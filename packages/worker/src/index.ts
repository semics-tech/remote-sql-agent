import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pino } from 'pino';
import {
  toTimestamp,
  type InstanceInfo,
  type WorkerMessage,
  type ConfigUpdate,
} from '@rsagent/protocol';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { Outbox } from './outbox.js';
import { InstanceMonitor, type PollIntervals } from './instance-monitor.js';
import { ControlPlaneSession } from './session.js';

const WORKER_VERSION = '0.1.0';
const OUTBOX_DRAIN_BATCH = 50;

async function main(): Promise<void> {
  // `rsagent enrol --token <t> [config]` is the one-time registration path.
  if (process.argv[2] === 'enrol') {
    const args = process.argv.slice(3);
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

  const configPath = process.argv[2] ?? process.env.RSAGENT_WORKER_CONFIG ?? './worker.yaml';
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
      'This worker is configured above readOnly. Write commands are not implemented in this build, ' +
        'but the ceiling should still be set to the minimum the site actually needs.',
    );
  }

  const outbox = new Outbox(config.outbox.path, config.outbox.maxRows);
  const monitors = new Map<string, InstanceMonitor>();

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

  // -------------------------------------------------------------------------
  // Connect to each configured instance.
  // -------------------------------------------------------------------------
  for (const instanceConfig of config.instances) {
    const monitor = new InstanceMonitor({
      config: instanceConfig,
      outbox,
      logger,
      emit,
    });
    try {
      await monitor.connect();
      monitors.set(instanceConfig.name, monitor);
    } catch (err) {
      // One unreachable instance must not stop the worker serving the others on
      // the same host.
      logger.error(
        { err, instance: instanceConfig.name },
        'Failed to connect to instance; it will be retried on the next reconnect',
      );
    }
  }

  if (monitors.size === 0) {
    logger.fatal('No SQL Server instances could be reached; exiting for the supervisor to restart');
    process.exit(1);
  }

  const buildInstanceInfos = (): InstanceInfo[] =>
    [...monitors.values()].map((m) => ({
      instanceName: m.instanceName,
      sqlVersion: m.identity?.sqlVersion ?? '',
      sqlEdition: m.identity?.sqlEdition ?? '',
      agentStatus: m.identity?.agentStatus ?? 'unknown',
      serverName: m.identity?.serverName ?? '',
    }));

  // -------------------------------------------------------------------------
  // Control plane session.
  // -------------------------------------------------------------------------
  let heartbeatTimer: NodeJS.Timeout | null = null;

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

        // Order matters: drain the backlog first so history that accumulated
        // during the outage lands before the fresh snapshot's deltas.
        drainOutbox();

        void (async () => {
          for (const monitor of monitors.values()) {
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
                instances: buildInstanceInfos(),
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

      onCommand: () => {
        // The write path lands in M4. Until then the command vocabulary exists
        // on the wire but the worker applies nothing — a build that cannot
        // write cannot be talked into writing.
        logger.warn('Received a command from the control plane; this build is observe-only');
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
          instances: buildInstanceInfos(),
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
    await Promise.all([...monitors.values()].map((m) => m.close()));
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
