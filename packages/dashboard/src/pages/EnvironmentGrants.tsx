import { useState } from 'react';
import { ROLES } from '@remote-sql-agent/protocol/browser';
import type { Role } from '@remote-sql-agent/protocol/browser';
import {
  ALL_ENVIRONMENTS,
  useEnvironmentGrantAdmin,
  useEnvironmentGrants,
  type EnvironmentGrant,
  type GrantSubjectKind,
} from '../api.js';
import { Empty, Panel, QueryState } from '../components.jsx';
import { formatDateTime } from '../format.js';

/**
 * Who may write where.
 *
 * A grant *adds* a role inside one environment on top of the user's base role,
 * and can never take anything away. The screen says so in as many words,
 * because "grant" reads to most people as though it might also restrict — and
 * an administrator who believes these rows hide production from everyone else
 * has drawn exactly the wrong conclusion about their estate.
 */

const SUBJECT_KINDS: Array<{ key: GrantSubjectKind; label: string; hint: string; placeholder: string }> = [
  {
    key: 'entra_group',
    label: 'Entra group',
    hint: 'The group’s object id, from Entra. Not its name — a display name can be changed and then reused by a different group, and the grant would follow the name.',
    placeholder: '00000000-0000-0000-0000-000000000000',
  },
  {
    key: 'app_role',
    label: 'Entra app role',
    hint: 'The app role value as Entra emits it in the token, e.g. rsagent.production.',
    placeholder: 'rsagent.production',
  },
  {
    key: 'user',
    label: 'One user',
    hint: 'A user id from this control plane. Prefer a group: a grant against a person has to be revisited when they change team.',
    placeholder: 'user id',
  },
];

export function EnvironmentGrants() {
  const { data, isLoading, error } = useEnvironmentGrants();
  const grants = data?.grants ?? [];

  return (
    <QueryState isLoading={isLoading} error={error}>
      <p className="page-sub">
        A grant <strong>adds</strong> a role within one environment. It never removes anything, so
        everyone keeps the estate-wide role they already have — which is why the usual shape is a
        base role of Viewer plus a grant of Editor on <span className="mono">production</span>: read
        every server, write one environment. Nothing here hides an instance, a job or a run from
        anybody.
      </p>

      <GrantForm environments={data?.environments ?? []} />

      <Panel title={`Grants (${grants.length})`}>
        {grants.length === 0 ? (
          <Empty
            title="No environment grants"
            hint="Everyone can do exactly what their base role allows, everywhere."
          />
        ) : (
          <GrantTable grants={grants} />
        )}
      </Panel>

      {(data?.untaggedInstances.length ?? 0) > 0 ? (
        <Panel title={`Instances with no environment (${data!.untaggedInstances.length})`}>
          {/* The quiet failure mode of the whole design. A grant for a named
              environment does not reach an untagged instance, so these are
              writable by base role only — and from the operator's side that
              looks identical to a permissions bug. */}
          <div className="notice">
            {/* One element, not a run of text and spans: `.notice` is a flex
                container with a gap, so sibling children become separate flex
                items and the inline `*` gets pushed to the far end of the row. */}
            <span>
              A grant for a named environment does not reach these. They are writable only by
              whoever already has the role estate-wide. Set an environment on each from the
              worker&apos;s instance configuration, or write a grant for{' '}
              <span className="mono">{ALL_ENVIRONMENTS}</span>.
            </span>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Host</th>
                  <th>Instance</th>
                </tr>
              </thead>
              <tbody>
                {data!.untaggedInstances.map((i) => (
                  <tr key={i.instanceId}>
                    <td className="nowrap mono">{i.hostName}</td>
                    <td className="nowrap mono">{i.instanceName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : null}
    </QueryState>
  );
}

function GrantForm({ environments }: { environments: string[] }) {
  const admin = useEnvironmentGrantAdmin();
  const [subjectKind, setSubjectKind] = useState<GrantSubjectKind>('entra_group');
  const [subjectKey, setSubjectKey] = useState('');
  const [subjectLabel, setSubjectLabel] = useState('');
  const [environmentTag, setEnvironmentTag] = useState('');
  const [role, setRole] = useState<Role>('Editor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kind = SUBJECT_KINDS.find((k) => k.key === subjectKind)!;
  const complete = subjectKey.trim().length > 0 && environmentTag.trim().length > 0;

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await admin.save({
        subjectKind,
        subjectKey: subjectKey.trim(),
        subjectLabel: subjectLabel.trim() || null,
        environmentTag: environmentTag.trim(),
        role,
      });
      setSubjectKey('');
      setSubjectLabel('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the grant.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Add a grant">
      {error ? <div className="error">{error}</div> : null}
      <div className="editor-grid">
        <label htmlFor="grant-kind">Applies to</label>
        <select
          id="grant-kind"
          value={subjectKind}
          onChange={(e) => setSubjectKind(e.target.value as GrantSubjectKind)}
        >
          {SUBJECT_KINDS.map((k) => (
            <option key={k.key} value={k.key}>
              {k.label}
            </option>
          ))}
        </select>

        <label htmlFor="grant-subject">{kind.label}</label>
        <div>
          <input
            id="grant-subject"
            type="text"
            value={subjectKey}
            placeholder={kind.placeholder}
            onChange={(e) => setSubjectKey(e.target.value)}
            style={{ width: '100%', maxWidth: 420 }}
          />
          <div className="faint" style={{ marginTop: 4 }}>
            {kind.hint}
          </div>
        </div>

        <label htmlFor="grant-label">Name it</label>
        <input
          id="grant-label"
          type="text"
          value={subjectLabel}
          placeholder="production DBAs"
          onChange={(e) => setSubjectLabel(e.target.value)}
        />

        <label htmlFor="grant-environment">Environment</label>
        <div>
          <input
            id="grant-environment"
            type="text"
            list="grant-environments"
            value={environmentTag}
            placeholder="production"
            onChange={(e) => setEnvironmentTag(e.target.value)}
          />
          {/* A list of the tags actually in use, because a grant for an
              environment nobody has tagged does nothing and says nothing. */}
          <datalist id="grant-environments">
            {environments.map((environment) => (
              <option key={environment} value={environment} />
            ))}
            <option value={ALL_ENVIRONMENTS} />
          </datalist>
          <div className="faint" style={{ marginTop: 4 }}>
            Matched against the instance&apos;s environment, ignoring case.{' '}
            <span className="mono">{ALL_ENVIRONMENTS}</span> means every environment, including
            instances with none set.
          </div>
        </div>

        <label htmlFor="grant-role">Role in that environment</label>
        <select id="grant-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>

      <div className="action-bar">
        <button className="action primary" disabled={!complete || busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Add grant'}
        </button>
      </div>
    </Panel>
  );
}

function GrantTable({ grants }: { grants: EnvironmentGrant[] }) {
  const admin = useEnvironmentGrantAdmin();
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(id: string): Promise<void> {
    setRemoving(id);
    setError(null);
    try {
      await admin.remove(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the grant.');
    } finally {
      setRemoving(null);
    }
  }

  return (
    <div className="table-scroll">
      {error ? <div className="error">{error}</div> : null}
      <table>
        <thead>
          <tr>
            <th>Environment</th>
            <th>Applies to</th>
            <th>Subject</th>
            <th>Adds the role</th>
            <th>Created</th>
            <th style={{ width: 90 }} />
          </tr>
        </thead>
        <tbody>
          {grants.map((g) => (
            <tr key={g.id}>
              <td className="nowrap">
                {g.environmentTag === ALL_ENVIRONMENTS ? (
                  <span className="badge drift" title="Every environment, including untagged">
                    every environment
                  </span>
                ) : (
                  <span className="mono">{g.environmentTag}</span>
                )}
              </td>
              <td className="nowrap muted">
                {SUBJECT_KINDS.find((k) => k.key === g.subjectKind)?.label ?? g.subjectKind}
              </td>
              <td className="nowrap">
                {g.subjectLabel ? <>{g.subjectLabel} </> : null}
                <span className="faint mono">{g.subjectKey}</span>
              </td>
              <td className="nowrap">
                <span className="badge neutral">{g.role}</span>
              </td>
              <td className="nowrap muted">{formatDateTime(g.createdAt)}</td>
              <td className="nowrap">
                <button
                  className="action danger"
                  disabled={removing === g.id}
                  onClick={() => void remove(g.id)}
                >
                  {removing === g.id ? 'Removing…' : 'Remove'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
