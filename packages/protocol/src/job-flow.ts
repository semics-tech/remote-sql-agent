import { StepAction, type JobDefinition, type JobStep } from './job-definition.js';

/**
 * Reading a job's control flow: what runs next, and what can be reached at all.
 *
 * Kept in the protocol package rather than in either consumer because both need
 * exactly the same answers. The control plane infers the running step for the
 * overview; the dashboard infers it for the run timeline. Two implementations
 * of "what does SQL Agent do after this step" would eventually disagree, and
 * the disagreement would show as one screen contradicting another.
 */

/** msdb `sysjobhistory.run_status`. */
export const RunStatus = {
  Failed: 0,
  Succeeded: 1,
  Retry: 2,
  Cancelled: 3,
} as const;

/** The minimum a completed step must report for the flow to be followed. */
export interface CompletedStep {
  stepId: number;
  /** msdb run_status: 0 Failed, 1 Succeeded, 2 Retry, 3 Cancelled. */
  runStatus: number;
}

/**
 * Which step is running, derived from the job's own flow.
 *
 * `sysjobactivity.last_executed_step_id` is the last step that **finished**,
 * not the one in progress — using it directly names the step one behind, and
 * reports nothing at all for the whole of the first step, because before
 * anything has finished it is zero.
 *
 * Following the definition instead is exact: Agent starts at `startStepId` and
 * then obeys the on-success / on-failure action of whatever just completed.
 *
 * Returns null when the last step's action ends the job — at that point nothing
 * is running, the run is finishing.
 */
export function inferRunningStep(
  definition: JobDefinition,
  completed: readonly CompletedStep[],
): number | null {
  if (completed.length === 0) return definition.startStepId;

  const last = completed[completed.length - 1]!;
  const step = definition.steps.find((s) => s.stepId === last.stepId);
  if (!step) return null;

  // A retry has not finished — Agent is about to run this same step again, so
  // the running step is this one. Branching on `runStatus === 1` and treating
  // everything else as failure sent the caller down the *failure* branch of a
  // step that had not failed: no in-flight bar on the timeline, "finishing" on
  // the overview, and a "Running for" counter that kept climbing against it.
  if (last.runStatus === RunStatus.Retry) return step.stepId;

  // Cancelled ends the run outright; it does not take the failure branch.
  if (last.runStatus === RunStatus.Cancelled) return null;

  return nextStepAfter(definition, step, last.runStatus === RunStatus.Succeeded);
}

/**
 * The step Agent moves to after `step` completes, or null if the job ends.
 *
 * Exported because "where does this go" is asked in several places — inferring
 * the live step, checking reachability, and rewiring around a disabled step all
 * need the same answer.
 */
export function nextStepAfter(
  definition: JobDefinition,
  step: JobStep,
  succeeded: boolean,
): number | null {
  const action = succeeded ? step.onSuccessAction : step.onFailAction;
  const target = succeeded ? step.onSuccessStepId : step.onFailStepId;

  if (action === StepAction.GoToStep) return target || null;
  if (action === StepAction.GoToNextStep) {
    const next = definition.steps
      .filter((s) => s.stepId > step.stepId)
      .sort((a, b) => a.stepId - b.stepId)[0];
    return next?.stepId ?? null;
  }
  // QuitWithSuccess / QuitWithFailure: nothing follows.
  return null;
}

/**
 * Every step the job can actually arrive at, from its start step.
 *
 * Both branches are followed, because a step reached only by an error handler
 * is still reachable — "runs on the unhappy path" is not the same as dead.
 */
export function reachableSteps(definition: JobDefinition): Set<number> {
  const byStepId = new Map(definition.steps.map((s) => [s.stepId, s]));
  const seen = new Set<number>();
  const queue: number[] = [definition.startStepId];

  while (queue.length > 0) {
    const stepId = queue.pop()!;
    if (seen.has(stepId)) continue;
    const step = byStepId.get(stepId);
    if (!step) continue;
    seen.add(stepId);

    for (const succeeded of [true, false]) {
      const next = nextStepAfter(definition, step, succeeded);
      if (next !== null && !seen.has(next)) queue.push(next);
    }
  }

  return seen;
}

/**
 * Steps the job can never arrive at, in step order.
 *
 * This is the honest form of "there is a step after one that quits". A step
 * following a Quit is only stranded if nothing *else* branches to it, and a job
 * whose error handler sits at the end — below a step that quits on success — is
 * a perfectly ordinary shape that should not be flagged.
 */
export function unreachableSteps(definition: JobDefinition): JobStep[] {
  const reachable = reachableSteps(definition);
  return definition.steps
    .filter((s) => !reachable.has(s.stepId))
    .sort((a, b) => a.stepId - b.stepId);
}

/**
 * Is this step switched off?
 *
 * SQL Agent has no concept of a disabled step, so the product expresses one by
 * routing the flow around it (see `disableStep`). That makes "disabled" a
 * property to be *read* from the job rather than stored beside it: a step
 * nothing can reach is a step that will not run, however it came to be that
 * way — including when a DBA rewired it by hand in SSMS.
 */
export function isStepDisabled(definition: JobDefinition, stepId: number): boolean {
  return !reachableSteps(definition).has(stepId);
}
