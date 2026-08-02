import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Role } from '@remote-sql-agent/protocol';

/**
 * Control plane schema (§8).
 *
 * The control plane is the source of record for *history*, not for *truth*:
 * on-prem msdb is always the runtime truth, and everything here is a mirror
 * plus an append-only version history. Nothing in this schema is authoritative
 * over a live Agent.
 */

// ---------------------------------------------------------------------------
// Workers and instances
// ---------------------------------------------------------------------------

export const workers = pgTable(
  'workers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    hostName: text('host_name').notNull(),
    /** Serial of the currently-issued client certificate. */
    certSerial: text('cert_serial'),
    certExpiresAt: timestamp('cert_expires_at', { withTimezone: true }),
    certRevokedAt: timestamp('cert_revoked_at', { withTimezone: true }),
    version: text('version'),
    /** Server-side capability grant; the effective set is this ∩ the worker's ceiling. */
    capabilities: jsonb('capabilities').$type<string[]>().notNull().default([]),
    /** The ceiling the worker reported from its own worker.yaml (§6.3). */
    maxCapabilityReported: text('max_capability_reported'),
    /**
     * SPKI public key the worker generated at enrolment, in PEM. SQL
     * credentials configured from the dashboard are encrypted to this in the
     * operator's browser, so the private half never leaves the SQL host and the
     * control plane stores ciphertext it cannot open.
     */
    credentialPublicKeyPem: text('credential_public_key_pem'),
    credentialKeyFingerprint: text('credential_key_fingerprint'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    lastRemoteAddress: text('last_remote_address'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('workers_host_name_key').on(t.hostName)],
);

export const instances = pgTable(
  'instances',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    /** e.g. "MSSQLSERVER" or "INST1" — unique within a host. */
    instanceName: text('instance_name').notNull(),
    /** @@SERVERNAME as the instance reports it. */
    serverName: text('server_name'),
    sqlVersion: text('sql_version'),
    sqlEdition: text('sql_edition'),
    agentStatus: text('agent_status').notNull().default('unknown'),
    /**
     * What the worker reported it can actually edit here: its effective SQL
     * login, whether it is sysadmin, whether the write wrapper is installed,
     * and which jobs that wrapper currently permits.
     *
     * Reported by the worker rather than configured, because SQL Server decides
     * it — sp_update_job refuses a job owned by another login unless the caller
     * is sysadmin. Stored so the dashboard can grey out a save that would fail
     * instead of accepting an edit and reporting a raw SQL error afterwards.
     *
     * jsonb rather than columns: it is a snapshot of remote state read straight
     * back out, never filtered or joined on, and the allowlist is a list.
     */
    jobWriteMode: jsonb('job_write_mode'),
    // No environment tag here on purpose. It lives on the config row that sets
    // it — see db/environment-tag.ts. A column here had no writer and read as
    // NULL for every instance, which silently disabled the whole grant system.
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    /**
     * Set when an administrator stops monitoring this instance.
     *
     * Not a delete: the run history and version timeline are the reason this
     * product exists, and destroying them because someone removed a
     * configuration would be a surprising amount of data loss for a one-click
     * action. The instance stops appearing as live and stops counting towards
     * estate totals; its history stays queryable.
     */
    detachedAt: timestamp('detached_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('instances_worker_name_key').on(t.workerId, t.instanceName)],
);

/**
 * Incremental sync bookmarks. Kept in their own table rather than on
 * `instances` so that a snapshot reset does not race with heartbeat updates to
 * the instance row.
 */
export const syncState = pgTable('sync_state', {
  instanceId: uuid('instance_id')
    .primaryKey()
    .references(() => instances.id, { onDelete: 'cascade' }),
  /** Highest msdb sysjobhistory.instance_id ingested. */
  historyHighWaterMark: bigint('history_high_water_mark', { mode: 'number' })
    .notNull()
    .default(0),
  /** Latest Agent error-log timestamp ingested. */
  agentLogHighWaterMark: timestamp('agent_log_high_water_mark', { withTimezone: true }),
  lastSnapshotAt: timestamp('last_snapshot_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Jobs, versions, drift
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    /** msdb job_id — stable identity for the job on its instance. */
    jobUuid: uuid('job_uuid').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    categoryName: text('category_name'),
    ownerLoginName: text('owner_login_name'),
    description: text('description'),
    currentVersionNo: integer('current_version_no').notNull().default(0),
    currentDefinitionHash: text('current_definition_hash'),
    /** True when the newest version has origin='local' — an on-prem edit. */
    isDrifted: boolean('is_drifted').notNull().default(false),
    driftDetectedAt: timestamp('drift_detected_at', { withTimezone: true }),
    /** Denormalised from history so the estate grid is a single cheap query. */
    lastRunStatus: smallint('last_run_status'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastRunDurationSeconds: integer('last_run_duration_seconds'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    /** Soft delete: a job removed on-prem stays visible with its history. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('jobs_instance_uuid_key').on(t.instanceId, t.jobUuid),
    index('jobs_instance_idx').on(t.instanceId),
    index('jobs_name_idx').on(t.name),
    index('jobs_drift_idx').on(t.isDrifted),
  ],
);

export const jobVersionOrigin = ['initial', 'local', 'remote'] as const;
export type JobVersionOrigin = (typeof jobVersionOrigin)[number];

export const jobVersions = pgTable(
  'job_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    jobUuid: uuid('job_uuid').notNull(),
    /** Monotonic per (instance, job). */
    versionNo: integer('version_no').notNull(),
    /** Canonical JobDefinition.v1. Stored as jsonb so cross-estate search
     * (§9.5) can reach inside step bodies — see docs/security.md for the
     * trade-off against column-level encryption. */
    definition: jsonb('definition').notNull(),
    definitionHash: text('definition_hash').notNull(),
    origin: text('origin').$type<JobVersionOrigin>().notNull(),
    /** Set when origin='remote': links the version to the audited command. */
    commandId: uuid('command_id'),
    createdBy: text('created_by'),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('job_versions_key').on(t.instanceId, t.jobUuid, t.versionNo),
    index('job_versions_lookup_idx').on(t.instanceId, t.jobUuid),
    index('job_versions_hash_idx').on(t.definitionHash),
  ],
);

// ---------------------------------------------------------------------------
// History, activity, agent log
// ---------------------------------------------------------------------------

export const jobHistory = pgTable(
  'job_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    jobUuid: uuid('job_uuid').notNull(),
    /** msdb sysjobhistory.instance_id — the high-water-mark key. Unique per
     * instance, which is what makes ingestion idempotent on replay. */
    sqlInstanceId: bigint('sql_instance_id', { mode: 'number' }).notNull(),
    /** 0 = the job-level outcome row; >0 = a step. */
    stepId: integer('step_id').notNull(),
    stepName: text('step_name'),
    /** 0=Failed 1=Succeeded 2=Retry 3=Cancelled 4=InProgress */
    runStatus: smallint('run_status').notNull(),
    runDatetime: timestamp('run_datetime', { withTimezone: true }).notNull(),
    runDurationSeconds: integer('run_duration_seconds').notNull().default(0),
    message: text('message'),
    retriesAttempted: integer('retries_attempted').notNull().default(0),
    server: text('server'),
    sqlSeverity: integer('sql_severity').notNull().default(0),
    sqlMessageId: integer('sql_message_id').notNull().default(0),
  },
  (t) => [
    uniqueIndex('job_history_instance_sqlid_key').on(t.instanceId, t.sqlInstanceId),
    index('job_history_job_idx').on(t.instanceId, t.jobUuid, t.runDatetime),
    index('job_history_run_datetime_idx').on(t.runDatetime),
    index('job_history_status_idx').on(t.runStatus, t.runDatetime),
    /**
     * The History tab (`getJobHistory`), and the two failure-context lookups
     * that run *inside* ingestion on every new failure (`#failureContext` in
     * notifications/service.ts, and `getCurrentRun` in stats.ts) all filter on
     * `(instance_id, job_uuid)` and order by `sql_instance_id` — msdb's own
     * ordering key, and the one that correctly interleaves step rows with the
     * job-level outcome row that closes each run. `job_history_job_idx` above
     * sorts by `run_datetime` instead, which cannot serve an
     * `ORDER BY sql_instance_id` scan, so every one of those queries fell back
     * to a full filter-then-sort. The failure-context ones matter most: they
     * run synchronously while a new failure is being ingested, so a slow scan
     * there is latency on the write path, not just a slow page load.
     */
    index('job_history_instance_job_sqlid_idx').on(t.instanceId, t.jobUuid, t.sqlInstanceId),
  ],
);

export const jobActivity = pgTable(
  'job_activity',
  {
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    jobUuid: uuid('job_uuid').notNull(),
    state: text('state').notNull(),
    currentStepId: integer('current_step_id'),
    currentStepName: text('current_step_name'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    lastExecutedStepAt: timestamp('last_executed_step_at', { withTimezone: true }),
    nextScheduledRunAt: timestamp('next_scheduled_run_at', { withTimezone: true }),
    lastRunOutcome: smallint('last_run_outcome'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.instanceId, t.jobUuid] })],
);

export const agentLogEntries = pgTable(
  'agent_log_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    loggedAt: timestamp('logged_at', { withTimezone: true }).notNull(),
    severity: text('severity'),
    message: text('message').notNull(),
    processInfo: text('process_info'),
    /** sha256(loggedAt|message) — the Agent log has no row id, so this is what
     * makes re-tailing after a reconnect idempotent. */
    dedupeKey: text('dedupe_key').notNull(),
  },
  (t) => [
    uniqueIndex('agent_log_dedupe_key').on(t.instanceId, t.dedupeKey),
    index('agent_log_time_idx').on(t.instanceId, t.loggedAt),
  ],
);

// ---------------------------------------------------------------------------
// Commands, audit, identity
// ---------------------------------------------------------------------------

export const commandState = [
  'pending_approval',
  'approved',
  'dispatched',
  'succeeded',
  'failed',
  'expired',
  'rejected',
] as const;
export type CommandState = (typeof commandState)[number];

/** States `completedAt` is set on, and therefore safe for retention to reach. */
export const TERMINAL_COMMAND_STATES: readonly CommandState[] = [
  'succeeded',
  'failed',
  'expired',
  'rejected',
];

export const commands = pgTable(
  'commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(),
    instanceId: uuid('instance_id')
      .notNull()
      .references(() => instances.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    jobUuid: uuid('job_uuid'),
    /** The full intended change, persisted before dispatch so the audit trail
     * records what was asked for even if application fails. */
    payload: jsonb('payload').notNull(),
    baseDefinitionHash: text('base_definition_hash'),
    state: text('state').$type<CommandState>().notNull().default('pending_approval'),
    issuedBy: uuid('issued_by'),
    approvedBy: uuid('approved_by'),
    /** Retained alongside the audit row so the command stays independently
     * verifiable long after the TLS session is gone (§6.4). */
    signature: text('signature'),
    resultCode: text('result_code'),
    resultDetail: text('result_detail'),
    sqlErrorNumber: integer('sql_error_number'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (t) => [
    index('commands_state_idx').on(t.state),
    index('commands_worker_idx').on(t.workerId, t.state),
    index('commands_issued_at_idx').on(t.issuedAt),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    /** 'user' | 'worker' | 'system' */
    actorType: text('actor_type').notNull(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    target: text('target'),
    detail: jsonb('detail'),
    remoteAddress: text('remote_address'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_actor_idx').on(t.actor, t.at),
    index('audit_log_action_idx').on(t.action, t.at),
  ],
);

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: text('username').notNull(),
    /** Null for Entra-backed users: they have no local credential by design. */
    passwordHash: text('password_hash'),
    role: text('role').notNull().default('Viewer'),
    displayName: text('display_name'),
    email: text('email'),
    /** 'local' | 'entra' */
    identityProvider: text('identity_provider').notNull().default('local'),
    /** Entra `oid` claim — immutable per user per tenant, unlike UPN or email. */
    externalId: text('external_id'),
    /** True when the role came from an Entra app role rather than local admin
     * assignment; such roles are re-synced on every sign-in and must not be
     * edited in the dashboard, or the next sign-in would silently revert it. */
    roleFromIdp: boolean('role_from_idp').notNull().default(false),
    /**
     * What this user is a member of, as `entra_group:<oid>` and
     * `app_role:<name>`, captured at each sign-in. Environment grants are
     * matched against these (see `environmentGrants`).
     *
     * A snapshot, not a live lookup: it is refreshed on sign-in, so removing
     * somebody from a group in Entra takes effect at their next sign-in or when
     * their session expires, whichever comes first. That bound is the session
     * TTL, and it is the same bound the base role already has.
     */
    identityGroups: jsonb('identity_groups').$type<string[]>().notNull().default([]),
    /**
     * Set when Entra refused to enumerate the groups claim.
     *
     * Past roughly 200 groups Entra replaces `groups` with a `_claim_names` /
     * `_claim_sources` pair pointing at the Graph API rather than listing them.
     * We do not follow it, so `identityGroups` is incomplete and the user gets
     * *less* access than intended — which is the safe direction, but silently
     * having fewer permissions than the administrator granted is impossible to
     * diagnose from the dashboard. This flag is what lets it be reported.
     */
    identityGroupsTruncated: boolean('identity_groups_truncated').notNull().default(false),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_username_key').on(t.username),
    uniqueIndex('users_external_id_key').on(t.externalId),
  ],
);

/**
 * Environment-scoped permission grants (§6.5, extended).
 *
 * The base role on `users` applies estate-wide. A grant *adds* a role within
 * one environment on top of it, and can never take anything away — so the shape
 * an estate actually wants is a base role of Viewer plus a grant of Editor on
 * `production` to whoever runs production. That reads all servers and writes
 * only one environment, which is what "production_admin" means to a DBA.
 *
 * Additive-only is a deliberate design constraint, not a simplification:
 *
 *  - There is no way to write a grant that removes access, so no combination of
 *    grants can produce less access than the base role. That makes the
 *    worst case of a mistake in this table "somebody has more access in one
 *    environment than intended", never "the estate is unreadable" — and the
 *    first is visible in the audit trail while the second is an outage.
 *  - Read routes are therefore not scoped at all. Nothing here hides an
 *    instance, a job or a run from anybody. Adding a subtractive dimension
 *    later would mean auditing every read path in the product for leaks
 *    (search results, notification payloads, metrics, the audit log itself),
 *    which is a different piece of work with a different risk profile.
 *
 * The subject is deliberately *not* a foreign key to `users`. A grant is
 * usually written against an Entra group that nobody has signed in from yet;
 * requiring the user to exist first would mean the grant could only be created
 * after the first person it applies to had already been let in without it.
 */
export const grantSubjectKind = ['entra_group', 'app_role', 'user'] as const;
export type GrantSubjectKind = (typeof grantSubjectKind)[number];

/** `environmentTag` value meaning every environment, including untagged ones. */
export const ALL_ENVIRONMENTS = '*';

export const environmentGrants = pgTable(
  'environment_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    subjectKind: text('subject_kind').$type<GrantSubjectKind>().notNull(),
    /**
     * The Entra group's object id, the Entra app role name, or a `users.id`.
     *
     * Group *object ids* rather than display names: a display name in Entra can
     * be changed, and can be reused by a different group afterwards, so a grant
     * keyed on one silently follows the name to whoever holds it next.
     */
    subjectKey: text('subject_key').notNull(),
    /** Display name for the admin screen, so it is not a wall of GUIDs. Advisory. */
    subjectLabel: text('subject_label'),
    /** An `instances.environment_tag`, matched case-insensitively, or `*`. */
    environmentTag: text('environment_tag').notNull(),
    role: text('role').$type<Role>().notNull(),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One grant per subject per environment: two rows would mean two answers to
    // "what can they do here", and the resolver would have to pick.
    uniqueIndex('environment_grants_subject_env_key').on(
      t.subjectKind,
      t.subjectKey,
      t.environmentTag,
    ),
    index('environment_grants_subject_idx').on(t.subjectKind, t.subjectKey),
  ],
);

/**
 * Worker credentials (§6.2, extended).
 *
 * Three authentication modes share one enrolment flow and one credential table:
 *
 *   token  — a high-entropy API key, stored only as an argon2id hash. Simplest
 *            to operate; the default.
 *   mtls   — an X.509 client certificate issued by the embedded CA. Strongest,
 *            but the site carries CA custody and rotation.
 *   entra  — no stored secret at all: the worker presents an Entra token from
 *            its managed identity and we pin the principal's object id.
 *
 * A worker may hold more than one credential (e.g. during a key rotation, or
 * while migrating from token to mtls), so this is a separate table rather than
 * columns on `workers`.
 */
export const workerCredentialMode = ['token', 'mtls', 'entra'] as const;
export type WorkerCredentialMode = (typeof workerCredentialMode)[number];

export const workerCredentials = pgTable(
  'worker_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<WorkerCredentialMode>().notNull(),
    /** token mode: argon2id hash of the API key. The key itself is shown once. */
    secretHash: text('secret_hash'),
    /** token mode: first 8 chars of the key, so the dashboard can identify it
     * without holding anything usable. */
    secretPrefix: text('secret_prefix'),
    /** mtls mode: serial and fingerprint of the issued client certificate. */
    certSerial: text('cert_serial'),
    certFingerprint: text('cert_fingerprint'),
    certPem: text('cert_pem'),
    /** entra mode: the managed identity's object id (`oid`) and tenant. */
    entraObjectId: text('entra_object_id'),
    entraTenantId: text('entra_tenant_id'),
    label: text('label'),
    createdBy: uuid('created_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('worker_credentials_worker_idx').on(t.workerId),
    index('worker_credentials_mode_idx').on(t.mode),
    uniqueIndex('worker_credentials_cert_serial_key').on(t.certSerial),
    uniqueIndex('worker_credentials_entra_oid_key').on(t.entraObjectId),
  ],
);

/**
 * Outbound audit delivery queue.
 *
 * The database is the source of truth for the audit trail. Export to an
 * external sink (OpenTelemetry logs) is asynchronous and queued, so a collector
 * outage can never fail a user's request or silently drop the trail. Rows are
 * deleted only once the exporter has accepted them.
 */
export const auditExportQueue = pgTable(
  'audit_export_queue',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    auditLogId: uuid('audit_log_id')
      .notNull()
      .references(() => auditLog.id, { onDelete: 'cascade' }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_export_queue_next_idx').on(t.nextAttemptAt)],
);

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const notificationChannelKind = ['email', 'slack', 'teams', 'webhook'] as const;
export type NotificationChannelKind = (typeof notificationChannelKind)[number];

/**
 * Where notifications go.
 *
 * `secret` holds the one piece of bearer material each kind needs — the Slack
 * or Teams incoming-webhook URL, the SMTP password. It is never returned by the
 * API; the dashboard sees only `secretHint`, which is enough to tell two
 * channels apart and useless to anyone who reads it.
 */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    kind: text('kind').$type<NotificationChannelKind>().notNull(),
    /** Non-secret settings: SMTP host/port/from, recipient list, custom headers. */
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    secret: text('secret'),
    /** e.g. "hooks.slack.com/…/T0A9" — recognisable, not reusable. */
    secretHint: text('secret_hint'),
    enabled: boolean('enabled').notNull().default(true),
    lastDeliveredAt: timestamp('last_delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
    lastErrorAt: timestamp('last_error_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notification_channels_name_key').on(t.name)],
);

export const notificationEventKind = [
  'job.failed',
  'job.succeeded',
  'job.recovered',
  'job.long_running',
  'worker.offline',
  'command.failed',
] as const;
export type NotificationEventKind = (typeof notificationEventKind)[number];

/**
 * Which events go to which channels, and for which part of the estate.
 *
 * An empty `instanceIds` means every instance — including ones enrolled after
 * the rule was written, which is the behaviour a growing estate needs.
 */
export const notificationRules = pgTable(
  'notification_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    events: jsonb('events').$type<NotificationEventKind[]>().notNull().default([]),
    instanceIds: jsonb('instance_ids').$type<string[]>().notNull().default([]),
    /** Case-insensitive substring match on the job name; empty matches all. */
    jobNameContains: text('job_name_contains'),
    channelIds: jsonb('channel_ids').$type<string[]>().notNull().default([]),
    /**
     * Suppress repeats of the same event for the same job for this long. A job
     * that fails every five minutes should page once, not 288 times a day.
     */
    throttleMinutes: integer('throttle_minutes').notNull().default(60),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('notification_rules_name_key').on(t.name)],
);

/**
 * Events that have happened, recorded once.
 *
 * `dedupeKey` is what makes detection idempotent: the worker's outbox replays
 * on reconnect, so the same failed run arrives more than once as a matter of
 * course, and it must not notify twice.
 */
export const notificationEvents = pgTable(
  'notification_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').$type<NotificationEventKind>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    instanceId: uuid('instance_id').references(() => instances.id, { onDelete: 'cascade' }),
    workerId: uuid('worker_id').references(() => workers.id, { onDelete: 'cascade' }),
    jobUuid: uuid('job_uuid'),
    /** Everything the message needs, denormalised so a deleted job still renders. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_events_dedupe_key').on(t.dedupeKey),
    index('notification_events_occurred_idx').on(t.occurredAt),
  ],
);

export const notificationDeliveryState = ['pending', 'sent', 'failed', 'suppressed'] as const;
export type NotificationDeliveryState = (typeof notificationDeliveryState)[number];

/**
 * One row per (event, channel). Queued rather than sent inline so that a dead
 * SMTP server or a rate-limited Slack workspace delays a notification instead
 * of failing the ingestion that produced it.
 */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => notificationEvents.id, { onDelete: 'cascade' }),
    ruleId: uuid('rule_id').references(() => notificationRules.id, { onDelete: 'set null' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    state: text('state').$type<NotificationDeliveryState>().notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    /** "kind:instance:job" — what the throttle window is measured against. */
    throttleKey: text('throttle_key').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('notification_deliveries_event_channel_key').on(t.eventId, t.channelId),
    index('notification_deliveries_next_idx').on(t.state, t.nextAttemptAt),
    index('notification_deliveries_throttle_idx').on(t.channelId, t.throttleKey, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Worker onboarding: instance configuration and SQL credentials
// ---------------------------------------------------------------------------

export const instanceConfigStatus = [
  'awaiting_credentials',
  'pending',
  'connected',
  'auth_failed',
  'unreachable',
  'decrypt_failed',
] as const;
export type InstanceConfigStatus = (typeof instanceConfigStatus)[number];

export const sqlAuthMode = ['integrated', 'sql'] as const;
export type SqlAuthMode = (typeof sqlAuthMode)[number];

/**
 * Instances an admin has asked a worker to monitor, configured from the
 * dashboard rather than by editing worker.yaml on the host.
 *
 * **The control plane cannot read the credential.** `credentialCiphertext` is
 * encrypted in the operator's browser to the public key that worker generated
 * at enrolment, and only that worker holds the private half. This database
 * therefore never holds a usable SQL login — which matters, because a control
 * plane that did would concentrate credentials for the whole estate in the one
 * component reachable from every network segment. See docs/security.md.
 */
export const workerInstanceConfigs = pgTable(
  'worker_instance_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workerId: uuid('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    /** "MSSQLSERVER", or a named instance. */
    instanceName: text('instance_name').notNull(),
    /** Address the worker dials, e.g. "localhost" or "localhost\\SQL2019,1433". */
    serverAddress: text('server_address').notNull(),
    authMode: text('auth_mode').$type<SqlAuthMode>().notNull().default('integrated'),
    /** Login name, held in clear: it is not a secret and it is worth showing. */
    loginName: text('login_name'),
    /** RSA-OAEP ciphertext, base64. Opaque here by design. */
    credentialCiphertext: text('credential_ciphertext'),
    /** Fingerprint of the key it was encrypted to, so a re-keyed worker's stale
     * ciphertext is detected rather than handed over and silently failing. */
    credentialKeyFingerprint: text('credential_key_fingerprint'),
    credentialUpdatedAt: timestamp('credential_updated_at', { withTimezone: true }),
    credentialUpdatedBy: uuid('credential_updated_by'),
    encryptTls: boolean('encrypt_tls').notNull().default(true),
    trustServerCertificate: boolean('trust_server_certificate').notNull().default(false),
    environmentTag: text('environment_tag'),
    status: text('status').$type<InstanceConfigStatus>().notNull().default('awaiting_credentials'),
    statusDetail: text('status_detail'),
    statusAt: timestamp('status_at', { withTimezone: true }),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('worker_instance_configs_key').on(t.workerId, t.instanceName),
    index('worker_instance_configs_worker_idx').on(t.workerId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** sha256 of the session token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** sha256 of the double-submit CSRF token bound to this session. */
    csrfTokenHash: text('csrf_token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    remoteAddress: text('remote_address'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

export const enrolmentTokens = pgTable(
  'enrolment_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** sha256 of the token; single-use and short-lived (§6.2). */
    tokenHash: text('token_hash').notNull(),
    /** The token is bound to a host name so it cannot enrol an arbitrary box. */
    hostName: text('host_name').notNull(),
    /** Which credential the admin intends this worker to end up holding. */
    credentialMode: text('credential_mode').$type<WorkerCredentialMode>().notNull().default('token'),
    /** Ceiling the admin intends for this worker. The worker's own worker.yaml
     * can still be lower; it can never be higher. */
    intendedCapabilities: jsonb('intended_capabilities').$type<string[]>().notNull().default([]),
    createdBy: uuid('created_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedByWorkerId: uuid('used_by_worker_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('enrolment_tokens_hash_key').on(t.tokenHash)],
);

/** Singleton row holding control-plane-wide secrets and the embedded CA (§6.2). */
export const serverKeys = pgTable('server_keys', {
  id: text('id').primaryKey(),
  privateKeyPem: text('private_key_pem').notNull(),
  publicKeyPem: text('public_key_pem').notNull(),
  certificatePem: text('certificate_pem'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
