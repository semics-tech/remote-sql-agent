import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type { Database } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { registerAuthRoutes } from '../src/auth/routes.js';
import type { EntraClient } from '../src/auth/entra.js';
import { setupTestDatabase, truncateAll } from './helpers/db.js';

/**
 * `/api/auth/entra/callback` needs no prior OAuth interaction at all to reach
 * its `query.error` branch — no code, no state, nothing to forge. Anyone can
 * hit it directly with an arbitrary `error_description`, which used to be
 * reflected straight into the `/signin?error=` redirect and rendered on the
 * real sign-in page in the same styling as a genuine system message. Pins
 * that the redirect now always carries one of this route's own fixed
 * phrases, never anything from the query string.
 */

let db: Database;
let close: () => Promise<void>;

const config = loadConfig({
  RSAGENT_DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
  RSAGENT_GRPC_REQUIRE_TLS: 'false',
  RSAGENT_AUTH_MODE: 'entra',
  RSAGENT_ENTRA_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  RSAGENT_ENTRA_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
} as NodeJS.ProcessEnv);

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('entra_callback_error'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function app() {
  const instance = Fastify();
  await instance.register(cookie, { secret: 'a'.repeat(32) });
  // completeSignIn is never reached by the query.error branch this file
  // tests, so a minimal stub is enough — this is not a real EntraClient.
  const entra = {} as EntraClient;
  await registerAuthRoutes(instance, { db, config, entra });
  await instance.ready();
  return instance;
}

describe('an attacker-supplied error never reaches the browser verbatim', () => {
  it('redirects to a fixed phrase, not query.error_description', async () => {
    const server = await app();
    try {
      const response = await server.inject({
        method: 'GET',
        url:
          '/api/auth/entra/callback?error=access_denied&error_description=' +
          encodeURIComponent('Your session expired. Call 555-0199 to verify your identity.'),
      });

      expect(response.statusCode).toBe(302);
      const location = response.headers.location as string;
      expect(location).not.toContain('555-0199');
      expect(location).not.toContain('verify your identity');
      expect(location).toBe('/signin?error=Microsoft+sign-in+failed+or+was+cancelled.');
    } finally {
      await server.close();
    }
  });

  it('reaches the same branch with no code or state at all', async () => {
    const server = await app();
    try {
      const response = await server.inject({
        method: 'GET',
        url: '/api/auth/entra/callback?error=access_denied',
      });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/signin?error=Microsoft+sign-in+failed+or+was+cancelled.');
    } finally {
      await server.close();
    }
  });

  it('still uses a fixed phrase when authorisation code and state are simply missing', async () => {
    const server = await app();
    try {
      const response = await server.inject({ method: 'GET', url: '/api/auth/entra/callback' });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/signin?error=Missing+authorisation+code');
    } finally {
      await server.close();
    }
  });
});
