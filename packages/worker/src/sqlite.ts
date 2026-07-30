import { nodeRequire } from './node-require.js';

/**
 * The SQLite binding the outbox runs on.
 *
 * `node:sqlite` rather than better-sqlite3, because it is built into the
 * runtime. That is what lets the worker ship as a single executable and lets
 * `npm i -g` finish without a C++ toolchain — a real constraint on a Windows
 * database server, where the alternative is asking a DBA to install Visual
 * Studio build tools before they can monitor a job.
 *
 * The trade is that `node:sqlite` is still marked experimental, so it can
 * change across a Node major. The worker pins its runtime (see the SEA build
 * and the version fetched by the release workflow), so a change lands when we
 * take the new Node, not when a customer's host updates underneath us. The
 * surface used is small and confined to outbox.ts.
 *
 * Loaded through require() rather than a static import so the warning filter
 * below is installed first. This is not stylistic: the warning is emitted when
 * the builtin is *loaded*, not when a database is opened, and ESM imports are
 * hoisted — a static import runs before any statement in this file however the
 * source is ordered, and esbuild is free to move it again when it bundles. A
 * require() call happens where it is written.
 */

// Suppress only this one warning, and only for SQLite. The worker writes to a
// service log that people read during an incident; a line on every start that
// nobody can act on trains them to skim. Every other warning — deprecations
// especially — still comes through untouched.
const inherited = process.listeners('warning');
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/iu.test(warning.message)) return;
  for (const listener of inherited) listener(warning);
});

// A type-only import, which both TypeScript and esbuild erase entirely — it
// produces no runtime import and so cannot load the builtin ahead of the
// filter above. The require() below is what actually loads it.
import type { DatabaseSync as DatabaseSyncClass } from 'node:sqlite';

export const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: typeof DatabaseSyncClass;
};
export type Database = DatabaseSyncClass;
