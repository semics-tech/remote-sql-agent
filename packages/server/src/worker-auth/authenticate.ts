import { and, eq, isNull } from 'drizzle-orm';
import type * as grpc from '@grpc/grpc-js';
import type { Database } from '../db/client.js';
import { workerCredentials, workers } from '../db/schema.js';
import { verifyWorkerKey, workerKeyPrefix } from '../auth/passwords.js';
import { EntraWorkloadValidator } from '../auth/entra.js';
import { fingerprintOf } from './ca.js';
import type { ServerConfig } from '../config.js';

/**
 * Authenticate a worker session (§6.2).
 *
 * Runs once per connection, before any message is processed. Failing closed is
 * the rule throughout: an unrecognised credential, a disabled mode, a revoked
 * key or an expired certificate all end the stream rather than degrading to a
 * lesser trust level.
 */

export const WORKER_KEY_METADATA = 'x-rsagent-worker-key';
export const WORKER_TOKEN_METADATA = 'authorization';

export interface AuthenticatedWorker {
  workerId: string;
  hostName: string;
  credentialId: string;
  mode: 'token' | 'mtls' | 'entra';
}

export class WorkerAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerAuthError';
  }
}

export class WorkerAuthenticator {
  readonly #entra: EntraWorkloadValidator | null;

  constructor(
    private readonly db: Database,
    private readonly config: ServerConfig,
  ) {
    const { entraTenantId, entraAudience, enabledModes } = config.workerAuth;
    this.#entra =
      enabledModes.includes('entra') && entraTenantId && entraAudience
        ? new EntraWorkloadValidator(entraTenantId, entraAudience)
        : null;

    if (enabledModes.includes('entra') && !this.#entra) {
      throw new Error(
        'Worker auth mode "entra" is enabled but RSAGENT_WORKER_ENTRA_TENANT_ID / ' +
          'RSAGENT_WORKER_ENTRA_AUDIENCE are not both set.',
      );
    }
  }

  get enabledModes(): string[] {
    return this.config.workerAuth.enabledModes;
  }

  /**
   * Identify the worker behind a call.
   *
   * mTLS is checked first: a verified client certificate is the strongest
   * assertion available and is established by the TLS layer before any
   * application byte is read.
   */
  async authenticate(call: {
    metadata: grpc.Metadata;
    getPeer: () => string;
    // Present only when the server was configured with client-cert verification.
    getPeerCertificate?: () => { raw?: Buffer; pem?: string } | null;
  }): Promise<AuthenticatedWorker> {
    if (this.enabledModes.includes('mtls')) {
      const certPem = extractPeerCertificate(call);
      if (certPem) return this.#authenticateMtls(certPem);
    }

    if (this.enabledModes.includes('entra')) {
      const bearer = firstMetadataValue(call.metadata, WORKER_TOKEN_METADATA);
      if (bearer) return this.#authenticateEntra(bearer.replace(/^Bearer\s+/iu, ''));
    }

    if (this.enabledModes.includes('token')) {
      const key = firstMetadataValue(call.metadata, WORKER_KEY_METADATA);
      if (key) return this.#authenticateToken(key);
    }

    throw new WorkerAuthError(
      'NoCredential',
      `No usable worker credential was presented. This control plane accepts: ${this.enabledModes.join(', ')}.`,
    );
  }

  async #authenticateToken(key: string): Promise<AuthenticatedWorker> {
    // Narrow by the stored prefix first so a lookup does not have to argon2-verify
    // every credential in the estate. The prefix is not a secret and is not
    // sufficient on its own.
    const prefix = workerKeyPrefix(key);
    const candidates = await this.db
      .select({
        id: workerCredentials.id,
        workerId: workerCredentials.workerId,
        secretHash: workerCredentials.secretHash,
        expiresAt: workerCredentials.expiresAt,
        hostName: workers.hostName,
      })
      .from(workerCredentials)
      .innerJoin(workers, eq(workers.id, workerCredentials.workerId))
      .where(
        and(
          eq(workerCredentials.mode, 'token'),
          eq(workerCredentials.secretPrefix, prefix),
          isNull(workerCredentials.revokedAt),
        ),
      );

    for (const candidate of candidates) {
      if (!candidate.secretHash) continue;
      if (!(await verifyWorkerKey(candidate.secretHash, key))) continue;

      if (candidate.expiresAt && candidate.expiresAt.getTime() < Date.now()) {
        throw new WorkerAuthError('CredentialExpired', 'This worker key has expired. Rotate it.');
      }

      await this.#touch(candidate.id);
      return {
        workerId: candidate.workerId,
        hostName: candidate.hostName,
        credentialId: candidate.id,
        mode: 'token',
      };
    }

    throw new WorkerAuthError('InvalidCredential', 'That worker key is not recognised.');
  }

  async #authenticateMtls(certPem: string): Promise<AuthenticatedWorker> {
    const fingerprint = fingerprintOf(certPem);
    const [credential] = await this.db
      .select({
        id: workerCredentials.id,
        workerId: workerCredentials.workerId,
        expiresAt: workerCredentials.expiresAt,
        revokedAt: workerCredentials.revokedAt,
        hostName: workers.hostName,
      })
      .from(workerCredentials)
      .innerJoin(workers, eq(workers.id, workerCredentials.workerId))
      .where(
        and(eq(workerCredentials.mode, 'mtls'), eq(workerCredentials.certFingerprint, fingerprint)),
      );

    if (!credential) {
      throw new WorkerAuthError('InvalidCredential', 'That client certificate is not registered.');
    }
    // Revocation is checked here rather than via a published CRL, so revoking a
    // certificate takes effect on the next connection rather than at the next
    // CRL refresh.
    if (credential.revokedAt) {
      throw new WorkerAuthError('CredentialRevoked', 'That client certificate has been revoked.');
    }
    if (credential.expiresAt && credential.expiresAt.getTime() < Date.now()) {
      throw new WorkerAuthError('CredentialExpired', 'That client certificate has expired.');
    }

    await this.#touch(credential.id);
    return {
      workerId: credential.workerId,
      hostName: credential.hostName,
      credentialId: credential.id,
      mode: 'mtls',
    };
  }

  async #authenticateEntra(token: string): Promise<AuthenticatedWorker> {
    if (!this.#entra) {
      throw new WorkerAuthError('ModeDisabled', 'Entra worker authentication is not enabled.');
    }

    let principal: { objectId: string; tenantId: string };
    try {
      principal = await this.#entra.validate(token);
    } catch (err) {
      throw new WorkerAuthError(
        'InvalidCredential',
        `Entra token rejected: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }

    const [credential] = await this.db
      .select({
        id: workerCredentials.id,
        workerId: workerCredentials.workerId,
        revokedAt: workerCredentials.revokedAt,
        hostName: workers.hostName,
      })
      .from(workerCredentials)
      .innerJoin(workers, eq(workers.id, workerCredentials.workerId))
      .where(
        and(
          eq(workerCredentials.mode, 'entra'),
          eq(workerCredentials.entraObjectId, principal.objectId),
        ),
      );

    // A valid Entra token proves the caller is *a* principal in the tenant, not
    // that it is a worker we know. The object id must have been pinned at
    // enrolment, or any identity in the tenant could register as a worker.
    if (!credential) {
      throw new WorkerAuthError(
        'InvalidCredential',
        'That managed identity is not enrolled as a worker.',
      );
    }
    if (credential.revokedAt) {
      throw new WorkerAuthError('CredentialRevoked', 'That managed identity has been revoked.');
    }

    await this.#touch(credential.id);
    return {
      workerId: credential.workerId,
      hostName: credential.hostName,
      credentialId: credential.id,
      mode: 'entra',
    };
  }

  async #touch(credentialId: string): Promise<void> {
    await this.db
      .update(workerCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(workerCredentials.id, credentialId))
      .catch(() => undefined);
  }
}

function firstMetadataValue(metadata: grpc.Metadata, key: string): string | null {
  const values = metadata.get(key);
  const first = values[0];
  if (typeof first === 'string') return first;
  if (first instanceof Buffer) return first.toString('utf8');
  return null;
}

function extractPeerCertificate(call: {
  getPeerCertificate?: () => { raw?: Buffer; pem?: string } | null;
}): string | null {
  const cert = call.getPeerCertificate?.();
  if (!cert) return null;
  if (cert.pem) return cert.pem;
  if (cert.raw) {
    const base64 = cert.raw.toString('base64').replace(/(.{64})/gu, '$1\n');
    return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
  }
  return null;
}
