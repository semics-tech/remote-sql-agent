import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, verifyPassword, generateSecret } from './passwords.js';
import type { EntraProfile } from './entra.js';
import type { AuthenticatedUser } from './sessions.js';
import { membershipKey } from './environments.js';
import type { Role } from '@remote-sql-agent/protocol';
import type { Logger } from 'pino';

/** User provisioning and local sign-in. */

export async function authenticateLocal(
  db: Database,
  username: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const [row] = await db
    .select()
    .from(users)
    .where(and(eq(users.username, username), eq(users.identityProvider, 'local')));

  // Hash even when the user does not exist, so a missing account and a wrong
  // password take the same time and cannot be distinguished by an attacker
  // enumerating usernames.
  if (!row?.passwordHash) {
    await verifyPassword(
      '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$Zm9vYmFyYmF6cXV4Zm9vYmFyYmF6cXV4Zm9v',
      password,
    );
    return null;
  }

  if (row.disabledAt) return null;
  if (!(await verifyPassword(row.passwordHash, password))) return null;

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role as Role,
    identityProvider: row.identityProvider,
    roleFromIdp: row.roleFromIdp,
    identityGroups: row.identityGroups,
    identityGroupsTruncated: row.identityGroupsTruncated,
  };
}

/**
 * Provision or update a user from a validated Entra profile.
 *
 * Matching is on `oid`, never on username or email: both can be reassigned to a
 * different person in Entra, and matching on them would hand one employee
 * another's account.
 *
 * The role is re-synced on every sign-in, so revoking an app role in Entra takes
 * effect at the user's next sign-in rather than requiring a second change here.
 */
export async function upsertEntraUser(
  db: Database,
  profile: EntraProfile,
): Promise<AuthenticatedUser> {
  if (!profile.role) {
    throw new Error(
      `${profile.username} signed in successfully but has no Remote SQL Agent app role assigned in Entra. ` +
        `Assign one of the rsagent.* app roles, or set RSAGENT_ENTRA_DEFAULT_ROLE.`,
    );
  }

  const now = new Date();
  // Both kinds of membership in one namespaced list, so a group object id and
  // an app role of the same name cannot collide in a grant lookup.
  const identityGroups = [
    ...profile.groupIds.map((id) => membershipKey('entra_group', id)),
    ...profile.appRoles.map((name) => membershipKey('app_role', name)),
  ];

  const [row] = await db
    .insert(users)
    .values({
      username: profile.username,
      passwordHash: null,
      role: profile.role,
      displayName: profile.displayName,
      email: profile.email,
      identityProvider: 'entra',
      externalId: profile.objectId,
      roleFromIdp: true,
      identityGroups,
      identityGroupsTruncated: profile.groupsTruncated,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: users.externalId,
      set: {
        username: profile.username,
        displayName: profile.displayName,
        email: profile.email,
        role: profile.role,
        roleFromIdp: true,
        // Replaced wholesale rather than merged: removing somebody from a group
        // in Entra has to remove their access here too, and a merge would make
        // membership permanent once granted.
        identityGroups,
        identityGroupsTruncated: profile.groupsTruncated,
        lastLoginAt: now,
      },
    })
    .returning();

  if (!row) throw new Error('Failed to provision the Entra user.');

  if (row.disabledAt) {
    // Disabling locally is an explicit administrative act and must survive a
    // successful Entra sign-in.
    throw new Error(`${profile.username} is disabled in Remote SQL Agent.`);
  }

  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role as Role,
    identityProvider: row.identityProvider,
    roleFromIdp: row.roleFromIdp,
    identityGroups: row.identityGroups,
    identityGroupsTruncated: row.identityGroupsTruncated,
  };
}

export async function listUsers(db: Database) {
  return db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      role: users.role,
      identityProvider: users.identityProvider,
      roleFromIdp: users.roleFromIdp,
      disabledAt: users.disabledAt,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.username));
}

export async function createLocalUser(
  db: Database,
  params: { username: string; password: string; role: Role; displayName?: string | null },
) {
  const [row] = await db
    .insert(users)
    .values({
      username: params.username,
      passwordHash: await hashPassword(params.password),
      role: params.role,
      displayName: params.displayName ?? null,
      identityProvider: 'local',
      roleFromIdp: false,
    })
    .returning({ id: users.id, username: users.username, role: users.role });
  return row ?? null;
}

export async function setUserRole(db: Database, userId: string, role: Role): Promise<void> {
  const [existing] = await db.select().from(users).where(eq(users.id, userId));
  if (!existing) throw new Error('No such user.');
  if (existing.roleFromIdp) {
    // Silently accepting this would be worse: the change would survive until
    // the user's next sign-in and then revert with no explanation.
    throw new Error(
      `${existing.username}'s role comes from an Entra app role. Change it in Entra instead — ` +
        `a change made here would be overwritten at their next sign-in.`,
    );
  }
  await db.update(users).set({ role }).where(eq(users.id, userId));
}

export async function setUserDisabled(
  db: Database,
  userId: string,
  disabled: boolean,
): Promise<void> {
  await db
    .update(users)
    .set({ disabledAt: disabled ? new Date() : null })
    .where(eq(users.id, userId));
}

/**
 * Ensure an administrator exists on first boot.
 *
 * If no password is configured, one is generated and logged once. There is
 * deliberately no fixed default password: a well-known default that nobody
 * changes is how self-hosted products end up in breach reports.
 */
export async function ensureBootstrapAdmin(
  db: Database,
  username: string,
  configuredPassword: string | undefined,
  logger: Logger,
): Promise<void> {
  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length > 0) return;

  const password = configuredPassword ?? generateSecret(18);
  await createLocalUser(db, { username, password, role: 'Admin', displayName: 'Bootstrap admin' });

  if (configuredPassword) {
    logger.info({ username }, 'Created the bootstrap administrator from RSAGENT_BOOTSTRAP_ADMIN_PASSWORD.');
  } else {
    logger.warn(
      `\n\n  Created the bootstrap administrator.\n` +
        `    username: ${username}\n` +
        `    password: ${password}\n\n` +
        `  This is shown once and is not recoverable. Sign in and change it now.\n`,
    );
  }
}

/** Are there any Entra-backed users? Used to warn before disabling Entra. */
export async function hasEntraUsers(db: Database): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(isNotNull(users.externalId))
    .limit(1);
  return rows.length > 0;
}
