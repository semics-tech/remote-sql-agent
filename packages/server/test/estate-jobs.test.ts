import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db/client.js';
import { instances, jobActivity, jobHistory, jobs } from '../src/db/schema.js';
import { listEstateJobs, type JobFacet } from '../src/domain/overview.js';
import { setupTestDatabase, seedInstance, tagInstance, truncateAll } from './helpers/db.js';
import { eq } from 'drizzle-orm';

/**
 * The estate-wide job list behind the overview filters.
 *
 * The property worth pinning is that the facet counts and the filtered rows
 * cannot disagree. A chip reading "3 failed" that yields two rows when clicked
 * is the kind of thing that makes people stop trusting the page, and it is easy
 * to introduce by filtering in one place and counting in another.
 */

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('estate_jobs'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

const RUN_FAILED = 0;
const RUN_SUCCEEDED = 1;

let seq = 0;
function nextUuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

async function seedJob(
  instanceId: string,
  name: string,
  overrides: Partial<{
    enabled: boolean;
    isDrifted: boolean;
    lastRunStatus: number | null;
    lastRunAt: Date | null;
  }> = {},
): Promise<string> {
  const jobUuid = nextUuid();
  await db.insert(jobs).values({
    instanceId,
    jobUuid,
    name,
    enabled: overrides.enabled ?? true,
    isDrifted: overrides.isDrifted ?? false,
    // `in` rather than `??`, so an explicit null means "never run" instead of
    // falling through to the default the way a nullish coalesce would.
    lastRunStatus: 'lastRunStatus' in overrides ? overrides.lastRunStatus : RUN_SUCCEEDED,
    lastRunAt: 'lastRunAt' in overrides ? overrides.lastRunAt : new Date('2026-07-31T02:00:00Z'),
  });
  return jobUuid;
}

/** Mark a job executing, started `elapsed` seconds before `now`. */
async function markRunning(
  instanceId: string,
  jobUuid: string,
  now: Date,
  elapsedSeconds: number,
): Promise<void> {
  await db.insert(jobActivity).values({
    instanceId,
    jobUuid,
    state: 'executing',
    startedAt: new Date(now.getTime() - elapsedSeconds * 1000),
  });
}

/** Enough successful runs for a duration baseline to exist (three is the floor). */
async function seedBaseline(
  instanceId: string,
  jobUuid: string,
  durationSeconds: number,
  now: Date,
): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await db.insert(jobHistory).values({
      instanceId,
      jobUuid,
      sqlInstanceId: seq * 1000 + i,
      stepId: 0,
      runStatus: RUN_SUCCEEDED,
      runDatetime: new Date(now.getTime() - (i + 1) * 24 * 60 * 60 * 1000),
      runDurationSeconds: durationSeconds,
    });
  }
}

const facetsFor = (result: { jobs: Array<{ jobName: string; facets: JobFacet[] }> }, name: string) =>
  result.jobs.find((j) => j.jobName === name)?.facets ?? [];

describe('facets', () => {
  it('describes each job by everything true of it, not one status', async () => {
    const { instanceId } = await seedInstance(db);
    await seedJob(instanceId, 'Healthy');
    await seedJob(instanceId, 'Broken', { lastRunStatus: RUN_FAILED });
    await seedJob(instanceId, 'Never', { lastRunStatus: null, lastRunAt: null });
    await seedJob(instanceId, 'Off', { enabled: false, lastRunStatus: RUN_FAILED });

    const result = await listEstateJobs(db);

    expect(facetsFor(result, 'Healthy')).toEqual(['succeeded']);
    expect(facetsFor(result, 'Broken')).toEqual(['failed']);
    expect(facetsFor(result, 'Never')).toEqual(['neverRun']);
    // Both, and in one row: a disabled job whose last run failed is not "just
    // disabled", and collapsing it to a single status would have to pick one.
    expect(facetsFor(result, 'Off')).toEqual(['failed', 'disabled']);
  });

  it('marks a run long only against that job\'s own history', async () => {
    const now = new Date('2026-07-31T09:00:00Z');
    const { instanceId } = await seedInstance(db);

    // Normally two hours, running for two hours: not long.
    const steady = await seedJob(instanceId, 'Steady');
    await seedBaseline(instanceId, steady, 7200, now);
    await markRunning(instanceId, steady, now, 7200);

    // Normally ten seconds, running for an hour: long.
    const quick = await seedJob(instanceId, 'Quick');
    await seedBaseline(instanceId, quick, 10, now);
    await markRunning(instanceId, quick, now, 3600);

    const result = await listEstateJobs(db, { now });

    expect(facetsFor(result, 'Steady')).toContain('running');
    expect(facetsFor(result, 'Steady')).not.toContain('longRunning');
    expect(facetsFor(result, 'Quick')).toEqual(expect.arrayContaining(['running', 'longRunning']));
  });
});

describe('filtering', () => {
  async function estate() {
    const { instanceId } = await seedInstance(db);
    await seedJob(instanceId, 'Alpha');
    await seedJob(instanceId, 'Beta', { lastRunStatus: RUN_FAILED });
    await seedJob(instanceId, 'Gamma', { lastRunStatus: RUN_FAILED });
    await seedJob(instanceId, 'Delta', { enabled: false });
    await seedJob(instanceId, 'Epsilon', { isDrifted: true });
    return instanceId;
  }

  it('returns everything when nothing is selected', async () => {
    await estate();
    const result = await listEstateJobs(db);
    expect(result.jobs).toHaveLength(5);
    expect(result.total).toBe(5);
    expect(result.matched).toBe(5);
  });

  it('treats several selected facets as "any of these"', async () => {
    await estate();
    const result = await listEstateJobs(db, { facets: ['failed', 'disabled'] });
    expect(result.jobs.map((j) => j.jobName).sort()).toEqual(['Beta', 'Delta', 'Gamma']);
  });

  it('counts every facet regardless of which are selected', async () => {
    await estate();
    const all = await listEstateJobs(db);
    const filtered = await listEstateJobs(db, { facets: ['failed'] });

    // The chips must not renumber themselves as they are clicked: a "disabled"
    // chip that drops to 0 the moment "failed" is ticked reads as the disabled
    // jobs having gone away.
    expect(filtered.counts).toEqual(all.counts);
    expect(filtered.counts.failed).toBe(2);
    expect(filtered.counts.disabled).toBe(1);
    expect(filtered.counts.drifted).toBe(1);
  });

  it('agrees between the count and the rows it yields', async () => {
    await estate();
    const all = await listEstateJobs(db);

    for (const facet of ['failed', 'disabled', 'drifted', 'succeeded'] as JobFacet[]) {
      const only = await listEstateJobs(db, { facets: [facet] });
      expect(only.jobs).toHaveLength(all.counts[facet]);
    }
  });

  it('matches text against the job, host, instance, category and environment', async () => {
    const { instanceId } = await seedInstance(db, 'PRODSQL01', 'MSSQLSERVER');
    await tagInstance(db, instanceId, 'production');
    await seedJob(instanceId, 'Nightly Backup');
    await seedJob(instanceId, 'Reindex');

    expect((await listEstateJobs(db, { filter: 'nightly' })).jobs).toHaveLength(1);
    expect((await listEstateJobs(db, { filter: 'prodsql' })).jobs).toHaveLength(2);
    expect((await listEstateJobs(db, { filter: 'production' })).jobs).toHaveLength(2);
    expect((await listEstateJobs(db, { filter: 'staging' })).jobs).toHaveLength(0);
  });

  it('counts only what the text filter matched', async () => {
    const { instanceId } = await seedInstance(db);
    await seedJob(instanceId, 'Nightly Backup', { lastRunStatus: RUN_FAILED });
    await seedJob(instanceId, 'Reindex', { lastRunStatus: RUN_FAILED });

    const result = await listEstateJobs(db, { filter: 'nightly' });
    expect(result.total).toBe(1);
    expect(result.counts.failed).toBe(1);
  });
});

describe('ordering and paging', () => {
  it('puts the jobs worth reading at the top', async () => {
    const { instanceId } = await seedInstance(db);
    await seedJob(instanceId, 'Aardvark');
    await seedJob(instanceId, 'Zebra', { lastRunStatus: RUN_FAILED });
    await seedJob(instanceId, 'Mongoose', { enabled: false });

    // Alphabetical would bury the failure in the middle of the list.
    const result = await listEstateJobs(db);
    expect(result.jobs.map((j) => j.jobName)).toEqual(['Zebra', 'Mongoose', 'Aardvark']);
  });

  it('caps the rows sent without lying about how many matched', async () => {
    const { instanceId } = await seedInstance(db);
    for (let i = 0; i < 10; i += 1) await seedJob(instanceId, `Job ${i}`);

    const result = await listEstateJobs(db, { limit: 3 });
    expect(result.jobs).toHaveLength(3);
    expect(result.returned).toBe(3);
    expect(result.matched).toBe(10);
    expect(result.total).toBe(10);
  });

  it('reports truncation when the estate is larger than one scan', async () => {
    const { instanceId } = await seedInstance(db);
    for (let i = 0; i < 5; i += 1) await seedJob(instanceId, `Job ${i}`);

    const result = await listEstateJobs(db, { scanLimit: 3 });
    expect(result.truncated).toBe(true);
    expect((await listEstateJobs(db, { scanLimit: 50 })).truncated).toBe(false);
  });
});

describe('what the estate view excludes', () => {
  it('leaves out deleted jobs and detached instances', async () => {
    const { instanceId } = await seedInstance(db);
    const gone = await seedJob(instanceId, 'Deleted');
    await seedJob(instanceId, 'Live');
    await db.update(jobs).set({ deletedAt: new Date() }).where(eq(jobs.jobUuid, gone));

    expect((await listEstateJobs(db)).jobs.map((j) => j.jobName)).toEqual(['Live']);

    await db.update(instances).set({ detachedAt: new Date() }).where(eq(instances.id, instanceId));
    expect((await listEstateJobs(db)).jobs).toHaveLength(0);
  });
});
