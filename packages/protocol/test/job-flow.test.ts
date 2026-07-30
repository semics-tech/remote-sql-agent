import { describe, expect, it } from 'vitest';
import {
  inferRunningStep,
  isStepDisabled,
  nextStepAfter,
  reachableSteps,
  unreachableSteps,
} from '../src/job-flow.js';
import { StepAction } from '../src/job-definition.js';
import { job, step } from './fixtures.js';

/**
 * Reading a job's control flow.
 *
 * The consequential case throughout is the one msdb makes easy to get wrong:
 * `last_executed_step_id` names the step that *finished*, so anything derived
 * from it directly is one step behind and says nothing at all during the first.
 */

/** Three steps falling through one to the next. */
const LINEAR = job({
  steps: [
    step({ stepId: 1, name: 'Extract', onSuccessAction: StepAction.GoToNextStep }),
    step({ stepId: 2, name: 'Transform', onSuccessAction: StepAction.GoToNextStep }),
    step({ stepId: 3, name: 'Load', onSuccessAction: StepAction.QuitWithSuccess }),
  ],
});

const BRANCHING = job({
  startStepId: 1,
  steps: [
    step({
      stepId: 1,
      name: 'Backup',
      onSuccessAction: StepAction.GoToStep,
      onSuccessStepId: 3,
      onFailAction: StepAction.GoToStep,
      onFailStepId: 2,
    }),
    step({ stepId: 2, name: 'Alert', onSuccessAction: StepAction.QuitWithFailure }),
    step({ stepId: 3, name: 'Cleanup', onSuccessAction: StepAction.QuitWithSuccess }),
  ],
});

describe('inferRunningStep', () => {
  it('is the start step before anything has finished', () => {
    // msdb reports last_executed_step_id = 0 here, which is why reading it
    // directly leaves the first step invisible for its whole duration.
    expect(inferRunningStep(LINEAR, [])).toBe(1);
  });

  it('respects a job that does not start at step 1', () => {
    expect(inferRunningStep(job({ ...LINEAR, startStepId: 2 }), [])).toBe(2);
  });

  it('names the step after the one that finished, not the one that finished', () => {
    expect(inferRunningStep(LINEAR, [{ stepId: 1, runStatus: 1 }])).toBe(2);
    expect(
      inferRunningStep(LINEAR, [
        { stepId: 1, runStatus: 1 },
        { stepId: 2, runStatus: 1 },
      ]),
    ).toBe(3);
  });

  it('follows the branch the outcome actually took', () => {
    expect(inferRunningStep(BRANCHING, [{ stepId: 1, runStatus: 1 }])).toBe(3);
    expect(inferRunningStep(BRANCHING, [{ stepId: 1, runStatus: 0 }])).toBe(2);
  });

  it('reports nothing running once the flow quits', () => {
    expect(inferRunningStep(LINEAR, [{ stepId: 3, runStatus: 1 }])).toBeNull();
    // A failure whose action is quit ends the run just as surely.
    expect(inferRunningStep(LINEAR, [{ stepId: 1, runStatus: 0 }])).toBeNull();
  });

  it('reports nothing when a step it does not know about finished', () => {
    expect(inferRunningStep(LINEAR, [{ stepId: 9, runStatus: 1 }])).toBeNull();
  });
});

describe('nextStepAfter', () => {
  it('skips gaps rather than assuming stepId + 1', () => {
    const gapped = job({
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 4, name: 'Four', onSuccessAction: StepAction.QuitWithSuccess }),
      ],
    });
    expect(nextStepAfter(gapped, gapped.steps[0]!, true)).toBe(4);
  });

  it('has nowhere to go from the last step', () => {
    const trailing = job({
      steps: [step({ stepId: 1, name: 'Only', onSuccessAction: StepAction.GoToNextStep })],
    });
    expect(nextStepAfter(trailing, trailing.steps[0]!, true)).toBeNull();
  });
});

describe('reachableSteps', () => {
  it('follows both branches, so an error handler counts as reachable', () => {
    expect([...reachableSteps(BRANCHING)].sort()).toEqual([1, 2, 3]);
  });

  it('terminates on a loop rather than spinning', () => {
    const looping = job({
      steps: [
        step({ stepId: 1, name: 'One', onSuccessAction: StepAction.GoToNextStep }),
        step({ stepId: 2, name: 'Two', onSuccessAction: StepAction.GoToStep, onSuccessStepId: 1 }),
      ],
    });
    expect([...reachableSteps(looping)].sort()).toEqual([1, 2]);
  });
});

describe('unreachableSteps', () => {
  it('finds nothing wrong with an ordinary job', () => {
    expect(unreachableSteps(LINEAR)).toEqual([]);
    expect(unreachableSteps(BRANCHING)).toEqual([]);
  });

  it('does not flag a handler that sits below a step which quits', () => {
    // The shape this protects: happy path ends at step 2, and step 3 exists
    // only as step 1's failure branch. A naive "step after a Quit" check would
    // call that broken, and it is completely normal.
    const withHandler = job({
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
    expect(unreachableSteps(withHandler)).toEqual([]);
  });

  it('flags a step nothing can arrive at', () => {
    const stranded = job({
      startStepId: 1,
      steps: [
        step({ stepId: 1, name: 'Work', onSuccessAction: StepAction.QuitWithSuccess }),
        step({ stepId: 2, name: 'Stranded' }),
      ],
    });
    expect(unreachableSteps(stranded).map((s) => s.name)).toEqual(['Stranded']);
  });
});

describe('isStepDisabled', () => {
  it('reads a step nothing reaches as switched off', () => {
    const stranded = job({
      startStepId: 1,
      steps: [
        step({ stepId: 1, name: 'Work', onSuccessAction: StepAction.QuitWithSuccess }),
        step({ stepId: 2, name: 'Off' }),
      ],
    });
    expect(isStepDisabled(stranded, 2)).toBe(true);
    expect(isStepDisabled(stranded, 1)).toBe(false);
  });
});
