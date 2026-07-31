import { useState } from 'react';
import { Link } from 'react-router';
import { useEstateJobs, type EstateJob, type JobFacet } from '../api.js';
import { Empty, LastRunCell, Panel } from '../components.jsx';
import { formatDateTime, formatDuration } from '../format.js';
import { liveElapsedSeconds, useTicker } from '../ticker.js';

/**
 * Every job in the estate, on the page someone already has open.
 *
 * The estate grid aggregates per instance and the Jobs page groups by name.
 * Neither answers "show me everything that is failing right now, wherever it
 * lives" — which is the question a bad morning starts with, and the reason this
 * sits at the bottom of the overview rather than being a fourth page nobody
 * navigates to.
 *
 * Collapsed by default. A fifty-instance estate has thousands of jobs, and
 * opening the overview onto all of them would bury the four panels above that
 * are already ordered by urgency.
 */

interface FacetChip {
  key: JobFacet;
  label: string;
  /** Which run-status colour the chip carries, if any. */
  tone?: 'failed' | 'running' | 'retry' | 'cancelled' | 'succeeded' | 'drift';
  title: string;
}

const CHIPS: FacetChip[] = [
  { key: 'running', label: 'Running', tone: 'running', title: 'SQL Agent reports it executing now' },
  {
    key: 'longRunning',
    label: 'Running long',
    tone: 'retry',
    title: "Well past this job's own average for a successful run",
  },
  { key: 'failed', label: 'Failed', tone: 'failed', title: 'The most recent run failed' },
  {
    key: 'succeeded',
    label: 'Succeeded',
    tone: 'succeeded',
    title: 'The most recent run succeeded',
  },
  { key: 'retry', label: 'Retrying', tone: 'retry', title: 'The most recent run ended in a retry' },
  {
    key: 'cancelled',
    label: 'Cancelled',
    tone: 'cancelled',
    title: 'The most recent run was cancelled',
  },
  { key: 'neverRun', label: 'Never run', title: 'Mirrored, but no run on record' },
  { key: 'disabled', label: 'Disabled', title: 'Enabled is off in SQL Agent' },
  {
    key: 'drifted',
    label: 'Drifted',
    tone: 'drift',
    title: 'The newest version came from an edit made on the server itself',
  },
];

export function AllJobs() {
  const [open, setOpen] = useState(false);
  const [facets, setFacets] = useState<JobFacet[]>([]);
  const [filter, setFilter] = useState('');

  // Not fetched until opened: this is the one query on the page that can return
  // thousands of rows, and the panel is closed most of the time.
  const { data, isLoading, error, dataUpdatedAt } = useEstateJobs(facets, filter, open);

  const toggle = (facet: JobFacet) =>
    setFacets((current) =>
      current.includes(facet) ? current.filter((f) => f !== facet) : [...current, facet],
    );

  const counts = data?.counts;
  const title = open && data ? `All jobs (${data.matched} of ${data.total})` : 'All jobs';

  return (
    <Panel
      title={title}
      actions={
        <button className="action" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </button>
      }
    >
      {!open ? null : (
        <>
          <div className="filter-bar">
            <input
              type="search"
              placeholder="Filter by job, host, instance, category or environment"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter jobs"
              style={{ minWidth: 300 }}
            />
            <div className="chips" role="group" aria-label="Filter by status">
              {CHIPS.map((chip) => {
                const count = counts?.[chip.key] ?? 0;
                const on = facets.includes(chip.key);
                return (
                  <button
                    key={chip.key}
                    type="button"
                    className={`chip ${on ? 'on' : ''} ${chip.tone ? `chip-${chip.tone}` : ''}`}
                    aria-pressed={on}
                    title={chip.title}
                    // Nothing to select is still worth showing greyed: "0
                    // failed" is the answer someone is looking for, and a chip
                    // that vanishes reads as the filter being unavailable.
                    disabled={count === 0 && !on}
                    onClick={() => toggle(chip.key)}
                  >
                    {chip.label}
                    <span className="chip-count">{count}</span>
                  </button>
                );
              })}
            </div>
            {facets.length > 0 ? (
              <button className="action" onClick={() => setFacets([])}>
                Clear
              </button>
            ) : null}
          </div>

          {error ? (
            <div className="error">Could not load the job list: {String(error)}</div>
          ) : isLoading ? (
            <div className="empty">Loading…</div>
          ) : data && data.jobs.length === 0 ? (
            <Empty
              title={data.total === 0 ? 'No jobs mirrored yet' : 'Nothing matches'}
              hint={
                data.total === 0
                  ? 'Add a worker from the Estate page to start mirroring a SQL Server host.'
                  : 'Clear the filters to see everything.'
              }
            />
          ) : data ? (
            <>
              {data.truncated ? (
                <div className="notice">
                  This estate has more jobs than one query returns. Narrow it with the filter — the
                  counts above are incomplete.
                </div>
              ) : data.matched > data.returned ? (
                <div className="notice">
                  Showing the first {data.returned} of {data.matched} matching jobs. Narrow it with
                  the filter or a status to see the rest.
                </div>
              ) : null}
              <JobTable rows={data.jobs} fetchedAt={dataUpdatedAt} />
            </>
          ) : null}
        </>
      )}
    </Panel>
  );
}

function JobTable({ rows, fetchedAt }: { rows: EstateJob[]; fetchedAt: number }) {
  // Only ticks while something is actually running, so a list of idle jobs
  // costs nothing per second.
  const anyRunning = rows.some((r) => r.facets.includes('running'));
  const now = useTicker(anyRunning);

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Job</th>
            <th>Instance</th>
            <th>Environment</th>
            <th>Status</th>
            <th>Last run</th>
            <th className="right">Duration</th>
            <th>Next run</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.instanceId}:${r.jobUuid}`}>
              <td className="nowrap">
                <Link to={`/instances/${r.instanceId}/jobs/${r.jobUuid}`}>{r.jobName}</Link>
              </td>
              <td className="nowrap muted mono">
                {r.hostName}\{r.instanceName}
              </td>
              <td className="nowrap muted">{r.environmentTag ?? <span className="faint">—</span>}</td>
              <td className="nowrap">
                <FacetBadges job={r} />
              </td>
              <td className="nowrap">
                <LastRunCell
                  status={r.lastRunStatus}
                  at={r.lastRunAt}
                  durationSeconds={r.lastRunDurationSeconds}
                />
              </td>
              <td className="right nowrap mono muted">
                {r.facets.includes('running') ? (
                  // Counting up, like the panel above: the figure the server
                  // sent was already stale when it arrived.
                  formatDuration(liveElapsedSeconds(r.elapsedSeconds, fetchedAt, now))
                ) : (
                  formatDuration(r.lastRunDurationSeconds)
                )}
              </td>
              <td className="nowrap muted">{formatDateTime(r.nextRunAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The badges worth carrying into a row.
 *
 * Not every facet: "succeeded" is already the dot in the Last run column, and
 * repeating it would put a badge on almost every row and make the ones that
 * matter disappear into the noise.
 */
const BADGES: Array<{ facet: JobFacet; className: string; label: string }> = [
  { facet: 'longRunning', className: 'drift', label: 'long' },
  { facet: 'running', className: 'running', label: 'running' },
  { facet: 'failed', className: 'failed', label: 'failed' },
  { facet: 'disabled', className: 'neutral', label: 'disabled' },
  { facet: 'drifted', className: 'drift', label: 'drifted' },
  { facet: 'neverRun', className: 'neutral', label: 'never run' },
];

function FacetBadges({ job }: { job: EstateJob }) {
  const shown = BADGES.filter((b) => job.facets.includes(b.facet));
  if (shown.length === 0) return <span className="faint">—</span>;
  return (
    <>
      {shown.map((b) => (
        <span key={b.facet} className={`badge ${b.className}`}>
          {b.label}
        </span>
      ))}
    </>
  );
}
