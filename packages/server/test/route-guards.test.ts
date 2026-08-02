import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPairSync } from 'node:crypto';
import type { Role } from '@remote-sql-agent/protocol';
import type { Database } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/api/app.js';
import { CommandService } from '../src/domain/commands.js';
import { NotificationService } from '../src/domain/notifications/service.js';
import { EventBroker } from '../src/api/events.js';
import { WorkerRegistry } from '../src/hub/registry.js';
import { environmentGrants, instances, jobs, users } from '../src/db/schema.js';
import { createSession, CSRF_HEADER, SESSION_COOKIE } from '../src/auth/sessions.js';
import { membershipKey } from '../src/auth/environments.js';
import { setupTestDatabase, seedInstance, tagInstance, truncateAll } from './helpers/db.js';

/**
 * The real routes, behind the real `createApp`.
 *
 * environment-guard.test.ts proves the guard decides correctly, but it does so
 * on throwaway routes — which leaves the question this file answers: is each
 * *actual* route wired to the guard it should be? That is a per-route fact, it
 * is invisible to every other test, and getting it wrong in either direction is
 * a security bug. A write route left on `requirePermission` silently ignores
 * every grant; an estate-wide route moved to `requireInstancePermission` lets a
 * production grant reach user administration.
 *
 * No SQL Server is needed: the write routes only *enqueue* a command. Nothing
 * in the control plane dials a database on this path — the worker applies it,
 * which is the whole design.
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

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('route_guards'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
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

const PROD_GROUP = '11111111-2222-3333-4444-555555555555';
const JOB_UUID = '22222222-2222-4222-8222-222222222222';

async function seedUser(role: Role, identityGroups: string[] = []): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ username: `u-${role}-${identityGroups.length}`, role, identityGroups })
    .returning({ id: users.id });
  return row!.id;
}

async function signIn(userId: string) {
  const session = await createSession(db, userId, 1, null);
  return { cookie: `${SESSION_COOKIE}=${session.token}`, csrf: session.csrfToken };
}

/**
 * A production instance with one job on it, plus a Viewer holding an Editor
 * grant on production and nothing else.
 */
async function productionEstate() {
  const { instanceId } = await seedInstance(db);
  await tagInstance(db, instanceId, 'production');
  await db.insert(jobs).values({ instanceId, jobUuid: JOB_UUID, name: 'Nightly Backup' });

  const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
  await db.insert(environmentGrants).values({
    subjectKind: 'entra_group',
    subjectKey: PROD_GROUP,
    environmentTag: 'production',
    role: 'Editor',
  });

  return { instanceId, userId };
}

/**
 * Every write and execute route, and the permission each needs.
 *
 * A route added to the write path without being added here is a route nobody
 * has checked the guard on.
 */
const WRITE_ROUTES = (instanceId: string) => [
  {
    name: 'toggle a job',
    method: 'POST' as const,
    url: `/api/instances/${instanceId}/jobs/${JOB_UUID}/toggle`,
    payload: { enabled: false },
  },
  {
    name: 'run a job',
    method: 'POST' as const,
    url: `/api/instances/${instanceId}/jobs/${JOB_UUID}/run`,
    payload: {},
  },
  {
    name: 'stop a job',
    method: 'POST' as const,
    url: `/api/instances/${instanceId}/jobs/${JOB_UUID}/stop`,
    payload: {},
  },
  {
    name: 'acknowledge drift',
    method: 'POST' as const,
    url: `/api/instances/${instanceId}/jobs/${JOB_UUID}/acknowledge-drift`,
    payload: {},
  },
  {
    name: 'allow central writes',
    method: 'POST' as const,
    url: `/api/instances/${instanceId}/jobs/${JOB_UUID}/write-allowed`,
    payload: { allowed: true },
  },
  {
    name: 'delete a job',
    method: 'DELETE' as const,
    url: `/api/instances/${instanceId}/jobs/${JOB_UUID}`,
    payload: {},
  },
];

/** The error codes only the RBAC guard produces. */
const AUTHORISATION_ERRORS = new Set(['Unauthenticated', 'Forbidden', 'CsrfFailed']);

/**
 * Was this refused by *authorisation*, as opposed to anything downstream?
 *
 * The status code alone cannot answer it. This product has two gates on every
 * write — what the user may ask for, and what the worker will accept — and the
 * second also answers 403, with `CapabilityDenied`. Treating any 403 as an
 * authorisation refusal makes these tests pass for the wrong reason: a route
 * accidentally left wide open would still look "refused" because no worker is
 * connected to accept the command.
 */
function refusedByAuthorisation(response: { statusCode: number; body: string }): boolean {
  if (response.statusCode !== 401 && response.statusCode !== 403) return false;
  try {
    return AUTHORISATION_ERRORS.has((JSON.parse(response.body) as { error?: string }).error ?? '');
  } catch {
    return true;
  }
}

describe('write and execute routes consult environment grants', () => {
  it.each(WRITE_ROUTES('PLACEHOLDER').map((r) => r.name))('lets a production grant through: %s', async (name) => {
    const app = await buildApp();
    try {
      const { instanceId, userId } = await productionEstate();
      const route = WRITE_ROUTES(instanceId).find((r) => r.name === name)!;
      const auth = await signIn(userId);

      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
        payload: route.payload,
      });

      // Past the guard. The command is then refused further down, because no
      // worker is connected and none holds the job.write capability — but that
      // is the second gate, not authorisation.
      expect(refusedByAuthorisation(response), `${name} was refused: ${response.body}`).toBe(false);
    } finally {
      await app.close();
    }
  });

  it.each(WRITE_ROUTES('PLACEHOLDER').map((r) => r.name))('refuses a bare Viewer: %s', async (name) => {
    const app = await buildApp();
    try {
      const { instanceId } = await productionEstate();
      // Same estate, but this user holds no grant at all.
      const auth = await signIn(await seedUser('Viewer'));
      const route = WRITE_ROUTES(instanceId).find((r) => r.name === name)!;

      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
        payload: route.payload,
      });

      expect(refusedByAuthorisation(response)).toBe(true);
      expect(response.json().error).toBe('Forbidden');
    } finally {
      await app.close();
    }
  });
});

describe('estate-wide routes stay on the base role', () => {
  /**
   * These must not be reachable by a grant, however privileged. A grant that
   * confers user administration is a grant that can write more grants, and is
   * therefore self-extending.
   */
  const ESTATE_ROUTES = [
    { name: 'list users', method: 'GET' as const, url: '/api/users' },
    { name: 'list workers', method: 'GET' as const, url: '/api/workers' },
    { name: 'read the audit log', method: 'GET' as const, url: '/api/audit' },
    { name: 'list environment grants', method: 'GET' as const, url: '/api/environment-grants' },
  ];

  it.each(ESTATE_ROUTES)('refuses an Admin grant on every environment: $name', async (route) => {
    const app = await buildApp();
    try {
      await seedInstance(db);
      const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
      await db.insert(environmentGrants).values({
        subjectKind: 'entra_group',
        subjectKey: PROD_GROUP,
        environmentTag: '*',
        role: 'Admin',
      });
      const auth = await signIn(userId);

      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it.each(ESTATE_ROUTES)('admits a base-role Admin: $name', async (route) => {
    const app = await buildApp();
    try {
      const auth = await signIn(await seedUser('Admin'));
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('history-scrubbing config stays on the base role', () => {
  it('refuses an environment-Admin grant', async () => {
    const app = await buildApp();
    try {
      const { workerId } = await seedInstance(db);
      const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
      await db.insert(environmentGrants).values({
        subjectKind: 'entra_group',
        subjectKey: PROD_GROUP,
        environmentTag: '*',
        role: 'Admin',
      });
      const auth = await signIn(userId);

      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/workers/${workerId}/history-scrubbing`,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
      });
      expect(getResponse.statusCode).toBe(403);

      const putResponse = await app.inject({
        method: 'PUT',
        url: `/api/workers/${workerId}/history-scrubbing`,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
        payload: { rules: [] },
      });
      expect(putResponse.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('admits a base-role Admin and persists the config', async () => {
    const app = await buildApp();
    try {
      const { workerId } = await seedInstance(db);
      const auth = await signIn(await seedUser('Admin'));

      const putResponse = await app.inject({
        method: 'PUT',
        url: `/api/workers/${workerId}/history-scrubbing`,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
        payload: { rules: [{ id: 'r1', description: 'no passwords', pattern: 'Password=\\S+' }] },
      });
      expect(putResponse.statusCode).toBe(200);

      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/workers/${workerId}/history-scrubbing`,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json()).toEqual({
        rules: [{ id: 'r1', description: 'no passwords', pattern: 'Password=\\S+' }],
      });
    } finally {
      await app.close();
    }
  });
});

describe('log-scrubbing config stays on the base role', () => {
  it('refuses an environment-Admin grant', async () => {
    const app = await buildApp();
    try {
      const { workerId } = await seedInstance(db);
      const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
      await db.insert(environmentGrants).values({
        subjectKind: 'entra_group',
        subjectKey: PROD_GROUP,
        environmentTag: '*',
        role: 'Admin',
      });
      const auth = await signIn(userId);

      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/workers/${workerId}/log-scrubbing`,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
      });
      expect(getResponse.statusCode).toBe(403);

      const putResponse = await app.inject({
        method: 'PUT',
        url: `/api/workers/${workerId}/log-scrubbing`,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
        payload: { allowedSeverities: [], rules: [] },
      });
      expect(putResponse.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('admits a base-role Admin and persists the config', async () => {
    const app = await buildApp();
    try {
      const { workerId } = await seedInstance(db);
      const auth = await signIn(await seedUser('Admin'));

      const putResponse = await app.inject({
        method: 'PUT',
        url: `/api/workers/${workerId}/log-scrubbing`,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
        payload: {
          allowedSeverities: ['error'],
          rules: [{ id: 'r1', description: 'no backups', pattern: 'backup', action: 'drop' }],
        },
      });
      expect(putResponse.statusCode).toBe(200);

      const getResponse = await app.inject({
        method: 'GET',
        url: `/api/workers/${workerId}/log-scrubbing`,
        headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json()).toEqual({
        allowedSeverities: ['error'],
        rules: [{ id: 'r1', description: 'no backups', pattern: 'backup', action: 'drop' }],
      });
    } finally {
      await app.close();
    }
  });
});

describe('reads stay estate-wide', () => {
  it('lets a Viewer read a job in an environment they hold no grant for', async () => {
    const app = await buildApp();
    try {
      const { instanceId } = await productionEstate();
      const auth = await signIn(await seedUser('Viewer'));

      // The design says grants add and never subtract, so nothing here hides
      // an instance. If this ever starts returning 403, reads have quietly
      // acquired a scoping dimension and docs/security.md is wrong.
      const response = await app.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/jobs/${JOB_UUID}`,
        headers: { cookie: auth.cookie },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('what the dashboard is told about an instance', () => {
  it('reports the permissions held in that instance\'s environment', async () => {
    const app = await buildApp();
    try {
      const { instanceId, userId } = await productionEstate();
      const auth = await signIn(userId);

      const response = await app.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/capabilities`,
        headers: { cookie: auth.cookie },
      });
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.environmentTag).toBe('production');
      // Editor here, via the grant — not the bare Viewer base role. Returning
      // the base role would grey out controls that in fact work.
      expect(body.yourPermissions).toContain('job.write');
    } finally {
      await app.close();
    }
  });

  it('does not claim job.write on an instance the grant does not reach', async () => {
    const app = await buildApp();
    try {
      const { userId } = await productionEstate();
      const [uat] = await db
        .select({ workerId: instances.workerId })
        .from(instances)
        .limit(1);
      const [other] = await db
        .insert(instances)
        .values({ workerId: uat!.workerId, instanceName: 'UAT1' })
        .returning({ id: instances.id });
      await tagInstance(db, other!.id, 'uat');
      const auth = await signIn(userId);

      const response = await app.inject({
        method: 'GET',
        url: `/api/instances/${other!.id}/capabilities`,
        headers: { cookie: auth.cookie },
      });

      const body = response.json();
      expect(body.environmentTag).toBe('uat');
      expect(body.yourPermissions).not.toContain('job.write');
      // Reads are still there: the SPA must not grey out the UAT job page.
      expect(body.yourPermissions).toContain('job.read');
    } finally {
      await app.close();
    }
  });
});

describe('tagging an instance the way the product does', () => {
  /**
   * The gap every other test in this feature had.
   *
   * They all set the tag with a direct `db.update`, and the product writes it
   * somewhere else entirely — so the guard was read against a value nothing
   * produced, and the whole feature shipped inert while 54 tests passed. This is
   * the only test that goes through the tagging route an administrator uses, and
   * it is the one that fails if the two ever part company again.
   */
  async function tagViaApi(
    app: Awaited<ReturnType<typeof buildApp>>,
    workerId: string,
    tag: string,
  ): Promise<{ cookie: string; csrf: string }> {
    const admin = await signIn(await seedUser('Admin'));
    const response = await app.inject({
      method: 'PUT',
      url: `/api/workers/${workerId}/instance-configs`,
      headers: { cookie: admin.cookie, [CSRF_HEADER]: admin.csrf },
      payload: {
        instanceName: 'MSSQLSERVER',
        serverAddress: 'localhost',
        authMode: 'integrated',
        environmentTag: tag,
      },
    });
    expect(response.statusCode, response.body).toBeLessThan(300);
    return admin;
  }

  it('lets a grant on that tag reach the instance', async () => {
    const app = await buildApp();
    try {
      const { instanceId, workerId } = await seedInstance(db);
      await db.insert(jobs).values({ instanceId, jobUuid: JOB_UUID, name: 'Nightly Backup' });
      const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
      await db.insert(environmentGrants).values({
        subjectKind: 'entra_group',
        subjectKey: PROD_GROUP,
        environmentTag: 'production',
        role: 'Editor',
      });
      const auth = await signIn(userId);

      const toggle = () =>
        app.inject({
          method: 'POST',
          url: `/api/instances/${instanceId}/jobs/${JOB_UUID}/toggle`,
          headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
          payload: { enabled: false },
        });

      // Untagged, so the grant cannot reach it and only the base role applies.
      expect(refusedByAuthorisation(await toggle())).toBe(true);

      await tagViaApi(app, workerId, 'production');

      const after = await toggle();
      expect(refusedByAuthorisation(after), `still refused: ${after.body}`).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('reports the tag it was given, case-folded, on the capabilities route', async () => {
    const app = await buildApp();
    try {
      const { instanceId, workerId } = await seedInstance(db);
      // Typed with a capital by an administrator; compared lowercase everywhere.
      await tagViaApi(app, workerId, 'Production');
      const auth = await signIn(await seedUser('Viewer'));

      const response = await app.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/capabilities`,
        headers: { cookie: auth.cookie },
      });
      expect(response.json().environmentTag).toBe('production');
    } finally {
      await app.close();
    }
  });

  it('treats a blank tag as untagged rather than as a tag nothing matches', async () => {
    const app = await buildApp();
    try {
      const { instanceId, workerId } = await seedInstance(db);
      const admin = await tagViaApi(app, workerId, '   ');
      const auth = await signIn(await seedUser('Viewer'));

      const response = await app.inject({
        method: 'GET',
        url: `/api/instances/${instanceId}/capabilities`,
        headers: { cookie: auth.cookie },
      });
      expect(response.json().environmentTag).toBeNull();

      // And it shows up where an administrator will look for it.
      const grants = await app.inject({
        method: 'GET',
        url: '/api/environment-grants',
        headers: { cookie: admin.cookie },
      });
      const body = grants.json();
      expect(body.untaggedInstances.map((i: { instanceId: string }) => i.instanceId)).toContain(
        instanceId,
      );
      expect(body.environments).not.toContain('');
    } finally {
      await app.close();
    }
  });
});
