import type { JobDefinition, JobStep } from '../src/job-definition.js';
import type { ScheduleDefinition } from '../src/schedule.js';
import { FreqType, FreqSubdayType, WeekdayFlag } from '../src/schedule.js';

export function step(overrides: Partial<JobStep> = {}): JobStep {
  return {
    stepId: 1,
    name: 'Step 1',
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
    ...overrides,
  };
}

export function schedule(overrides: Partial<ScheduleDefinition> = {}): ScheduleDefinition {
  return {
    name: 'Nightly',
    enabled: true,
    freqType: FreqType.Daily,
    freqInterval: 1,
    freqSubdayType: FreqSubdayType.AtSpecifiedTime,
    freqSubdayInterval: 0,
    freqRelativeInterval: 0,
    freqRecurrenceFactor: 0,
    activeStartDate: 20240101,
    activeEndDate: 99991231,
    activeStartTime: 20000,
    activeEndTime: 235959,
    ...overrides,
  };
}

export function job(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    schemaVersion: 'JobDefinition.v1',
    name: 'Nightly Reindex',
    description: 'Rebuilds fragmented indexes.',
    enabled: true,
    categoryName: 'Database Maintenance',
    ownerLoginName: 'sa',
    startStepId: 1,
    notifications: {
      emailOperatorName: 'DBA Team',
      emailLevel: 2,
      netsendOperatorName: null,
      netsendLevel: 0,
      pageOperatorName: null,
      pageLevel: 0,
      eventlogLevel: 2,
      deleteLevel: 0,
    },
    steps: [
      step({ stepId: 1, name: 'Rebuild', command: 'EXEC dbo.usp_Reindex;', onSuccessAction: 3 }),
      step({ stepId: 2, name: 'Update stats', command: 'EXEC dbo.usp_UpdateStats;' }),
    ],
    schedules: [schedule()],
    targetServers: ['(local)'],
    ...overrides,
  };
}

/** A weekly schedule on Mon/Wed/Fri, every 2 weeks, every 30 min 08:00-18:00. */
export function complexSchedule(): ScheduleDefinition {
  return schedule({
    name: 'Business hours sweep',
    freqType: FreqType.Weekly,
    freqInterval: WeekdayFlag.Monday | WeekdayFlag.Wednesday | WeekdayFlag.Friday,
    freqRecurrenceFactor: 2,
    freqSubdayType: FreqSubdayType.Minutes,
    freqSubdayInterval: 30,
    activeStartTime: 80000,
    activeEndTime: 180000,
  });
}
