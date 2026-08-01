import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicaliseJobWithHash, type JobDefinition } from '@remote-sql-agent/protocol';
import type { Database } from '../src/db/client.js';
import { searchJobs } from '../src/domain/queries.js';
import { recordJobVersion } from '../src/domain/versioning.js';
import { setupTestDatabase, truncateAll, seedInstance } from './helpers/db.js';

/**
 * `searchJobs` matches in Postgres (`ILIKE`, across both the job name and
 * every step body) and then recomputes `nameMatched` and `matchingSteps` in
 * Node, from the same query, to tell the caller *why* a row was returned.
 * Those two computations agreeing is not automatic — `%` and `_` are ILIKE
 * wildcards but plain characters to `String.includes`, and a search term
 * containing either would disagree if the SQL side were not escaping it. No
 * test exercised any of this before.
 */

let db: Database;
let close: () => Promise<void>;
let instanceId: string;

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('search_jobs'));
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

async function seedJob(jobUuid: string, definition: JobDefinition): Promise<void> {
  const { canonicalJson, hash } = canonicaliseJobWithHash(definition);
  await recordJobVersion(db, {
    instanceId,
    jobUuid,
    canonicalJson,
    definitionHash: hash,
    origin: 'local',
  });
}

const JOB_PERCENT = '11111111-1111-4111-8111-111111111111';
const JOB_UNDERSCORE = '22222222-2222-4222-8222-222222222222';
const JOB_PLAIN = '33333333-3333-4333-8333-333333333333';

describe('literal % and _ in the search term', () => {
  beforeEach(async () => {
    await seedJob(JOB_PERCENT, job({ name: 'Disk 90% Full Alert' }));
    await seedJob(JOB_UNDERSCORE, job({ name: 'legacy_finance_sync' }));
    await seedJob(JOB_PLAIN, job({ name: 'Weekly Backup' }));
  });

  it('matches "%" as a literal character, not a wildcard', async () => {
    const hits = await searchJobs(db, '90%');
    expect(hits.map((h) => h.jobUuid)).toEqual([JOB_PERCENT]);
    expect(hits[0]!.nameMatched).toBe(true);
  });

  it('matches "_" as a literal character, not a single-character wildcard', async () => {
    // Every job name in this suite has a real character where "_" is, so a
    // wildcard interpretation would match all three instead of just one.
    const hits = await searchJobs(db, 'legacy_finance');
    expect(hits.map((h) => h.jobUuid)).toEqual([JOB_UNDERSCORE]);
    expect(hits[0]!.nameMatched).toBe(true);
  });

  it('every row SQL selects on a name match, Node also reports nameMatched', async () => {
    for (const term of ['90%', 'legacy_finance_sync', 'Weekly Backup', 'FULL']) {
      const hits = await searchJobs(db, term);
      for (const hit of hits) {
        expect(hit.nameMatched).toBe(hit.jobName.toLowerCase().includes(term.toLowerCase()));
      }
    }
  });
});

describe('step body search', () => {
  it('finds a job by step command text and reports which step matched', async () => {
    const jobUuid = '44444444-4444-4444-8444-444444444444';
    await seedJob(
      jobUuid,
      job({
        name: 'Unrelated Name',
        steps: [
          {
            stepId: 1,
            name: 'Connect',
            subsystem: 'TSQL',
            command: "EXEC sp_addlinkedserver 'LEGACYFIN01';",
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
      }),
    );

    const hits = await searchJobs(db, 'LEGACYFIN01');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.nameMatched).toBe(false);
    expect(hits[0]!.matchingSteps).toEqual([
      expect.objectContaining({ stepId: 1, stepName: 'Connect' }),
    ]);
  });
});
