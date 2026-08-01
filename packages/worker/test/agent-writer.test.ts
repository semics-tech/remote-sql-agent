import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What actually gets bound when the worker writes to a customer's msdb.
 *
 * This is the only code in the repository that mutates somebody else's SQL
 * Server, it is CODEOWNERS-gated, and it had no dedicated test — the integration
 * suite exercises it end to end, but only against the happy path and only when
 * a SQL Server container is available.
 *
 * The bugs worth catching here are all *parameter* bugs: a NULL where a value
 * belonged, a value that never reached the procedure at all. Those are visible
 * without a database, and asserting them here means they are checked on every
 * run rather than on the runs that have Docker.
 */

interface Recorded {
  procedure: string;
  inputs: Record<string, unknown>;
}

const recorded: Recorded[] = [];
/** Rows the next `.query()` should return, in call order. */
let queryResults: unknown[][] = [];

class FakeRequest {
  #inputs: Record<string, unknown> = {};
  #outputs: Record<string, unknown> = {};

  input(name: string, _type: unknown, value?: unknown): this {
    // mssql allows input(name, value) as well as input(name, type, value).
    this.#inputs[name] = value === undefined ? _type : value;
    return this;
  }

  /** Declares an output parameter; the value comes back on the *result*. */
  output(name: string): this {
    this.#outputs[name] = undefined;
    return this;
  }

  execute(procedure: string) {
    recorded.push({ procedure, inputs: { ...this.#inputs } });
    // sp_add_job hands back the id msdb allocated. Deliberately upper case:
    // the caller lowercases it, and asserting that is part of the contract.
    if (procedure.endsWith('sp_add_job')) {
      this.#outputs.job_id = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
    }
    return Promise.resolve({ output: this.#outputs, recordset: [] });
  }

  query(text: string) {
    recorded.push({ procedure: `query:${text.replace(/\s+/gu, ' ').trim()}`, inputs: { ...this.#inputs } });
    return Promise.resolve({ recordset: queryResults.shift() ?? [] });
  }
}

const commit = vi.fn(() => Promise.resolve());
const rollback = vi.fn(() => Promise.resolve());

vi.mock('mssql', () => {
  const request = function (this: unknown) {
    return new FakeRequest();
  } as unknown as new () => FakeRequest;

  const types = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === 'Request') return request;
        if (prop === 'MAX') return -1;
        // Every type constructor — NVarChar(128), Int, TinyInt — is irrelevant
        // to what is asserted here, so they all collapse to a marker.
        return (...args: unknown[]) => ({ type: String(prop), args });
      },
    },
  );

  return { default: types, ...(types as object) };
});

const { upsertJob } = await import('../src/sql/agent-writer.js');

const pool = {
  transaction: () => ({
    begin: () => Promise.resolve(),
    commit,
    rollback,
  }),
} as never;

const JOB_UUID = '11111111-1111-4111-8111-111111111111';

function baseStep() {
  return {
    stepId: 1,
    name: 'Rebuild',
    subsystem: 'TSQL',
    command: 'EXEC dbo.usp_Reindex;',
    databaseName: 'master',
    databaseUserName: null,
    onSuccessAction: 1,
    onSuccessStepId: 0,
    onFailAction: 2,
    onFailStepId: 0,
    retryAttempts: 0,
    retryIntervalMinutes: 0,
    outputFileName: null,
    flags: 0,
    proxyName: null,
  };
}

function definition(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'JobDefinition.v1',
    name: 'Nightly Maintenance',
    description: 'Rebuilds indexes.',
    enabled: true,
    categoryName: 'Database Maintenance',
    ownerLoginName: 'sa',
    startStepId: 1,
    notifications: {
      emailOperatorName: null,
      emailLevel: 0,
      netsendOperatorName: null,
      netsendLevel: 0,
      pageOperatorName: null,
      pageLevel: 0,
      eventlogLevel: 2,
      deleteLevel: 0,
    },
    steps: [baseStep()],
    schedules: [],
    targetServers: [],
    ...overrides,
  } as never;
}

/** The one call to a given procedure, or the first if there are several. */
function call(procedure: string): Recorded | undefined {
  return recorded.find((r) => r.procedure.endsWith(procedure));
}

beforeEach(() => {
  recorded.length = 0;
  queryResults = [];
  commit.mockClear();
  rollback.mockClear();
});

describe('updating a job that already exists', () => {
  /** `jobExists` returns true, then `reconcileJobSchedules` sees no schedules. */
  function existingJob() {
    queryResults = [[{ present: 1 }], []];
  }

  it('clears a description rather than silently leaving the old one', async () => {
    existingJob();
    await upsertJob(pool, JOB_UUID, definition({ description: null }));

    // The bug: `sp_update_job` reads NULL as "leave this alone", so passing
    // NULL made clearing a description a no-op. The operator was told the save
    // succeeded, msdb kept the old text, and the next poll reported their own
    // edit back as on-prem drift — permanently, since every retry repeated it.
    expect(call('sp_update_job')?.inputs.description).toBe('');
  });

  it('clears a category the same way', async () => {
    existingJob();
    await upsertJob(pool, JOB_UUID, definition({ categoryName: null }));
    expect(call('sp_update_job')?.inputs.category_name).toBe('');
  });

  it('still passes a real description through unchanged', async () => {
    existingJob();
    await upsertJob(pool, JOB_UUID, definition({ description: 'Rebuilds indexes.' }));
    expect(call('sp_update_job')?.inputs.description).toBe('Rebuilds indexes.');
  });

  it('leaves the owner NULL when it is not set, because "" is not a login', async () => {
    // Not the same case: SQL Server requires a valid login here and rejects an
    // empty string, so NULL genuinely is how you say "leave the owner alone".
    existingJob();
    await upsertJob(pool, JOB_UUID, definition({ ownerLoginName: null }));
    expect(call('sp_update_job')?.inputs.owner_login_name).toBeNull();
  });

  it('replaces every step rather than diffing them', async () => {
    existingJob();
    await upsertJob(pool, JOB_UUID, definition());

    // `sp_delete_jobstep` with step_id 0 is the documented "all steps" form.
    // Diffing would have to track ids that shift under every deletion, and is
    // wrong in exactly the case that matters — a step removed from the middle
    // of a branching job.
    expect(call('sp_delete_jobstep')?.inputs.step_id).toBe(0);
    expect(call('sp_add_jobstep')?.inputs.step_name).toBe('Rebuild');
  });

  it('binds the step body as a parameter, never into the statement', async () => {
    existingJob();
    const command = "EXEC dbo.usp_Thing @arg = N'; DROP TABLE dbo.T; --';";
    await upsertJob(pool, JOB_UUID, definition({ steps: [{ ...baseStep(), command }] }));

    expect(call('sp_add_jobstep')?.inputs.command).toBe(command);
    // Nothing that reaches the server may carry the body inside its text.
    expect(recorded.every((r) => !r.procedure.includes('DROP TABLE'))).toBe(true);
  });

  it('commits once, and does not add a job server to a job that already had one', async () => {
    existingJob();
    await upsertJob(pool, JOB_UUID, definition());

    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(call('sp_add_jobserver')).toBeUndefined();
  });
});

describe('creating a job that does not exist', () => {
  function missingJob() {
    queryResults = [[], []];
  }

  it('reports the uuid msdb allocated, not the one it was asked for', async () => {
    missingJob();
    const result = await upsertJob(pool, JOB_UUID, definition());

    // `sp_add_job` has no input job id — msdb allocates it — so an upsert with
    // `allowOverwrite` against a job that was deleted on-prem creates a *new*
    // job under a new uuid rather than restoring the old one. That is a real
    // gap (the operator pressed the button they were told to press for a
    // conflict, and got a duplicate) and needs a product decision: refuse, or
    // adopt the new id. Pinned here so the current behaviour is at least known.
    expect(result.created).toBe(true);
    expect(result.jobUuid).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(result.jobUuid).not.toBe(JOB_UUID);
  });

  it('attaches a job server, without which the local Agent will not run it', async () => {
    missingJob();
    await upsertJob(pool, JOB_UUID, definition());
    expect(call('sp_add_jobserver')?.inputs.server_name).toBe('(LOCAL)');
  });

  it('sets the start step only after the steps it names exist', async () => {
    missingJob();
    await upsertJob(pool, JOB_UUID, definition());

    const addStep = recorded.findIndex((r) => r.procedure.endsWith('sp_add_jobstep'));
    const setStart = recorded.findIndex(
      (r) => r.procedure.endsWith('sp_update_job') && 'start_step_id' in r.inputs,
    );
    expect(addStep).toBeGreaterThanOrEqual(0);
    expect(setStart).toBeGreaterThan(addStep);
  });
});
