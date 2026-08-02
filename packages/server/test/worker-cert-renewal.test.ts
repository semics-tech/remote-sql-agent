import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import forge from 'node-forge';
import type { Database } from '../src/db/client.js';
import { workerCredentials, workers } from '../src/db/schema.js';
import { RenewalError, renewWorkerCertificate } from '../src/worker-auth/renewal.js';
import { fingerprintOf, loadOrCreateCa } from '../src/worker-auth/ca.js';
import type { ServerConfig } from '../src/config.js';
import { pino } from 'pino';
import type { ServerMessage } from '@remote-sql-agent/protocol';
import { handleCertificateRenewal } from '../src/hub/hub.js';
import { setupTestDatabase, truncateAll, seedInstance } from './helpers/db.js';

/**
 * Certificate renewal against a real database.
 *
 * The parts worth a real Postgres are the ones that decide whether a worker can
 * still connect afterwards: that the certificate it is *currently* using stays
 * valid across its own renewal, and that older spares do not accumulate as live
 * credentials forever.
 */

let db: Database;
let close: () => Promise<void>;
let workerId: string;

const config = {
  workerAuth: { enabledModes: ['mtls'], certValidityDays: 90 },
} as unknown as ServerConfig;

function makeCsr(commonName = 'TESTHOST'): string {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

/** Insert an mtls credential row, as enrolment or a previous renewal would. */
async function seedCredential(label: string): Promise<string> {
  const [row] = await db
    .insert(workerCredentials)
    .values({
      workerId,
      mode: 'mtls',
      certSerial: `serial-${label}-${Math.random().toString(16).slice(2)}`,
      certFingerprint: `fingerprint-${label}-${Math.random().toString(16).slice(2)}`,
      label,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    })
    .returning({ id: workerCredentials.id });
  if (!row) throw new Error('Failed to seed a credential');
  return row.id;
}

async function liveCredentials(): Promise<{ id: string; label: string | null }[]> {
  return db
    .select({ id: workerCredentials.id, label: workerCredentials.label })
    .from(workerCredentials)
    .where(and(eq(workerCredentials.workerId, workerId), eq(workerCredentials.mode, 'mtls')))
    .then((rows) => rows);
}

beforeAll(async () => {
  const setup = await setupTestDatabase('worker_cert_renewal');
  db = setup.db;
  close = setup.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(db);
  ({ workerId } = await seedInstance(db));
});

describe('renewWorkerCertificate', () => {
  it('issues a certificate the authenticator will accept', async () => {
    const current = await seedCredential('Issued at enrolment');

    const renewed = await renewWorkerCertificate(db, config, {
      workerId,
      hostName: 'TESTHOST',
      currentCredentialId: current,
      csrPem: makeCsr(),
    });

    // The fingerprint stored has to be the one computed from the certificate
    // itself: authentication looks the credential up by exactly this value.
    expect(renewed.fingerprint).toBe(fingerprintOf(renewed.certificatePem));

    const [stored] = await db
      .select()
      .from(workerCredentials)
      .where(eq(workerCredentials.certFingerprint, renewed.fingerprint));

    expect(stored?.revokedAt).toBeNull();
    expect(stored?.label).toBe('Renewed');
    expect(stored?.expiresAt?.getTime()).toBe(renewed.notAfter.getTime());
  });

  it('leaves the certificate in use valid alongside the new one', async () => {
    const current = await seedCredential('Issued at enrolment');

    await renewWorkerCertificate(db, config, {
      workerId,
      hostName: 'TESTHOST',
      currentCredentialId: current,
      csrPem: makeCsr(),
    });

    // Revoking it here would kill the very session carrying the response, so
    // the worker would never learn that renewal had succeeded.
    const [row] = await db
      .select()
      .from(workerCredentials)
      .where(eq(workerCredentials.id, current));
    expect(row?.revokedAt).toBeNull();

    const live = (await liveCredentials()).filter((c) => c.label !== null);
    expect(live).toHaveLength(2);
  });

  it('retires spares from earlier renewals', async () => {
    const oldest = await seedCredential('Issued at enrolment');
    const previous = await seedCredential('Renewed');
    const current = await seedCredential('Renewed');

    await renewWorkerCertificate(db, config, {
      workerId,
      hostName: 'TESTHOST',
      currentCredentialId: current,
      csrPem: makeCsr(),
    });

    // Without this a worker renewing every 45 days accumulates a live
    // credential per renewal forever, and each one still opens a session.
    for (const id of [oldest, previous]) {
      const [row] = await db.select().from(workerCredentials).where(eq(workerCredentials.id, id));
      expect(row?.revokedAt).not.toBeNull();
      expect(row?.revokedReason).toBe('Superseded by certificate renewal');
    }

    const [currentRow] = await db
      .select()
      .from(workerCredentials)
      .where(eq(workerCredentials.id, current));
    expect(currentRow?.revokedAt).toBeNull();
  });

  it('does not touch another worker credentials', async () => {
    const current = await seedCredential('Issued at enrolment');
    const { workerId: otherWorker } = await seedInstance(db, 'OTHERHOST', 'MSSQLSERVER');
    const [other] = await db
      .insert(workerCredentials)
      .values({
        workerId: otherWorker,
        mode: 'mtls',
        certSerial: 'serial-other',
        certFingerprint: 'fingerprint-other',
        label: 'Issued at enrolment',
      })
      .returning({ id: workerCredentials.id });

    await renewWorkerCertificate(db, config, {
      workerId,
      hostName: 'TESTHOST',
      currentCredentialId: current,
      csrPem: makeCsr(),
    });

    const [row] = await db
      .select()
      .from(workerCredentials)
      .where(eq(workerCredentials.id, other!.id));
    expect(row?.revokedAt).toBeNull();
  });

  it('records the new serial and expiry on the worker', async () => {
    const current = await seedCredential('Issued at enrolment');

    const renewed = await renewWorkerCertificate(db, config, {
      workerId,
      hostName: 'TESTHOST',
      currentCredentialId: current,
      csrPem: makeCsr(),
    });

    const [worker] = await db.select().from(workers).where(eq(workers.id, workerId));
    expect(worker?.certExpiresAt?.getTime()).toBe(renewed.notAfter.getTime());
    expect(worker?.certSerial).toBeTruthy();
  });

  it('issues from the same CA the hub verifies against', async () => {
    const current = await seedCredential('Issued at enrolment');
    const ca = await loadOrCreateCa(db);

    const renewed = await renewWorkerCertificate(db, config, {
      workerId,
      hostName: 'TESTHOST',
      currentCredentialId: current,
      csrPem: makeCsr(),
    });

    expect(renewed.caCertificatePem).toBe(ca.certificatePem);
    const issued = forge.pki.certificateFromPem(renewed.certificatePem);
    expect(forge.pki.certificateFromPem(ca.certificatePem).verify(issued)).toBe(true);
  });

  it('names the worker from its enrolled identity, not the CSR subject', async () => {
    const current = await seedCredential('Issued at enrolment');

    const renewed = await renewWorkerCertificate(db, config, {
      workerId,
      hostName: 'TESTHOST',
      currentCredentialId: current,
      // A worker that could name itself in a renewal could rename itself into
      // another worker's identity.
      csrPem: makeCsr('SOMEONE-ELSE'),
    });

    const issued = forge.pki.certificateFromPem(renewed.certificatePem);
    expect(issued.subject.getField('CN')?.value).toBe(workerId);
  });

  it('refuses when mtls is not an enabled mode', async () => {
    const current = await seedCredential('Issued at enrolment');
    const tokenOnly = {
      workerAuth: { enabledModes: ['token'], certValidityDays: 90 },
    } as unknown as ServerConfig;

    await expect(
      renewWorkerCertificate(db, tokenOnly, {
        workerId,
        hostName: 'TESTHOST',
        currentCredentialId: current,
        csrPem: makeCsr(),
      }),
    ).rejects.toThrow(RenewalError);
  });

  it('rejects a signing request that fails its own signature check', async () => {
    const current = await seedCredential('Issued at enrolment');

    // Proof the requester holds the key it is asking us to certify.
    const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 });
    const csr = forge.pki.createCertificationRequest();
    csr.publicKey = keys.publicKey;
    csr.setSubject([{ name: 'commonName', value: 'TESTHOST' }]);
    csr.sign(forge.pki.rsa.generateKeyPair({ bits: 2048 }).privateKey, forge.md.sha256.create());

    await expect(
      renewWorkerCertificate(db, config, {
        workerId,
        hostName: 'TESTHOST',
        currentCredentialId: current,
        csrPem: forge.pki.certificationRequestToPem(csr),
      }),
    ).rejects.toThrow(RenewalError);

    // Nothing stored on a rejected request.
    const live = await liveCredentials();
    expect(live).toHaveLength(1);
  });

  it('rejects an empty signing request', async () => {
    const current = await seedCredential('Issued at enrolment');

    await expect(
      renewWorkerCertificate(db, config, {
        workerId,
        hostName: 'TESTHOST',
        currentCredentialId: current,
        csrPem: '',
      }),
    ).rejects.toThrow(RenewalError);
  });
});

describe('handleCertificateRenewal', () => {
  const log = pino({ level: 'silent' });
  let sent: ServerMessage[];

  function ctx() {
    return { send: (m: ServerMessage) => void sent.push(m), log, remoteAddress: '10.0.0.9' };
  }

  function authenticatedAs(mode: 'token' | 'mtls' | 'entra', credentialId: string) {
    return { workerId, hostName: 'TESTHOST', credentialId, mode };
  }

  beforeEach(() => {
    sent = [];
  });

  it.each(['token', 'entra'] as const)(
    'refuses a renewal from a %s worker and issues nothing',
    async (mode) => {
      // Otherwise a worker whose enrolment never established that it holds a key
      // could talk itself into an mTLS identity.
      const current = await seedCredential('Issued at enrolment');

      await handleCertificateRenewal(
        { db, config, events: { publish: () => undefined } as never },
        authenticatedAs(mode, current),
        { csrPem: makeCsr() },
        ctx(),
      );

      expect(sent).toHaveLength(1);
      const reply = sent[0]?.msg;
      expect(reply?.$case).toBe('certificateRenewal');
      if (reply?.$case !== 'certificateRenewal') throw new Error('wrong reply');
      expect(reply.certificateRenewal.success).toBe(false);
      expect(reply.certificateRenewal.certificatePem).toBe('');
      expect(reply.certificateRenewal.errorDetail).toContain(mode);

      // No credential minted for the refused request.
      expect(await liveCredentials()).toHaveLength(1);
    },
  );

  it('issues to an mTLS worker and reports the new certificate', async () => {
    const current = await seedCredential('Issued at enrolment');

    await handleCertificateRenewal(
      { db, config, events: { publish: () => undefined } as never },
      authenticatedAs('mtls', current),
      { csrPem: makeCsr() },
      ctx(),
    );

    const reply = sent[0]?.msg;
    if (reply?.$case !== 'certificateRenewal') throw new Error('wrong reply');
    expect(reply.certificateRenewal.success).toBe(true);
    expect(reply.certificateRenewal.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(reply.certificateRenewal.caCertificatePem).toContain('BEGIN CERTIFICATE');
    expect(reply.certificateRenewal.notAfter).toBeDefined();
  });

  it('reports a bad CSR in band and keeps the session up', async () => {
    const current = await seedCredential('Issued at enrolment');

    await handleCertificateRenewal(
      { db, config, events: { publish: () => undefined } as never },
      authenticatedAs('mtls', current),
      { csrPem: 'not a csr' },
      ctx(),
    );

    const reply = sent[0]?.msg;
    if (reply?.$case !== 'certificateRenewal') throw new Error('wrong reply');
    expect(reply.certificateRenewal.success).toBe(false);
    // The worker's current certificate is still valid, so a failure here is a
    // reason to retry later rather than to drop the link.
    expect(reply.certificateRenewal.errorDetail).not.toBe('');
  });
});
