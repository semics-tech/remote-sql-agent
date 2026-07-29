import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Database } from '../src/db/client.js';
import { instances } from '../src/db/schema.js';
import { deleteInstanceConfig, upsertInstanceConfig } from '../src/domain/worker-config.js';
import { getEstateOverview } from '../src/domain/queries.js';
import { getOverview, groupJobs } from '../src/domain/overview.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';

/**
 * Detaching an instance.
 *
 * Removing a configuration has to stop the instance appearing as live without
 * destroying its history — the run timeline is most of why anyone runs this.
 * Every estate-wide view has to agree about that, which is what these pin: a
 * detached instance leaking back into one view but not another is worse than it
 * showing in all of them, because the numbers stop reconciling.
 */

let db: Database;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('instance_detach'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

async function configure(workerId: string, instanceName = 'MSSQLSERVER') {
  return upsertInstanceConfig(db, {
    workerId,
    instanceName,
    serverAddress: 'localhost',
    authMode: 'integrated',
    actorId: null,
  });
}

async function seedJob(instanceId: string, jobUuid: string, name: string): Promise<void> {
  await db.execute(
    `INSERT INTO jobs (instance_id, job_uuid, name) VALUES ('${instanceId}', '${jobUuid}', '${name}')` as never,
  );
}

const JOB_UUID = '11111111-1111-4111-8111-111111111111';

describe('removing an instance configuration', () => {
  it('keeps the row and its history rather than deleting it', async () => {
    const { workerId, instanceId } = await seedInstance(db);
    await seedJob(instanceId, JOB_UUID, 'Nightly Backup');
    const config = await configure(workerId);

    await deleteInstanceConfig(db, config.id);

    // A one-click Remove must not destroy the version timeline and run history
    // that are the reason the product exists.
    const [row] = await db.select().from(instances).where(eq(instances.id, instanceId));
    expect(row).toBeDefined();
    expect(row!.detachedAt).toBeInstanceOf(Date);
  });

  it('drops out of the estate view', async () => {
    const { workerId } = await seedInstance(db);
    const config = await configure(workerId);
    expect(await getEstateOverview(db)).toHaveLength(1);

    await deleteInstanceConfig(db, config.id);
    expect(await getEstateOverview(db)).toHaveLength(0);
  });

  it('stops counting towards the overview totals', async () => {
    const { workerId, instanceId } = await seedInstance(db);
    await seedJob(instanceId, JOB_UUID, 'Nightly Backup');
    const config = await configure(workerId);

    const before = await getOverview(db, () => true);
    expect(before.totals.instances).toBe(1);
    expect(before.totals.jobs).toBe(1);
    expect(before.workers[0]!.instanceCount).toBe(1);

    await deleteInstanceConfig(db, config.id);

    const after = await getOverview(db, () => true);
    expect(after.totals.instances).toBe(0);
    expect(after.totals.jobs).toBe(0);
    // The worker is still enrolled; it just has nothing to monitor.
    expect(after.workers[0]!.instanceCount).toBe(0);
  });

  it('drops out of cross-estate grouping', async () => {
    const { workerId, instanceId } = await seedInstance(db);
    await seedJob(instanceId, JOB_UUID, 'Nightly Backup');
    const config = await configure(workerId);

    expect(await groupJobs(db, 'name')).toHaveLength(1);

    await deleteInstanceConfig(db, config.id);
    expect(await groupJobs(db, 'name')).toHaveLength(0);
  });

  it('comes back, with its history, when configured again', async () => {
    const { workerId, instanceId } = await seedInstance(db);
    await seedJob(instanceId, JOB_UUID, 'Nightly Backup');

    const config = await configure(workerId);
    await deleteInstanceConfig(db, config.id);
    await configure(workerId);

    const estate = await getEstateOverview(db);
    expect(estate).toHaveLength(1);
    // Same row, so the job and its history came back with it.
    expect(estate[0]!.instanceId).toBe(instanceId);
    expect(estate[0]!.jobCount).toBe(1);
  });

  it('leaves other instances on the same worker alone', async () => {
    const { workerId } = await seedInstance(db, 'HOST-A', 'MSSQLSERVER');
    await db.execute(
      `INSERT INTO instances (worker_id, instance_name, agent_status)
       VALUES ('${workerId}', 'INST2', 'running')` as never,
    );

    const config = await configure(workerId, 'MSSQLSERVER');
    await configure(workerId, 'INST2');

    await deleteInstanceConfig(db, config.id);

    const estate = await getEstateOverview(db);
    expect(estate.map((i) => i.instanceName)).toEqual(['INST2']);
  });
});
