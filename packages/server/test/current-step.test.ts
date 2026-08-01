import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicaliseJobWithHash, type JobDefinition } from '@remote-sql-agent/protocol';
import type { Database } from '../src/db/client.js';
import { getJobStats } from '../src/domain/stats.js';
import { jobActivity, jobHistory, jobVersions, jobs } from '../src/db/schema.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';

/**
 * Which step the job page says is running.
 *
 * `sysjobactivity.last_executed_step_id` is the step that **finished**, and it
 * is 0 for the whole of the first step because nothing has finished yet.
 * Publishing it as the current step named the step one behind, and named
 * nothing at all at the start of every run.
 *
 * CLAUDE.md is explicit that this has to be answered once and shared, because
 * two implementations drift and the symptom is one screen contradicting
 * another. `getRunningJobs` already derived it from the definition; this is the
 * caller that did not.
 */

let db: Database;
let close: () => Promise<void>;
let instanceId: string;

const JOB_UUID = '11111111-1111-4111-8111-111111111111';
const STARTED = new Date('2026-08-01T02:00:00Z');

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('current_step'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
  ({ instanceId } = await seedInstance(db));
});

function threeStepJob(): JobDefinition {
  const base = {
    schemaVersion: 'JobDefinition.v1',
    name: 'Nightly Maintenance',
    description: null,
    enabled: true,
    categoryName: null,
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
    steps: [1, 2, 3].map((stepId) => ({
      stepId,
      name: `Step ${stepId}`,
      subsystem: 'TSQL',
      command: 'SELECT 1;',
      databaseName: 'master',
      databaseUserName: null,
      onSuccessAction: stepId === 3 ? 1 : 3,
      onSuccessStepId: 0,
      onFailAction: 2,
      onFailStepId: 0,
      retryAttempts: 0,
      retryIntervalMinutes: 0,
      outputFileName: null,
      flags: 0,
      proxyName: null,
    })),
    schedules: [],
    targetServers: [],
  };
  return base as unknown as JobDefinition;
}

/**
 * A job mid-run.
 *
 * `lastExecutedStepId` is what msdb reports and what the old code published —
 * deliberately set to the *finished* step so the difference is visible.
 */
async function runningJob(options: { finishedSteps: number[]; lastExecutedStepId: number }) {
  const definition = threeStepJob();
  const { canonicalJson, hash } = canonicaliseJobWithHash(definition);

  await db.insert(jobs).values({
    instanceId,
    jobUuid: JOB_UUID,
    name: definition.name,
    currentVersionNo: 1,
    currentDefinitionHash: hash,
  });
  await db.insert(jobVersions).values({
    instanceId,
    jobUuid: JOB_UUID,
    versionNo: 1,
    definition: JSON.parse(canonicalJson) as never,
    definitionHash: hash,
    origin: 'initial',
  });
  await db.insert(jobActivity).values({
    instanceId,
    jobUuid: JOB_UUID,
    state: 'executing',
    startedAt: STARTED,
    currentStepId: options.lastExecutedStepId,
    currentStepName: `Step ${options.lastExecutedStepId}`,
  });

  for (const stepId of options.finishedSteps) {
    await db.insert(jobHistory).values({
      instanceId,
      jobUuid: JOB_UUID,
      sqlInstanceId: stepId,
      stepId,
      stepName: `Step ${stepId}`,
      runStatus: 1,
      runDatetime: new Date(STARTED.getTime() + stepId * 1000),
      runDurationSeconds: 1,
    });
  }

  return getJobStats(db, instanceId, JOB_UUID, { now: new Date(STARTED.getTime() + 60_000) });
}

describe('the step a running job is on', () => {
  it('is the one after the last to finish, not the one that finished', async () => {
    // msdb says step 1 finished; the job is therefore on step 2.
    const stats = await runningJob({ finishedSteps: [1], lastExecutedStepId: 1 });
    expect(stats.currentRun!.currentStepId).toBe(2);
    expect(stats.currentRun!.currentStepName).toBe('Step 2');
  });

  it('is the first step before anything has finished', async () => {
    // The case msdb cannot express: `last_executed_step_id` is 0 for the whole
    // of the first step, so the job page named no step at all during it.
    const stats = await runningJob({ finishedSteps: [], lastExecutedStepId: 0 });
    expect(stats.currentRun!.currentStepId).toBe(1);
    expect(stats.currentRun!.currentStepName).toBe('Step 1');
  });

  it('is null once the last step has finished, because nothing is running', async () => {
    const stats = await runningJob({ finishedSteps: [1, 2, 3], lastExecutedStepId: 3 });
    expect(stats.currentRun!.currentStepId).toBeNull();
    expect(stats.currentRun!.currentStepName).toBeNull();
  });

  it('agrees with what the overview derives for the same run', async () => {
    // The property CLAUDE.md actually asks for: one answer, not two. If these
    // ever diverge, one screen is contradicting another.
    const { getRunningJobs } = await import('../src/domain/overview.js');
    const stats = await runningJob({ finishedSteps: [1], lastExecutedStepId: 1 });
    const running = await getRunningJobs(db, new Date(STARTED.getTime() + 60_000));

    const overview = running.find((r) => r.jobUuid === JOB_UUID);
    expect(overview?.currentStepId).toBe(stats.currentRun!.currentStepId);
  });
});
