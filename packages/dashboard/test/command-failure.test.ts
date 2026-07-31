import { describe, expect, it } from 'vitest';
import { explainCommandFailure, type CommandRow } from '../src/api.js';

/**
 * A job save that fails on the SQL host used to be reported as success: the
 * editor announced "Saved and sent to the worker." when the command was merely
 * queued, and never revisited it. For a product whose premise is that the
 * dashboard tells you the truth about the estate, a false "Saved" is the worst
 * failure available.
 *
 * These pin the wording an operator is given, because the raw SQL Server text
 * describes the rule rather than the way out of it — 14525 in particular says
 * "only members of sysadmin role are allowed", which reads as "grant sysadmin"
 * and is exactly the wrong conclusion.
 */

function command(overrides: Partial<CommandRow>): CommandRow {
  return {
    id: 'c1',
    type: 'upsertJob',
    state: 'failed',
    instanceId: 'i1',
    instanceName: 'MSSQLSERVER',
    hostName: 'SQL01',
    jobUuid: 'j1',
    jobName: 'Nightly load',
    payload: {},
    issuedBy: 'alice',
    approvedBy: null,
    resultCode: 'SqlError',
    resultDetail: null,
    sqlErrorNumber: null,
    issuedAt: '2026-07-31T00:00:00Z',
    completedAt: '2026-07-31T00:00:01Z',
    expiresAt: null,
    ...overrides,
  } as CommandRow;
}

describe('explainCommandFailure', () => {
  it('explains a job-ownership refusal without implying sysadmin is the fix', () => {
    const message = explainCommandFailure(
      command({
        sqlErrorNumber: 14525,
        resultDetail:
          'Only members of sysadmin role are allowed to update or delete jobs owned by a different login.',
      }),
    );
    expect(message).toMatch(/owned by a different login/iu);
    // The reassurance that matters most: an operator seeing a save fail needs to
    // know the job was not left half-edited.
    expect(message).toMatch(/nothing was changed/iu);
    // Enable/disable genuinely still works on jobs the worker does not own —
    // SQL Server carves that out — so the message must not imply otherwise.
    expect(message).toMatch(/enable and disable still work/iu);
  });

  it('keeps SQL Server’s own wording for failures with no specific remedy', () => {
    // A DBA will want the verbatim text to search for; paraphrasing it loses them.
    const message = explainCommandFailure(
      command({ resultDetail: 'Invalid object name msdb.dbo.sysjobsteps.' }),
    );
    expect(message).toContain('Invalid object name msdb.dbo.sysjobsteps.');
  });

  it('says nothing was changed when a command expired unapplied', () => {
    const message = explainCommandFailure(command({ state: 'expired', resultCode: 'Expired' }));
    expect(message).toMatch(/nothing was changed/iu);
  });

  it('reports a capability refusal in the worker’s own words', () => {
    const message = explainCommandFailure(
      command({
        resultCode: 'CapabilityDenied',
        resultDetail: 'This worker is not permitted to job.write.',
      }),
    );
    expect(message).toBe('This worker is not permitted to job.write.');
  });

  it('still explains a failure that carried no detail at all', () => {
    // The worker can die mid-apply and report nothing useful; the operator
    // still needs to be told the save did not land.
    const message = explainCommandFailure(command({ resultDetail: null }));
    expect(message).toMatch(/could not apply/iu);
    expect(message).not.toMatch(/undefined|null/iu);
  });
});
