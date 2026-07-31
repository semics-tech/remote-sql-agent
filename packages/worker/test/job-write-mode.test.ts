import { describe, expect, it } from 'vitest';
import { canEditJob, type JobWriteMode } from '../src/sql/agent-repo.js';

/**
 * Whether a job can be edited is decided by SQL Server, and getting it wrong in
 * either direction is bad in a different way. Too permissive and the dashboard
 * offers a save that fails with a raw SQL error after the operator has written
 * it. Too strict and it hides an edit that would have worked.
 *
 * This is the one rule, applied both by the worker before it attempts a write
 * and by the dashboard before it offers one, so the two cannot drift.
 */

function mode(overrides: Partial<JobWriteMode> = {}): JobWriteMode {
  return {
    sqlLoginName: 'CORP\\SQLAGENT-SVC',
    isSysadmin: false,
    wrapperInstalled: false,
    wrapperAllowsDashboardManagement: false,
    allowlistedJobs: [],
    ...overrides,
  };
}

describe('canEditJob', () => {
  it('permits a job the worker owns', () => {
    expect(
      canEditJob(mode(), { name: 'Nightly load', ownerLoginName: 'CORP\\SQLAGENT-SVC' }),
    ).toBe(true);
  });

  it('refuses a job owned by someone else with no wrapper', () => {
    // The common case on a real estate: jobs are owned by sa.
    expect(canEditJob(mode(), { name: 'Nightly load', ownerLoginName: 'sa' })).toBe(false);
  });

  it('permits anything when the worker is sysadmin', () => {
    expect(
      canEditJob(mode({ isSysadmin: true }), { name: 'Nightly load', ownerLoginName: 'sa' }),
    ).toBe(true);
  });

  it('permits an allowlisted job through the wrapper', () => {
    expect(
      canEditJob(mode({ wrapperInstalled: true, allowlistedJobs: ['Nightly load'] }), {
        name: 'Nightly load',
        ownerLoginName: 'sa',
      }),
    ).toBe(true);
  });

  it('refuses a job the wrapper has not been told about', () => {
    // Default-deny is the whole point of the allowlist: installing the wrapper
    // must not silently make every job on the instance editable.
    expect(
      canEditJob(mode({ wrapperInstalled: true, allowlistedJobs: ['Something else'] }), {
        name: 'Nightly load',
        ownerLoginName: 'sa',
      }),
    ).toBe(false);
  });

  it('ignores an allowlist when the wrapper is not installed', () => {
    // A stale allowlist read from a previous install must not grant anything.
    expect(
      canEditJob(mode({ wrapperInstalled: false, allowlistedJobs: ['Nightly load'] }), {
        name: 'Nightly load',
        ownerLoginName: 'sa',
      }),
    ).toBe(false);
  });

  it('matches owner and job name case-insensitively', () => {
    // SQL Server logins are case-insensitive, and so is the default collation
    // sp_update_job matches the job name under. Comparing exactly would refuse
    // edits that SQL Server would have accepted.
    expect(
      canEditJob(mode({ sqlLoginName: 'corp\\sqlagent-svc' }), {
        name: 'x',
        ownerLoginName: 'CORP\\SQLAGENT-SVC',
      }),
    ).toBe(true);
    expect(
      canEditJob(mode({ wrapperInstalled: true, allowlistedJobs: ['NIGHTLY LOAD'] }), {
        name: 'Nightly load',
        ownerLoginName: 'sa',
      }),
    ).toBe(true);
  });

  it('refuses when the owner is unknown', () => {
    // A job whose owner_sid maps to no login reads as null. Treating that as a
    // match would make every orphaned job editable.
    expect(canEditJob(mode(), { name: 'Nightly load', ownerLoginName: null })).toBe(false);
  });
});
