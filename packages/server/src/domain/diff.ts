import type { JobDefinition, JobStep, ScheduleDefinition } from '@rsagent/protocol';

/**
 * Structured diff between two job definitions (§7.2).
 *
 * Field-level rather than line-level, because the interesting question in the
 * Versions tab is "what changed about this job", not "which characters moved".
 * Step bodies are the exception: they are handed to the UI whole so Monaco can
 * render a proper text diff.
 */

export type ChangeKind = 'added' | 'removed' | 'modified';

export interface FieldChange {
  kind: 'field';
  path: string;
  before: unknown;
  after: unknown;
}

export interface StepChange {
  kind: 'step';
  change: ChangeKind;
  stepId: number;
  stepName: string;
  /** Present for 'modified': the specific fields that moved. */
  fields?: FieldChange[];
  /** Present when the body changed, for the Monaco diff viewer. */
  commandBefore?: string;
  commandAfter?: string;
}

export interface ScheduleChange {
  kind: 'schedule';
  change: ChangeKind;
  name: string;
  fields?: FieldChange[];
}

export type Change = FieldChange | StepChange | ScheduleChange;

const JOB_SCALAR_FIELDS = [
  'name',
  'description',
  'enabled',
  'categoryName',
  'ownerLoginName',
  'startStepId',
] as const;

const STEP_FIELDS = [
  'name',
  'subsystem',
  'databaseName',
  'databaseUserName',
  'onSuccessAction',
  'onSuccessStepId',
  'onFailAction',
  'onFailStepId',
  'retryAttempts',
  'retryIntervalMinutes',
  'outputFileName',
  'flags',
  'proxyName',
] as const;

const SCHEDULE_FIELDS = [
  'enabled',
  'freqType',
  'freqInterval',
  'freqSubdayType',
  'freqSubdayInterval',
  'freqRelativeInterval',
  'freqRecurrenceFactor',
  'activeStartDate',
  'activeEndDate',
  'activeStartTime',
  'activeEndTime',
] as const;

export function diffJobDefinitions(beforeRaw: unknown, afterRaw: unknown): Change[] {
  const before = beforeRaw as JobDefinition;
  const after = afterRaw as JobDefinition;
  const changes: Change[] = [];

  for (const field of JOB_SCALAR_FIELDS) {
    if (before[field] !== after[field]) {
      changes.push({ kind: 'field', path: field, before: before[field], after: after[field] });
    }
  }

  for (const key of Object.keys(after.notifications ?? {}) as Array<
    keyof JobDefinition['notifications']
  >) {
    const b = before.notifications?.[key];
    const a = after.notifications?.[key];
    if (b !== a) {
      changes.push({ kind: 'field', path: `notifications.${key}`, before: b, after: a });
    }
  }

  changes.push(...diffSteps(before.steps ?? [], after.steps ?? []));
  changes.push(...diffSchedules(before.schedules ?? [], after.schedules ?? []));

  return changes;
}

function diffSteps(before: JobStep[], after: JobStep[]): StepChange[] {
  const changes: StepChange[] = [];
  const beforeById = new Map(before.map((s) => [s.stepId, s]));
  const afterById = new Map(after.map((s) => [s.stepId, s]));

  for (const step of after) {
    const prev = beforeById.get(step.stepId);
    if (!prev) {
      changes.push({
        kind: 'step',
        change: 'added',
        stepId: step.stepId,
        stepName: step.name,
        commandAfter: step.command,
      });
      continue;
    }

    const fields: FieldChange[] = [];
    for (const field of STEP_FIELDS) {
      if (prev[field] !== step[field]) {
        fields.push({
          kind: 'field',
          path: `steps[${step.stepId}].${field}`,
          before: prev[field],
          after: step[field],
        });
      }
    }
    const commandChanged = prev.command !== step.command;

    if (fields.length > 0 || commandChanged) {
      changes.push({
        kind: 'step',
        change: 'modified',
        stepId: step.stepId,
        stepName: step.name,
        fields,
        ...(commandChanged ? { commandBefore: prev.command, commandAfter: step.command } : {}),
      });
    }
  }

  for (const step of before) {
    if (!afterById.has(step.stepId)) {
      changes.push({
        kind: 'step',
        change: 'removed',
        stepId: step.stepId,
        stepName: step.name,
        commandBefore: step.command,
      });
    }
  }

  return changes.sort((a, b) => a.stepId - b.stepId);
}

function diffSchedules(before: ScheduleDefinition[], after: ScheduleDefinition[]): ScheduleChange[] {
  const changes: ScheduleChange[] = [];
  // Schedules are matched by name: it is the only stable identity a schedule
  // has across two instances, and schedule_id is instance-local.
  const beforeByName = new Map(before.map((s) => [s.name, s]));
  const afterByName = new Map(after.map((s) => [s.name, s]));

  for (const sched of after) {
    const prev = beforeByName.get(sched.name);
    if (!prev) {
      changes.push({ kind: 'schedule', change: 'added', name: sched.name });
      continue;
    }
    const fields: FieldChange[] = [];
    for (const field of SCHEDULE_FIELDS) {
      if (prev[field] !== sched[field]) {
        fields.push({
          kind: 'field',
          path: `schedules[${sched.name}].${field}`,
          before: prev[field],
          after: sched[field],
        });
      }
    }
    if (fields.length > 0) {
      changes.push({ kind: 'schedule', change: 'modified', name: sched.name, fields });
    }
  }

  for (const sched of before) {
    if (!afterByName.has(sched.name)) {
      changes.push({ kind: 'schedule', change: 'removed', name: sched.name });
    }
  }

  return changes;
}
