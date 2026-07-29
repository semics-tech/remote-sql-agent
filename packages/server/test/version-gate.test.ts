import { describe, expect, it } from 'vitest';
import { checkWorkerVersion, compareVersions } from '../src/hub/version-gate.js';

describe('compareVersions', () => {
  it.each([
    ['1.0.0', '1.0.0', 0],
    ['1.0.1', '1.0.0', 1],
    ['1.0.0', '1.0.1', -1],
    ['1.10.0', '1.9.0', 1],
    ['2.0.0', '1.99.99', 1],
  ])('compares %s to %s', (a, b, expected) => {
    expect(Math.sign(compareVersions(a, b))).toBe(expected);
  });

  it('compares numerically, not lexicographically', () => {
    // The classic bug: "1.10.0" < "1.9.0" as strings.
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
  });

  it('treats a missing segment as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBeLessThan(0);
  });

  it('ignores pre-release suffixes', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(0);
  });

  it('treats unparseable segments as zero rather than NaN', () => {
    // NaN comparisons are all false, which would silently allow anything.
    expect(compareVersions('1.x.0', '1.0.0')).toBe(0);
  });
});

describe('checkWorkerVersion', () => {
  it('allows everything when no minimum is configured', () => {
    expect(checkWorkerVersion('0.0.1', null).allowed).toBe(true);
    expect(checkWorkerVersion('', null).allowed).toBe(true);
  });

  it('allows a worker at or above the minimum', () => {
    expect(checkWorkerVersion('1.2.0', '1.2.0').allowed).toBe(true);
    expect(checkWorkerVersion('1.3.0', '1.2.0').allowed).toBe(true);
  });

  it('refuses a worker below the minimum, and says what to do', () => {
    const result = checkWorkerVersion('1.1.9', '1.2.0');
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/1\.1\.9/u);
    expect(result.reason).toMatch(/1\.2\.0/u);
    // The operator needs to know the fix is "upgrade and it reconnects itself".
    expect(result.reason).toMatch(/upgrade/iu);
  });

  it('refuses a worker that reports no version at all', () => {
    // Failing open here would let exactly the workers we are trying to retire
    // through, by omitting the field.
    expect(checkWorkerVersion('', '1.2.0').allowed).toBe(false);
  });
});
