import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import type { Logger } from 'pino';
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
import { queryAudit } from '../domain/audit.js';
import { diffJobDefinitions } from '../domain/diff.js';

export interface AppDeps {
  db: Database;
  config: ServerConfig;
  logger: Logger;
  registry: WorkerRegistry;
}

const uuidParam = z.object({ instanceId: z.string().uuid() });
const jobParams = z.object({ instanceId: z.string().uuid(), jobUuid: z.string().uuid() });

// The return type is inferred rather than annotated as FastifyInstance: passing
// a concrete pino Logger via `loggerInstance` specialises the instance type, and
// the generic FastifyInstance is not assignable to it.
export async function createApp(deps: AppDeps) {
  const { db, config, logger, registry } = deps;

  const app = Fastify({
    loggerInstance: logger.child({ component: 'api' }),
    trustProxy: true,
    bodyLimit: 4 * 1024 * 1024,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: 'ValidationError', detail: error.issues });
    }
    request.log.error({ err: error }, 'Unhandled API error');
    const status = error.statusCode ?? 500;
    // Never leak internals to the client; the log has the detail.
    return reply
      .status(status)
      .send({ error: status < 500 ? error.message : 'InternalServerError' });
  });

  // -------------------------------------------------------------------------
  // Health and metrics
  // -------------------------------------------------------------------------

  app.get('/health', async () => ({
    status: 'ok',
    version: '0.1.0',
    workersOnline: registry.size,
  }));

  app.get('/metrics', async (_request, reply) => {
    const estate = await getEstateOverview(db);
    const lines = [
      '# HELP rsagent_workers_online Number of workers with a live session.',
      '# TYPE rsagent_workers_online gauge',
      `rsagent_workers_online ${registry.size}`,
      '# HELP rsagent_instances_total Number of known SQL Server instances.',
      '# TYPE rsagent_instances_total gauge',
      `rsagent_instances_total ${estate.length}`,
      '# HELP rsagent_jobs_total Number of jobs mirrored per instance.',
      '# TYPE rsagent_jobs_total gauge',
      ...estate.map(
        (i) => `rsagent_jobs_total{instance="${escapeLabel(i.instanceName)}",host="${escapeLabel(i.hostName)}"} ${i.jobCount}`,
      ),
      '# HELP rsagent_jobs_failed_24h Jobs whose most recent run failed, last 24h.',
      '# TYPE rsagent_jobs_failed_24h gauge',
      ...estate.map(
        (i) => `rsagent_jobs_failed_24h{instance="${escapeLabel(i.instanceName)}",host="${escapeLabel(i.hostName)}"} ${i.failedLast24h}`,
      ),
      '# HELP rsagent_jobs_drifted Jobs whose newest version was an on-prem edit.',
      '# TYPE rsagent_jobs_drifted gauge',
      ...estate.map(
        (i) => `rsagent_jobs_drifted{instance="${escapeLabel(i.instanceName)}",host="${escapeLabel(i.hostName)}"} ${i.driftedJobs}`,
      ),
    ];
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });

  // -------------------------------------------------------------------------
  // Estate and instances (§9.1, §9.2)
  // -------------------------------------------------------------------------

  app.get('/api/estate', async () => ({ instances: await getEstateOverview(db) }));

  app.get('/api/instances/:instanceId', async (request, reply) => {
    const { instanceId } = uuidParam.parse(request.params);
    const instance = await getInstance(db, instanceId);
    if (!instance) return reply.status(404).send({ error: 'NotFound' });
    return {
      ...instance,
      workerOnline: registry.isOnline(instance.workerId),
    };
  });

  app.get('/api/instances/:instanceId/jobs', async (request) => {
    const { instanceId } = uuidParam.parse(request.params);
    const { includeDeleted } = z
      .object({ includeDeleted: z.coerce.boolean().optional() })
      .parse(request.query);
    return { jobs: await listJobs(db, instanceId, { includeDeleted }) };
  });

  app.get('/api/instances/:instanceId/agent-log', async (request) => {
    const { instanceId } = uuidParam.parse(request.params);
    const { limit } = z.object({ limit: z.coerce.number().int().positive().optional() }).parse(
      request.query,
    );
    return { entries: await getAgentLog(db, instanceId, limit ?? 200) };
  });

  // -------------------------------------------------------------------------
  // Job detail, history, versions (§9.3)
  // -------------------------------------------------------------------------

  app.get('/api/instances/:instanceId/jobs/:jobUuid', async (request, reply) => {
    const { instanceId, jobUuid } = jobParams.parse(request.params);
    const job = await getJob(db, instanceId, jobUuid);
    if (!job) return reply.status(404).send({ error: 'NotFound' });
    return job;
  });

  app.get('/api/instances/:instanceId/jobs/:jobUuid/history', async (request) => {
    const { instanceId, jobUuid } = jobParams.parse(request.params);
    const { limit } = z.object({ limit: z.coerce.number().int().positive().optional() }).parse(
      request.query,
    );
    return { runs: await getJobHistory(db, instanceId, jobUuid, limit ?? 50) };
  });

  app.get('/api/instances/:instanceId/jobs/:jobUuid/versions', async (request) => {
    const { instanceId, jobUuid } = jobParams.parse(request.params);
    const versions = await getJobVersions(db, instanceId, jobUuid);
    // The list view only needs metadata; definitions are fetched per version.
    return {
      versions: versions.map(({ definition: _definition, ...v }) => v),
    };
  });

  app.get('/api/instances/:instanceId/jobs/:jobUuid/versions/:versionNo', async (request, reply) => {
    const { instanceId, jobUuid } = jobParams.parse(request.params);
    const { versionNo } = z
      .object({ versionNo: z.coerce.number().int().positive() })
      .parse(request.params);
    const version = await getJobVersion(db, instanceId, jobUuid, versionNo);
    if (!version) return reply.status(404).send({ error: 'NotFound' });
    return version;
  });

  /** Structured diff between two versions, for the Versions tab (§7.2). */
  app.get('/api/instances/:instanceId/jobs/:jobUuid/diff', async (request, reply) => {
    const { instanceId, jobUuid } = jobParams.parse(request.params);
    const { from, to } = z
      .object({ from: z.coerce.number().int().positive(), to: z.coerce.number().int().positive() })
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
  });

  app.post('/api/instances/:instanceId/jobs/:jobUuid/acknowledge-drift', async (request) => {
    const { instanceId, jobUuid } = jobParams.parse(request.params);
    await acknowledgeDrift(db, instanceId, jobUuid);
    return { acknowledged: true };
  });

  // -------------------------------------------------------------------------
  // Cross-estate search (§9.5)
  // -------------------------------------------------------------------------

  app.get('/api/search', async (request) => {
    const { q, limit } = z
      .object({
        q: z.string().min(2, 'Search needs at least two characters'),
        limit: z.coerce.number().int().positive().optional(),
      })
      .parse(request.query);
    return { query: q, hits: await searchJobs(db, q, { limit }) };
  });

  // -------------------------------------------------------------------------
  // Admin (§9.7)
  // -------------------------------------------------------------------------

  app.get('/api/workers', async () => {
    const rows = await listWorkers(db);
    return { workers: rows.map((w) => ({ ...w, online: registry.isOnline(w.id) })) };
  });

  app.get('/api/audit', async (request) => {
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
  // Dashboard static assets
  // -------------------------------------------------------------------------

  if (config.dashboardDir) {
    await app.register(fastifyStatic, { root: config.dashboardDir, wildcard: false });
    // SPA fallback: any non-API path serves index.html so client routing works
    // on a hard refresh.
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
