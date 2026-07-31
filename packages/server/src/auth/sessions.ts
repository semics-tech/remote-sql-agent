import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { generateSecret, hashToken } from './passwords.js';
import type { Role } from '@remote-sql-agent/protocol';

/**
 * Server-side sessions.
 *
 * The cookie carries an opaque random token; the database stores only its
 * SHA-256. A database compromise therefore does not hand the attacker live
 * sessions, and an administrator can revoke a session immediately — neither of
 * which is true of a self-contained JWT.
 */

export const SESSION_COOKIE = 'rsagent_session';
export const CSRF_COOKIE = 'rsagent_csrf';
export const CSRF_HEADER = 'x-rsagent-csrf';

export interface AuthenticatedUser {
  id: string;
  username: string;
  displayName: string | null;
  role: Role;
  identityProvider: string;
  roleFromIdp: boolean;
  /**
   * `entra_group:<oid>` / `app_role:<name>`, as captured at the user's last
   * sign-in. Read from the users row on every request rather than baked into
   * the session, so an administrator who corrects a membership does not have to
   * wait for the session to expire.
   */
  identityGroups: string[];
  /** Entra would not enumerate the groups claim; see the schema comment. */
  identityGroupsTruncated: boolean;
}

export interface CreatedSession {
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export async function createSession(
  db: Database,
  userId: string,
  ttlHours: number,
  remoteAddress: string | null,
): Promise<CreatedSession> {
  const token = generateSecret(32);
  const csrfToken = generateSecret(24);
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    csrfTokenHash: hashToken(csrfToken),
    expiresAt,
    remoteAddress,
  });

  return { token, csrfToken, expiresAt };
}

export interface ResolvedSession {
  user: AuthenticatedUser;
  sessionId: string;
  csrfTokenHash: string;
}

export async function resolveSession(
  db: Database,
  token: string | undefined,
): Promise<ResolvedSession | null> {
  if (!token) return null;

  const [row] = await db
    .select({
      sessionId: sessions.id,
      csrfTokenHash: sessions.csrfTokenHash,
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      role: users.role,
      identityProvider: users.identityProvider,
      roleFromIdp: users.roleFromIdp,
      identityGroups: users.identityGroups,
      identityGroupsTruncated: users.identityGroupsTruncated,
      disabledAt: users.disabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));

  // A disabled user's existing sessions must stop working immediately, not at
  // their next natural expiry.
  if (!row || row.disabledAt) return null;

  // Best-effort activity stamp; never worth failing a request over.
  void db
    .update(sessions)
    .set({ lastUsedAt: new Date() })
    .where(eq(sessions.id, row.sessionId))
    .catch(() => undefined);

  return {
    sessionId: row.sessionId,
    csrfTokenHash: row.csrfTokenHash,
    user: {
      id: row.userId,
      username: row.username,
      displayName: row.displayName,
      role: row.role as Role,
      identityProvider: row.identityProvider,
      roleFromIdp: row.roleFromIdp,
      identityGroups: row.identityGroups,
      identityGroupsTruncated: row.identityGroupsTruncated,
    },
  };
}

export async function revokeSession(db: Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function revokeAllSessionsForUser(db: Database, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function pruneExpiredSessions(db: Database): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, new Date()))
    .returning({ id: sessions.id });
  return removed.length;
}

/** Users with no local password and no external identity cannot sign in at all. */
export async function listSignInCapableUsers(db: Database) {
  return db.select().from(users).where(isNull(users.disabledAt));
}
