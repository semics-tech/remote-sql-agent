import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { instances, jobActivity, jobHistory, jobs, workers } from '../db/schema.js';

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
  currentStepId: number | null;
  currentStepName: string | null;
  startedAt: Date | null;
  elapsedSeconds: number | null;
  /** Mean duration of recent successful runs, or null with too little history. */
  averageSeconds: number | null;
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
    .where(and(eq(jobActivity.state, 'executing'), isNull(jobs.deletedAt)))
    .orderBy(asc(jobActivity.startedAt));

  if (rows.length === 0) return [];

  const baselines = await durationBaselines(
    db,
    rows.map((r) => ({ instanceId: r.instanceId, jobUuid: r.jobUuid })),
    now,
  );

  return rows.map((r) => {
    const elapsedSeconds = r.startedAt
      ? Math.max(0, Math.round((now.getTime() - r.startedAt.getTime()) / 1000))
      : null;
    const averageSeconds = baselines.get(`${r.instanceId}:${r.jobUuid}`) ?? null;

    let overrunRatio: number | null = null;
    let isLongRunning = false;

    if (elapsedSeconds !== null && averageSeconds !== null && averageSeconds > 0) {
      overrunRatio = elapsedSeconds / averageSeconds;
      isLongRunning =
        overrunRatio >= OVERRUN_RATIO && elapsedSeconds - averageSeconds >= OVERRUN_FLOOR_SECONDS;
    } else if (elapsedSeconds !== null) {
      isLongRunning = elapsedSeconds >= NO_BASELINE_ALERT_SECONDS;
    }

    return { ...r, elapsedSeconds, averageSeconds, overrunRatio, isLongRunning };
  });
}

/**
 * Mean duration of recent *successful* runs, keyed "instanceId:jobUuid".
 *
 * Failures are excluded on purpose: a job that fails after two seconds would
 * otherwise drag the baseline down and make every healthy run look like an
 * overrun. Cancelled runs are excluded for the same reason.
 */
export async function durationBaselines(
  db: Database,
  keys: Array<{ instanceId: string; jobUuid: string }>,
  now: Date,
): Promise<Map<string, number>> {
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
  const out = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.instanceId}:${row.jobUuid}`;
    // One sample is an anecdote, not a baseline.
    if (!wanted.has(key) || Number(row.runs) < 3) continue;
    out.set(key, Number(row.averageSeconds));
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
    .leftJoin(instances, eq(instances.workerId, workers.id))
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
    .where(isNull(jobs.deletedAt));

  const [instanceCounts] = await db
    .select({
      instances: sql<number>`COUNT(*)`,
      agentsStopped: sql<number>`COUNT(*) FILTER (WHERE ${instances.agentStatus} <> 'running')`,
    })
    .from(instances);

  return {
    jobs: Number(jobCounts?.jobs ?? 0),
    jobsDisabled: Number(jobCounts?.jobsDisabled ?? 0),
    failedLast24h: Number(jobCounts?.failedLast24h ?? 0),
    instances: Number(instanceCounts?.instances ?? 0),
    agentsStopped: Number(instanceCounts?.agentsStopped ?? 0),
  };
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
export async function groupJobs(
  db: Database,
  groupBy: GroupKey,
  options: { filter?: string; limit?: number } = {},
): Promise<JobGroup[]> {
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
    .where(isNull(jobs.deletedAt))
    .orderBy(asc(jobs.name), asc(workers.hostName), asc(instances.instanceName))
    .limit(Math.min(options.limit ?? 5000, 20_000));

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
  return [...groups.values()].sort(
    (a, b) => b.failing - a.failing || b.total - a.total || a.label.localeCompare(b.label),
  );
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
    .where(isNull(jobs.deletedAt));

  const out = new Map<string, string>();
  for (const row of rows) {
    const def = row.definition as { schedules?: unknown[] };
    const schedules = def.schedules ?? [];
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
