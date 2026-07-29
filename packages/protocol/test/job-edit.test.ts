import { describe, expect, it } from 'vitest';
import { addStep, moveStep, removeStep, updateStep } from '../src/job-edit.js';
import { StepAction, jobDefinitionSchema } from '../src/job-definition.js';
import { job, step } from './fixtures.js';

/**
 * SQL Agent addresses steps by position, so every structural edit repoints the
 * job's branching. These tests pin the repair rules, because getting them wrong
 * produces a job that is still valid, still saves, and runs the wrong steps.
 */

/** Four steps with branching that a naive renumber would silently corrupt. */
function branchingJob() {
  return job({
    startStepId: 2,
    steps: [
      step({ stepId: 1, name: 'Precheck', onSuccessAction: StepAction.GoToNextStep }),
      step({
        stepId: 2,
        name: 'Backup',
        onSuccessAction: StepAction.GoToStep,
        onSuccessStepId: 4,
        onFailAction: StepAction.GoToStep,
        onFailStepId: 3,
      }),
      step({ stepId: 3, name: 'Alert on failure', onSuccessAction: StepAction.QuitWithFailure }),
      step({ stepId: 4, name: 'Cleanup', onSuccessAction: StepAction.QuitWithSuccess }),
    ],
  });
}

describe('addStep', () => {
  it('appends at the end by default and numbers the new step last', () => {
    const { definition } = addStep(job());
    expect(definition.steps.map((s) => s.stepId)).toEqual([1, 2, 3]);
    expect(definition.steps[2]!.name).toBe('Step 3');
  });

  it('keeps branches pointing at the same step when inserting above them', () => {
    // "Backup" jumps to "Cleanup". Inserting before "Cleanup" pushes it from
    // step 4 to step 5, and the jump must follow it.
    const { definition } = addStep(branchingJob(), { afterStepId: 3 });

    const backup = definition.steps.find((s) => s.name === 'Backup')!;
    const cleanup = definition.steps.find((s) => s.name === 'Cleanup')!;
    expect(cleanup.stepId).toBe(5);
    expect(backup.onSuccessStepId).toBe(5);
  });

  it('moves the start step with the job when insertion shifts it', () => {
    const { definition } = addStep(branchingJob(), { afterStepId: 1 });
    const backup = definition.steps.find((s) => s.name === 'Backup')!;
    expect(backup.stepId).toBe(3);
    expect(definition.startStepId).toBe(3);
  });

  it('produces a definition that still validates', () => {
    const { definition } = addStep(branchingJob(), { afterStepId: 2 });
    expect(() => jobDefinitionSchema.parse(definition)).not.toThrow();
  });

  it('does not reuse a step name that is already taken', () => {
    const base = job({ steps: [step({ stepId: 1, name: 'Step 3' })] });
    const { definition } = addStep(base);
    expect(definition.steps[1]!.name).not.toBe('Step 3');
  });
});

describe('removeStep', () => {
  it('renumbers the remaining steps with no gaps', () => {
    const { definition } = removeStep(branchingJob(), 1);
    expect(definition.steps.map((s) => s.stepId)).toEqual([1, 2, 3]);
    expect(definition.steps.map((s) => s.name)).toEqual(['Backup', 'Alert on failure', 'Cleanup']);
  });

  it('repoints surviving branches at the step they meant, not the old number', () => {
    const { definition } = removeStep(branchingJob(), 1);
    const backup = definition.steps.find((s) => s.name === 'Backup')!;

    // Cleanup slid from 4 to 3 and the alert step from 3 to 2.
    expect(backup.onSuccessStepId).toBe(3);
    expect(backup.onFailStepId).toBe(2);
  });

  it('quits reporting failure when a failure handler is deleted', () => {
    const { definition, warnings } = removeStep(branchingJob(), 3);
    const backup = definition.steps.find((s) => s.name === 'Backup')!;

    // Critically not "go to the next step" — that would let a failed backup
    // fall through to cleanup and report the job as successful.
    expect(backup.onFailAction).toBe(StepAction.QuitWithFailure);
    expect(backup.onFailStepId).toBe(0);
    expect(warnings.join(' ')).toContain('quits reporting failure');
  });

  it('falls through on success when a success target is deleted', () => {
    const { definition, warnings } = removeStep(branchingJob(), 4);
    const backup = definition.steps.find((s) => s.name === 'Backup')!;
    expect(backup.onSuccessAction).toBe(StepAction.GoToNextStep);
    expect(warnings.join(' ')).toContain('goes to the next step');
  });

  it('quits with success when a deleted success target left nothing after it', () => {
    const base = job({
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToStep, onSuccessStepId: 2 }),
        step({ stepId: 2, name: 'Two' }),
      ],
    });
    const { definition } = removeStep(base, 2);
    expect(definition.steps[0]!.onSuccessAction).toBe(StepAction.QuitWithSuccess);
  });

  it('resets the start step when the job started at the deleted one', () => {
    const { definition, warnings } = removeStep(branchingJob(), 2);
    expect(definition.startStepId).toBe(1);
    expect(warnings.join(' ')).toContain('starts at step 1');
  });

  it('refuses to remove the only step rather than saving an unrunnable job', () => {
    const base = job({ startStepId: 1, steps: [step({ stepId: 1, name: 'Only' })] });
    const { definition, warnings } = removeStep(base, 1);
    expect(definition.steps).toHaveLength(1);
    expect(warnings[0]).toContain('at least one step');
  });

  it('ignores a step id that is not there', () => {
    const before = branchingJob();
    const { definition } = removeStep(before, 99);
    expect(definition.steps).toHaveLength(4);
  });
});

describe('moveStep', () => {
  it('swaps adjacent steps and renumbers them', () => {
    const { definition } = moveStep(branchingJob(), 3, 'up');
    expect(definition.steps.map((s) => s.name)).toEqual([
      'Precheck',
      'Alert on failure',
      'Backup',
      'Cleanup',
    ]);
    expect(definition.steps.map((s) => s.stepId)).toEqual([1, 2, 3, 4]);
  });

  it('preserves every branch across a reorder', () => {
    const { definition, warnings } = moveStep(branchingJob(), 3, 'up');
    const backup = definition.steps.find((s) => s.name === 'Backup')!;

    // Backup is now step 3; its handler moved to 2 and cleanup stayed at 4.
    expect(backup.onFailStepId).toBe(2);
    expect(backup.onSuccessStepId).toBe(4);
    expect(warnings).toEqual([]);
  });

  it('follows the start step through the move', () => {
    const { definition } = moveStep(branchingJob(), 2, 'up');
    expect(definition.startStepId).toBe(1);
    expect(definition.steps[0]!.name).toBe('Backup');
  });

  it('does nothing at the ends of the list', () => {
    expect(moveStep(branchingJob(), 1, 'up').definition.steps.map((s) => s.name)).toEqual([
      'Precheck',
      'Backup',
      'Alert on failure',
      'Cleanup',
    ]);
    expect(moveStep(branchingJob(), 4, 'down').definition.steps[3]!.name).toBe('Cleanup');
  });
});

describe('reference hygiene', () => {
  it('clears the target step id when the action is not "go to step"', () => {
    // msdb stores a leftover target on a Quit action; two servers that differ
    // only in that dead number must not hash differently.
    const base = job({
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.QuitWithSuccess, onSuccessStepId: 7 }),
        step({ stepId: 2, name: 'Two' }),
      ],
    });
    const { definition } = moveStep(base, 1, 'down');
    expect(definition.steps.find((s) => s.name === 'One')!.onSuccessStepId).toBe(0);
  });

  it('repairs a reference that was already dangling before the edit', () => {
    const base = job({
      steps: [
        step({ stepId: 1, name: 'One', onFailAction: StepAction.GoToStep, onFailStepId: 9 }),
        step({ stepId: 2, name: 'Two' }),
      ],
    });
    const { definition, warnings } = addStep(base);
    expect(definition.steps[0]!.onFailAction).toBe(StepAction.QuitWithFailure);
    expect(warnings).toHaveLength(1);
  });
});

describe('updateStep', () => {
  it('edits fields without letting the caller change the step id', () => {
    const { steps } = updateStep(job(), 2, { name: 'Renamed', stepId: 99 } as never);
    expect(steps[1]).toMatchObject({ stepId: 2, name: 'Renamed' });
  });
});
