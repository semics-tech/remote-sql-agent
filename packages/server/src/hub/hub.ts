import * as grpc from '@grpc/grpc-js';
import type { Logger } from 'pino';
import {
  WorkerHubService,
  type ServerMessage,
  type WorkerMessage,
  type Snapshot,
  type JobDefinitionBlob,
  effectiveCapabilities,
  isMaxCapabilityTier,
  hashCanonical,
} from '@rsagent/protocol';
import type { Database } from '../db/client.js';
import type { ServerConfig } from '../config.js';
import { type WorkerRegistry, type LiveWorker } from './registry.js';
import {
  ingestAgentLog,
  ingestHistory,
  markWorkerDisconnected,
  touchWorker,
  upsertActivity,
  upsertInstances,
  upsertWorker,
} from '../domain/ingest.js';
import { markJobsMissingFromSnapshot, recordJobVersion } from '../domain/versioning.js';
import { writeAudit } from '../domain/audit.js';

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
  // Snapshots arrive chunked; only commit once more_chunks is false, so a
  // half-received snapshot can never soft-delete jobs it simply hasn't seen yet.
  const pendingSnapshots = new Map<string, PendingSnapshot>();

  const log = logger.child({ component: 'hub', peer: remoteAddress });

  const send = (message: ServerMessage): void => {
    if (!call.writable) return;
    call.write(message);
  };

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
          hostName = hello.hostName;

          const worker = await upsertWorker(db, {
            hostName: hello.hostName,
            version: hello.workerVersion,
            maxCapabilityReported: hello.maxCapability,
            remoteAddress,
          });
          workerId = worker.id;

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
            hostName: hello.hostName,
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
            actor: hello.hostName,
            action: 'worker.connected',
            target: worker.id,
            detail: {
              version: hello.workerVersion,
              maxCapability: hello.maxCapability,
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
          // Write path lands in M4; results are recorded for audit in the
          // meantime so nothing is silently dropped if a command is ever sent.
          const result = msg.commandResult;
          log.info(
            { hostName, commandId: result.commandId, success: result.success },
            'Command result received',
          );
          await writeAudit(db, {
            actorType: 'worker',
            actor: hostName,
            action: 'command.result',
            target: result.commandId,
            detail: {
              success: result.success,
              errorCode: result.errorCode,
              errorDetail: result.errorDetail,
            },
            remoteAddress,
          });
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

export function createGrpcServer(deps: HubDeps): grpc.Server {
  const server = new grpc.Server({
    'grpc.max_receive_message_length': 32 * 1024 * 1024,
    'grpc.keepalive_time_ms': 30_000,
    'grpc.keepalive_timeout_ms': 10_000,
  });
  server.addService(WorkerHubService, createWorkerHubService(deps));
  return server;
}
