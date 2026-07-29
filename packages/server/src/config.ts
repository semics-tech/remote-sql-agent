import { z } from 'zod';

/**
 * Control-plane configuration. Everything is environment-driven so the Docker
 * Compose deployment needs no config file.
 */
const configSchema = z.object({
  databaseUrl: z.string().url(),
  httpHost: z.string(),
  httpPort: z.coerce.number().int().min(1).max(65535),
  grpcHost: z.string(),
  grpcPort: z.coerce.number().int().min(1).max(65535),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  /** Serve the built dashboard from the API process (single-container deploy). */
  dashboardDir: z.string().optional(),
  /** Default worker poll intervals, pushed down in HelloAck. */
  definitionPollSeconds: z.coerce.number().int().positive(),
  historyPollSeconds: z.coerce.number().int().positive(),
  activityPollSeconds: z.coerce.number().int().positive(),
  agentLogPollSeconds: z.coerce.number().int().positive(),
  heartbeatSeconds: z.coerce.number().int().positive(),
  historyBatchSize: z.coerce.number().int().positive(),
  /** How long a dispatched command may wait before auto-expiring (§5.4). */
  commandTtlSeconds: z.coerce.number().int().positive(),
  historyRetentionDays: z.coerce.number().int().positive(),
});

export type ServerConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return configSchema.parse({
    databaseUrl:
      env.RSAGENT_DATABASE_URL ??
      'postgres://rsagent:rsagent_dev_password@localhost:5433/rsagent',
    httpHost: env.RSAGENT_HTTP_HOST ?? '0.0.0.0',
    httpPort: env.RSAGENT_HTTP_PORT ?? 8080,
    grpcHost: env.RSAGENT_GRPC_HOST ?? '0.0.0.0',
    grpcPort: env.RSAGENT_GRPC_PORT ?? 8443,
    logLevel: env.RSAGENT_LOG_LEVEL ?? 'info',
    dashboardDir: env.RSAGENT_DASHBOARD_DIR,
    definitionPollSeconds: env.RSAGENT_DEFINITION_POLL_SECONDS ?? 30,
    historyPollSeconds: env.RSAGENT_HISTORY_POLL_SECONDS ?? 10,
    activityPollSeconds: env.RSAGENT_ACTIVITY_POLL_SECONDS ?? 10,
    agentLogPollSeconds: env.RSAGENT_AGENT_LOG_POLL_SECONDS ?? 60,
    heartbeatSeconds: env.RSAGENT_HEARTBEAT_SECONDS ?? 30,
    historyBatchSize: env.RSAGENT_HISTORY_BATCH_SIZE ?? 500,
    commandTtlSeconds: env.RSAGENT_COMMAND_TTL_SECONDS ?? 900,
    historyRetentionDays: env.RSAGENT_HISTORY_RETENTION_DAYS ?? 90,
  });
}
