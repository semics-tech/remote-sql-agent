import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { MAX_CAPABILITY_TIER_NAMES } from '@rsagent/protocol';

/**
 * Worker configuration (worker.yaml).
 *
 * `maxCapability` is the security-critical setting: it is the ceiling a site
 * can pin locally, and the control plane can never raise it (§6.3). It
 * deliberately lives in a file on the SQL host rather than anywhere the control
 * plane can reach.
 */

const instanceConfigSchema = z.object({
  /** Instance name as it should appear in the control plane, e.g. "MSSQLSERVER" or "INST1". */
  name: z.string().min(1),
  server: z.string().min(1),
  port: z.number().int().positive().optional(),
  database: z.string().default('msdb'),
  /** SQL auth. Omit both to use integrated auth (Windows only). */
  user: z.string().optional(),
  password: z.string().optional(),
  domain: z.string().optional(),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(false),
  connectionTimeoutMs: z.number().int().positive().default(15_000),
  requestTimeoutMs: z.number().int().positive().default(30_000),
});

export type InstanceConfig = z.infer<typeof instanceConfigSchema>;

export const workerConfigSchema = z.object({
  hostName: z.string().min(1).default(hostname()),
  controlPlane: z.object({
    address: z.string().min(1),
    /** Plain TLS for M1 development; mTLS material lands in M3. */
    tls: z
      .object({
        enabled: z.boolean().default(false),
        caCertPath: z.string().optional(),
        clientCertPath: z.string().optional(),
        clientKeyPath: z.string().optional(),
      })
      .default({ enabled: false }),
    reconnect: z
      .object({
        initialDelayMs: z.number().int().positive().default(1_000),
        maxDelayMs: z.number().int().positive().default(60_000),
        jitterRatio: z.number().min(0).max(1).default(0.3),
      })
      .default({}),
  }),
  /**
   * The local ceiling. Never overridable from the control plane — this is the
   * defence that survives control-plane compromise.
   */
  maxCapability: z.enum(MAX_CAPABILITY_TIER_NAMES as [string, ...string[]]).default('readOnly'),
  instances: z.array(instanceConfigSchema).min(1),
  outbox: z
    .object({
      path: z.string().default('./run/outbox.sqlite'),
      /** Bounded; oldest-first eviction is logged and reported (§5.4). */
      maxRows: z.number().int().positive().default(100_000),
    })
    .default({}),
  polling: z
    .object({
      definitionSeconds: z.number().int().positive().default(30),
      historySeconds: z.number().int().positive().default(10),
      activitySeconds: z.number().int().positive().default(10),
      agentLogSeconds: z.number().int().positive().default(60),
      heartbeatSeconds: z.number().int().positive().default(30),
      historyBatchSize: z.number().int().positive().default(500),
    })
    .default({}),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Path to a file touched each loop so a service wrapper can spot a wedged event loop. */
  healthFilePath: z.string().default('./run/health'),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfig(path: string): WorkerConfig {
  const raw = parseYaml(readFileSync(path, 'utf8')) as unknown;
  const config = workerConfigSchema.parse(raw);

  // Passwords may be supplied via environment rather than the file, so the
  // config can be committed and the secret injected by the installer.
  for (const instance of config.instances) {
    if (!instance.password) {
      const envKey = `RSAGENT_SQL_PASSWORD_${instance.name.toUpperCase().replaceAll(/[^A-Z0-9]/gu, '_')}`;
      const fromEnv = process.env[envKey] ?? process.env.RSAGENT_SQL_PASSWORD;
      if (fromEnv) instance.password = fromEnv;
    }
  }

  return config;
}
