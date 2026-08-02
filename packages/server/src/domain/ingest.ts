import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  agentLogEntries,
  auditExportQueue,
  commands,
  instances,
  jobActivity,
  jobHistory,
  jobs,
  notificationEvents,
  syncState,
  TERMINAL_COMMAND_STATES,
  workers,
} from '../db/schema.js';
import type { ActivityRow, AgentLogRow, HistoryRow, InstanceInfo } from '@remote-sql-agent/protocol';
import { fromTimestamp } from '@remote-sql-agent/protocol';

/**
 * Ingestion of everything the worker streams up.
 *
 * Every path here must be idempotent. The worker's outbox replays on
 * reconnect and a worker restart re-sends a full snapshot, so "apply twice"
 * is the normal case, not an edge case.
 */

/**
 * Record a Hello against an already-authenticated worker.
 *
 * The worker row is created at enrolment, not here, and is looked up by the id
 * the authenticator established. Nothing self-reported in Hello is used to
 * decide *which* worker this is — otherwise any authenticated worker could
 * claim another's host name and take over its instances.
 */
export async function recordWorkerHello(
  db: Database,
  params: {
    workerId: string;
    version: string;
    maxCapabilityReported: string;
    remoteAddress?: string | null;
  },
): Promise<{ id: string; hostName: string; capabilities: string[] }> {
  const now = new Date();
  const [row] = await db
    .update(workers)
    .set({
      version: params.version,
      maxCapabilityReported: params.maxCapabilityReported,
      connectedAt: now,
      lastSeenAt: now,
      lastRemoteAddress: params.remoteAddress ?? null,
    })
    .where(eq(workers.id, params.workerId))
    .returning({
      id: workers.id,
      hostName: workers.hostName,
      capabilities: workers.capabilities,
    });

  if (!row) throw new Error(`Authenticated worker ${params.workerId} no longer exists`);
  return row;
}

export async function upsertInstances(
  db: Database,
  workerId: string,
  infos: InstanceInfo[],
): Promise<Map<string, string>> {
  const now = new Date();
  const byName = new Map<string, string>();

  for (const info of infos) {
    const [row] = await db
      .insert(instances)
      .values({
        workerId,
        instanceName: info.instanceName,
        serverName: info.serverName || null,
        sqlVersion: info.sqlVersion || null,
        sqlEdition: info.sqlEdition || null,
        agentStatus: info.agentStatus || 'unknown',
        jobWriteMode: info.writeMode ?? null,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: [instances.workerId, instances.instanceName],
        set: {
          serverName: info.serverName || null,
          sqlVersion: info.sqlVersion || null,
          sqlEdition: info.sqlEdition || null,
          agentStatus: info.agentStatus || 'unknown',
          // Overwritten on every Hello, never merged: a DBA who uninstalls the
          // wrapper or empties the allowlist must see that reflected, and
          // keeping a stale entry would leave the dashboard offering an edit
          // that no longer works.
          jobWriteMode: info.writeMode ?? null,
          lastSeenAt: now,
        },
      })
      .returning({ id: instances.id });

    if (!row) continue;
    byName.set(info.instanceName, row.id);

    await db.insert(syncState).values({ instanceId: row.id }).onConflictDoNothing();
  }

  return byName;
}

export async function touchWorker(db: Database, workerId: string): Promise<void> {
  await db.update(workers).set({ lastSeenAt: new Date() }).where(eq(workers.id, workerId));
}

export async function markWorkerDisconnected(db: Database, workerId: string): Promise<void> {
  await db.update(workers).set({ connectedAt: null }).where(eq(workers.id, workerId));
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export interface IngestedRun {
  jobUuid: string;
  sqlInstanceId: number;
  runStatus: number;
  runDatetime: Date;
  runDurationSeconds: number;
  message: string | null;
}

export interface HistoryIngestResult {
  inserted: number;
  highWaterMark: number;
  /**
   * Job-level outcome rows this call actually created — never rows that were
   * already held. Notification detection keys off this, so a replayed outbox
   * batch cannot re-alert on a failure from last week.
   */
  newRuns: IngestedRun[];
}

/**
 * Insert history rows, ignoring any we already hold.
 *
 * Deduplication is on (instance_id, sysjobhistory.instance_id) — msdb's own row
 * identity — so a replayed outbox batch cannot duplicate runs. The high-water
 * mark only ever moves forward.
 */
export async function ingestHistory(
  db: Database,
  instanceId: string,
  rows: HistoryRow[],
): Promise<HistoryIngestResult> {
  if (rows.length === 0) {
    const current = await getHistoryHighWaterMark(db, instanceId);
    return { inserted: 0, highWaterMark: current, newRuns: [] };
  }

  const values = rows
    .map((r) => {
      const runDatetime = fromTimestamp(r.runDatetime);
      if (!runDatetime) return null;
      return {
        instanceId,
        jobUuid: r.jobUuid,
        sqlInstanceId: Number(r.instanceId),
        stepId: r.stepId,
        stepName: r.stepName || null,
        runStatus: r.runStatus,
        runDatetime,
        runDurationSeconds: r.runDurationSeconds,
        message: r.message || null,
        retriesAttempted: r.retriesAttempted,
        server: r.server || null,
        sqlSeverity: r.sqlSeverity,
        sqlMessageId: r.sqlMessageId,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  if (values.length === 0) {
    return { inserted: 0, highWaterMark: await getHistoryHighWaterMark(db, instanceId), newRuns: [] };
  }

  // RETURNING after ON CONFLICT DO NOTHING yields only the rows that were
  // genuinely new, which is exactly the signal notification detection needs.
  const inserted = await db
    .insert(jobHistory)
    .values(values)
    .onConflictDoNothing({ target: [jobHistory.instanceId, jobHistory.sqlInstanceId] })
    .returning({
      id: jobHistory.id,
      jobUuid: jobHistory.jobUuid,
      sqlInstanceId: jobHistory.sqlInstanceId,
      stepId: jobHistory.stepId,
      runStatus: jobHistory.runStatus,
      runDatetime: jobHistory.runDatetime,
      runDurationSeconds: jobHistory.runDurationSeconds,
      message: jobHistory.message,
    });

  const batchMax = Math.max(...values.map((v) => v.sqlInstanceId));
  await db
    .insert(syncState)
    .values({ instanceId, historyHighWaterMark: batchMax })
    .onConflictDoUpdate({
      target: syncState.instanceId,
      // GREATEST guards against an out-of-order replay dragging the mark back,
      // which would cause the worker to re-ship history it already sent.
      set: {
        historyHighWaterMark: sql`GREATEST(${syncState.historyHighWaterMark}, ${batchMax})`,
      },
    });

  await refreshLastRunSummary(db, instanceId, [...new Set(values.map((v) => v.jobUuid))]);

  return {
    inserted: inserted.length,
    highWaterMark: batchMax,
    newRuns: inserted
      .filter((r) => r.stepId === 0)
      .map(({ id: _id, stepId: _stepId, ...run }) => run),
  };
}

export async function getHistoryHighWaterMark(db: Database, instanceId: string): Promise<number> {
  const [row] = await db
    .select({ hwm: syncState.historyHighWaterMark })
    .from(syncState)
    .where(eq(syncState.instanceId, instanceId));
  return row?.hwm ?? 0;
}

/**
 * Refresh the denormalised last-run columns on `jobs` so the estate overview is
 * one cheap query rather than a correlated subquery per job. Only step_id = 0
 * rows count — that is the job-level outcome row, and using step rows would
 * report the last *step* outcome as the job outcome.
 */
async function refreshLastRunSummary(
  db: Database,
  instanceId: string,
  jobUuids: string[],
): Promise<void> {
  for (const jobUuid of jobUuids) {
    const [latest] = await db
      .select({
        runStatus: jobHistory.runStatus,
        runDatetime: jobHistory.runDatetime,
        durationSeconds: jobHistory.runDurationSeconds,
      })
      .from(jobHistory)
      .where(
        and(
          eq(jobHistory.instanceId, instanceId),
          eq(jobHistory.jobUuid, jobUuid),
          eq(jobHistory.stepId, 0),
        ),
      )
      .orderBy(desc(jobHistory.runDatetime), desc(jobHistory.sqlInstanceId))
      .limit(1);

    if (!latest) continue;

    await db
      .update(jobs)
      .set({
        lastRunStatus: latest.runStatus,
        lastRunAt: latest.runDatetime,
        lastRunDurationSeconds: latest.durationSeconds,
      })
      .where(and(eq(jobs.instanceId, instanceId), eq(jobs.jobUuid, jobUuid)));
  }
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export async function upsertActivity(
  db: Database,
  instanceId: string,
  rows: ActivityRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();

  for (const r of rows) {
    await db
      .insert(jobActivity)
      .values({
        instanceId,
        jobUuid: r.jobUuid,
        state: r.state,
        currentStepId: r.currentStepId || null,
        currentStepName: r.currentStepName || null,
        startedAt: fromTimestamp(r.startExecutionDate),
        lastExecutedStepAt: fromTimestamp(r.lastExecutedStepDate),
        nextScheduledRunAt: fromTimestamp(r.nextScheduledRunDate),
        lastRunOutcome: r.lastRunOutcome,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [jobActivity.instanceId, jobActivity.jobUuid],
        set: {
          state: r.state,
          currentStepId: r.currentStepId || null,
          currentStepName: r.currentStepName || null,
          startedAt: fromTimestamp(r.startExecutionDate),
          lastExecutedStepAt: fromTimestamp(r.lastExecutedStepDate),
          nextScheduledRunAt: fromTimestamp(r.nextScheduledRunDate),
          lastRunOutcome: r.lastRunOutcome,
          updatedAt: now,
        },
      });

    const nextRun = fromTimestamp(r.nextScheduledRunDate);
    if (nextRun) {
      await db
        .update(jobs)
        .set({ nextRunAt: nextRun })
        .where(and(eq(jobs.instanceId, instanceId), eq(jobs.jobUuid, r.jobUuid)));
    }
  }
}

// ---------------------------------------------------------------------------
// Agent error log
// ---------------------------------------------------------------------------

/**
 * The Agent error log has no row identity of its own, so re-tailing after a
 * reconnect would duplicate entries. Hash the content to get one.
 */
export function agentLogDedupeKey(loggedAt: Date, message: string, processInfo: string): string {
  return createHash('sha256')
    .update(`${loggedAt.toISOString()}|${processInfo}|${message}`, 'utf8')
    .digest('hex');
}

export async function ingestAgentLog(
  db: Database,
  instanceId: string,
  rows: AgentLogRow[],
): Promise<number> {
  if (rows.length === 0) return 0;

  const values = rows
    .map((r) => {
      const loggedAt = fromTimestamp(r.loggedAt);
      if (!loggedAt) return null;
      return {
        instanceId,
        loggedAt,
        severity: r.severity || null,
        message: r.message,
        processInfo: r.processInfo || null,
        dedupeKey: agentLogDedupeKey(loggedAt, r.message, r.processInfo ?? ''),
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  if (values.length === 0) return 0;

  const inserted = await db
    .insert(agentLogEntries)
    .values(values)
    .onConflictDoNothing({ target: [agentLogEntries.instanceId, agentLogEntries.dedupeKey] })
    .returning({ id: agentLogEntries.id });

  const newest = values.reduce((a, b) => (a.loggedAt > b.loggedAt ? a : b));
  const newestIso = newest.loggedAt.toISOString();
  await db
    .insert(syncState)
    .values({ instanceId, agentLogHighWaterMark: newest.loggedAt })
    .onConflictDoUpdate({
      target: syncState.instanceId,
      set: {
        agentLogHighWaterMark: sql`GREATEST(
          COALESCE(${syncState.agentLogHighWaterMark}, ${newestIso}::timestamptz),
          ${newestIso}::timestamptz
        )`,
      },
    });

  return inserted.length;
}

/**
 * Delete history, log and operational-bookkeeping rows older than the
 * retention window (§8).
 *
 * Deliberately not touching `audit_log`: that table is append-only by design
 * (see the comment on `writeAudit`), and its own retention — if it is ever
 * needed — belongs in an explicit archival job that exports before it removes,
 * not here. `commands` is pruned, but only terminal rows (a command still
 * `pending_approval`, `approved` or `dispatched` is never touched regardless of
 * age) — the durable record of what happened lives in `audit_log.detail` and
 * `job_versions` either way, so this only drops the dispatch bookkeeping that
 * already served its purpose.
 *
 * `audit_export_queue` is the one row here that is not really about *age*: a
 * healthy queue drains within minutes (delivered or given up on past
 * `maxAttempts`, both of which delete the row immediately — see
 * audit-export.ts), so this is normally a no-op for it. It stops being a no-op
 * when OTLP export is disabled, which is the default: `writeAudit` enqueues a
 * row here unconditionally on every audited action, and nothing ever drains
 * the queue while export is off, so left alone it grows for the entire
 * lifetime of the deployment. Bounding it by age here — rather than
 * special-casing "export is disabled" — means the same one rule ("nothing
 * outlives the retention window") covers both the healthy and the
 * never-going-to-be-exported case without `pruneRetention` needing to know
 * which one it is.
 */
export async function pruneRetention(db: Database, retentionDays: number): Promise<void> {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  await db.delete(jobHistory).where(lt(jobHistory.runDatetime, cutoff));
  await db.delete(agentLogEntries).where(lt(agentLogEntries.loggedAt, cutoff));
  // Deliveries cascade from the event they belong to (onDelete: 'cascade'),
  // so removing old events is enough to keep both tables bounded.
  await db.delete(notificationEvents).where(lt(notificationEvents.occurredAt, cutoff));
  await db
    .delete(commands)
    .where(and(inArray(commands.state, TERMINAL_COMMAND_STATES), lt(commands.completedAt, cutoff)));
  await db.delete(auditExportQueue).where(lt(auditExportQueue.createdAt, cutoff));
}
