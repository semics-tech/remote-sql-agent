/**
 * Regenerate protobuf types from `proto/` into `src/gen/`.
 *
 * The .proto files are the single source of truth. Generated output is checked
 * in so that neither the worker build nor a contributor's first `pnpm install`
 * needs a working protoc toolchain — but CI runs this with `--check` and fails
 * if the checked-in output has drifted from the .proto files (§10).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const repoRoot = join(pkgRoot, '..', '..');
const genDir = join(pkgRoot, 'src', 'gen');
const bufBin = join(repoRoot, 'node_modules', '.bin', 'buf');

const check = process.argv.includes('--check');

function listFilesRecursive(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(relative(base, full));
  }
  return out.sort();
}

function generateInto(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  execFileSync(
    bufBin,
    ['generate', '--template', join(pkgRoot, 'buf.gen.yaml'), '--output', outDir],
    { cwd: pkgRoot, stdio: 'inherit' },
  );
}

if (check) {
  const tmp = mkdtempSync(join(tmpdir(), 'rsagent-proto-'));
  try {
    generateInto(tmp);
    // buf writes relative to --output using the plugin's `out` path.
    const freshRoot = join(tmp, 'src', 'gen');
    const fresh = listFilesRecursive(freshRoot);
    const current = listFilesRecursive(genDir);

    const missing = fresh.filter((f) => !current.includes(f));
    const extra = current.filter((f) => !fresh.includes(f));
    const changed = fresh.filter(
      (f) =>
        current.includes(f) &&
        readFileSync(join(freshRoot, f), 'utf8') !== readFileSync(join(genDir, f), 'utf8'),
    );

    if (missing.length || extra.length || changed.length) {
      console.error('Generated protobuf output is stale. Run `pnpm proto:gen` and commit.');
      for (const f of missing) console.error(`  missing:  ${f}`);
      for (const f of extra) console.error(`  orphaned: ${f}`);
      for (const f of changed) console.error(`  changed:  ${f}`);
      process.exit(1);
    }
    console.log(`Generated protobuf output is up to date (${current.length} files).`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  rmSync(genDir, { recursive: true, force: true });
  const tmp = mkdtempSync(join(tmpdir(), 'rsagent-proto-'));
  try {
    generateInto(tmp);
    cpSync(join(tmp, 'src', 'gen'), genDir, { recursive: true });
    console.log(`Wrote ${listFilesRecursive(genDir).length} generated files to src/gen.`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
