import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { CommandService } from '../src/domain/commands.js';
import { WorkerRegistry } from '../src/hub/registry.js';
import { auditLog, workers } from '../src/db/schema.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';

/**
 * Which environment an audited write happened in.
 *
 * `request.environmentTag` used to be set only when a *grant* was what let a
 * write through — never when the base role alone was enough — so the audit
 * trail for the common case (a base-role Admin editing production) carried an
 * instance id but no environment. `requireInstancePermission` now resolves it
 * unconditionally and `issue()` threads it through to the command's audit row.
 */

let db: Database;
let close: () => Promise<void>;
const logger = pino({ level: 'silent' });

const config = loadConfig({
  RSAGENT_DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
  RSAGENT_GRPC_REQUIRE_TLS: 'false',
} as NodeJS.ProcessEnv);

const { privateKey } = generateKeyPairSync('ed25519');
const signingKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('audit_environment_tag'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

function service() {
  return new CommandService(db, config, new WorkerRegistry(), signingKeyPem, logger);
}

async function latestIssuedDetail(): Promise<Record<string, unknown>> {
  const rows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, 'command.issued'))
    .orderBy(auditLog.id);
  const last = rows.at(-1);
  return (last?.detail as Record<string, unknown>) ?? {};
}

describe('command.issued audit rows', () => {
  it('carry the environment tag the caller supplied', async () => {
    const { instanceId, workerId } = await seedInstance(db);
    await db
      .update(workers)
      .set({ capabilities: ['observe', 'job.toggle'], maxCapabilityReported: 'operate' })
      .where(eq(workers.id, workerId));
    await service().create({
      instanceId,
      kind: 'toggleJob',
      jobUuid: '11111111-1111-4111-8111-111111111111',
      payload: { jobUuid: '11111111-1111-4111-8111-111111111111', enabled: false },
      issuedBy: '00000000-0000-4000-8000-000000000000',
      issuedByUsername: 'dba',
      issuedByRole: 'Admin',
      environmentTag: 'production',
    });

    expect((await latestIssuedDetail()).environmentTag).toBe('production');
  });

  it('record null explicitly rather than omitting the field, for an untagged instance', async () => {
    // An absent key would make the shape of `detail` vary row to row for no
    // reason an auditor can see; a stated null says "resolved, and there
    // wasn't one" rather than leaving it ambiguous with "never resolved".
    const { instanceId, workerId } = await seedInstance(db);
    await db
      .update(workers)
      .set({ capabilities: ['observe', 'job.toggle'], maxCapabilityReported: 'operate' })
      .where(eq(workers.id, workerId));
    await service().create({
      instanceId,
      kind: 'toggleJob',
      jobUuid: '11111111-1111-4111-8111-111111111111',
      payload: { jobUuid: '11111111-1111-4111-8111-111111111111', enabled: false },
      issuedBy: '00000000-0000-4000-8000-000000000000',
      issuedByUsername: 'dba',
      issuedByRole: 'Admin',
    });

    const detail = await latestIssuedDetail();
    expect('environmentTag' in detail).toBe(true);
    expect(detail.environmentTag).toBeNull();
  });
});
