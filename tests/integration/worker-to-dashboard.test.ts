import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { pino } from 'pino';
import sql from 'mssql';
import { createDatabase, type Database } from '@rsagent/server/src/db/client.js';
import { runMigrations } from '@rsagent/server/src/db/migrate.js';
import { createGrpcServer } from '@rsagent/server/src/hub/hub.js';
import { WorkerRegistry } from '@rsagent/server/src/hub/registry.js';
import { loadConfig } from '@rsagent/server/src/config.js';
import {
  getEstateOverview,
  listJobs,
  getJob,
  getJobHistory,
  searchJobs,
} from '@rsagent/server/src/domain/queries.js';
import { getJobVersions } from '@rsagent/server/src/domain/versioning.js';
import {
  CommandService,
  buildProtoCommand,
} from '@rsagent/server/src/domain/commands.js';
import { commands as commandsTable, users } from '@rsagent/server/src/db/schema.js';
import { eq } from 'drizzle-orm';
import {
  canonicaliseJobWithHash,
  generateCommandSigningKeyPair,
  signCommand,
  type CommandSigningKeyPair,
  type JobDefinition,
} from '@rsagent/protocol';
import { handleCommand } from '@rsagent/worker/src/command-handler.js';
import { WorkerAuthenticator } from '@rsagent/server/src/worker-auth/authenticate.js';
import {
  createEnrolmentToken,
  redeemEnrolmentToken,
} from '@rsagent/server/src/worker-auth/enrolment.js';
import { InstanceMonitor } from '@rsagent/worker/src/instance-monitor.js';
import { Outbox } from '@rsagent/worker/src/outbox.js';
import { ControlPlaneSession } from '@rsagent/worker/src/session.js';
import { writeWorkerKey } from '@rsagent/worker/src/credentials.js';
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
let commandService: CommandService;
let signingKeys: CommandSigningKeyPair;
/** A real user row, so command.issued_by satisfies its foreign key. */
let ISSUER_ID: string;

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
  signingKeys = generateCommandSigningKeyPair();
  const serverConfig = loadConfig({
    ...process.env,
    RSAGENT_DATABASE_URL: testDbUrl(),
    // The hub is bound to loopback with an ephemeral port for the test.
    RSAGENT_GRPC_REQUIRE_TLS: 'false',
    // Exercise the command path itself here; the two-person rule is covered by
    // unit tests and would need a second user for every case.
    RSAGENT_REQUIRE_APPROVAL_JOB_WRITE: 'false',
  });

  commandService = new CommandService(
    db,
    serverConfig,
    registry,
    signingKeys.privateKeyPem,
    logger,
  );

  const [issuer] = await db
    .insert(users)
    .values({
      username: 'integration-test',
      passwordHash: null,
      role: 'Admin',
      identityProvider: 'local',
    })
    .returning({ id: users.id });
  ISSUER_ID = issuer!.id;

  grpcServer = createGrpcServer({
    db,
    config: serverConfig,
    logger,
    registry,
    authenticator: new WorkerAuthenticator(db, serverConfig),
    commands: commandService,
    commandSigningPublicKey: signingKeys.publicKeyPem,
  });

  grpcPort = await new Promise<number>((resolve, reject) => {
    grpcServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, port) =>
      err ? reject(err) : resolve(port),
    );
  });

  outboxDir = mkdtempSync(join(tmpdir(), 'rsagent-integration-'));
  outbox = new Outbox(join(outboxDir, 'outbox.sqlite'), 10_000);

  // Enrol exactly as an installer would: mint a single-use token, exchange it
  // for an API key, then connect with that key. A worker with no credential is
  // rejected, so there is no way to skip this step in the test either.
  const enrolment = await createEnrolmentToken(db, {
    hostName: HOST_NAME,
    credentialMode: 'token',
    intendedCapabilities: ['job.toggle', 'job.run', 'schedule.write', 'job.write'],
    createdBy: null,
    ttlMinutes: 60,
  });
  const enrolResult = await redeemEnrolmentToken(db, serverConfig, {
    token: enrolment.token,
    hostName: HOST_NAME,
    workerVersion: '0.1.0-test',
  });
  const keyFile = join(outboxDir, 'worker.key');
  writeWorkerKey(keyFile, enrolResult.workerKey!);

  const workerConfig = workerConfigSchema.parse({
    hostName: HOST_NAME,
    controlPlane: {
      address: `127.0.0.1:${grpcPort}`,
      auth: { mode: 'token', keyFile },
      tls: { enabled: false },
    },
    // The write-path tests need a worker that is actually allowed to write; the
    // ceiling itself is asserted separately by pinning it back to observe-only.
    maxCapability: 'full',
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
      onCommand: (message) => {
        if (message.msg?.$case !== 'command') return;
        const command = message.msg.command;
        void (async () => {
          // Mirrors the real worker: application is held against definition
          // polling, and the change is attributed to the command that made it.
          const result = await monitor.runExclusive(async () => {
            const outcome = await handleCommand(command, {
              pool: monitor.connectionPool!,
              instanceName: command.instanceName,
              capabilities: session.capabilities,
              outbox,
              logger,
              commandSigningPublicKey: session.commandSigningPublicKey,
            });
            if (outcome.success && outcome.resultingJob) {
              monitor.noteAppliedCommand(outcome.resultingJob.jobUuid, command.id);
            }
            return outcome;
          });
          session.send({ msg: { $case: 'commandResult', commandResult: result } });
          await monitor.pollDefinitions().catch(() => undefined);
        })();
      },
      onDisconnect: () => undefined,
    },
    () => ({
      msg: {
        $case: 'hello',
        hello: {
          workerVersion: '0.1.0-test',
          hostName: HOST_NAME,
          maxCapability: 'full',
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

    // Produce a fresh failure rather than relying on one already being in
    // msdb: a new worker deliberately seeds its high-water mark near the
    // current maximum instead of replaying the instance's whole history, so
    // old rows are legitimately never shipped.
    //
    // Retries are dropped to zero first: the fixture's two one-minute retries
    // would otherwise make this a two-minute test for no extra coverage.
    await pool
      .request()
      .input('jobName', sql.NVarChar, 'RSAgent Fixture - Known Failure')
      .query(
        'EXEC msdb.dbo.sp_update_jobstep @job_name = @jobName, @step_id = 1, @retry_attempts = 0',
      );

    await pool
      .request()
      .input('jobName', sql.NVarChar, 'RSAgent Fixture - Known Failure')
      .query('EXEC msdb.dbo.sp_start_job @job_name = @jobName');

    // Wait for a *completed* run, not merely a new one: while a job is
    // executing it has step rows but no job-outcome row yet, and the History
    // view reports that as status 4 (In progress).
    const runs = await eventually(
      () => getJobHistory(db, instance!.instanceId, failing.jobUuid),
      (r) => r.some((run) => run.runStatus === 0),
      { timeoutMs: 90_000 },
    );

    expect(runs[0]!.runStatus).toBe(0); // Failed
    // Severity 16 is what RAISERROR(..., 16, 1) produces; capturing it is how a
    // DBA tells a genuine error from a cancelled run.
    expect(runs[0]!.steps.some((s) => s.sqlSeverity === 16)).toBe(true);
    expect(runs[0]!.message).toMatch(/failed/iu);
  }, 120_000);
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

// ---------------------------------------------------------------------------
// M4 — the write path
// ---------------------------------------------------------------------------

describe('write path', () => {
  /** Issue a command directly through the service and wait for its outcome. */
  async function issueAndSettle(
    kind: Parameters<CommandService['create']>[0]['kind'],
    jobUuid: string,
    payload: Record<string, unknown>,
    baseDefinitionHash?: string,
  ) {
    const [instance] = await getEstateOverview(db);
    const created = await commandService.create({
      instanceId: instance!.instanceId,
      kind,
      jobUuid,
      payload,
      baseDefinitionHash: baseDefinitionHash ?? null,
      issuedBy: ISSUER_ID,
      issuedByUsername: 'integration-test',
    });

    const settled = await eventually(
      async () => {
        const [row] = await db
          .select()
          .from(commandsTable)
          .where(eq(commandsTable.id, created.id));
        return row!;
      },
      (row) => row.state === 'succeeded' || row.state === 'failed' || row.state === 'expired',
      { timeoutMs: 60_000 },
    );
    return settled;
  }

  it('enables a disabled job and records it as a remote change, not drift', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const target = jobs.find((j) => j.name === 'RSAgent Fixture - Monthly Archive')!;

    const settled = await issueAndSettle('toggleJob', target.jobUuid, {
      jobUuid: target.jobUuid,
      enabled: !target.enabled,
      baseDefinitionHash: '',
    });
    expect(settled.state).toBe('succeeded');

    // msdb is the truth; assert against it rather than our own mirror.
    const live = await pool
      .request()
      .input('jobUuid', sql.UniqueIdentifier, target.jobUuid)
      .query<{ enabled: number }>('SELECT enabled FROM msdb.dbo.sysjobs WHERE job_id = @jobUuid');
    expect(live.recordset[0]!.enabled === 1).toBe(!target.enabled);

    const versions = await getJobVersions(db, instance!.instanceId, target.jobUuid);
    expect(versions[0]!.origin).toBe('remote');
    expect(versions[0]!.commandId).toBe(settled.id);

    const after = await listJobs(db, instance!.instanceId);
    // The operator's own change must never come back flagged as on-prem drift.
    expect(after.find((j) => j.jobUuid === target.jobUuid)!.isDrifted).toBe(false);
  }, 120_000);

  it('round-trips a full job definition byte for byte', async () => {
    // The most important assertion in the project: what the dashboard sends is
    // exactly what msdb holds afterwards, branching and schedules included.
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const target = jobs.find((j) => j.name === 'RSAgent Fixture - Nightly Maintenance')!;
    const detail = await getJob(db, instance!.instanceId, target.jobUuid);

    const edited = structuredClone(detail!.definition) as JobDefinition;
    edited.description = `Round-trip test ${process.pid}`;
    edited.steps[1]!.command = `EXEC dbo.usp_RebuildIndexes; -- round trip ${process.pid}`;
    edited.steps[1]!.retryAttempts = 3;

    const { canonicalJson, hash: sentHash } = canonicaliseJobWithHash(edited);

    const settled = await issueAndSettle(
      'upsertJob',
      target.jobUuid,
      {
        jobUuid: target.jobUuid,
        canonicalJson,
        baseDefinitionHash: detail!.currentDefinitionHash,
        allowOverwrite: false,
      },
      detail!.currentDefinitionHash ?? undefined,
    );
    expect(settled.state).toBe('succeeded');

    const reSnapshot = await eventually(
      () => getJob(db, instance!.instanceId, target.jobUuid),
      (job) => job?.currentDefinitionHash === sentHash,
      { timeoutMs: 60_000 },
    );

    // Identical canonical hash means every field survived the trip through
    // msdb's stored procedures unchanged.
    expect(reSnapshot!.currentDefinitionHash).toBe(sentHash);
    const got = reSnapshot!.definition as JobDefinition;
    expect(got.steps).toHaveLength(4);
    expect(got.steps[0]!.onFailStepId).toBe(4);
    expect(got.schedules).toHaveLength(1);
  }, 180_000);

  it('refuses an edit made against a stale version and leaves the job untouched', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const target = jobs.find((j) => j.name === 'RSAgent Fixture - Quarterly Reconciliation')!;
    const detail = await getJob(db, instance!.instanceId, target.jobUuid);

    const edited = structuredClone(detail!.definition) as JobDefinition;
    edited.description = 'Should never be applied.';
    const { canonicalJson } = canonicaliseJobWithHash(edited);

    const settled = await issueAndSettle(
      'upsertJob',
      target.jobUuid,
      {
        jobUuid: target.jobUuid,
        canonicalJson,
        baseDefinitionHash: '0'.repeat(64),
        allowOverwrite: false,
      },
      '0'.repeat(64),
    );

    expect(settled.state).toBe('failed');
    expect(settled.resultCode).toBe('Conflict');

    // Flag and ask, never last-write-wins: msdb must be unchanged.
    const live = await pool
      .request()
      .input('jobUuid', sql.UniqueIdentifier, target.jobUuid)
      .query<{ description: string }>(
        'SELECT description FROM msdb.dbo.sysjobs WHERE job_id = @jobUuid',
      );
    expect(live.recordset[0]!.description).not.toBe('Should never be applied.');
  }, 120_000);

  it('applies the same edit when the operator explicitly overwrites', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const target = jobs.find((j) => j.name === 'RSAgent Fixture - Quarterly Reconciliation')!;
    const detail = await getJob(db, instance!.instanceId, target.jobUuid);

    const edited = structuredClone(detail!.definition) as JobDefinition;
    edited.description = `Deliberate overwrite ${process.pid}`;
    const { canonicalJson } = canonicaliseJobWithHash(edited);

    const settled = await issueAndSettle('upsertJob', target.jobUuid, {
      jobUuid: target.jobUuid,
      canonicalJson,
      baseDefinitionHash: '0'.repeat(64),
      allowOverwrite: true,
    });

    expect(settled.state).toBe('succeeded');
  }, 120_000);

  it('ignores a redelivered command rather than applying it twice', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const target = jobs.find((j) => j.name === 'RSAgent Fixture - Startup Warmup')!;

    const created = await commandService.create({
      instanceId: instance!.instanceId,
      kind: 'toggleJob',
      jobUuid: target.jobUuid,
      payload: { jobUuid: target.jobUuid, enabled: false, baseDefinitionHash: '' },
      issuedBy: ISSUER_ID,
      issuedByUsername: 'integration-test',
    });

    await eventually(
      async () => {
        const [row] = await db.select().from(commandsTable).where(eq(commandsTable.id, created.id));
        return row!;
      },
      (row) => row.state === 'succeeded',
      { timeoutMs: 60_000 },
    );

    // Re-dispatch the identical command. The worker's idempotency record should
    // make it a no-op rather than a second application.
    await db
      .update(commandsTable)
      .set({ state: 'approved', expiresAt: new Date(Date.now() + 600_000) })
      .where(eq(commandsTable.id, created.id));
    await commandService.dispatch(created.id);

    const settled = await eventually(
      async () => {
        const [row] = await db.select().from(commandsTable).where(eq(commandsTable.id, created.id));
        return row!;
      },
      (row) => row.state === 'succeeded' || row.state === 'failed',
      { timeoutMs: 60_000 },
    );
    expect(settled.state).toBe('succeeded');
    expect(settled.resultDetail).toMatch(/already applied/iu);
  }, 120_000);

  it('refuses a write the worker capability ceiling does not permit', async () => {
    // The property that survives control-plane compromise: the ceiling lives in
    // worker.yaml, so a command that skipped every server-side check is still
    // refused at the point it would touch msdb.
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const target = jobs.find((j) => j.name === 'RSAgent Fixture - Heartbeat Log')!;

    const restrictedContext = {
      pool,
      instanceName: INSTANCE_NAME,
      capabilities: ['observe'] as const,
      outbox,
      logger,
      commandSigningPublicKey: signingKeys.publicKeyPem,
    };

    const command = buildProtoCommand(
      '99999999-9999-4999-8999-999999999999',
      'toggleJob',
      INSTANCE_NAME,
      { jobUuid: target.jobUuid, enabled: false, baseDefinitionHash: '' },
    );
    command.signature = signCommand(command, signingKeys.privateKeyPem);

    const result = await handleCommand(command, {
      ...restrictedContext,
      capabilities: [...restrictedContext.capabilities],
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('CapabilityDenied');
  }, 60_000);

  it('refuses a command whose signature does not verify', async () => {
    const [instance] = await getEstateOverview(db);
    const jobs = await listJobs(db, instance!.instanceId);
    const target = jobs.find((j) => j.name === 'RSAgent Fixture - Heartbeat Log')!;

    const command = buildProtoCommand(
      '88888888-8888-4888-8888-888888888888',
      'toggleJob',
      INSTANCE_NAME,
      { jobUuid: target.jobUuid, enabled: false, baseDefinitionHash: '' },
    );
    command.signature = signCommand(command, signingKeys.privateKeyPem);
    // Tamper after signing, exactly as an attacker on the path would.
    command.payload = {
      $case: 'toggleJob',
      toggleJob: { jobUuid: target.jobUuid, enabled: true, baseDefinitionHash: '' },
    };

    const result = await handleCommand(command, {
      pool,
      instanceName: INSTANCE_NAME,
      capabilities: ['observe', 'job.toggle'],
      outbox,
      logger,
      commandSigningPublicKey: signingKeys.publicKeyPem,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('BadSignature');
  }, 60_000);
});
