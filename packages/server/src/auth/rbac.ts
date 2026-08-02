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
     * The environment the named instance belongs to, resolved by
     * `requireInstancePermission` whenever the request names one — whether
     * base role or a grant is what let it through. Recorded on the audit row
     * so the trail says which environment a write happened in, not only which
     * instance.
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
 * base role already allows it, the request proceeds without the grant table
 * ever being loaded — only a user whose base role is insufficient pays for
 * that lookup. The environment tag itself *is* resolved even on the base-role
 * path, one query, so it can be attributed on the audit row; that used to
 * happen only when a grant was what let the request through, which meant a
 * base-role Admin's write carried no environment at all.
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

    const instanceId = await resolveInstance(deps.db, request);

    // Resolved before the permission check, and unconditionally when an
    // instance is named — not only on the path where a grant was needed. This
    // is the fix for a gap the review found: `request.environmentTag` used to
    // stay unset whenever base role alone was enough, so a base-role Admin's
    // write carried no environment in the audit trail at all. The extra query
    // lands on every instance-scoped write rather than only the ones a grant
    // decided, which is a deliberate cost: writes are human-paced, and knowing
    // which environment an audited change happened in is the whole point of
    // having environments.
    //
    // Caught rather than left to throw: `resolveInstance` reads the path
    // parameter with no format validation of its own (that happens later, in
    // the route body), so an instance id that is not a valid UUID used to
    // reach this query only on the grant-needed path and would surface as a
    // raw 500. Treating a lookup failure the same as "no such instance" keeps
    // the existing fail-closed behaviour for a user who needs a grant, and
    // stops an unrelated malformed-id case turning into an unhandled error for
    // a base-role user who did not need one.
    let environmentTag: string | null | undefined;
    if (instanceId) {
      try {
        environmentTag = await environmentOfInstance(deps.db, instanceId);
      } catch (err) {
        request.log?.warn({ err, instanceId }, 'Could not resolve the environment for this instance');
        environmentTag = undefined;
      }
    }
    if (environmentTag !== undefined) request.environmentTag = environmentTag;

    if (roleHasPermission(session.user.role, permission)) return;

    if (!instanceId) {
      await reply.status(403).send({
        error: 'Forbidden',
        detail: `Your role (${session.user.role}) cannot ${permission}, and this request does not name an instance to check a grant against.`,
      });
      return;
    }

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
    if (canInEnvironment(principal, grants, permission, environmentTag)) return;

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
