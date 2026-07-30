import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The dashboard is served off disk by @fastify/static, and nothing else in the
 * suite touches it — so a breaking change in that plugin would first show up as
 * a blank dashboard in production.
 *
 * This registers the plugin exactly as src/api/app.ts does, including the SPA
 * fallback, and pins the two properties that matter: assets are served, and the
 * static mount cannot be walked out of. The second is not hypothetical —
 * GHSA-83w8-p2f5-377r was a route guard bypass via path traversal in this
 * plugin, and the fix for it is the reason the dependency was raised to 10.1.1.
 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rsagent-static-'));
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>dashboard</title>');
  writeFileSync(join(root, 'assets', 'app-a1b2c3.js'), 'console.log("dashboard");');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The dashboard half of createApp(), lifted out so it needs no database. */
async function buildStaticApp() {
  const app = Fastify();
  await app.register(fastifyStatic, { root });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/health')) {
      return reply.status(404).send({ error: 'NotFound' });
    }
    return reply.sendFile('index.html');
  });
  return app;
}

describe('dashboard static assets', () => {
  it('serves a content-hashed asset', async () => {
    const app = await buildStaticApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/assets/app-a1b2c3.js' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('dashboard');
    } finally {
      await app.close();
    }
  });

  it('falls back to index.html so client-side routes survive a refresh', async () => {
    const app = await buildStaticApp();
    try {
      // A deep link the server has no route for. Reloading /jobs/<uuid> must
      // return the app, not a 404, or every bookmark in the product breaks.
      const response = await app.inject({ method: 'GET', url: '/jobs/some-uuid' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<title>dashboard</title>');
    } finally {
      await app.close();
    }
  });

  it('still answers API 404s as JSON rather than serving the app', async () => {
    const app = await buildStaticApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'NotFound' });
    } finally {
      await app.close();
    }
  });

  it('refuses to serve anything outside the dashboard directory', async () => {
    const outside = join(root, '..', 'rsagent-static-secret.txt');
    writeFileSync(outside, 'not for the internet');

    const app = await buildStaticApp();
    try {
      // Both the raw and the percent-encoded form: the encoded one is what a
      // traversal attempt actually looks like on the wire, since a well-behaved
      // client normalises the raw form away before it ever leaves the browser.
      for (const url of [
        '/../rsagent-static-secret.txt',
        '/..%2frsagent-static-secret.txt',
        '/assets/..%2f..%2frsagent-static-secret.txt',
      ]) {
        const response = await app.inject({ method: 'GET', url });
        expect(response.body).not.toContain('not for the internet');
      }
    } finally {
      await app.close();
      rmSync(outside, { force: true });
    }
  });
});
