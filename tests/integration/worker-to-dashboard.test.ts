import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { pino } from 'pino';
import sql from 'mssql';
import { createDatabase, type Database } from '@rsagent/server/src/db/client.js';
import { runMigrations } from '@rsagent/server/src/db/migrate.js';
import { createGrpcServer } from '@rsagent/server/src/hub/hub.js';
import { WorkerRegistry } from '@rsagent/server/src/hub/registry.js';
import { loadConfig } from '@rsagent/server/src/config.js';
import { getEstateOverview, listJobs, getJobHistory, searchJobs } from '@rsagent/server/src/domain/queries.js';
import { getJobVersions } from '@rsagent/server/src/domain/versioning.js';
import { generateCommandSigningKeyPair } from '@rsagent/protocol';
import { InstanceMonitor } from '@rsagent/worker/src/instance-monitor.js';
import { Outbox } from '@rsagent/worker/src/outbox.js';
import { ControlPlaneSession } from '@rsagent/worker/src/session.js';
import { workerConfigSchema, type InstanceConfig } from '@rsagent/worker/src/config.js';
import type { WorkerMessage } from '@rsagent/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * The M1/M2 acceptance criteria, end to end against a real SQL Server:
 * worker reads msdb -> gRPC hub -> Postgres -> the queries backing the
 * dashboard. Nothing is mocked; the only thing missing versus production is
 * mTLS (M3).
 *
 * Requires the dev stack: `pnpm dev:up && pnpm dev:seed`.
 */

const SQL_HOST = process.env.RSAGENT_TEST_SQL_HOST ?? 'localhost';
const SQL_PORT = Number(process.env.RSAGENT_TEST_SQL_PORT ?? 14330);
const SQL_PASSWORD = process.env.RSAGENT_TEST_SQL_PASSWORD ?? 'RsAgent_Dev_Pass123';
const ADMIN_URL =
  process.env.RSAGENT_TEST_ADMIN_URL ??
  'postgres://rsagent:rsagent_dev_password@localhost:5433/rsagent';
const TEST_DB = 'rsagent_integration';
const HOST_NAME = 'INTEGRATION-HOST';
const INSTANCE_NAME = 'MSSQLSERVER';

let db: Database;
let closeDb: () => Promise<void>;
let grpcServer: grpc.Server;
let grpcPort: number;
let monitor: InstanceMonitor;
let session: ControlPlaneSession;
let outbox: Outbox;
let outboxDir: string;
let pool: sql.ConnectionPool;

const logger = pino({ level: process.env.RSAGENT_TEST_LOG_LEVEL ?? 'silent' });

const instanceConfig: InstanceConfig = {
  name: INSTANCE_NAME,
  server: SQL_HOST,
  port: SQL_PORT,
  database: 'msdb',
  user: 'sa',
  password: SQL_PASSWORD,
  encrypt: true,
  trustServerCertificate: true,
  connectionTimeoutMs: 30_000,
  requestTimeoutMs: 60_000,
};

function testDbUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB}`;
  return url.toString();
}

/** Wait for a predicate, polling. The pipeline is asynchronous end to end. */
async function eventually<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  { timeoutMs = 60_000, intervalMs = 500 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await fn();
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs}ms. Last value: ${JSON.stringify(last)}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

beforeAll(async () => {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${TEST_DB}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }

  await runMigrations(testDbUrl());
  ({ db, close: closeDb } = createDatabase(testDbUrl(), { max: 6 }));

  const registry = new WorkerRegistry();
  const signingKey = generateCommandSigningKeyPair();
  grpcServer = createGrpcServer({
    db,
    config: loadConfig({ ...process.env, RSAGENT_DATABASE_URL: testDbUrl() }),
    logger,
    registry,
    commandSigningPublicKey: signingKey.publicKeyPem,
  });

  grpcPort = await new Promise<number>((resolve, reject) => {
    grpcServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) =>
      err ? reject(err) : resolve(port),
    );
  });

  outboxDir = mkdtempSync(join(tmpdir(), 'rsagent-integration-'));
  outbox = new Outbox(join(outboxDir, 'outbox.sqlite'), 10_000);

  const workerConfig = workerConfigSchema.parse({
    hostName: HOST_NAME,
    controlPlane: { address: `127.0.0.1:${grpcPort}`, tls: { enabled: false } },
    maxCapability: 'readOnly',
    instances: [instanceConfig],
    outbox: { path: join(outboxDir, 'outbox.sqlite'), maxRows: 10_000 },
    polling: {
      definitionSeconds: 2,
      historySeconds: 2,
      activitySeconds: 2,
      agentLogSeconds: 3600,
      heartbeatSeconds: 5,
      historyBatchSize: 500,
    },
  });

  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => (ready = resolve));

  const emit = (message: WorkerMessage): boolean => session.send(message);

  monitor = new InstanceMonitor({ config: instanceConfig, outbox, logger, emit });
  await monitor.connect();
  pool = await new sql.ConnectionPool({
    server: SQL_HOST,
    port: SQL_PORT,
    database: 'msdb',
    user: 'sa',
    password: SQL_PASSWORD,
    options: { encrypt: true, trustServerCertificate: true, useUTC: true },
  }).connect();

  session = new ControlPlaneSession(
    workerConfig,
    logger,
    {
      onReady: () => {
        void (async () => {
          await monitor.sendSnapshot();
          monitor.startPolling({
            definitionSeconds: 2,
            historySeconds: 2,
            activitySeconds: 2,
            agentLogSeconds: 3600,
            historyBatchSize: 500,
          });
          ready();
        })();
      },
      onCommand: () => undefined,
      onDisconnect: () => undefined,
    },
    () => ({
      msg: {
        $case: 'hello',
        hello: {
          workerVersion: '0.1.0-test',
          hostName: HOST_NAME,
          maxCapability: 'readOnly',
          instances: [
            {
              instanceName: INSTANCE_NAME,
              sqlVersion: monitor.identity?.sqlVersion ?? '',
              sqlEdition: monitor.identity?.sqlEdition ?? '',
              agentStatus: monitor.identity?.agentStatus ?? 'unknown',
              serverName: monitor.identity?.serverName ?? '',
            },
          ],
        },
      },
    }),
  );

  session.start();
  await readyPromise;
}, 300_000);

afterAll(async () => {
  monitor?.stopPolling();
  session?.stop();
  await monitor?.close();
  await pool?.close();
  outbox?.close();
  if (outboxDir) rmSync(outboxDir, { recursive: true, force: true });
  await new Promise<void>((resolve) => grpcServer?.tryShutdown(() => resolve()));
  await closeDb?.();
});

describe('worker registers and mirrors the instance', () => {
  it('appears in the estate overview with its jobs', async () => {
    const estate = await eventually(
      () => getEstateOverview(db),
      (rows) => rows.length === 1 && rows[0]!.jobCount > 0,
    );

    expect(estate[0]).toMatchObject({
      hostName: HOST_NAME,
      instanceName: INSTANCE_NAME,
      workerConnected: true,
      agentStatus: 'running',
    });
    // The seed creates 10 fixture jobs.
    expect(estate[0]!.jobCount).toBeGreaterThanOrEqual(10);
  });

  it('mirrors job definitions faithfully, including step bodies and flow control', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const nightly = jobs.find((j) => j.name === 'RSAgent Fixture - Nightly Maintenance');
    expect(nightly).toBeDefined();

    const versions = await getJobVersions(db, instance!.instanceId, nightly!.jobUuid);
    const definition = versions[0]!.definition as {
      steps: Array<{ stepId: number; name: string; onFailAction: number; onFailStepId: number; command: string }>;
    };

    expect(definition.steps).toHaveLength(4);
    // Branching must survive the round trip: steps 1-3 jump to the handler on
    // failure. Losing this would silently change what the job does.
    expect(definition.steps[0]).toMatchObject({ onFailAction: 4, onFailStepId: 4 });
    expect(definition.steps[0]!.command).toContain('DBCC CHECKDB');
  });

  it('records the first observation as "initial" rather than drift', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const versions = await getJobVersions(db, instance!.instanceId, jobs[0]!.jobUuid);
    expect(versions.at(-1)!.origin).toBe('initial');
    expect(jobs.every((j) => !j.isDrifted)).toBe(true);
  });
});

describe('run history', () => {
  it('captures a run with step-level detail after the job completes', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const heartbeat = jobs.find((j) => j.name === 'RSAgent Fixture - Heartbeat Log')!;

    const before = await getJobHistory(db, instance!.instanceId, heartbeat.jobUuid);

    await pool
      .request()
      .input('jobName', sql.NVarChar, 'RSAgent Fixture - Heartbeat Log')
      .query('EXEC msdb.dbo.sp_start_job @job_name = @jobName');

    const after = await eventually(
      () => getJobHistory(db, instance!.instanceId, heartbeat.jobUuid),
      (runs) => runs.length > before.length,
      { timeoutMs: 90_000 },
    );

    const latest = after[0]!;
    expect(latest.runStatus).toBe(1); // Succeeded
    // Step rows nested under their run is the SSMS "View History" shape.
    expect(latest.steps.length).toBeGreaterThan(0);
    expect(latest.steps[0]!.stepName).toBe('Write heartbeat');
    expect(latest.steps[0]!.message).toContain('Logged');
  }, 120_000);

  it('surfaces a failed run with its severity', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const failing = jobs.find((j) => j.name === 'RSAgent Fixture - Known Failure')!;

    const runs = await eventually(
      () => getJobHistory(db, instance!.instanceId, failing.jobUuid),
      (r) => r.length > 0,
    );
    expect(runs[0]!.runStatus).toBe(0); // Failed
    expect(runs[0]!.steps.some((s) => s.sqlSeverity === 16)).toBe(true);
  });
});

describe('drift detection', () => {
  it('records an SSMS-equivalent edit as a local-origin version and flags the job', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const target = jobs.find((j) => j.name === 'RSAgent Fixture - Idle Cleanup')!;
    const versionsBefore = await getJobVersions(db, instance!.instanceId, target.jobUuid);

    // The edit must differ from whatever is already on the instance. SQL Server
    // is shared state that survives between runs, so a fixed command would be a
    // no-op on the second run and the test would (correctly) see no new version.
    const marker = `-- drift test ${Date.now()}-${process.pid}`;

    // Exactly what SSMS does under the covers when a DBA edits a step.
    await pool
      .request()
      .input('jobName', sql.NVarChar, 'RSAgent Fixture - Idle Cleanup')
      .input('command', sql.NVarChar, `SELECT 1;\n${marker}`)
      .query(
        'EXEC msdb.dbo.sp_update_jobstep @job_name = @jobName, @step_id = 1, @command = @command',
      );

    const versionsAfter = await eventually(
      () => getJobVersions(db, instance!.instanceId, target.jobUuid),
      (v) => v.length > versionsBefore.length,
      { timeoutMs: 60_000 },
    );

    expect(versionsAfter[0]!.origin).toBe('local');
    expect(versionsAfter[0]!.versionNo).toBe(versionsBefore[0]!.versionNo + 1);
    const drifted = versionsAfter[0]!.definition as { steps: Array<{ command: string }> };
    expect(drifted.steps[0]!.command).toContain(marker);

    const jobsAfter = await listJobs(db, instance!.instanceId);
    expect(jobsAfter.find((j) => j.jobUuid === target.jobUuid)!.isDrifted).toBe(true);
  }, 120_000);

  it('does not invent drift when nothing has changed', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const stable = jobs.find((j) => j.name === 'RSAgent Fixture - Startup Warmup')!;

    const before = await getJobVersions(db, instance!.instanceId, stable.jobUuid);
    // Two definition polls plus a re-snapshot would each create a version if
    // canonical hashing were unstable.
    await monitor.sendSnapshot();
    await monitor.pollDefinitions();
    await new Promise((r) => setTimeout(r, 3000));

    const after = await getJobVersions(db, instance!.instanceId, stable.jobUuid);
    expect(after).toHaveLength(before.length);
  }, 60_000);
});

describe('cross-estate search', () => {
  it('finds a job by text inside a step body', async () => {
    const hits = await eventually(
      () => searchJobs(db, 'LEGACYFIN01'),
      (h) => h.length > 0,
    );
    expect(hits[0]!.jobName).toBe('RSAgent Fixture - Legacy Feed Import');
    expect(hits[0]!.matchingSteps.length).toBeGreaterThan(0);
    expect(hits[0]!.nameMatched).toBe(false);
  });

  it('finds a job by name', async () => {
    const hits = await searchJobs(db, 'Quarterly');
    expect(hits.some((h) => h.nameMatched)).toBe(true);
  });

  it('escapes LIKE wildcards rather than matching everything', async () => {
    expect(await searchJobs(db, '%')).toHaveLength(0);
  });
});
