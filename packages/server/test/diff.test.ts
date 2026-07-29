import { describe, expect, it } from 'vitest';
import { diffJobDefinitions, type StepChange, type ScheduleChange } from '../src/domain/diff.js';
import type { JobDefinition, JobStep } from '@rsagent/protocol';

function step(overrides: Partial<JobStep> = {}): JobStep {
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

function job(overrides: Partial<JobDefinition> = {}): JobDefinition {
  return {
    schemaVersion: 'JobDefinition.v1',
    name: 'Nightly',
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
    steps: [step()],
    schedules: [],
    targetServers: [],
    ...overrides,
  };
}

describe('diffJobDefinitions', () => {
  it('reports no changes for identical definitions', () => {
    expect(diffJobDefinitions(job(), job())).toEqual([]);
  });

  it('reports scalar field changes', () => {
    const changes = diffJobDefinitions(job(), job({ name: 'Renamed', enabled: false }));
    expect(changes).toEqual(
      expect.arrayContaining([
        { kind: 'field', path: 'name', before: 'Nightly', after: 'Renamed' },
        { kind: 'field', path: 'enabled', before: true, after: false },
      ]),
    );
  });

  it('reports notification changes with a qualified path', () => {
    const before = job();
    const after = job({ notifications: { ...before.notifications, emailLevel: 2 } });
    expect(diffJobDefinitions(before, after)).toContainEqual({
      kind: 'field',
      path: 'notifications.emailLevel',
      before: 0,
      after: 2,
    });
  });

  it('surfaces a changed step body for the text diff viewer', () => {
    const changes = diffJobDefinitions(
      job({ steps: [step({ command: 'SELECT 1;' })] }),
      job({ steps: [step({ command: 'SELECT 2;' })] }),
    );
    const stepChange = changes.find((c) => c.kind === 'step') as StepChange;
    expect(stepChange.change).toBe('modified');
    expect(stepChange.commandBefore).toBe('SELECT 1;');
    expect(stepChange.commandAfter).toBe('SELECT 2;');
  });

  it('does not emit command before/after when only metadata changed', () => {
    // Otherwise the Versions tab would open a Monaco diff showing two identical
    // panes every time someone bumped a retry count.
    const changes = diffJobDefinitions(
      job({ steps: [step({ retryAttempts: 0 })] }),
      job({ steps: [step({ retryAttempts: 3 })] }),
    );
    const stepChange = changes.find((c) => c.kind === 'step') as StepChange;
    expect(stepChange.commandBefore).toBeUndefined();
    expect(stepChange.fields).toContainEqual({
      kind: 'field',
      path: 'steps[1].retryAttempts',
      before: 0,
      after: 3,
    });
  });

  it('detects added and removed steps', () => {
    const changes = diffJobDefinitions(
      job({ steps: [step({ stepId: 1 })] }),
      job({ steps: [step({ stepId: 1 }), step({ stepId: 2, name: 'New step' })] }),
    );
    const added = changes.find((c) => c.kind === 'step' && c.change === 'added') as StepChange;
    expect(added.stepId).toBe(2);
    expect(added.stepName).toBe('New step');

    const reverse = diffJobDefinitions(
      job({ steps: [step({ stepId: 1 }), step({ stepId: 2, name: 'Old step' })] }),
      job({ steps: [step({ stepId: 1 })] }),
    );
    const removed = changes.length ? (reverse.find((c) => c.kind === 'step') as StepChange) : null;
    expect(removed?.change).toBe('removed');
  });

  it('orders step changes by step id', () => {
    const changes = diffJobDefinitions(
      job({ steps: [step({ stepId: 1 }), step({ stepId: 2, name: 'Two' })] }),
      job({
        steps: [
          step({ stepId: 1, command: 'CHANGED' }),
          step({ stepId: 2, name: 'Two', command: 'ALSO CHANGED' }),
        ],
      }),
    );
    const ids = changes.filter((c) => c.kind === 'step').map((c) => (c as StepChange).stepId);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('matches schedules by name rather than position', () => {
    const a = job({
      schedules: [
        { name: 'Nightly', enabled: true, freqType: 4, freqInterval: 1, freqSubdayType: 1, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 0, activeStartDate: 20240101, activeEndDate: 99991231, activeStartTime: 20000, activeEndTime: 235959 },
        { name: 'Weekly', enabled: true, freqType: 8, freqInterval: 2, freqSubdayType: 1, freqSubdayInterval: 0, freqRelativeInterval: 0, freqRecurrenceFactor: 1, activeStartDate: 20240101, activeEndDate: 99991231, activeStartTime: 30000, activeEndTime: 235959 },
      ],
    });
    const b = job({ schedules: [a.schedules[1]!, a.schedules[0]!] });
    expect(diffJobDefinitions(a, b)).toEqual([]);
  });

  it('reports a changed schedule time', () => {
    const base = {
      name: 'Nightly',
      enabled: true,
      freqType: 4,
      freqInterval: 1,
      freqSubdayType: 1,
      freqSubdayInterval: 0,
      freqRelativeInterval: 0,
      freqRecurrenceFactor: 0,
      activeStartDate: 20240101,
      activeEndDate: 99991231,
      activeStartTime: 20000,
      activeEndTime: 235959,
    };
    const changes = diffJobDefinitions(
      job({ schedules: [base] }),
      job({ schedules: [{ ...base, activeStartTime: 30000 }] }),
    );
    const scheduleChange = changes.find((c) => c.kind === 'schedule') as ScheduleChange;
    expect(scheduleChange.change).toBe('modified');
    expect(scheduleChange.fields).toContainEqual({
      kind: 'field',
      path: 'schedules[Nightly].activeStartTime',
      before: 20000,
      after: 30000,
    });
  });
});
