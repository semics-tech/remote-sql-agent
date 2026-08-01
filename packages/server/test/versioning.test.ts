import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc } from 'drizzle-orm';
import { canonicaliseJobWithHash, type JobDefinition } from '@remote-sql-agent/protocol';
import type { Database } from '../src/db/client.js';
import { jobs } from '../src/db/schema.js';
import {
  markJobDeleted,
  markJobsMissingFromSnapshot,
  recordJobVersion,
  getJobVersions,
  acknowledgeDrift,
} from '../src/domain/versioning.js';
import { setupTestDatabase, truncateAll, seedInstance } from './helpers/db.js';

let db: Database;
let close: () => Promise<void>;
let instanceId: string;

const JOB_A = '11111111-1111-4111-8111-111111111111';
const JOB_B = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  const setup = await setupTestDatabase('versioning');
  db = setup.db;
  close = setup.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
  ({ instanceId } = await seedInstance(db));
});

function job(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    schemaVersion: 'JobDefinition.v1',
    name: 'Nightly Maintenance',
    description: null,
    enabled: true,
    categoryName: 'Maintenance',
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
    steps: [
      {
        stepId: 1,
        name: 'Run',
        subsystem: 'TSQL',
        command: 'SELECT 1;',
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
      },
    ],
    schedules: [],
    targetServers: [],
    ...overrides,
  };
}

async function record(
  definition: JobDefinition,
  origin: 'local' | 'remote' = 'local',
  jobUuid = JOB_A,
  commandId: string | null = null,
) {
  const { canonicalJson, hash } = canonicaliseJobWithHash(definition);
  return recordJobVersion(db, {
    instanceId,
    jobUuid,
    canonicalJson,
    definitionHash: hash,
    origin,
    commandId,
  });
}

describe('first observation', () => {
  it('records version 1 as "initial", not as drift', () => {
    // Flagging every job as drifted on first contact would make the badge
    // meaningless — the job existed before the control plane did.
    return record(job()).then((result) => {
      expect(result).toMatchObject({ changed: true, versionNo: 1, isDrift: false });
    });
  });

  it('stores the parsed definition', async () => {
    await record(job());
    const versions = await getJobVersions(db, instanceId, JOB_A);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.origin).toBe('initial');
    expect((versions[0]!.definition as JobDefinition).name).toBe('Nightly Maintenance');
  });
});

describe('idempotency', () => {
  it('does not create a version when the hash is unchanged', async () => {
    await record(job());
    const second = await record(job());
    expect(second).toMatchObject({ changed: false, versionNo: 1 });
    expect(await getJobVersions(db, instanceId, JOB_A)).toHaveLength(1);
  });

  it('is unmoved by a re-observation that differs only in line endings', async () => {
    // The worker re-sends a full snapshot on every reconnect; if canonical
    // normalisation were not idempotent, every reconnect would fake a drift.
    await record(job());
    const result = await record(
      job({ steps: [{ ...job().steps[0]!, command: 'SELECT 1;\r\n' }] }),
    );
    expect(result.changed).toBe(false);
  });

  it('allocates strictly increasing version numbers under concurrency', async () => {
    await record(job());
    // Ten different definitions recorded at once must not collide on
    // version_no; the row lock plus the unique index is what guarantees it.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => record(job({ description: `change ${i}` }))),
    );
    const versions = await getJobVersions(db, instanceId, JOB_A);
    const numbers = versions.map((v) => v.versionNo).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers[0]).toBe(1);
  });
});

describe('drift attribution', () => {
  it('flags an on-premise change as drift', async () => {
    await record(job());
    const result = await record(job({ enabled: false }));
    expect(result).toMatchObject({ changed: true, versionNo: 2, isDrift: true });

    const versions = await getJobVersions(db, instanceId, JOB_A);
    expect(versions[0]!.origin).toBe('local');
  });

  it('does not flag a change the worker attributes to a command', async () => {
    // Otherwise an operator's own dashboard edit would come back moments later
    // reported as someone meddling in SSMS.
    await record(job());
    const commandId = '33333333-3333-4333-8333-333333333333';
    const result = await record(job({ enabled: false }), 'remote', JOB_A, commandId);

    expect(result.isDrift).toBe(false);
    const versions = await getJobVersions(db, instanceId, JOB_A);
    expect(versions[0]!.origin).toBe('remote');
    expect(versions[0]!.commandId).toBe(commandId);
  });

  it('clears the drift flag when acknowledged', async () => {
    await record(job());
    await record(job({ enabled: false }));
    await acknowledgeDrift(db, instanceId, JOB_A);

    const [row] = await db.execute(
      `SELECT is_drifted FROM jobs WHERE job_uuid = '${JOB_A}'` as never,
    );
    expect((row as { is_drifted: boolean }).is_drifted).toBe(false);
  });
});

describe('snapshot reconciliation', () => {
  it('soft-deletes jobs absent from a complete snapshot', async () => {
    await record(job(), 'local', JOB_A);
    await record(job({ name: 'Second job' }), 'local', JOB_B);

    const removed = await markJobsMissingFromSnapshot(db, instanceId, [JOB_A]);
    expect(removed).toBe(1);

    const [row] = await db.execute(
      `SELECT deleted_at FROM jobs WHERE job_uuid = '${JOB_B}'` as never,
    );
    expect((row as { deleted_at: Date | null }).deleted_at).not.toBeNull();
  });

  it('soft-deletes everything when the snapshot is empty', async () => {
    // An instance that legitimately has no jobs any more must not be treated as
    // "no information".
    await record(job(), 'local', JOB_A);
    expect(await markJobsMissingFromSnapshot(db, instanceId, [])).toBe(1);
  });

  it('deletes only the named job, leaving the rest of the instance alone', async () => {
    // The distinction the hub got wrong: a single `deleted` delta reached
    // `markJobsMissingFromSnapshot(db, instanceId, [])`, whose documented
    // meaning is "this instance has no jobs any more", so one deleted job took
    // every other job on the instance with it. Reconciling a whole instance is
    // only ever correct from a *complete* snapshot.
    await record(job(), 'local', JOB_A);
    await record(job({ name: 'Second job' }), 'local', JOB_B);

    await markJobDeleted(db, instanceId, JOB_A);

    const rows = await db
      .select({ jobUuid: jobs.jobUuid, deletedAt: jobs.deletedAt })
      .from(jobs)
      .orderBy(asc(jobs.jobUuid));
    expect(rows.filter((r) => r.deletedAt !== null).map((r) => r.jobUuid)).toEqual([JOB_A]);
  });

  it('preserves history and versions through a soft delete', async () => {
    await record(job(), 'local', JOB_A);
    await record(job({ enabled: false }), 'local', JOB_A);
    await markJobsMissingFromSnapshot(db, instanceId, []);

    // The control plane is the record of history; deleting on-prem must not
    // destroy what it recorded.
    expect(await getJobVersions(db, instanceId, JOB_A)).toHaveLength(2);
  });

  it('revives a job that reappears', async () => {
    await record(job(), 'local', JOB_A);
    await markJobsMissingFromSnapshot(db, instanceId, []);
    await record(job(), 'local', JOB_A);

    const [row] = await db.execute(
      `SELECT deleted_at FROM jobs WHERE job_uuid = '${JOB_A}'` as never,
    );
    expect((row as { deleted_at: Date | null }).deleted_at).toBeNull();
  });
});
