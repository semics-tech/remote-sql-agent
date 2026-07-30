import { describe, expect, it } from 'vitest';
import {
  addStep,
  disableStep,
  enableStep,
  moveStep,
  removeStep,
  reorderStep,
  updateStep,
} from '../src/job-edit.js';
import { isStepDisabled } from '../src/job-flow.js';
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

describe('reorderStep', () => {
  it('drops a step at the position the pointer was over', () => {
    // "Cleanup" dragged to the top of the list.
    const { definition } = reorderStep(branchingJob(), 4, 0);
    expect(definition.steps.map((s) => s.name)).toEqual([
      'Cleanup',
      'Precheck',
      'Backup',
      'Alert on failure',
    ]);
  });

  it('lands on the same row whether dragged up or down', () => {
    // The trap this pins: indices shift once the dragged step is lifted out.
    // Moving step 1 to index 2 must put it *third*, not second, and the same
    // row moved back must return the list to where it started.
    const downwards = reorderStep(branchingJob(), 1, 2).definition;
    expect(downwards.steps.map((s) => s.name)).toEqual([
      'Backup',
      'Alert on failure',
      'Precheck',
      'Cleanup',
    ]);

    const back = reorderStep(downwards, 3, 0).definition;
    expect(back.steps.map((s) => s.name)).toEqual(
      branchingJob().steps.map((s) => s.name),
    );
  });

  it('carries branches and the start step across the move', () => {
    const { definition } = reorderStep(branchingJob(), 4, 0);
    const backup = definition.steps.find((s) => s.name === 'Backup')!;

    // Cleanup is now step 1 and the handler is step 4; both jumps must follow.
    expect(backup.onSuccessStepId).toBe(1);
    expect(backup.onFailStepId).toBe(4);
    expect(definition.startStepId).toBe(3);
  });

  it('clamps a drop past either end rather than refusing it', () => {
    expect(reorderStep(branchingJob(), 1, 99).definition.steps[3]!.name).toBe('Precheck');
    expect(reorderStep(branchingJob(), 4, -5).definition.steps[0]!.name).toBe('Cleanup');
  });

  it('leaves the definition untouched for a no-op or an unknown step', () => {
    const base = branchingJob();
    expect(reorderStep(base, 2, 1).definition).toBe(base);
    expect(reorderStep(base, 99, 0).definition).toBe(base);
  });

  it('produces a definition that still validates', () => {
    const { definition } = reorderStep(branchingJob(), 2, 3);
    expect(() => jobDefinitionSchema.parse(definition)).not.toThrow();
  });
});

describe('end-of-list defaults', () => {
  it('makes a newly appended step quit rather than fall off the end', () => {
    // "Go to the next step" on the last step names nothing at all, and SSMS
    // will not offer it there either.
    const { definition } = addStep(job());
    const last = definition.steps[definition.steps.length - 1]!;
    expect(last.onSuccessAction).toBe(StepAction.QuitWithSuccess);
    expect(last.onFailAction).toBe(StepAction.QuitWithFailure);
  });

  it('keeps a step inserted in the middle falling through', () => {
    const { definition } = addStep(branchingJob(), { afterStepId: 1 });
    expect(definition.steps[1]!.onSuccessAction).toBe(StepAction.GoToNextStep);
  });

  it('puts a step back into the chain when it stops being last', () => {
    const base = job({
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 2, name: 'Two', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });
    const { definition, warnings } = addStep(base);

    const two = definition.steps.find((s) => s.name === 'Two')!;
    expect(two.onSuccessAction).toBe(StepAction.GoToNextStep);
    // On failure it still stops: a step added after a failure is not something
    // to start running because the list grew.
    expect(two.onFailAction).toBe(StepAction.QuitWithFailure);
    expect(warnings.some((w) => /no longer last/u.test(w))).toBe(true);
  });

  it('leaves a deliberate mid-list quit alone', () => {
    // The happy path ends at step 2 and step 3 is step 1's error handler. This
    // is a real shape, and rewiring it would change what the job does.
    const base = job({
      startStepId: 1,
      steps: [
        step({
          stepId: 1,
          name: 'Work',
          onSuccessAction: StepAction.GoToNextStep,
          onFailAction: StepAction.GoToStep,
          onFailStepId: 3,
        }),
        step({ stepId: 2, name: 'Finish', onSuccessAction: StepAction.QuitWithSuccess }),
        step({ stepId: 3, name: 'Handler', onSuccessAction: StepAction.QuitWithFailure }),
      ],
    });
    const { definition } = addStep(base);

    // "Finish" was never last, so nothing touches it.
    expect(definition.steps.find((s) => s.name === 'Finish')!.onSuccessAction).toBe(
      StepAction.QuitWithSuccess,
    );
  });

  it('does not resurrect a step whose quit was chosen, not automatic', () => {
    // Quit on success but *branch* on failure is not the automatic pairing, so
    // it reads as a decision and survives losing its place at the end.
    const base = job({
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToNextStep }),
        step({
          stepId: 2,
          name: 'Two',
          onSuccessAction: StepAction.QuitWithSuccess,
          onFailAction: StepAction.GoToStep,
          onFailStepId: 1,
        }),
      ],
    });
    const { definition } = addStep(base);
    expect(definition.steps.find((s) => s.name === 'Two')!.onSuccessAction).toBe(
      StepAction.QuitWithSuccess,
    );
  });
});

describe('disableStep', () => {
  it('routes the flow past the step, leaving it in the job', () => {
    const base = job({
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 2, name: 'Two', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 3, name: 'Three', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });
    const { definition } = disableStep(base, 2);

    // The step is still there, command and all — that is the whole point.
    expect(definition.steps).toHaveLength(3);
    expect(definition.steps[1]!.name).toBe('Two');
    // ...and nothing can arrive at it.
    expect(isStepDisabled(definition, 2)).toBe(true);
    expect(definition.steps[0]!.onSuccessAction).toBe(StepAction.GoToStep);
    expect(definition.steps[0]!.onSuccessStepId).toBe(3);
  });

  it('redirects explicit branches into the step, not just fall-through', () => {
    const base = job({
      startStepId: 1,
      steps: [
        step({
          stepId: 1,
          name: 'One',
          onSuccessAction: StepAction.GoToNextStep,
          onFailAction: StepAction.GoToStep,
          onFailStepId: 2,
        }),
        step({ stepId: 2, name: 'Two', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 3, name: 'Three', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });
    const { definition } = disableStep(base, 2);
    // Both routes into the disabled step now land past it.
    expect(definition.steps[0]!.onFailStepId).toBe(3);
    expect(isStepDisabled(definition, 2)).toBe(true);
  });

  it('ends the job where the disabled step used to end it', () => {
    const base = job({
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 2, name: 'Two', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });
    const { definition } = disableStep(base, 2);
    expect(definition.steps[0]!.onSuccessAction).toBe(StepAction.QuitWithSuccess);
  });

  it('moves the start step when the start step is the one being disabled', () => {
    const base = job({
      startStepId: 1,
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 2, name: 'Two', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });
    const { definition, warnings } = disableStep(base, 1);
    expect(definition.startStepId).toBe(2);
    expect(warnings).toHaveLength(1);
  });

  it('refuses to leave a job with nothing to run', () => {
    const single = job({ steps: [step({ stepId: 1, name: 'Only' })] });
    const { definition, warnings } = disableStep(single, 1);
    expect(definition).toBe(single);
    expect(warnings).toHaveLength(1);
  });

  it('produces a definition that still validates', () => {
    const { definition } = disableStep(branchingJob(), 3);
    expect(() => jobDefinitionSchema.parse(definition)).not.toThrow();
  });
});

describe('enableStep', () => {
  it('undoes a disable without anything having been stored', () => {
    // Step ids are positions, so where a step belongs is derivable: step 2 goes
    // back between 1 and 3. Nothing needs to remember the old wiring.
    const base = job({
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 2, name: 'Two', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 3, name: 'Three', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });

    const disabled = disableStep(base, 2).definition;
    const restored = enableStep(disabled, 2).definition;

    expect(isStepDisabled(restored, 2)).toBe(false);
    expect(restored.steps[0]!.onSuccessAction).toBe(StepAction.GoToNextStep);
    expect(restored).toEqual(base);
  });

  it('restores the last step, whose disable left a quit rather than a jump', () => {
    // Disabling the final step has nowhere to route past it, so the step above
    // is made to stop instead. Undoing that is a different repair from undoing
    // a jump, and matching only on the jump left this case stuck off.
    const base = job({
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 2, name: 'Two', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 3, name: 'Three', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });

    const disabled = disableStep(base, 3).definition;
    expect(isStepDisabled(disabled, 3)).toBe(true);
    expect(disabled.steps[1]!.onSuccessAction).toBe(StepAction.QuitWithSuccess);

    const restored = enableStep(disabled, 3).definition;
    expect(isStepDisabled(restored, 3)).toBe(false);
    expect(restored).toEqual(base);
  });

  it('makes a re-enabled first step the start step again', () => {
    const base = job({
      startStepId: 1,
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 2, name: 'Two', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });
    const disabled = disableStep(base, 1).definition;
    expect(disabled.startStepId).toBe(2);

    const restored = enableStep(disabled, 1).definition;
    expect(restored.startStepId).toBe(1);
    expect(isStepDisabled(restored, 1)).toBe(false);
  });

  it('does nothing to a step that already runs', () => {
    const base = branchingJob();
    expect(enableStep(base, 2).definition).toBe(base);
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
    expect(warnings.some((w) => /no longer exists on failure/u.test(w))).toBe(true);
  });
});

describe('updateStep', () => {
  it('edits fields without letting the caller change the step id', () => {
    const { steps } = updateStep(job(), 2, { name: 'Renamed', stepId: 99 } as never);
    expect(steps[1]).toMatchObject({ stepId: 2, name: 'Renamed' });
  });
});
