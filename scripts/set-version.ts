/**
 * Set every package in the workspace to one version.
 *
 *   pnpm release:version 0.2.0
 *   pnpm release:version 0.2.0-rc.1
 *
 * Lockstep on purpose. The worker, the control plane and the protocol are one
 * system that speaks one wire format to itself; a worker at 0.3 talking to a
 * control plane at 0.2 is a support conversation nobody wants to have, and the
 * release workflow already refuses to publish unless the tag matches. Keeping
 * the private packages in step costs nothing and means `docker image` and
 * `npm ls` report the same number as the tag.
 *
 * This writes files and stops. It does not commit, tag or push — cutting a
 * release stays a deliberate act, and the diff is worth reading first.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Same shape npm enforces, minus the build-metadata suffix: `+build` is legal
// semver but Docker tags cannot contain `+`, and a version that cannot be a
// tag is not usable here.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/u;

const version = process.argv[2];
if (!version) {
  console.error('Usage: pnpm release:version <version>   e.g. 0.2.0, 0.2.0-rc.1');
  process.exit(2);
}
if (!SEMVER.test(version)) {
  console.error(
    `"${version}" is not a version this project can release.\n` +
      'Expected MAJOR.MINOR.PATCH with an optional prerelease, and no build metadata:\n' +
      '  0.2.0    0.2.0-rc.1    1.0.0-beta.3',
  );
  process.exit(2);
}

function manifestPaths(): string[] {
  const found = [join(repoRoot, 'package.json')];
  for (const group of ['packages', 'tests']) {
    const base = join(repoRoot, group);
    for (const entry of readdirSync(base)) {
      const manifest = join(base, entry, 'package.json');
      try {
        if (statSync(manifest).isFile()) found.push(manifest);
      } catch {
        // Not a package directory.
      }
    }
  }
  return found;
}

let changed = 0;
for (const path of manifestPaths()) {
  const source = readFileSync(path, 'utf8');

  // Rewritten with a targeted replace rather than JSON.parse/stringify so key
  // order, indentation and the "//" comment keys survive untouched. A version
  // bump that reformats four manifests buries itself in its own diff.
  const updated = source.replace(
    /^(\s*"version":\s*")[^"]*(",?\s*)$/mu,
    (_match, before: string, after: string) => `${before}${version}${after}`,
  );

  if (updated === source) {
    console.warn(`  no version field: ${path.slice(repoRoot.length + 1)}`);
    continue;
  }
  writeFileSync(path, updated);
  console.log(`  ${path.slice(repoRoot.length + 1)}`);
  changed++;
}

// The worker reports this to the control plane on every heartbeat, and it is
// what the dashboard shows next to a host. Left behind, it silently reports
// the previous release forever. Lives in its own file (version.ts) rather
// than index.ts, because the shipped bundle carries no package.json to read
// a version from at runtime — but check index.ts too, so this keeps working
// against a checkout from before that split.
const workerVersionCandidates = [
  join(repoRoot, 'packages', 'worker', 'src', 'version.ts'),
  join(repoRoot, 'packages', 'worker', 'src', 'index.ts'),
];
let patchedWorkerVersion = false;
for (const path of workerVersionCandidates) {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  const updated = source.replace(
    /^(export const WORKER_VERSION = '|const WORKER_VERSION = ')[^']*(';)$/mu,
    (_match, before: string, after: string) => `${before}${version}${after}`,
  );
  if (updated === source) continue;
  writeFileSync(path, updated);
  console.log(`  ${path.slice(repoRoot.length + 1)} (WORKER_VERSION)`);
  patchedWorkerVersion = true;
  break;
}
if (!patchedWorkerVersion) {
  console.error(
    '\nCould not find WORKER_VERSION in packages/worker/src/version.ts or index.ts.\n' +
      'It is reported on every heartbeat, so it must not be left stale — update it by hand.',
  );
  process.exit(1);
}

// Deploy examples an operator copies verbatim. Stale here means every fresh
// install pins a release behind the one that was just cut.
const deployTargets: Array<{ path: string; pattern: RegExp }> = [
  { path: join(repoRoot, 'deploy', '.env.example'), pattern: /^(RSAGENT_VERSION=)[^\n]*$/mu },
  {
    path: join(repoRoot, 'deploy', 'k8s', 'control-plane.yaml'),
    pattern: /^(\s*image: ghcr\.io\/semics-tech\/remote-sql-agent\/control-plane:)[^\s]+$/mu,
  },
  { path: join(repoRoot, 'deploy', 'cloud-init.yaml'), pattern: /^(\s*RSAGENT_VERSION=")[^"]*(")$/mu },
  { path: join(repoRoot, 'docs', 'deployment.md'), pattern: /^(RSAGENT_VERSION=)\d[^\s#]*/mu },
];
for (const { path, pattern } of deployTargets) {
  const source = readFileSync(path, 'utf8');
  const updated = source.replace(pattern, (...args: unknown[]) => {
    // Regexes above have either one or two capture groups (a trailing quote
    // for cloud-init's `"..."` form); args is [match, ...groups, offset, string].
    const groups = args.slice(1, -2) as string[];
    return groups.length > 1 ? `${groups[0]}${version}${groups[1]}` : `${groups[0]}${version}`;
  });
  if (updated === source) {
    console.warn(`  no RSAGENT_VERSION pin found: ${path.slice(repoRoot.length + 1)}`);
    continue;
  }
  writeFileSync(path, updated);
  console.log(`  ${path.slice(repoRoot.length + 1)}`);
}

console.log(`\nSet ${changed} manifests to ${version}.`);
console.log('\nNext:');
console.log('  1. Move CHANGELOG.md [Unreleased] entries under a new heading for this version');
console.log('  2. Read the diff, then commit');
console.log(`  3. git tag v${version} && git push origin v${version}`);
if (version.includes('-')) {
  console.log('\nThis is a prerelease: npm gets dist-tag "next" and Docker "latest" does not move.');
}
