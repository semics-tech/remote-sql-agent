import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPairSync } from 'node:crypto';
import type { Database } from '../src/db/client.js';
import { createDatabase } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/api/app.js';
import { CommandService } from '../src/domain/commands.js';
import { NotificationService } from '../src/domain/notifications/service.js';
import { EventBroker } from '../src/api/events.js';
import { WorkerRegistry } from '../src/hub/registry.js';
import { setupTestDatabase } from './helpers/db.js';

/**
 * `/health`, `/readyz` and `/metrics` — the routes infrastructure scrapes with
 * no session.
 *
 * `/health` used to hardcode a version that drifted from the real one and to
 * be wired as the k8s readiness probe despite never touching the database, so
 * a Postgres outage still reported ready. `/readyz` is the fix: it is the one
 * that actually answers "can this instance serve traffic".
 */

const packageVersion = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
  ) as { version: string }
).version;

const logger = pino({ level: 'silent' });
const { privateKey } = generateKeyPairSync('ed25519');
const signingKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('health_metrics'));
});

afterAll(async () => {
  await close();
});

function config(env: Record<string, string> = {}) {
  return loadConfig({
    RSAGENT_DATABASE_URL: 'postgres://x:y@localhost:5432/z',
    RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
    RSAGENT_GRPC_REQUIRE_TLS: 'false',
    ...env,
  } as NodeJS.ProcessEnv);
}

async function buildApp(database: Database, cfg: ReturnType<typeof config>) {
  const registry = new WorkerRegistry();
  const notifications = new NotificationService(database, cfg, logger);
  return createApp({
    db: database,
    config: cfg,
    logger,
    registry,
    entra: null,
    commands: new CommandService(database, cfg, registry, signingKeyPem, logger),
    notifications,
    events: new EventBroker(),
  });
}

describe('/health', () => {
  it('reports the real package version, not a hardcoded one', async () => {
    const server = await buildApp(db, config());
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      expect(response.json().version).toBe(packageVersion);
    } finally {
      await server.close();
    }
  });

  it('reports ok even when the database is unreachable', async () => {
    const { db: brokenDb, close: closeBroken } = createDatabase(
      'postgres://x:y@localhost:1/z',
    );
    const server = await buildApp(brokenDb, config());
    try {
      const response = await server.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
    } finally {
      await server.close();
      await closeBroken();
    }
  });
});

describe('/readyz', () => {
  it('answers ok when the database is reachable', async () => {
    const server = await buildApp(db, config());
    try {
      const response = await server.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    } finally {
      await server.close();
    }
  });

  it('answers 503 when the database is unreachable — the bug /health could not catch', async () => {
    const { db: brokenDb, close: closeBroken } = createDatabase(
      'postgres://x:y@localhost:1/z',
    );
    const server = await buildApp(brokenDb, config());
    try {
      const response = await server.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
    } finally {
      await server.close();
      await closeBroken();
    }
  });
});

describe('/metrics', () => {
  it('serves without a token when none is configured', async () => {
    const server = await buildApp(db, config());
    try {
      const response = await server.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('rsagent_workers_online');
    } finally {
      await server.close();
    }
  });

  it('refuses without the bearer token once one is configured', async () => {
    const server = await buildApp(db, config({ RSAGENT_METRICS_TOKEN: 'secret-token' }));
    try {
      const noAuth = await server.inject({ method: 'GET', url: '/metrics' });
      expect(noAuth.statusCode).toBe(401);

      const wrongAuth = await server.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer wrong' },
      });
      expect(wrongAuth.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('serves with the correct bearer token', async () => {
    const server = await buildApp(db, config({ RSAGENT_METRICS_TOKEN: 'secret-token' }));
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer secret-token' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('rsagent_workers_online');
    } finally {
      await server.close();
    }
  });
});
