import { Editor, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor/editor/editor.api';
import 'monaco-editor/languages/definitions/sql/register';
import 'monaco-editor/languages/definitions/powershell/register';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';

/**
 * Editable step body. Shares Monaco with the diff viewer, and like it is
 * bundled locally rather than fetched from a CDN — the target networks have no
 * general egress.
 */
loader.config({ monaco });
self.MonacoEnvironment = { getWorker: () => new editorWorker() };

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

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
      <Editor
        height={height}
        language={language}
        value={value}
        theme={dark ? 'vs-dark' : 'vs'}
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
  );
}
