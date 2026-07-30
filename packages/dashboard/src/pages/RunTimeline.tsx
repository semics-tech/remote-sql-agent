import { useEffect, useState } from 'react';
import { StepAction, type JobDefinition } from '@remote-sql-agent/protocol/browser';
import type { HistoryRun, JobStats } from '../api.js';
import { formatDateTime, formatDuration, runStatusClass, runStatusLabel } from '../format.js';

/**
 * A run on a time axis: steps down the side, elapsed time across.
 *
 * The question this answers is "what is it doing, and is that normal" — which a
 * list of steps cannot, because the thing you need is *when* each one ran and
 * for how long relative to the others. A step that usually takes two seconds
 * sitting at four minutes is obvious here and invisible in a table.
 *
 * One SQL Server behaviour shapes everything: msdb writes a step's history row
 * when the step **finishes**, and that row carries the step's *start* time plus
 * its duration. So finished steps can be placed exactly, and the step currently
 * running has no row at all — its bar is inferred from where the previous one
 * ended and extended to now.
 */

export interface TimelineStep {
  stepId: number;
  name: string;
  /** Seconds from the start of the run. */
  offsetSeconds: number;
  durationSeconds: number;
  /** msdb run_status, or null for the step still in flight. */
  runStatus: number | null;
  message: string | null;
  running: boolean;
}

export interface TimelineRun {
  startedAt: Date;
  totalSeconds: number;
  running: boolean;
  runStatus: number | null;
  steps: TimelineStep[];
}

/**
 * Build the timeline for the run in flight.
 *
 * Exported for testing: the offset arithmetic is the part that would be subtly
 * wrong in a way nobody notices, because a plausible-looking chart is not
 * obviously a lying one.
 */
export function buildLiveRun(
  definition: JobDefinition | null,
  stats: JobStats | undefined,
  nowMs: number,
): TimelineRun | null {
  const current = stats?.currentRun;
  if (!definition || !current?.startedAt) return null;

  const startedAt = new Date(current.startedAt);
  const startMs = startedAt.getTime();
  if (Number.isNaN(startMs)) return null;

  const elapsed = Math.max(0, Math.round((nowMs - startMs) / 1000));
  const byStepId = new Map(definition.steps.map((s) => [s.stepId, s]));

  const steps: TimelineStep[] = [];
  let cursor = 0;

  for (const done of current.completedSteps) {
    // Prefer the step's own recorded start; fall back to running total when
    // msdb has not given us one, so bars never collapse onto zero.
    const offset = done.startedAt
      ? Math.max(0, Math.round((new Date(done.startedAt).getTime() - startMs) / 1000))
      : cursor;

    steps.push({
      stepId: done.stepId,
      name: done.stepName ?? byStepId.get(done.stepId)?.name ?? `Step ${done.stepId}`,
      offsetSeconds: offset,
      durationSeconds: done.runDurationSeconds,
      runStatus: done.runStatus,
      message: done.message,
      running: false,
    });
    cursor = offset + done.runDurationSeconds;
  }

  // The step in flight has no history row yet — msdb writes one only when a
  // step finishes — so it has to be inferred, and it starts where the last
  // finished step ended and runs to now.
  const runningStepId = inferRunningStep(definition, current.completedSteps);
  if (runningStepId !== null && !steps.some((s) => s.stepId === runningStepId)) {
    steps.push({
      stepId: runningStepId,
      name: byStepId.get(runningStepId)?.name ?? `Step ${runningStepId}`,
      offsetSeconds: cursor,
      durationSeconds: Math.max(0, elapsed - cursor),
      runStatus: null,
      message: null,
      running: true,
    });
  }

  return {
    startedAt,
    totalSeconds: Math.max(elapsed, 1),
    running: true,
    runStatus: null,
    steps,
  };
}

/**
 * Which step is running, derived from the job's own flow.
 *
 * `sysjobactivity.last_executed_step_id` is the last step that **finished**,
 * not the one in progress — using it directly puts the live bar one step behind
 * and leaves the timeline empty for the whole of step one. Following the
 * definition instead is exact: Agent starts at `startStepId` and then obeys the
 * on-success / on-failure action of whatever just completed.
 *
 * Returns null when the last step's action ends the job, because at that point
 * nothing is running — the run is finishing.
 */
export function inferRunningStep(
  definition: JobDefinition,
  completed: JobStats['currentRun'] extends infer R
    ? R extends { completedSteps: infer C }
      ? C
      : never
    : never,
): number | null {
  if (completed.length === 0) return definition.startStepId;

  const last = completed[completed.length - 1]!;
  const step = definition.steps.find((s) => s.stepId === last.stepId);
  if (!step) return null;

  const succeeded = last.runStatus === 1;
  const action = succeeded ? step.onSuccessAction : step.onFailAction;
  const target = succeeded ? step.onSuccessStepId : step.onFailStepId;

  if (action === StepAction.GoToStep) return target || null;
  if (action === StepAction.GoToNextStep) {
    const next = definition.steps
      .filter((s) => s.stepId > last.stepId)
      .sort((a, b) => a.stepId - b.stepId)[0];
    return next?.stepId ?? null;
  }
  // QuitWithSuccess / QuitWithFailure: the run is ending, nothing follows.
  return null;
}

/** Build the timeline for a run that has finished, from its history rows. */
export function buildHistoricRun(run: HistoryRun | undefined): TimelineRun | null {
  if (!run) return null;

  const startedAt = new Date(run.runDatetime);
  const startMs = startedAt.getTime();
  if (Number.isNaN(startMs)) return null;

  let cursor = 0;
  const steps: TimelineStep[] = run.steps.map((s) => {
    const offset = s.runDatetime
      ? Math.max(0, Math.round((new Date(s.runDatetime).getTime() - startMs) / 1000))
      : cursor;
    cursor = offset + s.runDurationSeconds;
    return {
      stepId: s.stepId,
      name: s.stepName ?? `Step ${s.stepId}`,
      offsetSeconds: offset,
      durationSeconds: s.runDurationSeconds,
      runStatus: s.runStatus,
      message: s.message,
      running: false,
    };
  });

  return {
    startedAt,
    // A sub-second run still needs a non-zero axis or every bar divides by zero.
    totalSeconds: Math.max(run.runDurationSeconds, cursor, 1),
    running: false,
    runStatus: run.runStatus,
    steps,
  };
}

export function RunTimeline({
  definition,
  stats,
  history,
  running,
}: {
  definition: JobDefinition | null;
  stats: JobStats | undefined;
  history: HistoryRun[];
  running: boolean;
}) {
  const now = useTicker(running);

  // While a run is in flight, show it. Otherwise show the last one — the panel
  // is never blank, so there is always something to compare the next run to.
  const live = running ? buildLiveRun(definition, stats, now) : null;
  const run = live ?? buildHistoricRun(history[0]);

  if (!run) {
    return (
      <div className="empty">
        <strong>No runs recorded yet</strong>
        <span>The timeline appears the first time this job runs.</span>
      </div>
    );
  }

  const ticks = axisTicks(run.totalSeconds);

  return (
    <div className="timeline">
      <div className="timeline-head">
        {run.running ? (
          <span className="badge running">Running</span>
        ) : (
          <span className={`badge ${run.runStatus === 1 ? 'online' : run.runStatus === 0 ? 'failed' : 'neutral'}`}>
            {runStatusLabel(run.runStatus)}
          </span>
        )}
        <span className="mono">{formatDuration(run.totalSeconds)}</span>
        <span className="faint">started {formatDateTime(run.startedAt.toISOString())}</span>
        {!run.running ? <span className="faint">· most recent run</span> : null}
      </div>

      <div className="timeline-grid">
        <div className="timeline-axis" aria-hidden="true">
          {ticks.map((t) => (
            <span
              key={t}
              className="timeline-tick"
              style={{ left: `${(t / run.totalSeconds) * 100}%` }}
            >
              {formatDuration(t)}
            </span>
          ))}
        </div>

        <ol className="timeline-lanes">
          {run.steps.map((step) => {
            const left = (step.offsetSeconds / run.totalSeconds) * 100;
            // Floored so a zero-second step is still a visible mark rather than
            // nothing at all — "it ran and was instant" is information.
            const width = Math.max(1.5, (step.durationSeconds / run.totalSeconds) * 100);
            const label = `Step ${step.stepId} ${step.name}: ${
              step.running ? 'running' : runStatusLabel(step.runStatus)
            } for ${formatDuration(step.durationSeconds)}`;

            return (
              <li key={step.stepId} className="timeline-lane">
                <span className="timeline-label" title={`${step.stepId}. ${step.name}`}>
                  <span className="timeline-step-id">{step.stepId}</span>
                  {step.name}
                </span>
                <span className="timeline-track">
                  {ticks.map((t) => (
                    <span
                      key={t}
                      className="timeline-gridline"
                      style={{ left: `${(t / run.totalSeconds) * 100}%` }}
                      aria-hidden="true"
                    />
                  ))}
                  <span
                    className={`timeline-bar ${step.running ? 'running' : runStatusClass(step.runStatus)}`}
                    style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                    title={`${label}${step.message ? `\n\n${step.message}` : ''}`}
                    role="img"
                    aria-label={label}
                  />
                </span>
                <span className="timeline-duration mono">
                  {formatDuration(step.durationSeconds)}
                </span>
              </li>
            );
          })}
        </ol>

        {/* The advancing edge. Only while running — on a finished run it would
            just be a line at the end pretending to mean something. */}
        {run.running ? <span className="timeline-now" aria-hidden="true" /> : null}
      </div>

      {run.steps.length === 0 ? (
        <p className="faint" style={{ margin: '6px 0 0' }}>
          Waiting for the first step to report. SQL Server records a step when it finishes, so a
          fast step may complete before it appears.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Four or five round numbers across the axis.
 *
 * Snapped to human intervals — 5s, 30s, 5m — because an axis labelled 0, 7, 14,
 * 21 is harder to read than one labelled 0, 10, 20, 30 even though it fits the
 * data better.
 */
function axisTicks(totalSeconds: number): number[] {
  const candidates = [1, 5, 10, 15, 30, 60, 300, 600, 1800, 3600, 7200, 21600];
  const step = candidates.find((c) => totalSeconds / c <= 6) ?? 43_200;

  const ticks: number[] = [];
  for (let t = 0; t < totalSeconds; t += step) ticks.push(t);
  return ticks;
}

/**
 * A one-second tick while a run is live.
 *
 * The bar for the running step is drawn against "now", so without this it would
 * only grow when a poll happened to land.
 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}
