import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { eq } from 'drizzle-orm';
import type { Role } from '@remote-sql-agent/protocol';
import type { Database } from '../src/db/client.js';
import { environmentGrants, instances, users } from '../src/db/schema.js';
import { requireInstancePermission, requirePermission } from '../src/auth/rbac.js';
import { createSession, CSRF_HEADER, SESSION_COOKIE } from '../src/auth/sessions.js';
import { membershipKey } from '../src/auth/environments.js';
import { setupTestDatabase, seedInstance, tagInstance, truncateAll } from './helpers/db.js';

/**
 * The guard, against a real database.
 *
 * environment-grants.test.ts pins the decision. This pins that the decision is
 * actually reached: that the base role short-circuits before any grant lookup,
 * that an unidentifiable instance is refused rather than treated as untagged,
 * that CSRF still applies, and — most importantly — that `requirePermission`
 * ignores grants entirely, so an Admin grant on production is not a way to
 * reach the estate-wide routes.
 */

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('environment_guard'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

const PROD_GROUP = '11111111-2222-3333-4444-555555555555';

async function seedUser(role: Role, identityGroups: string[] = []): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ username: `u-${role}-${identityGroups.length}`, role, identityGroups })
    .returning({ id: users.id });
  return row!.id;
}

async function tag(instanceId: string, environmentTag: string | null): Promise<void> {
  await tagInstance(db, instanceId, environmentTag);
}

async function addGrant(
  subjectKey: string,
  environmentTag: string,
  role: Role,
  subjectKind: 'entra_group' | 'app_role' | 'user' = 'entra_group',
): Promise<void> {
  await db.insert(environmentGrants).values({ subjectKind, subjectKey, environmentTag, role });
}

/**
 * A Fastify instance carrying both guards on throwaway routes.
 *
 * The real routes are not used because what is under test is the guard, and
 * standing up createApp() would drag in the hub registry, the command service
 * and the notification service to assert something none of them touch.
 */
async function app() {
  const instance = Fastify();
  await instance.register(cookie, { secret: 'a'.repeat(32) });

  instance.post(
    '/scoped/:instanceId',
    { preHandler: requireInstancePermission({ db }, 'job.write') },
    async (request) => ({ ok: true, environmentTag: request.environmentTag ?? null }),
  );
  // No :instanceId on the path: the guard cannot identify a target and must
  // refuse rather than fall through to the untagged case.
  instance.post(
    '/scoped-without-instance',
    { preHandler: requireInstancePermission({ db }, 'job.write') },
    async () => ({ ok: true }),
  );
  instance.post(
    '/estate-wide',
    { preHandler: requirePermission({ db }, 'user.admin') },
    async () => ({ ok: true }),
  );

  await instance.ready();
  return instance;
}

async function signIn(userId: string) {
  const session = await createSession(db, userId, 1, null);
  return {
    cookie: `${SESSION_COOKIE}=${session.token}`,
    csrf: session.csrfToken,
  };
}

async function post(
  server: Awaited<ReturnType<typeof app>>,
  url: string,
  auth: { cookie: string; csrf: string },
) {
  return server.inject({
    method: 'POST',
    url,
    headers: { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf },
    payload: {},
  });
}

describe('a grant reaching the instance', () => {
  it('lets a Viewer write in the environment they were granted', async () => {
    const server = await app();
    try {
      const { instanceId } = await seedInstance(db);
      await tag(instanceId, 'production');
      const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
      await addGrant(PROD_GROUP, 'production', 'Editor');

      const response = await post(server, `/scoped/${instanceId}`, await signIn(userId));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, environmentTag: 'production' });
    } finally {
      await server.close();
    }
  });

  it('refuses the same user on an instance in another environment', async () => {
    const server = await app();
    try {
      const { workerId } = await seedInstance(db, 'PRODHOST');
      const [uat] = await db
        .insert(instances)
        .values({ workerId, instanceName: 'UAT1' })
        .returning({ id: instances.id });
      await tag(uat!.id, 'uat');

      const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
      await addGrant(PROD_GROUP, 'production', 'Editor');

      const response = await post(server, `/scoped/${uat!.id}`, await signIn(userId));
      expect(response.statusCode).toBe(403);
      // The refusal has to name where they *could* have done it, or it sends
      // them to an administrator who cannot see anything wrong either.
      expect(response.json().detail).toContain('production');
    } finally {
      await server.close();
    }
  });

  it('refuses on an untagged instance', async () => {
    const server = await app();
    try {
      const { instanceId } = await seedInstance(db);
      await tag(instanceId, null);
      const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
      await addGrant(PROD_GROUP, 'production', 'Editor');

      expect((await post(server, `/scoped/${instanceId}`, await signIn(userId))).statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});

describe('failing closed', () => {
  it('refuses when the route cannot name an instance', async () => {
    const server = await app();
    try {
      const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
      await addGrant(PROD_GROUP, '*', 'Admin');

      // Even with a grant covering every environment: without a target there
      // is nothing to evaluate against, and guessing would mean a route that
      // stopped carrying :instanceId silently authorised against "untagged".
      const response = await post(server, '/scoped-without-instance', await signIn(userId));
      expect(response.statusCode).toBe(403);
      expect(response.json().detail).toContain('does not name an instance');
    } finally {
      await server.close();
    }
  });

  it('answers 403 rather than 404 for an instance that does not exist', async () => {
    const server = await app();
    try {
      const userId = await seedUser('Viewer');
      const missing = '00000000-0000-4000-8000-000000000000';
      const response = await post(server, `/scoped/${missing}`, await signIn(userId));

      // A 404/403 split here is an existence oracle: the caller has not been
      // shown that any of these instances exist.
      expect(response.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('still requires a session', async () => {
    const server = await app();
    try {
      const { instanceId } = await seedInstance(db);
      const response = await server.inject({ method: 'POST', url: `/scoped/${instanceId}`, payload: {} });
      expect(response.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it('still requires the CSRF header', async () => {
    const server = await app();
    try {
      const { instanceId } = await seedInstance(db);
      await tag(instanceId, 'production');
      const userId = await seedUser('Admin');
      const auth = await signIn(userId);

      // An Admin who would otherwise pass on the base role alone: CSRF is
      // checked before the permission, so the short-circuit must not skip it.
      const response = await server.inject({
        method: 'POST',
        url: `/scoped/${instanceId}`,
        headers: { cookie: auth.cookie },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('CsrfFailed');
    } finally {
      await server.close();
    }
  });
});

describe('the boundary between the two guards', () => {
  it('does not let an Admin grant reach an estate-wide route', async () => {
    const server = await app();
    try {
      const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
      // Admin, on every environment there is.
      await addGrant(PROD_GROUP, '*', 'Admin');

      // If this ever returns 200, an environment grant has become a way to
      // create users and enrol workers — and a grant that can grant is
      // self-extending. This is the single most important assertion here.
      const response = await post(server, '/estate-wide', await signIn(userId));
      expect(response.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });

  it('lets a base-role Admin through both', async () => {
    const server = await app();
    try {
      const { instanceId } = await seedInstance(db);
      await tag(instanceId, 'production');
      const userId = await seedUser('Admin');
      const auth = await signIn(userId);

      expect((await post(server, '/estate-wide', auth)).statusCode).toBe(200);

      const scoped = await post(server, `/scoped/${instanceId}`, auth);
      expect(scoped.statusCode).toBe(200);
      // The base role short-circuited the *permission* check, so no grant
      // lookup ran — but the environment tag is still resolved and recorded,
      // because the audit trail should say which environment a write happened
      // in whether or not a grant was what allowed it.
      expect(scoped.json().environmentTag).toBe('production');
    } finally {
      await server.close();
    }
  });
});

describe('membership is a snapshot from sign-in', () => {
  it('follows a membership change without waiting for the session to expire', async () => {
    const server = await app();
    try {
      const { instanceId } = await seedInstance(db);
      await tag(instanceId, 'production');
      const userId = await seedUser('Viewer');
      await addGrant(PROD_GROUP, 'production', 'Editor');
      const auth = await signIn(userId);

      expect((await post(server, `/scoped/${instanceId}`, auth)).statusCode).toBe(403);

      // Groups are read from the users row on every request rather than baked
      // into the session, so correcting one takes effect immediately.
      await db
        .update(users)
        .set({ identityGroups: [membershipKey('entra_group', PROD_GROUP)] })
        .where(eq(users.id, userId));

      expect((await post(server, `/scoped/${instanceId}`, auth)).statusCode).toBe(200);
    } finally {
      await server.close();
    }
  });

  it('revokes access the moment the grant is deleted', async () => {
    const server = await app();
    try {
      const { instanceId } = await seedInstance(db);
      await tag(instanceId, 'production');
      const userId = await seedUser('Viewer', [membershipKey('entra_group', PROD_GROUP)]);
      await addGrant(PROD_GROUP, 'production', 'Editor');
      const auth = await signIn(userId);

      expect((await post(server, `/scoped/${instanceId}`, auth)).statusCode).toBe(200);

      await db.delete(environmentGrants);
      expect((await post(server, `/scoped/${instanceId}`, auth)).statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });
});
