import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import type { ServerConfig } from '../config.js';
import type { EntraClient } from './entra.js';
import { authenticateLocal, upsertEntraUser } from './users.js';
import {
  createSession,
  revokeSession,
  CSRF_COOKIE,
  SESSION_COOKIE,
} from './sessions.js';
import { requireSession } from './rbac.js';
import { writeAudit } from '../domain/audit.js';
import { ROLE_PERMISSIONS } from '@remote-sql-agent/protocol';

export interface AuthRoutesDeps {
  db: Database;
  config: ServerConfig;
  entra: EntraClient | null;
}

const loginSchema = z.object({
  username: z.string().min(1).max(256),
  password: z.string().min(1).max(1024),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRoutesDeps,
): Promise<void> {
  const { db, config, entra } = deps;
  const secure = config.publicUrl.startsWith('https://');
  const redirectUri = `${config.publicUrl.replace(/\/$/u, '')}/api/auth/entra/callback`;

  const cookieOptions = {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
  };

  function issueCookies(
    reply: FastifyReply,
    token: string,
    csrfToken: string,
    expiresAt: Date,
  ): void {
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });
    // Readable by script on purpose: the SPA must echo it back in a header,
    // which is exactly what a cross-site attacker cannot do.
    reply.setCookie(CSRF_COOKIE, csrfToken, {
      ...cookieOptions,
      httpOnly: false,
      expires: expiresAt,
    });
  }

  /** What sign-in methods this deployment offers. Unauthenticated by design. */
  app.get('/api/auth/config', async () => ({
    localEnabled: config.auth.mode === 'local' || config.auth.mode === 'both',
    entraEnabled: (config.auth.mode === 'entra' || config.auth.mode === 'both') && entra !== null,
    entraLoginUrl: '/api/auth/entra/login',
  }));

  app.get(
    '/api/auth/me',
    { preHandler: requireSession({ db }) },
    async (request) => ({
      user: request.user,
      permissions: request.user ? ROLE_PERMISSIONS[request.user.role] : [],
    }),
  );

  // --- Local sign-in --------------------------------------------------------

  app.post(
    '/api/auth/login',
    {
      config: {
        // Sign-in is the one endpoint worth rate-limiting hard: it is the only
        // place an attacker can test a password.
        rateLimit: { max: 10, timeWindow: '5 minutes' },
      },
    },
    async (request, reply) => {
      if (config.auth.mode === 'entra') {
        return reply
          .status(400)
          .send({ error: 'LocalSignInDisabled', detail: 'This deployment signs in with Entra.' });
      }

      const { username, password } = loginSchema.parse(request.body);
      const user = await authenticateLocal(db, username, password);

      if (!user) {
        await writeAudit(db, {
          actorType: 'user',
          actor: username,
          action: 'auth.login.failed',
          detail: { provider: 'local' },
          remoteAddress: request.ip,
        });
        // Deliberately does not say which of the two was wrong.
        return reply
          .status(401)
          .send({ error: 'InvalidCredentials', detail: 'Incorrect username or password.' });
      }

      const session = await createSession(db, user.id, config.auth.sessionTtlHours, request.ip);
      issueCookies(reply, session.token, session.csrfToken, session.expiresAt);

      await writeAudit(db, {
        actorType: 'user',
        actor: user.username,
        action: 'auth.login',
        target: user.id,
        detail: { provider: 'local', role: user.role },
        remoteAddress: request.ip,
      });

      return { user, csrfToken: session.csrfToken };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    const session = token ? await requireSessionUser(db, token) : null;

    await revokeSession(db, token);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    reply.clearCookie(CSRF_COOKIE, { ...cookieOptions, httpOnly: false });

    if (session) {
      await writeAudit(db, {
        actorType: 'user',
        actor: session,
        action: 'auth.logout',
        remoteAddress: request.ip,
      });
    }
    return { signedOut: true };
  });

  // --- Entra sign-in --------------------------------------------------------

  if (entra) {
    app.get('/api/auth/entra/login', async (_request, reply) => {
      const { url } = entra.beginSignIn(redirectUri);
      return reply.redirect(url, 302);
    });

    app.get('/api/auth/entra/callback', async (request, reply) => {
      const query = z
        .object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        })
        .parse(request.query);

      if (query.error) {
        // query.error_description is Entra's free text, and query.error alone
        // reaches this branch with no code/state check at all — this route
        // requires no prior OAuth interaction, so both are reachable by
        // anyone crafting a link, not only by a real failed sign-in. Keeping
        // it in the audit log but never in the redirect is what stops that
        // link from putting attacker-chosen text on the real sign-in page,
        // styled exactly like a genuine system message.
        await writeAudit(db, {
          actorType: 'user',
          actor: 'unknown',
          action: 'auth.login.failed',
          detail: { provider: 'entra', error: query.error, description: query.error_description ?? null },
          remoteAddress: request.ip,
        });
        return reply.redirect('/signin?error=Microsoft+sign-in+failed+or+was+cancelled.', 302);
      }

      if (!query.code || !query.state) {
        return reply.redirect('/signin?error=Missing+authorisation+code', 302);
      }

      try {
        const profile = await entra.completeSignIn(query.code, query.state);
        const user = await upsertEntraUser(db, profile);
        const session = await createSession(db, user.id, config.auth.sessionTtlHours, request.ip);
        issueCookies(reply, session.token, session.csrfToken, session.expiresAt);

        await writeAudit(db, {
          actorType: 'user',
          actor: user.username,
          action: 'auth.login',
          target: user.id,
          detail: {
            provider: 'entra',
            role: user.role,
            appRoles: profile.appRoles,
            objectId: profile.objectId,
          },
          remoteAddress: request.ip,
        });

        return reply.redirect('/', 302);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sign-in failed.';
        request.log.warn({ err }, 'Entra sign-in failed');
        await writeAudit(db, {
          actorType: 'user',
          actor: 'unknown',
          action: 'auth.login.failed',
          detail: { provider: 'entra', reason: message },
          remoteAddress: request.ip,
        });
        // Fixed message rather than `message` itself, for the same reason as
        // the query.error branch above: nothing reaching the browser here
        // should be text this route did not author itself.
        return reply.redirect(
          '/signin?error=Microsoft+sign-in+failed.+Try+again+or+contact+your+administrator.',
          302,
        );
      }
    });
  }
}

/** Resolve just the username for audit purposes, tolerating an expired session. */
async function requireSessionUser(db: Database, token: string): Promise<string | null> {
  const { resolveSession } = await import('./sessions.js');
  const session = await resolveSession(db, token);
  return session?.user.username ?? null;
}
