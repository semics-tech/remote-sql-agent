import type { JobStats, RunPoint } from '../api.js';
import { formatDuration, runStatusClass, runStatusLabel } from '../format.js';

/**
 * The high-level read on a job: is it reliable, how long does it take, and is
 * that changing.
 *
 * Deliberately four numbers and one chart. A DBA opening a job wants to know
 * within a second whether this is a healthy job with a slow week or a job that
 * has been failing since Tuesday; anything more elaborate is read less often,
 * not more.
 */
export function JobSummary({ stats }: { stats: JobStats | undefined }) {
  if (!stats) return null;

  if (stats.totalRuns === 0) {
    return (
      <div className="job-summary">
        <span className="faint">
          No runs recorded in the last {stats.windowDays} days, so there is nothing to summarise yet.
        </span>
      </div>
    );
  }

  const successRate = stats.successRate === null ? null : Math.round(stats.successRate * 100);
  const trend = stats.duration.trend;

  return (
    <div className="job-summary">
      <div className="job-stat">
        <div className={`n ${successRate !== null && successRate < 90 ? 'bad' : ''}`}>
          {successRate === null ? '—' : `${successRate}%`}
        </div>
        <div className="l">
          Succeeded
          <span className="faint"> · {stats.totalRuns} runs</span>
        </div>
      </div>

      <div className="job-stat">
        <div className="n">{formatDuration(round(stats.duration.medianSeconds))}</div>
        <div className="l">Typical duration</div>
      </div>

      <div className="job-stat">
        <div className="n">{formatDuration(round(stats.duration.p95Seconds))}</div>
        <div className="l">
          Slowest 5%
          <span className="faint"> · max {formatDuration(round(stats.duration.maxSeconds))}</span>
        </div>
      </div>

      <div className="job-stat">
        <div className={`n ${trend !== null && trend > 1.25 ? 'bad' : ''}`}>
          {trend === null ? '—' : `${trend > 1 ? '+' : ''}${Math.round((trend - 1) * 100)}%`}
        </div>
        <div className="l">
          Trend
          <span className="faint">
            {' '}
            · {trend === null ? 'too few runs' : 'recent vs older runs'}
          </span>
        </div>
      </div>

      <div className="job-chart">
        <DurationChart runs={stats.recentRuns} />
        <div className="l faint">
          Last {stats.recentRuns.length} runs, oldest first — height is duration, colour is outcome
        </div>
      </div>
    </div>
  );
}

/**
 * Duration per run, coloured by outcome.
 *
 * Bars rather than a line: runs are discrete events, and a line implies a
 * continuity between them that does not exist. Scaled to the tallest bar, so
 * the shape of the variation is what reads, not the absolute figure — that is
 * in the numbers alongside.
 */
function DurationChart({ runs }: { runs: RunPoint[] }) {
  if (runs.length === 0) return <div className="faint">No runs</div>;

  const max = Math.max(1, ...runs.map((r) => r.runDurationSeconds));

  return (
    <div className="duration-chart" role="img" aria-label={describeChart(runs, max)}>
      {runs.map((run) => {
        const height = Math.max(2, Math.round((run.runDurationSeconds / max) * 100));
        return (
          <span
            key={run.sqlInstanceId}
            className={`duration-bar ${runStatusClass(run.runStatus)}`}
            style={{ height: `${height}%` }}
            title={`${new Date(run.runDatetime).toLocaleString()} — ${runStatusLabel(
              run.runStatus,
            )} in ${formatDuration(run.runDurationSeconds)}`}
          />
        );
      })}
    </div>
  );
}

function describeChart(runs: RunPoint[], max: number): string {
  const failures = runs.filter((r) => r.runStatus === 0).length;
  return (
    `${runs.length} runs, oldest first. Longest ${formatDuration(max)}. ` +
    (failures === 0 ? 'None failed.' : `${failures} failed.`)
  );
}

function round(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}
