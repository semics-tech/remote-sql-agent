import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { inferRunningStep, type JobDefinition } from '@remote-sql-agent/protocol';
import type { Database } from '../db/client.js';
import { instances, jobActivity, jobHistory, jobs, jobVersions, workers } from '../db/schema.js';

/**
 * The operations overview — "what is happening right now, and what should I
 * look at first".
 *
 * The estate grid answers "what exists". This answers a different question, and
 * it is the one a DBA actually opens the tool for at 09:00. Everything here is
 * deliberately estate-wide: the whole point of the product is not having to
 * visit fifty instances to find the one that broke.
 */

const RUN_STATUS_FAILED = 0;
const RUN_STATUS_SUCCEEDED = 1;

/** Runs older than this do not inform the duration baseline. */
const BASELINE_WINDOW_DAYS = 30;

/**
 * A run is "long" once it passes both tests: comfortably over its own average,
 * and over a floor. The ratio alone makes a job that normally takes two seconds
 * scream at six; the floor alone never fires for a job that normally takes a
 * day. Requiring both is what stops this list becoming noise people ignore.
 */
const OVERRUN_RATIO = 2;
const OVERRUN_FLOOR_SECONDS = 60;

/** With no baseline at all, only flag a run that is obviously stuck. */
const NO_BASELINE_ALERT_SECONDS = 60 * 60;

export interface RunningJob {
  instanceId: string;
  instanceName: string;
  hostName: string;
  jobUuid: string;
  jobName: string;
  /**
   * The step running now — inferred from the job's own flow, not read from
   * `sysjobactivity`.
   *
   * msdb's `last_executed_step_id` is the last step that *finished*, so taking
   * it at face value names the previous step for the whole of every step, and
   * names nothing at all during the first one. See `inferRunningStep`.
   */
  currentStepId: number | null;
  currentStepName: string | null;
  /** Position of the running step, and how many the job has: "2 of 5". */
  currentStepNumber: number | null;
  stepCount: number | null;
  startedAt: Date | null;
  elapsedSeconds: number | null;
  /** Mean duration of recent successful runs, or null with too little history. */
  averageSeconds: number | null;
  /**
   * How long the previous successful run took.
   *
   * Reported even when there is no average, because one prior run is still a
   * far better answer to "should I be worried yet" than nothing at all — it is
   * only too thin a sample to *judge* an overrun against.
   */
  lastDurationSeconds: number | null;
  /** elapsed / average, once both are known. */
  overrunRatio: number | null;
  isLongRunning: boolean;
}

export interface FailedRun {
  instanceId: string;
  instanceName: string;
  hostName: string;
  jobUuid: string;
  jobName: string;
  runDatetime: Date;
  runDurationSeconds: number;
  message: string | null;
  /** Consecutive failures ending with this run — one-off or persistent. */
  consecutiveFailures: number;
}

export interface WorkerHealth {
  workerId: string;
  hostName: string;
  version: string | null;
  online: boolean;
  lastSeenAt: Date | null;
  instanceCount: number;
  /** Instances whose Agent is not reporting as running. */
  agentsNotRunning: number;
}

export interface OverviewTotals {
  instances: number;
  jobs: number;
  jobsDisabled: number;
  runningNow: number;
  longRunning: number;
  failedLast24h: number;
  workersOnline: number;
  workersOffline: number;
  agentsStopped: number;
}

export interface Overview {
  totals: OverviewTotals;
  running: RunningJob[];
  failures: FailedRun[];
  workers: WorkerHealth[];
}

export interface OverviewOptions {
  /** Cap on the failure list. The totals are always exact. */
  failureLimit?: number;
  /** Injected so tests can pin "now" rather than racing the clock. */
  now?: Date;
}

export async function getOverview(
  db: Database,
  isOnline: (workerId: string) => boolean,
  options: OverviewOptions = {},
): Promise<Overview> {
  const now = options.now ?? new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [running, failures, workerRows, totals] = await Promise.all([
    getRunningJobs(db, now),
    getRecentFailures(db, since24h, options.failureLimit ?? 50),
    getWorkerHealth(db, isOnline),
    getTotals(db, since24h),
  ]);

  return {
    totals: {
      ...totals,
      runningNow: running.length,
      longRunning: running.filter((r) => r.isLongRunning).length,
      workersOnline: workerRows.filter((w) => w.online).length,
      workersOffline: workerRows.filter((w) => !w.online).length,
    },
    running,
    failures,
    workers: workerRows,
  };
}

/**
 * Everything SQL Agent currently reports as executing, with each run measured
 * against that job's own history rather than a global threshold — a nightly
 * index rebuild that takes 40 minutes is not a problem, and a five-second
 * heartbeat job that has taken 40 minutes very much is.
 */
export async function getRunningJobs(db: Database, now: Date): Promise<RunningJob[]> {
  const rows = await db
    .select({
      instanceId: instances.id,
      instanceName: instances.instanceName,
      hostName: workers.hostName,
      jobUuid: jobActivity.jobUuid,
      jobName: jobs.name,
      currentStepId: jobActivity.currentStepId,
      currentStepName: jobActivity.currentStepName,
      startedAt: jobActivity.startedAt,
    })
    .from(jobActivity)
    .innerJoin(instances, eq(instances.id, jobActivity.instanceId))
    .innerJoin(workers, eq(workers.id, instances.workerId))
    .innerJoin(
      jobs,
      and(eq(jobs.instanceId, jobActivity.instanceId), eq(jobs.jobUuid, jobActivity.jobUuid)),
    )
    .where(
      and(
        eq(jobActivity.state, 'executing'),
        isNull(jobs.deletedAt),
        isNull(instances.detachedAt),
      ),
    )
    .orderBy(asc(jobActivity.startedAt));

  if (rows.length === 0) return [];

  const keys = rows.map((r) => ({ instanceId: r.instanceId, jobUuid: r.jobUuid }));
  const [baselines, progress] = await Promise.all([
    durationBaselines(db, keys, now),
    runningStepProgress(
      db,
      rows.map((r) => ({ ...r, startedAt: r.startedAt })),
    ),
  ]);

  return rows.map((r) => {
    const elapsedSeconds = r.startedAt
      ? Math.max(0, Math.round((now.getTime() - r.startedAt.getTime()) / 1000))
      : null;
    const baseline = baselines.get(`${r.instanceId}:${r.jobUuid}`);
    const averageSeconds = baseline?.averageSeconds ?? null;
    const lastDurationSeconds = baseline?.lastDurationSeconds ?? null;

    let overrunRatio: number | null = null;
    let isLongRunning = false;

    if (elapsedSeconds !== null && averageSeconds !== null && averageSeconds > 0) {
      overrunRatio = elapsedSeconds / averageSeconds;
      isLongRunning =
        overrunRatio >= OVERRUN_RATIO && elapsedSeconds - averageSeconds >= OVERRUN_FLOOR_SECONDS;
    } else if (elapsedSeconds !== null) {
      isLongRunning = elapsedSeconds >= NO_BASELINE_ALERT_SECONDS;
    }

    const step = progress.get(`${r.instanceId}:${r.jobUuid}`);

    return {
      ...r,
      // Fall back to msdb's own answer only when the definition is not
      // mirrored yet. It is the wrong step, but a wrong step is still more
      // use than a blank cell, and it is what this showed before.
      currentStepId: step ? step.currentStepId : r.currentStepId,
      currentStepName: step ? step.currentStepName : r.currentStepName,
      currentStepNumber: step?.currentStepNumber ?? null,
      stepCount: step?.stepCount ?? null,
      elapsedSeconds,
      averageSeconds,
      lastDurationSeconds,
      overrunRatio,
      isLongRunning,
    };
  });
}

interface StepProgress {
  currentStepId: number | null;
  currentStepName: string | null;
  currentStepNumber: number | null;
  stepCount: number;
}

/**
 * Work out which step each running job is actually on.
 *
 * Two things are needed and neither is in `job_activity`: the job's definition,
 * to know what follows what, and the steps this run has already finished, to
 * know how far along the flow it has got. Both are fetched for the whole set at
 * once — the input is only the jobs currently executing, which is a handful
 * even on a large estate.
 */
async function runningStepProgress(
  db: Database,
  running: Array<{ instanceId: string; jobUuid: string; startedAt: Date | null }>,
): Promise<Map<string, StepProgress>> {
  const out = new Map<string, StepProgress>();
  if (running.length === 0) return out;

  const instanceIds = [...new Set(running.map((r) => r.instanceId))];
  const jobUuids = [...new Set(running.map((r) => r.jobUuid))];

  const [definitionRows, historyRows] = await Promise.all([
    db
      .select({
        instanceId: jobVersions.instanceId,
        jobUuid: jobVersions.jobUuid,
        definition: jobVersions.definition,
      })
      .from(jobVersions)
      .innerJoin(
        jobs,
        and(
          eq(jobs.instanceId, jobVersions.instanceId),
          eq(jobs.jobUuid, jobVersions.jobUuid),
          eq(jobs.currentVersionNo, jobVersions.versionNo),
        ),
      )
      .where(
        and(inArray(jobVersions.instanceId, instanceIds), inArray(jobVersions.jobUuid, jobUuids)),
      ),
    db
      .select({
        instanceId: jobHistory.instanceId,
        jobUuid: jobHistory.jobUuid,
        stepId: jobHistory.stepId,
        runStatus: jobHistory.runStatus,
        runDatetime: jobHistory.runDatetime,
        sqlInstanceId: jobHistory.sqlInstanceId,
      })
      .from(jobHistory)
      .where(
        and(
          inArray(jobHistory.instanceId, instanceIds),
          inArray(jobHistory.jobUuid, jobUuids),
          ne(jobHistory.stepId, 0),
          // Only rows from the current run. The earliest start across the set
          // bounds the query; each job is filtered to its own start below.
          gte(jobHistory.runDatetime, earliestStart(running)),
        ),
      )
      .orderBy(asc(jobHistory.sqlInstanceId)),
  ]);

  const definitions = new Map(
    definitionRows.map((r) => [`${r.instanceId}:${r.jobUuid}`, r.definition as JobDefinition]),
  );

  for (const job of running) {
    const key = `${job.instanceId}:${job.jobUuid}`;
    const definition = definitions.get(key);
    if (!definition || definition.steps.length === 0) continue;

    const completed = historyRows.filter(
      (h) =>
        h.instanceId === job.instanceId &&
        h.jobUuid === job.jobUuid &&
        job.startedAt !== null &&
        // msdb timestamps are second-resolution, so a step finishing in the
        // same second the job started would be lost to a strict comparison.
        h.runDatetime.getTime() >= job.startedAt.getTime() - 1000,
    );

    const stepId = inferRunningStep(definition, completed);
    const ordered = [...definition.steps].sort((a, b) => a.stepId - b.stepId);
    const index = stepId === null ? -1 : ordered.findIndex((s) => s.stepId === stepId);

    out.set(key, {
      currentStepId: stepId,
      currentStepName: index === -1 ? null : (ordered[index]?.name ?? null),
      currentStepNumber: index === -1 ? null : index + 1,
      stepCount: ordered.length,
    });
  }

  return out;
}

function earliestStart(running: Array<{ startedAt: Date | null }>): Date {
  const times = running.map((r) => r.startedAt?.getTime()).filter((t): t is number => t !== undefined);
  // No start times at all means nothing can be attributed to a run anyway; a
  // recent bound keeps the query cheap rather than scanning all of history.
  if (times.length === 0) return new Date(Date.now() - 60 * 60 * 1000);
  return new Date(Math.min(...times) - 1000);
}

export interface DurationBaseline {
  /** Null until there are enough runs to mean anything. */
  averageSeconds: number | null;
  /** The most recent successful run, however few there have been. */
  lastDurationSeconds: number | null;
}

/**
 * Duration baselines from recent *successful* runs, keyed "instanceId:jobUuid".
 *
 * Failures are excluded on purpose: a job that fails after two seconds would
 * otherwise drag the baseline down and make every healthy run look like an
 * overrun. Cancelled runs are excluded for the same reason.
 */
export async function durationBaselines(
  db: Database,
  keys: Array<{ instanceId: string; jobUuid: string }>,
  now: Date,
): Promise<Map<string, DurationBaseline>> {
  if (keys.length === 0) return new Map();

  const since = new Date(now.getTime() - BASELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const instanceIds = [...new Set(keys.map((k) => k.instanceId))];
  const jobUuids = [...new Set(keys.map((k) => k.jobUuid))];

  // Filtered on both columns then narrowed to exact pairs below: a composite
  // IN list is awkward to express and this is at most a handful of instances.
  const rows = await db
    .select({
      instanceId: jobHistory.instanceId,
      jobUuid: jobHistory.jobUuid,
      averageSeconds: sql<number>`AVG(${jobHistory.runDurationSeconds})`,
      // The latest row's value, not the largest — array_agg with an ORDER BY is
      // the one aggregate that can pick it out without a second round trip.
      lastDurationSeconds: sql<
        number | null
      >`(ARRAY_AGG(${jobHistory.runDurationSeconds} ORDER BY ${jobHistory.runDatetime} DESC))[1]`,
      runs: sql<number>`COUNT(*)`,
    })
    .from(jobHistory)
    .where(
      and(
        inArray(jobHistory.instanceId, instanceIds),
        inArray(jobHistory.jobUuid, jobUuids),
        eq(jobHistory.stepId, 0),
        eq(jobHistory.runStatus, RUN_STATUS_SUCCEEDED),
        gte(jobHistory.runDatetime, since),
      ),
    )
    .groupBy(jobHistory.instanceId, jobHistory.jobUuid);

  const wanted = new Set(keys.map((k) => `${k.instanceId}:${k.jobUuid}`));
  const out = new Map<string, DurationBaseline>();
  for (const row of rows) {
    const key = `${row.instanceId}:${row.jobUuid}`;
    if (!wanted.has(key)) continue;
    out.set(key, {
      // One sample is an anecdote, not a baseline — but it is still worth
      // showing, so only the average is withheld.
      averageSeconds: Number(row.runs) < 3 ? null : Number(row.averageSeconds),
      lastDurationSeconds:
        row.lastDurationSeconds === null ? null : Number(row.lastDurationSeconds),
    });
  }
  return out;
}

/** Failed runs in the window, newest first, with a consecutive-failure count. */
export async function getRecentFailures(
  db: Database,
  since: Date,
  limit: number,
): Promise<FailedRun[]> {
  const rows = await db
    .select({
      instanceId: instances.id,
      instanceName: instances.instanceName,
      hostName: workers.hostName,
      jobUuid: jobHistory.jobUuid,
      jobName: jobs.name,
      runDatetime: jobHistory.runDatetime,
      runDurationSeconds: jobHistory.runDurationSeconds,
      message: jobHistory.message,
      sqlInstanceId: jobHistory.sqlInstanceId,
    })
    .from(jobHistory)
    .innerJoin(instances, eq(instances.id, jobHistory.instanceId))
    .innerJoin(workers, eq(workers.id, instances.workerId))
    .innerJoin(
      jobs,
      and(eq(jobs.instanceId, jobHistory.instanceId), eq(jobs.jobUuid, jobHistory.jobUuid)),
    )
    .where(
      and(
        eq(jobHistory.stepId, 0),
        eq(jobHistory.runStatus, RUN_STATUS_FAILED),
        gte(jobHistory.runDatetime, since),
        isNull(jobs.deletedAt),
        isNull(instances.detachedAt),
      ),
    )
    .orderBy(desc(jobHistory.runDatetime))
    .limit(Math.min(limit, 500));

  if (rows.length === 0) return [];

  const streaks = await failureStreaks(
    db,
    rows.map((r) => ({ instanceId: r.instanceId, jobUuid: r.jobUuid })),
  );

  return rows.map(({ sqlInstanceId: _sqlInstanceId, ...r }) => ({
    ...r,
    consecutiveFailures: streaks.get(`${r.instanceId}:${r.jobUuid}`) ?? 1,
  }));
}

/**
 * How many runs a job has failed in a row, counting back from its most recent.
 *
 * "Failed once overnight" and "has failed every run since Tuesday" look
 * identical in a list of failures, and they call for completely different
 * responses.
 */
async function failureStreaks(
  db: Database,
  keys: Array<{ instanceId: string; jobUuid: string }>,
): Promise<Map<string, number>> {
  const unique = new Map(keys.map((k) => [`${k.instanceId}:${k.jobUuid}`, k]));
  const out = new Map<string, number>();

  // Bounded: only the jobs already on the failure page, at most a few dozen.
  await Promise.all(
    [...unique].map(async ([key, k]) => {
      const recent = await db
        .select({ runStatus: jobHistory.runStatus })
        .from(jobHistory)
        .where(
          and(
            eq(jobHistory.instanceId, k.instanceId),
            eq(jobHistory.jobUuid, k.jobUuid),
            eq(jobHistory.stepId, 0),
          ),
        )
        .orderBy(desc(jobHistory.runDatetime), desc(jobHistory.sqlInstanceId))
        .limit(50);

      let streak = 0;
      for (const run of recent) {
        if (run.runStatus !== RUN_STATUS_FAILED) break;
        streak += 1;
      }
      out.set(key, streak);
    }),
  );

  return out;
}

export async function getWorkerHealth(
  db: Database,
  isOnline: (workerId: string) => boolean,
): Promise<WorkerHealth[]> {
  const rows = await db
    .select({
      workerId: workers.id,
      hostName: workers.hostName,
      version: workers.version,
      lastSeenAt: workers.lastSeenAt,
      instanceCount: sql<number>`COUNT(${instances.id})`,
      agentsNotRunning: sql<number>`COUNT(${instances.id}) FILTER (WHERE ${instances.agentStatus} <> 'running')`,
    })
    .from(workers)
    .leftJoin(
      instances,
      and(eq(instances.workerId, workers.id), isNull(instances.detachedAt)),
    )
    .groupBy(workers.id, workers.hostName, workers.version, workers.lastSeenAt)
    .orderBy(asc(workers.hostName));

  return rows.map((r) => ({
    ...r,
    instanceCount: Number(r.instanceCount),
    agentsNotRunning: Number(r.agentsNotRunning),
    online: isOnline(r.workerId),
  }));
}

async function getTotals(
  db: Database,
  since24h: Date,
): Promise<Omit<OverviewTotals, 'runningNow' | 'longRunning' | 'workersOnline' | 'workersOffline'>> {
  const [jobCounts] = await db
    .select({
      jobs: sql<number>`COUNT(*)`,
      jobsDisabled: sql<number>`COUNT(*) FILTER (WHERE NOT ${jobs.enabled})`,
      failedLast24h: sql<number>`COUNT(*) FILTER (
        WHERE ${jobs.lastRunStatus} = ${RUN_STATUS_FAILED}
          AND ${jobs.lastRunAt} >= ${since24h.toISOString()}::timestamptz
      )`,
    })
    .from(jobs)
    .innerJoin(instances, eq(instances.id, jobs.instanceId))
    .where(and(isNull(jobs.deletedAt), isNull(instances.detachedAt)));

  const [instanceCounts] = await db
    .select({
      instances: sql<number>`COUNT(*)`,
      agentsStopped: sql<number>`COUNT(*) FILTER (WHERE ${instances.agentStatus} <> 'running')`,
    })
    .from(instances)
    .where(isNull(instances.detachedAt));

  return {
    jobs: Number(jobCounts?.jobs ?? 0),
    jobsDisabled: Number(jobCounts?.jobsDisabled ?? 0),
    failedLast24h: Number(jobCounts?.failedLast24h ?? 0),
    instances: Number(instanceCounts?.instances ?? 0),
    agentsStopped: Number(instanceCounts?.agentsStopped ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Every job in the estate, filterable
// ---------------------------------------------------------------------------

/**
 * The facets a job can carry, and the ones the overview filters on.
 *
 * These are not mutually exclusive and deliberately do not form a single
 * "status" column. A job can be running *and* disabled *and* drifted at once,
 * and collapsing that into one value means picking a winner and hiding the rest
 * — which is how a disabled job that is somehow still executing becomes
 * invisible. Filtering is therefore "has any of the selected facets".
 */
export const JOB_FACETS = [
  'running',
  'longRunning',
  'failed',
  'succeeded',
  'retry',
  'cancelled',
  'neverRun',
  'disabled',
  'drifted',
] as const;
export type JobFacet = (typeof JOB_FACETS)[number];

const RUN_STATUS_RETRY = 2;
const RUN_STATUS_CANCELLED = 3;

export interface EstateJob {
  instanceId: string;
  instanceName: string;
  hostName: string;
  environmentTag: string | null;
  jobUuid: string;
  jobName: string;
  enabled: boolean;
  categoryName: string | null;
  ownerLoginName: string | null;
  lastRunStatus: number | null;
  lastRunAt: Date | null;
  lastRunDurationSeconds: number | null;
  nextRunAt: Date | null;
  /** Live now, and how far past its own average it has got. */
  elapsedSeconds: number | null;
  averageSeconds: number | null;
  facets: JobFacet[];
}

export interface EstateJobsResult {
  jobs: EstateJob[];
  /**
   * Counts per facet across everything the *text* filter matched, before the
   * facet filter is applied — so ticking "failed" does not change the number
   * next to "running" and leave the reader wondering what happened to them.
   */
  counts: Record<JobFacet, number>;
  /** Jobs matching the text filter, and matching text plus facets. */
  total: number;
  matched: number;
  /** Rows returned, which is `matched` capped at the page size. */
  returned: number;
  /** The estate is larger than one query: everything above is a partial view. */
  truncated: boolean;
}

export interface ListEstateJobsOptions {
  facets?: readonly JobFacet[];
  filter?: string;
  /** Rows sent to the browser. The counts are over everything regardless. */
  limit?: number;
  /** Cap on rows read. Shared with groupJobs so both truncate at the same size. */
  scanLimit?: number;
  now?: Date;
}

/**
 * Every job in the estate, with the facets the overview filters on.
 *
 * The estate grid answers "what exists" per instance and the job groups answer
 * "is this job healthy everywhere". Neither answers "show me everything that is
 * failing right now, wherever it lives", which is what someone does first when
 * a morning starts badly.
 */
export async function listEstateJobs(
  db: Database,
  options: ListEstateJobsOptions = {},
): Promise<EstateJobsResult> {
  const now = options.now ?? new Date();
  const scanLimit = Math.min(options.scanLimit ?? 20_000, 50_000);
  const limit = Math.min(options.limit ?? 500, 5_000);

  const [rows, running] = await Promise.all([
    db
      .select({
        instanceId: instances.id,
        instanceName: instances.instanceName,
        hostName: workers.hostName,
        environmentTag: instances.environmentTag,
        jobUuid: jobs.jobUuid,
        jobName: jobs.name,
        enabled: jobs.enabled,
        categoryName: jobs.categoryName,
        ownerLoginName: jobs.ownerLoginName,
        isDrifted: jobs.isDrifted,
        lastRunStatus: jobs.lastRunStatus,
        lastRunAt: jobs.lastRunAt,
        lastRunDurationSeconds: jobs.lastRunDurationSeconds,
        nextRunAt: jobs.nextRunAt,
        activityState: jobActivity.state,
      })
      .from(jobs)
      .innerJoin(instances, eq(instances.id, jobs.instanceId))
      .innerJoin(workers, eq(workers.id, instances.workerId))
      .leftJoin(
        jobActivity,
        and(eq(jobActivity.instanceId, jobs.instanceId), eq(jobActivity.jobUuid, jobs.jobUuid)),
      )
      .where(and(isNull(jobs.deletedAt), isNull(instances.detachedAt)))
      .orderBy(asc(jobs.name), asc(workers.hostName), asc(instances.instanceName))
      .limit(scanLimit),
    // Only the executing jobs, so this is a handful of rows even on a large
    // estate. It is the one facet that cannot be answered from the jobs table:
    // "long" is measured against each job's own history, not a fixed threshold.
    getRunningJobs(db, now),
  ]);

  const live = new Map(running.map((r) => [`${r.instanceId}:${r.jobUuid}`, r]));
  const needle = options.filter?.trim().toLowerCase() ?? '';
  const wanted = new Set(options.facets ?? []);

  const counts = Object.fromEntries(JOB_FACETS.map((f) => [f, 0])) as Record<JobFacet, number>;
  const matched: EstateJob[] = [];
  let total = 0;

  for (const row of rows) {
    if (
      needle &&
      !row.jobName.toLowerCase().includes(needle) &&
      !row.hostName.toLowerCase().includes(needle) &&
      !row.instanceName.toLowerCase().includes(needle) &&
      !(row.categoryName ?? '').toLowerCase().includes(needle) &&
      !(row.environmentTag ?? '').toLowerCase().includes(needle)
    ) {
      continue;
    }
    total += 1;

    const current = live.get(`${row.instanceId}:${row.jobUuid}`);
    const facets = facetsOf(row, current);
    for (const facet of facets) counts[facet] += 1;

    if (wanted.size > 0 && !facets.some((f) => wanted.has(f))) continue;

    matched.push({
      instanceId: row.instanceId,
      instanceName: row.instanceName,
      hostName: row.hostName,
      environmentTag: row.environmentTag,
      jobUuid: row.jobUuid,
      jobName: row.jobName,
      enabled: row.enabled,
      categoryName: row.categoryName,
      ownerLoginName: row.ownerLoginName,
      lastRunStatus: row.lastRunStatus,
      lastRunAt: row.lastRunAt,
      lastRunDurationSeconds: row.lastRunDurationSeconds,
      nextRunAt: row.nextRunAt,
      elapsedSeconds: current?.elapsedSeconds ?? null,
      averageSeconds: current?.averageSeconds ?? null,
      facets,
    });
  }

  matched.sort(byUrgencyThenName);

  return {
    jobs: matched.slice(0, limit),
    counts,
    total,
    matched: matched.length,
    returned: Math.min(matched.length, limit),
    truncated: rows.length >= scanLimit,
  };
}

function facetsOf(
  row: {
    enabled: boolean;
    isDrifted: boolean;
    lastRunStatus: number | null;
    lastRunAt: Date | null;
    activityState: string | null;
  },
  current: RunningJob | undefined,
): JobFacet[] {
  const facets: JobFacet[] = [];
  if (row.activityState === 'executing') facets.push('running');
  if (current?.isLongRunning) facets.push('longRunning');
  if (row.lastRunStatus === RUN_STATUS_FAILED) facets.push('failed');
  if (row.lastRunStatus === RUN_STATUS_SUCCEEDED) facets.push('succeeded');
  if (row.lastRunStatus === RUN_STATUS_RETRY) facets.push('retry');
  if (row.lastRunStatus === RUN_STATUS_CANCELLED) facets.push('cancelled');
  if (row.lastRunAt === null) facets.push('neverRun');
  if (!row.enabled) facets.push('disabled');
  if (row.isDrifted) facets.push('drifted');
  return facets;
}

/**
 * Worst first.
 *
 * The same ordering the rest of this page uses: an all-jobs list sorted
 * alphabetically buries the one row worth reading somewhere around "N".
 */
const FACET_WEIGHT: Record<JobFacet, number> = {
  longRunning: 0,
  failed: 1,
  running: 2,
  retry: 3,
  cancelled: 4,
  drifted: 5,
  neverRun: 6,
  disabled: 7,
  succeeded: 8,
};

function byUrgencyThenName(a: EstateJob, b: EstateJob): number {
  const rank = (job: EstateJob) =>
    job.facets.length === 0 ? 9 : Math.min(...job.facets.map((f) => FACET_WEIGHT[f]));
  return (
    rank(a) - rank(b) ||
    a.jobName.localeCompare(b.jobName) ||
    a.hostName.localeCompare(b.hostName) ||
    a.instanceName.localeCompare(b.instanceName)
  );
}

// ---------------------------------------------------------------------------
// Cross-estate job grouping (§9.5 extended)
// ---------------------------------------------------------------------------

export const GROUP_KEYS = ['name', 'category', 'owner', 'schedule', 'instance'] as const;
export type GroupKey = (typeof GROUP_KEYS)[number];

export interface GroupMember {
  instanceId: string;
  instanceName: string;
  hostName: string;
  jobUuid: string;
  jobName: string;
  enabled: boolean;
  categoryName: string | null;
  ownerLoginName: string | null;
  scheduleSummary: string;
  lastRunStatus: number | null;
  lastRunAt: Date | null;
  lastRunDurationSeconds: number | null;
  nextRunAt: Date | null;
  running: boolean;
}

export interface JobGroup {
  key: string;
  label: string;
  members: GroupMember[];
  total: number;
  failing: number;
  running: number;
  disabled: number;
  neverRun: number;
}

/**
 * The same logical job usually exists on many instances — "Nightly Backup" on
 * thirty servers. Grouping turns "is it healthy everywhere?" into one glance
 * instead of thirty tabs, which is the question the estate grid cannot answer
 * because it aggregates per *instance* rather than per *job*.
 */
export interface GroupJobsResult {
  groups: JobGroup[];
  /** True when the row cap was hit, so the caller can say so rather than
   * presenting a partial estate as if it were the whole one. */
  truncated: boolean;
}

export async function groupJobs(
  db: Database,
  groupBy: GroupKey,
  options: { filter?: string; limit?: number } = {},
): Promise<GroupJobsResult> {
  const limit = Math.min(options.limit ?? 20_000, 50_000);
  const rows = await db
    .select({
      instanceId: instances.id,
      instanceName: instances.instanceName,
      hostName: workers.hostName,
      jobUuid: jobs.jobUuid,
      jobName: jobs.name,
      enabled: jobs.enabled,
      categoryName: jobs.categoryName,
      ownerLoginName: jobs.ownerLoginName,
      lastRunStatus: jobs.lastRunStatus,
      lastRunAt: jobs.lastRunAt,
      lastRunDurationSeconds: jobs.lastRunDurationSeconds,
      nextRunAt: jobs.nextRunAt,
      activityState: jobActivity.state,
    })
    .from(jobs)
    .innerJoin(instances, eq(instances.id, jobs.instanceId))
    .innerJoin(workers, eq(workers.id, instances.workerId))
    .leftJoin(
      jobActivity,
      and(eq(jobActivity.instanceId, jobs.instanceId), eq(jobActivity.jobUuid, jobs.jobUuid)),
    )
    .where(and(isNull(jobs.deletedAt), isNull(instances.detachedAt)))
    .orderBy(asc(jobs.name), asc(workers.hostName), asc(instances.instanceName))
    .limit(limit);

  // Schedules live inside the definition rather than a column, so the summary
  // is derived here rather than grouped in SQL.
  const summaries =
    groupBy === 'schedule'
      ? await scheduleSummaries(db)
      : new Map<string, string>();

  const needle = options.filter?.trim().toLowerCase() ?? '';
  const groups = new Map<string, JobGroup>();

  for (const row of rows) {
    const member: GroupMember = {
      instanceId: row.instanceId,
      instanceName: row.instanceName,
      hostName: row.hostName,
      jobUuid: row.jobUuid,
      jobName: row.jobName,
      enabled: row.enabled,
      categoryName: row.categoryName,
      ownerLoginName: row.ownerLoginName,
      scheduleSummary: summaries.get(`${row.instanceId}:${row.jobUuid}`) ?? 'Not scheduled',
      lastRunStatus: row.lastRunStatus,
      lastRunAt: row.lastRunAt,
      lastRunDurationSeconds: row.lastRunDurationSeconds,
      nextRunAt: row.nextRunAt,
      running: row.activityState === 'executing',
    };

    if (
      needle &&
      !member.jobName.toLowerCase().includes(needle) &&
      !member.hostName.toLowerCase().includes(needle) &&
      !member.instanceName.toLowerCase().includes(needle)
    ) {
      continue;
    }

    const label = groupLabel(groupBy, member);
    let group = groups.get(label);
    if (!group) {
      group = { key: label, label, members: [], total: 0, failing: 0, running: 0, disabled: 0, neverRun: 0 };
      groups.set(label, group);
    }

    group.members.push(member);
    group.total += 1;
    if (member.lastRunStatus === RUN_STATUS_FAILED) group.failing += 1;
    if (member.running) group.running += 1;
    if (!member.enabled) group.disabled += 1;
    if (member.lastRunAt === null) group.neverRun += 1;
  }

  // Anything failing first: this list is read top-down when something is wrong.
  return {
    groups: [...groups.values()].sort(
      (a, b) => b.failing - a.failing || b.total - a.total || a.label.localeCompare(b.label),
    ),
    truncated: rows.length >= limit,
  };
}

function groupLabel(groupBy: GroupKey, member: GroupMember): string {
  switch (groupBy) {
    case 'name':
      return member.jobName;
    case 'category':
      return member.categoryName ?? 'Uncategorised';
    case 'owner':
      return member.ownerLoginName ?? 'Unknown owner';
    case 'schedule':
      return member.scheduleSummary;
    case 'instance':
      return `${member.hostName} · ${member.instanceName}`;
  }
}

/**
 * A short, groupable description of when each job runs, read from the current
 * definition. Two jobs group together only when their schedule *shape* matches,
 * so "every day at 02:00" collects across the estate.
 */
async function scheduleSummaries(db: Database): Promise<Map<string, string>> {
  const { jobVersions } = await import('../db/schema.js');
  const { describeSchedule } = await import('@remote-sql-agent/protocol');

  const rows = await db
    .select({
      instanceId: jobVersions.instanceId,
      jobUuid: jobVersions.jobUuid,
      // Only the schedules, extracted in Postgres. Selecting the whole
      // definition pulls every step's T-SQL body across the wire — on a
      // 50-instance estate that is tens of megabytes per request, to read one
      // small array from each.
      schedules: sql<unknown[] | null>`${jobVersions.definition} -> 'schedules'`,
    })
    .from(jobVersions)
    .innerJoin(
      jobs,
      and(
        eq(jobs.instanceId, jobVersions.instanceId),
        eq(jobs.jobUuid, jobVersions.jobUuid),
        eq(jobs.currentVersionNo, jobVersions.versionNo),
      ),
    )
    .where(isNull(jobs.deletedAt));

  const out = new Map<string, string>();
  for (const row of rows) {
    const schedules = Array.isArray(row.schedules) ? row.schedules : [];
    if (schedules.length === 0) continue;
    const described = schedules
      .map((s) => {
        try {
          return describeSchedule(s as Parameters<typeof describeSchedule>[0]);
        } catch {
          // A schedule we cannot describe should not lose the whole job from
          // the grouping; it lands in its own bucket instead.
          return 'Unrecognised schedule';
        }
      })
      .sort();
    out.set(`${row.instanceId}:${row.jobUuid}`, described.join(' + '));
  }
  return out;
}

export { ne };
