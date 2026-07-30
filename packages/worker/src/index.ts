import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pino } from 'pino';
import {
  toTimestamp,
  type WorkerMessage,
  type ConfigUpdate,
} from '@remote-sql-agent/protocol';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { Outbox } from './outbox.js';
import { type PollIntervals } from './instance-monitor.js';
import { MonitorSet } from './monitor-set.js';
import { loadOrCreateCredentialKey } from './credential-key.js';
import { ControlPlaneSession } from './session.js';
import { handleCommand } from './command-handler.js';

const WORKER_VERSION = '0.1.0';
const OUTBOX_DRAIN_BATCH = 50;

async function main(): Promise<void> {
  // Offsets are the same whether this runs as `node rsagent-worker.mjs ...` or
  // as the single executable: a SEA gets argv [realExePath, invokedPath, ...],
  // so argv[2] is the first real argument either way. Verified, because the
  // plausible-sounding assumption that a binary has no argv[1] is wrong and
  // would make `rsagent enrol` read the executable as its config file.
  const argv = process.argv.slice(2);

  // Prints what this build is and exits, touching no config, no disk and no
  // network. The release build runs it against every executable it produces:
  // a botched injection leaves a working copy of `node` behind, which looks
  // entirely healthy until someone tries to use it.
  if (argv[0] === '--rsagent-selftest' || argv[0] === '--version') {
    console.log(
      `rsagent-worker ${WORKER_VERSION} (node ${process.versions.node}, ${process.platform}-${process.arch})`,
    );
    process.exit(0);
  }

  // `rsagent enrol --token <t> [config]` is the one-time registration path.
  if (argv[0] === 'enrol') {
    const args = argv.slice(1);
    const tokenIndex = args.indexOf('--token');
    const token = tokenIndex >= 0 ? args[tokenIndex + 1] : undefined;
    const configPath =
      args.find((a) => !a.startsWith('--') && a !== token) ??
      process.env.RSAGENT_WORKER_CONFIG ??
      './worker.yaml';

    if (!token) {
      console.error('Usage: rsagent enrol --token <enrolment-token> [path/to/worker.yaml]');
      process.exit(2);
    }

    const { enrol } = await import('./enrol.js');
    await enrol({ configPath, token });
    process.exit(0);
  }

  const configPath = argv[0] ?? process.env.RSAGENT_WORKER_CONFIG ?? './worker.yaml';
  const config = loadWorkerConfig(configPath);
  const logger = pino({
    level: config.logLevel,
    // Step bodies can carry connection strings (§6.6); never log definitions.
    redact: { paths: ['*.canonicalJson', '*.command', '*.password'], censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  logger.info(
    { host: config.hostName, maxCapability: config.maxCapability, instances: config.instances.length },
    'Starting Remote SQL Agent worker',
  );

  if (config.maxCapability !== 'readOnly') {
    logger.warn(
      { maxCapability: config.maxCapability },
      'This worker is configured above readOnly. The ceiling should be the minimum the site needs.',
    );
  }

  // Generated on first run if enrolment did not already do it. The private half
  // never leaves this host; see credential-key.ts.
  const credentialKey = loadOrCreateCredentialKey(config.credentialKeyFile);
  logger.info(
    { fingerprint: credentialKey.fingerprint.slice(0, 16) },
    'Credential key ready; SQL credentials from the dashboard are encrypted to it',
  );

  const outbox = new Outbox(config.outbox.path, config.outbox.maxRows);

  // -------------------------------------------------------------------------
  // Emit: live stream if connected, outbox otherwise.
  // -------------------------------------------------------------------------
  let session: ControlPlaneSession | null = null;

  const emit = (message: WorkerMessage): boolean => {
    const kind = message.msg?.$case;
    const accepted = session?.send(message) ?? false;
    if (accepted) return true;

    // Snapshots are regenerated on reconnect, so queuing a stale one would just
    // waste space and replay outdated state. Everything else is durable.
    if (kind === 'history' || kind === 'activity' || kind === 'agentLog') {
      const instanceName =
        kind === 'history'
          ? message.msg!.history.instanceName
          : kind === 'activity'
            ? message.msg!.activity.instanceName
            : message.msg!.agentLog.instanceName;
      outbox.enqueue(kind, instanceName, message);
    }
    return false;
  };

  const monitors = new MonitorSet({ outbox, logger, emit, credentialKey });

  // Instances listed in worker.yaml come up first and are never removed by the
  // control plane. Anything else arrives over the session.
  await monitors.addLocal(config.instances);

  if (monitors.size === 0) {
    // Not a failure. A worker enrolled from the dashboard is *expected* to
    // start with nothing to watch — exiting here would put it in a restart loop
    // until someone configured it, which is exactly backwards.
    logger.info(
      'No instances configured yet. Connecting to the control plane and waiting to be told what to monitor.',
    );
  }

  // -------------------------------------------------------------------------
  // Control plane session.
  // -------------------------------------------------------------------------
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let commandQueue: Promise<void> = Promise.resolve();

  const drainOutbox = (): void => {
    if (!session?.connected) return;
    for (;;) {
      const batch = outbox.peek(OUTBOX_DRAIN_BATCH);
      if (batch.length === 0) return;

      const sent: number[] = [];
      for (const row of batch) {
        const message = JSON.parse(row.payload) as WorkerMessage;
        if (!session.send(message)) break;
        sent.push(row.id);
      }
      outbox.acknowledge(sent);

      // Stopped early: the stream is no longer accepting writes. Leave the rest
      // queued rather than spinning.
      if (sent.length < batch.length) return;
    }
  };

  session = new ControlPlaneSession(
    config,
    logger,
    {
      onReady: (capabilities, serverConfig) => {
        const intervals = resolveIntervals(config, serverConfig);
        monitors.setIntervals(intervals);

        // Order matters: drain the backlog first so history that accumulated
        // during the outage lands before the fresh snapshot's deltas.
        drainOutbox();

        void (async () => {
          for (const monitor of monitors.monitors()) {
            try {
              await monitor.refreshIdentity();
              await monitor.sendSnapshot();
              monitor.startPolling(intervals);
            } catch (err) {
              logger.error(
                { err, instance: monitor.instanceName },
                'Failed to start monitoring instance',
              );
            }
          }
        })();

        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          const stats = outbox.stats();
          session?.send({
            msg: {
              $case: 'heartbeat',
              heartbeat: {
                sentAt: toTimestamp(new Date()),
                instances: monitors.instanceInfos(),
                outboxDepth: stats.depth,
                clockSkewMs: 0,
              },
            },
          });
          if (stats.evicted > 0) {
            logger.warn(
              { evicted: stats.evicted },
              'Outbox has evicted rows to stay within its bound; some history was dropped',
            );
          }
          drainOutbox();
          touchHealthFile(config.healthFilePath);
        }, intervals.heartbeatSeconds * 1000);
        heartbeatTimer.unref();

        logger.info({ capabilities }, 'Worker ready');
      },

      onMessage: (message) => {
        const msg = message.msg;
        if (!msg) return;

        if (msg.$case === 'instanceConfigs') {
          // Serialised behind the same queue as commands: reconciling while a
          // command is being applied could close the pool out from under it.
          commandQueue = commandQueue
            .then(async () => {
              const results = await monitors.reconcileRemote(msg.instanceConfigs.configs);
              session?.send({
                msg: { $case: 'instanceConfigStatus', instanceConfigStatus: { results } },
              });

              const failed = results.filter((r) => r.status !== 'connected');
              if (failed.length > 0) {
                logger.warn(
                  { failed: failed.map((f) => `${f.instanceName}=${f.status}`) },
                  'Some instance configurations could not be used',
                );
              }
            })
            .catch((err: unknown) => {
              logger.error({ err }, 'Failed to apply instance configuration');
            });
          return;
        }

        if (msg.$case !== 'command') return;
        const command = msg.command;

        // Serialised: two commands against one job applied concurrently would
        // race on msdb state, and the second's conflict check would read a
        // half-applied definition.
        commandQueue = commandQueue
          .then(async () => {
            const monitor = monitors.get(command.instanceName);
            if (!monitor) {
              logger.warn(
                { commandId: command.id, instanceName: command.instanceName },
                'Command for an instance this worker does not manage',
              );
              session?.send({
                msg: {
                  $case: 'commandResult',
                  commandResult: {
                    commandId: command.id,
                    success: false,
                    errorCode: 'UnknownInstance',
                    errorDetail: `This worker does not manage instance "${command.instanceName}".`,
                    sqlErrorNumber: 0,
                    appliedAt: toTimestamp(new Date()),
                  },
                },
              });
              return;
            }

            const pool = monitor.connectionPool;
            if (!pool) {
              session?.send({
                msg: {
                  $case: 'commandResult',
                  commandResult: {
                    commandId: command.id,
                    success: false,
                    errorCode: 'InstanceUnavailable',
                    errorDetail: 'The worker is not currently connected to that SQL Server instance.',
                    sqlErrorNumber: 0,
                    appliedAt: toTimestamp(new Date()),
                  },
                },
              });
              return;
            }

            // Held against definition polling: a poll landing between the msdb
            // write and the result being sent would report the change as drift.
            const result = await monitor.runExclusive(async () => {
              const outcome = await handleCommand(command, {
                pool,
                instanceName: command.instanceName,
                capabilities: session?.capabilities ?? ['observe'],
                outbox,
                logger,
                commandSigningPublicKey: session?.commandSigningPublicKey ?? '',
              });

              if (outcome.success && outcome.resultingJob) {
                monitor.noteAppliedCommand(outcome.resultingJob.jobUuid, command.id);
              }
              return outcome;
            });

            session?.send({ msg: { $case: 'commandResult', commandResult: result } });

            const kind = command.payload?.$case;

            // Starting or stopping a job changes *activity*, not the
            // definition. One immediate read is not enough: sp_start_job
            // returns before Agent has written the activity row, so this asks
            // the monitor to poll hard for a short window instead.
            if (result.success && (kind === 'runJob' || kind === 'stopJob')) {
              monitor.nudgeActivity();
            }

            // Re-poll definitions so an edit is mirrored now rather than at the
            // next scheduled tick — an operator watching the screen should see
            // their own change land.
            if (kind !== 'runJob' && kind !== 'stopJob') {
              await monitor.pollDefinitions().catch(() => undefined);
            }
          })
          .catch((err: unknown) => {
            logger.error({ err, commandId: command.id }, 'Failed to process command');
          });
      },

      onDisconnect: (reason) => {
        logger.warn({ reason }, 'Control plane session lost; pollers continue into the outbox');
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      },
    },
    () => ({
      msg: {
        $case: 'hello',
        hello: {
          workerVersion: WORKER_VERSION,
          hostName: config.hostName,
          maxCapability: config.maxCapability,
          instances: monitors.instanceInfos(),
          credentialPublicKey: credentialKey.publicKeyPem,
        },
      },
    }),
  );

  session.start();

  // -------------------------------------------------------------------------
  // Lifecycle (§5.4): log and exit cleanly so the service wrapper restarts us.
  // -------------------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down worker');
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    session?.stop();
    await monitors.closeAll();
    outbox.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception; exiting for the service wrapper to restart');
    process.exit(1);
  });
}

function resolveIntervals(config: WorkerConfig, serverConfig: ConfigUpdate | undefined): PollIntervals & {
  heartbeatSeconds: number;
} {
  // The control plane may tune poll intervals centrally, but a zero or missing
  // value must fall back to local config rather than producing a hot loop.
  const pick = (remote: number | undefined, local: number): number =>
    remote && remote > 0 ? remote : local;

  return {
    definitionSeconds: pick(serverConfig?.definitionPollSeconds, config.polling.definitionSeconds),
    historySeconds: pick(serverConfig?.historyPollSeconds, config.polling.historySeconds),
    activitySeconds: pick(serverConfig?.activityPollSeconds, config.polling.activitySeconds),
    agentLogSeconds: pick(serverConfig?.agentLogPollSeconds, config.polling.agentLogSeconds),
    historyBatchSize: pick(serverConfig?.historyBatchSize, config.polling.historyBatchSize),
    heartbeatSeconds: pick(serverConfig?.heartbeatSeconds, config.polling.heartbeatSeconds),
  };
}

/** Touched each heartbeat so WinSW/systemd can detect a wedged event loop (§5.4). */
function touchHealthFile(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Date().toISOString(), 'utf8');
  } catch {
    // A failure to write the health file must never take the worker down.
  }
}

main().catch((err: unknown) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
