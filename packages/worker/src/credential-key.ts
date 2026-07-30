import {
  constants,
  createHash,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
} from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The key SQL credentials are encrypted to.
 *
 * This is the mechanism behind the promise that the control plane never holds a
 * usable SQL login. The private half is generated here, on the SQL host, and
 * never leaves it. Only the public half is published, and an operator entering
 * a password in the dashboard has it encrypted *in their browser* to that key.
 * What reaches the control plane, and what sits in Postgres, is ciphertext only
 * this host can open.
 *
 * The honest limit: whatever can read this file can read this host's SQL
 * password. Nothing can change that — a worker has to be able to log in — which
 * is why integrated authentication, where there is no password at all, is the
 * default the installer offers first.
 */

/** 4096-bit RSA-OAEP carries ~446 bytes, comfortably more than a credential. */
const KEY_BITS = 4096;

export interface CredentialKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  /** sha256 over the DER SPKI, hex. Matches what the control plane computes. */
  fingerprint: string;
}

export function fingerprintPublicKey(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex');
}

/**
 * Load the host's credential key, generating it on first use.
 *
 * Generated at enrolment so the public key is ready before the worker first
 * connects — an admin who enrols a worker and immediately opens the dashboard
 * should be able to configure it, not be told to wait.
 */
export function loadOrCreateCredentialKey(path: string): CredentialKeyPair {
  // Deliberately no existsSync-then-act. Asking whether the key is there and
  // then creating it are two operations, and between them anything can happen
  // to the path — most damagingly, a symlink pointing somewhere the attacker
  // can read, which the create would then follow and hand them the private
  // half of the key protecting every SQL credential on this host.
  //
  // So both directions act first and interpret the error afterwards: the read
  // is attempted outright, and the write uses 'wx' (O_CREAT | O_EXCL), which
  // the kernel refuses if anything already exists at the path, symlink or not.
  const existing = readExistingKey(path);
  if (existing) return existing;

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: KEY_BITS,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  mkdirSync(dirname(path), { recursive: true });
  try {
    // Created 0600 by the same call that creates it, so there is no window in
    // which the key exists at the default umask. On Windows the mode is
    // advisory and the installer restricts the directory ACL instead — see
    // deploy/worker/install.ps1.
    writeFileSync(path, privateKey, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;

    // Someone created the key between our read and our write — a second worker
    // process starting alongside this one. Theirs is the one on disk, so it is
    // the one this host will be able to decrypt with. Discard the key we just
    // generated rather than overwriting and stranding every credential already
    // encrypted to the winner.
    const winner = readExistingKey(path);
    if (!winner) throw error;
    return winner;
  }

  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort: some filesystems (and Windows) do not implement chmod.
  }

  return {
    privateKeyPem: privateKey,
    publicKeyPem: publicKey,
    fingerprint: fingerprintPublicKey(publicKey),
  };
}

function readExistingKey(path: string): CredentialKeyPair | null {
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }

  const publicKeyPem = createPublicKey(privateKeyPem)
    .export({ type: 'spki', format: 'pem' })
    .toString();
  return { privateKeyPem, publicKeyPem, fingerprint: fingerprintPublicKey(publicKeyPem) };
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export class CredentialDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialDecryptError';
  }
}

export interface DecryptedCredential {
  password: string;
}

/**
 * Open a credential blob from the control plane.
 *
 * A fingerprint mismatch is reported as its own failure rather than left to
 * surface as a decryption error: "the stored credential was encrypted to a key
 * this worker no longer has" and "the password is wrong" need completely
 * different responses from an operator, and they must not look alike.
 */
export function decryptCredential(
  ciphertextBase64: string,
  expectedFingerprint: string,
  key: CredentialKeyPair,
): DecryptedCredential {
  if (expectedFingerprint && expectedFingerprint !== key.fingerprint) {
    throw new CredentialDecryptError(
      'The stored credential was encrypted to a different key than this worker now holds. Enter it again in the dashboard.',
    );
  }

  let plaintext: Buffer;
  try {
    plaintext = privateDecrypt(
      {
        key: key.privateKeyPem,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(ciphertextBase64, 'base64'),
    );
  } catch (err) {
    throw new CredentialDecryptError(
      `The stored credential could not be decrypted: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new CredentialDecryptError('The decrypted credential was not in the expected format.');
  }

  const password = (parsed as { password?: unknown }).password;
  if (typeof password !== 'string' || password.length === 0) {
    throw new CredentialDecryptError('The decrypted credential contained no password.');
  }

  return { password };
}
