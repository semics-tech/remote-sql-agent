import type { FastifyReply, FastifyRequest } from 'fastify';
import { roleHasPermission, type Permission } from '@remote-sql-agent/protocol';
import type { Database } from '../db/client.js';
import { resolveSession, SESSION_COOKIE, CSRF_HEADER, type AuthenticatedUser } from './sessions.js';
import { hashToken, safeEqualHex } from './passwords.js';

/**
 * Server-side authorisation (§6.5).
 *
 * Every route states the permission it needs. The SPA hides what a user cannot
 * do, but that is cosmetic — this is the only enforcement point, and there is
 * deliberately no way to register a route without going through it.
 */

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    sessionId?: string;
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface GuardDeps {
  db: Database;
}

export class AuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Build a preHandler enforcing authentication, CSRF and a single permission.
 *
 * Ordering matters: authenticate, then CSRF, then authorise. Checking the
 * permission first would let an unauthenticated caller distinguish "route
 * exists" from "route does not" by status code.
 */
export function requirePermission(deps: GuardDeps, permission: Permission) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];
    const session = await resolveSession(deps.db, token);

    if (!session) {
      await reply.status(401).send({ error: 'Unauthenticated', detail: 'Sign in to continue.' });
      return;
    }

    request.user = session.user;
    request.sessionId = session.sessionId;

    // Double-submit CSRF: the cookie is sent automatically by the browser, the
    // header is not, so a cross-site form post cannot produce a matching pair.
    if (MUTATING_METHODS.has(request.method)) {
      const provided = request.headers[CSRF_HEADER];
      const providedValue = Array.isArray(provided) ? provided[0] : provided;
      if (!providedValue || !safeEqualHex(hashToken(providedValue), session.csrfTokenHash)) {
        await reply
          .status(403)
          .send({ error: 'CsrfFailed', detail: 'Missing or invalid CSRF token. Reload and retry.' });
        return;
      }
    }

    if (!roleHasPermission(session.user.role, permission)) {
      await reply.status(403).send({
        error: 'Forbidden',
        detail: `Your role (${session.user.role}) cannot ${permission}.`,
      });
      return;
    }
  };
}

/** Authenticate without requiring any particular permission. */
export function requireSession(deps: GuardDeps) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = await resolveSession(deps.db, request.cookies[SESSION_COOKIE]);
    if (!session) {
      await reply.status(401).send({ error: 'Unauthenticated', detail: 'Sign in to continue.' });
      return;
    }
    request.user = session.user;
    request.sessionId = session.sessionId;
  };
}

/** The actor string recorded in the audit log for a request. */
export function actorOf(request: FastifyRequest): string {
  return request.user?.username ?? 'anonymous';
}
