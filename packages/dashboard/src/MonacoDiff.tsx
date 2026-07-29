import { DiffEditor, loader } from '@monaco-editor/react';
// The editor core only. Importing 'monaco-editor' would drag in the TypeScript,
// CSS, HTML and JSON language services — megabytes of machinery for languages
// that cannot appear in a SQL Agent job step.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution';
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

/**
 * Text diff for step bodies. Lazily loaded — Monaco is by far the largest
 * dependency in the dashboard and only the Versions tab needs it.
 *
 * Monaco is bundled locally rather than pulled from jsDelivr, which is what
 * @monaco-editor/react does by default. This product is deployed inside
 * firewalled corporate networks with no general egress (that constraint is the
 * whole reason the worker dials out), so a CDN dependency would simply fail to
 * load for the target customer.
 */
loader.config({ monaco });

// Only the base editor worker is wired up: the SQL contribution is
// tokenisation-only, so no language service worker is needed for a read-only
// diff, and pulling in the rest would triple the bundle for no behaviour.
self.MonacoEnvironment = {
  getWorker: () => new editorWorker(),
};

export default function MonacoDiff({
  original,
  modified,
  language,
}: {
  original: string;
  modified: string;
  language: string;
}) {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  // Height is derived from content: a two-line change should not open a
  // 500px editor, and a long procedure should not be crammed into one.
  const lines = Math.max(original.split('\n').length, modified.split('\n').length);
  const height = Math.min(Math.max(lines * 19 + 22, 90), 460);

  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <DiffEditor
        height={height}
        language={language}
        original={original}
        modified={modified}
        theme={dark ? 'vs-dark' : 'vs'}
        options={{
          readOnly: true,
          renderSideBySide: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 12,
          lineNumbersMinChars: 3,
          renderOverviewRuler: false,
          scrollbar: { alwaysConsumeMouseWheel: false },
        }}
      />
    </div>
  );
}
