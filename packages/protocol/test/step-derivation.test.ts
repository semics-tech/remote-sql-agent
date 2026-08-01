import { describe, expect, it } from 'vitest';
import { addStep, disableStep, enableStep } from '../src/job-edit.js';
import { inferRunningStep, RunStatus } from '../src/job-flow.js';
import { canonicaliseJobWithHash } from '../src/canonical.js';
import { StepAction } from '../src/job-definition.js';
import { job, schedule, step } from './fixtures.js';

/**
 * Cases where the answer looked right and was not.
 *
 * Each of these produces a job that still validates, still saves, and still
 * runs — which is why none of them showed up as an error. What they change is
 * which step runs, or whether the estate believes a job has been edited.
 */

describe('addStep with an id that is not there', () => {
  it('appends rather than silently inserting at the front', () => {
    // `findIndex` returns -1, and `splice(-1 + 1, …)` is `splice(0, …)`. So the
    // new step landed at position 1, `rebuild` resolved `startStepId` from the
    // old id, and the step the operator had just added never ran. Every sibling
    // function in the module guards `index === -1`; this one did not.
    const before = job();
    const { definition, warnings } = addStep(before, { afterStepId: 99 });

    expect(definition.steps).toHaveLength(before.steps.length + 1);
    expect(definition.steps[definition.steps.length - 1]!.name).toMatch(/Step/u);
    expect(definition.startStepId).toBe(before.startStepId);
    expect(warnings.join(' ')).toMatch(/no step 99/u);
  });

  it('still honours a real afterStepId', () => {
    const { definition } = addStep(job(), { afterStepId: 1 });
    expect(definition.steps[1]!.name).toMatch(/Step/u);
    expect(definition.steps).toHaveLength(3);
  });
});

describe('disabling and re-enabling a step', () => {
  /** Three steps, where step 2 is reached on failure as well as by falling in. */
  function withFailureBranch() {
    return job({
      startStepId: 1,
      steps: [
        step({
          stepId: 1,
          name: 'Load',
          onSuccessAction: StepAction.GoToNextStep,
          onFailAction: StepAction.GoToNextStep,
        }),
        step({ stepId: 2, name: 'Recover', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 3, name: 'Report', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });
  }

  it('puts the failure branch back, not only the success branch', () => {
    // `disableStep` rewires *every* inbound branch, success and failure.
    // `enableStep` repaired only `onSuccessAction`, so a round trip moved the
    // failure handler permanently — the exact failure the module header warns
    // about, and invisible because the job still runs.
    const original = withFailureBranch();
    const disabled = disableStep(original, 2).definition;
    const restored = enableStep(disabled, 2).definition;

    const first = restored.steps.find((s) => s.stepId === 1)!;
    expect(first.onSuccessAction).toBe(StepAction.GoToNextStep);
    expect(first.onFailAction).toBe(StepAction.GoToNextStep);
    expect(restored).toEqual(original);
  });

  it('leaves a predecessor that was never rewired alone', () => {
    // The trap in fixing the above: a predecessor whose failure branch is
    // `QuitWithFailure` was never touched by the disable, and turning it into a
    // fall-through on enable would invent a route through the job.
    const original = job({
      startStepId: 1,
      steps: [
        step({
          stepId: 1,
          name: 'Load',
          onSuccessAction: StepAction.GoToNextStep,
          onFailAction: StepAction.QuitWithFailure,
        }),
        step({ stepId: 2, name: 'Transform', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 3, name: 'Report', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });

    const restored = enableStep(disableStep(original, 2).definition, 2).definition;
    expect(restored.steps.find((s) => s.stepId === 1)!.onFailAction).toBe(
      StepAction.QuitWithFailure,
    );
    expect(restored).toEqual(original);
  });

  it('warns that an explicit branch into the step cannot be restored', () => {
    // An explicit "on failure go to step 2" is indistinguishable, once rewired,
    // from a branch that always pointed at the bypass. Nothing can put it back,
    // so the operator is told at the time rather than discovering it after a
    // round trip.
    const original = job({
      startStepId: 1,
      steps: [
        step({
          stepId: 1,
          name: 'Load',
          onSuccessAction: StepAction.GoToNextStep,
          onFailAction: StepAction.GoToStep,
          onFailStepId: 2,
        }),
        step({ stepId: 2, name: 'Recover', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 3, name: 'Report', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });

    const { warnings } = disableStep(original, 2);
    expect(warnings.join(' ')).toMatch(/will not put it back/u);
  });
});

describe('the running step during a retry', () => {
  function retryJob() {
    return job({
      startStepId: 1,
      steps: [
        step({ stepId: 1, name: 'Load', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 2, name: 'Cleanup', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });
  }

  it('is the step being retried, not whatever its failure branch points at', () => {
    // msdb run_status is 0 Failed / 1 Succeeded / 2 Retry / 3 Cancelled. The
    // code branched on `=== 1` and treated everything else as failure, so a
    // retrying step sent the caller down the *failure* branch of a step that
    // had not failed: no in-flight bar on the timeline, "finishing" on the
    // overview, and a "Running for" counter that kept climbing against it.
    expect(inferRunningStep(retryJob(), [{ stepId: 1, runStatus: RunStatus.Retry }])).toBe(1);
  });

  it('still follows the success and failure branches normally', () => {
    expect(inferRunningStep(retryJob(), [{ stepId: 1, runStatus: RunStatus.Succeeded }])).toBe(2);
    expect(inferRunningStep(retryJob(), [{ stepId: 1, runStatus: RunStatus.Failed }])).toBeNull();
  });

  it('treats a cancelled run as over rather than as a failure', () => {
    expect(inferRunningStep(retryJob(), [{ stepId: 1, runStatus: RunStatus.Cancelled }])).toBeNull();
  });
});

describe('two schedules with the same name', () => {
  it('canonicalise to the same bytes whichever order they arrive in', () => {
    // SQL Server permits it, `Array.sort` is stable, and the worker's read has
    // no tiebreak — so with only the name to sort on, row order leaked into the
    // hash. Two reads of an untouched job produced two hashes, and the job
    // reported itself drifted, repeatedly, with nobody having edited it.
    const a = schedule({ name: 'Nightly', activeStartTime: 20000 });
    const b = schedule({ name: 'Nightly', activeStartTime: 60000 });

    const forwards = canonicaliseJobWithHash(job({ schedules: [a, b] }));
    const backwards = canonicaliseJobWithHash(job({ schedules: [b, a] }));

    expect(backwards.hash).toBe(forwards.hash);
  });

  it('still distinguishes a real change to one of them', () => {
    const base = canonicaliseJobWithHash(
      job({ schedules: [schedule({ name: 'N', activeStartTime: 20000 }), schedule({ name: 'N' })] }),
    );
    const changed = canonicaliseJobWithHash(
      job({ schedules: [schedule({ name: 'N', activeStartTime: 30000 }), schedule({ name: 'N' })] }),
    );
    expect(changed.hash).not.toBe(base.hash);
  });
});
