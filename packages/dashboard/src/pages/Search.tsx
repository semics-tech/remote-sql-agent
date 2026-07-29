import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useSearch } from '../api.js';
import { Panel, QueryState, Empty } from '../components.jsx';

/**
 * §9.5 Cross-estate search.
 *
 * The question this exists to answer: "which servers still reference X in a job
 * step?" SSMS cannot answer it at any price, which is why the spec calls it the
 * killer feature and why it gets its own top-level screen rather than a filter
 * box on the instance view.
 */
export function Search() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const { data, isLoading, error } = useSearch(query);

  const hits = data?.hits ?? [];
  const instanceCount = new Set(hits.map((h) => h.instanceId)).size;

  return (
    <div className="page">
      <div className="page-head">
        <h2>Search the estate</h2>
      </div>
      <p className="page-sub">
        Find jobs by name, or by text inside any job step body, across every instance at once.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input);
        }}
        style={{ display: 'flex', gap: 8, marginBottom: 14 }}
      >
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. LEGACYFIN01, sp_send_dbmail, TRUNCATE TABLE"
          style={{ flex: 1, maxWidth: 480 }}
          aria-label="Search job names and step bodies"
        />
        <button className="action" type="submit">
          Search
        </button>
      </form>

      {query.trim().length < 2 ? (
        <Empty
          title="Type at least two characters"
          hint="Searches job names and the full text of every T-SQL, PowerShell and CmdExec step body."
        />
      ) : (
        <QueryState isLoading={isLoading} error={error}>
          <Panel
            title={`${hits.length} ${hits.length === 1 ? 'job' : 'jobs'} across ${instanceCount} ${
              instanceCount === 1 ? 'instance' : 'instances'
            }`}
          >
            {hits.length === 0 ? (
              <Empty title={`Nothing matches “${query}”`} hint="Search is case-insensitive and matches substrings." />
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Host / instance</th>
                      <th>Job</th>
                      <th>Matched in</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hits.map((h) => (
                      <tr key={`${h.instanceId}:${h.jobUuid}`}>
                        <td className="nowrap mono">
                          <Link to={`/instances/${h.instanceId}`}>
                            {h.hostName}\{h.instanceName}
                          </Link>
                        </td>
                        <td className="nowrap">
                          <Link to={`/instances/${h.instanceId}/jobs/${h.jobUuid}`}>{h.jobName}</Link>{' '}
                          {!h.enabled ? <span className="badge neutral">disabled</span> : null}
                        </td>
                        <td>
                          {h.nameMatched ? <div className="muted">Job name</div> : null}
                          {h.matchingSteps.map((s) => (
                            <div key={s.stepId} style={{ marginBottom: 3 }}>
                              <span className="faint">
                                Step {s.stepId} · {s.stepName}
                              </span>
                              <pre className="code" style={{ marginTop: 2, fontSize: 11.5 }}>
                                {s.excerpt}
                              </pre>
                            </div>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </QueryState>
      )}
    </div>
  );
}
