import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render error anywhere below it and shows a page, not a blank
 * screen.
 *
 * React unmounts the whole tree on an uncaught render error — the default
 * here was nothing rendering at all, with the only trace of what happened in
 * the browser console. This is meant to run on a second monitor all day
 * (queryClient's own comment); a DBA watching it should see something that
 * says the page broke, not a screen that looks like the tab crashed.
 *
 * Must be a class component: getDerivedStateFromError and componentDidCatch
 * have no hook equivalent.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled error in the dashboard UI', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="app">
        <div className="empty" style={{ maxWidth: 560, margin: '80px auto' }}>
          <strong>Something went wrong on this page.</strong>
          <p>
            Nothing about the estate changed — this is the dashboard failing to render, not a
            problem with a worker or a SQL Server instance. Reloading usually clears it.
          </p>
          <button
            type="button"
            className="action primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
          <details style={{ marginTop: 16, textAlign: 'left' }}>
            <summary>Technical detail</summary>
            <pre className="error" style={{ whiteSpace: 'pre-wrap' }}>
              {this.state.error.stack ?? this.state.error.message}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
