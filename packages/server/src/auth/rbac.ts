import type { FastifyReply, FastifyRequest } from 'fastify';
import { roleHasPermission, type Permission } from '@remote-sql-agent/protocol';
import type { Database } from '../db/client.js';
import { resolveSession, SESSION_COOKIE, CSRF_HEADER, type AuthenticatedUser } from './sessions.js';
import { hashToken, safeEqualHex } from './passwords.js';
import { canInEnvironment, grantedEnvironments } from './environments.js';
import { environmentOfInstance, loadGrants, principalOf } from './grants-store.js';

/**
 * Server-side authorisation (§6.5).
 *
 * Every route states the permission it needs. The SPA hides what a user cannot
 * do, but that is cosmetic — this is the only enforcement point, and there is
 * deliberately no way to register a route without going through it.
 *
 * Two guards, and which one a route uses is a security decision:
 *
 *   requirePermission          the base role only. For anything estate-wide —
 *                              reads, user administration, worker enrolment.
 *   requireInstancePermission  the base role, *or* an environment grant that
 *                              reaches the instance this request names. For
 *                              anything that changes or executes something on
 *                              one SQL Server.
 *
 * The second is strictly more permissive than the first, because grants only
 * ever add (see environments.ts). Moving a route from the first to the second
 * can therefore let a request through that used to be refused, and moving one
 * the other way can only refuse requests that used to be allowed. Neither is a
 * no-op, and neither should be done without saying why.
 */

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    sessionId?: string;
    /**
     * Set by `requireInstancePermission` when a grant — rather than the base
     * role — is what let the request through. Recorded on the audit row so the
     * trail says which environment's authority was used.
     */
    environmentTag?: string | null;
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
    const session = await authenticate(deps, request, reply);
    if (!session) return;

    // The base role only. Environment grants are not consulted here on purpose:
    // this guard is for estate-wide actions, and a grant scoped to production
    // must not confer the ability to create users or enrol workers.
    if (!roleHasPermission(session.user.role, permission)) {
      await reply.status(403).send({
        error: 'Forbidden',
        detail: `Your role (${session.user.role}) cannot ${permission}.`,
      });
      return;
    }
  };
}

/**
 * Where the guard should look for the instance this request is about.
 *
 * Defaults to `:instanceId` on the path, which covers every write route. The
 * command approval routes name a command instead, so they pass a resolver that
 * reads the instance off it — approving a command *is* an act against that
 * command's instance, and guarding it estate-wide would let an operator with
 * production rights approve a change queued against a different environment.
 */
export type InstanceResolver = (
  db: Database,
  request: FastifyRequest,
) => Promise<string | null> | string | null;

const instanceFromParams: InstanceResolver = (_db, request) => {
  const params = request.params as { instanceId?: unknown } | undefined;
  return typeof params?.instanceId === 'string' ? params.instanceId : null;
};

/**
 * Build a preHandler enforcing a permission *against one instance*.
 *
 * Identical to `requirePermission` up to the permission check, then: if the
 * base role already allows it, nothing else happens and no extra query runs.
 * Only a user whose base role is insufficient pays for the grant lookup, which
 * is the case this feature exists for.
 *
 * Fails closed at every step. An instance that cannot be identified, or that
 * does not exist, is refused rather than evaluated as "untagged" — otherwise a
 * route that stopped carrying `:instanceId` would silently start authorising
 * against the untagged case instead of erroring.
 */
export function requireInstancePermission(
  deps: GuardDeps,
  permission: Permission,
  resolveInstance: InstanceResolver = instanceFromParams,
) {
  return async function guard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const session = await authenticate(deps, request, reply);
    if (!session) return;

    if (roleHasPermission(session.user.role, permission)) return;

    const instanceId = await resolveInstance(deps.db, request);
    if (!instanceId) {
      await reply.status(403).send({
        error: 'Forbidden',
        detail: `Your role (${session.user.role}) cannot ${permission}, and this request does not name an instance to check a grant against.`,
      });
      return;
    }

    const environmentTag = await environmentOfInstance(deps.db, instanceId);
    if (environmentTag === undefined) {
      // Deliberately not a 404: the caller has not been shown that this
      // instance exists, and a 404-versus-403 split here is an existence
      // oracle for anyone probing instance ids.
      await reply.status(403).send({
        error: 'Forbidden',
        detail: `Your role (${session.user.role}) cannot ${permission} here.`,
      });
      return;
    }

    const principal = principalOf(session.user);
    const grants = await loadGrants(deps.db);
    if (canInEnvironment(principal, grants, permission, environmentTag)) {
      request.environmentTag = environmentTag;
      return;
    }

    // Say where they *can* do it. Once grants exist, "your role cannot
    // job.write" is often simply untrue — they can, one environment over — and
    // it sends the operator to an administrator who cannot see anything wrong
    // either.
    const elsewhere = grantedEnvironments(principal, grants, permission);
    const detail =
      elsewhere.length > 0
        ? `You can ${permission} in ${elsewhere.join(', ')}, but not in ${environmentTag ?? 'this untagged environment'}.`
        : `Your role (${session.user.role}) cannot ${permission}, and you hold no grant that allows it in ${environmentTag ?? 'an untagged environment'}.`;

    await reply.status(403).send({ error: 'Forbidden', detail });
  };
}

/**
 * Session, CSRF and nothing else. Shared so the two guards cannot drift on the
 * half that is the same in both — which is the half an attacker cares about.
 */
async function authenticate(
  deps: GuardDeps,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ user: AuthenticatedUser } | null> {
  const token = request.cookies[SESSION_COOKIE];
  const session = await resolveSession(deps.db, token);

  if (!session) {
    await reply.status(401).send({ error: 'Unauthenticated', detail: 'Sign in to continue.' });
    return null;
  }

  request.user = session.user;
  request.sessionId = session.sessionId;

  if (MUTATING_METHODS.has(request.method)) {
    const provided = request.headers[CSRF_HEADER];
    const providedValue = Array.isArray(provided) ? provided[0] : provided;
    if (!providedValue || !safeEqualHex(hashToken(providedValue), session.csrfTokenHash)) {
      await reply
        .status(403)
        .send({ error: 'CsrfFailed', detail: 'Missing or invalid CSRF token. Reload and retry.' });
      return null;
    }
  }

  return { user: session.user };
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
