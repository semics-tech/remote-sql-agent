import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { Logger } from 'pino';
import {
  NO_JOB_WRITE,
  ROLES,
  isCapability,
  type JobWriteMode,
  type Role,
} from '@remote-sql-agent/protocol';
import type { Database } from '../db/client.js';
import type { ServerConfig } from '../config.js';
import type { WorkerRegistry } from '../hub/registry.js';
import {
  getAgentLog,
  getEstateOverview,
  getInstance,
  getJob,
  getJobHistory,
  listJobs,
  listWorkers,
  searchJobs,
} from '../domain/queries.js';
import { acknowledgeDrift, getJobVersion, getJobVersions } from '../domain/versioning.js';
import { queryAudit, writeAudit } from '../domain/audit.js';
import { diffJobDefinitions } from '../domain/diff.js';
import { requirePermission, requireInstancePermission, actorOf } from '../auth/rbac.js';
import { registerAuthRoutes } from '../auth/routes.js';
import type { EntraClient } from '../auth/entra.js';
import { createLocalUser, listUsers, setUserDisabled, setUserRole } from '../auth/users.js';
import {
  GrantError,
  deleteGrant,
  grantInputSchema,
  listEnvironmentTags,
  listGrants,
  loadGrants,
  principalOf,
  saveGrant,
  untaggedInstances,
} from '../auth/grants-store.js';
import { permissionsInEnvironment } from '../auth/environments.js';
import { hashToken, safeEqualHex } from '../auth/passwords.js';
import {
  createEnrolmentToken,
  listCredentials,
  revokeCredential,
  rotateWorkerKey,
} from '../worker-auth/enrolment.js';
import { and, eq, sql } from 'drizzle-orm';
import { commandState, jobs, sqlAuthMode, workers } from '../db/schema.js';
import {
  CommandError,
  prepareJobDefinition,
  type CommandService,
} from '../domain/commands.js';
import {
  GROUP_KEYS,
  JOB_FACETS,
  getOverview,
  groupJobs,
  listEstateJobs,
  type JobFacet,
} from '../domain/overview.js';
import { getJobStats } from '../domain/stats.js';
import {
  WorkerConfigError,
  deleteInstanceConfig,
  getCredentialKey,
  listInstanceConfigs,
  listWorkersAwaitingSetup,
  pushInstanceConfigs,
  upsertInstanceConfig,
} from '../domain/worker-config.js';
import type { NotificationService } from '../domain/notifications/service.js';
import {
  SSE_HEADERS,
  SSE_KEEPALIVE_MS,
  formatEvent,
  type EventBroker,
} from './events.js';
import {
  NotificationConfigError,
  channelInputSchema,
  deleteChannel,
  deleteRule,
  listChannels,
  listDeliveries,
  listRules,
  ruleInputSchema,
  saveChannel,
  saveRule,
} from '../domain/notifications/store.js';

/**
 * Read once at module load, from the package this file actually ships in —
 * `/health` used to hardcode this and drifted from the real version at the
 * first release after it was written.
 */
const SERVER_VERSION: string = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'),
  ) as { version: string }
).version;

/** How long a `/metrics` scrape's estate query is reused across concurrent or
 * rapid-fire requests, so a short scrape interval does not multiply the load
 * `getEstateOverview` already puts on Postgres for every dashboard load. */
const METRICS_CACHE_MS = 15_000;

export interface AppDeps {
  db: Database;
  config: ServerConfig;
  logger: Logger;
  registry: WorkerRegistry;
  entra: EntraClient | null;
  commands: CommandService;
  notifications: NotificationService;
  events: EventBroker;
}

const instanceParam = z.object({ instanceId: z.string().uuid() });
const jobParams = z.object({ instanceId: z.string().uuid(), jobUuid: z.string().uuid() });

// The return type is inferred rather than annotated as FastifyInstance: passing
// a concrete pino Logger via `loggerInstance` specialises the instance type, and
// the generic FastifyInstance is not assignable to it.
export async function createApp(deps: AppDeps) {
  const { db, config, logger, registry, entra } = deps;
  const guard = (permission: Parameters<typeof requirePermission>[1]) =>
    requirePermission({ db }, permission);

  /**
   * For routes that change or execute something on one SQL Server.
   *
   * Strictly more permissive than `guard`: the base role is checked first and,
   * only if it is insufficient, an environment grant reaching this instance.
   * Every route using it takes `:instanceId` on the path.
   */
  const instanceGuard = (permission: Parameters<typeof requirePermission>[1]) =>
    requireInstancePermission({ db }, permission);

  /**
   * Approving a command is an act against that command's instance.
   *
   * Guarding it estate-wide would let somebody holding command.approve in one
   * environment approve a change queued against another — which is precisely
   * the separation this feature exists to create, undone at the last step.
   */
  const approvalGuard = requireInstancePermission({ db }, 'command.approve', async (_db, request) => {
    const params = request.params as { commandId?: unknown };
    if (typeof params.commandId !== 'string') return null;
    const command = await deps.commands.byId(params.commandId);
    return command?.instanceId ?? null;
  });

  // Widened to FastifyBaseLogger on purpose: passing a concrete pino Logger
  // specialises the whole FastifyInstance type and makes it incompatible with
  // any helper that accepts a plain FastifyInstance.
  const app = Fastify({
    loggerInstance: logger.child({ component: 'api' }) as FastifyBaseLogger,
    // Counted hops, never `true`. `true` trusts the whole X-Forwarded-For chain
    // and takes the *leftmost* entry — the one the client wrote — so any caller
    // could choose their own `request.ip`. That is both a rate-limit bypass and
    // a forged `remoteAddress` on every audit row and every session. 0 ignores
    // the header entirely. See RSAGENT_TRUSTED_PROXY_HOPS in config.ts.
    trustProxy: config.trustedProxyHops === 0 ? false : config.trustedProxyHops,
    bodyLimit: 4 * 1024 * 1024,
  });

  await app.register(cookie, { secret: config.auth.cookieSecret });
  // Credentials are cookie-based, so the origin allowlist must be exact — a
  // reflected origin with credentials:true is equivalent to no CORS at all.
  await app.register(cors, { origin: [config.publicUrl], credentials: true });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'same-origin');
    return payload;
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: 'ValidationError', detail: error.issues });
    }
    if (error instanceof NotificationConfigError || error instanceof GrantError) {
      return reply.status(error.statusCode).send({ error: error.code, detail: error.message });
    }
    if (error instanceof WorkerConfigError || error instanceof CommandError) {
      // These carry an operator-facing explanation of *why* a command was
      // refused, which is the whole point — a bare 403 teaches nobody anything.
      return reply.status(error.statusCode).send({ error: error.code, detail: error.message });
    }
    request.log.error({ err: error }, 'Unhandled API error');
    const status = error.statusCode ?? 500;
    return reply
      .status(status)
      .send({ error: status < 500 ? error.message : 'InternalServerError' });
  });

  await registerAuthRoutes(app, { db, config, entra });

  // -------------------------------------------------------------------------
  // Health, readiness and metrics
  //
  // Unauthenticated by default: these are scraped by infrastructure that has
  // no session, and neither exposes job content — only counts. `/metrics` can
  // be locked down with RSAGENT_METRICS_TOKEN where the scrape network is not
  // otherwise trusted.
  //
  // `/health` answers "is the process alive", nothing more — no database
  // call, so a Postgres outage cannot turn a liveness probe into a crash-loop
  // across the whole fleet. `/readyz` answers "can this instance actually
  // serve traffic" and is what a readiness probe should point at instead;
  // unlike `/health`, it was previously reporting ready with Postgres gone.
  // -------------------------------------------------------------------------

  app.get('/health', async () => ({
    status: 'ok',
    version: SERVER_VERSION,
    workersOnline: registry.size,
  }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await db.execute(sql`select 1`);
    } catch (err) {
      logger.warn({ err }, 'Readiness check failed: database unreachable');
      return reply.status(503).send({ status: 'error', detail: 'database unreachable' });
    }
    return reply.send({ status: 'ok' });
  });

  let metricsCache: { at: number; estate: Awaited<ReturnType<typeof getEstateOverview>> } | null =
    null;

  app.get('/metrics', async (request, reply) => {
    if (config.metricsToken) {
      const header = request.headers.authorization;
      const provided = header?.startsWith('Bearer ') ? header.slice(7) : null;
      if (!provided || !safeEqualHex(hashToken(provided), hashToken(config.metricsToken))) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }
    }

    // getEstateOverview is a real aggregate query, not a cache read — reused
    // across scrapes so a short Prometheus interval does not multiply the
    // load every dashboard page load already puts on Postgres.
    if (!metricsCache || Date.now() - metricsCache.at > METRICS_CACHE_MS) {
      metricsCache = { at: Date.now(), estate: await getEstateOverview(db) };
    }
    const estate = metricsCache.estate;

    const label = (i: { instanceName: string; hostName: string }) =>
      `{instance="${escapeLabel(i.instanceName)}",host="${escapeLabel(i.hostName)}"}`;
    const lines = [
      '# HELP rsagent_workers_online Number of workers with a live session.',
      '# TYPE rsagent_workers_online gauge',
      `rsagent_workers_online ${registry.size}`,
      '# HELP rsagent_instances_total Number of known SQL Server instances.',
      '# TYPE rsagent_instances_total gauge',
      `rsagent_instances_total ${estate.length}`,
      '# HELP rsagent_jobs_total Number of jobs mirrored per instance.',
      '# TYPE rsagent_jobs_total gauge',
      ...estate.map((i) => `rsagent_jobs_total${label(i)} ${i.jobCount}`),
      '# HELP rsagent_jobs_failed_24h Jobs whose most recent run failed, last 24h.',
      '# TYPE rsagent_jobs_failed_24h gauge',
      ...estate.map((i) => `rsagent_jobs_failed_24h${label(i)} ${i.failedLast24h}`),
      '# HELP rsagent_jobs_drifted Jobs whose newest version was an on-prem edit.',
      '# TYPE rsagent_jobs_drifted gauge',
      ...estate.map((i) => `rsagent_jobs_drifted${label(i)} ${i.driftedJobs}`),
    ];
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });

  // -------------------------------------------------------------------------
  // Estate and instances (§9.1, §9.2)
  // -------------------------------------------------------------------------

  app.get('/api/estate', { preHandler: guard('instance.read') }, async () => ({
    instances: await getEstateOverview(db),
  }));

  /**
   * Live update stream.
   *
   * Carries invalidation signals only — "this changed, refetch it" — so every
   * permission decision stays on the REST routes the browser then calls.
   */
  app.get('/api/events', { preHandler: guard('instance.read') }, (request, reply) => {
    const send = (chunk: string): void => {
      if (!reply.raw.writableEnded) reply.raw.write(chunk);
    };

    const unsubscribe = deps.events.subscribe((event) => send(formatEvent(event)));
    if (!unsubscribe) {
      return reply
        .status(503)
        .send({ error: 'TooManyStreams', detail: 'Too many live connections. Try again shortly.' });
    }

    // Fastify must not try to serialise or close this response.
    reply.hijack();
    reply.raw.writeHead(200, SSE_HEADERS);
    // An initial comment flushes headers immediately, so EventSource fires
    // `open` rather than sitting in `connecting` until the first real event.
    send(': connected\n\n');

    const keepalive = setInterval(() => send(': keepalive\n\n'), SSE_KEEPALIVE_MS);
    keepalive.unref();

    const close = (): void => {
      clearInterval(keepalive);
      unsubscribe();
    };
    request.raw.on('close', close);
    request.raw.on('error', close);
    return reply;
  });

  /** The operations overview: what is running, what is late, what broke. */
  app.get('/api/overview', { preHandler: guard('instance.read') }, async () =>
    getOverview(db, (workerId) => registry.isOnline(workerId)),
  );

  /**
   * Every job in the estate, filterable — "show me everything failing right
   * now, wherever it lives".
   *
   * Registered before `/api/jobs/groups` only incidentally; Fastify routes on
   * the full path, so the two do not shadow one another.
   */
  app.get('/api/jobs', { preHandler: guard('job.read') }, async (request) => {
    const { status, filter, limit } = z
      .object({
        // Repeatable (`?status=a&status=b`) and comma-separated both work; the
        // dashboard sends one comma-separated value and a hand-written curl
        // reasonably expects the other.
        status: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .transform((v) =>
            (Array.isArray(v) ? v : v === undefined ? [] : [v])
              .flatMap((s) => s.split(','))
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        filter: z.string().max(128).optional(),
        limit: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);

    const unknown = status.filter((s) => !(JOB_FACETS as readonly string[]).includes(s));
    if (unknown.length > 0) {
      // Silently dropping an unrecognised filter would show the whole estate
      // and look like "nothing is wrong" rather than "you asked for something
      // that does not exist".
      throw new CommandError(
        400,
        'UnknownStatus',
        `Not a job status: ${unknown.join(', ')}. Valid values are ${JOB_FACETS.join(', ')}.`,
      );
    }

    return listEstateJobs(db, { facets: status as JobFacet[], filter, limit });
  });

  /** Cross-estate job grouping — "is this job healthy on all thirty servers?" */
  app.get('/api/jobs/groups', { preHandler: guard('job.read') }, async (request) => {
    const { by, filter } = z
      .object({
        by: z.enum(GROUP_KEYS).default('name'),
        filter: z.string().max(128).optional(),
      })
      .parse(request.query);
    const { groups, truncated } = await groupJobs(db, by, { filter });
    return { groupBy: by, groups, truncated };
  });

  app.get(
    '/api/instances/:instanceId',
    { preHandler: guard('instance.read') },
    async (request, reply) => {
      const { instanceId } = instanceParam.parse(request.params);
      const instance = await getInstance(db, instanceId);
      if (!instance) return reply.status(404).send({ error: 'NotFound' });
      return { ...instance, workerOnline: registry.isOnline(instance.workerId) };
    },
  );

  app.get('/api/instances/:instanceId/jobs', { preHandler: guard('job.read') }, async (request) => {
    const { instanceId } = instanceParam.parse(request.params);
    const { includeDeleted } = z
      .object({ includeDeleted: z.coerce.boolean().optional() })
      .parse(request.query);
    return { jobs: await listJobs(db, instanceId, { includeDeleted }) };
  });

  app.get(
    '/api/instances/:instanceId/agent-log',
    { preHandler: guard('instance.read') },
    async (request) => {
      const { instanceId } = instanceParam.parse(request.params);
      const { limit } = z
        .object({ limit: z.coerce.number().int().positive().optional() })
        .parse(request.query);
      return { entries: await getAgentLog(db, instanceId, limit ?? 200) };
    },
  );

  // -------------------------------------------------------------------------
  // Job detail, history, versions (§9.3)
  // -------------------------------------------------------------------------

  app.get(
    '/api/instances/:instanceId/jobs/:jobUuid',
    { preHandler: guard('job.read') },
    async (request, reply) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const job = await getJob(db, instanceId, jobUuid);
      if (!job) return reply.status(404).send({ error: 'NotFound' });
      return job;
    },
  );

  app.get(
    '/api/instances/:instanceId/jobs/:jobUuid/history',
    { preHandler: guard('history.read') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const { limit } = z
        .object({ limit: z.coerce.number().int().positive().optional() })
        .parse(request.query);
      return { runs: await getJobHistory(db, instanceId, jobUuid, limit ?? 50) };
    },
  );

  /** Statistics and per-step baselines behind the job overview and step graph. */
  app.get(
    '/api/instances/:instanceId/jobs/:jobUuid/stats',
    { preHandler: guard('history.read') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      return getJobStats(db, instanceId, jobUuid);
    },
  );

  app.get(
    '/api/instances/:instanceId/jobs/:jobUuid/versions',
    { preHandler: guard('version.read') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const versions = await getJobVersions(db, instanceId, jobUuid);
      return { versions: versions.map(({ definition: _definition, ...v }) => v) };
    },
  );

  app.get(
    '/api/instances/:instanceId/jobs/:jobUuid/versions/:versionNo',
    { preHandler: guard('version.read') },
    async (request, reply) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const { versionNo } = z
        .object({ versionNo: z.coerce.number().int().positive() })
        .parse(request.params);
      const version = await getJobVersion(db, instanceId, jobUuid, versionNo);
      if (!version) return reply.status(404).send({ error: 'NotFound' });
      return version;
    },
  );

  app.get(
    '/api/instances/:instanceId/jobs/:jobUuid/diff',
    { preHandler: guard('version.read') },
    async (request, reply) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const { from, to } = z
        .object({
          from: z.coerce.number().int().positive(),
          to: z.coerce.number().int().positive(),
        })
        .parse(request.query);

      const [a, b] = await Promise.all([
        getJobVersion(db, instanceId, jobUuid, from),
        getJobVersion(db, instanceId, jobUuid, to),
      ]);
      if (!a || !b) return reply.status(404).send({ error: 'NotFound' });

      return {
        from: { versionNo: a.versionNo, detectedAt: a.detectedAt, origin: a.origin },
        to: { versionNo: b.versionNo, detectedAt: b.detectedAt, origin: b.origin },
        changes: diffJobDefinitions(a.definition, b.definition),
      };
    },
  );

  app.post(
    '/api/instances/:instanceId/jobs/:jobUuid/acknowledge-drift',
    { preHandler: instanceGuard('job.toggle') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      await acknowledgeDrift(db, instanceId, jobUuid);
      await writeAudit(db, {
        actorType: 'user',
        actor: actorOf(request),
        action: 'drift.acknowledged',
        target: `${instanceId}/${jobUuid}`,
        remoteAddress: request.ip,
      });
      return { acknowledged: true };
    },
  );

  // -------------------------------------------------------------------------
  // Write path (§6.4, M4)
  //
  // Every route here only *issues* a command. Nothing in the control plane
  // touches a SQL Server; the worker applies it, after its own independent
  // checks, and reports back.
  // -------------------------------------------------------------------------

  /** What the signed-in user could actually do to this instance right now. */
  app.get(
    '/api/instances/:instanceId/capabilities',
    { preHandler: guard('instance.read') },
    async (request) => {
      const { instanceId } = instanceParam.parse(request.params);
      const { capabilities, hostName } = await deps.commands.effectiveCapabilitiesFor(instanceId);
      const [instance, grants] = await Promise.all([getInstance(db, instanceId), loadGrants(db)]);
      const environmentTag = instance?.environmentTag ?? null;
      return {
        hostName,
        workerCapabilities: capabilities,
        // What SQL Server itself will permit, which is a separate question from
        // what this product grants. A worker can hold job.write and still be
        // unable to edit a job owned by another login.
        jobWriteMode: (instance?.jobWriteMode as JobWriteMode | null) ?? NO_JOB_WRITE,
        // Scoped to this instance's environment, not the bare base role. The
        // SPA greys out what a user cannot do, and an estate-wide answer here
        // would either hide controls that would in fact work in production, or
        // offer ones that the guard will refuse.
        environmentTag,
        yourPermissions: request.user
          ? permissionsInEnvironment(principalOf(request.user), grants, environmentTag)
          : [],
        // Whether *this* user's saves will queue, not whether the rule exists:
        // an exempt Admin should not be warned about an approval step that will
        // never apply to them.
        approvalRequiredForJobWrite: request.user
          ? deps.commands.requiresApproval('upsertJob', request.user.role)
          : false,
      };
    },
  );

  /**
   * Issue a command on behalf of the signed-in user.
   *
   * `request.user` is always set here: every caller sits behind a
   * `requirePermission` guard, which refuses the request before the handler
   * runs if there is no session.
   */
  const issue = async (
    request: FastifyRequest,
    input: Omit<
      Parameters<CommandService['create']>[0],
      'issuedBy' | 'issuedByUsername' | 'issuedByRole' | 'remoteAddress'
    >,
  ) =>
    deps.commands.create({
      ...input,
      issuedBy: request.user!.id,
      issuedByUsername: request.user!.username,
      issuedByRole: request.user!.role,
      remoteAddress: request.ip,
    });

  /**
   * The hash the caller says their change was based on.
   *
   * Required for every change to an existing job, and this is load-bearing: the
   * worker reads an empty base hash as "create — nothing to conflict with"
   * (`command-handler.ts`, `checkConflict`). So omitting the field skipped the
   * drift check outright, and `allowOverwrite` — the flag that exists to make
   * overwriting an unacknowledged DBA edit a deliberate act — was bypassable by
   * simply not sending it.
   *
   * The control plane already holds the authoritative hash, so it is also
   * checked here rather than only on the SQL host. That turns a stale editor
   * into an immediate 409 instead of a command that queues, dispatches, and
   * comes back refused seconds later.
   */
  const baseHashFor = async (
    instanceId: string,
    jobUuid: string,
    supplied: string | undefined,
    allowOverwrite: boolean,
  ): Promise<string> => {
    // An explicit overwrite is the operator saying "I have seen the conflict
    // and I mean it". Nothing to check; the worker skips its own check too.
    if (allowOverwrite) return supplied ?? '';

    if (supplied === undefined) {
      throw new CommandError(
        400,
        'BaseHashRequired',
        'Changing an existing job needs the definition hash your change was based on, ' +
          'so a concurrent edit on the SQL host is not silently overwritten. ' +
          'Send baseDefinitionHash, or allowOverwrite to overwrite deliberately.',
      );
    }

    const [row] = await db
      .select({ currentDefinitionHash: jobs.currentDefinitionHash })
      .from(jobs)
      .where(and(eq(jobs.instanceId, instanceId), eq(jobs.jobUuid, jobUuid)));

    // No row, or a job the control plane has never held a definition for: the
    // supplied hash is all there is to go on, and the worker still checks it.
    if (!row?.currentDefinitionHash) return supplied;

    if (row.currentDefinitionHash !== supplied) {
      throw new CommandError(
        409,
        'Conflict',
        'This job changed since you loaded it. Reload to see the current definition, ' +
          'then re-apply your change.',
      );
    }
    return supplied;
  };

  app.post(
    '/api/instances/:instanceId/jobs/:jobUuid/toggle',
    { preHandler: instanceGuard('job.toggle') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const { enabled, baseDefinitionHash, allowOverwrite } = z
        .object({
          enabled: z.boolean(),
          baseDefinitionHash: z.string().optional(),
          allowOverwrite: z.boolean().optional(),
        })
        .parse(request.body);

      const base = await baseHashFor(
        instanceId,
        jobUuid,
        baseDefinitionHash,
        allowOverwrite === true,
      );

      return issue(request, {
        instanceId,
        kind: 'toggleJob',
        jobUuid,
        payload: { jobUuid, enabled, baseDefinitionHash: base },
        baseDefinitionHash: base || null,
      });
    },
  );

  /**
   * Put a job under central management, or take it out again.
   *
   * Guarded by job.write rather than a permission of its own: allowlisting a
   * job is the act that makes editing it possible, so anyone who could do this
   * could already edit it once done, and a second permission would only be one
   * more thing to forget to revoke.
   *
   * The worker applies it through the wrapper's own procedure, so an instance
   * installed as DBA-managed refuses it in msdb — this route issuing the
   * command is not the same as the change being accepted.
   */
  app.post(
    '/api/instances/:instanceId/jobs/:jobUuid/write-allowed',
    { preHandler: instanceGuard('job.write') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const { allowed } = z.object({ allowed: z.boolean() }).parse(request.body);

      const job = await getJob(db, instanceId, jobUuid);
      if (!job) throw new CommandError(404, 'NotFound', 'No such job.');

      return issue(request, {
        instanceId,
        kind: 'setJobWriteAllowed',
        jobUuid,
        // The name is resolved here rather than taken from the request: the
        // allowlist is keyed on it, and letting a caller supply a name that
        // does not match the job they named would allowlist something else.
        payload: { jobUuid, jobName: job.name, allowed },
      });
    },
  );

  app.post(
    '/api/instances/:instanceId/jobs/:jobUuid/run',
    { preHandler: instanceGuard('job.run') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const { stepName } = z.object({ stepName: z.string().optional() }).parse(request.body ?? {});
      return issue(request, {
        instanceId,
        kind: 'runJob',
        jobUuid,
        payload: { jobUuid, stepName: stepName ?? '' },
      });
    },
  );

  app.post(
    '/api/instances/:instanceId/jobs/:jobUuid/stop',
    { preHandler: instanceGuard('job.run') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      return issue(request, {
        instanceId,
        kind: 'stopJob',
        jobUuid,
        payload: { jobUuid },
      });
    },
  );

  /** Create or update a job from a full JobDefinition.v1. */
  app.put(
    '/api/instances/:instanceId/jobs/:jobUuid',
    { preHandler: instanceGuard('job.write') },
    async (request) => {
      const { instanceId, jobUuid } = z
        .object({
          instanceId: z.string().uuid(),
          // "new" is the sentinel for a job that does not exist yet: msdb
          // allocates the id, so the dashboard cannot supply one.
          jobUuid: z.union([z.string().uuid(), z.literal('new')]),
        })
        .parse(request.params);

      const body = z
        .object({
          definition: z.unknown(),
          baseDefinitionHash: z.string().optional(),
          allowOverwrite: z.boolean().optional(),
        })
        .parse(request.body);

      const { canonicalJson } = prepareJobDefinition(body.definition);

      // A create has nothing to conflict with, so it is the one case where an
      // absent base hash is correct rather than a bypass.
      const base =
        jobUuid === 'new'
          ? ''
          : await baseHashFor(instanceId, jobUuid, body.baseDefinitionHash, body.allowOverwrite === true);

      return issue(request, {
        instanceId,
        kind: 'upsertJob',
        jobUuid: jobUuid === 'new' ? null : jobUuid,
        payload: {
          jobUuid: jobUuid === 'new' ? '' : jobUuid,
          canonicalJson,
          baseDefinitionHash: base,
          allowOverwrite: body.allowOverwrite === true,
        },
        baseDefinitionHash: base || null,
      });
    },
  );

  app.delete(
    '/api/instances/:instanceId/jobs/:jobUuid',
    { preHandler: instanceGuard('job.write') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const { baseDefinitionHash, allowOverwrite } = z
        .object({
          baseDefinitionHash: z.string().optional(),
          allowOverwrite: z.boolean().optional(),
        })
        .parse(request.body ?? {});

      const base = await baseHashFor(
        instanceId,
        jobUuid,
        baseDefinitionHash,
        allowOverwrite === true,
      );

      return issue(request, {
        instanceId,
        kind: 'deleteJob',
        jobUuid,
        payload: { jobUuid, baseDefinitionHash: base },
        baseDefinitionHash: base || null,
      });
    },
  );

  // --- Commands and approvals (§9.6) ---------------------------------------

  app.get('/api/commands', { preHandler: guard('job.read') }, async (request) => {
    const { state, limit } = z
      .object({
        state: z.enum(commandState).optional(),
        limit: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    return {
      commands: await deps.commands.list({ state, limit }),
      pendingApproval: await deps.commands.countPendingApproval(),
    };
  });

  /**
   * A single command, so the job editor can find out whether the save it just
   * issued actually landed. Queuing a command is not the same as applying one:
   * the worker can refuse it seconds later, and the editor used to report
   * success on the enqueue and never revisit it.
   */
  app.get('/api/commands/:commandId', { preHandler: guard('job.read') }, async (request, reply) => {
    const { commandId } = z.object({ commandId: z.string().uuid() }).parse(request.params);
    const command = await deps.commands.byId(commandId);
    if (!command) return reply.status(404).send({ error: 'NotFound' });
    return command;
  });

  app.post('/api/commands/:commandId/approve', { preHandler: approvalGuard }, async (request) => {
    const { commandId } = z.object({ commandId: z.string().uuid() }).parse(request.params);
    await deps.commands.approve(commandId, request.user!.id, request.user!.username, request.ip);
    return { approved: true };
  });

  app.post('/api/commands/:commandId/reject', { preHandler: approvalGuard }, async (request) => {
    const { commandId } = z.object({ commandId: z.string().uuid() }).parse(request.params);
    const { reason } = z.object({ reason: z.string().max(500) }).parse(request.body);
    await deps.commands.reject(commandId, request.user!.username, reason, request.ip);
    return { rejected: true };
  });

  // -------------------------------------------------------------------------
  // Cross-estate search (§9.5)
  // -------------------------------------------------------------------------

  app.get('/api/search', { preHandler: guard('job.read') }, async (request) => {
    const { q, limit } = z
      .object({
        q: z.string().min(2, 'Search needs at least two characters'),
        limit: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    return { query: q, hits: await searchJobs(db, q, { limit }) };
  });

  // -------------------------------------------------------------------------
  // Administration (§9.7)
  // -------------------------------------------------------------------------

  app.get('/api/workers', { preHandler: guard('worker.admin') }, async () => {
    const rows = await listWorkers(db);
    return { workers: rows.map((w) => ({ ...w, online: registry.isOnline(w.id) })) };
  });

  app.get('/api/workers/:workerId/credentials', { preHandler: guard('worker.admin') }, async (request) => {
    const { workerId } = z.object({ workerId: z.string().uuid() }).parse(request.params);
    return { credentials: await listCredentials(db, workerId) };
  });

  /** Rotate a worker's API key. The new key is returned once and never again. */
  app.post(
    '/api/workers/:workerId/credentials/rotate',
    { preHandler: guard('worker.admin') },
    async (request) => {
      const { workerId } = z.object({ workerId: z.string().uuid() }).parse(request.params);
      const key = await rotateWorkerKey(db, workerId, config, request.user?.id ?? null);
      await writeAudit(db, {
        actorType: 'user',
        actor: actorOf(request),
        action: 'worker.credential.rotated',
        target: workerId,
        remoteAddress: request.ip,
      });
      return {
        workerKey: key,
        note: 'Copy this now — it is not shown again. The previous key stays valid until you revoke it.',
      };
    },
  );

  app.post(
    '/api/workers/:workerId/credentials/:credentialId/revoke',
    { preHandler: guard('worker.admin') },
    async (request) => {
      const { credentialId } = z
        .object({ workerId: z.string().uuid(), credentialId: z.string().uuid() })
        .parse(request.params);
      const { reason } = z.object({ reason: z.string().max(500).optional() }).parse(request.body ?? {});
      await revokeCredential(db, credentialId, reason ?? 'Revoked from the dashboard');
      await writeAudit(db, {
        actorType: 'user',
        actor: actorOf(request),
        action: 'worker.credential.revoked',
        target: credentialId,
        detail: { reason },
        remoteAddress: request.ip,
      });
      return { revoked: true };
    },
  );

  app.post('/api/enrolment-tokens', { preHandler: guard('worker.admin') }, async (request) => {
    const body = z
      .object({
        hostName: z.string().min(1).max(255),
        credentialMode: z.enum(['token', 'mtls', 'entra']).default('token'),
        capabilities: z.array(z.string()).default([]),
      })
      .parse(request.body);

    const unknown = body.capabilities.filter((c) => !isCapability(c));
    if (unknown.length > 0) {
      throw Object.assign(new Error(`Unknown capabilities: ${unknown.join(', ')}`), {
        statusCode: 400,
      });
    }
    if (!config.workerAuth.enabledModes.includes(body.credentialMode)) {
      throw Object.assign(
        new Error(
          `Worker auth mode "${body.credentialMode}" is not enabled. Enabled: ${config.workerAuth.enabledModes.join(', ')}.`,
        ),
        { statusCode: 400 },
      );
    }

    const created = await createEnrolmentToken(db, {
      hostName: body.hostName,
      credentialMode: body.credentialMode,
      intendedCapabilities: body.capabilities,
      createdBy: request.user?.id ?? null,
      ttlMinutes: config.workerAuth.enrolmentTokenTtlMinutes,
    });

    await writeAudit(db, {
      actorType: 'user',
      actor: actorOf(request),
      action: 'enrolment_token.created',
      target: body.hostName,
      detail: { credentialMode: body.credentialMode, capabilities: body.capabilities },
      remoteAddress: request.ip,
    });

    return {
      token: created.token,
      expiresAt: created.expiresAt,
      hostName: body.hostName,
      note: 'Single use. Copy it now — it is not shown again.',
      install: installCommands({
        token: created.token,
        hostName: body.hostName,
        hubAddress: hubAddress(config),
        publicUrl: config.publicUrl,
      }),
    };
  });

  /** Grant or reduce a worker's server-side capabilities (§6.3). */
  app.post('/api/workers/:workerId/capabilities', { preHandler: guard('worker.admin') }, async (request) => {
    const { workerId } = z.object({ workerId: z.string().uuid() }).parse(request.params);
    const { capabilities } = z.object({ capabilities: z.array(z.string()) }).parse(request.body);

    const unknown = capabilities.filter((c) => !isCapability(c));
    if (unknown.length > 0) {
      throw Object.assign(new Error(`Unknown capabilities: ${unknown.join(', ')}`), {
        statusCode: 400,
      });
    }

    await db.update(workers).set({ capabilities }).where(eq(workers.id, workerId));
    await writeAudit(db, {
      actorType: 'user',
      actor: actorOf(request),
      action: 'worker.capabilities.changed',
      target: workerId,
      detail: { capabilities },
      remoteAddress: request.ip,
    });

    // The worker re-derives its effective set from its own ceiling on the next
    // session, so a grant here is a request, not a guarantee.
    return {
      capabilities,
      note: 'Takes effect on the worker\'s next session, capped by its local maxCapability.',
    };
  });

  // --- Worker onboarding (§9.7 extended) -----------------------------------

  /** Workers that have enrolled but have nothing to monitor yet. */
  app.get('/api/workers/awaiting-setup', { preHandler: guard('worker.admin') }, async () => ({
    workers: (await listWorkersAwaitingSetup(db)).map((w) => ({
      ...w,
      online: registry.isOnline(w.workerId),
    })),
  }));

  /**
   * The worker's public key, so the browser can encrypt a SQL credential to it.
   *
   * This is the load-bearing half of "the control plane never holds a usable
   * SQL login": the dashboard encrypts with this key, and only the worker on
   * that host holds the private half.
   */
  app.get(
    '/api/workers/:workerId/credential-key',
    { preHandler: guard('worker.admin') },
    async (request, reply) => {
      const { workerId } = z.object({ workerId: z.string().uuid() }).parse(request.params);
      const key = await getCredentialKey(db, workerId);
      if (!key) {
        return reply.status(409).send({
          error: 'NoCredentialKey',
          detail:
            'This worker has not published an encryption key yet. It publishes one the first time it connects.',
        });
      }
      return key;
    },
  );

  app.get(
    '/api/workers/:workerId/instance-configs',
    { preHandler: guard('worker.admin') },
    async (request) => {
      const { workerId } = z.object({ workerId: z.string().uuid() }).parse(request.params);
      return { configs: await listInstanceConfigs(db, workerId) };
    },
  );

  app.put(
    '/api/workers/:workerId/instance-configs',
    { preHandler: guard('worker.admin') },
    async (request) => {
      const { workerId } = z.object({ workerId: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          instanceName: z.string().min(1).max(128),
          serverAddress: z.string().min(1).max(255),
          authMode: z.enum(sqlAuthMode),
          loginName: z.string().max(128).nullish(),
          // Opaque here on purpose. The server has no key to check it with, and
          // that is the property being preserved rather than a gap.
          credentialCiphertext: z.string().max(4096).nullish(),
          credentialKeyFingerprint: z.string().max(128).nullish(),
          encryptTls: z.boolean().optional(),
          trustServerCertificate: z.boolean().optional(),
          environmentTag: z.string().max(64).nullish(),
        })
        .parse(request.body);

      const saved = await upsertInstanceConfig(db, {
        ...body,
        workerId,
        actorId: request.user?.id ?? null,
      });

      await writeAudit(db, {
        actorType: 'user',
        actor: actorOf(request),
        action: 'worker.instance_config.saved',
        target: `${workerId}/${body.instanceName}`,
        // Never the ciphertext, and obviously never a credential — only whether
        // one was supplied.
        detail: {
          serverAddress: body.serverAddress,
          authMode: body.authMode,
          loginName: body.loginName ?? null,
          credentialSupplied: Boolean(body.credentialCiphertext),
        },
        remoteAddress: request.ip,
      });

      const delivered = await pushInstanceConfigs(db, registry, workerId);
      return {
        config: saved,
        delivered,
        note: delivered
          ? 'Sent to the worker. It will report back once it has tried to connect.'
          : 'Saved. The worker is offline, so it will pick this up when it next connects.',
      };
    },
  );

  app.delete(
    '/api/workers/:workerId/instance-configs/:configId',
    { preHandler: guard('worker.admin') },
    async (request, reply) => {
      const { workerId, configId } = z
        .object({ workerId: z.string().uuid(), configId: z.string().uuid() })
        .parse(request.params);

      const owner = await deleteInstanceConfig(db, configId);
      if (owner !== workerId) return reply.status(404).send({ error: 'NotFound' });

      await writeAudit(db, {
        actorType: 'user',
        actor: actorOf(request),
        action: 'worker.instance_config.removed',
        target: `${workerId}/${configId}`,
        remoteAddress: request.ip,
      });

      await pushInstanceConfigs(db, registry, workerId);
      return { removed: true };
    },
  );

  // --- Notifications (§9.8) -------------------------------------------------

  app.get('/api/notifications/channels', { preHandler: guard('worker.admin') }, async () => ({
    channels: await listChannels(db),
  }));

  app.post('/api/notifications/channels', { preHandler: guard('worker.admin') }, async (request) => {
    const body = channelInputSchema.parse(request.body);
    const channel = await saveChannel(db, { ...body, actorId: request.user?.id ?? null });
    await writeAudit(db, {
      actorType: 'user',
      actor: actorOf(request),
      action: 'notification.channel.saved',
      target: channel.id,
      detail: { name: body.name, kind: body.kind },
      remoteAddress: request.ip,
    });
    return channel;
  });

  app.delete(
    '/api/notifications/channels/:channelId',
    { preHandler: guard('worker.admin') },
    async (request) => {
      const { channelId } = z.object({ channelId: z.string().uuid() }).parse(request.params);
      await deleteChannel(db, channelId);
      await writeAudit(db, {
        actorType: 'user',
        actor: actorOf(request),
        action: 'notification.channel.removed',
        target: channelId,
        remoteAddress: request.ip,
      });
      return { removed: true };
    },
  );

  /** Send a sample so a misconfiguration surfaces now, not during an incident. */
  app.post(
    '/api/notifications/channels/:channelId/test',
    { preHandler: guard('worker.admin') },
    async (request, reply) => {
      const { channelId } = z.object({ channelId: z.string().uuid() }).parse(request.params);
      try {
        await deps.notifications.test(channelId, actorOf(request));
      } catch (err) {
        // The sender's own message names the failure precisely; a generic
        // "test failed" would send the admin looking in the wrong place.
        return reply.status(502).send({
          error: 'DeliveryFailed',
          detail: err instanceof Error ? err.message : 'Delivery failed.',
        });
      }
      return { sent: true };
    },
  );

  app.get('/api/notifications/rules', { preHandler: guard('worker.admin') }, async () => ({
    rules: await listRules(db),
  }));

  app.post('/api/notifications/rules', { preHandler: guard('worker.admin') }, async (request) => {
    const body = ruleInputSchema.parse(request.body);
    const rule = await saveRule(db, { ...body, actorId: request.user?.id ?? null });
    await writeAudit(db, {
      actorType: 'user',
      actor: actorOf(request),
      action: 'notification.rule.saved',
      target: rule.id,
      detail: { name: body.name, events: body.events },
      remoteAddress: request.ip,
    });
    return rule;
  });

  app.delete(
    '/api/notifications/rules/:ruleId',
    { preHandler: guard('worker.admin') },
    async (request) => {
      const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(request.params);
      await deleteRule(db, ruleId);
      await writeAudit(db, {
        actorType: 'user',
        actor: actorOf(request),
        action: 'notification.rule.removed',
        target: ruleId,
        remoteAddress: request.ip,
      });
      return { removed: true };
    },
  );

  /** What was sent, what was throttled, and what failed. */
  app.get('/api/notifications/deliveries', { preHandler: guard('worker.admin') }, async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    return { deliveries: await listDeliveries(db, limit ?? 100) };
  });

  app.get('/api/audit', { preHandler: guard('audit.read') }, async (request) => {
    const q = z
      .object({
        actor: z.string().optional(),
        action: z.string().optional(),
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.coerce.number().int().positive().optional(),
        offset: z.coerce.number().int().min(0).optional(),
      })
      .parse(request.query);
    return { entries: await queryAudit(db, q) };
  });

  // -------------------------------------------------------------------------
  // Environment grants (§6.5, extended)
  //
  // Administered estate-wide on purpose: deciding who may write to production
  // is not itself a production-scoped act, and letting a production grant
  // confer the ability to write grants would make every grant self-extending.
  // -------------------------------------------------------------------------

  app.get('/api/environment-grants', { preHandler: guard('user.admin') }, async () => {
    const [grants, environments, untagged] = await Promise.all([
      listGrants(db),
      listEnvironmentTags(db),
      untaggedInstances(db),
    ]);
    return {
      grants,
      // The tags actually in use, so the admin screen offers a list rather than
      // a free-text box that silently accepts a typo.
      environments,
      // The quiet failure mode of the whole design, reported rather than left
      // to be discovered: an untagged instance is reachable by base role only,
      // so a `production` grant does not cover it and nobody is told.
      untaggedInstances: untagged,
    };
  });

  app.post('/api/environment-grants', { preHandler: guard('user.admin') }, async (request) => {
    const input = grantInputSchema.parse(request.body);
    const saved = await saveGrant(db, input, request.user?.id ?? null);

    await writeAudit(db, {
      actorType: 'user',
      actor: actorOf(request),
      action: 'environment-grant.saved',
      target: `${input.subjectKind}:${input.subjectKey}@${input.environmentTag}`,
      detail: { role: input.role, subjectLabel: input.subjectLabel ?? null },
      remoteAddress: request.ip,
    });

    return { id: saved.id };
  });

  app.delete(
    '/api/environment-grants/:grantId',
    { preHandler: guard('user.admin') },
    async (request, reply) => {
      const { grantId } = z.object({ grantId: z.string().uuid() }).parse(request.params);
      const removed = await deleteGrant(db, grantId);
      if (!removed) return reply.status(404).send({ error: 'NotFound' });

      await writeAudit(db, {
        actorType: 'user',
        actor: actorOf(request),
        action: 'environment-grant.removed',
        target: grantId,
        remoteAddress: request.ip,
      });

      return { removed: true };
    },
  );

  app.get('/api/users', { preHandler: guard('user.admin') }, async () => ({
    users: await listUsers(db),
  }));

  app.post('/api/users', { preHandler: guard('user.admin') }, async (request) => {
    const body = z
      .object({
        username: z.string().min(1).max(256),
        password: z.string().min(12, 'Use at least 12 characters.').max(1024),
        role: z.enum(ROLES),
        displayName: z.string().max(256).optional(),
      })
      .parse(request.body);

    const created = await createLocalUser(db, body);
    await writeAudit(db, {
      actorType: 'user',
      actor: actorOf(request),
      action: 'user.created',
      target: created?.id,
      detail: { username: body.username, role: body.role },
      remoteAddress: request.ip,
    });
    return created;
  });

  app.post('/api/users/:userId/role', { preHandler: guard('user.admin') }, async (request) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const { role } = z.object({ role: z.enum(ROLES) }).parse(request.body);

    try {
      await setUserRole(db, userId, role as Role);
    } catch (err) {
      throw Object.assign(new Error(err instanceof Error ? err.message : 'Failed'), {
        statusCode: 400,
      });
    }

    await writeAudit(db, {
      actorType: 'user',
      actor: actorOf(request),
      action: 'user.role.changed',
      target: userId,
      detail: { role },
      remoteAddress: request.ip,
    });
    return { role };
  });

  app.post('/api/users/:userId/disabled', { preHandler: guard('user.admin') }, async (request) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(request.params);
    const { disabled } = z.object({ disabled: z.boolean() }).parse(request.body);

    if (userId === request.user?.id && disabled) {
      throw Object.assign(new Error('You cannot disable your own account.'), { statusCode: 400 });
    }

    await setUserDisabled(db, userId, disabled);
    await writeAudit(db, {
      actorType: 'user',
      actor: actorOf(request),
      action: disabled ? 'user.disabled' : 'user.enabled',
      target: userId,
      remoteAddress: request.ip,
    });
    return { disabled };
  });

  // -------------------------------------------------------------------------
  // Worker bootstrap
  //
  // Unauthenticated, and deliberately so: a SQL host running the install
  // one-liner has no dashboard session. Neither the scripts nor the package are
  // secret — the enrolment token is the credential, it is single-use, short
  // lived, bound to a host name, and lives only in the command the admin pasted.
  // -------------------------------------------------------------------------

  if (config.workerPackageDir) {
    const packageDir = config.workerPackageDir;

    const serveScript = async (file: string, reply: FastifyReply, contentType: string) => {
      const path = join(packageDir, file);
      if (!existsSync(path)) {
        return reply
          .status(503)
          .type('text/plain')
          .send(
            `The worker bootstrap script is not available on this control plane.\n` +
              `Expected ${file} in ${packageDir}.\n` +
              `Install the worker manually from the release page instead.\n`,
          );
      }
      return reply.type(contentType).send(readFileSync(path, 'utf8'));
    };

    app.get('/install.ps1', async (_request, reply) =>
      serveScript('bootstrap.ps1', reply, 'text/plain; charset=utf-8'),
    );
    app.get('/install.sh', async (_request, reply) =>
      serveScript('bootstrap.sh', reply, 'text/x-shellscript; charset=utf-8'),
    );

    // The msdb setup a DBA runs. Served from here for the same reason the
    // worker package is: a SQL host can reach the control plane and usually
    // cannot reach GitHub, and the dashboard links to these at the moment it
    // tells someone an edit is unavailable without them.
    app.get('/sql/worker-permissions.sql', async (_request, reply) =>
      serveScript('worker-permissions.sql', reply, 'text/plain; charset=utf-8'),
    );
    app.get('/sql/worker-write-wrapper.sql', async (_request, reply) =>
      serveScript('worker-write-wrapper.sql', reply, 'text/plain; charset=utf-8'),
    );

    await app.register(fastifyStatic, {
      root: packageDir,
      prefix: '/downloads/',
      decorateReply: false,
      // No directory listing: the package names are in the install command, and
      // an index only invites poking at whatever else lands in this directory.
      index: false,
      list: false,
    });
  }

  // -------------------------------------------------------------------------
  // Dashboard static assets
  // -------------------------------------------------------------------------

  if (config.dashboardDir) {
    // Wildcard rather than an enumerated file list: the asset filenames are
    // content-hashed, and enumerating at startup means a rebuilt dashboard 404s
    // until the process is restarted.
    await app.register(fastifyStatic, { root: config.dashboardDir });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.url.startsWith('/api') ||
        request.url.startsWith('/health') ||
        request.url.startsWith('/readyz') ||
        request.url.startsWith('/metrics')
      ) {
        return reply.status(404).send({ error: 'NotFound' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', ' ');
}

/**
 * Where a worker should dial.
 *
 * Derived from the dashboard's public URL rather than the bind address:
 * `0.0.0.0` is what the process listens on, and pasting it into an install
 * command on a SQL host produces a worker that connects to itself.
 *
 * The derivation assumes the hub is reachable on the public URL's host at the
 * port the process bound, which holds for the Compose deployment and stops
 * holding the moment something maps ports or gives the hub its own name —
 * hence RSAGENT_HUB_ADVERTISED_ADDRESS.
 */
export function hubAddress(config: ServerConfig): string {
  if (config.hubAdvertisedAddress) return config.hubAdvertisedAddress;
  const host = (() => {
    try {
      return new URL(config.publicUrl).hostname;
    } catch {
      return config.grpcHost;
    }
  })();
  return `${host}:${config.grpcPort}`;
}

/**
 * Whether the installer can work out the package URL on its own.
 *
 * Both bootstrap scripts strip the port off `--control-plane` and fetch the
 * worker package from `https://<that host>/downloads/...`. That guess is only
 * right when the hub and the dashboard share a host and the dashboard is on
 * 443. Everywhere else the install has to be told, or it downloads from a host
 * that is not serving packages and the operator sees a 404 halfway through
 * installing on a production SQL host.
 */
function installerCanFindPackages(hubAddress: string, publicUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return false;
  }
  // Everything up to the last colon: the host half, with IPv6 brackets intact.
  const hubHost = hubAddress.slice(0, hubAddress.lastIndexOf(':'));
  const onDefaultHttpsPort = url.protocol === 'https:' && (url.port === '' || url.port === '443');
  return onDefaultHttpsPort && url.hostname === hubHost;
}

/**
 * The one-liner an admin pastes onto a SQL host.
 *
 * The token is a bearer credential with a short life, so these are shown once
 * in the browser and never stored anywhere they could be read again. Both
 * scripts install a service, enrol, and start — the admin then says which
 * instances to monitor from the dashboard, so nobody has to hand-edit YAML on
 * fifty boxes.
 */
export function installCommands(params: {
  token: string;
  hostName: string;
  hubAddress: string;
  publicUrl: string;
}): { windows: string; linux: string; manual: string } {
  const base = params.publicUrl.replace(/\/+$/u, '');

  // Spelled out only when the scripts cannot derive it, so the common one-liner
  // stays short enough to read before pasting it into an elevated prompt.
  const implicit = installerCanFindPackages(params.hubAddress, params.publicUrl);
  const windowsPackage = implicit
    ? ''
    : ` -PackageUrl '${base}/downloads/rsagent-worker-windows.zip'`;
  const linuxPackage = implicit
    ? ''
    : ` --package-url '${base}/downloads/rsagent-worker-linux.tar.gz'`;

  return {
    windows:
      `iwr ${base}/install.ps1 -UseBasicParsing | iex; ` +
      `Install-RsAgentWorker -ControlPlane '${params.hubAddress}' -Token '${params.token}'` +
      windowsPackage,
    linux:
      `curl -fsSL ${base}/install.sh | sudo bash -s -- ` +
      `--control-plane '${params.hubAddress}' --token '${params.token}'` +
      linuxPackage,
    manual:
      `rsagent enrol --control-plane ${params.hubAddress} ` +
      `--token ${params.token} /etc/rsagent/worker.yaml`,
  };
}
