import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_PERMISSIONS, type Permission, type Role } from '@remote-sql-agent/protocol';
import {
  canInEnvironment,
  effectiveRole,
  grantedEnvironments,
  membershipKey,
  permissionsInEnvironment,
  type EnvironmentGrant,
  type Principal,
} from '../src/auth/environments.js';

/**
 * The environment-grant decision.
 *
 * Pure, and tested without a database on purpose: this is the code that decides
 * whether a write reaches a production SQL Server, and the cases that matter —
 * an untagged instance, a subject in two groups, a grant for an environment
 * nobody uses any more — are ones worth being able to state directly rather
 * than build a fixture for.
 */

const PROD_GROUP = '11111111-2222-3333-4444-555555555555';
const UAT_GROUP = '99999999-8888-7777-6666-555555555555';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'user-1',
    role: 'Viewer',
    identityGroups: [membershipKey('entra_group', PROD_GROUP)],
    ...overrides,
  };
}

function grant(overrides: Partial<EnvironmentGrant> = {}): EnvironmentGrant {
  return {
    subjectKind: 'entra_group',
    subjectKey: PROD_GROUP,
    environmentTag: 'production',
    role: 'Editor',
    ...overrides,
  };
}

describe('the shape this feature exists for', () => {
  // "production_admin can write and execute on servers tagged production, but
  // can read and view all servers." Base role Viewer, one grant.
  const productionAdmin = principal({ role: 'Viewer' });
  const grants = [grant({ role: 'Editor' })];

  it('writes in production', () => {
    expect(canInEnvironment(productionAdmin, grants, 'job.write', 'production')).toBe(true);
    expect(canInEnvironment(productionAdmin, grants, 'job.run', 'production')).toBe(true);
  });

  it('does not write anywhere else', () => {
    expect(canInEnvironment(productionAdmin, grants, 'job.write', 'uat')).toBe(false);
    expect(canInEnvironment(productionAdmin, grants, 'job.run', 'development')).toBe(false);
  });

  it('still reads everywhere, because the base role does', () => {
    for (const environment of ['production', 'uat', 'development', null]) {
      expect(canInEnvironment(productionAdmin, grants, 'job.read', environment)).toBe(true);
      expect(canInEnvironment(productionAdmin, grants, 'instance.read', environment)).toBe(true);
      expect(canInEnvironment(productionAdmin, grants, 'history.read', environment)).toBe(true);
    }
  });
});

describe('grants add and never subtract', () => {
  it('never returns a role below the base role', () => {
    // The load-bearing invariant. If any combination of grants could lower the
    // effective role, a mistake in the grants table would become an outage
    // rather than an over-permission — and the second is at least visible in
    // the audit trail.
    const combinations: EnvironmentGrant[][] = [
      [],
      [grant({ role: 'Viewer' })],
      [grant({ role: 'Viewer', environmentTag: '*' })],
      [grant({ role: 'Operator' }), grant({ role: 'Viewer', environmentTag: 'uat' })],
      [grant({ subjectKey: 'someone-else', role: 'Viewer' })],
    ];

    for (const base of ROLES) {
      for (const grants of combinations) {
        for (const environment of ['production', 'uat', null]) {
          const resolved = effectiveRole(principal({ role: base }), grants, environment);
          const permissions = ROLE_PERMISSIONS[resolved];
          for (const held of ROLE_PERMISSIONS[base]) {
            expect(permissions).toContain(held);
          }
        }
      }
    }
  });

  it('takes the most privileged grant when several reach the instance', () => {
    // What an administrator who assigned both meant, and the same rule the
    // Entra app-role mapping already uses.
    const holder = principal({
      identityGroups: [
        membershipKey('entra_group', PROD_GROUP),
        membershipKey('entra_group', UAT_GROUP),
      ],
    });
    const grants = [
      grant({ subjectKey: PROD_GROUP, role: 'Operator' }),
      grant({ subjectKey: UAT_GROUP, role: 'Admin' }),
    ];
    expect(effectiveRole(holder, grants, 'production')).toBe('Admin');
  });
});

describe('which instances a grant reaches', () => {
  it('does not reach an untagged instance', () => {
    // Fails closed, and deliberately. An instance enrolled before tagging
    // existed, or one where the tag was mistyped, must not inherit
    // production's write permissions by accident. The cost is that tagging is
    // load-bearing — which is a failure people can see.
    expect(canInEnvironment(principal(), [grant()], 'job.write', null)).toBe(false);
  });

  it('reaches everything, including untagged, when the tag is *', () => {
    const everywhere = [grant({ environmentTag: '*' })];
    expect(canInEnvironment(principal(), everywhere, 'job.write', null)).toBe(true);
    expect(canInEnvironment(principal(), everywhere, 'job.write', 'production')).toBe(true);
    expect(canInEnvironment(principal(), everywhere, 'job.write', 'anything-at-all')).toBe(true);
  });

  it.each([
    ['Production', 'production'],
    ['production', 'PRODUCTION'],
    ['  production  ', 'production'],
  ])('matches %s against %s', (instanceTag, grantTag) => {
    // Free text typed into a box on two different screens. `Production` on the
    // instance against `production` on the grant is not a distinction anybody
    // intends, and getting it wrong produces a grant that does nothing with no
    // error anywhere — close to undiagnosable from the dashboard.
    expect(
      canInEnvironment(principal(), [grant({ environmentTag: grantTag })], 'job.write', instanceTag),
    ).toBe(true);
  });

  it('does not match a different tag', () => {
    expect(canInEnvironment(principal(), [grant()], 'job.write', 'production-dr')).toBe(false);
    expect(canInEnvironment(principal(), [grant()], 'job.write', 'prod')).toBe(false);
  });
});

describe('which subjects a grant applies to', () => {
  it('ignores a grant for a group the user is not in', () => {
    expect(canInEnvironment(principal(), [grant({ subjectKey: UAT_GROUP })], 'job.write', 'production')).toBe(
      false,
    );
  });

  it('does not confuse a group object id with an app role of the same name', () => {
    // Both live in one namespaced list precisely so this cannot happen: an
    // app role called "production-writers" must not satisfy a grant written
    // against a group whose object id happens to be the same string.
    const inGroupOnly = principal({ identityGroups: [membershipKey('entra_group', 'shared-name')] });
    const asAppRole = [grant({ subjectKind: 'app_role', subjectKey: 'shared-name' })];
    expect(canInEnvironment(inGroupOnly, asAppRole, 'job.write', 'production')).toBe(false);

    const asGroup = [grant({ subjectKind: 'entra_group', subjectKey: 'shared-name' })];
    expect(canInEnvironment(inGroupOnly, asGroup, 'job.write', 'production')).toBe(true);
  });

  it('matches a user grant on the user id, not the username', () => {
    const named = [grant({ subjectKind: 'user', subjectKey: 'user-1' })];
    expect(canInEnvironment(principal(), named, 'job.write', 'production')).toBe(true);
    expect(
      canInEnvironment(principal({ userId: 'user-2' }), named, 'job.write', 'production'),
    ).toBe(false);
  });

  it('gives a user with no memberships exactly their base role', () => {
    const nobody = principal({ identityGroups: [] });
    expect(effectiveRole(nobody, [grant({ role: 'Admin' })], 'production')).toBe('Viewer');
  });
});

describe('what the dashboard is told', () => {
  it('reports the permissions held in one environment, not estate-wide', () => {
    const grants = [grant({ role: 'Editor' })];
    const inProduction = permissionsInEnvironment(principal(), grants, 'production');
    const inUat = permissionsInEnvironment(principal(), grants, 'uat');

    expect(inProduction).toContain('job.write');
    expect(inUat).not.toContain('job.write');
    // Reads are in both: the SPA must not grey out a job page in UAT.
    expect(inUat).toContain('job.read');
  });
});

describe('explaining a refusal', () => {
  it('names the environments where the user could have done it', () => {
    // A 403 saying only "your role cannot job.write" is often untrue once
    // grants exist — they can, one environment over — and it sends the
    // operator to an administrator who then cannot see anything wrong either.
    const grants = [
      grant({ environmentTag: 'uat', role: 'Editor' }),
      grant({ environmentTag: 'development', role: 'Editor' }),
      grant({ environmentTag: 'production', role: 'Operator' }),
    ];
    expect(grantedEnvironments(principal(), grants, 'job.write')).toEqual(['development', 'uat']);
  });

  it('says nothing about grants held by other people', () => {
    const grants = [grant({ subjectKey: UAT_GROUP, environmentTag: 'uat', role: 'Admin' })];
    expect(grantedEnvironments(principal(), grants, 'job.write')).toEqual([]);
  });
});

describe('permissions that stay estate-wide', () => {
  it('is not what confers user or worker administration', () => {
    // A grant is consulted only by the instance guard, and no route behind
    // these permissions uses it. Pinned here as well because the boundary is
    // easy to erode: an Admin grant on production reads like "Admin", and it
    // must not become the ability to create users or enrol workers.
    const productionAdmin = [grant({ role: 'Admin' })];
    const holder = principal({ role: 'Viewer' });

    for (const permission of ['user.admin', 'worker.admin', 'audit.read'] as Permission[]) {
      // The resolver *would* grant it inside production — that is what Admin
      // means — so the separation lives in which guard each route uses. This
      // asserts the resolver's half honestly rather than pretending otherwise.
      expect(canInEnvironment(holder, productionAdmin, permission, 'production')).toBe(true);
      expect(canInEnvironment(holder, productionAdmin, permission, 'uat')).toBe(false);
    }
  });
});

describe('role ordering', () => {
  it('ranks roles by the declared order, most privileged last', () => {
    // effectiveRole picks "the higher of two roles" by index into ROLES.
    // Reordering that array silently changes every grant in the estate.
    expect(ROLES).toEqual(['Viewer', 'Operator', 'Editor', 'Admin'] satisfies Role[]);
  });
});
