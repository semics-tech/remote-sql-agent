/**
 * Build a single-file worker executable for the host platform.
 *
 * Produces dist/rsagent-worker-<platform>-<arch>[.exe]: the Node runtime with
 * the bundled worker injected into it. No Node on the target, no node_modules,
 * no install step — which is the point. A DBA copies one file onto a database
 * server and runs it.
 *
 * Deliberately builds only for the platform it is running on. Cross-injecting
 * into a downloaded runtime does work, but the macOS result then has to be
 * re-signed with tooling that only exists on macOS, and an unsigned binary on
 * a database server is exactly the thing a security team should reject. The
 * release workflow runs this on a matrix of runners instead, so each binary is
 * produced by the OS it targets.
 *
 * The runtime that gets embedded is whatever Node is running this script, so
 * CI must be on the pinned version — that is what makes the executable and the
 * `node rsagent-worker.mjs` path the same runtime.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const workerRoot = join(here, '..');
const dist = join(workerRoot, 'dist');
const build = join(dist, 'sea');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const target = `${process.platform}-${process.arch}`;
const outputName = `rsagent-worker-${target}${isWindows ? '.exe' : ''}`;
const output = join(dist, outputName);

function run(command: string, args: string[], cwd = workerRoot): void {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/**
 * Run a package manager binary.
 *
 * On Windows these are `.cmd` shims, which execFileSync cannot launch
 * directly — it needs a real executable. This runs on a windows-latest runner
 * in the release matrix, so the naive form fails there and only there.
 */
function runTool(tool: string, args: string[]): void {
  run(isWindows ? `${tool}.cmd` : tool, args);
}

rmSync(build, { recursive: true, force: true });
mkdirSync(build, { recursive: true });

// SEA takes a CommonJS entry point only, so this is a second bundle rather
// than the .mjs that npm and the tarball ship.
//
// It differs in one way: nothing is marked external. A single executable has
// no node_modules to fall back on, so an external require reaches the builtin
// loader and dies with "No such built-in module: @azure/identity" — which is
// what happens here, because mssql requires it eagerly whether or not anyone
// uses Entra. Inlining it costs about 1 MB against a ~110 MB runtime.
console.log('Bundling worker (CommonJS, for SEA)...');
runTool('pnpm', ['run', 'bundle:cjs']);

const seaConfig = join(build, 'sea-config.json');
writeFileSync(
  seaConfig,
  `${JSON.stringify(
    {
      main: join(dist, 'rsagent-worker.cjs'),
      output: join(build, 'sea.blob'),
      // The worker is a long-running service started once and left alone, so
      // the startup saving from a code cache is worth nothing here, while a
      // V8-version mismatch between build and run is a real way to ship a
      // binary that will not start. Left off deliberately.
      useCodeCache: false,
      // Suppressed because it is aimed at people building SEAs, not at a DBA
      // who has been handed one. The genuinely load-bearing experimental
      // dependency is node:sqlite, and that trade is documented in src/sqlite.ts.
      disableExperimentalSEAWarning: true,
    },
    null,
    2,
  )}\n`,
);

console.log('Preparing the SEA blob...');
run(process.execPath, ['--experimental-sea-config', seaConfig]);

console.log(`Copying the Node ${process.version} runtime...`);
copyFileSync(process.execPath, output);
chmodSync(output, 0o755);

// A signed binary cannot be modified without invalidating the signature, so
// the existing one comes off before injection and a fresh ad-hoc signature
// goes on after. Skipping either step produces a file macOS refuses to run
// with "killed: 9", which looks nothing like a signing problem.
if (isMac) {
  try {
    run('codesign', ['--remove-signature', output]);
  } catch {
    console.warn('No existing signature to remove; continuing.');
  }
}

console.log('Injecting the worker into the runtime...');
const require = createRequire(import.meta.url);
const postject = require.resolve('postject/dist/cli.js');
run(process.execPath, [
  postject,
  output,
  'NODE_SEA_BLOB',
  join(build, 'sea.blob'),
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(isMac ? ['--macho-segment-name', 'NODE_SEA'] : []),
]);

if (isMac) {
  // Ad-hoc (`-`) rather than a real identity: this makes the binary runnable,
  // it does not make it trusted. Distribution signing and notarisation are a
  // separate, credential-bearing step and are not done here.
  run('codesign', ['--sign', '-', output]);
}

const sizeMb = (statSync(output).size / 1024 / 1024).toFixed(1);
console.log(`\n${outputName}  (${sizeMb} MB)`);

// Proving it starts is the only check that catches a bad injection: a
// mis-injected binary is still a perfectly good copy of node, and would
// happily sit in a release looking correct.
console.log('Verifying the executable runs...');
const banner = execFileSync(output, ['--rsagent-selftest'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
console.log(banner.trim());
