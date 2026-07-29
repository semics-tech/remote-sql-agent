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
import { eq } from 'drizzle-orm';
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
import { markJobsMissingFromSnapshot, recordJobVersion } from '../domain/versioning.js';
import { writeAudit } from '../domain/audit.js';
import {
  WorkerAuthError,
  type AuthenticatedWorker,
  type WorkerAuthenticator,
} from '../worker-auth/authenticate.js';

const SERVER_VERSION = '0.1.0';

interface PendingSnapshot {
  instanceName: string;
  jobs: JobDefinitionBlob[];
}

export interface HubDeps {
  db: Database;
  config: ServerConfig;
  logger: Logger;
  registry: WorkerRegistry;
  authenticator: WorkerAuthenticator;
  commands: CommandService;
  commandSigningPublicKey: string;
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
  let identity: AuthenticatedWorker | null = null;
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
    identity = await deps.authenticator.authenticate(call);
    hostName = identity.hostName;
    workerId = identity.workerId;
    log.info(
      { hostName, workerId, mode: identity.mode },
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

  const authenticated = identity;

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
          registry.register(session);

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

          // Anything approved while this worker was offline goes out now,
          // provided it has not passed its TTL.
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
            await markJobsMissingFromSnapshot(db, instanceId, []).catch(() => undefined);
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
          const batch = msg.history;
          const instanceId = instanceIds.get(batch.instanceName);
          if (!instanceId) break;
          const result = await ingestHistory(db, instanceId, batch.rows);
          if (result.inserted > 0) {
            log.debug(
              { hostName, instanceName: batch.instanceName, inserted: result.inserted },
              'History ingested',
            );
          }
          break;
        }

        case 'activity': {
          const update = msg.activity;
          const instanceId = instanceIds.get(update.instanceName);
          if (!instanceId) break;
          await upsertActivity(db, instanceId, update.rows);
          break;
        }

        case 'agentLog': {
          const batch = msg.agentLog;
          const instanceId = instanceIds.get(batch.instanceName);
          if (!instanceId) break;
          await ingestAgentLog(db, instanceId, batch.rows);
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

        case 'commandResult': {
          const result = msg.commandResult;
          log.info(
            { hostName, commandId: result.commandId, success: result.success, code: result.errorCode },
            'Command result received',
          );

          await deps.commands.recordResult({
            commandId: result.commandId,
            success: result.success,
            errorCode: result.errorCode,
            errorDetail: result.errorDetail,
            sqlErrorNumber: result.sqlErrorNumber,
            hostName,
          });

          // The worker returns live state alongside the result. On success that
          // is the applied definition and belongs in the timeline attributed to
          // this command — recording it here rather than waiting for the next
          // poll is what stops an operator's own change coming back moments
          // later flagged as on-prem drift.
          //
          // On a Conflict it is the *current* on-prem definition, which is
          // exactly what the three-way view needs, so it is recorded as drift.
          if (result.resultingJob) {
            const instanceId = [...instanceIds.values()][0];
            const [commandRow] = await db
              .select({ instanceId: commands.instanceId, issuedBy: commands.issuedBy })
              .from(commands)
              .where(eq(commands.id, result.commandId));

            const targetInstance = commandRow?.instanceId ?? instanceId;
            if (targetInstance) {
              verifyBlobHash(result.resultingJob, log);
              await recordJobVersion(db, {
                instanceId: targetInstance,
                jobUuid: result.resultingJob.jobUuid,
                canonicalJson: result.resultingJob.canonicalJson,
                definitionHash: result.resultingJob.definitionHash,
                origin: result.success ? 'remote' : 'local',
                commandId: result.success ? result.commandId : null,
                createdBy: result.success ? commandRow?.issuedBy ?? null : null,
              });
            }
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
  const key = `${snapshot.instanceName}:${snapshot.snapshotId}`;
  const acc = pending.get(key) ?? { instanceName: snapshot.instanceName, jobs: [] };
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
