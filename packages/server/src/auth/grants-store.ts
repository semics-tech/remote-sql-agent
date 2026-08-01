import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { ROLES, type Role } from '@remote-sql-agent/protocol';
import type { Database } from '../db/client.js';
import { environmentTag, environmentTagJoin } from '../db/environment-tag.js';
import {
  environmentGrants,
  grantSubjectKind,
  instances,
  users,
  workerInstanceConfigs,
  workers,
  type GrantSubjectKind,
} from '../db/schema.js';
import { normaliseTag, type EnvironmentGrant, type Principal } from './environments.js';

/** Reading and writing `environment_grants`. The decisions live in environments.ts. */

export class GrantError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GrantError';
  }
}

export const grantInputSchema = z.object({
  subjectKind: z.enum(grantSubjectKind),
  subjectKey: z.string().min(1).max(200),
  subjectLabel: z.string().max(200).nullish(),
  /** `*` or a tag. Stored as typed; matched case-insensitively. */
  environmentTag: z.string().min(1).max(64),
  role: z.enum(ROLES),
});
export type GrantInput = z.infer<typeof grantInputSchema>;

/**
 * Every grant, for the resolver.
 *
 * Loaded whole rather than filtered per user. The table is administrative — one
 * row per group per environment — so it is tens of rows on a large estate, and
 * a `WHERE subject_key = ANY(...)` per request buys nothing while making the
 * decision depend on the query being right as well as the resolver.
 */
export async function loadGrants(db: Database): Promise<EnvironmentGrant[]> {
  const rows = await db
    .select({
      subjectKind: environmentGrants.subjectKind,
      subjectKey: environmentGrants.subjectKey,
      environmentTag: environmentGrants.environmentTag,
      role: environmentGrants.role,
    })
    .from(environmentGrants);
  return rows;
}

export async function listGrants(db: Database) {
  return db
    .select()
    .from(environmentGrants)
    .orderBy(
      asc(environmentGrants.environmentTag),
      asc(environmentGrants.subjectKind),
      asc(environmentGrants.subjectLabel),
    );
}

export async function saveGrant(
  db: Database,
  input: GrantInput,
  createdBy: string | null,
): Promise<{ id: string }> {
  if (input.subjectKind === 'user') {
    // The only subject kind that names something we can check. A typo in a
    // group object id cannot be validated — the group lives in Entra — but a
    // grant pointing at a user id that does not exist is always a mistake, and
    // it would sit in the table doing nothing until somebody noticed.
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, input.subjectKey));
    if (!user) throw new GrantError(400, 'UnknownUser', 'No user with that id.');
  }

  // Stored exactly as it is compared. The resolver already lowercases both
  // sides, but storing what was typed let `Production` and `production` sit in
  // the table as two rows that both match — and since the resolver keeps the
  // more privileged of the two, correcting a grant *downward* silently did
  // nothing. Normalising here is what makes the unique index mean what it says.
  const tag = normaliseTag(input.environmentTag);
  if (tag === null) {
    throw new GrantError(400, 'EmptyEnvironmentTag', 'An environment tag cannot be blank.');
  }

  const [row] = await db
    .insert(environmentGrants)
    .values({
      subjectKind: input.subjectKind,
      subjectKey: input.subjectKey,
      subjectLabel: input.subjectLabel ?? null,
      environmentTag: tag,
      role: input.role,
      createdBy,
    })
    .onConflictDoUpdate({
      target: [
        environmentGrants.subjectKind,
        environmentGrants.subjectKey,
        environmentGrants.environmentTag,
      ],
      set: { role: input.role, subjectLabel: input.subjectLabel ?? null },
    })
    .returning({ id: environmentGrants.id });

  if (!row) throw new GrantError(500, 'GrantNotSaved', 'The grant could not be saved.');
  return row;
}

export async function deleteGrant(db: Database, id: string): Promise<boolean> {
  const removed = await db
    .delete(environmentGrants)
    .where(eq(environmentGrants.id, id))
    .returning({ id: environmentGrants.id });
  return removed.length > 0;
}

/**
 * The environment tag of one instance.
 *
 * Returns `undefined` for an instance that does not exist, which the guard
 * treats differently from `null` — an unknown instance must be refused rather
 * than evaluated as "untagged".
 */
export async function environmentOfInstance(
  db: Database,
  instanceId: string,
): Promise<string | null | undefined> {
  // Left join, so a tagless instance still returns a row. An inner join would
  // collapse "untagged" into "no such instance", and the guard answers those
  // two differently.
  const [row] = await db
    .select({ environmentTag })
    .from(instances)
    .leftJoin(workerInstanceConfigs, environmentTagJoin)
    .where(eq(instances.id, instanceId));
  return row === undefined ? undefined : row.environmentTag;
}

/**
 * Tags actually in use, so the admin screen offers a list rather than a text box.
 *
 * Read straight off the config table rather than through `instances`, which also
 * lists a tag configured for a worker that has not connected yet — the admin
 * tags it and grants against it in one sitting, before enrolment finishes.
 */
export async function listEnvironmentTags(db: Database): Promise<string[]> {
  const rows = await db
    .selectDistinct({ environmentTag: workerInstanceConfigs.environmentTag })
    .from(workerInstanceConfigs)
    .where(isNotNull(workerInstanceConfigs.environmentTag))
    .orderBy(asc(workerInstanceConfigs.environmentTag));
  return rows.map((r) => r.environmentTag).filter((t): t is string => t !== null);
}

/**
 * Instances that no grant can reach beyond the base role.
 *
 * Surfaced because it is the quiet failure mode of the whole design: an
 * instance enrolled before tagging existed, or with a mistyped tag, is not
 * covered by a `production` grant and nobody is told. It looks identical to a
 * permissions bug from the operator's side.
 */
export async function untaggedInstances(db: Database) {
  return db
    .select({
      instanceId: instances.id,
      instanceName: instances.instanceName,
      hostName: workers.hostName,
    })
    .from(instances)
    .innerJoin(workers, eq(workers.id, instances.workerId))
    .leftJoin(workerInstanceConfigs, environmentTagJoin)
    .where(and(isNull(environmentTag), isNull(instances.detachedAt)))
    .orderBy(asc(workers.hostName), asc(instances.instanceName));
}

/** Build the resolver's view of the signed-in user. */
export function principalOf(user: {
  id: string;
  role: Role;
  identityGroups?: readonly string[];
}): Principal {
  return { userId: user.id, role: user.role, identityGroups: user.identityGroups ?? [] };
}

export type { GrantSubjectKind };
