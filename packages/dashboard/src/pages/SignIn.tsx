import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth.jsx';

/**
 * `?error=` on this page comes only from this control plane's own redirect
 * after a failed Entra sign-in, and the server only ever puts one of a small
 * set of fixed phrases there — never Entra's own free-text error description
 * or an exception message, both of which used to be reflected here verbatim.
 * The length cap is a second line of defence against a future redirect that
 * forgets that discipline: React already escapes this as text, so nothing
 * here executes, but a page-filling wall of attacker-chosen text styled as a
 * genuine system message is a phishing primitive on the real domain, on its
 * own, without needing a script to run.
 */
const MAX_SIGNIN_ERROR_LENGTH = 200;

function signInErrorFromUrl(): string | null {
  const raw = new URLSearchParams(window.location.search).get('error');
  return raw ? raw.slice(0, MAX_SIGNIN_ERROR_LENGTH) : null;
}

/** Sign-in. Offers whichever methods the deployment has configured. */
export function SignIn() {
  const { config, signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(signInErrorFromUrl());
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
