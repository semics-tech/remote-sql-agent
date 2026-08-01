import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { CommandService } from '../src/domain/commands.js';
import { WorkerRegistry } from '../src/hub/registry.js';
import { auditLog, commands, workers } from '../src/db/schema.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';

/**
 * What a worker is allowed to assert about a command.
 *
 * A worker is trusted for its own instances. It is not trusted for the estate,
 * and the difference matters here because `recordResult` selected on the command
 * id alone: any authenticated worker could finalise any command by guessing or
 * replaying an id, and the audit row it wrote named *itself* as the actor.
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
  ({ db, close } = await setupTestDatabase('command_result_scope'));
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

/** Two workers, and one command queued against the first. */
async function twoWorkersOneCommand() {
  const mine = await seedInstance(db, 'SQL01');
  const theirs = await seedInstance(db, 'SQL02');

  // Enough capability for `create` to get past its own gate, so what is under
  // test is the result path rather than the issue path. `operate` is the tier
  // that includes job.toggle; the grant is intersected with it.
  await db
    .update(workers)
    .set({ capabilities: ['observe', 'job.toggle'], maxCapabilityReported: 'operate' })
    .where(eq(workers.id, mine.workerId));

  const created = await service().create({
    instanceId: mine.instanceId,
    kind: 'toggleJob',
    jobUuid: '44444444-4444-4444-8444-444444444444',
    payload: { jobUuid: '44444444-4444-4444-8444-444444444444', enabled: false },
    issuedBy: '00000000-0000-4000-8000-000000000000',
    issuedByUsername: 'dba',
    issuedByRole: 'Admin',
  });

  return { commandId: created.id, mine, theirs };
}

describe('a result reported by a worker the command was not sent to', () => {
  it('is ignored rather than finalising the command', async () => {
    const { commandId, theirs } = await twoWorkersOneCommand();

    const outcome = await service().recordResult({
      commandId,
      workerId: theirs.workerId,
      success: true,
      errorCode: '',
      errorDetail: '',
      sqlErrorNumber: 0,
      hostName: 'SQL02',
    });

    expect(outcome).toBeNull();

    const [row] = await db.select().from(commands).where(eq(commands.id, commandId));
    // Still awaiting its real worker, not marked succeeded by a stranger.
    expect(row!.state).not.toBe('succeeded');
    expect(row!.completedAt).toBeNull();
  });

  it('writes no audit row claiming it applied the change', async () => {
    const { commandId, theirs } = await twoWorkersOneCommand();

    await service().recordResult({
      commandId,
      workerId: theirs.workerId,
      success: true,
      errorCode: '',
      errorDetail: '',
      sqlErrorNumber: 0,
      hostName: 'SQL02',
    });

    const rows = await db.select().from(auditLog);
    // `command.issued` is expected; a `command.result` attributed to SQL02 is
    // the forged row this guards against.
    expect(rows.map((r) => r.action)).not.toContain('command.result');
    expect(rows.some((r) => r.actor === 'SQL02')).toBe(false);
  });

  it('still accepts the result from the worker it was actually sent to', async () => {
    const { commandId, mine } = await twoWorkersOneCommand();

    const outcome = await service().recordResult({
      commandId,
      workerId: mine.workerId,
      success: true,
      errorCode: '',
      errorDetail: '',
      sqlErrorNumber: 0,
      hostName: 'SQL01',
    });

    expect(outcome).not.toBeNull();
    const [row] = await db.select().from(commands).where(eq(commands.id, commandId));
    expect(row!.state).toBe('succeeded');
  });

  it('ignores an id that matches nothing at all', async () => {
    const { mine } = await twoWorkersOneCommand();

    const outcome = await service().recordResult({
      commandId: '55555555-5555-4555-8555-555555555555',
      workerId: mine.workerId,
      success: true,
      errorCode: '',
      errorDetail: '',
      sqlErrorNumber: 0,
      hostName: 'SQL01',
    });

    expect(outcome).toBeNull();
  });
});
