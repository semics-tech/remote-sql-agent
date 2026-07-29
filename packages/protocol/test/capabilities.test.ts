import { describe, expect, it } from 'vitest';
import {
  effectiveCapabilities,
  COMMAND_CAPABILITY,
  COMMAND_KINDS,
  CAPABILITIES,
  MAX_CAPABILITY_TIERS,
  isCapability,
} from '../src/capabilities.js';
import { ROLES, ROLE_PERMISSIONS, roleHasPermission } from '../src/roles.js';

describe('effectiveCapabilities', () => {
  it('always grants observe, even with an empty server grant', () => {
    expect(effectiveCapabilities([], 'readOnly')).toEqual(['observe']);
  });

  it('never exceeds the worker-local ceiling, whatever the server grants', () => {
    // The defence-in-depth property from §6.3: a site can hard-pin a worker to
    // observe-only and a compromised control plane cannot override it.
    expect(effectiveCapabilities([...CAPABILITIES], 'readOnly')).toEqual(['observe']);
  });

  it('intersects rather than unions', () => {
    expect(effectiveCapabilities(['job.write'], 'operate')).toEqual(['observe']);
    expect(effectiveCapabilities(['job.toggle'], 'operate')).toEqual(['observe', 'job.toggle']);
  });

  it('grants the full set only when both sides allow it', () => {
    expect(effectiveCapabilities([...CAPABILITIES], 'full')).toEqual([...CAPABILITIES]);
  });

  it('drops capability strings it does not recognise', () => {
    // A newer control plane must not be able to smuggle an unknown capability
    // past an older worker.
    expect(effectiveCapabilities(['job.toggle', 'job.nuke'], 'full')).toEqual([
      'observe',
      'job.toggle',
    ]);
  });

  it('returns capabilities in a stable order regardless of grant order', () => {
    const a = effectiveCapabilities(['job.write', 'job.toggle', 'job.run'], 'full');
    const b = effectiveCapabilities(['job.run', 'job.write', 'job.toggle'], 'full');
    expect(a).toEqual(b);
  });

  it('has tiers that are strictly nested', () => {
    const tiers = ['readOnly', 'operate', 'schedule', 'full'] as const;
    for (let i = 1; i < tiers.length; i++) {
      const lower = MAX_CAPABILITY_TIERS[tiers[i - 1]!] as readonly string[];
      const higher = MAX_CAPABILITY_TIERS[tiers[i]!] as readonly string[];
      expect(higher).toEqual(expect.arrayContaining([...lower]));
    }
  });
});

describe('command vocabulary', () => {
  it('maps every command kind to a real capability', () => {
    for (const kind of COMMAND_KINDS) {
      expect(isCapability(COMMAND_CAPABILITY[kind])).toBe(true);
    }
  });

  it('has no command reachable with observe alone', () => {
    // observe is read-only by construction; if a write command ever mapped to
    // it, a read-only worker would become writable.
    for (const kind of COMMAND_KINDS) {
      expect(COMMAND_CAPABILITY[kind]).not.toBe('observe');
    }
  });
});

describe('RBAC matrix', () => {
  it('gives every role read access', () => {
    for (const role of ROLES) {
      expect(roleHasPermission(role, 'job.read')).toBe(true);
    }
  });

  it('withholds writes from Viewer', () => {
    for (const p of ['job.toggle', 'job.run', 'job.write', 'schedule.write'] as const) {
      expect(roleHasPermission('Viewer', p)).toBe(false);
    }
  });

  it('withholds job.write from Operator but allows toggle and run', () => {
    expect(roleHasPermission('Operator', 'job.toggle')).toBe(true);
    expect(roleHasPermission('Operator', 'job.run')).toBe(true);
    expect(roleHasPermission('Operator', 'job.write')).toBe(false);
  });

  it('withholds administration and approval from Editor', () => {
    expect(roleHasPermission('Editor', 'job.write')).toBe(true);
    expect(roleHasPermission('Editor', 'command.approve')).toBe(false);
    expect(roleHasPermission('Editor', 'user.admin')).toBe(false);
    expect(roleHasPermission('Editor', 'audit.read')).toBe(false);
  });

  it('has strictly increasing privilege across the role ladder', () => {
    const ladder = ['Viewer', 'Operator', 'Editor', 'Admin'] as const;
    for (let i = 1; i < ladder.length; i++) {
      const lower = ROLE_PERMISSIONS[ladder[i - 1]!];
      const higher = ROLE_PERMISSIONS[ladder[i]!];
      expect(higher).toEqual(expect.arrayContaining([...lower]));
      expect(higher.length).toBeGreaterThan(lower.length);
    }
  });

  it('separates approval from the ability to make the change', () => {
    // §6.4: job.write requires a second approver by default, so the role that
    // authors a change must not be the role that can rubber-stamp it.
    expect(roleHasPermission('Editor', 'job.write')).toBe(true);
    expect(roleHasPermission('Editor', 'command.approve')).toBe(false);
  });
});
