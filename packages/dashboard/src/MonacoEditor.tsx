import { useEffect, useRef, useState } from 'react';
import { Editor, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/powershell/register';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import { lintStepBody, summariseDiagnostics, type Diagnostic } from './lint/index.js';

/**
 * Editable step body. Shares Monaco with the diff viewer, and like it is
 * bundled locally rather than fetched from a CDN — the target networks have no
 * general egress.
 */
loader.config({ monaco });
self.MonacoEnvironment = { getWorker: () => new editorWorker() };

/** Marker owner. Namespaced so clearing ours never touches Monaco's own. */
const MARKER_OWNER = 'rsagent';

/**
 * Long enough that linting never runs mid-keystroke, short enough that it feels
 * like the editor noticed rather than that a job ran.
 */
const LINT_DELAY_MS = 250;

const SEVERITY: Record<Diagnostic['severity'], monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  info: monaco.MarkerSeverity.Info,
};

export default function MonacoEditorPane({
  value,
  language,
  onChange,
  readOnly = false,
}: {
  value: string;
  language: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}) {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const lines = value.split('\n').length;
  const height = Math.min(Math.max(lines * 19 + 24, 140), 480);

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);

  // Debounced so a body of any size does not lint on every keystroke. The
  // dependency on `language` matters as much as the one on `value`: switching a
  // step from TSQL to PowerShell must re-lint the same text under the other set
  // of rules, and would otherwise leave the previous language's markers behind.
  useEffect(() => {
    const timer = setTimeout(() => setDiagnostics(lintStepBody(value, language)), LINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value, language]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      MARKER_OWNER,
      diagnostics.map((d) => ({
        severity: SEVERITY[d.severity],
        // The code is shown by Monaco next to the message, so a rule can be
        // named in a conversation rather than described.
        code: d.code,
        message: d.message,
        startLineNumber: d.startLine,
        startColumn: d.startColumn,
        endLineNumber: d.endLine,
        endColumn: d.endColumn,
      })),
    );
  }, [diagnostics]);

  // Markers are attached to the model, and the model outlives this component
  // when Monaco reuses it for the next step. Clearing on unmount is what stops
  // one step's findings appearing against another's body.
  useEffect(
    () => () => {
      const model = editorRef.current?.getModel();
      if (model) monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    },
    [],
  );

  const reveal = (d: Diagnostic) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(d.startLine);
    editor.setPosition({ lineNumber: d.startLine, column: d.startColumn });
    editor.focus();
  };

  return (
    <div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
        <Editor
          height={height}
          language={language}
          value={value}
          theme={dark ? 'vs-dark' : 'vs'}
          onMount={(editor) => {
            editorRef.current = editor;
            setDiagnostics(lintStepBody(value, language));
          }}
          onChange={(next) => onChange(next ?? '')}
          options={{
            readOnly,
            // Without this, a read-only editor still shows a text cursor and
            // invites typing that silently does nothing.
            domReadOnly: readOnly,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            lineNumbersMinChars: 3,
            overviewRulerLanes: 0,
            automaticLayout: true,
            scrollbar: { alwaysConsumeMouseWheel: false },
          }}
        />
      </div>
      <DiagnosticSummary diagnostics={diagnostics} onReveal={reveal} />
    </div>
  );
}

/**
 * What the squiggles say, without having to find them.
 *
 * A step body is often taller than the box, so a warning six screens down is a
 * warning nobody sees. This lists the findings in order and scrolls to one when
 * it is clicked.
 */
function DiagnosticSummary({
  diagnostics,
  onReveal,
}: {
  diagnostics: Diagnostic[];
  onReveal: (d: Diagnostic) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const summary = summariseDiagnostics(diagnostics);
  if (!summary) return null;

  const worst = diagnostics.some((d) => d.severity === 'error')
    ? 'error'
    : diagnostics.some((d) => d.severity === 'warning')
      ? 'warning'
      : 'info';

  return (
    <div className={`lint-bar lint-${worst}`}>
      <button
        type="button"
        className="lint-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? '▾' : '▸'} {summary}
      </button>
      {expanded ? (
        <ul className="lint-list">
          {diagnostics.map((d, i) => (
            <li key={`${d.code}:${d.startLine}:${d.startColumn}:${i}`}>
              <button type="button" className={`lint-item lint-${d.severity}`} onClick={() => onReveal(d)}>
                <span className="lint-line">Line {d.startLine}</span>
                <span className="lint-message">{d.message}</span>
                <span className="lint-code">{d.code}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
