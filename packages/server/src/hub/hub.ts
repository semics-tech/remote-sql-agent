import * as grpc from '@grpc/grpc-js';
import type { Logger } from 'pino';
import {
  WorkerHubService,
  EnrolmentService,
  type EnrolRequest,
  type EnrolResponse,
  type ServerMessage,
  type WorkerMessage,
  type Snapshot,
  type JobDefinitionBlob,
  effectiveCapabilities,
  isMaxCapabilityTier,
  hashCanonical,
  toTimestamp,
} from '@remote-sql-agent/protocol';
import { EnrolmentError, redeemEnrolmentToken } from '../worker-auth/enrolment.js';
import type { CommandService } from '../domain/commands.js';
import { checkWorkerVersion } from './version-gate.js';
import { commands } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { ServerConfig } from '../config.js';
import { type WorkerRegistry, type LiveWorker } from './registry.js';
import {
  ingestAgentLog,
  ingestHistory,
  markWorkerDisconnected,
  recordWorkerHello,
  touchWorker,
  upsertActivity,
  upsertInstances,
} from '../domain/ingest.js';
import {
  markJobDeleted,
  markJobsMissingFromSnapshot,
  recordJobVersion,
} from '../domain/versioning.js';
import { writeAudit } from '../domain/audit.js';
import { applyHistoryScrubRules, getHistoryScrubConfig } from '../domain/history-scrubbing.js';
import { applyScrubRules, getScrubConfig } from '../domain/log-scrubbing.js';
import type { NotificationService } from '../domain/notifications/service.js';
import type { EventBroker } from '../api/events.js';
import {
  pushInstanceConfigs,
  recordCredentialKey,
  recordInstanceConfigStatus,
} from '../domain/worker-config.js';
import {
  WorkerAuthError,
  type AuthenticatedWorker,
  type WorkerAuthenticator,
} from '../worker-auth/authenticate.js';

const SERVER_VERSION = '0.1.0';

export interface PendingSnapshot {
  instanceName: string;
  jobs: JobDefinitionBlob[];
  /** When the first chunk of this snapshot arrived, for the abandonment sweep below. */
  startedAt: number;
}

/**
 * How long a chunked snapshot may sit incomplete before it is discarded.
 *
 * Generous relative to how long assembling one actually takes — `moreChunks`
 * batches are ~25 jobs each and land within a poll cycle — because the cost of
 * being wrong in the "too short" direction is a legitimate slow snapshot losing
 * its accumulated chunks and having to restart, while the cost in the "too
 * long" direction is bounded to this one duration regardless.
 */
const SNAPSHOT_ABANDON_MS = 10 * 60 * 1000;

export interface HubDeps {
  db: Database;
  config: ServerConfig;
  logger: Logger;
  registry: WorkerRegistry;
  authenticator: WorkerAuthenticator;
  commands: CommandService;
  commandSigningPublicKey: string;
  notifications: NotificationService;
  events: EventBroker;
}

/**
 * The WorkerHub gRPC service.
 *
 * One long-lived bidirectional stream per worker. Everything the worker
 * observes flows up this stream; commands flow back down it. The worker always
 * dialled out, so the control plane never needs to reach into the network
 * segment — that property is the product and must not be eroded.
 */
export function createWorkerHubService(deps: HubDeps): grpc.UntypedServiceImplementation {
  return {
    session: (call: grpc.ServerDuplexStream<WorkerMessage, ServerMessage>) => {
      void handleSession(call, deps);
    },
  };
}

async function handleSession(
  call: grpc.ServerDuplexStream<WorkerMessage, ServerMessage>,
  deps: HubDeps,
): Promise<void> {
  const { db, config, logger, registry } = deps;
  const remoteAddress = call.getPeer();

  let session: LiveWorker | null = null;
  let workerId: string | null = null;
  let hostName = '(unknown)';
  const instanceIds = new Map<string, string>();
  // Not initialised: the catch below always returns, so this is definitely
  // assigned by the time anything reads it, and TypeScript can see that. A
  // `= null` here would only be a value no path ever observes.
  let authenticated: AuthenticatedWorker;
  // Snapshots arrive chunked; only commit once more_chunks is false, so a
  // half-received snapshot can never soft-delete jobs it simply hasn't seen yet.
  const pendingSnapshots = new Map<string, PendingSnapshot>();

  const log = logger.child({ component: 'hub', peer: remoteAddress });

  const send = (message: ServerMessage): void => {
    if (!call.writable) return;
    call.write(message);
  };

  // Authenticate before a single message is processed. A stream that cannot
  // prove who it is never reaches the ingestion path at all.
  try {
    authenticated = await deps.authenticator.authenticate(call);
    hostName = authenticated.hostName;
    workerId = authenticated.workerId;
    log.info(
      { hostName, workerId, mode: authenticated.mode },
      'Worker authenticated',
    );
  } catch (err) {
    const code = err instanceof WorkerAuthError ? err.code : 'AuthFailed';
    const message = err instanceof Error ? err.message : 'Authentication failed';
    log.warn({ err, code }, 'Rejected worker session');

    await writeAudit(db, {
      actorType: 'system',
      actor: remoteAddress,
      action: 'worker.auth.failed',
      detail: { code, message },
      remoteAddress,
    }).catch(() => undefined);

    call.emit('error', {
      code: grpc.status.UNAUTHENTICATED,
      details: message,
    } as grpc.ServiceError);
    call.end();
    return;
  }

  // Message handling is serialised through a promise chain: gRPC delivers
  // messages as fast as they arrive, and concurrent ingestion of two snapshot
  // chunks (or a snapshot racing a delta) would interleave version numbers.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): void => {
    queue = queue.then(fn).catch((err: unknown) => {
      log.error({ err, hostName }, 'Failed to process worker message');
    });
  };

  call.on('data', (message: WorkerMessage) => {
    enqueue(async () => {
      const msg = message.msg;
      if (!msg) return;

      switch (msg.$case) {
        case 'hello': {
          const hello = msg.hello;

          const versionCheck = checkWorkerVersion(
            hello.workerVersion,
            config.minimumWorkerVersion,
          );
          if (!versionCheck.allowed) {
            log.warn(
              { hostName: authenticated.hostName, version: hello.workerVersion },
              versionCheck.reason,
            );
            await writeAudit(db, {
              actorType: 'worker',
              actor: authenticated.hostName,
              action: 'worker.rejected.version',
              target: authenticated.workerId,
              detail: {
                version: hello.workerVersion,
                minimum: config.minimumWorkerVersion,
              },
              remoteAddress,
            });
            call.emit('error', {
              code: grpc.status.FAILED_PRECONDITION,
              details: versionCheck.reason,
            } as grpc.ServiceError);
            call.end();
            return;
          }

          // The identity comes from the credential, never from the message. A
          // worker that claims a different host name in Hello is logged and
          // ignored rather than allowed to adopt another worker's instances.
          if (hello.hostName && hello.hostName !== authenticated.hostName) {
            log.warn(
              { claimed: hello.hostName, authenticated: authenticated.hostName },
              'Worker reported a host name that does not match its credential; using the credential',
            );
          }

          const worker = await recordWorkerHello(db, {
            workerId: authenticated.workerId,
            version: hello.workerVersion,
            maxCapabilityReported: hello.maxCapability,
            remoteAddress,
          });
          workerId = worker.id;
          hostName = worker.hostName;

          // The key credentials are encrypted to. A worker that has re-keyed
          // invalidates every stored ciphertext, so this is recorded before any
          // configuration is sent back down.
          if (hello.credentialPublicKey) {
            try {
              const { changed } = await recordCredentialKey(
                db,
                worker.id,
                hello.credentialPublicKey,
              );
              if (changed) {
                log.warn(
                  { hostName },
                  'Worker published a new credential key; stored SQL credentials must be entered again',
                );
                await writeAudit(db, {
                  actorType: 'worker',
                  actor: worker.hostName,
                  action: 'worker.credential_key.rotated',
                  target: worker.id,
                  remoteAddress,
                });
              }
            } catch (err) {
              log.warn({ err, hostName }, 'Ignoring an unreadable credential key from the worker');
            }
          }

          const ids = await upsertInstances(db, worker.id, hello.instances);
          for (const [name, id] of ids) instanceIds.set(name, id);

          // Compute the effective set the same way the worker will, so the
          // dashboard shows what is actually possible rather than what was
          // granted. A worker reporting an unknown ceiling is treated as
          // read-only — failing closed is the only safe reading.
          const ceiling = isMaxCapabilityTier(hello.maxCapability)
            ? hello.maxCapability
            : 'readOnly';
          if (!isMaxCapabilityTier(hello.maxCapability)) {
            log.warn(
              { hostName, reported: hello.maxCapability },
              'Worker reported an unrecognised maxCapability; treating as readOnly',
            );
          }
          const capabilities = effectiveCapabilities(worker.capabilities, ceiling);

          session = {
            workerId: worker.id,
            hostName: worker.hostName,
            instanceIds,
            send,
            disconnect: (reason: string) => {
              log.info({ hostName, reason }, 'Disconnecting worker session');
              call.end();
            },
            connectedAt: new Date(),
          };
          const superseded = registry.register(session);
          if (superseded) {
            log.warn(
              { hostName, workerId: worker.id },
              'This worker replaced an existing live session for the same identity. ' +
                'If it repeats every few seconds, two worker processes are sharing one ' +
                'credential and are disconnecting each other — stop one of them.',
            );
          }

          await writeAudit(db, {
            actorType: 'worker',
            actor: worker.hostName,
            action: 'worker.connected',
            target: worker.id,
            detail: {
              version: hello.workerVersion,
              maxCapability: hello.maxCapability,
              authMode: authenticated.mode,
              instances: hello.instances.map((i) => i.instanceName),
              effectiveCapabilities: capabilities,
            },
            remoteAddress,
          });

          send({
            msg: {
              $case: 'helloAck',
              helloAck: {
                workerId: worker.id,
                capabilities,
                serverVersion: SERVER_VERSION,
                commandSigningPublicKey: deps.commandSigningPublicKey,
                config: {
                  definitionPollSeconds: config.definitionPollSeconds,
                  historyPollSeconds: config.historyPollSeconds,
                  activityPollSeconds: config.activityPollSeconds,
                  agentLogPollSeconds: config.agentLogPollSeconds,
                  heartbeatSeconds: config.heartbeatSeconds,
                  historyBatchSize: config.historyBatchSize,
                },
              },
            },
          });

          log.info(
            { hostName, workerId: worker.id, instances: hello.instances.length, capabilities },
            'Worker connected',
          );

          // Tell it what to monitor before anything else. A freshly-enrolled
          // worker has no instances in its own config and is waiting for this.
          await pushInstanceConfigs(db, registry, worker.id);

          // Anything approved while this worker was offline goes out now,
          // provided it has not passed its TTL.
          deps.events.publish({ type: 'worker' });

          const dispatched = await deps.commands.dispatchPendingFor(worker.id);
          if (dispatched > 0) {
            log.info({ hostName, dispatched }, 'Dispatched commands queued while the worker was offline');
          }
          break;
        }

        case 'snapshot': {
          const snapshot = msg.snapshot;
          const instanceId = instanceIds.get(snapshot.instanceName);
          if (!instanceId) {
            log.warn(
              { hostName, instanceName: snapshot.instanceName },
              'Snapshot for an instance not declared in Hello; ignoring',
            );
            break;
          }
          await handleSnapshotChunk(deps, instanceId, snapshot, pendingSnapshots, log);
          break;
        }

        case 'definition': {
          const delta = msg.definition;
          const instanceId = instanceIds.get(delta.instanceName);
          if (!instanceId || !delta.job) break;

          if (delta.deleted) {
            // One job, by uuid. This used to call
            // `markJobsMissingFromSnapshot(db, instanceId, [])`, and an empty
            // list is *documented* as "this instance has no jobs any more" —
            // so a single deleted delta soft-deleted every job on the
            // instance, discarding the uuid it was told about. Reconciling a
            // whole instance is only ever correct from a complete snapshot.
            await markJobDeleted(db, instanceId, delta.job.jobUuid).catch(() => undefined);
            break;
          }

          verifyBlobHash(delta.job, log);

          // A delta the worker attributes to a command it just applied is a
          // remote change, not drift. Without this the operator's own edit
          // would come back moments later flagged as someone meddling in SSMS.
          const result = await recordJobVersion(db, {
            instanceId,
            jobUuid: delta.job.jobUuid,
            canonicalJson: delta.job.canonicalJson,
            definitionHash: delta.job.definitionHash,
            origin: delta.appliedCommandId ? 'remote' : 'local',
            commandId: delta.appliedCommandId || null,
          });

          if (result.changed) {
            deps.events.publish({
              type: 'definition',
              instanceId,
              jobUuid: delta.job.jobUuid,
            });
            log.info(
              {
                hostName,
                instanceName: delta.instanceName,
                jobUuid: delta.job.jobUuid,
                versionNo: result.versionNo,
                drift: result.isDrift,
              },
              result.isDrift ? 'Local drift detected' : 'Definition change recorded',
            );
          }
          break;
        }

        case 'history': {
          if (!workerId) break;
          const batch = msg.history;
          const instanceId = instanceIds.get(batch.instanceName);
          if (!instanceId) break;

          const scrubConfig = await getHistoryScrubConfig(db, workerId);
          const { rows, redactedCount } = applyHistoryScrubRules(scrubConfig, batch.rows);
          if (redactedCount > 0) {
            log.debug(
              { hostName, instanceName: batch.instanceName, redactedCount },
              'History row messages redacted before storage',
            );
          }

          const result = await ingestHistory(db, instanceId, rows);
          if (result.inserted > 0) {
            log.debug(
              { hostName, instanceName: batch.instanceName, inserted: result.inserted },
              'History ingested',
            );
          }
          // Only genuinely new outcome rows reach here, so a replayed outbox
          // batch cannot re-alert on a failure that was handled last week.
          // Notification faults must never fail ingestion.
          if (result.inserted > 0) deps.events.publish({ type: 'history', instanceId });

          await deps.notifications
            .onRunsIngested(instanceId, result.newRuns)
            .catch((err: unknown) => {
              log.error({ err, hostName }, 'Failed to raise notifications for ingested runs');
            });
          break;
        }

        case 'activity': {
          const update = msg.activity;
          const instanceId = instanceIds.get(update.instanceName);
          if (!instanceId) break;
          await upsertActivity(db, instanceId, update.rows);
          deps.events.publish({ type: 'activity', instanceId });
          break;
        }

        case 'agentLog': {
          if (!workerId) break;
          const batch = msg.agentLog;
          const instanceId = instanceIds.get(batch.instanceName);
          if (!instanceId) break;

          const scrubConfig = await getScrubConfig(db, workerId);
          const { kept, droppedCount, redactedCount } = applyScrubRules(scrubConfig, batch.rows);
          if (droppedCount > 0 || redactedCount > 0) {
            log.debug(
              { hostName, instanceName: batch.instanceName, droppedCount, redactedCount },
              'Agent log rows scrubbed before storage',
            );
          }

          await ingestAgentLog(db, instanceId, kept);
          break;
        }

        case 'heartbeat': {
          if (!workerId) break;
          await touchWorker(db, workerId);
          if (msg.heartbeat.instances.length > 0) {
            const ids = await upsertInstances(db, workerId, msg.heartbeat.instances);
            for (const [name, id] of ids) instanceIds.set(name, id);
          }
          break;
        }

        case 'instanceConfigStatus': {
          if (!workerId) break;
          const { results } = msg.instanceConfigStatus;
          await recordInstanceConfigStatus(db, workerId, results);

          const problems = results.filter((r) => r.status !== 'connected');
          if (problems.length > 0) {
            log.warn(
              { hostName, problems: problems.map((p) => `${p.instanceName}: ${p.status}`) },
              'Worker could not use some instance configurations',
            );
          }
          // Instances that connected are about to appear in a Hello or
          // heartbeat, so nothing needs to be pushed back down here.
          break;
        }

        case 'commandResult': {
          const result = msg.commandResult;
          if (!workerId) break;
          log.info(
            { hostName, commandId: result.commandId, success: result.success, code: result.errorCode },
            'Command result received',
          );

          const command = await deps.commands.recordResult({
            commandId: result.commandId,
            workerId,
            success: result.success,
            errorCode: result.errorCode,
            errorDetail: result.errorDetail,
            sqlErrorNumber: result.sqlErrorNumber,
            hostName,
          });

          if (command) {
            deps.events.publish({ type: 'command', instanceId: command.instanceId });
          }

          if (!result.success && command) {
            await deps.notifications
              .onCommandFailed({
                commandId: result.commandId,
                commandType: command.type,
                instanceId: command.instanceId,
                jobUuid: command.jobUuid,
                resultCode: result.errorCode,
                resultDetail: result.errorDetail,
                issuedBy: command.issuedByUsername ?? 'unknown',
              })
              .catch((err: unknown) => {
                log.error({ err }, 'Failed to raise a notification for a failed command');
              });
          }

          // The worker returns live state alongside the result. On success that
          // is the applied definition and belongs in the timeline attributed to
          // this command — recording it here rather than waiting for the next
          // poll is what stops an operator's own change coming back moments
          // later flagged as on-prem drift.
          //
          // On a Conflict it is the *current* on-prem definition, which is
          // exactly what the three-way view needs, so it is recorded as drift.
          if (result.resultingJob) {
            const [commandRow] = await db
              .select({ instanceId: commands.instanceId, issuedBy: commands.issuedBy })
              .from(commands)
              .where(and(eq(commands.id, result.commandId), eq(commands.workerId, workerId)));

            // No fallback to "some instance on this session". There used to be
            // one, and it meant an unknown command id still produced a version
            // row with origin:'remote' — which sets isDrift=false, so a worker
            // could launder a local SSMS edit as a control-plane change and the
            // drift the operator needs to see would never be reported.
            const targetInstance = commandRow?.instanceId;
            if (!targetInstance || ![...instanceIds.values()].includes(targetInstance)) {
              log.warn(
                { hostName, commandId: result.commandId },
                'Resulting job for a command this worker was not sent, or for an instance outside this session; ignoring',
              );
              break;
            }

            verifyBlobHash(result.resultingJob, log);
            await recordJobVersion(db, {
              instanceId: targetInstance,
              jobUuid: result.resultingJob.jobUuid,
              canonicalJson: result.resultingJob.canonicalJson,
              definitionHash: result.resultingJob.definitionHash,
              origin: result.success ? 'remote' : 'local',
              commandId: result.success ? result.commandId : null,
              createdBy: result.success ? commandRow.issuedBy : null,
            });
          }
          break;
        }
      }
    });
  });

  const teardown = (reason: string, err?: unknown): void => {
    enqueue(async () => {
      if (session && workerId) {
        registry.unregister(workerId, session);
        await markWorkerDisconnected(db, workerId);
        deps.events.publish({ type: 'worker' });
        await writeAudit(db, {
          actorType: 'worker',
          actor: hostName,
          action: 'worker.disconnected',
          target: workerId,
          detail: { reason },
          remoteAddress,
        });
      }
      if (err) log.warn({ err, hostName }, `Worker session ended: ${reason}`);
      else log.info({ hostName }, `Worker session ended: ${reason}`);
      session = null;
    });
  };

  call.on('end', () => {
    teardown('client closed stream');
    call.end();
  });

  call.on('error', (err: Error) => {
    teardown('stream error', err);
  });

  call.on('cancelled', () => {
    teardown('cancelled');
  });
}

async function handleSnapshotChunk(
  deps: HubDeps,
  instanceId: string,
  snapshot: Snapshot,
  pending: Map<string, PendingSnapshot>,
  log: Logger,
): Promise<void> {
  sweepAbandonedSnapshots(pending, log);

  const key = `${snapshot.instanceName}:${snapshot.snapshotId}`;
  const acc = pending.get(key) ?? {
    instanceName: snapshot.instanceName,
    jobs: [],
    startedAt: Date.now(),
  };
  acc.jobs.push(...snapshot.jobs);
  pending.set(key, acc);

  if (snapshot.moreChunks) return;

  pending.delete(key);

  for (const blob of acc.jobs) {
    verifyBlobHash(blob, log);
    // Origin 'local': a snapshot is by definition what is on the box right now.
    // recordJobVersion downgrades the very first observation to 'initial'.
    await recordJobVersion(deps.db, {
      instanceId,
      jobUuid: blob.jobUuid,
      canonicalJson: blob.canonicalJson,
      definitionHash: blob.definitionHash,
      origin: 'local',
    });
  }

  const removed = await markJobsMissingFromSnapshot(
    deps.db,
    instanceId,
    acc.jobs.map((j) => j.jobUuid),
  );

  log.info(
    { instanceName: snapshot.instanceName, jobs: acc.jobs.length, softDeleted: removed },
    'Snapshot applied',
  );
}

/**
 * Drop chunked snapshots that stopped arriving.
 *
 * `pendingSnapshots` is scoped to one session (see `handleSession`), so it
 * clears on reconnect regardless — but a session can stay open for days, and
 * every accumulated chunk holds full T-SQL step bodies, which routinely
 * contain connection strings (CLAUDE.md). A worker that starts a snapshot and
 * never finishes it — crashes mid-send, or an instance is detached while a
 * chunk is in flight — would otherwise leave that memory held for as long as
 * the connection lasts. Checked on every chunk rather than on a separate
 * timer: chunks are the only thing that grows this map, so there is nothing to
 * sweep between them.
 */
export function sweepAbandonedSnapshots(pending: Map<string, PendingSnapshot>, log: Logger): void {
  const cutoff = Date.now() - SNAPSHOT_ABANDON_MS;
  for (const [key, acc] of pending) {
    if (acc.startedAt > cutoff) continue;
    log.warn(
      { instanceName: acc.instanceName, jobs: acc.jobs.length, ageMs: Date.now() - acc.startedAt },
      'Discarding a chunked snapshot that stopped arriving before it completed',
    );
    pending.delete(key);
  }
}

/**
 * Never trust the hash the worker sent. Re-deriving it locally is what makes
 * the version timeline trustworthy — a worker (or anything that has taken one
 * over) must not be able to make two different definitions share a hash and so
 * hide a change from the drift detector.
 */
function verifyBlobHash(blob: JobDefinitionBlob, log: Logger): void {
  const actual = hashCanonical(blob.canonicalJson);
  if (actual !== blob.definitionHash) {
    log.warn(
      { jobUuid: blob.jobUuid, claimed: blob.definitionHash, actual },
      'Worker-reported definition hash did not match its payload; using the locally computed hash',
    );
    blob.definitionHash = actual;
  }
}

/**
 * The enrolment service.
 *
 * Deliberately a separate service from WorkerHub: it is the one RPC a worker
 * makes *before* it holds a durable credential, authenticated only by a
 * single-use enrolment token. Keeping it separate means the hub's
 * authenticator has no "except during enrolment" branch to get wrong.
 */
export function createEnrolmentServiceImpl(deps: HubDeps): grpc.UntypedServiceImplementation {
  return {
    enrol: (
      call: grpc.ServerUnaryCall<EnrolRequest, EnrolResponse>,
      callback: grpc.sendUnaryData<EnrolResponse>,
    ) => {
      void (async () => {
        const peer = call.getPeer();
        try {
          const result = await redeemEnrolmentToken(deps.db, deps.config, {
            token: call.request.enrolmentToken,
            hostName: call.request.hostName,
            workerVersion: call.request.workerVersion,
            csrPem: call.request.csrPem || undefined,
          });

          await writeAudit(deps.db, {
            actorType: 'system',
            actor: call.request.hostName,
            action: 'worker.enrolled',
            target: result.workerId,
            detail: { mode: result.mode },
            remoteAddress: peer,
          });

          deps.logger.info(
            { hostName: call.request.hostName, workerId: result.workerId, mode: result.mode },
            'Worker enrolled',
          );

          callback(null, {
            workerId: result.workerId,
            workerKey: result.workerKey ?? '',
            certificatePem: result.certificatePem ?? '',
            caCertificatePem: result.caCertificatePem ?? '',
            notAfter: result.notAfter ? toTimestamp(result.notAfter) : undefined,
          });
        } catch (err) {
          const code = err instanceof EnrolmentError ? err.code : 'Internal';
          const message = err instanceof Error ? err.message : 'Enrolment failed';
          deps.logger.warn({ err, peer, code }, 'Enrolment rejected');

          await writeAudit(deps.db, {
            actorType: 'system',
            actor: call.request.hostName || peer,
            action: 'worker.enrolment.failed',
            detail: { code, message },
            remoteAddress: peer,
          }).catch(() => undefined);

          callback({
            code:
              code === 'InvalidToken' || code === 'TokenExpired'
                ? grpc.status.UNAUTHENTICATED
                : grpc.status.PERMISSION_DENIED,
            details: message,
          } as grpc.ServiceError);
        }
      })();
    },
  };
}

export interface GrpcServerOptions {
  /** PEM server certificate chain and key. Without them the hub is plaintext. */
  tlsCert?: Buffer | undefined;
  tlsKey?: Buffer | undefined;
  /** CA to verify worker client certificates against, for mTLS mode. */
  clientCa?: Buffer | undefined;
}

export function createGrpcServer(deps: HubDeps): grpc.Server {
  const server = new grpc.Server({
    'grpc.max_receive_message_length': 32 * 1024 * 1024,
    'grpc.keepalive_time_ms': 30_000,
    'grpc.keepalive_timeout_ms': 10_000,
  });
  server.addService(WorkerHubService, createWorkerHubService(deps));
  server.addService(EnrolmentService, createEnrolmentServiceImpl(deps));
  return server;
}

/**
 * Build channel credentials for the hub.
 *
 * Client certificates are *requested* but not *required* at the TLS layer even
 * in mTLS mode, because enrolment legitimately arrives without one. Requiring a
 * certificate is the authenticator's job, per-service, where it can tell the
 * two cases apart.
 */
export function createServerCredentials(options: GrpcServerOptions): grpc.ServerCredentials {
  if (!options.tlsCert || !options.tlsKey) {
    return grpc.ServerCredentials.createInsecure();
  }
  return grpc.ServerCredentials.createSsl(
    options.clientCa ?? null,
    [{ private_key: options.tlsKey, cert_chain: options.tlsCert }],
    false,
  );
}
