import { useEffect, useState } from 'react';
import {
  useInstanceConfigs,
  useWorkerAdmin,
  type InstanceConfigView,
} from '../api.js';
import { Empty, QueryState } from '../components.jsx';
import { formatRelative } from '../format.js';
import {
  INSECURE_CONTEXT_MESSAGE,
  canEncryptCredentials,
  encryptCredential,
} from '../crypto.js';

/**
 * Telling a worker which SQL instances to monitor, and how to log in.
 *
 * The password never leaves this browser in the clear. It is encrypted here,
 * with the public key the target worker generated on its own SQL host, and the
 * control plane stores a blob it has no key for. That is the whole point: a
 * control plane holding working logins for fifty instances would be the single
 * most valuable thing in the estate, and it is reachable from every network
 * segment by design.
 *
 * Integrated authentication is offered first because it is better still —
 * there is no password to store anywhere.
 */

const STATUS_LABEL: Record<InstanceConfigView['status'], { text: string; badge: string }> = {
  connected: { text: 'Connected', badge: 'online' },
  pending: { text: 'Contacting…', badge: 'neutral' },
  awaiting_credentials: { text: 'Needs a credential', badge: 'drift' },
  auth_failed: { text: 'Login refused', badge: 'failed' },
  unreachable: { text: 'Cannot reach', badge: 'failed' },
  decrypt_failed: { text: 'Credential unreadable', badge: 'failed' },
};

export function InstanceConfigPanel({
  workerId,
  hostName,
  liveInstanceCount = 0,
}: {
  workerId: string;
  hostName: string;
  /** Instances actually reporting, however they were configured. Lets the
   * empty state tell "idle" apart from "configured in worker.yaml". */
  liveInstanceCount?: number;
}) {
  const configs = useInstanceConfigs(workerId);
  const [editing, setEditing] = useState<InstanceConfigView | 'new' | null>(null);
  const admin = useWorkerAdmin();
  const rows = configs.data?.configs ?? [];
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function remove(configId: string): Promise<void> {
    setRemovingId(configId);
    setRemoveError(null);
    try {
      await admin.removeInstanceConfig(workerId, configId);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : 'Could not remove the instance.');
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="instance-config">
      {removeError ? <div className="error">{removeError}</div> : null}
      <QueryState isLoading={configs.isLoading} error={configs.error}>
        {rows.length === 0 ? (
          <Empty
            title={
              liveInstanceCount > 0
                ? `${hostName} is monitoring ${liveInstanceCount} instance(s) from its own worker.yaml`
                : `${hostName} is not monitoring anything yet`
            }
            hint={
              liveInstanceCount > 0
                ? 'Those are configured on the host and are not managed from here. Anything you add below is monitored as well.'
                : 'Add the SQL Server instances on this host. The worker connects to them locally.'
            }
          />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Instance</th>
                  <th>Address</th>
                  <th>Signs in as</th>
                  <th>Status</th>
                  <th style={{ width: 150 }} />
                </tr>
              </thead>
              <tbody>
                {rows.map((config) => {
                  const status = STATUS_LABEL[config.status];
                  return (
                    <tr key={config.id}>
                      <td className="nowrap mono">{config.instanceName}</td>
                      <td className="nowrap muted mono">{config.serverAddress}</td>
                      <td className="nowrap muted">
                        {config.authMode === 'integrated' ? (
                          <span title="The worker's own service account. No password is stored anywhere.">
                            the service account
                          </span>
                        ) : (
                          <span className="mono">{config.loginName}</span>
                        )}
                      </td>
                      <td>
                        <span className={`badge ${status.badge}`} title={config.statusDetail ?? ''}>
                          {status.text}
                        </span>
                        {config.statusAt ? (
                          <span className="faint"> {formatRelative(config.statusAt)}</span>
                        ) : null}
                      </td>
                      <td className="nowrap">
                        <button className="action" onClick={() => setEditing(config)}>
                          Edit
                        </button>
                        <button
                          className="action danger"
                          disabled={removingId === config.id}
                          onClick={() => void remove(config.id)}
                        >
                          {removingId === config.id ? 'Removing…' : 'Remove'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* A refused login is the one status that needs a nudge rather than a
            badge: the fix is to type the password again, right here. */}
        {rows.some((c) => c.status === 'auth_failed' || c.status === 'decrypt_failed') ? (
          <div className="notice">
            {rows.find((c) => c.status === 'decrypt_failed')
              ? 'This worker cannot decrypt a stored credential — usually because it was reinstalled and generated a new key. Edit the instance and enter the password again.'
              : 'SQL Server refused a login. Edit the instance and enter the password again, or check the login still exists and is not disabled.'}
          </div>
        ) : null}

        <div className="action-bar">
          <button className="action" onClick={() => setEditing('new')}>
            Add an instance
          </button>
        </div>
      </QueryState>

      {editing ? (
        <InstanceConfigForm
          workerId={workerId}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function InstanceConfigForm({
  workerId,
  existing,
  onClose,
}: {
  workerId: string;
  existing: InstanceConfigView | null;
  onClose: () => void;
}) {
  const admin = useWorkerAdmin();

  const [instanceName, setInstanceName] = useState(existing?.instanceName ?? 'MSSQLSERVER');
  const [serverAddress, setServerAddress] = useState(existing?.serverAddress ?? 'localhost');
  const [authMode, setAuthMode] = useState<'integrated' | 'sql'>(existing?.authMode ?? 'integrated');
  const [loginName, setLoginName] = useState(existing?.loginName ?? '');
  const [password, setPassword] = useState('');
  const [encryptTls, setEncryptTls] = useState(existing?.encryptTls ?? true);
  const [trustServerCertificate, setTrust] = useState(existing?.trustServerCertificate ?? false);
  const [environmentTag, setEnvironmentTag] = useState(existing?.environmentTag ?? '');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const secureContext = canEncryptCredentials();
  const needsPassword = authMode === 'sql' && !existing?.hasCredential && password.length === 0;

  /**
   * The fingerprint of the key the password will be encrypted to.
   *
   * Shown because it is the only thing an operator can check. The key arrives
   * from the control plane, which is precisely the party the encryption is
   * meant to exclude — so a control plane serving a key of its own would be
   * able to read every credential entered here, and nothing in the browser can
   * pin it. Printing the fingerprint lets it be compared against what the
   * worker logged on the SQL host, which is a check that does not depend on
   * trusting the control plane at all.
   */
  const [keyFingerprint, setKeyFingerprint] = useState<string | null>(null);
  useEffect(() => {
    if (authMode !== 'sql' || !secureContext) return;
    let cancelled = false;
    void admin
      .credentialKey(workerId)
      .then((key) => {
        if (!cancelled) setKeyFingerprint(key.fingerprint);
      })
      .catch(() => {
        if (!cancelled) setKeyFingerprint(null);
      });
    return () => {
      cancelled = true;
    };
  }, [admin, authMode, secureContext, workerId]);

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    setNote(null);

    try {
      let credentialCiphertext: string | undefined;
      let credentialKeyFingerprint: string | undefined;

      if (authMode === 'sql' && password.length > 0) {
        // Fetched per save rather than cached: if the worker has re-keyed since
        // this form opened, encrypting to the stale key would produce ciphertext
        // nothing can read. The server rejects a mismatched fingerprint too.
        const key = await admin.credentialKey(workerId);
        credentialCiphertext = await encryptCredential(key.publicKeyPem, password);
        credentialKeyFingerprint = key.fingerprint;
      }

      const result = await admin.saveInstanceConfig(workerId, {
        instanceName: instanceName.trim(),
        serverAddress: serverAddress.trim(),
        authMode,
        loginName: authMode === 'sql' ? loginName.trim() : null,
        credentialCiphertext,
        credentialKeyFingerprint,
        encryptTls,
        trustServerCertificate,
        environmentTag: environmentTag.trim() || null,
      });

      // Dropped as soon as it has been encrypted and sent.
      setPassword('');
      setNote(result.note);
      if (result.delivered) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that configuration.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ borderColor: 'var(--accent)' }}>
      <div className="panel-head">
        {existing ? `Edit ${existing.instanceName}` : 'Add an instance'}
      </div>

      {error ? <div className="error">{error}</div> : null}
      {note ? <div className="notice">{note}</div> : null}

      <div className="editor-grid">
        <label htmlFor="cfg-instance">Instance name</label>
        <div>
          <input
            id="cfg-instance"
            type="text"
            value={instanceName}
            disabled={Boolean(existing)}
            onChange={(e) => setInstanceName(e.target.value)}
          />
          <div className="faint">
            As SQL Server knows it. The default instance is <span className="mono">MSSQLSERVER</span>.
          </div>
        </div>

        <label htmlFor="cfg-address">Address</label>
        <div>
          <input
            id="cfg-address"
            type="text"
            value={serverAddress}
            onChange={(e) => setServerAddress(e.target.value)}
          />
          <div className="faint">
            How the worker reaches it from that host — usually{' '}
            <span className="mono">localhost</span>. A named instance or port goes here too:{' '}
            <span className="mono">localhost\SQL2019</span>,{' '}
            <span className="mono">localhost,1433</span>.
          </div>
        </div>

        <label htmlFor="cfg-auth">Authentication</label>
        <div>
          <select
            id="cfg-auth"
            value={authMode}
            onChange={(e) => setAuthMode(e.target.value as 'integrated' | 'sql')}
          >
            <option value="integrated">Windows — the worker's service account</option>
            <option value="sql">SQL Server login</option>
          </select>
          <div className="faint">
            {authMode === 'integrated'
              ? 'Nothing is stored. Grant the service account SQLAgentReaderRole in msdb. This is the safer option and the one to prefer.'
              : 'The password is encrypted in your browser to this worker’s own key. The control plane stores it, but cannot read it.'}
          </div>
        </div>

        {authMode === 'sql' ? (
          <>
            <label htmlFor="cfg-login">Login</label>
            <input
              id="cfg-login"
              type="text"
              value={loginName}
              autoComplete="off"
              placeholder="rsagent_worker"
              onChange={(e) => setLoginName(e.target.value)}
            />

            <label htmlFor="cfg-password">Password</label>
            <div>
              <input
                id="cfg-password"
                type="password"
                value={password}
                autoComplete="new-password"
                placeholder={existing?.hasCredential ? 'unchanged' : ''}
                disabled={!secureContext}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="faint">
                {!secureContext ? (
                  <span style={{ color: 'var(--status-failed)' }}>{INSECURE_CONTEXT_MESSAGE}</span>
                ) : existing?.hasCredential ? (
                  `Set ${formatRelative(existing.credentialUpdatedAt)}. Leave blank to keep it.`
                ) : (
                  'Encrypted here before it is sent. It is not stored in this page after saving.'
                )}
              </div>
              {secureContext && keyFingerprint ? (
                <div className="faint">
                  Encrypting to key{' '}
                  <span className="mono" title={keyFingerprint}>
                    {keyFingerprint.slice(0, 16)}…
                  </span>
                  . The worker logs this fingerprint on the SQL host when it starts — comparing
                  them is what proves the control plane has not substituted a key it could read
                  the password with.
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        <label htmlFor="cfg-tag">Environment tag</label>
        <input
          id="cfg-tag"
          type="text"
          value={environmentTag}
          placeholder="production"
          onChange={(e) => setEnvironmentTag(e.target.value)}
        />

        <label htmlFor="cfg-encrypt">Encrypt the connection</label>
        <div>
          <input
            id="cfg-encrypt"
            type="checkbox"
            checked={encryptTls}
            onChange={(e) => setEncryptTls(e.target.checked)}
          />
          <label className="inline-check" style={{ marginLeft: 16 }}>
            <input
              type="checkbox"
              checked={trustServerCertificate}
              onChange={(e) => setTrust(e.target.checked)}
            />
            Trust the server certificate
          </label>
          <div className="faint">
            Trusting the certificate is usually required for a SQL Server using its self-signed
            default, and means the connection is encrypted but not authenticated.
          </div>
        </div>
      </div>

      <div className="action-bar">
        <button
          className="action primary"
          disabled={
            busy ||
            instanceName.trim().length === 0 ||
            serverAddress.trim().length === 0 ||
            (authMode === 'sql' && loginName.trim().length === 0) ||
            needsPassword ||
            (authMode === 'sql' && !secureContext && !existing?.hasCredential)
          }
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save and connect'}
        </button>
        <button className="action" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
