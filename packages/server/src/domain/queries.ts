import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNull,
  lt,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { environmentTag, environmentTagJoin } from '../db/environment-tag.js';
import {
  agentLogEntries,
  instances,
  jobActivity,
  jobHistory,
  jobs,
  jobVersions,
  workerInstanceConfigs,
  workers,
} from '../db/schema.js';

/** Read-side queries backing the dashboard (§9). */

const RUN_STATUS_FAILED = 0;

// ---------------------------------------------------------------------------
// Estate overview (§9.1)
// ---------------------------------------------------------------------------

export interface EstateRow {
  instanceId: string;
  instanceName: string;
  hostName: string;
  serverName: string | null;
  sqlVersion: string | null;
  sqlEdition: string | null;
  agentStatus: string;
  environmentTag: string | null;
  lastSeenAt: Date | null;
  workerConnected: boolean;
  jobCount: number;
  failedLast24h: number;
  runningNow: number;
  driftedJobs: number;
}

export async function getEstateOverview(db: Database): Promise<EstateRow[]> {
  // Bound as an ISO string with an explicit cast: postgres.js cannot infer a
  // parameter type for a bare Date embedded in a raw sql fragment.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // One aggregate query rather than N+1 per instance: the reference estate is
  // 50+ instances and the overview is the most-hit screen in the product.
  const rows = await db
    .select({
      instanceId: instances.id,
      instanceName: instances.instanceName,
      hostName: workers.hostName,
      serverName: instances.serverName,
      sqlVersion: instances.sqlVersion,
      sqlEdition: instances.sqlEdition,
      agentStatus: instances.agentStatus,
      environmentTag,
      lastSeenAt: instances.lastSeenAt,
      workerConnectedAt: workers.connectedAt,
      jobCount: sql<number>`COUNT(DISTINCT ${jobs.id}) FILTER (WHERE ${jobs.deletedAt} IS NULL)`,
      driftedJobs: sql<number>`COUNT(DISTINCT ${jobs.id}) FILTER (WHERE ${jobs.isDrifted} AND ${jobs.deletedAt} IS NULL)`,
      failedLast24h: sql<number>`COUNT(DISTINCT ${jobs.id}) FILTER (
        WHERE ${jobs.lastRunStatus} = ${RUN_STATUS_FAILED}
          AND ${jobs.lastRunAt} >= ${since}::timestamptz
          AND ${jobs.deletedAt} IS NULL
      )`,
      runningNow: sql<number>`COUNT(DISTINCT ${jobActivity.jobUuid}) FILTER (WHERE ${jobActivity.state} = 'executing')`,
    })
    .from(instances)
    .innerJoin(workers, eq(workers.id, instances.workerId))
    .leftJoin(workerInstanceConfigs, environmentTagJoin)
    .leftJoin(jobs, eq(jobs.instanceId, instances.id))
    .leftJoin(
      jobActivity,
      and(eq(jobActivity.instanceId, instances.id), eq(jobActivity.jobUuid, jobs.jobUuid)),
    )
    .where(isNull(instances.detachedAt))
    .groupBy(
      instances.id,
      instances.instanceName,
      workers.hostName,
      instances.serverName,
      instances.sqlVersion,
      instances.sqlEdition,
      instances.agentStatus,
      environmentTag,
      instances.lastSeenAt,
      workers.connectedAt,
    )
    .orderBy(asc(workers.hostName), asc(instances.instanceName));

  return rows.map(({ workerConnectedAt, ...r }) => ({
    ...r,
    jobCount: Number(r.jobCount),
    driftedJobs: Number(r.driftedJobs),
    failedLast24h: Number(r.failedLast24h),
    runningNow: Number(r.runningNow),
    workerConnected: workerConnectedAt !== null,
  }));
}

// ---------------------------------------------------------------------------
// Instance and job views (§9.2, §9.3)
// ---------------------------------------------------------------------------

export async function getInstance(db: Database, instanceId: string) {
  const [row] = await db
    .select({
      id: instances.id,
      instanceName: instances.instanceName,
      hostName: workers.hostName,
      serverName: instances.serverName,
      sqlVersion: instances.sqlVersion,
      sqlEdition: instances.sqlEdition,
      agentStatus: instances.agentStatus,
      // What SQL Server will let the worker edit here, as the worker reported
      // it. Separate from `capabilities`, which is what this product grants.
      jobWriteMode: instances.jobWriteMode,
      environmentTag,
      lastSeenAt: instances.lastSeenAt,
      workerId: workers.id,
      workerConnectedAt: workers.connectedAt,
      workerVersion: workers.version,
      capabilities: workers.capabilities,
      maxCapabilityReported: workers.maxCapabilityReported,
    })
    .from(instances)
    .innerJoin(workers, eq(workers.id, instances.workerId))
    .leftJoin(workerInstanceConfigs, environmentTagJoin)
    .where(eq(instances.id, instanceId));
  return row ?? null;
}

export async function listJobs(
  db: Database,
  instanceId: string,
  options: { includeDeleted?: boolean } = {},
) {
  const conditions: SQL[] = [eq(jobs.instanceId, instanceId)];
  if (!options.includeDeleted) conditions.push(isNull(jobs.deletedAt));

  return db
    .select({
      jobUuid: jobs.jobUuid,
      name: jobs.name,
      enabled: jobs.enabled,
      categoryName: jobs.categoryName,
      ownerLoginName: jobs.ownerLoginName,
      description: jobs.description,
      currentVersionNo: jobs.currentVersionNo,
      isDrifted: jobs.isDrifted,
      driftDetectedAt: jobs.driftDetectedAt,
      lastRunStatus: jobs.lastRunStatus,
      lastRunAt: jobs.lastRunAt,
      lastRunDurationSeconds: jobs.lastRunDurationSeconds,
      nextRunAt: jobs.nextRunAt,
      deletedAt: jobs.deletedAt,
      activityState: jobActivity.state,
      activityStepName: jobActivity.currentStepName,
      activityStartedAt: jobActivity.startedAt,
    })
    .from(jobs)
    .leftJoin(
      jobActivity,
      and(eq(jobActivity.instanceId, jobs.instanceId), eq(jobActivity.jobUuid, jobs.jobUuid)),
    )
    .where(and(...conditions))
    .orderBy(asc(jobs.name));
}

export async function getJob(db: Database, instanceId: string, jobUuid: string) {
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.instanceId, instanceId), eq(jobs.jobUuid, jobUuid)));
  if (!job) return null;

  const [version] = await db
    .select({ definition: jobVersions.definition, versionNo: jobVersions.versionNo })
    .from(jobVersions)
    .where(and(eq(jobVersions.instanceId, instanceId), eq(jobVersions.jobUuid, jobUuid)))
    .orderBy(desc(jobVersions.versionNo))
    .limit(1);

  const [activity] = await db
    .select()
    .from(jobActivity)
    .where(and(eq(jobActivity.instanceId, instanceId), eq(jobActivity.jobUuid, jobUuid)));

  return {
    ...job,
    definition: version?.definition ?? null,
    activity: activity ?? null,
  };
}

/**
 * Job run history, grouped the way SSMS "View History" presents it: one entry
 * per run (the step_id = 0 outcome row) with its steps nested underneath.
 */
export interface HistoryRun {
  sqlInstanceId: number;
  runDatetime: Date;
  runStatus: number;
  runDurationSeconds: number;
  message: string | null;
  steps: Array<{
    sqlInstanceId: number;
    stepId: number;
    stepName: string | null;
    runStatus: number;
    runDatetime: Date;
    runDurationSeconds: number;
    message: string | null;
    retriesAttempted: number;
    sqlSeverity: number;
    sqlMessageId: number;
  }>;
}

export async function getJobHistory(
  db: Database,
  instanceId: string,
  jobUuid: string,
  limit = 50,
): Promise<HistoryRun[]> {
  // Fetch the most recent N job-level rows, then their steps. Steps belong to
  // the run whose outcome row has the next-highest sql_instance_id, because
  // msdb writes step rows before the job outcome row that closes the run.
  const outcomes = await db
    .select()
    .from(jobHistory)
    .where(
      and(
        eq(jobHistory.instanceId, instanceId),
        eq(jobHistory.jobUuid, jobUuid),
        eq(jobHistory.stepId, 0),
      ),
    )
    .orderBy(desc(jobHistory.sqlInstanceId))
    .limit(limit);

  if (outcomes.length === 0) {
    // A run in progress has step rows but no outcome row yet; surface those
    // rather than showing an empty History tab mid-run.
    const orphanSteps = await db
      .select()
      .from(jobHistory)
      .where(and(eq(jobHistory.instanceId, instanceId), eq(jobHistory.jobUuid, jobUuid)))
      .orderBy(desc(jobHistory.sqlInstanceId))
      .limit(limit);
    if (orphanSteps.length === 0) return [];
    return [
      {
        sqlInstanceId: orphanSteps[0]!.sqlInstanceId,
        runDatetime: orphanSteps[orphanSteps.length - 1]!.runDatetime,
        runStatus: 4, // In progress
        runDurationSeconds: 0,
        message: null,
        steps: orphanSteps.reverse().map(toStep),
      },
    ];
  }

  // msdb writes a run's step rows *before* the step_id = 0 outcome row that
  // closes it, so the steps belonging to the oldest run we are showing have
  // ids *below* that run's outcome id. The floor is therefore the outcome row
  // immediately preceding the oldest one we included; anything above it belongs
  // to a run in our window.
  const oldestOutcomeId = outcomes[outcomes.length - 1]!.sqlInstanceId;
  const [previousOutcome] = await db
    .select({ sqlInstanceId: jobHistory.sqlInstanceId })
    .from(jobHistory)
    .where(
      and(
        eq(jobHistory.instanceId, instanceId),
        eq(jobHistory.jobUuid, jobUuid),
        eq(jobHistory.stepId, 0),
        lt(jobHistory.sqlInstanceId, oldestOutcomeId),
      ),
    )
    .orderBy(desc(jobHistory.sqlInstanceId))
    .limit(1);

  const floor = previousOutcome?.sqlInstanceId ?? 0;
  const newestOutcomeId = outcomes[0]!.sqlInstanceId;

  const allSteps = await db
    .select()
    .from(jobHistory)
    .where(
      and(
        eq(jobHistory.instanceId, instanceId),
        eq(jobHistory.jobUuid, jobUuid),
        gt(jobHistory.sqlInstanceId, floor),
        lte(jobHistory.sqlInstanceId, newestOutcomeId),
        ne(jobHistory.stepId, 0),
      ),
    )
    .orderBy(asc(jobHistory.sqlInstanceId));

  // Walk outcomes oldest-first, assigning each step row to the first outcome
  // whose id is greater than the step's.
  const ascending = [...outcomes].reverse();
  const runs: HistoryRun[] = ascending.map((o) => ({
    sqlInstanceId: o.sqlInstanceId,
    runDatetime: o.runDatetime,
    runStatus: o.runStatus,
    runDurationSeconds: o.runDurationSeconds,
    message: o.message,
    steps: [],
  }));

  let cursor = 0;
  for (const step of allSteps) {
    while (cursor < runs.length && step.sqlInstanceId > runs[cursor]!.sqlInstanceId) cursor++;
    if (cursor >= runs.length) break;
    runs[cursor]!.steps.push(toStep(step));
  }

  return runs.reverse();
}

function toStep(r: typeof jobHistory.$inferSelect): HistoryRun['steps'][number] {
  return {
    sqlInstanceId: r.sqlInstanceId,
    stepId: r.stepId,
    stepName: r.stepName,
    runStatus: r.runStatus,
    runDatetime: r.runDatetime,
    runDurationSeconds: r.runDurationSeconds,
    message: r.message,
    retriesAttempted: r.retriesAttempted,
    sqlSeverity: r.sqlSeverity,
    sqlMessageId: r.sqlMessageId,
  };
}

export async function getAgentLog(db: Database, instanceId: string, limit = 200) {
  return db
    .select()
    .from(agentLogEntries)
    .where(eq(agentLogEntries.instanceId, instanceId))
    .orderBy(desc(agentLogEntries.loggedAt))
    .limit(Math.min(limit, 1000));
}

export async function listWorkers(db: Database) {
  return db
    .select({
      id: workers.id,
      hostName: workers.hostName,
      version: workers.version,
      capabilities: workers.capabilities,
      maxCapabilityReported: workers.maxCapabilityReported,
      connectedAt: workers.connectedAt,
      lastSeenAt: workers.lastSeenAt,
      certExpiresAt: workers.certExpiresAt,
      certRevokedAt: workers.certRevokedAt,
      instanceCount: count(instances.id),
    })
    .from(workers)
    .leftJoin(instances, eq(instances.workerId, workers.id))
    .groupBy(workers.id)
    .orderBy(asc(workers.hostName));
}

// ---------------------------------------------------------------------------
// Cross-estate search (§9.5)
// ---------------------------------------------------------------------------

export interface SearchHit {
  instanceId: string;
  instanceName: string;
  hostName: string;
  jobUuid: string;
  jobName: string;
  enabled: boolean;
  isDrifted: boolean;
  /** Which step bodies matched, so the UI can show the relevant excerpt. */
  matchingSteps: Array<{ stepId: number; stepName: string; excerpt: string }>;
  nameMatched: boolean;
}

/**
 * Find jobs by name or by text inside any step body, across every instance.
 *
 * "Which servers still reference LEGACYFIN01 in a step?" is the question SSMS
 * cannot answer at all, and it is the reason the canonical definition is stored
 * as searchable jsonb rather than an encrypted blob — see docs/security.md for
 * that trade-off.
 */
export async function searchJobs(
  db: Database,
  query: string,
  options: { limit?: number; includeDeleted?: boolean } = {},
): Promise<SearchHit[]> {
  const limit = Math.min(options.limit ?? 200, 1000);
  const pattern = `%${escapeLikePattern(query)}%`;

  const conditions: SQL[] = [
    // The jsonb path query keeps the step-body search in Postgres rather than
    // pulling every definition into Node to grep.
    or(
      ilike(jobs.name, pattern),
      sql`EXISTS (
        SELECT 1
        FROM   jsonb_array_elements(${jobVersions.definition} -> 'steps') AS s
        WHERE  s ->> 'command' ILIKE ${pattern}
      )`,
    )!,
  ];
  if (!options.includeDeleted) conditions.push(isNull(jobs.deletedAt));

  const rows = await db
    .select({
      instanceId: instances.id,
      instanceName: instances.instanceName,
      hostName: workers.hostName,
      jobUuid: jobs.jobUuid,
      jobName: jobs.name,
      enabled: jobs.enabled,
      isDrifted: jobs.isDrifted,
      definition: jobVersions.definition,
    })
    .from(jobs)
    .innerJoin(instances, eq(instances.id, jobs.instanceId))
    .innerJoin(workers, eq(workers.id, instances.workerId))
    .innerJoin(
      jobVersions,
      and(
        eq(jobVersions.instanceId, jobs.instanceId),
        eq(jobVersions.jobUuid, jobs.jobUuid),
        eq(jobVersions.versionNo, jobs.currentVersionNo),
      ),
    )
    .where(and(...conditions))
    .orderBy(asc(workers.hostName), asc(instances.instanceName), asc(jobs.name))
    .limit(limit);

  const needle = query.toLowerCase();

  return rows.map((r) => {
    const def = r.definition as { steps?: Array<{ stepId: number; name: string; command: string }> };
    const matchingSteps = (def.steps ?? [])
      .filter((s) => s.command.toLowerCase().includes(needle))
      .map((s) => ({
        stepId: s.stepId,
        stepName: s.name,
        excerpt: excerptAround(s.command, needle),
      }));

    return {
      instanceId: r.instanceId,
      instanceName: r.instanceName,
      hostName: r.hostName,
      jobUuid: r.jobUuid,
      jobName: r.jobName,
      enabled: r.enabled,
      isDrifted: r.isDrifted,
      matchingSteps,
      nameMatched: r.jobName.toLowerCase().includes(needle),
    };
  });
}

/** Escape LIKE wildcards so a search for "100%" does not match everything. */
function escapeLikePattern(input: string): string {
  return input.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

function excerptAround(text: string, needle: string, radius = 80): string {
  const idx = text.toLowerCase().indexOf(needle);
  if (idx === -1) return text.slice(0, radius * 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + needle.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
