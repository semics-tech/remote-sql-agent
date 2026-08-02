import { and, eq, isNull, ne } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { workerCredentials, workers } from '../db/schema.js';
import { issueClientCertificate, loadOrCreateCa } from './ca.js';
import type { ServerConfig } from '../config.js';

/**
 * Client-certificate renewal (§6.2).
 *
 * Enrolment used to be the only way a worker could ever obtain a certificate,
 * which made `RSAGENT_WORKER_CERT_VALIDITY_DAYS` an outage timer rather than a
 * security control: at day 90 every mTLS worker in the estate stopped being able
 * to connect, and each one needed a human to mint a fresh single-use enrolment
 * token. Short certificate lifetimes are only defensible once something renews
 * them, and this is that something.
 *
 * The authorising fact is possession of a working credential, established by the
 * TLS handshake that opened the session this request arrives on. That is the
 * same basis EST `simplereenroll` (RFC 7030) and kubelet client-certificate
 * rotation use. It does mean a *stolen* worker key can keep renewing itself
 * indefinitely; the answers to that are the audit row written on every renewal
 * and the per-connection revocation check, not an expiry the legitimate worker
 * would trip over first.
 */

export class RenewalError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RenewalError';
  }
}

export interface RenewCertificateParams {
  workerId: string;
  hostName: string;
  /** The credential that authenticated this session, exempt from the sweep below. */
  currentCredentialId: string;
  csrPem: string;
}

export interface RenewedCertificate {
  certificatePem: string;
  caCertificatePem: string;
  notAfter: Date;
  fingerprint: string;
  /** Older spare certificates retired by this renewal, for the audit detail. */
  supersededCount: number;
}

export async function renewWorkerCertificate(
  db: Database,
  config: ServerConfig,
  params: RenewCertificateParams,
): Promise<RenewedCertificate> {
  if (!config.workerAuth.enabledModes.includes('mtls')) {
    throw new RenewalError(
      'ModeDisabled',
      'Worker auth mode "mtls" is not enabled on this control plane.',
    );
  }
  if (!params.csrPem) {
    throw new RenewalError('CsrRequired', 'Certificate renewal requires a signing request.');
  }

  const ca = await loadOrCreateCa(db);

  let issued;
  try {
    issued = issueClientCertificate(
      ca,
      params.csrPem,
      params.workerId,
      params.hostName,
      config.workerAuth.certValidityDays,
    );
  } catch (err) {
    // A CSR that fails its own signature check is the interesting case: it means
    // whatever sent it does not hold the key it is asking us to certify.
    throw new RenewalError(
      'InvalidCsr',
      `The certificate signing request was rejected: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const supersededCount = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(workerCredentials)
      .values({
        workerId: params.workerId,
        mode: 'mtls',
        certSerial: issued.serial,
        certFingerprint: issued.fingerprint,
        certPem: issued.certificatePem,
        label: 'Renewed',
        expiresAt: issued.notAfter,
      })
      .returning({ id: workerCredentials.id });

    if (!inserted) throw new RenewalError('Internal', 'Failed to store the renewed certificate.');

    // The certificate in use stays valid alongside the new one. Renewal happens
    // at half-life while the worker is connected *on* the old certificate, and
    // revoking it here would kill the very session carrying the response — the
    // worker would lose the reply telling it renewal had succeeded.
    //
    // Everything older than those two goes, though. Without this a worker that
    // renews every 45 days accumulates a live certificate per renewal forever,
    // and each one is a credential that still opens a session.
    const retired = await tx
      .update(workerCredentials)
      .set({ revokedAt: new Date(), revokedReason: 'Superseded by certificate renewal' })
      .where(
        and(
          eq(workerCredentials.workerId, params.workerId),
          eq(workerCredentials.mode, 'mtls'),
          isNull(workerCredentials.revokedAt),
          ne(workerCredentials.id, inserted.id),
          ne(workerCredentials.id, params.currentCredentialId),
        ),
      )
      .returning({ id: workerCredentials.id });

    await tx
      .update(workers)
      .set({ certSerial: issued.serial, certExpiresAt: issued.notAfter })
      .where(eq(workers.id, params.workerId));

    return retired.length;
  });

  return {
    certificatePem: issued.certificatePem,
    caCertificatePem: ca.certificatePem,
    notAfter: issued.notAfter,
    fingerprint: issued.fingerprint,
    supersededCount,
  };
}
