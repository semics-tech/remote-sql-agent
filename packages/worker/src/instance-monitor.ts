import { randomUUID } from 'node:crypto';
import type sql from 'mssql';
import type { Logger } from 'pino';
import {
  canonicaliseJobWithHash,
  toTimestamp,
  toTimestampOrUndefined,
  type HistoryRow,
  type ActivityRow,
  type AgentLogRow,
  type JobDefinitionBlob,
  type WorkerMessage,
} from '@remote-sql-agent/protocol';
import type { InstanceConfig } from './config.js';
import type { Outbox } from './outbox.js';
import {
  AgentLogUnavailable,
  readActivity,
  readAgentErrorLog,
  readHistorySince,
  readIdentity,
  readJobs,
  readJobsFingerprint,
  readMaxHistoryId,
  type InstanceIdentity,
  type JobsFingerprint,
} from './sql/agent-repo.js';
import { connectInstance } from './sql/pool.js';

/**
 * Owns one SQL Server instance: its connection, its polling loops and its
 * incremental bookmarks.
 *
 * Everything produced here goes through `emit`, which either writes to the live
 * stream or falls back to the outbox. No poller knows or cares whether the
 * control plane is reachable — that is the only way offline behaviour stays
 * correct as pollers are added.
 */

export interface InstanceMonitorDeps {
  config: InstanceConfig;
  outbox: Outbox;
  logger: Logger;
  /** Returns true if the message was accepted by the live stream. */
  emit: (message: WorkerMessage) => boolean;
}

export interface PollIntervals {
  definitionSeconds: number;
  historySeconds: number;
  activitySeconds: number;
  agentLogSeconds: number;
  historyBatchSize: number;
}

/** Chunk size for snapshot upload; keeps individual gRPC messages well clear
 * of the 32 MiB receive limit even with large T-SQL step bodies. */
const SNAPSHOT_CHUNK_SIZE = 25;

/**
 * Cadence while a job is actually executing.
 *
 * The configured interval — ten seconds by default — is right for an idle
 * instance and useless for watching a run: plenty of Agent jobs finish inside
 * it, so `executing` is never observed at all and the dashboard goes straight
 * from "starting" to "finished" with nothing in between. While something is
 * running, both activity and history are polled at this instead, so step
 * completions land on the timeline as they happen.
 */
const ACTIVE_POLL_MS = 750;

/**
 * How long to keep the fast cadence after issuing a start.
 *
 * `sp_start_job` returns as soon as Agent accepts the request, before the job
 * appears in `sysjobactivity`, so the first poll after a command usually sees
 * nothing. This covers that gap without leaving the instance polling hard
 * forever if the job never starts.
 */
const START_BURST_MS = 15_000;

export class InstanceMonitor {
  #pool: sql.ConnectionPool | null = null;
  #identity: InstanceIdentity | null = null;
  #timers: NodeJS.Timeout[] = [];
  #definitionHashes = new Map<string, string>();
  #lastFingerprint: JobsFingerprint | null = null;
  #agentLogSupported = true;
  #warnedUnknownSubsystems = new Set<string>();
  #stopped = false;

  /** True while SQL Agent reports at least one job on this instance executing. */
  #anyExecuting = false;
  /** Epoch ms until which to poll fast regardless, after issuing a start. */
  #fastUntil = 0;
  #liveTimer: NodeJS.Timeout | null = null;
  #intervals: PollIntervals | null = null;

  /**
   * Serialises definition polling against command application.
   *
   * Without this, the scheduled poll can observe a change a command has just
   * made and report it before the command's own result is processed — so the
   * operator's edit comes back attributed as on-prem drift.
   */
  #exclusive: Promise<unknown> = Promise.resolve();

  /**
   * jobUuid -> commandId for changes this worker just made itself. Consumed by
   * the next delta for that job so the control plane attributes it to the
   * command rather than to someone editing in SSMS.
   */
  #pendingAttribution = new Map<string, string>();

  constructor(private readonly deps: InstanceMonitorDeps) {}

  get instanceName(): string {
    return this.deps.config.name;
  }

  get identity(): InstanceIdentity | null {
    return this.#identity;
  }

  /** The live connection, for the command handler. Null while disconnected. */
  get connectionPool(): sql.ConnectionPool | null {
    return this.#pool;
  }

  async connect(): Promise<void> {
    this.#pool = await connectInstance(this.deps.config);
    this.#identity = await readIdentity(this.#pool);
    this.#definitionHashes = this.deps.outbox.getDefinitionHashes(this.instanceName);

    // Seed the history bookmark to the current maximum on very first contact so
    // a new worker does not replay years of history on day one. Once a bookmark
    // exists it is always honoured.
    if (this.deps.outbox.getHistoryHighWaterMark(this.instanceName) === 0) {
      const max = await readMaxHistoryId(this.#pool);
      // Back off by a small window so a run in flight during enrolment is not
      // lost entirely.
      this.deps.outbox.setHistoryHighWaterMark(this.instanceName, Math.max(0, max - 100));
    }

    this.deps.logger.info(
      {
        instance: this.instanceName,
        server: this.#identity.serverName,
        version: this.#identity.sqlVersion,
        edition: this.#identity.sqlEdition,
        agent: this.#identity.agentStatus,
      },
      'Connected to SQL Server instance',
    );
  }

  /**
   * Run something with definition polling held off, and with polling unable to
   * start midway through it.
   */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#exclusive.then(fn, fn);
    // Swallow on the chain itself so one failure does not poison every
    // subsequent poll.
    this.#exclusive = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Attribute the next observed change to a job to the command that caused it. */
  noteAppliedCommand(jobUuid: string, commandId: string): void {
    this.#pendingAttribution.set(jobUuid.toLowerCase(), commandId);
  }

  async refreshIdentity(): Promise<InstanceIdentity | null> {
    if (!this.#pool) return null;
    try {
      this.#identity = await readIdentity(this.#pool);
    } catch (err) {
      this.deps.logger.warn({ err, instance: this.instanceName }, 'Failed to refresh identity');
    }
    return this.#identity;
  }

  startPolling(intervals: PollIntervals): void {
    this.stopPolling();
    this.#stopped = false;

    const schedule = (fn: () => Promise<void>, seconds: number, label: string): void => {
      const run = (): void => {
        if (this.#stopped) return;
        fn().catch((err: unknown) => {
          this.deps.logger.error({ err, instance: this.instanceName }, `${label} poll failed`);
        });
      };
      const timer = setInterval(run, seconds * 1000);
      timer.unref();
      this.#timers.push(timer);
      run();
    };

    schedule(() => this.pollDefinitions(), intervals.definitionSeconds, 'definition');
    if (this.#agentLogSupported) {
      schedule(() => this.pollAgentLog(), intervals.agentLogSeconds, 'agent log');
    }

    // Activity and history share one self-rescheduling loop rather than fixed
    // intervals, so the cadence can follow whether anything is actually
    // running. They are polled together on purpose: a step completion is only
    // meaningful alongside the activity row that says which step came next.
    this.#intervals = intervals;
    this.#scheduleLivePoll(0);
  }

  #scheduleLivePoll(delayMs: number): void {
    if (this.#stopped) return;
    if (this.#liveTimer) clearTimeout(this.#liveTimer);

    this.#liveTimer = setTimeout(() => {
      void this.#livePollOnce()
        .catch((err: unknown) => {
          this.deps.logger.error({ err, instance: this.instanceName }, 'Live poll failed');
        })
        .finally(() => this.#scheduleLivePoll(this.#nextLiveDelayMs()));
    }, delayMs);
    this.#liveTimer.unref();
  }

  #nextLiveDelayMs(): number {
    const idle = (this.#intervals?.activitySeconds ?? 10) * 1000;
    const fast = this.#anyExecuting || Date.now() < this.#fastUntil;
    return fast ? ACTIVE_POLL_MS : idle;
  }

  async #livePollOnce(): Promise<void> {
    await this.pollActivity();
    // History second: a step that finished is only visible here, and polling it
    // after activity means the two views agree rather than showing a step as
    // still running when its completion row already exists.
    await this.pollHistory(this.#intervals?.historyBatchSize ?? 500);
  }

  /**
   * Poll hard for a short window.
   *
   * Called after a start or stop is applied. Without it the first observation
   * lands on the normal interval, by which time a short job has been and gone.
   */
  nudgeActivity(): void {
    this.#fastUntil = Date.now() + START_BURST_MS;
    this.#scheduleLivePoll(0);
  }

  stopPolling(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    if (this.#liveTimer) clearTimeout(this.#liveTimer);
    this.#liveTimer = null;
  }

  async close(): Promise<void> {
    this.stopPolling();
    await this.#pool?.close();
    this.#pool = null;
  }

  // -------------------------------------------------------------------------
  // Snapshot
  // -------------------------------------------------------------------------

  /**
   * Upload the full object graph. Sent on every (re)connect: it is the only way
   * the control plane can learn about changes that happened while the worker
   * was offline, including deletions.
   */
  async sendSnapshot(): Promise<void> {
    if (!this.#pool) return;
    const { jobs, unknownSubsystems } = await readJobs(this.#pool);
    this.#warnUnknownSubsystems(unknownSubsystems);

    const snapshotId = randomUUID();
    const blobs = jobs.map((job) => this.#toBlob(job.jobUuid, job.definition, job.dateModified));

    // Refresh the local hash cache from the snapshot so the next definition
    // poll compares against what we just uploaded.
    this.#definitionHashes = new Map(blobs.map((b) => [b.jobUuid, b.definitionHash]));
    this.deps.outbox.setDefinitionHashes(this.instanceName, this.#definitionHashes);
    this.#lastFingerprint = await readJobsFingerprint(this.#pool);

    // Always send a final chunk with moreChunks=false, even for an empty
    // estate: the server only commits (and reconciles deletions) on that chunk.
    const chunks: JobDefinitionBlob[][] = [];
    for (let i = 0; i < blobs.length; i += SNAPSHOT_CHUNK_SIZE) {
      chunks.push(blobs.slice(i, i + SNAPSHOT_CHUNK_SIZE));
    }
    if (chunks.length === 0) chunks.push([]);

    chunks.forEach((chunk, index) => {
      this.deps.emit({
        msg: {
          $case: 'snapshot',
          snapshot: {
            snapshotId,
            instanceName: this.instanceName,
            moreChunks: index < chunks.length - 1,
            jobs: chunk,
            schedules: [],
            operators: [],
            alerts: [],
          },
        },
      });
    });

    this.deps.logger.info(
      { instance: this.instanceName, jobs: blobs.length, chunks: chunks.length },
      'Snapshot sent',
    );
  }

  // -------------------------------------------------------------------------
  // Pollers
  // -------------------------------------------------------------------------

  /**
   * Detect definition changes by canonical hash (§5.3).
   *
   * A cheap fingerprint (max date_modified + job count) short-circuits the
   * common case where nothing has changed, so a 500-job instance is not
   * serialised and hashed every 30 seconds.
   */
  async pollDefinitions(): Promise<void> {
    return this.runExclusive(() => this.#pollDefinitionsNow());
  }

  async #pollDefinitionsNow(): Promise<void> {
    if (!this.#pool) return;

    const fingerprint = await readJobsFingerprint(this.#pool);
    if (
      this.#lastFingerprint &&
      this.#lastFingerprint.jobCount === fingerprint.jobCount &&
      sameTime(this.#lastFingerprint.maxDateModified, fingerprint.maxDateModified)
    ) {
      return;
    }

    const { jobs, unknownSubsystems } = await readJobs(this.#pool);
    this.#warnUnknownSubsystems(unknownSubsystems);

    const seen = new Set<string>();
    let changes = 0;

    for (const job of jobs) {
      const blob = this.#toBlob(job.jobUuid, job.definition, job.dateModified);
      seen.add(job.jobUuid);

      if (this.#definitionHashes.get(job.jobUuid) === blob.definitionHash) continue;

      this.#definitionHashes.set(job.jobUuid, blob.definitionHash);
      changes += 1;

      // If this worker made the change itself, say so: an unattributed delta
      // would be recorded as on-prem drift and the operator would see their own
      // edit flagged as someone else meddling.
      const attributedTo = this.#pendingAttribution.get(job.jobUuid) ?? '';
      this.#pendingAttribution.delete(job.jobUuid);

      this.deps.emit({
        msg: {
          $case: 'definition',
          definition: {
            instanceName: this.instanceName,
            job: blob,
            deleted: false,
            appliedCommandId: attributedTo,
          },
        },
      });
    }

    // A job that has vanished needs a full snapshot to reconcile: the delta
    // channel carries changes to jobs that still exist, and the server only
    // soft-deletes on a complete snapshot.
    const vanished = [...this.#definitionHashes.keys()].filter((uuid) => !seen.has(uuid));
    if (vanished.length > 0) {
      this.deps.logger.info(
        { instance: this.instanceName, vanished: vanished.length },
        'Jobs disappeared on-prem; sending a reconciling snapshot',
      );
      await this.sendSnapshot();
      return;
    }

    this.#lastFingerprint = fingerprint;
    this.deps.outbox.setDefinitionHashes(this.instanceName, this.#definitionHashes);

    if (changes > 0) {
      this.deps.logger.info(
        { instance: this.instanceName, changes },
        'Definition changes detected and sent',
      );
    }
  }

  async pollHistory(batchSize: number): Promise<void> {
    if (!this.#pool) return;

    // Drain in a loop: after an outage there may be far more than one batch
    // waiting, and one batch per interval would take hours to catch up.
    for (;;) {
      const hwm = this.deps.outbox.getHistoryHighWaterMark(this.instanceName);
      const records = await readHistorySince(this.#pool, hwm, batchSize);
      if (records.length === 0) return;

      const rows: HistoryRow[] = records.map((r) => ({
        instanceId: r.sqlInstanceId,
        jobUuid: r.jobUuid,
        stepId: r.stepId,
        stepName: r.stepName,
        runStatus: r.runStatus,
        runDatetime: toTimestamp(r.runDatetime),
        runDurationSeconds: r.runDurationSeconds,
        message: r.message,
        retriesAttempted: r.retriesAttempted,
        server: r.server,
        sqlSeverity: r.sqlSeverity,
        sqlMessageId: r.sqlMessageId,
      }));

      this.deps.emit({
        msg: { $case: 'history', history: { instanceName: this.instanceName, rows } },
      });

      const maxId = Math.max(...records.map((r) => r.sqlInstanceId));
      this.deps.outbox.setHistoryHighWaterMark(this.instanceName, maxId);

      if (records.length < batchSize) return;
    }
  }

  async pollActivity(): Promise<void> {
    if (!this.#pool) return;
    const records = await readActivity(this.#pool);

    // Drives the poll cadence. Recomputed on every read rather than only on
    // change, so a job that starts on its own schedule speeds the loop up too —
    // not just one the dashboard asked for.
    this.#anyExecuting = records.some((r) => r.state === 'executing');

    if (records.length === 0) return;

    const rows: ActivityRow[] = records.map((r) => ({
      jobUuid: r.jobUuid,
      state: r.state,
      currentStepId: r.currentStepId,
      currentStepName: r.currentStepName,
      startExecutionDate: toTimestampOrUndefined(r.startExecutionDate),
      lastExecutedStepDate: toTimestampOrUndefined(r.lastExecutedStepDate),
      nextScheduledRunDate: toTimestampOrUndefined(r.nextScheduledRunDate),
      lastRunOutcome: r.lastRunOutcome,
    }));

    this.deps.emit({
      msg: { $case: 'activity', activity: { instanceName: this.instanceName, rows } },
    });
  }

  async pollAgentLog(): Promise<void> {
    if (!this.#pool || !this.#agentLogSupported) return;

    const since = this.deps.outbox.getAgentLogHighWaterMark(this.instanceName);
    let records;
    try {
      records = await readAgentErrorLog(this.#pool, since);
    } catch (err) {
      if (err instanceof AgentLogUnavailable) {
        // Expected for a least-privileged login. Disable the poller rather than
        // demanding elevated rights the security model says we must not need.
        this.#agentLogSupported = false;
        this.deps.logger.warn(
          { instance: this.instanceName },
          'Agent error log is not readable by this login; log streaming disabled for this instance. ' +
            'Grant EXECUTE on xp_readerrorlog if you want it, or leave it off.',
        );
        return;
      }
      throw err;
    }

    // xp_readerrorlog's @startDate filter is inclusive, so the boundary row
    // comes back every poll; drop anything at or before the bookmark.
    const fresh = since ? records.filter((r) => r.loggedAt > since) : records;
    if (fresh.length === 0) return;

    const rows: AgentLogRow[] = fresh.map((r) => ({
      loggedAt: toTimestamp(r.loggedAt),
      severity: r.severity,
      message: r.message,
      processInfo: r.processInfo,
    }));

    this.deps.emit({
      msg: { $case: 'agentLog', agentLog: { instanceName: this.instanceName, rows } },
    });

    const newest = fresh.reduce((a, b) => (a.loggedAt > b.loggedAt ? a : b));
    this.deps.outbox.setAgentLogHighWaterMark(this.instanceName, newest.loggedAt);
  }

  // -------------------------------------------------------------------------

  #toBlob(jobUuid: string, definition: unknown, dateModified: Date): JobDefinitionBlob {
    const { canonicalJson, hash } = canonicaliseJobWithHash(definition);
    return {
      jobUuid,
      canonicalJson,
      definitionHash: hash,
      dateModified: toTimestamp(dateModified),
    };
  }

  #warnUnknownSubsystems(subsystems: string[]): void {
    for (const subsystem of subsystems) {
      if (this.#warnedUnknownSubsystems.has(subsystem)) continue;
      this.#warnedUnknownSubsystems.add(subsystem);
      this.deps.logger.warn(
        { instance: this.instanceName, subsystem },
        'Job step uses a subsystem this worker version does not model; ' +
          'it is mirrored as CmdExec and must not be written back until support is added',
      );
    }
  }
}

function sameTime(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}
