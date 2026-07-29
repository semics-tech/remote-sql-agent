import { createHash, createPublicKey } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { WorkerRegistry } from '../hub/registry.js';
import {
  instances,
  workerInstanceConfigs,
  workers,
  type InstanceConfigStatus as ConfigStatus,
  type SqlAuthMode,
} from '../db/schema.js';

/**
 * Worker onboarding: which SQL instances a worker monitors, and how it logs in.
 *
 * The design rule this file exists to hold:
 *
 *   **The control plane never holds a usable SQL credential.**
 *
 * A password typed in the dashboard is encrypted *in the browser* to the public
 * key that specific worker generated on its own host at enrolment. What reaches
 * this process, and what lands in Postgres, is ciphertext only that one host can
 * open. The alternative — the control plane decrypting on the worker's behalf —
 * would put working logins for every instance in the estate inside the single
 * component every network segment can reach, which is precisely the
 * concentration of risk the outbound-only architecture exists to avoid.
 *
 * The cost of that choice is honest and worth stating: a compromised *host*
 * still yields its own credential, because a worker must be able to log in.
 * Nothing can fix that, and integrated authentication (no stored password at
 * all) is why it is the default.
 */

export class WorkerConfigError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerConfigError';
  }
}

/**
 * sha256 over the DER SPKI, hex. Computed from the key itself rather than the
 * PEM text so that whitespace or line-ending differences cannot make the same
 * key fingerprint two ways.
 */
export function fingerprintPublicKey(pem: string): string {
  const der = createPublicKey(pem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

export interface WorkerCredentialKey {
  publicKeyPem: string;
  fingerprint: string;
}

/**
 * The key the dashboard should encrypt to.
 *
 * Absent until the worker has connected at least once and published one. There
 * is deliberately no fallback: an admin must not be able to store a credential
 * that no worker can read, because it would look configured and silently never
 * work.
 */
export async function getCredentialKey(
  db: Database,
  workerId: string,
): Promise<WorkerCredentialKey | null> {
  const [row] = await db
    .select({
      pem: workers.credentialPublicKeyPem,
      fingerprint: workers.credentialKeyFingerprint,
    })
    .from(workers)
    .where(eq(workers.id, workerId));

  if (!row?.pem || !row.fingerprint) return null;
  return { publicKeyPem: row.pem, fingerprint: row.fingerprint };
}

/** Record the key a worker published in Hello, noticing when it has re-keyed. */
export async function recordCredentialKey(
  db: Database,
  workerId: string,
  publicKeyPem: string,
): Promise<{ changed: boolean; fingerprint: string }> {
  let fingerprint: string;
  try {
    fingerprint = fingerprintPublicKey(publicKeyPem);
  } catch (err) {
    throw new WorkerConfigError(
      400,
      'BadKey',
      `The worker published an unreadable public key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const [existing] = await db
    .select({ fingerprint: workers.credentialKeyFingerprint })
    .from(workers)
    .where(eq(workers.id, workerId));

  const changed = existing?.fingerprint !== undefined && existing.fingerprint !== fingerprint;

  await db
    .update(workers)
    .set({ credentialPublicKeyPem: publicKeyPem, credentialKeyFingerprint: fingerprint })
    .where(eq(workers.id, workerId));

  if (changed) {
    // Every stored ciphertext is now unopenable. Say so in the record rather
    // than letting the worker fail to decrypt and look like a bad password.
    await db
      .update(workerInstanceConfigs)
      .set({
        status: 'awaiting_credentials',
        statusDetail:
          'The worker generated a new key, so the stored credential can no longer be decrypted. Enter it again.',
        statusAt: new Date(),
      })
      .where(
        and(
          eq(workerInstanceConfigs.workerId, workerId),
          eq(workerInstanceConfigs.authMode, 'sql'),
        ),
      );
  }

  return { changed, fingerprint };
}

export interface InstanceConfigView {
  id: string;
  workerId: string;
  instanceName: string;
  serverAddress: string;
  authMode: SqlAuthMode;
  loginName: string | null;
  /** Whether a credential is stored — never the credential, nor its length. */
  hasCredential: boolean;
  credentialUpdatedAt: Date | null;
  encryptTls: boolean;
  trustServerCertificate: boolean;
  environmentTag: string | null;
  status: ConfigStatus;
  statusDetail: string | null;
  statusAt: Date | null;
}

export async function listInstanceConfigs(
  db: Database,
  workerId: string,
): Promise<InstanceConfigView[]> {
  const rows = await db
    .select()
    .from(workerInstanceConfigs)
    .where(eq(workerInstanceConfigs.workerId, workerId))
    .orderBy(asc(workerInstanceConfigs.instanceName));

  // The ciphertext is deliberately not in the projection. It is useless without
  // the worker's private key, but there is no reason for it to travel to a
  // browser, so it does not.
  return rows.map((r) => ({
    id: r.id,
    workerId: r.workerId,
    instanceName: r.instanceName,
    serverAddress: r.serverAddress,
    authMode: r.authMode,
    loginName: r.loginName,
    hasCredential: r.credentialCiphertext !== null,
    credentialUpdatedAt: r.credentialUpdatedAt,
    encryptTls: r.encryptTls,
    trustServerCertificate: r.trustServerCertificate,
    environmentTag: r.environmentTag,
    status: r.status,
    statusDetail: r.statusDetail,
    statusAt: r.statusAt,
  }));
}

export interface UpsertInstanceConfigInput {
  workerId: string;
  instanceName: string;
  serverAddress: string;
  authMode: SqlAuthMode;
  loginName?: string | null;
  /** Base64 RSA-OAEP ciphertext from the browser. Omit to keep what is stored. */
  credentialCiphertext?: string | null;
  /** Fingerprint the browser encrypted to, checked against the current key. */
  credentialKeyFingerprint?: string | null;
  encryptTls?: boolean;
  trustServerCertificate?: boolean;
  environmentTag?: string | null;
  actorId: string | null;
}

/** Ciphertext from a 4096-bit RSA key is 512 bytes; base64 of that is 684. */
const MAX_CIPHERTEXT_BASE64 = 4096;

export async function upsertInstanceConfig(
  db: Database,
  input: UpsertInstanceConfigInput,
): Promise<InstanceConfigView> {
  const key = await getCredentialKey(db, input.workerId);

  if (input.authMode === 'sql' && !input.loginName) {
    throw new WorkerConfigError(400, 'MissingLogin', 'SQL authentication needs a login name.');
  }

  if (input.credentialCiphertext) {
    if (!key) {
      throw new WorkerConfigError(
        409,
        'NoCredentialKey',
        'This worker has not published an encryption key yet. Wait for it to connect, then set the credential.',
      );
    }
    if (input.credentialKeyFingerprint !== key.fingerprint) {
      // Almost always a stale form: the worker re-keyed while it was open.
      // Storing it anyway would produce ciphertext nothing can read.
      throw new WorkerConfigError(
        409,
        'KeyChanged',
        'The worker changed its encryption key while you were filling this in. Reload and enter the credential again.',
      );
    }
    if (input.credentialCiphertext.length > MAX_CIPHERTEXT_BASE64) {
      throw new WorkerConfigError(400, 'CiphertextTooLarge', 'That credential blob is too large.');
    }
  }

  const now = new Date();
  const hasNewCredential = Boolean(input.credentialCiphertext);
  const integrated = input.authMode === 'integrated';

  const shared = {
    serverAddress: input.serverAddress,
    authMode: input.authMode,
    loginName: integrated ? null : (input.loginName ?? null),
    encryptTls: input.encryptTls ?? true,
    trustServerCertificate: input.trustServerCertificate ?? false,
    environmentTag: input.environmentTag ?? null,
  };

  // Integrated auth clears any stored ciphertext: leaving a password behind for
  // a config that no longer uses one is a secret nobody is tracking.
  const credential = integrated
    ? {
        credentialCiphertext: null,
        credentialKeyFingerprint: null,
        credentialUpdatedAt: null,
        credentialUpdatedBy: null,
      }
    : hasNewCredential
      ? {
          credentialCiphertext: input.credentialCiphertext!,
          credentialKeyFingerprint: input.credentialKeyFingerprint!,
          credentialUpdatedAt: now,
          credentialUpdatedBy: input.actorId,
        }
      : {};

  const [row] = await db
    .insert(workerInstanceConfigs)
    .values({
      workerId: input.workerId,
      instanceName: input.instanceName,
      ...shared,
      ...credential,
      status: integrated || hasNewCredential ? 'pending' : 'awaiting_credentials',
      statusDetail: null,
      statusAt: now,
      createdBy: input.actorId,
    })
    .onConflictDoUpdate({
      target: [workerInstanceConfigs.workerId, workerInstanceConfigs.instanceName],
      set: {
        ...shared,
        ...credential,
        ...(integrated || hasNewCredential
          ? { status: 'pending' as const, statusDetail: null, statusAt: now }
          : {}),
      },
    })
    .returning({ id: workerInstanceConfigs.id });

  if (!row) throw new WorkerConfigError(500, 'Internal', 'Failed to save the configuration.');

  // Configuring an instance again un-detaches it, so its existing history and
  // version timeline come back with it rather than starting over.
  await db
    .update(instances)
    .set({ detachedAt: null })
    .where(
      and(
        eq(instances.workerId, input.workerId),
        eq(instances.instanceName, input.instanceName),
      ),
    );

  const configs = await listInstanceConfigs(db, input.workerId);
  const saved = configs.find((c) => c.id === row.id);
  if (!saved) throw new WorkerConfigError(500, 'Internal', 'Failed to read back the configuration.');
  return saved;
}

export async function deleteInstanceConfig(db: Database, configId: string): Promise<string | null> {
  const [row] = await db
    .delete(workerInstanceConfigs)
    .where(eq(workerInstanceConfigs.id, configId))
    .returning({
      workerId: workerInstanceConfigs.workerId,
      instanceName: workerInstanceConfigs.instanceName,
    });
  if (!row) return null;

  // Mark the mirrored instance detached rather than leaving it in the estate
  // view reporting whatever it last said. Not a delete: its run history and
  // version timeline are the point of the product, and losing them to a
  // one-click Remove would be a nasty surprise.
  await db
    .update(instances)
    .set({ detachedAt: new Date() })
    .where(
      and(eq(instances.workerId, row.workerId), eq(instances.instanceName, row.instanceName)),
    );

  return row.workerId;
}

/**
 * The set to send a worker: everything configured for it, ciphertext included.
 *
 * Configs still awaiting a credential are sent too. The worker needs to know
 * they exist so it can report the instance as unconfigured rather than the
 * dashboard guessing at what the worker has heard about.
 */
export async function buildInstanceConfigSet(db: Database, workerId: string) {
  const rows = await db
    .select()
    .from(workerInstanceConfigs)
    .where(eq(workerInstanceConfigs.workerId, workerId))
    .orderBy(asc(workerInstanceConfigs.instanceName));

  return rows.map((r) => ({
    instanceName: r.instanceName,
    serverAddress: r.serverAddress,
    authMode: r.authMode,
    loginName: r.loginName ?? '',
    credentialCiphertext: r.credentialCiphertext ?? '',
    credentialKeyFingerprint: r.credentialKeyFingerprint ?? '',
    encryptTls: r.encryptTls,
    trustServerCertificate: r.trustServerCertificate,
    environmentTag: r.environmentTag ?? '',
  }));
}

/** Push the current set to a connected worker. No-op when it is offline. */
export async function pushInstanceConfigs(
  db: Database,
  registry: WorkerRegistry,
  workerId: string,
): Promise<boolean> {
  const live = registry.get(workerId);
  if (!live) return false;

  const configs = await buildInstanceConfigSet(db, workerId);
  live.send({ msg: { $case: 'instanceConfigs', instanceConfigs: { configs } } });
  return true;
}

/** Record what the worker made of a configuration we sent it. */
export async function recordInstanceConfigStatus(
  db: Database,
  workerId: string,
  results: Array<{ instanceName: string; status: string; detail: string }>,
): Promise<void> {
  const now = new Date();
  for (const result of results) {
    await db
      .update(workerInstanceConfigs)
      .set({
        status: toConfigStatus(result.status),
        statusDetail: result.detail || null,
        statusAt: now,
      })
      .where(
        and(
          eq(workerInstanceConfigs.workerId, workerId),
          eq(workerInstanceConfigs.instanceName, result.instanceName),
        ),
      );
  }
}

/** An unrecognised status from a newer worker must not become 'connected'. */
function toConfigStatus(value: string): ConfigStatus {
  switch (value) {
    case 'connected':
    case 'auth_failed':
    case 'unreachable':
    case 'decrypt_failed':
    case 'awaiting_credentials':
      return value;
    default:
      return 'pending';
  }
}

/**
 * Workers with nothing to monitor yet.
 *
 * The dashboard leads with these: a worker that enrolled ninety seconds ago and
 * is waiting to be told what to look at is the single most actionable thing on
 * the screen, and it is invisible in a list sorted by host name.
 */
export async function listWorkersAwaitingSetup(db: Database) {
  const rows = await db
    .select({
      workerId: workers.id,
      hostName: workers.hostName,
      version: workers.version,
      createdAt: workers.createdAt,
      lastSeenAt: workers.lastSeenAt,
      hasCredentialKey: workers.credentialKeyFingerprint,
      configuredInstances: workerInstanceConfigs.id,
      liveInstances: instances.id,
    })
    .from(workers)
    .leftJoin(workerInstanceConfigs, eq(workerInstanceConfigs.workerId, workers.id))
    .leftJoin(instances, eq(instances.workerId, workers.id))
    .orderBy(asc(workers.createdAt));

  const byWorker = new Map<
    string,
    {
      workerId: string;
      hostName: string;
      version: string | null;
      createdAt: Date;
      lastSeenAt: Date | null;
      hasCredentialKey: boolean;
      configuredInstances: number;
      liveInstances: number;
    }
  >();

  for (const row of rows) {
    let entry = byWorker.get(row.workerId);
    if (!entry) {
      entry = {
        workerId: row.workerId,
        hostName: row.hostName,
        version: row.version,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        hasCredentialKey: row.hasCredentialKey !== null,
        configuredInstances: 0,
        liveInstances: 0,
      };
      byWorker.set(row.workerId, entry);
    }
    if (row.configuredInstances) entry.configuredInstances += 1;
    if (row.liveInstances) entry.liveInstances += 1;
  }

  // The join multiplies rows when a worker has both configs and instances, so
  // the counts above are inflated; recount distinctly.
  for (const entry of byWorker.values()) {
    const configs = new Set(
      rows.filter((r) => r.workerId === entry.workerId && r.configuredInstances).map((r) => r.configuredInstances),
    );
    const live = new Set(
      rows.filter((r) => r.workerId === entry.workerId && r.liveInstances).map((r) => r.liveInstances),
    );
    entry.configuredInstances = configs.size;
    entry.liveInstances = live.size;
  }

  return [...byWorker.values()].filter((w) => w.liveInstances === 0);
}
