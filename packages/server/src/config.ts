import { z } from 'zod';
import { ROLES, type Role } from '@rsagent/protocol';

/**
 * Control-plane configuration. Everything is environment-driven so the Docker
 * Compose deployment needs no config file.
 */

/** Parse "rsagent.admin:Admin,rsagent.editor:Editor" into a lookup. */
function parseRoleMap(raw: string | undefined): Record<string, Role> {
  if (!raw) return {};
  const out: Record<string, Role> = {};
  for (const pair of raw.split(',')) {
    const [claim, role] = pair.split(':').map((s) => s.trim());
    if (!claim || !role) continue;
    if (!(ROLES as readonly string[]).includes(role)) {
      throw new Error(
        `Invalid role "${role}" in role map. Expected one of: ${ROLES.join(', ')}`,
      );
    }
    out[claim] = role as Role;
  }
  return out;
}

/** Default mapping from Entra app roles to dashboard roles. */
const DEFAULT_APP_ROLE_MAP: Record<string, Role> = {
  'rsagent.viewer': 'Viewer',
  'rsagent.operator': 'Operator',
  'rsagent.editor': 'Editor',
  'rsagent.admin': 'Admin',
};

const configSchema = z.object({
  databaseUrl: z.string().url(),
  httpHost: z.string(),
  httpPort: z.coerce.number().int().min(1).max(65535),
  grpcHost: z.string(),
  grpcPort: z.coerce.number().int().min(1).max(65535),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  /** Serve the built dashboard from the API process (single-container deploy). */
  dashboardDir: z.string().optional(),

  /** Public origin of the dashboard; used to build the OIDC redirect URI and to
   * decide whether cookies may be marked Secure. */
  publicUrl: z.string().url(),

  // --- Dashboard identity ---------------------------------------------------
  auth: z.object({
    /** 'local' | 'entra' | 'both'. 'both' keeps local sign-in available as a
     * break-glass path when the IdP is unreachable. */
    mode: z.enum(['local', 'entra', 'both']),
    sessionTtlHours: z.coerce.number().int().positive(),
    /** Secret for signing session cookies. Generated and persisted on first
     * boot if unset, so Compose works with no key ceremony. */
    cookieSecret: z.string().optional(),
    /** Username of the bootstrap admin created on first boot. */
    bootstrapAdminUsername: z.string(),
    /** Password for the bootstrap admin. If unset, one is generated and printed
     * once to the log — never a fixed default. */
    bootstrapAdminPassword: z.string().optional(),
    entra: z
      .object({
        tenantId: z.string(),
        clientId: z.string(),
        clientSecret: z.string().optional(),
        /** Map Entra app roles -> dashboard roles. */
        appRoleMap: z.record(z.enum(ROLES)),
        /** Role for an authenticated user with no recognised app role. Null
         * denies sign-in, which is the safe default: an unmapped user should
         * not silently become a Viewer with estate-wide read access. */
        defaultRole: z.enum(ROLES).nullable(),
      })
      .nullable(),
  }),

  // --- Worker authentication ------------------------------------------------
  workerAuth: z.object({
    /** Which credential modes the hub will accept. */
    enabledModes: z.array(z.enum(['token', 'mtls', 'entra'])).min(1),
    /** Validity of an API key issued in token mode; null means non-expiring. */
    tokenTtlDays: z.coerce.number().int().positive().nullable(),
    enrolmentTokenTtlMinutes: z.coerce.number().int().positive(),
    /** mTLS: issued client certificate lifetime. */
    certValidityDays: z.coerce.number().int().positive(),
    /** Entra workload identity: expected token audience and tenant. */
    entraTenantId: z.string().optional(),
    entraAudience: z.string().optional(),
    /** TLS for the gRPC hub. Strongly recommended in every mode — in token mode
     * it is the only thing stopping the API key going over the wire in clear. */
    tlsCertPath: z.string().optional(),
    tlsKeyPath: z.string().optional(),
    /** mTLS mode additionally needs the CA to verify client certs against; the
     * embedded CA is used when this is unset. */
    tlsClientCaPath: z.string().optional(),
    /** Refuse to start without hub TLS. Defaults true; set false only for local
     * development. */
    requireTls: z.coerce.boolean(),
  }),

  // --- Audit export ---------------------------------------------------------
  audit: z.object({
    /** The database is always written. This controls the *additional* export. */
    otlpEnabled: z.coerce.boolean(),
    /** OTLP/HTTP logs endpoint, e.g. http://otel-collector:4318/v1/logs */
    otlpEndpoint: z.string().optional(),
    /** "key=value,key2=value2" — for backends that authenticate with a header. */
    otlpHeaders: z.record(z.string()),
    serviceName: z.string(),
    exportIntervalMs: z.coerce.number().int().positive(),
    exportBatchSize: z.coerce.number().int().positive(),
    maxAttempts: z.coerce.number().int().positive(),
  }),

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
  /** Require a second approver for job.write commands (§6.4). */
  requireApprovalForJobWrite: z.coerce.boolean(),
});

export type ServerConfig = z.infer<typeof configSchema>;

function parseHeaders(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const authMode = env.RSAGENT_AUTH_MODE ?? 'local';
  const tenantId = env.RSAGENT_ENTRA_TENANT_ID;
  const clientId = env.RSAGENT_ENTRA_CLIENT_ID;

  if ((authMode === 'entra' || authMode === 'both') && (!tenantId || !clientId)) {
    throw new Error(
      'RSAGENT_AUTH_MODE requires Entra but RSAGENT_ENTRA_TENANT_ID / RSAGENT_ENTRA_CLIENT_ID are not set.',
    );
  }

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
    publicUrl: env.RSAGENT_PUBLIC_URL ?? 'http://localhost:8080',

    auth: {
      mode: authMode,
      sessionTtlHours: env.RSAGENT_SESSION_TTL_HOURS ?? 12,
      cookieSecret: env.RSAGENT_COOKIE_SECRET,
      bootstrapAdminUsername: env.RSAGENT_BOOTSTRAP_ADMIN ?? 'admin',
      bootstrapAdminPassword: env.RSAGENT_BOOTSTRAP_ADMIN_PASSWORD,
      entra:
        tenantId && clientId
          ? {
              tenantId,
              clientId,
              clientSecret: env.RSAGENT_ENTRA_CLIENT_SECRET,
              appRoleMap: {
                ...DEFAULT_APP_ROLE_MAP,
                ...parseRoleMap(env.RSAGENT_ENTRA_APP_ROLE_MAP),
              },
              defaultRole: env.RSAGENT_ENTRA_DEFAULT_ROLE
                ? (env.RSAGENT_ENTRA_DEFAULT_ROLE as Role)
                : null,
            }
          : null,
    },

    workerAuth: {
      enabledModes: list(env.RSAGENT_WORKER_AUTH_MODES, ['token']),
      tokenTtlDays: env.RSAGENT_WORKER_TOKEN_TTL_DAYS
        ? Number(env.RSAGENT_WORKER_TOKEN_TTL_DAYS)
        : null,
      enrolmentTokenTtlMinutes: env.RSAGENT_ENROLMENT_TOKEN_TTL_MINUTES ?? 60,
      certValidityDays: env.RSAGENT_WORKER_CERT_VALIDITY_DAYS ?? 90,
      entraTenantId: env.RSAGENT_WORKER_ENTRA_TENANT_ID ?? tenantId,
      entraAudience: env.RSAGENT_WORKER_ENTRA_AUDIENCE,
      tlsCertPath: env.RSAGENT_GRPC_TLS_CERT,
      tlsKeyPath: env.RSAGENT_GRPC_TLS_KEY,
      tlsClientCaPath: env.RSAGENT_GRPC_TLS_CLIENT_CA,
      requireTls: bool(env.RSAGENT_GRPC_REQUIRE_TLS, true),
    },

    audit: {
      otlpEnabled: bool(env.RSAGENT_AUDIT_OTLP_ENABLED, false),
      otlpEndpoint: env.RSAGENT_AUDIT_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      otlpHeaders: parseHeaders(
        env.RSAGENT_AUDIT_OTLP_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
      ),
      serviceName: env.OTEL_SERVICE_NAME ?? 'remote-sql-agent',
      exportIntervalMs: env.RSAGENT_AUDIT_EXPORT_INTERVAL_MS ?? 10_000,
      exportBatchSize: env.RSAGENT_AUDIT_EXPORT_BATCH_SIZE ?? 200,
      maxAttempts: env.RSAGENT_AUDIT_EXPORT_MAX_ATTEMPTS ?? 10,
    },

    definitionPollSeconds: env.RSAGENT_DEFINITION_POLL_SECONDS ?? 30,
    historyPollSeconds: env.RSAGENT_HISTORY_POLL_SECONDS ?? 10,
    activityPollSeconds: env.RSAGENT_ACTIVITY_POLL_SECONDS ?? 10,
    agentLogPollSeconds: env.RSAGENT_AGENT_LOG_POLL_SECONDS ?? 60,
    heartbeatSeconds: env.RSAGENT_HEARTBEAT_SECONDS ?? 30,
    historyBatchSize: env.RSAGENT_HISTORY_BATCH_SIZE ?? 500,
    commandTtlSeconds: env.RSAGENT_COMMAND_TTL_SECONDS ?? 900,
    historyRetentionDays: env.RSAGENT_HISTORY_RETENTION_DAYS ?? 90,
    requireApprovalForJobWrite: bool(env.RSAGENT_REQUIRE_APPROVAL_JOB_WRITE, true),
  });
}
