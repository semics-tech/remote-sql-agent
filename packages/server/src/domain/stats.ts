import { and, asc, desc, eq, gte, ne, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { jobActivity, jobHistory } from '../db/schema.js';

/**
 * Per-job statistics and per-step baselines.
 *
 * Two audiences, one query set: the job overview ("is this job healthy, and is
 * it getting slower?") and the live step graph ("which step is it on, and is
 * that step taking longer than it usually does?"). Both need the same
 * per-step history, so they are computed together rather than twice.
 */

const RUN_STATUS_FAILED = 0;
const RUN_STATUS_SUCCEEDED = 1;
const RUN_STATUS_RETRY = 2;
const RUN_STATUS_CANCELLED = 3;

const STATS_WINDOW_DAYS = 90;

export interface RunPoint {
  sqlInstanceId: number;
  runDatetime: Date;
  runStatus: number;
  runDurationSeconds: number;
}

export interface StepStat {
  stepId: number;
  stepName: string | null;
  runs: number;
  failures: number;
  averageSeconds: number;
  maxSeconds: number;
  lastSeconds: number | null;
}

export interface CurrentRunStep {
  stepId: number;
  stepName: string | null;
  runStatus: number;
  /** When the step began. msdb records this alongside the duration on the row
   * it writes when the step *finishes*, which is what lets a timeline place
   * each bar rather than just stacking them end to end. */
  startedAt: Date;
  runDurationSeconds: number;
  message: string | null;
}

export interface CurrentRun {
  startedAt: Date | null;
  elapsedSeconds: number | null;
  currentStepId: number | null;
  currentStepName: string | null;
  /** Steps this run has already finished, in execution order. */
  completedSteps: CurrentRunStep[];
}

export interface JobStats {
  windowDays: number;
  totalRuns: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  retried: number;
  /** Null rather than 0 when there is no history — "no data" is not "0%". */
  successRate: number | null;
  duration: {
    averageSeconds: number | null;
    medianSeconds: number | null;
    p95Seconds: number | null;
    minSeconds: number | null;
    maxSeconds: number | null;
    lastSeconds: number | null;
    /** Mean of the newest quarter vs the oldest quarter, as a ratio. >1 is
     * getting slower. Null when there are too few runs to mean anything. */
    trend: number | null;
  };
  /** Oldest first, so it plots left to right like every other time series. */
  recentRuns: RunPoint[];
  steps: StepStat[];
  currentRun: CurrentRun | null;
}

export interface JobStatsOptions {
  recentRunLimit?: number;
  now?: Date;
}

export async function getJobStats(
  db: Database,
  instanceId: string,
  jobUuid: string,
  options: JobStatsOptions = {},
): Promise<JobStats> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - STATS_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const recentRunLimit = Math.min(options.recentRunLimit ?? 50, 500);

  const [outcomes, stepRows, activityRow] = await Promise.all([
    db
      .select({
        sqlInstanceId: jobHistory.sqlInstanceId,
        runDatetime: jobHistory.runDatetime,
        runStatus: jobHistory.runStatus,
        runDurationSeconds: jobHistory.runDurationSeconds,
      })
      .from(jobHistory)
      .where(
        and(
          eq(jobHistory.instanceId, instanceId),
          eq(jobHistory.jobUuid, jobUuid),
          eq(jobHistory.stepId, 0),
          gte(jobHistory.runDatetime, since),
        ),
      )
      .orderBy(desc(jobHistory.runDatetime), desc(jobHistory.sqlInstanceId))
      .limit(1000),

    db
      .select({
        stepId: jobHistory.stepId,
        stepName: sql<string | null>`MAX(${jobHistory.stepName})`,
        runs: sql<number>`COUNT(*)`,
        failures: sql<number>`COUNT(*) FILTER (WHERE ${jobHistory.runStatus} = ${RUN_STATUS_FAILED})`,
        averageSeconds: sql<number>`AVG(${jobHistory.runDurationSeconds})`,
        maxSeconds: sql<number>`MAX(${jobHistory.runDurationSeconds})`,
      })
      .from(jobHistory)
      .where(
        and(
          eq(jobHistory.instanceId, instanceId),
          eq(jobHistory.jobUuid, jobUuid),
          ne(jobHistory.stepId, 0),
          gte(jobHistory.runDatetime, since),
        ),
      )
      .groupBy(jobHistory.stepId)
      .orderBy(asc(jobHistory.stepId)),

    db
      .select()
      .from(jobActivity)
      .where(and(eq(jobActivity.instanceId, instanceId), eq(jobActivity.jobUuid, jobUuid)))
      .limit(1),
  ]);

  const lastStepDurations = await lastDurationPerStep(db, instanceId, jobUuid);

  const succeededDurations = outcomes
    .filter((o) => o.runStatus === RUN_STATUS_SUCCEEDED)
    .map((o) => o.runDurationSeconds)
    .sort((a, b) => a - b);

  const totalRuns = outcomes.length;
  const succeeded = outcomes.filter((o) => o.runStatus === RUN_STATUS_SUCCEEDED).length;

  const activity = activityRow[0] ?? null;
  const currentRun =
    activity && activity.state === 'executing'
      ? await getCurrentRun(db, instanceId, jobUuid, activity, now)
      : null;

  return {
    windowDays: STATS_WINDOW_DAYS,
    totalRuns,
    succeeded,
    failed: outcomes.filter((o) => o.runStatus === RUN_STATUS_FAILED).length,
    cancelled: outcomes.filter((o) => o.runStatus === RUN_STATUS_CANCELLED).length,
    retried: outcomes.filter((o) => o.runStatus === RUN_STATUS_RETRY).length,
    successRate: totalRuns === 0 ? null : succeeded / totalRuns,
    duration: {
      averageSeconds: mean(succeededDurations),
      medianSeconds: percentile(succeededDurations, 0.5),
      p95Seconds: percentile(succeededDurations, 0.95),
      minSeconds: succeededDurations[0] ?? null,
      maxSeconds: succeededDurations[succeededDurations.length - 1] ?? null,
      lastSeconds: outcomes[0]?.runDurationSeconds ?? null,
      trend: durationTrend(outcomes),
    },
    recentRuns: outcomes.slice(0, recentRunLimit).reverse(),
    steps: stepRows.map((s) => ({
      stepId: s.stepId,
      stepName: s.stepName,
      runs: Number(s.runs),
      failures: Number(s.failures),
      averageSeconds: Number(s.averageSeconds),
      maxSeconds: Number(s.maxSeconds),
      lastSeconds: lastStepDurations.get(s.stepId) ?? null,
    })),
    currentRun,
  };
}

/**
 * How long each step took the last time it ran.
 *
 * DISTINCT ON is the right tool here: one row per step, newest first, in a
 * single pass rather than a query per step.
 */
async function lastDurationPerStep(
  db: Database,
  instanceId: string,
  jobUuid: string,
): Promise<Map<number, number>> {
  const rows = await db.execute<{ step_id: number; run_duration_seconds: number }>(sql`
    SELECT DISTINCT ON (step_id) step_id, run_duration_seconds
    FROM   job_history
    WHERE  instance_id = ${instanceId}
      AND  job_uuid    = ${jobUuid}
      AND  step_id    <> 0
    ORDER BY step_id, run_datetime DESC, sql_instance_id DESC
  `);

  return new Map([...rows].map((r) => [Number(r.step_id), Number(r.run_duration_seconds)]));
}

/**
 * Progress of the run currently in flight.
 *
 * msdb writes a step's history row when that step *finishes*, so the steps
 * listed here are the ones already done; the step named by `jobActivity` is the
 * one still going. That asymmetry is a SQL Server property, not a sync delay,
 * and the live graph depends on reading it correctly.
 */
async function getCurrentRun(
  db: Database,
  instanceId: string,
  jobUuid: string,
  activity: typeof jobActivity.$inferSelect,
  now: Date,
): Promise<CurrentRun> {
  const startedAt = activity.startedAt;

  const completedSteps = startedAt
    ? await db
        .select({
          stepId: jobHistory.stepId,
          stepName: jobHistory.stepName,
          runStatus: jobHistory.runStatus,
          startedAt: jobHistory.runDatetime,
          runDurationSeconds: jobHistory.runDurationSeconds,
          message: jobHistory.message,
        })
        .from(jobHistory)
        .where(
          and(
            eq(jobHistory.instanceId, instanceId),
            eq(jobHistory.jobUuid, jobUuid),
            ne(jobHistory.stepId, 0),
            // Second-resolution timestamps in msdb mean a step finishing in the
            // same second the job started would be excluded by a strict >.
            gte(jobHistory.runDatetime, new Date(startedAt.getTime() - 1000)),
          ),
        )
        .orderBy(asc(jobHistory.sqlInstanceId))
    : [];

  return {
    startedAt,
    elapsedSeconds: startedAt
      ? Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000))
      : null,
    currentStepId: activity.currentStepId,
    currentStepName: activity.currentStepName,
    completedSteps,
  };
}

/**
 * Is this job getting slower? Compare the mean of the newest quarter of runs
 * against the oldest quarter. Quartiles rather than first-vs-last run because a
 * single outlier should not read as a trend.
 */
function durationTrend(outcomes: RunPoint[]): number | null {
  const successful = outcomes
    .filter((o) => o.runStatus === RUN_STATUS_SUCCEEDED)
    .map((o) => o.runDurationSeconds);
  if (successful.length < 8) return null;

  const quarter = Math.max(2, Math.floor(successful.length / 4));
  // `outcomes` is newest-first, so the head is the recent window.
  const recent = mean(successful.slice(0, quarter));
  const older = mean(successful.slice(-quarter));
  if (recent === null || older === null || older === 0) return null;
  return recent / older;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Nearest-rank percentile over an ascending array. */
function percentile(ascending: number[], p: number): number | null {
  if (ascending.length === 0) return null;
  const rank = Math.ceil(p * ascending.length);
  return ascending[Math.min(ascending.length - 1, Math.max(0, rank - 1))] ?? null;
}
