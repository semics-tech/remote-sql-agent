import { StepAction, type JobDefinition, type JobStep } from './job-definition.js';
import { nextStepAfter, reachableSteps } from './job-flow.js';

/**
 * Structural edits to a job's step list.
 *
 * SQL Agent identifies steps by *position*: `sysjobsteps.step_id` is 1..n with
 * no gaps, and `on_success_step_id` / `on_fail_step_id` / `start_step_id` are
 * all positions too. So inserting, deleting or reordering a step silently
 * repoints every "Go to step N" in the job — step 4's error handler quietly
 * becomes step 3's, and nothing complains until it fires in production at 3am.
 *
 * Everything here therefore edits a graph rather than a list: references are
 * resolved to the step they point *at*, the list is restructured, and the
 * numbers are recomputed at the end. Callers get warnings for any reference
 * that could not survive the edit.
 */

export interface StepEditResult {
  definition: JobDefinition;
  /** Reference repairs the operator should be told about, in plain words. */
  warnings: string[];
}

interface Node {
  step: JobStep;
  onSuccessTarget: Node | null;
  onFailTarget: Node | null;
  /** Was this the last step before the edit? Drives the end-of-list defaults. */
  wasLast: boolean;
}

/** A new step with the same defaults SSMS uses in the New Job Step dialog. */
export function newStepTemplate(name: string): JobStep {
  return {
    stepId: 1,
    name,
    subsystem: 'TSQL',
    command: '',
    databaseName: 'master',
    databaseUserName: null,
    onSuccessAction: StepAction.GoToNextStep,
    onSuccessStepId: 0,
    // Quit reporting failure, not "carry on": a new step that errors must not
    // silently fall through to whatever comes next.
    onFailAction: StepAction.QuitWithFailure,
    onFailStepId: 0,
    retryAttempts: 0,
    retryIntervalMinutes: 0,
    outputFileName: null,
    flags: 0,
    proxyName: null,
  };
}

/**
 * Insert a step after `afterStepId`, or at the end when that is null.
 *
 * Existing references are preserved by meaning: a step that pointed at "the
 * step that does the reindex" still points at it, wherever the insertion pushed
 * it to.
 */
export function addStep(
  definition: JobDefinition,
  options: { afterStepId?: number | null; step?: Partial<JobStep> } = {},
): StepEditResult {
  const nodes = toNodes(definition);
  const created: Node = {
    step: { ...newStepTemplate(nextStepName(definition)), ...options.step },
    onSuccessTarget: null,
    onFailTarget: null,
    wasLast: false,
  };

  const afterIndex =
    options.afterStepId == null
      ? nodes.length - 1
      : nodes.findIndex((n) => n.step.stepId === options.afterStepId);

  nodes.splice(afterIndex + 1, 0, created);
  return rebuild(definition, nodes, []);
}

/** Remove a step, repairing anything that pointed at it. */
export function removeStep(definition: JobDefinition, stepId: number): StepEditResult {
  const nodes = toNodes(definition);
  const index = nodes.findIndex((n) => n.step.stepId === stepId);
  if (index === -1) return { definition, warnings: [] };
  if (nodes.length === 1) {
    // sp_add_job accepts a job with no steps, but such a job can never run and
    // the UI has nothing to show. Refusing is kinder than accepting silently.
    return {
      definition,
      warnings: ['A job must keep at least one step, so this one was not removed.'],
    };
  }

  const [removed] = nodes.splice(index, 1);
  return rebuild(definition, nodes, removed ? [removed] : []);
}

/** Move a step one position earlier or later, preserving every reference. */
export function moveStep(
  definition: JobDefinition,
  stepId: number,
  direction: 'up' | 'down',
): StepEditResult {
  const nodes = toNodes(definition);
  const index = nodes.findIndex((n) => n.step.stepId === stepId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index === -1 || target < 0 || target >= nodes.length) {
    return { definition, warnings: [] };
  }

  const moved = nodes[index]!;
  nodes[index] = nodes[target]!;
  nodes[target] = moved;
  return rebuild(definition, nodes, []);
}

/**
 * Move a step to an absolute position, preserving every reference.
 *
 * Separate from `moveStep` because dragging is positional: the operator drops a
 * step *between* two others and expects it to land there, whereas repeated
 * single-place swaps would have to be counted out and get the destination wrong
 * whenever the dragged step passes its own original slot.
 *
 * `toIndex` is the destination in the list as it will read afterwards, zero-
 * based, and is clamped rather than rejected — a drop past the last row means
 * "put it last", which is what the pointer was over.
 */
export function reorderStep(
  definition: JobDefinition,
  stepId: number,
  toIndex: number,
): StepEditResult {
  const nodes = toNodes(definition);
  const from = nodes.findIndex((n) => n.step.stepId === stepId);
  if (from === -1) return { definition, warnings: [] };

  const to = Math.max(0, Math.min(nodes.length - 1, Math.trunc(toIndex)));
  if (to === from) return { definition, warnings: [] };

  const [moved] = nodes.splice(from, 1);
  nodes.splice(to, 0, moved!);
  return rebuild(definition, nodes, []);
}

/**
 * Switch a step off without removing it.
 *
 * SQL Agent has no disabled-step flag, so this is expressed in the one currency
 * SQL Agent does understand: control flow. The step keeps its row in
 * `sysjobsteps` — name, command, retries, everything — and the job simply
 * routes around it. Whatever used to fall into it now goes wherever it went.
 *
 * That choice is what makes the feature safe in both directions. SSMS sees an
 * ordinary job with ordinary branching. Uninstall the worker and the job keeps
 * running on schedule, still skipping the step. Nothing depends on this product
 * being present to interpret a flag it invented, which is the failure mode a
 * stored `disabled: true` would have had — a job that quietly runs a step
 * everyone believed was off, the moment the tool goes away.
 *
 * The cost is that this is a real edit to the job: a new version, a diff, and
 * the same capability and approval checks as any other write. That is the
 * honest accounting — the job on the server genuinely changed.
 */
export function disableStep(definition: JobDefinition, stepId: number): StepEditResult {
  const target = definition.steps.find((s) => s.stepId === stepId);
  if (!target) return { definition, warnings: [] };

  if (definition.steps.length === 1) {
    return {
      definition,
      warnings: ['A job needs one step that runs, so its only step cannot be disabled.'],
    };
  }

  const warnings: string[] = [];
  // Where traffic aimed at this step should go instead: wherever the step
  // itself would have gone on success. Redirecting to its failure branch would
  // be worse — it would run the error handler for an error that never happened.
  const bypass = nextStepAfter(definition, target, true);

  const steps = definition.steps.map((s) => {
    if (s.stepId === stepId) return { ...s };
    const step = { ...s };

    for (const branch of ['onSuccess', 'onFail'] as const) {
      const actionKey = `${branch}Action` as const;
      const stepIdKey = `${branch}StepId` as const;
      const arrivesHere =
        (step[actionKey] === StepAction.GoToStep && step[stepIdKey] === stepId) ||
        (step[actionKey] === StepAction.GoToNextStep &&
          nextStepAfter(definition, s, branch === 'onSuccess') === stepId);

      if (!arrivesHere) continue;

      if (bypass === null) {
        // The disabled step ended the job, so whatever fed it must end it too.
        step[actionKey] =
          branch === 'onSuccess' ? StepAction.QuitWithSuccess : StepAction.QuitWithFailure;
        step[stepIdKey] = 0;
      } else {
        step[actionKey] = StepAction.GoToStep;
        step[stepIdKey] = bypass;
      }
    }

    return step;
  });

  let startStepId = definition.startStepId;
  if (startStepId === stepId) {
    if (bypass === null) {
      return {
        definition,
        warnings: [
          `"${target.name}" is the only step this job would run, so disabling it would leave ` +
            'the job with nothing to do.',
        ],
      };
    }
    startStepId = bypass;
    warnings.push(`The job started at "${target.name}", so it now starts at step ${bypass}.`);
  }

  return { definition: { ...definition, steps, startStepId }, warnings };
}

/**
 * Put a disabled step back into the flow, at the position it occupies.
 *
 * No stored state is needed to undo `disableStep`, because step ids *are*
 * positions: a step sitting at 3 belongs between 2 and 4, so restoring it means
 * putting the fall-through chain back. Anything that was made to jump over it
 * goes back to running straight on.
 */
export function enableStep(definition: JobDefinition, stepId: number): StepEditResult {
  const target = definition.steps.find((s) => s.stepId === stepId);
  if (!target) return { definition, warnings: [] };
  if (reachableSteps(definition).has(stepId)) {
    return { definition, warnings: [] };
  }

  const ordered = [...definition.steps].sort((a, b) => a.stepId - b.stepId);
  const index = ordered.findIndex((s) => s.stepId === stepId);
  const previous = ordered[index - 1];
  const isLast = index === ordered.length - 1;

  const steps = definition.steps.map((s) => {
    if (s.stepId !== stepId) {
      // The step immediately above falls through to it again. Keyed on "does
      // not currently arrive here" rather than on the specific wiring
      // `disableStep` left behind: disabling the *last* step turns the one
      // above it into a Quit rather than a jump, and matching only on the jump
      // would leave that case impossible to undo.
      const arrives =
        previous && s.stepId === previous.stepId
          ? nextStepAfter(definition, s, true) === stepId
          : true;
      if (previous && s.stepId === previous.stepId && !arrives) {
        return { ...s, onSuccessAction: StepAction.GoToNextStep, onSuccessStepId: 0 };
      }
      return { ...s };
    }

    // The step itself has to lead somewhere, or re-enabling it would strand
    // everything below.
    const step = { ...s };
    if (step.onSuccessAction === StepAction.GoToNextStep && isLast) {
      step.onSuccessAction = StepAction.QuitWithSuccess;
      step.onSuccessStepId = 0;
    }
    return step;
  });

  const next = { ...definition, steps };
  // Nothing above it to fall through from: it has to become the start step.
  const startStepId = previous ? next.startStepId : stepId;

  return { definition: { ...next, startStepId }, warnings: [] };
}

/** Replace one step's fields without disturbing the graph. */
export function updateStep(
  definition: JobDefinition,
  stepId: number,
  patch: Partial<JobStep>,
): JobDefinition {
  return {
    ...definition,
    steps: definition.steps.map((s) => (s.stepId === stepId ? { ...s, ...patch, stepId } : s)),
  };
}

/**
 * Resolve the definition's positional references into object references.
 *
 * A `GoToStep` action naming a step that does not exist is left unresolved
 * rather than guessed at; `rebuild` then repairs it like any other dangling
 * reference, so a job that arrived already broken comes out consistent.
 */
function toNodes(definition: JobDefinition): Node[] {
  const ordered = [...definition.steps].sort((a, b) => a.stepId - b.stepId);
  const nodes: Node[] = ordered.map((step, index) => ({
    step: { ...step },
    onSuccessTarget: null,
    onFailTarget: null,
    wasLast: index === ordered.length - 1,
  }));

  const byStepId = new Map(nodes.map((n) => [n.step.stepId, n]));
  for (const node of nodes) {
    if (node.step.onSuccessAction === StepAction.GoToStep) {
      node.onSuccessTarget = byStepId.get(node.step.onSuccessStepId) ?? null;
    }
    if (node.step.onFailAction === StepAction.GoToStep) {
      node.onFailTarget = byStepId.get(node.step.onFailStepId) ?? null;
    }
  }
  return nodes;
}

/** Renumber 1..n by position and write the references back as step ids. */
function rebuild(
  definition: JobDefinition,
  nodes: Node[],
  removed: Node[],
): StepEditResult {
  const warnings: string[] = [];
  const surviving = new Set(nodes);
  const positionOf = new Map<Node, number>(nodes.map((n, i) => [n, i + 1]));

  const steps: JobStep[] = nodes.map((node, index) => {
    const stepId = index + 1;
    const step: JobStep = { ...node.step, stepId };

    if (step.onSuccessAction === StepAction.GoToStep) {
      if (node.onSuccessTarget && surviving.has(node.onSuccessTarget)) {
        step.onSuccessStepId = positionOf.get(node.onSuccessTarget)!;
      } else {
        // On success, falling through to the next step is what the operator
        // almost always meant; at the end of the list there is nothing to fall
        // through to, so the job finishes successfully.
        const hasNext = index < nodes.length - 1;
        step.onSuccessAction = hasNext ? StepAction.GoToNextStep : StepAction.QuitWithSuccess;
        step.onSuccessStepId = 0;
        warnings.push(
          `Step ${stepId} "${step.name}" pointed at a step that no longer exists on success; ` +
            `it now ${hasNext ? 'goes to the next step' : 'quits reporting success'}.`,
        );
      }
    } else {
      step.onSuccessStepId = 0;
    }

    if (step.onFailAction === StepAction.GoToStep) {
      if (node.onFailTarget && surviving.has(node.onFailTarget)) {
        step.onFailStepId = positionOf.get(node.onFailTarget)!;
      } else {
        // Never "go to the next step" here. A failure branch whose handler has
        // gone must stop the job, not continue as though nothing happened.
        step.onFailAction = StepAction.QuitWithFailure;
        step.onFailStepId = 0;
        warnings.push(
          `Step ${stepId} "${step.name}" pointed at a step that no longer exists on failure; ` +
            'it now quits reporting failure.',
        );
      }
    } else {
      step.onFailStepId = 0;
    }

    warnings.push(...applyEndOfListDefaults(step, index === nodes.length - 1, node.wasLast));

    return step;
  });

  const startNode = nodes.find((n) => n.step.stepId === definition.startStepId);
  const removedStart = removed.some((n) => n.step.stepId === definition.startStepId);

  // Every branch below assigns it, so there is no initialiser to go stale.
  let startStepId: number;
  if (removedStart || !startNode) {
    startStepId = 1;
    if (removedStart) {
      warnings.push('The job started at the step you removed, so it now starts at step 1.');
    }
  } else {
    startStepId = positionOf.get(startNode)!;
  }

  return {
    definition: { ...definition, steps, startStepId },
    warnings,
  };
}

/**
 * Keep the ends of the list sensible as steps move in and out of them.
 *
 * "Go to the next step" on the last step names nothing, and SSMS will not offer
 * it there — so a step that arrives at the end has to stop instead. The inverse
 * matters just as much: a step that used to be last still says "quit", and left
 * alone it would silently strand everything now sitting below it.
 *
 * Both rules fire *only* on the exact value the other rule would have written.
 * A middle step set to quit deliberately keeps quitting, because that is a real
 * thing to want — a job whose happy path ends early and whose error handler
 * lives at the bottom. Overriding that would be worse than leaving it, so
 * anything genuinely stranded is reported by `unreachableSteps` instead of
 * being quietly rewired.
 */
function applyEndOfListDefaults(step: JobStep, isLast: boolean, wasLast: boolean): string[] {
  const warnings: string[] = [];

  if (isLast && !wasLast) {
    if (step.onSuccessAction === StepAction.GoToNextStep) {
      step.onSuccessAction = StepAction.QuitWithSuccess;
      step.onSuccessStepId = 0;
      warnings.push(
        `Step ${step.stepId} "${step.name}" is now last, so on success it quits reporting ` +
          'success rather than going to a next step that does not exist.',
      );
    }
    if (step.onFailAction === StepAction.GoToNextStep) {
      step.onFailAction = StepAction.QuitWithFailure;
      step.onFailStepId = 0;
      warnings.push(
        `Step ${step.stepId} "${step.name}" is now last, so on failure it quits reporting failure.`,
      );
    }
  }

  if (wasLast && !isLast) {
    // Only the automatic pairing, both halves together: a step that quit on
    // success *and* failure was ending the job because it had nowhere to go.
    // One half changed by hand means the operator meant it.
    const wasAutomaticEnding =
      step.onSuccessAction === StepAction.QuitWithSuccess &&
      step.onFailAction === StepAction.QuitWithFailure;

    if (wasAutomaticEnding) {
      step.onSuccessAction = StepAction.GoToNextStep;
      step.onSuccessStepId = 0;
      warnings.push(
        `Step ${step.stepId} "${step.name}" is no longer last, so on success it now goes to the ` +
          'next step. On failure it still quits, so a failure here does not run what follows.',
      );
    }
  }

  return warnings;
}

/** "Step 4", avoiding a name already in use. */
function nextStepName(definition: JobDefinition): string {
  const taken = new Set(definition.steps.map((s) => s.name));
  let n = definition.steps.length + 1;
  while (taken.has(`Step ${n}`)) n += 1;
  return `Step ${n}`;
}
