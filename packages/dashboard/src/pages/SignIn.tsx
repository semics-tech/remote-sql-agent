import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth.jsx';

/** Sign-in. Offers whichever methods the deployment has configured. */
export function SignIn() {
  const { config, signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(
    new URLSearchParams(window.location.search).get('error'),
  );
  const [busy, setBusy] = useState(false);

  /**
   * Voided explicitly at the call site below, not passed to `onSubmit` raw.
   *
   * React's `onSubmit` expects void, so handing it an async function leaves the
   * promise unobserved. That is safe here only because the whole body sits
   * inside try/catch/finally — the first line added outside it would become a
   * sign-in failure nobody ever sees.
   */
  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username, password);
      window.location.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <div className="signin-card">
        <h1>
          Remote SQL Agent <span>estate control plane</span>
        </h1>

        {error ? <div className="error">{error}</div> : null}

        {config?.entraEnabled ? (
          <a className="signin-entra" href={config.entraLoginUrl}>
            Sign in with Microsoft
          </a>
        ) : null}

        {config?.entraEnabled && config?.localEnabled ? (
          <div className="signin-divider">
            <span>or</span>
          </div>
        ) : null}

        {config?.localEnabled ? (
          <form onSubmit={(event) => void onSubmit(event)}>
            <label htmlFor="username">Username</label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus={!config.entraEnabled}
            />

            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            <button className="action primary" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        ) : null}

        {config && !config.localEnabled && !config.entraEnabled ? (
          <p className="muted">
            No sign-in method is configured. Set <code>RSAGENT_AUTH_MODE</code> on the control
            plane.
          </p>
        ) : null}
      </div>
    </div>
  );
}
