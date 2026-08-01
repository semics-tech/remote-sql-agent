import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Database } from '../../db/client.js';
import type { ServerConfig } from '../../config.js';
import {
  instances,
  jobs,
  notificationChannels,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
  workers,
  type NotificationEventKind,
} from '../../db/schema.js';
import { NotificationSendError, sendNotification, type Channel } from './senders.js';
import type { NotificationEventView } from './render.js';

/**
 * Notification pipeline.
 *
 *   detector  -> recordEvent()   (deduplicated; nothing is notified twice)
 *             -> fanOut()        (rules matched, throttling applied)
 *             -> deliveries      (queued rows, one per channel)
 *             -> drain()         (sent, with backoff on failure)
 *
 * Detection and delivery are separated by the queue on purpose. Detection runs
 * inside ingestion, which must stay fast and must never fail because Slack is
 * down; delivery runs on its own timer and can afford to be slow and retried.
 */

export interface RecordEventInput {
  kind: NotificationEventKind;
  /** Stable identity for this occurrence. Re-recording it is a no-op. */
  dedupeKey: string;
  instanceId?: string | null;
  workerId?: string | null;
  jobUuid?: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

const MAX_ATTEMPTS = 8;
const SEND_TIMEOUT_MS = 15_000;

export class NotificationService {
  #timer: NodeJS.Timeout | null = null;
  #draining = false;

  constructor(
    private readonly db: Database,
    private readonly config: ServerConfig,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.drain().catch((err: unknown) => {
        this.logger.error({ err }, 'Notification delivery sweep failed');
      });
    }, 10_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Record an event and queue whatever it should notify.
   *
   * Returns false when this occurrence was already known — the normal outcome
   * when a worker replays its outbox after a reconnect.
   */
  async recordEvent(input: RecordEventInput): Promise<boolean> {
    const [event] = await this.db
      .insert(notificationEvents)
      .values({
        kind: input.kind,
        dedupeKey: input.dedupeKey,
        instanceId: input.instanceId ?? null,
        workerId: input.workerId ?? null,
        jobUuid: input.jobUuid ?? null,
        payload: input.payload,
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing({ target: notificationEvents.dedupeKey })
      .returning({ id: notificationEvents.id });

    if (!event) return false;

    await this.#fanOut(event.id, input);
    return true;
  }

  /** Match rules, apply throttling, and queue one delivery per channel. */
  async #fanOut(eventId: string, input: RecordEventInput): Promise<void> {
    const rules = await this.db
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.enabled, true));

    const jobName = typeof input.payload.jobName === 'string' ? input.payload.jobName : '';
    const throttleKey = `${input.kind}:${input.instanceId ?? input.workerId ?? 'estate'}:${input.jobUuid ?? ''}`;

    // A channel named by two rules gets one delivery, not two — the unique
    // index on (event, channel) enforces that.
    //
    // Where the rules disagree on throttling, the *shortest* window wins. The
    // alternative silently suppresses alerts someone explicitly asked for: a
    // rule set to zero means "send me all of these", and letting an unrelated
    // chattier rule mute it is a surprise in the direction of missing an
    // incident. Over-delivering is recoverable; under-delivering is not.
    const targets = new Map<string, { ruleId: string; throttleMinutes: number }>();

    for (const rule of rules) {
      if (!rule.events.includes(input.kind)) continue;
      if (rule.instanceIds.length > 0) {
        if (!input.instanceId || !rule.instanceIds.includes(input.instanceId)) continue;
      }
      if (rule.jobNameContains) {
        if (!jobName.toLowerCase().includes(rule.jobNameContains.toLowerCase())) continue;
      }

      for (const channelId of rule.channelIds) {
        const existing = targets.get(channelId);
        if (!existing || rule.throttleMinutes < existing.throttleMinutes) {
          targets.set(channelId, { ruleId: rule.id, throttleMinutes: rule.throttleMinutes });
        }
      }
    }

    if (targets.size === 0) return;

    for (const [channelId, { ruleId, throttleMinutes }] of targets) {
      const suppressed =
        throttleMinutes > 0 && (await this.#recentlySent(channelId, throttleKey, throttleMinutes));

      await this.db
        .insert(notificationDeliveries)
        .values({
          eventId,
          ruleId,
          channelId,
          throttleKey,
          // Suppressed rows are still written: "we decided not to tell you"
          // is part of the record, and without it a silent hour looks like a
          // broken pipeline rather than a working throttle.
          state: suppressed ? 'suppressed' : 'pending',
          lastError: suppressed ? `Throttled: an alert for this was sent within ${throttleMinutes} minutes.` : null,
        })
        .onConflictDoNothing({
          target: [notificationDeliveries.eventId, notificationDeliveries.channelId],
        });
    }
  }

  async #recentlySent(channelId: string, throttleKey: string, minutes: number): Promise<boolean> {
    const since = new Date(Date.now() - minutes * 60 * 1000);
    const [row] = await this.db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.channelId, channelId),
          eq(notificationDeliveries.throttleKey, throttleKey),
          eq(notificationDeliveries.state, 'sent'),
          gte(notificationDeliveries.sentAt, since),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Send everything due. Failures back off; permanent ones stop retrying.
   *
   * `#draining` only prevents two overlapping drains *in this process* — the
   * SELECT below takes no row lock (no `FOR UPDATE SKIP LOCKED`), so two
   * control-plane replicas draining at once would both select the same due
   * deliveries and send duplicate notifications. This is currently harmless:
   * the control plane runs as exactly one replica for an unrelated, stronger
   * reason (the worker registry is an in-memory map — see "Exactly one
   * replica" in docs/deployment.md), so there is only ever one drain loop
   * running anywhere. Add row-claiming here first if that ever changes.
   */
  async drain(limit = 50): Promise<number> {
    if (this.#draining) return 0;
    this.#draining = true;

    try {
      const due = await this.db
        .select({
          delivery: notificationDeliveries,
          event: notificationEvents,
          channel: notificationChannels,
        })
        .from(notificationDeliveries)
        .innerJoin(notificationEvents, eq(notificationEvents.id, notificationDeliveries.eventId))
        .innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
        .where(
          and(
            eq(notificationDeliveries.state, 'pending'),
            lte(notificationDeliveries.nextAttemptAt, new Date()),
            eq(notificationChannels.enabled, true),
          ),
        )
        .orderBy(asc(notificationDeliveries.nextAttemptAt))
        .limit(limit);

      let sent = 0;
      for (const row of due) {
        if (await this.#deliver(row.delivery.id, row.channel, row.event, row.delivery.attempts)) {
          sent += 1;
        }
      }
      return sent;
    } finally {
      this.#draining = false;
    }
  }

  async #deliver(
    deliveryId: string,
    channel: typeof notificationChannels.$inferSelect,
    event: typeof notificationEvents.$inferSelect,
    attempts: number,
  ): Promise<boolean> {
    const view: NotificationEventView = {
      kind: event.kind,
      payload: event.payload,
      occurredAt: event.occurredAt,
    };

    try {
      await sendNotification(toChannel(channel), view, {
        publicUrl: this.config.publicUrl,
        timeoutMs: SEND_TIMEOUT_MS,
      });

      await this.db
        .update(notificationDeliveries)
        .set({ state: 'sent', sentAt: new Date(), attempts: attempts + 1, lastError: null })
        .where(eq(notificationDeliveries.id, deliveryId));

      await this.db
        .update(notificationChannels)
        .set({ lastDeliveredAt: new Date(), lastError: null, lastErrorAt: null })
        .where(eq(notificationChannels.id, channel.id));

      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof NotificationSendError ? err.retryable : true;
      const nextAttempts = attempts + 1;
      const giveUp = !retryable || nextAttempts >= MAX_ATTEMPTS;

      await this.db
        .update(notificationDeliveries)
        .set({
          state: giveUp ? 'failed' : 'pending',
          attempts: nextAttempts,
          lastError: message,
          // Exponential, capped at ten minutes: long enough to ride out a
          // restart, short enough that a recovered channel catches up quickly.
          nextAttemptAt: new Date(Date.now() + Math.min(2 ** nextAttempts * 1000, 600_000)),
        })
        .where(eq(notificationDeliveries.id, deliveryId));

      await this.db
        .update(notificationChannels)
        .set({ lastError: message, lastErrorAt: new Date() })
        .where(eq(notificationChannels.id, channel.id));

      this.logger.warn(
        { channel: channel.name, kind: event.kind, attempts: nextAttempts, giveUp, err: message },
        'Notification delivery failed',
      );
      return false;
    }
  }

  /** Send a channel a sample message, so a misconfiguration surfaces at setup. */
  async test(channelId: string, actor: string): Promise<void> {
    const [channel] = await this.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.id, channelId));
    if (!channel) throw new NotificationSendError('No such channel.', false);

    await sendNotification(
      toChannel(channel),
      {
        kind: 'job.failed',
        occurredAt: new Date(),
        payload: {
          jobName: 'Test notification',
          instanceName: 'MSSQLSERVER',
          hostName: 'sqlprod01',
          runDurationSeconds: 42,
          stepName: 'Rebuild indexes',
          consecutiveFailures: 1,
          message:
            `This is a test sent by ${actor} from Remote SQL Agent. ` +
            'No job has failed. If you are reading this, the channel works.',
        },
      },
      { publicUrl: this.config.publicUrl, timeoutMs: SEND_TIMEOUT_MS },
    );

    await this.db
      .update(notificationChannels)
      .set({ lastDeliveredAt: new Date(), lastError: null, lastErrorAt: null })
      .where(eq(notificationChannels.id, channelId));
  }

  // -------------------------------------------------------------------------
  // Detectors
  // -------------------------------------------------------------------------

  /**
   * Turn newly-ingested run outcomes into events.
   *
   * Only rows the insert actually created are passed in, so a replayed batch
   * produces nothing. `job.recovered` fires on the first success after one or
   * more failures, which is the event people actually want out of "succeeded" —
   * nobody wants a message for every successful nightly run.
   */
  async onRunsIngested(
    instanceId: string,
    runs: Array<{
      jobUuid: string;
      sqlInstanceId: number;
      runStatus: number;
      runDatetime: Date;
      runDurationSeconds: number;
      message: string | null;
    }>,
  ): Promise<void> {
    if (runs.length === 0) return;

    const outcomes = runs.filter((r) => r.runStatus === 0 || r.runStatus === 1);
    if (outcomes.length === 0) return;

    const context = await this.#jobContext(
      instanceId,
      outcomes.map((r) => r.jobUuid),
    );

    for (const run of outcomes) {
      const job = context.get(run.jobUuid);
      if (!job) continue;

      const history = await this.#failureContext(instanceId, run.jobUuid, run.sqlInstanceId);
      const base = {
        instanceId,
        jobUuid: run.jobUuid,
        occurredAt: run.runDatetime,
        payload: {
          instanceId,
          jobUuid: run.jobUuid,
          jobName: job.jobName,
          instanceName: job.instanceName,
          hostName: job.hostName,
          runDurationSeconds: run.runDurationSeconds,
          message: run.message,
        },
      };

      if (run.runStatus === 0) {
        await this.recordEvent({
          ...base,
          kind: 'job.failed',
          dedupeKey: `job.failed:${instanceId}:${run.jobUuid}:${run.sqlInstanceId}`,
          payload: {
            ...base.payload,
            consecutiveFailures: history.consecutiveFailures,
            stepName: history.failedStepName,
          },
        });
        continue;
      }

      await this.recordEvent({
        ...base,
        kind: 'job.succeeded',
        dedupeKey: `job.succeeded:${instanceId}:${run.jobUuid}:${run.sqlInstanceId}`,
      });

      if (history.previousFailures > 0) {
        await this.recordEvent({
          ...base,
          kind: 'job.recovered',
          dedupeKey: `job.recovered:${instanceId}:${run.jobUuid}:${run.sqlInstanceId}`,
          payload: { ...base.payload, previousFailures: history.previousFailures },
        });
      }
    }
  }

  /** Names for the message, and a check that the job still exists. */
  async #jobContext(
    instanceId: string,
    jobUuids: string[],
  ): Promise<Map<string, { jobName: string; instanceName: string; hostName: string }>> {
    const rows = await this.db
      .select({
        jobUuid: jobs.jobUuid,
        jobName: jobs.name,
        instanceName: instances.instanceName,
        hostName: workers.hostName,
      })
      .from(jobs)
      .innerJoin(instances, eq(instances.id, jobs.instanceId))
      .innerJoin(workers, eq(workers.id, instances.workerId))
      .where(and(eq(jobs.instanceId, instanceId), inArray(jobs.jobUuid, [...new Set(jobUuids)])));

    return new Map(rows.map((r) => [r.jobUuid, r]));
  }

  /**
   * How many runs failed immediately before this one, and which step failed.
   *
   * Counted from history rather than a stored counter so that a replayed or
   * out-of-order batch cannot corrupt it.
   */
  async #failureContext(
    instanceId: string,
    jobUuid: string,
    sqlInstanceId: number,
  ): Promise<{ consecutiveFailures: number; previousFailures: number; failedStepName: string }> {
    const { jobHistory } = await import('../../db/schema.js');

    const previous = await this.db
      .select({ runStatus: jobHistory.runStatus })
      .from(jobHistory)
      .where(
        and(
          eq(jobHistory.instanceId, instanceId),
          eq(jobHistory.jobUuid, jobUuid),
          eq(jobHistory.stepId, 0),
          lte(jobHistory.sqlInstanceId, sqlInstanceId),
        ),
      )
      .orderBy(desc(jobHistory.sqlInstanceId))
      .limit(30);

    // previous[0] is this run; the rest are what came before it.
    let consecutiveFailures = 0;
    for (const row of previous) {
      if (row.runStatus !== 0) break;
      consecutiveFailures += 1;
    }
    let previousFailures = 0;
    for (const row of previous.slice(1)) {
      if (row.runStatus !== 0) break;
      previousFailures += 1;
    }

    const [failedStep] = await this.db
      .select({ stepName: jobHistory.stepName })
      .from(jobHistory)
      .where(
        and(
          eq(jobHistory.instanceId, instanceId),
          eq(jobHistory.jobUuid, jobUuid),
          ne(jobHistory.stepId, 0),
          eq(jobHistory.runStatus, 0),
          lte(jobHistory.sqlInstanceId, sqlInstanceId),
          gt(jobHistory.sqlInstanceId, sqlInstanceId - 200),
        ),
      )
      .orderBy(desc(jobHistory.sqlInstanceId))
      .limit(1);

    return {
      consecutiveFailures,
      previousFailures,
      failedStepName: failedStep?.stepName ?? '',
    };
  }

  /**
   * Flag runs that have overshot their own baseline.
   *
   * Deduplicated on the run's start time, so one long run produces one alert
   * however often this sweep runs.
   */
  async sweepLongRunning(now = new Date()): Promise<number> {
    const { getRunningJobs } = await import('../overview.js');
    const running = await getRunningJobs(this.db, now);

    let raised = 0;
    for (const job of running.filter((r) => r.isLongRunning && r.startedAt)) {
      const created = await this.recordEvent({
        kind: 'job.long_running',
        dedupeKey: `job.long_running:${job.instanceId}:${job.jobUuid}:${job.startedAt!.toISOString()}`,
        instanceId: job.instanceId,
        jobUuid: job.jobUuid,
        occurredAt: now,
        payload: {
          instanceId: job.instanceId,
          jobUuid: job.jobUuid,
          jobName: job.jobName,
          instanceName: job.instanceName,
          hostName: job.hostName,
          elapsedSeconds: job.elapsedSeconds,
          averageSeconds: job.averageSeconds,
          currentStepName: job.currentStepName,
        },
      });
      if (created) raised += 1;
    }
    return raised;
  }

  /**
   * Flag workers that have stopped reporting.
   *
   * The grace period matters: a worker restarting during a patch window is not
   * an incident, and paging for it is how people learn to ignore the channel.
   */
  async sweepOfflineWorkers(isOnline: (workerId: string) => boolean, now = new Date()): Promise<number> {
    const graceMs = this.config.heartbeatSeconds * 4 * 1000;
    const cutoff = new Date(now.getTime() - graceMs);

    const rows = await this.db
      .select({
        id: workers.id,
        hostName: workers.hostName,
        lastSeenAt: workers.lastSeenAt,
        instanceCount: sql<number>`COUNT(${instances.id})`,
      })
      .from(workers)
      .leftJoin(instances, eq(instances.workerId, workers.id))
      .where(
        // Never-connected workers are pending enrolment, not offline.
        and(isNull(workers.connectedAt), or(lte(workers.lastSeenAt, cutoff))),
      )
      .groupBy(workers.id, workers.hostName, workers.lastSeenAt);

    let raised = 0;
    for (const row of rows) {
      if (isOnline(row.id) || !row.lastSeenAt) continue;
      const created = await this.recordEvent({
        kind: 'worker.offline',
        dedupeKey: `worker.offline:${row.id}:${row.lastSeenAt.toISOString()}`,
        workerId: row.id,
        occurredAt: now,
        payload: {
          hostName: row.hostName,
          instanceCount: Number(row.instanceCount),
          lastSeenAt: row.lastSeenAt.toISOString(),
        },
      });
      if (created) raised += 1;
    }
    return raised;
  }

  /** A change that was refused or failed to apply on the server. */
  async onCommandFailed(params: {
    commandId: string;
    commandType: string;
    instanceId: string;
    jobUuid: string | null;
    resultCode: string;
    resultDetail: string;
    issuedBy: string;
  }): Promise<void> {
    const [row] = await this.db
      .select({
        instanceName: instances.instanceName,
        hostName: workers.hostName,
        jobName: jobs.name,
      })
      .from(instances)
      .innerJoin(workers, eq(workers.id, instances.workerId))
      .leftJoin(
        jobs,
        and(eq(jobs.instanceId, instances.id), eq(jobs.jobUuid, params.jobUuid ?? '')),
      )
      .where(eq(instances.id, params.instanceId));

    await this.recordEvent({
      kind: 'command.failed',
      dedupeKey: `command.failed:${params.commandId}`,
      instanceId: params.instanceId,
      jobUuid: params.jobUuid,
      occurredAt: new Date(),
      payload: {
        instanceId: params.instanceId,
        jobUuid: params.jobUuid ?? '',
        jobName: row?.jobName ?? '',
        instanceName: row?.instanceName ?? '',
        hostName: row?.hostName ?? '',
        commandType: params.commandType,
        resultCode: params.resultCode,
        message: params.resultDetail,
        issuedBy: params.issuedBy,
      },
    });
  }
}

function toChannel(row: typeof notificationChannels.$inferSelect): Channel {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    config: row.config,
    secret: row.secret,
  };
}
