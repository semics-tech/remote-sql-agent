/**
 * Assemble the worker distribution zip.
 *
 * Produces a directory that install.ps1 can consume directly:
 *
 *   rsagent-worker.mjs   the bundled worker
 *   rsagent-worker.xml   WinSW service definition
 *   install.ps1          installer
 *   node/                pinned Node runtime (fetched separately, see below)
 *
 * There is no node_modules directory any more. The outbox moved to the
 * runtime's own node:sqlite, so the bundle has no native module to sit beside
 * it — see src/sqlite.ts. @azure/identity is still left external, but it is
 * optional and only Entra worker auth reaches it.
 *
 * The Node runtime is not vendored into the repository. Point NODE_DIST at an
 * extracted Windows Node distribution, or run with --no-runtime to build a
 * package for a host that already has Node 24.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = join(here, '..');
const repoRoot = join(workerRoot, '..', '..');
const out = join(workerRoot, 'dist', 'package');

const includeRuntime = !process.argv.includes('--no-runtime');
const nodeDist = process.env.NODE_DIST;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log('Bundling worker...');
// `shell: true` on Windows: pnpm is a `.cmd` shim there, and since the fix for
// CVE-2024-27980 Node refuses to spawn one without a shell, failing with a
// bare EINVAL. Nothing on this line comes from outside this file.
execFileSync('pnpm', ['run', 'bundle'], {
  cwd: workerRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

cpSync(join(workerRoot, 'dist', 'rsagent-worker.mjs'), join(out, 'rsagent-worker.mjs'));
cpSync(join(repoRoot, 'deploy', 'worker', 'rsagent-worker.xml'), join(out, 'rsagent-worker.xml'));
cpSync(join(repoRoot, 'deploy', 'worker', 'install.ps1'), join(out, 'install.ps1'));
cpSync(join(repoRoot, 'deploy', 'worker', 'rsagent-worker.service'), join(out, 'rsagent-worker.service'));

if (includeRuntime) {
  if (!nodeDist) {
    console.warn(
      '\nNODE_DIST is not set, so no Node runtime was bundled.\n' +
        'Download the Windows x64 zip from https://nodejs.org/dist/ , extract it, and set\n' +
        '  NODE_DIST=/path/to/node-v24.x.x-win-x64\n' +
        'Or pass --no-runtime to build for hosts that already have Node 24.\n',
    );
  } else {
    console.log(`Copying Node runtime from ${nodeDist}...`);
    mkdirSync(join(out, 'node'), { recursive: true });
    for (const file of ['node.exe', 'LICENSE']) {
      const from = join(nodeDist, file);
      if (existsSync(from)) cpSync(from, join(out, 'node', file));
    }
  }
}

console.log(`\nWorker package assembled at ${out}`);
console.log('Add WinSW as rsagent-worker.exe before shipping: https://github.com/winsw/winsw/releases');
