import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPairSync } from 'node:crypto';
import type { JobDefinition } from '@remote-sql-agent/protocol';
import type { Database } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/api/app.js';
import { CommandService } from '../src/domain/commands.js';
import { NotificationService } from '../src/domain/notifications/service.js';
import { EventBroker } from '../src/api/events.js';
import { WorkerRegistry } from '../src/hub/registry.js';
import { jobs, users } from '../src/db/schema.js';
import { createSession, CSRF_HEADER, SESSION_COOKIE } from '../src/auth/sessions.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';

/**
 * The conflict gate on the write path.
 *
 * The worker reads an empty `baseDefinitionHash` as "create — nothing to
 * conflict with". That made the whole drift check opt-out: a client that simply
 * omitted the field overwrote an unacknowledged on-prem edit, and never had to
 * set `allowOverwrite`, the flag whose entire job is to make that deliberate.
 *
 * These tests are about what the *API* refuses, so no SQL Server and no worker
 * are involved — a refusal has to happen before a command is ever enqueued.
 */

let db: Database;
let close: () => Promise<void>;
const logger = pino({ level: 'silent' });

const config = loadConfig({
  RSAGENT_DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
  RSAGENT_GRPC_REQUIRE_TLS: 'false',
} as NodeJS.ProcessEnv);

const { privateKey } = generateKeyPairSync('ed25519');
const signingKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const JOB_UUID = '33333333-3333-4333-8333-333333333333';
const CURRENT_HASH = 'sha256:current';

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('job_write_conflict'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function buildApp() {
  const registry = new WorkerRegistry();
  return createApp({
    db,
    config,
    logger,
    registry,
    entra: null,
    commands: new CommandService(db, config, registry, signingKeyPem, logger),
    notifications: new NotificationService(db, config, logger),
    events: new EventBroker(),
  });
}

/** An Admin, and one job the control plane already holds a definition for. */
async function estate() {
  const { instanceId } = await seedInstance(db);
  await db.insert(jobs).values({
    instanceId,
    jobUuid: JOB_UUID,
    name: 'Nightly Backup',
    currentDefinitionHash: CURRENT_HASH,
  });

  const [user] = await db
    .insert(users)
    .values({ username: 'admin', role: 'Admin' })
    .returning({ id: users.id });
  const session = await createSession(db, user!.id, 1, null);

  return {
    instanceId,
    headers: { cookie: `${SESSION_COOKIE}=${session.token}`, [CSRF_HEADER]: session.csrfToken },
  };
}

const DEFINITION: JobDefinition = {
  schemaVersion: 'JobDefinition.v1',
  name: 'Nightly Backup',
  description: null,
  enabled: true,
  categoryName: 'Maintenance',
  ownerLoginName: 'sa',
  startStepId: 1,
  notifications: {
    emailOperatorName: null,
    emailLevel: 0,
    netsendOperatorName: null,
    netsendLevel: 0,
    pageOperatorName: null,
    pageLevel: 0,
    eventlogLevel: 2,
    deleteLevel: 0,
  },
  steps: [
    {
      stepId: 1,
      name: 'Backup',
      subsystem: 'TSQL',
      command: 'BACKUP DATABASE [x] TO DISK = N\'x.bak\';',
      databaseName: 'master',
      databaseUserName: null,
      onSuccessAction: 1,
      onSuccessStepId: 0,
      onFailAction: 2,
      onFailStepId: 0,
      retryAttempts: 0,
      retryIntervalMinutes: 0,
      outputFileName: null,
      flags: 0,
      proxyName: null,
    },
  ],
  schedules: [],
  targetServers: [],
};

/**
 * Did the request get past the conflict gate?
 *
 * Deliberately not "did it return 2xx". A write also passes through the worker
 * capability gate, which answers 403 `CapabilityDenied` whenever no worker is
 * connected — so asserting success would make every one of these pass for a
 * reason that has nothing to do with the gate under test, and would keep
 * passing if the gate were removed entirely.
 */
function passedConflictGate(response: { statusCode: number; body: string }): boolean {
  if (response.statusCode !== 400 && response.statusCode !== 409) return true;
  try {
    const error = (JSON.parse(response.body) as { error?: string }).error;
    return error !== 'BaseHashRequired' && error !== 'Conflict';
  } catch {
    return true;
  }
}

describe('changing an existing job without saying what it was based on', () => {
  /**
   * The three write routes that carry a base hash. Each is one route an
   * operator can reach, and each was independently bypassable.
   */
  const ROUTES = [
    {
      name: 'save a definition',
      method: 'PUT' as const,
      path: (i: string) => `/api/instances/${i}/jobs/${JOB_UUID}`,
      body: { definition: DEFINITION },
    },
    {
      name: 'toggle enabled',
      method: 'POST' as const,
      path: (i: string) => `/api/instances/${i}/jobs/${JOB_UUID}/toggle`,
      body: { enabled: false },
    },
    {
      name: 'delete the job',
      method: 'DELETE' as const,
      path: (i: string) => `/api/instances/${i}/jobs/${JOB_UUID}`,
      body: {},
    },
  ];

  it.each(ROUTES)('is refused with 400: $name', async (route) => {
    const app = await buildApp();
    try {
      const { instanceId, headers } = await estate();
      const response = await app.inject({
        method: route.method,
        url: route.path(instanceId),
        headers,
        payload: route.body,
      });

      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toBe('BaseHashRequired');
    } finally {
      await app.close();
    }
  });

  it.each(ROUTES)('is accepted when the hash matches: $name', async (route) => {
    const app = await buildApp();
    try {
      const { instanceId, headers } = await estate();
      const response = await app.inject({
        method: route.method,
        url: route.path(instanceId),
        headers,
        payload: { ...route.body, baseDefinitionHash: CURRENT_HASH },
      });

      expect(passedConflictGate(response), response.body).toBe(true);
    } finally {
      await app.close();
    }
  });

  it.each(ROUTES)('is refused with 409 when the hash is stale: $name', async (route) => {
    const app = await buildApp();
    try {
      const { instanceId, headers } = await estate();
      const response = await app.inject({
        method: route.method,
        url: route.path(instanceId),
        headers,
        payload: { ...route.body, baseDefinitionHash: 'sha256:what-the-editor-loaded' },
      });

      // Answered here rather than after a round trip to the SQL host. The
      // control plane holds the authoritative hash, so a stale editor is
      // knowable without dispatching anything.
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toBe('Conflict');
    } finally {
      await app.close();
    }
  });

  it.each(ROUTES)('is accepted with a stale hash and allowOverwrite: $name', async (route) => {
    const app = await buildApp();
    try {
      const { instanceId, headers } = await estate();
      const response = await app.inject({
        method: route.method,
        url: route.path(instanceId),
        headers,
        payload: { ...route.body, baseDefinitionHash: 'sha256:stale', allowOverwrite: true },
      });

      // The escape hatch still works — it just has to be asked for now.
      expect(passedConflictGate(response), response.body).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('creating a job', () => {
  it('needs no base hash, because there is nothing to conflict with', async () => {
    const app = await buildApp();
    try {
      const { instanceId, headers } = await estate();
      const response = await app.inject({
        method: 'PUT',
        url: `/api/instances/${instanceId}/jobs/new`,
        headers,
        payload: { definition: DEFINITION },
      });

      expect(passedConflictGate(response), response.body).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('accepts a job the control plane has never seen a definition for', async () => {
    const app = await buildApp();
    try {
      const { instanceId, headers } = await estate();
      // Ingestion has produced a row but no definition yet — there is nothing
      // to compare against, so the supplied hash is passed to the worker, which
      // does the real check on the SQL host.
      await db.insert(jobs).values({
        instanceId,
        jobUuid: '44444444-4444-4444-8444-444444444444',
        name: 'Never Versioned',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/instances/${instanceId}/jobs/44444444-4444-4444-8444-444444444444/toggle`,
        headers,
        payload: { enabled: false, baseDefinitionHash: 'sha256:whatever-the-client-had' },
      });

      expect(passedConflictGate(response), response.body).toBe(true);
    } finally {
      await app.close();
    }
  });
});
