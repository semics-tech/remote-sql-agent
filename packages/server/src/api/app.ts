import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyRequest,
} from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { Logger } from 'pino';
import { ROLES, ROLE_PERMISSIONS, isCapability, type Role } from '@remote-sql-agent/protocol';
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
import { requirePermission, actorOf } from '../auth/rbac.js';
import { registerAuthRoutes } from '../auth/routes.js';
import type { EntraClient } from '../auth/entra.js';
import { createLocalUser, listUsers, setUserDisabled, setUserRole } from '../auth/users.js';
import {
  createEnrolmentToken,
  listCredentials,
  revokeCredential,
  rotateWorkerKey,
} from '../worker-auth/enrolment.js';
import { eq } from 'drizzle-orm';
import { commandState, workers } from '../db/schema.js';
import {
  CommandError,
  prepareJobDefinition,
  type CommandService,
} from '../domain/commands.js';

export interface AppDeps {
  db: Database;
  config: ServerConfig;
  logger: Logger;
  registry: WorkerRegistry;
  entra: EntraClient | null;
  commands: CommandService;
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

  // Widened to FastifyBaseLogger on purpose: passing a concrete pino Logger
  // specialises the whole FastifyInstance type and makes it incompatible with
  // any helper that accepts a plain FastifyInstance.
  const app = Fastify({
    loggerInstance: logger.child({ component: 'api' }) as FastifyBaseLogger,
    trustProxy: true,
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
    if (error instanceof CommandError) {
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
  // Health and metrics
  //
  // Unauthenticated on purpose: these are scraped by infrastructure that has no
  // session. Neither exposes job content — only counts.
  // -------------------------------------------------------------------------

  app.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    workersOnline: registry.size,
  }));

  app.get('/metrics', async (_request, reply) => {
    const estate = await getEstateOverview(db);
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
    { preHandler: guard('job.toggle') },
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
      return {
        hostName,
        workerCapabilities: capabilities,
        yourPermissions: request.user ? ROLE_PERMISSIONS[request.user.role] : [],
        approvalRequiredForJobWrite: config.requireApprovalForJobWrite,
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
      'issuedBy' | 'issuedByUsername' | 'remoteAddress'
    >,
  ) =>
    deps.commands.create({
      ...input,
      issuedBy: request.user!.id,
      issuedByUsername: request.user!.username,
      remoteAddress: request.ip,
    });

  app.post(
    '/api/instances/:instanceId/jobs/:jobUuid/toggle',
    { preHandler: guard('job.toggle') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const { enabled, baseDefinitionHash } = z
        .object({ enabled: z.boolean(), baseDefinitionHash: z.string().optional() })
        .parse(request.body);

      return issue(request, {
        instanceId,
        kind: 'toggleJob',
        jobUuid,
        payload: { jobUuid, enabled, baseDefinitionHash: baseDefinitionHash ?? '' },
        baseDefinitionHash: baseDefinitionHash ?? null,
      });
    },
  );

  app.post(
    '/api/instances/:instanceId/jobs/:jobUuid/run',
    { preHandler: guard('job.run') },
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
    { preHandler: guard('job.run') },
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
    { preHandler: guard('job.write') },
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

      return issue(request, {
        instanceId,
        kind: 'upsertJob',
        jobUuid: jobUuid === 'new' ? null : jobUuid,
        payload: {
          jobUuid: jobUuid === 'new' ? '' : jobUuid,
          canonicalJson,
          baseDefinitionHash: body.baseDefinitionHash ?? '',
          allowOverwrite: body.allowOverwrite === true,
        },
        baseDefinitionHash: body.baseDefinitionHash ?? null,
      });
    },
  );

  app.delete(
    '/api/instances/:instanceId/jobs/:jobUuid',
    { preHandler: guard('job.write') },
    async (request) => {
      const { instanceId, jobUuid } = jobParams.parse(request.params);
      const { baseDefinitionHash } = z
        .object({ baseDefinitionHash: z.string().optional() })
        .parse(request.body ?? {});

      return issue(request, {
        instanceId,
        kind: 'deleteJob',
        jobUuid,
        payload: { jobUuid, baseDefinitionHash: baseDefinitionHash ?? '' },
        baseDefinitionHash: baseDefinitionHash ?? null,
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

  app.post('/api/commands/:commandId/approve', { preHandler: guard('command.approve') }, async (request) => {
    const { commandId } = z.object({ commandId: z.string().uuid() }).parse(request.params);
    await deps.commands.approve(commandId, request.user!.id, request.user!.username, request.ip);
    return { approved: true };
  });

  app.post('/api/commands/:commandId/reject', { preHandler: guard('command.approve') }, async (request) => {
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
      note: 'Single use. Copy it now — it is not shown again.',
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
  // Dashboard static assets
  // -------------------------------------------------------------------------

  if (config.dashboardDir) {
    // Wildcard rather than an enumerated file list: the asset filenames are
    // content-hashed, and enumerating at startup means a rebuilt dashboard 404s
    // until the process is restarted.
    await app.register(fastifyStatic, { root: config.dashboardDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/health')) {
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
