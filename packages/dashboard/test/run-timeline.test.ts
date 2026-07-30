import { describe, expect, it } from 'vitest';
import type { JobDefinition, JobStep } from '@remote-sql-agent/protocol/browser';
import { StepAction } from '@remote-sql-agent/protocol/browser';
import { buildHistoricRun, buildLiveRun } from '../src/pages/RunTimeline.js';
import type { HistoryRun, JobStats } from '../src/api.js';

/**
 * Timeline arithmetic.
 *
 * Worth testing precisely because a wrong chart still looks like a chart: bars
 * in plausible places that misreport when a step ran are worse than no chart at
 * all, since nobody thinks to doubt them.
 */

const RUN_START = '2026-07-30T07:43:33.000Z';
const RUN_START_MS = Date.parse(RUN_START);

function step(overrides: Partial<JobStep> = {}): JobStep {
  return {
    stepId: 1,
    name: 'Step',
    subsystem: 'TSQL',
    command: 'SELECT 1;',
    databaseName: 'master',
    databaseUserName: null,
    onSuccessAction: StepAction.GoToNextStep,
    onSuccessStepId: 0,
    onFailAction: StepAction.QuitWithFailure,
    onFailStepId: 0,
    retryAttempts: 0,
    retryIntervalMinutes: 0,
    outputFileName: null,
    flags: 0,
    proxyName: null,
    ...overrides,
  };
}

function definition(steps: JobStep[], startStepId = 1): JobDefinition {
  return {
    schemaVersion: 'JobDefinition.v1',
    name: 'ZZ Timeline Probe',
    description: null,
    enabled: true,
    categoryName: null,
    ownerLoginName: 'sa',
    startStepId,
    notifications: {
      emailOperatorName: null,
      emailLevel: 0,
      netsendOperatorName: null,
      netsendLevel: 0,
      pageOperatorName: null,
      pageLevel: 0,
      eventlogLevel: 0,
      deleteLevel: 0,
    },
    steps,
    schedules: [],
    targetServers: [],
  };
}

const THREE_STEPS = definition([
  step({ stepId: 1, name: 'Extract' }),
  step({ stepId: 2, name: 'Transform' }),
  step({ stepId: 3, name: 'Load', onSuccessAction: StepAction.QuitWithSuccess }),
]);

type CompletedStep = NonNullable<JobStats['currentRun']>['completedSteps'][number];

function completed(overrides: Partial<CompletedStep> = {}): CompletedStep {
  return {
    stepId: 1,
    stepName: 'Extract',
    runStatus: 1,
    startedAt: RUN_START,
    runDurationSeconds: 8,
    message: null,
    ...overrides,
  };
}

function stats(completedSteps: CompletedStep[]): JobStats {
  return {
    windowDays: 90,
    totalRuns: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    retried: 0,
    successRate: null,
    duration: {
      averageSeconds: null,
      medianSeconds: null,
      p95Seconds: null,
      minSeconds: null,
      maxSeconds: null,
      lastSeconds: null,
      trend: null,
    },
    recentRuns: [],
    steps: [],
    currentRun: {
      startedAt: RUN_START,
      elapsedSeconds: null,
      // Deliberately the *last finished* step, which is what msdb reports —
      // nothing here may treat it as the running one.
      currentStepId: completedSteps.at(-1)?.stepId ?? null,
      currentStepName: completedSteps.at(-1)?.stepName ?? null,
      completedSteps,
    },
  };
}

// The flow inference itself lives in the protocol package and is tested
// there (test/job-flow.test.ts). What remains here is the timeline
// arithmetic built on top of it.

describe('buildLiveRun', () => {
  it('draws the running step from the start of the run', () => {
    const run = buildLiveRun(THREE_STEPS, stats([]), RUN_START_MS + 5_000);

    expect(run?.steps).toHaveLength(1);
    expect(run?.steps[0]).toMatchObject({
      stepId: 1,
      offsetSeconds: 0,
      durationSeconds: 5,
      running: true,
    });
  });

  it('places each finished step at its own recorded start', () => {
    const run = buildLiveRun(
      THREE_STEPS,
      stats([
        completed({ stepId: 1, stepName: 'Extract', startedAt: RUN_START, runDurationSeconds: 8 }),
        completed({
          stepId: 2,
          stepName: 'Transform',
          startedAt: new Date(RUN_START_MS + 9_000).toISOString(),
          runDurationSeconds: 12,
        }),
      ]),
      RUN_START_MS + 24_000,
    );

    // Offsets come from msdb's own timestamps, not from stacking durations —
    // a gap between steps is real and must survive into the chart.
    expect(run?.steps[0]).toMatchObject({ stepId: 1, offsetSeconds: 0, durationSeconds: 8 });
    expect(run?.steps[1]).toMatchObject({ stepId: 2, offsetSeconds: 9, durationSeconds: 12 });
    // Step 3 is inferred as running, starting where step 2 ended.
    expect(run?.steps[2]).toMatchObject({ stepId: 3, offsetSeconds: 21, running: true });
  });

  it('grows the running bar with elapsed time', () => {
    const at = (ms: number) => buildLiveRun(THREE_STEPS, stats([]), RUN_START_MS + ms);
    expect(at(3_000)?.steps[0]?.durationSeconds).toBe(3);
    expect(at(30_000)?.steps[0]?.durationSeconds).toBe(30);
  });

  it('adds no running bar once the flow has quit', () => {
    const run = buildLiveRun(
      THREE_STEPS,
      stats([completed({ stepId: 3, stepName: 'Load' })]),
      RUN_START_MS + 30_000,
    );
    expect(run?.steps.filter((s) => s.running)).toHaveLength(0);
  });

  it('returns nothing without a definition or a run in flight', () => {
    expect(buildLiveRun(null, stats([]), RUN_START_MS)).toBeNull();
    expect(buildLiveRun(THREE_STEPS, undefined, RUN_START_MS)).toBeNull();
  });

  it('keeps the axis non-zero on a run that has only just started', () => {
    // Otherwise every bar divides by zero and the chart renders as NaN widths.
    expect(buildLiveRun(THREE_STEPS, stats([]), RUN_START_MS)?.totalSeconds).toBe(1);
  });
});

describe('buildHistoricRun', () => {
  const historyRun: HistoryRun = {
    sqlInstanceId: 100,
    runDatetime: RUN_START,
    runStatus: 1,
    runDurationSeconds: 29,
    message: null,
    steps: [
      {
        sqlInstanceId: 101,
        stepId: 1,
        stepName: 'Extract',
        runStatus: 1,
        runDatetime: new Date(RUN_START_MS + 1_000).toISOString(),
        runDurationSeconds: 8,
        message: null,
        retriesAttempted: 0,
        sqlSeverity: 0,
        sqlMessageId: 0,
      },
      {
        sqlInstanceId: 102,
        stepId: 2,
        stepName: 'Transform',
        runStatus: 1,
        runDatetime: new Date(RUN_START_MS + 9_000).toISOString(),
        runDurationSeconds: 12,
        message: null,
        retriesAttempted: 0,
        sqlSeverity: 0,
        sqlMessageId: 0,
      },
    ],
  };

  it('places steps at their real offsets from the run start', () => {
    const run = buildHistoricRun(historyRun);
    expect(run?.steps[0]).toMatchObject({ offsetSeconds: 1, durationSeconds: 8 });
    expect(run?.steps[1]).toMatchObject({ offsetSeconds: 9, durationSeconds: 12 });
    expect(run?.running).toBe(false);
    expect(run?.runStatus).toBe(1);
  });

  it('spans at least as far as its last step', () => {
    // A job outcome row can report a shorter duration than its steps span;
    // the axis has to cover the bars or they overflow the track.
    const run = buildHistoricRun({ ...historyRun, runDurationSeconds: 5 });
    expect(run?.totalSeconds).toBe(21);
  });

  it('returns nothing when there is no run', () => {
    expect(buildHistoricRun(undefined)).toBeNull();
  });
});
