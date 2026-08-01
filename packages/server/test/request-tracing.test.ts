import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPairSync } from 'node:crypto';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  NodeTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import type { Database } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/api/app.js';
import { CommandService } from '../src/domain/commands.js';
import { NotificationService } from '../src/domain/notifications/service.js';
import { EventBroker } from '../src/api/events.js';
import { WorkerRegistry } from '../src/hub/registry.js';
import { setupTestDatabase, truncateAll } from './helpers/db.js';

/** The Fastify `onRequest`/`onResponse`/`onError` span hooks in app.ts. */

let db: Database;
let close: () => Promise<void>;
const logger = pino({ level: 'silent' });
const exporter = new InMemorySpanExporter();

const config = loadConfig({
  RSAGENT_DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
  RSAGENT_GRPC_REQUIRE_TLS: 'false',
} as NodeJS.ProcessEnv);

const { privateKey } = generateKeyPairSync('ed25519');
const signingKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('request_tracing'));
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register();
});

afterAll(async () => {
  trace.disable();
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

afterEach(() => {
  exporter.reset();
});

async function buildApp() {
  const registry = new WorkerRegistry();
  const notifications = new NotificationService(db, config, logger);
  return createApp({
    db,
    config,
    logger,
    registry,
    entra: null,
    commands: new CommandService(db, config, registry, signingKeyPem, logger),
    notifications,
    events: new EventBroker(),
  });
}

describe('request spans', () => {
  it('records method, matched route, and status on a successful request', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);

    const span = exporter.getFinishedSpans().find((s) => s.name === 'GET /health');
    expect(span).toBeDefined();
    expect(span!.attributes['http.request.method']).toBe('GET');
    expect(span!.attributes['http.response.status_code']).toBe(200);
    expect(span!.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('names the span by route pattern, not the raw URL with an id in it', async () => {
    const app = await buildApp();
    // Unauthenticated, so this 401s before the handler runs — Fastify still
    // matches the route and sets routeOptions.url before preHandler denies
    // it, which is the part this test is checking.
    const res = await app.inject({
      method: 'GET',
      url: '/api/commands/33333333-3333-4333-8333-333333333333',
    });
    expect(res.statusCode).toBe(401);

    const span = exporter.getFinishedSpans().find((s) => s.name === 'GET /api/commands/:commandId');
    expect(span).toBeDefined();
  });

  it('marks the span an error on a 5xx response', async () => {
    // /health itself never 500s, so use a route that reaches the database and
    // point the app at one that immediately refuses connections.
    const brokenConfig = loadConfig({
      RSAGENT_DATABASE_URL: 'postgres://x:y@127.0.0.1:1/z',
      RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
      RSAGENT_GRPC_REQUIRE_TLS: 'false',
    } as NodeJS.ProcessEnv);
    const { createDatabase } = await import('../src/db/client.js');
    const broken = createDatabase(brokenConfig.databaseUrl);
    const registry = new WorkerRegistry();
    const app = await createApp({
      db: broken.db,
      config: brokenConfig,
      logger,
      registry,
      entra: null,
      commands: new CommandService(broken.db, brokenConfig, registry, signingKeyPem, logger),
      notifications: new NotificationService(broken.db, brokenConfig, logger),
      events: new EventBroker(),
    });

    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);

    const span = exporter.getFinishedSpans().find((s) => s.name === 'GET /metrics');
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    await broken.close();
  });
});
