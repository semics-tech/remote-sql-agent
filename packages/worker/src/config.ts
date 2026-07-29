import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { MAX_CAPABILITY_TIER_NAMES } from '@remote-sql-agent/protocol';

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
    /**
     * How this worker proves who it is (§6.2).
     *
     *   token — an API key obtained once at enrolment. Simplest to operate and
     *           the default; requires TLS, since the key is a bearer secret.
     *   mtls  — a client certificate issued by the control plane's CA.
     *   entra — an Azure managed identity token. No secret is stored at all.
     */
    auth: z
      .object({
        mode: z.enum(['token', 'mtls', 'entra']).default('token'),
        /** token mode: file holding the API key. Never the key itself, so the
         * config can be committed and the secret provisioned separately. */
        keyFile: z.string().optional(),
        /** entra mode: the control plane's application ID URI. */
        audience: z.string().optional(),
        /** entra mode: pin a specific user-assigned managed identity. */
        clientId: z.string().optional(),
      })
      .default({ mode: 'token' }),
    tls: z
      .object({
        enabled: z.boolean().default(true),
        caCertPath: z.string().optional(),
        clientCertPath: z.string().optional(),
        clientKeyPath: z.string().optional(),
      })
      .default({ enabled: true }),
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

  if (config.controlPlane.auth.mode === 'token' && !config.controlPlane.tls.enabled) {
    // The API key is a bearer secret: without TLS it is readable by anything on
    // the path, and possession is all an attacker needs.
    console.warn(
      '[rsagent] WARNING: token authentication is in use but TLS is disabled. ' +
        'The worker API key will be sent in clear text. Enable TLS unless this is a local test.',
    );
  }

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
