import {
  ROLES,
  ROLE_PERMISSIONS,
  roleHasPermission,
  type Permission,
  type Role,
} from '@remote-sql-agent/protocol';
import { ALL_ENVIRONMENTS, type GrantSubjectKind } from '../db/schema.js';

/**
 * Environment-scoped authorisation.
 *
 * Everything in this file is pure. It decides whether a write reaches a
 * production SQL Server, so it is deliberately separable from Fastify, from
 * Drizzle and from any I/O — the interesting cases (an untagged instance, a
 * subject in two groups, a grant for an environment that no longer exists) are
 * ones you want to be able to state as a table rather than a fixture.
 *
 * The single rule everything else follows from: **grants add, never subtract.**
 * The base role applies estate-wide and is the floor. A grant raises the role
 * within one environment. There is no expressible grant that removes anything,
 * so no combination of rows in `environment_grants` can leave a user with less
 * than their base role.
 */

/** A row from `environment_grants`, reduced to what the decision needs. */
export interface EnvironmentGrant {
  subjectKind: GrantSubjectKind;
  subjectKey: string;
  environmentTag: string;
  role: Role;
}

/** Who is asking. `identityGroups` are the `kind:key` strings held on `users`. */
export interface Principal {
  userId: string;
  role: Role;
  identityGroups: readonly string[];
}

/** Membership key format, shared by the sign-in path and the resolver. */
export function membershipKey(kind: GrantSubjectKind, key: string): string {
  return `${kind}:${key}`;
}

/**
 * Environment tags are compared case-insensitively.
 *
 * They are free text typed by an administrator into a box, and `Production` on
 * the instance against `production` on the grant is not a distinction anyone
 * intends. Getting this wrong fails in the safe direction — nobody is granted
 * anything — but "the grant I created does nothing and there is no error"
 * is close to undiagnosable from the dashboard, so it is worth not doing.
 */
function normaliseTag(tag: string | null): string | null {
  const trimmed = tag?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Does this grant's subject describe the principal? */
function appliesToSubject(grant: EnvironmentGrant, principal: Principal): boolean {
  if (grant.subjectKind === 'user') return grant.subjectKey === principal.userId;
  return principal.identityGroups.includes(membershipKey(grant.subjectKind, grant.subjectKey));
}

/**
 * Does this grant reach an instance tagged `environmentTag`?
 *
 * An instance with no tag is reachable only by a `*` grant. A grant for
 * `production` deliberately does *not* apply to an untagged instance: an
 * instance enrolled before anybody set up tagging, or one where the tag was
 * mistyped, must not silently inherit production's write permissions. The cost
 * is that tagging is load-bearing and an untagged instance is writable only by
 * base role — which is the failure people can see, rather than the one they
 * cannot.
 */
function appliesToEnvironment(grant: EnvironmentGrant, environmentTag: string | null): boolean {
  if (grant.environmentTag === ALL_ENVIRONMENTS) return true;
  const target = normaliseTag(environmentTag);
  return target !== null && normaliseTag(grant.environmentTag) === target;
}

const ROLE_RANK = new Map<Role, number>(ROLES.map((role, index) => [role, index]));

/** The more privileged of two roles, by the declared ROLES order. */
function higher(a: Role, b: Role): Role {
  return (ROLE_RANK.get(a) ?? 0) >= (ROLE_RANK.get(b) ?? 0) ? a : b;
}

/**
 * The role this principal holds against an instance in `environmentTag`.
 *
 * Never lower than the base role. Somebody holding two grants that both reach
 * the instance gets the more privileged, which is what an administrator who
 * assigned both meant — the same rule the Entra app-role mapping already uses
 * for a user with several app roles.
 */
export function effectiveRole(
  principal: Principal,
  grants: readonly EnvironmentGrant[],
  environmentTag: string | null,
): Role {
  let role = principal.role;
  for (const grant of grants) {
    if (!appliesToSubject(grant, principal)) continue;
    if (!appliesToEnvironment(grant, environmentTag)) continue;
    role = higher(role, grant.role);
  }
  return role;
}

/** Can this principal do `permission` to an instance in `environmentTag`? */
export function canInEnvironment(
  principal: Principal,
  grants: readonly EnvironmentGrant[],
  permission: Permission,
  environmentTag: string | null,
): boolean {
  // The base role is checked first and on its own, so the common case — an
  // Admin, or any read by a Viewer — costs nothing and does not depend on the
  // grant table being loaded at all.
  if (roleHasPermission(principal.role, permission)) return true;
  return roleHasPermission(effectiveRole(principal, grants, environmentTag), permission);
}

/** Every permission this principal holds in `environmentTag`, for the SPA. */
export function permissionsInEnvironment(
  principal: Principal,
  grants: readonly EnvironmentGrant[],
  environmentTag: string | null,
): readonly Permission[] {
  // Read from the role table rather than recomputed, so there is one source of
  // truth for what a role means.
  return ROLE_PERMISSIONS[effectiveRole(principal, grants, environmentTag)];
}

/**
 * Where a principal's grants apply, for explaining a refusal.
 *
 * A 403 that says only "your role cannot job.write" is wrong once grants exist
 * — the user may well be able to do exactly that, one environment over — and
 * sends them to an administrator who then cannot see anything wrong either.
 */
export function grantedEnvironments(
  principal: Principal,
  grants: readonly EnvironmentGrant[],
  permission: Permission,
): string[] {
  const tags = new Set<string>();
  for (const grant of grants) {
    if (!appliesToSubject(grant, principal)) continue;
    if (!roleHasPermission(grant.role, permission)) continue;
    tags.add(grant.environmentTag);
  }
  return [...tags].sort();
}
