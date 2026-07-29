import { and, desc, eq, isNull, notInArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { jobs, jobVersions, type JobVersionOrigin } from '../db/schema.js';
import { parseJobDefinition } from '@remote-sql-agent/protocol';

/**
 * Version and drift attribution (§7).
 *
 * The rule that matters: a definition change is only ever *recorded*, never
 * silently reconciled. Whether it came from the dashboard or from someone in
 * SSMS, it becomes a new immutable version row. The only difference is the
 * `origin` attribution and whether the job is flagged as drifted.
 */

export interface RecordVersionInput {
  instanceId: string;
  jobUuid: string;
  canonicalJson: string;
  definitionHash: string;
  origin: JobVersionOrigin;
  /** Set for origin='remote': links the version back to the audited command. */
  commandId?: string | null;
  createdBy?: string | null;
  detectedAt?: Date;
}

export interface RecordVersionResult {
  changed: boolean;
  versionNo: number;
  isDrift: boolean;
}

/**
 * Record an observed definition, creating a new version if the hash has moved.
 *
 * Idempotent by hash: re-observing the same definition (every poll, or after a
 * reconnect replays the snapshot) is a no-op. This is what stops the version
 * timeline filling with duplicates.
 */
export async function recordJobVersion(
  db: Database,
  input: RecordVersionInput,
): Promise<RecordVersionResult> {
  const definition = parseJobDefinition(input.canonicalJson);
  const detectedAt = input.detectedAt ?? new Date();

  return db.transaction(async (tx) => {
    // Lock the job row so two concurrent observations cannot both allocate the
    // same version_no. `FOR UPDATE` on a non-existent row is a no-op, and the
    // unique index on (instance, job, version_no) is the backstop.
    const [existing] = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.instanceId, input.instanceId), eq(jobs.jobUuid, input.jobUuid)))
      .for('update');

    if (existing && existing.currentDefinitionHash === input.definitionHash) {
      // Unchanged. Still clear the soft-delete flag if the job has reappeared.
      if (existing.deletedAt) {
        await tx
          .update(jobs)
          .set({ deletedAt: null, updatedAt: detectedAt })
          .where(eq(jobs.id, existing.id));
      }
      return { changed: false, versionNo: existing.currentVersionNo, isDrift: existing.isDrifted };
    }

    const versionNo = (existing?.currentVersionNo ?? 0) + 1;
    // The first version we ever see is 'initial', not drift — the job existed
    // before we did, and flagging every job on first contact would make the
    // drift badge meaningless.
    const origin: JobVersionOrigin = existing ? input.origin : 'initial';
    const isDrift = origin === 'local';

    await tx.insert(jobVersions).values({
      instanceId: input.instanceId,
      jobUuid: input.jobUuid,
      versionNo,
      definition,
      definitionHash: input.definitionHash,
      origin,
      commandId: input.commandId ?? null,
      createdBy: input.createdBy ?? null,
      detectedAt,
    });

    const jobColumns = {
      name: definition.name,
      enabled: definition.enabled,
      categoryName: definition.categoryName,
      ownerLoginName: definition.ownerLoginName,
      description: definition.description,
      currentVersionNo: versionNo,
      currentDefinitionHash: input.definitionHash,
      isDrifted: isDrift,
      driftDetectedAt: isDrift ? detectedAt : existing?.driftDetectedAt ?? null,
      deletedAt: null,
      updatedAt: detectedAt,
    };

    if (existing) {
      await tx.update(jobs).set(jobColumns).where(eq(jobs.id, existing.id));
    } else {
      await tx.insert(jobs).values({
        instanceId: input.instanceId,
        jobUuid: input.jobUuid,
        ...jobColumns,
      });
    }

    return { changed: true, versionNo, isDrift };
  });
}

/**
 * Mark a job as deleted on-prem. Soft delete: the job disappears from the
 * active list but its history and version timeline survive, which is the whole
 * point of the control plane being the record of history.
 */
export async function markJobDeleted(
  db: Database,
  instanceId: string,
  jobUuid: string,
  at = new Date(),
): Promise<void> {
  await db
    .update(jobs)
    .set({ deletedAt: at, updatedAt: at })
    .where(and(eq(jobs.instanceId, instanceId), eq(jobs.jobUuid, jobUuid)));
}

/**
 * Reconcile a full snapshot: any job we currently believe exists on this
 * instance but which is absent from the snapshot has been deleted on-prem.
 * Only ever called with a *complete* snapshot, never a partial chunk.
 */
export async function markJobsMissingFromSnapshot(
  db: Database,
  instanceId: string,
  seenJobUuids: string[],
  at = new Date(),
): Promise<number> {
  const conditions = [eq(jobs.instanceId, instanceId), isNull(jobs.deletedAt)];
  // An empty snapshot legitimately means "this instance has no jobs any more",
  // so it must soft-delete everything rather than being treated as a no-op.
  if (seenJobUuids.length > 0) {
    conditions.push(notInArray(jobs.jobUuid, seenJobUuids));
  }

  const result = await db
    .update(jobs)
    .set({ deletedAt: at, updatedAt: at })
    .where(and(...conditions))
    .returning({ id: jobs.id });
  return result.length;
}

export async function getJobVersions(db: Database, instanceId: string, jobUuid: string) {
  return db
    .select()
    .from(jobVersions)
    .where(and(eq(jobVersions.instanceId, instanceId), eq(jobVersions.jobUuid, jobUuid)))
    .orderBy(desc(jobVersions.versionNo));
}

export async function getJobVersion(
  db: Database,
  instanceId: string,
  jobUuid: string,
  versionNo: number,
) {
  const [row] = await db
    .select()
    .from(jobVersions)
    .where(
      and(
        eq(jobVersions.instanceId, instanceId),
        eq(jobVersions.jobUuid, jobUuid),
        eq(jobVersions.versionNo, versionNo),
      ),
    );
  return row ?? null;
}

/** Clear the drift flag once an operator has acknowledged or resolved it. */
export async function acknowledgeDrift(
  db: Database,
  instanceId: string,
  jobUuid: string,
): Promise<void> {
  await db
    .update(jobs)
    .set({ isDrifted: false, updatedAt: new Date() })
    .where(and(eq(jobs.instanceId, instanceId), eq(jobs.jobUuid, jobUuid)));
}
