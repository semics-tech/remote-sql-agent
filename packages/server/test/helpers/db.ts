import postgres from 'postgres';
import { createDatabase, type Database } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * A real Postgres for the tests that are only meaningful against one: version
 * allocation under a transaction, ON CONFLICT idempotency, GREATEST on the
 * high-water mark. Mocking those would test the mock.
 */

const ADMIN_URL =
  process.env.RSAGENT_TEST_ADMIN_URL ??
  'postgres://rsagent:rsagent_dev_password@localhost:5433/rsagent';

export function testDatabaseUrl(name: string): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * Create and migrate a database for one test file.
 *
 * Each file gets its own database, keyed by a caller-supplied name. Sharing one
 * would make the per-test TRUNCATE in one file wipe another file's fixtures the
 * moment vitest scheduled them concurrently — a failure that looks like a
 * product bug and is not.
 */
export async function setupTestDatabase(
  suite: string,
): Promise<{ db: Database; close: () => Promise<void> }> {
  const name = `rsagent_test_${suite.replace(/[^a-z0-9_]/giu, '_').toLowerCase()}`;

  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    const existing = await admin`SELECT 1 FROM pg_database WHERE datname = ${name}`;
    if (existing.length === 0) {
      // CREATE DATABASE cannot be parameterised or run inside a transaction.
      await admin.unsafe(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  const url = testDatabaseUrl(name);
  await runMigrations(url);
  const { db, close } = createDatabase(url, { max: 4 });
  return { db, close };
}

/** Wipe every table between tests. RESTART IDENTITY keeps ids predictable. */
export async function truncateAll(db: Database): Promise<void> {
  await db.execute(
    `TRUNCATE TABLE
       job_versions, job_history, job_activity, agent_log_entries,
       jobs, sync_state, instances, commands, workers,
       audit_log, sessions, users, enrolment_tokens, server_keys,
       notification_channels, notification_rules, notification_events,
       notification_deliveries, worker_instance_configs, environment_grants
     RESTART IDENTITY CASCADE` as never,
  );
}

/**
 * Tag an instance the way the product does — through its configuration row.
 *
 * There is deliberately no shortcut that writes the tag onto `instances`. The
 * first version of this feature shipped inert precisely because every test set
 * the tag somewhere the product never writes it, so the guard looked correct
 * against a value nothing produced.
 */
export async function tagInstance(
  db: Database,
  instanceId: string,
  environmentTag: string | null,
): Promise<void> {
  const [row] = await db.execute(
    `SELECT worker_id, instance_name FROM instances WHERE id = '${instanceId}'` as never,
  );
  const { worker_id: workerId, instance_name: instanceName } = row as {
    worker_id: string;
    instance_name: string;
  };

  const value = environmentTag === null ? 'NULL' : `'${environmentTag.replaceAll("'", "''")}'`;
  await db.execute(
    `INSERT INTO worker_instance_configs (worker_id, instance_name, server_address, environment_tag)
     VALUES ('${workerId}', '${instanceName}', 'localhost', ${value})
     ON CONFLICT (worker_id, instance_name)
     DO UPDATE SET environment_tag = ${value}` as never,
  );
}

/** Insert a worker + instance and return the instance id. */
export async function seedInstance(
  db: Database,
  hostName = 'TESTHOST',
  instanceName = 'MSSQLSERVER',
): Promise<{ workerId: string; instanceId: string }> {
  const [worker] = await db.execute(
    `INSERT INTO workers (host_name, version, max_capability_reported)
     VALUES ('${hostName}', '0.1.0', 'readOnly') RETURNING id` as never,
  );
  const workerId = (worker as { id: string }).id;

  const [instance] = await db.execute(
    `INSERT INTO instances (worker_id, instance_name, agent_status)
     VALUES ('${workerId}', '${instanceName}', 'running') RETURNING id` as never,
  );
  const instanceId = (instance as { id: string }).id;

  await db.execute(`INSERT INTO sync_state (instance_id) VALUES ('${instanceId}')` as never);

  return { workerId, instanceId };
}
