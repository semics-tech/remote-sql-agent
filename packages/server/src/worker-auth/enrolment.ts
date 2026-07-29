import { and, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import {
  enrolmentTokens,
  workerCredentials,
  workers,
  type WorkerCredentialMode,
} from '../db/schema.js';
import {
  generateSecret,
  generateWorkerKey,
  hashToken,
  hashWorkerKey,
} from '../auth/passwords.js';
import { issueClientCertificate, loadOrCreateCa, type CaMaterial } from './ca.js';
import type { ServerConfig } from '../config.js';

/**
 * Worker enrolment (§6.2).
 *
 * One flow serves all three credential modes: an administrator mints a
 * single-use, short-lived token bound to a host name, the installer hands it to
 * the worker once, and the worker exchanges it for a durable credential. The
 * enrolment token is the only bearer secret that ever travels by a channel the
 * control plane does not control, which is why it is single-use and expires in
 * an hour by default.
 */

export interface CreateEnrolmentTokenParams {
  hostName: string;
  credentialMode: WorkerCredentialMode;
  intendedCapabilities: string[];
  createdBy: string | null;
  ttlMinutes: number;
}

export interface CreatedEnrolmentToken {
  /** Shown once. Only its hash is stored. */
  token: string;
  id: string;
  expiresAt: Date;
}

export async function createEnrolmentToken(
  db: Database,
  params: CreateEnrolmentTokenParams,
): Promise<CreatedEnrolmentToken> {
  const token = `rsen_${generateSecret(24)}`;
  const expiresAt = new Date(Date.now() + params.ttlMinutes * 60 * 1000);

  const [row] = await db
    .insert(enrolmentTokens)
    .values({
      tokenHash: hashToken(token),
      hostName: params.hostName,
      credentialMode: params.credentialMode,
      intendedCapabilities: params.intendedCapabilities,
      createdBy: params.createdBy,
      expiresAt,
    })
    .returning({ id: enrolmentTokens.id });

  if (!row) throw new Error('Failed to create the enrolment token.');
  return { token, id: row.id, expiresAt };
}

export class EnrolmentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EnrolmentError';
  }
}

export interface EnrolRequestParams {
  token: string;
  hostName: string;
  workerVersion: string;
  /** Required for mtls mode; ignored otherwise. */
  csrPem?: string | undefined;
  /** Required for entra mode: the managed identity's object id, already
   * validated from a presented token. */
  entraObjectId?: string | undefined;
  entraTenantId?: string | undefined;
}

export interface EnrolResult {
  workerId: string;
  mode: WorkerCredentialMode;
  /** token mode: shown once, never recoverable. */
  workerKey?: string;
  /** mtls mode. */
  certificatePem?: string;
  caCertificatePem?: string;
  notAfter?: Date;
}

/**
 * Redeem an enrolment token for a durable credential.
 *
 * The token is consumed inside the same transaction that creates the
 * credential, so two installers racing with the same token cannot both succeed.
 */
export async function redeemEnrolmentToken(
  db: Database,
  config: ServerConfig,
  params: EnrolRequestParams,
): Promise<EnrolResult> {
  const mode = await db.transaction(async (tx) => {
    const [token] = await tx
      .select()
      .from(enrolmentTokens)
      .where(and(eq(enrolmentTokens.tokenHash, hashToken(params.token)), isNull(enrolmentTokens.usedAt)))
      .for('update');

    if (!token) {
      throw new EnrolmentError('InvalidToken', 'That enrolment token is unknown or already used.');
    }
    if (token.expiresAt.getTime() < Date.now()) {
      throw new EnrolmentError('TokenExpired', 'That enrolment token has expired. Generate a new one.');
    }
    // Binding to a host name stops a token intended for one server being used
    // to enrol an attacker's machine.
    if (token.hostName.toLowerCase() !== params.hostName.toLowerCase()) {
      throw new EnrolmentError(
        'HostMismatch',
        `This token was issued for ${token.hostName}, but enrolment came from ${params.hostName}.`,
      );
    }
    if (!config.workerAuth.enabledModes.includes(token.credentialMode)) {
      throw new EnrolmentError(
        'ModeDisabled',
        `Worker auth mode "${token.credentialMode}" is not enabled on this control plane.`,
      );
    }

    const [worker] = await tx
      .insert(workers)
      .values({
        hostName: params.hostName,
        version: params.workerVersion,
        capabilities: token.intendedCapabilities,
      })
      .onConflictDoUpdate({
        target: workers.hostName,
        set: { version: params.workerVersion, capabilities: token.intendedCapabilities },
      })
      .returning({ id: workers.id });

    if (!worker) throw new EnrolmentError('Internal', 'Failed to register the worker.');

    await tx
      .update(enrolmentTokens)
      .set({ usedAt: new Date(), usedByWorkerId: worker.id })
      .where(eq(enrolmentTokens.id, token.id));

    return { workerId: worker.id, mode: token.credentialMode };
  });

  switch (mode.mode) {
    case 'token': {
      const { key, prefix } = generateWorkerKey();
      const expiresAt = config.workerAuth.tokenTtlDays
        ? new Date(Date.now() + config.workerAuth.tokenTtlDays * 24 * 60 * 60 * 1000)
        : null;

      await db.insert(workerCredentials).values({
        workerId: mode.workerId,
        mode: 'token',
        secretHash: await hashWorkerKey(key),
        secretPrefix: prefix,
        label: 'Issued at enrolment',
        expiresAt,
      });

      return { workerId: mode.workerId, mode: 'token', workerKey: key, notAfter: expiresAt ?? undefined };
    }

    case 'mtls': {
      if (!params.csrPem) {
        throw new EnrolmentError('CsrRequired', 'mTLS enrolment requires a certificate signing request.');
      }
      const ca = await loadOrCreateCa(db);
      const [worker] = await db.select().from(workers).where(eq(workers.id, mode.workerId));
      const issued = issueClientCertificate(
        ca,
        params.csrPem,
        mode.workerId,
        worker?.hostName ?? params.hostName,
        config.workerAuth.certValidityDays,
      );

      await db.insert(workerCredentials).values({
        workerId: mode.workerId,
        mode: 'mtls',
        certSerial: issued.serial,
        certFingerprint: issued.fingerprint,
        certPem: issued.certificatePem,
        label: 'Issued at enrolment',
        expiresAt: issued.notAfter,
      });

      await db
        .update(workers)
        .set({ certSerial: issued.serial, certExpiresAt: issued.notAfter })
        .where(eq(workers.id, mode.workerId));

      return {
        workerId: mode.workerId,
        mode: 'mtls',
        certificatePem: issued.certificatePem,
        caCertificatePem: ca.certificatePem,
        notAfter: issued.notAfter,
      };
    }

    case 'entra': {
      if (!params.entraObjectId) {
        throw new EnrolmentError(
          'IdentityRequired',
          'Entra enrolment requires a validated workload identity token.',
        );
      }
      await db.insert(workerCredentials).values({
        workerId: mode.workerId,
        mode: 'entra',
        entraObjectId: params.entraObjectId,
        entraTenantId: params.entraTenantId ?? null,
        label: 'Managed identity pinned at enrolment',
      });
      return { workerId: mode.workerId, mode: 'entra' };
    }
  }
}

/** Rotate a token-mode credential, returning the new key once. */
export async function rotateWorkerKey(
  db: Database,
  workerId: string,
  config: ServerConfig,
  createdBy: string | null,
): Promise<string> {
  const { key, prefix } = generateWorkerKey();
  const expiresAt = config.workerAuth.tokenTtlDays
    ? new Date(Date.now() + config.workerAuth.tokenTtlDays * 24 * 60 * 60 * 1000)
    : null;

  await db.insert(workerCredentials).values({
    workerId,
    mode: 'token',
    secretHash: await hashWorkerKey(key),
    secretPrefix: prefix,
    label: 'Rotated',
    createdBy,
    expiresAt,
  });

  // The previous key is deliberately left valid until explicitly revoked, so a
  // rotation cannot lock out a worker that has not picked up the new key yet.
  return key;
}

export async function revokeCredential(
  db: Database,
  credentialId: string,
  reason: string,
): Promise<void> {
  await db
    .update(workerCredentials)
    .set({ revokedAt: new Date(), revokedReason: reason })
    .where(eq(workerCredentials.id, credentialId));
}

export async function listCredentials(db: Database, workerId: string) {
  return db
    .select({
      id: workerCredentials.id,
      mode: workerCredentials.mode,
      secretPrefix: workerCredentials.secretPrefix,
      certSerial: workerCredentials.certSerial,
      entraObjectId: workerCredentials.entraObjectId,
      label: workerCredentials.label,
      expiresAt: workerCredentials.expiresAt,
      revokedAt: workerCredentials.revokedAt,
      lastUsedAt: workerCredentials.lastUsedAt,
      createdAt: workerCredentials.createdAt,
    })
    .from(workerCredentials)
    .where(eq(workerCredentials.workerId, workerId));
}

export type { CaMaterial };
