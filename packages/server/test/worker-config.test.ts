import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { generateKeyPairSync } from 'node:crypto';
import type { Database } from '../src/db/client.js';
import { workerInstanceConfigs } from '../src/db/schema.js';
import {
  fingerprintPublicKey,
  getCredentialKey,
  listInstanceConfigs,
  recordCredentialKey,
  upsertInstanceConfig,
} from '../src/domain/worker-config.js';
import { setupTestDatabase, seedInstance, truncateAll } from './helpers/db.js';

/**
 * The credential relay.
 *
 * The property under test throughout: the control plane stores ciphertext it
 * cannot read, and knows when that ciphertext has become unreadable by the only
 * party that could open it.
 */

let db: Database;
let close: () => Promise<void>;

/** A stand-in for the keypair a worker generates on its own SQL host. */
function workerKey(): { publicKeyPem: string; fingerprint: string } {
  const { publicKey } = generateKeyPairSync('rsa', {
    // Small: these tests never encrypt with it, and 4096 makes them crawl.
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, fingerprint: fingerprintPublicKey(publicKey) };
}

beforeAll(async () => {
  ({ db, close } = await setupTestDatabase('worker_config'));
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
});

describe('recordCredentialKey', () => {
  it('does not report a re-key on a worker first connection', async () => {
    const { workerId } = await seedInstance(db);
    const key = workerKey();

    const result = await recordCredentialKey(db, workerId, key.publicKeyPem);

    // The column starts null. Treating "no key yet" as "the key changed" raised
    // a false audit event on every enrolment and told operators to re-enter
    // credentials that had never been set.
    expect(result.changed).toBe(false);
    expect(result.fingerprint).toBe(key.fingerprint);
  });

  it('does not report a re-key when the same worker reconnects', async () => {
    const { workerId } = await seedInstance(db);
    const key = workerKey();

    await recordCredentialKey(db, workerId, key.publicKeyPem);
    const second = await recordCredentialKey(db, workerId, key.publicKeyPem);

    expect(second.changed).toBe(false);
  });

  it('reports a re-key when the worker publishes a different key', async () => {
    const { workerId } = await seedInstance(db);
    await recordCredentialKey(db, workerId, workerKey().publicKeyPem);

    const replacement = workerKey();
    const result = await recordCredentialKey(db, workerId, replacement.publicKeyPem);

    expect(result.changed).toBe(true);
    expect(result.fingerprint).toBe(replacement.fingerprint);
  });

  it('marks stored SQL credentials unreadable after a genuine re-key', async () => {
    const { workerId } = await seedInstance(db);
    const key = await recordCredentialKey(db, workerId, workerKey().publicKeyPem);

    await upsertInstanceConfig(db, {
      workerId,
      instanceName: 'MSSQLSERVER',
      serverAddress: 'localhost',
      authMode: 'sql',
      loginName: 'rsagent_worker',
      credentialCiphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
      credentialKeyFingerprint: key.fingerprint,
      actorId: null,
    });

    await recordCredentialKey(db, workerId, workerKey().publicKeyPem);

    const [config] = await db
      .select()
      .from(workerInstanceConfigs)
      .where(eq(workerInstanceConfigs.workerId, workerId));

    // Said plainly, rather than left to surface as a failed login — the two
    // need completely different responses from an operator.
    expect(config!.status).toBe('awaiting_credentials');
    expect(config!.statusDetail).toContain('new key');
  });

  it('leaves an integrated-auth config alone across a re-key', async () => {
    const { workerId } = await seedInstance(db);
    await recordCredentialKey(db, workerId, workerKey().publicKeyPem);

    await upsertInstanceConfig(db, {
      workerId,
      instanceName: 'MSSQLSERVER',
      serverAddress: 'localhost',
      authMode: 'integrated',
      actorId: null,
    });

    await recordCredentialKey(db, workerId, workerKey().publicKeyPem);

    const [config] = await listInstanceConfigs(db, workerId);
    // There is no stored secret to invalidate, so nothing to re-enter.
    expect(config!.status).toBe('pending');
  });

  it('fingerprints the key rather than its text', async () => {
    const { workerId } = await seedInstance(db);
    const key = workerKey();

    await recordCredentialKey(db, workerId, key.publicKeyPem);
    // Whitespace differences from a round trip through a form field must not
    // read as a different key.
    const again = await recordCredentialKey(db, workerId, `${key.publicKeyPem.trimEnd()}\n\n`);

    expect(again.changed).toBe(false);
  });
});

describe('upsertInstanceConfig', () => {
  it('refuses ciphertext encrypted to a key the worker no longer holds', async () => {
    const { workerId } = await seedInstance(db);
    await recordCredentialKey(db, workerId, workerKey().publicKeyPem);

    // A stale form: the worker re-keyed while it was open. Storing this would
    // produce ciphertext nothing can read, which would look configured.
    await expect(
      upsertInstanceConfig(db, {
        workerId,
        instanceName: 'MSSQLSERVER',
        serverAddress: 'localhost',
        authMode: 'sql',
        loginName: 'rsagent_worker',
        credentialCiphertext: 'ZmFrZQ==',
        credentialKeyFingerprint: 'f'.repeat(64),
        actorId: null,
      }),
    ).rejects.toThrow(/changed its encryption key/iu);
  });

  it('refuses a credential before the worker has published a key', async () => {
    const { workerId } = await seedInstance(db);

    await expect(
      upsertInstanceConfig(db, {
        workerId,
        instanceName: 'MSSQLSERVER',
        serverAddress: 'localhost',
        authMode: 'sql',
        loginName: 'rsagent_worker',
        credentialCiphertext: 'ZmFrZQ==',
        credentialKeyFingerprint: 'f'.repeat(64),
        actorId: null,
      }),
    ).rejects.toThrow(/has not published an encryption key/iu);
  });

  it('never returns the ciphertext it stored', async () => {
    const { workerId } = await seedInstance(db);
    const key = await recordCredentialKey(db, workerId, workerKey().publicKeyPem);

    const saved = await upsertInstanceConfig(db, {
      workerId,
      instanceName: 'MSSQLSERVER',
      serverAddress: 'localhost',
      authMode: 'sql',
      loginName: 'rsagent_worker',
      credentialCiphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
      credentialKeyFingerprint: key.fingerprint,
      actorId: null,
    });

    expect(saved.hasCredential).toBe(true);
    expect(JSON.stringify(saved)).not.toContain('ZmFrZS1jaXBoZXJ0ZXh0');
  });

  it('clears a stored credential when switching to integrated auth', async () => {
    const { workerId } = await seedInstance(db);
    const key = await recordCredentialKey(db, workerId, workerKey().publicKeyPem);

    await upsertInstanceConfig(db, {
      workerId,
      instanceName: 'MSSQLSERVER',
      serverAddress: 'localhost',
      authMode: 'sql',
      loginName: 'rsagent_worker',
      credentialCiphertext: 'ZmFrZS1jaXBoZXJ0ZXh0',
      credentialKeyFingerprint: key.fingerprint,
      actorId: null,
    });

    const updated = await upsertInstanceConfig(db, {
      workerId,
      instanceName: 'MSSQLSERVER',
      serverAddress: 'localhost',
      authMode: 'integrated',
      actorId: null,
    });

    // Leaving a password behind for a config that no longer uses one is a
    // secret nobody is tracking.
    expect(updated.hasCredential).toBe(false);
    expect(updated.loginName).toBeNull();
  });

  it('requires a login name for SQL authentication', async () => {
    const { workerId } = await seedInstance(db);
    await expect(
      upsertInstanceConfig(db, {
        workerId,
        instanceName: 'MSSQLSERVER',
        serverAddress: 'localhost',
        authMode: 'sql',
        actorId: null,
      }),
    ).rejects.toThrow(/login name/iu);
  });
});

describe('getCredentialKey', () => {
  it('returns nothing until the worker has published one', async () => {
    const { workerId } = await seedInstance(db);
    expect(await getCredentialKey(db, workerId)).toBeNull();
  });
});
