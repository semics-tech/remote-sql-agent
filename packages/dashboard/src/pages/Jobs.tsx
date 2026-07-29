import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useJobGroups, type GroupKey, type JobGroup } from '../api.js';
import { Panel, QueryState, Empty, LastRunCell } from '../components.jsx';
import { formatDateTime, formatDuration } from '../format.js';

/**
 * Jobs across the whole estate, grouped.
 *
 * "Nightly Backup" exists on thirty servers, and the question is almost never
 * about one of them — it is "is this healthy everywhere?". The estate grid
 * cannot answer that, because it aggregates per instance rather than per job.
 * Groups are ordered with the failing ones first: this list is read top-down
 * when something is wrong.
 */

const GROUPINGS: Array<{ key: GroupKey; label: string; hint: string }> = [
  { key: 'name', label: 'Job name', hint: 'The same job across every instance that runs it' },
  { key: 'category', label: 'Category', hint: "SQL Agent's own job categories" },
  { key: 'owner', label: 'Owner', hint: 'The login each job runs as' },
  { key: 'schedule', label: 'Schedule', hint: 'Jobs that run at the same times' },
  { key: 'instance', label: 'Instance', hint: 'Everything on one server' },
];

export function Jobs() {
  const [groupBy, setGroupBy] = useState<GroupKey>('name');
  const [filter, setFilter] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);

  const { data, isLoading, error } = useJobGroups(groupBy, filter);
  const all = data?.groups ?? [];
  const groups = onlyProblems ? all.filter((g) => g.failing > 0 || g.neverRun > 0) : all;

  const active = GROUPINGS.find((g) => g.key === groupBy);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Jobs</h2>
        <select
          value={groupBy}
          onChange={(e) => setGroupBy(e.target.value as GroupKey)}
          aria-label="Group jobs by"
        >
          {GROUPINGS.map((g) => (
            <option key={g.key} value={g.key}>
              Group by {g.label.toLowerCase()}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="Filter by job, host or instance"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter jobs"
          style={{ minWidth: 240 }}
        />
        <label className="inline-check">
          <input
            type="checkbox"
            checked={onlyProblems}
            onChange={(e) => setOnlyProblems(e.target.checked)}
          />
          Only groups with a problem
        </label>
      </div>
      <p className="page-sub">{active?.hint}</p>

      <QueryState isLoading={isLoading} error={error}>
        {groups.length === 0 ? (
          <Empty
            title={all.length === 0 ? 'No jobs mirrored yet' : 'Nothing matches'}
            hint={
              all.length === 0
                ? 'Add a worker from the Estate page to start mirroring a SQL Server host.'
                : 'Clear the filter to see everything.'
            }
          />
        ) : (
          groups.map((group) => <GroupPanel key={group.key} group={group} groupBy={groupBy} />)
        )}
      </QueryState>
    </div>
  );
}

function GroupPanel({ group, groupBy }: { group: JobGroup; groupBy: GroupKey }) {
  // Groups that need attention open by default; healthy ones stay collapsed so
  // a fifty-instance estate does not open as a wall of green rows.
  const [open, setOpen] = useState(group.failing > 0);

  return (
    <Panel
      title={group.label}
      actions={
        <span className="group-summary">
          {group.failing > 0 ? <span className="badge failed">{group.failing} failing</span> : null}
          {group.running > 0 ? <span className="badge running">{group.running} running</span> : null}
          {group.disabled > 0 ? (
            <span className="badge neutral">{group.disabled} disabled</span>
          ) : null}
          {group.neverRun > 0 ? (
            <span className="badge neutral" title="Mirrored, but no run recorded">
              {group.neverRun} never run
            </span>
          ) : null}
          {group.failing === 0 && group.neverRun === 0 ? (
            <span className="badge online">all healthy</span>
          ) : null}
          <span className="faint">{group.total} instances</span>
          <button className="action" onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'}
          </button>
        </span>
      }
    >
      {open ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {/* Grouping by name makes the job column redundant and the
                    location column the useful one; grouping by instance is the
                    reverse. */}
                {groupBy === 'name' ? null : <th>Job</th>}
                <th>Instance</th>
                <th>Enabled</th>
                <th>Last run</th>
                <th className="right">Duration</th>
                <th>Next run</th>
                {groupBy === 'schedule' ? null : <th>Schedule</th>}
              </tr>
            </thead>
            <tbody>
              {group.members.map((m) => (
                <tr key={`${m.instanceId}:${m.jobUuid}`}>
                  {groupBy === 'name' ? null : (
                    <td className="nowrap">
                      <Link to={`/instances/${m.instanceId}/jobs/${m.jobUuid}`}>{m.jobName}</Link>
                    </td>
                  )}
                  <td className="nowrap">
                    <Link to={`/instances/${m.instanceId}/jobs/${m.jobUuid}`} className="mono">
                      {m.hostName}\{m.instanceName}
                    </Link>
                    {m.running ? (
                      <>
                        {' '}
                        <span className="badge running">running</span>
                      </>
                    ) : null}
                  </td>
                  <td>
                    {m.enabled ? (
                      <span className="muted">Yes</span>
                    ) : (
                      <span className="faint">No</span>
                    )}
                  </td>
                  <td className="nowrap">
                    <LastRunCell
                      status={m.lastRunStatus}
                      at={m.lastRunAt}
                      durationSeconds={m.lastRunDurationSeconds}
                    />
                  </td>
                  <td className="right nowrap mono muted">
                    {formatDuration(m.lastRunDurationSeconds)}
                  </td>
                  <td className="nowrap muted">{formatDateTime(m.nextRunAt)}</td>
                  {groupBy === 'schedule' ? null : (
                    <td className="muted">{m.scheduleSummary}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}
