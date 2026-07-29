import { StepAction, type JobDefinition, type JobStep } from './job-definition.js';

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
  const nodes: Node[] = ordered.map((step) => ({
    step: { ...step },
    onSuccessTarget: null,
    onFailTarget: null,
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

    return step;
  });

  let startStepId = definition.startStepId;
  const startNode = nodes.find((n) => n.step.stepId === definition.startStepId);
  const removedStart = removed.some((n) => n.step.stepId === definition.startStepId);

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

/** "Step 4", avoiding a name already in use. */
function nextStepName(definition: JobDefinition): string {
  const taken = new Set(definition.steps.map((s) => s.name));
  let n = definition.steps.length + 1;
  while (taken.has(`Step ${n}`)) n += 1;
  return `Step ${n}`;
}
