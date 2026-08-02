import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPairSync } from 'node:crypto';
import type { Database } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { createApp, sseSessionStillAuthorised } from '../src/api/app.js';
import { CommandService } from '../src/domain/commands.js';
import { NotificationService } from '../src/domain/notifications/service.js';
import { EventBroker } from '../src/api/events.js';
import { WorkerRegistry } from '../src/hub/registry.js';
import { users } from '../src/db/schema.js';
import { hashPassword } from '../src/auth/passwords.js';
import { createSession, revokeSession } from '../src/auth/sessions.js';
import { setupTestDatabase, truncateAll } from './helpers/db.js';

/**
 * `/api/auth/login` and the SSE stream's ongoing authorisation.
 *
 * Login is the one mutating route that runs before a session — and so before
 * the usual session-scoped CSRF cookie — exists. A cross-site page cannot
 * read the response of a login it triggers, but nothing used to stop the
 * request itself from reaching the server and its Set-Cookie from landing:
 * that is enough to sign a victim into an attacker-chosen account. `/api/events`
 * has the opposite shape — a real problem after the fact, since the guard only
 * runs once at connection open and the stream can then sit open for as long as
 * the tab does.
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
  ({ db, close } = await setupTestDatabase('auth_routes'));
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

/** Pull the value Fastify would set for a given cookie name out of Set-Cookie headers. */
function cookieValue(setCookie: string[] | string | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const match = header.match(new RegExp(`^${name}=([^;]+)`, 'u'));
    if (match) return decodeURIComponent(match[1]!);
  }
  return undefined;
}

describe('login CSRF', () => {
  it('mints a CSRF cookie on /api/auth/config, before any session exists', async () => {
    const server = await buildApp();
    try {
      const response = await server.inject({ method: 'GET', url: '/api/auth/config' });
      expect(response.statusCode).toBe(200);
      expect(cookieValue(response.headers['set-cookie'], 'rsagent_csrf')).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it('refuses a login with no CSRF cookie or header at all', async () => {
    const server = await buildApp();
    try {
      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'whatever' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('CsrfFailed');
    } finally {
      await server.close();
    }
  });

  it('refuses a login whose header does not match its own pre-auth cookie', async () => {
    const server = await buildApp();
    try {
      const configResponse = await server.inject({ method: 'GET', url: '/api/auth/config' });
      const csrfCookie = cookieValue(configResponse.headers['set-cookie'], 'rsagent_csrf');

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { cookie: `rsagent_csrf=${csrfCookie}`, 'x-rsagent-csrf': 'not-the-same-value' },
        payload: { username: 'admin', password: 'whatever' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('CsrfFailed');
    } finally {
      await server.close();
    }
  });

  it('accepts a login whose header matches the pre-auth cookie, and rejects bad credentials on their own merits', async () => {
    const server = await buildApp();
    try {
      await db.insert(users).values({
        username: 'dba',
        role: 'Admin',
        passwordHash: await hashPassword('correct horse battery staple'),
      });

      const configResponse = await server.inject({ method: 'GET', url: '/api/auth/config' });
      const csrfCookie = cookieValue(configResponse.headers['set-cookie'], 'rsagent_csrf');

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { cookie: `rsagent_csrf=${csrfCookie}`, 'x-rsagent-csrf': csrfCookie! },
        payload: { username: 'dba', password: 'wrong password' },
      });
      // Past the CSRF gate: refused for being the wrong password, not CsrfFailed.
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe('InvalidCredentials');
    } finally {
      await server.close();
    }
  });
});

describe('logout CSRF', () => {
  it('refuses to sign out a session with no CSRF header at all', async () => {
    const server = await buildApp();
    try {
      const [row] = await db
        .insert(users)
        .values({ username: 'dba2', role: 'Admin' })
        .returning({ id: users.id });
      const session = await createSession(db, row!.id, 1, null);

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { cookie: `rsagent_session=${session.token}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('CsrfFailed');

      // The session must still be usable — logout did not go through.
      expect(await sseSessionStillAuthorised(db, session.token, 'instance.read')).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('refuses to sign out with a header that does not match the session CSRF token', async () => {
    const server = await buildApp();
    try {
      const [row] = await db
        .insert(users)
        .values({ username: 'dba3', role: 'Admin' })
        .returning({ id: users.id });
      const session = await createSession(db, row!.id, 1, null);

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          cookie: `rsagent_session=${session.token}`,
          'x-rsagent-csrf': 'not-the-real-token',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('CsrfFailed');
    } finally {
      await server.close();
    }
  });

  it('signs out a session whose CSRF header matches', async () => {
    const server = await buildApp();
    try {
      const [row] = await db
        .insert(users)
        .values({ username: 'dba4', role: 'Admin' })
        .returning({ id: users.id });
      const session = await createSession(db, row!.id, 1, null);

      const response = await server.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          cookie: `rsagent_session=${session.token}`,
          'x-rsagent-csrf': session.csrfToken,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ signedOut: true });
      expect(await sseSessionStillAuthorised(db, session.token, 'instance.read')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('signs out cleanly with no session cookie at all (already-signed-out client)', async () => {
    const server = await buildApp();
    try {
      const response = await server.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ signedOut: true });
    } finally {
      await server.close();
    }
  });
});

describe('SSE stream re-authorisation', () => {
  it('stays authorised for a live session with the permission', async () => {
    const [row] = await db
      .insert(users)
      .values({ username: 'viewer', role: 'Viewer' })
      .returning({ id: users.id });
    const session = await createSession(db, row!.id, 1, null);

    expect(await sseSessionStillAuthorised(db, session.token, 'instance.read')).toBe(true);
  });

  it('stops being authorised the moment the session is revoked', async () => {
    const [row] = await db
      .insert(users)
      .values({ username: 'viewer2', role: 'Viewer' })
      .returning({ id: users.id });
    const session = await createSession(db, row!.id, 1, null);
    expect(await sseSessionStillAuthorised(db, session.token, 'instance.read')).toBe(true);

    await revokeSession(db, session.token);

    expect(await sseSessionStillAuthorised(db, session.token, 'instance.read')).toBe(false);
  });

  it('is never authorised with no session token', async () => {
    expect(await sseSessionStillAuthorised(db, undefined, 'instance.read')).toBe(false);
  });
});
