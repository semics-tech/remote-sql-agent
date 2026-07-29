/**
 * Apply deploy/sql-seed/seed.sql to the dev SQL Server container.
 *
 * Runs sqlcmd *inside* the container so the host needs no SQL Server tooling —
 * which matters on macOS/ARM where mssql-tools are awkward to install.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const seedFile = join(repoRoot, 'deploy', 'sql-seed', 'seed.sql');
const container = process.env.RSAGENT_SQL_CONTAINER ?? 'rsagent-dev-sqlserver-1';
const password = process.env.RSAGENT_SQL_SA_PASSWORD ?? 'RsAgent_Dev_Pass123';

function containerExists(): boolean {
  const r = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', container], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() === 'true';
}

if (!containerExists()) {
  console.error(
    `SQL Server container "${container}" is not running.\n` +
      `Start it with: pnpm dev:up   (override the name with RSAGENT_SQL_CONTAINER)`,
  );
  process.exit(1);
}

console.log(`Copying seed script into ${container}...`);
execFileSync('docker', ['cp', seedFile, `${container}:/tmp/seed.sql`], { stdio: 'inherit' });

console.log('Applying seed...');
execFileSync(
  'docker',
  [
    'exec',
    container,
    '/opt/mssql-tools18/bin/sqlcmd',
    '-S',
    'localhost',
    '-U',
    'sa',
    '-P',
    password,
    '-C', // trust the container's self-signed certificate
    '-b', // abort on error, so a failed seed fails this script
    '-i',
    '/tmp/seed.sql',
  ],
  { stdio: 'inherit' },
);

console.log('\nSeed applied.');
