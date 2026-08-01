import { z } from 'zod';
import { ROLES, type Role } from '@remote-sql-agent/protocol';

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
  /**
   * Worker installer scripts and packages, served at /install.sh, /install.ps1
   * and /downloads/. Serving these from the control plane rather than the
   * internet is what makes the one-line install work on a segmented network: a
   * SQL host can always reach the control plane, and usually cannot reach
   * GitHub. Unset disables the endpoints and the wizard says so.
   */
  workerPackageDir: z.string().optional(),

  /** Public origin of the dashboard; used to build the OIDC redirect URI and to
   * decide whether cookies may be marked Secure. */
  publicUrl: z.string().url(),

  /**
   * `host:port` workers should dial for the hub, when it is not simply the
   * public URL's host and `grpcPort`.
   *
   * This is the address printed in the install one-liners, so it ends up in
   * `worker.yaml` on every SQL host — getting it wrong is not a broken page,
   * it is fifty machines configured to connect somewhere that does not answer.
   * The derived default is right whenever the hub is published on its own port
   * of the same name. It is wrong wherever the outside port differs from the
   * one the process binds (a container platform mapping ports), or the hub has
   * a name of its own (a load balancer separate from the HTTP ingress).
   *
   * Must include the port. Accepting a bare host and appending `grpcPort` would
   * silently reintroduce the mismatch this exists to fix.
   */
  hubAdvertisedAddress: z.string().optional(),

  /**
   * How many reverse proxies sit in front of the HTTP server.
   *
   * This decides where `request.ip` comes from, and `request.ip` is what
   * @fastify/rate-limit counts against and what lands in `remoteAddress` on
   * every audit row and every session. Anything the client can choose is
   * therefore both a rate-limit bypass and a forged audit trail.
   *
   * 0 (the default) ignores X-Forwarded-For entirely and uses the socket
   * address, which is correct when the control plane is exposed directly and is
   * the only setting a client cannot influence. Set it to the number of proxies
   * you actually run — 1 for the Caddy profile, for Container Apps, or for a
   * Kubernetes ingress — and the address is taken that many hops back from the
   * socket, i.e. from the proxy nearest us rather than from the request.
   *
   * Overshooting is the dangerous direction: each hop beyond the real count is
   * one entry of attacker-controlled header that gets believed.
   */
  trustedProxyHops: z.coerce.number().int().min(0).max(8),

  /**
   * Bearer token required on `/metrics`. Unset leaves it open, which is the
   * right default for a scrape target with no other network exposure (the
   * original intent of the route) — but an operator putting the control
   * plane on a network Prometheus does not fully control now has a lever.
   * Estate job counts and failure rates are not secret in the way step
   * bodies are, so this is defence in depth rather than the primary control.
   */
  metricsToken: z.string().optional(),

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
        /** Map Entra app roles -> dashboard roles. The key is the app role
         * name as Entra emits it, so it is an open string; only the value is
         * constrained. Both halves are stated because zod 4 reads a lone
         * argument as the *key* schema, which would silently invert this. */
        appRoleMap: z.record(z.string(), z.enum(ROLES)),
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
    otlpHeaders: z.record(z.string(), z.string()),
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
  /**
   * Require a second approver for job.write commands (§6.4).
   *
   * Off by default. A four-eyes rule is the right control for a change-managed
   * estate, and the wrong one for a lone DBA looking after their own servers —
   * for them it is an approval that can never be granted. Sites that need it
   * turn it on, and the mechanism is unchanged when they do.
   */
  requireApprovalForJobWrite: z.coerce.boolean(),
  /**
   * Roles exempt from that rule when it is on. Admins are exempt by default:
   * an Admin can grant themselves any role and revoke anyone else's, so
   * requiring their changes to be countersigned is procedure rather than
   * control. Set to an empty list to make the rule apply to everyone.
   */
  approvalExemptRoles: z.array(z.enum(ROLES)),
  /**
   * Refuse workers older than this (semver). Lets an operator retire a version
   * with a known defect across the estate without visiting every host — the
   * refused worker logs exactly why and keeps retrying, so upgrading it fixes
   * things with no further intervention.
   */
  minimumWorkerVersion: z.string().nullable(),
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

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on', 'y']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', 'n']);

/**
 * A boolean environment variable, refusing anything it does not recognise.
 *
 * The refusal is the point. This used to compare against `'true' | '1' | 'yes'`
 * exactly, so any other spelling silently became **false** — and two of the
 * three call sites are security controls whose safe value is true.
 * `RSAGENT_GRPC_REQUIRE_TLS=True` started the hub in plaintext with worker API
 * keys on the wire; `RSAGENT_REQUIRE_APPROVAL_JOB_WRITE=True` turned off
 * four-eyes. Both look correct in a compose file and neither logs anything.
 *
 * Refusing at boot is the only way an operator finds out. A typo that disables
 * a control has to be loud, and there is no reading of `RSAGENT_GRPC_REQUIRE_TLS=maybe`
 * that should leave the server running.
 */
function bool(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  const normalised = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalised)) return true;
  if (FALSE_VALUES.has(normalised)) return false;
  throw new Error(
    `${name} must be a boolean (true/false, 1/0, yes/no, on/off) but was "${value}". ` +
      'Refusing to start rather than guess: this setting is silently security-relevant.',
  );
}

function list(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validate RSAGENT_HUB_ADVERTISED_ADDRESS as `host:port`.
 *
 * Rejected loudly at boot rather than corrected quietly. This value is copied
 * into `worker.yaml` on every SQL host in the estate, and a worker pointed at
 * the wrong port does not fail visibly — it retries on backoff forever while
 * the dashboard simply shows it as never having connected. A typo has to stop
 * the process here, where one person is looking at one log.
 *
 * Bracketed IPv6 is accepted because that is the literal form gRPC wants, and
 * it is what `new URL(...).hostname` hands back for an IPv6 public URL.
 */
function hubAdvertisedAddress(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  const match = /^(\[[0-9a-f:]+\]|[^:]+):(\d+)$/iu.exec(trimmed);
  const port = match ? Number(match[2]) : NaN;
  if (!match || port < 1 || port > 65535) {
    throw new Error(
      `RSAGENT_HUB_ADVERTISED_ADDRESS must be host:port, e.g. rsagent.example.com:8443 — got "${value}". ` +
        'The port is required: it is what workers dial, and it is not always the port the hub binds.',
    );
  }
  return trimmed;
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
    workerPackageDir: env.RSAGENT_WORKER_PACKAGE_DIR,
    publicUrl: env.RSAGENT_PUBLIC_URL ?? 'http://localhost:8080',
    hubAdvertisedAddress: hubAdvertisedAddress(env.RSAGENT_HUB_ADVERTISED_ADDRESS),
    trustedProxyHops: env.RSAGENT_TRUSTED_PROXY_HOPS ?? 0,
    metricsToken: env.RSAGENT_METRICS_TOKEN,

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
      requireTls: bool(env.RSAGENT_GRPC_REQUIRE_TLS, true, 'RSAGENT_GRPC_REQUIRE_TLS'),
    },

    audit: {
      otlpEnabled: bool(env.RSAGENT_AUDIT_OTLP_ENABLED, false, 'RSAGENT_AUDIT_OTLP_ENABLED'),
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
    requireApprovalForJobWrite: bool(env.RSAGENT_REQUIRE_APPROVAL_JOB_WRITE, false, 'RSAGENT_REQUIRE_APPROVAL_JOB_WRITE'),
    approvalExemptRoles: list(env.RSAGENT_APPROVAL_EXEMPT_ROLES, ['Admin']).filter((r) =>
      (ROLES as readonly string[]).includes(r),
    ),
    minimumWorkerVersion: env.RSAGENT_MINIMUM_WORKER_VERSION ?? null,
  });
}
