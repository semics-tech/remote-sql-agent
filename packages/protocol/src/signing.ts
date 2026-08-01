import {
  createHash,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { canonicalJsonStringify } from './canonical.js';
import type { Command } from './gen/rsagent/v1/worker.js';

/**
 * Per-command signatures (§6.4).
 *
 * The channel is already mTLS, so this is defence in depth with two specific
 * jobs: it makes every command independently auditable after the fact (the
 * signature is retained alongside the audit row, so "did the control plane
 * really issue this?" is answerable months later), and it means a compromised
 * TLS-terminating proxy in front of the control plane cannot forge commands.
 *
 * Signed bytes are a canonical, unambiguous encoding of the fields that decide
 * what the command *does*. Length-prefixing each field prevents a splicing
 * attack where field boundaries are shifted to produce the same byte string
 * from a different command (e.g. id="a", type="bc" vs id="ab", type="c").
 */

export const SIGNING_ALGORITHM = 'RSA-SHA256';

/**
 * A stable identifier for a command signing key: sha256 of its SPKI DER, hex.
 *
 * The DER rather than the PEM, so line endings, header wording and wrapping
 * cannot change the answer for the same key. This is what a worker pins in
 * `worker.yaml` and what the control plane prints for an operator to copy, and
 * the two have to agree exactly — which is why there is one implementation of
 * it rather than one on each side.
 *
 * Matches `openssl pkey -pubin -outform DER | openssl dgst -sha256`.
 */
export function signingKeyFingerprint(publicKeyPem: string): string {
  if (!publicKeyPem) return '';
  try {
    const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
    return createHash('sha256').update(der).digest('hex');
  } catch {
    // An unparseable key can never match a pin, and returning a sentinel keeps
    // the caller's comparison total rather than making it handle a throw.
    return '';
  }
}

export interface CommandSigningKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateCommandSigningKeyPair(): CommandSigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

function lengthPrefixed(parts: string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8');
    const len = Buffer.allocUnsafe(4);
    len.writeUInt32BE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

/** Discriminant of the command's payload oneof, e.g. "toggleJob". */
export function commandKind(command: Command): string {
  return command.payload?.$case ?? 'unknown';
}

/**
 * Hash of the payload, computed over the payload's canonical JSON. Using the
 * decoded payload rather than raw protobuf bytes keeps the signature stable
 * across protobuf encoder differences (field ordering is not guaranteed by the
 * spec, and a re-encode by any intermediary would otherwise break verification).
 */
export function commandPayloadHash(command: Command): string {
  const payload = command.payload;
  if (!payload) return createHash('sha256').update('', 'utf8').digest('hex');
  const inner = (payload as unknown as Record<string, unknown>)[payload.$case];
  return createHash('sha256')
    .update(`${payload.$case}:${canonicalJsonStringify(inner)}`, 'utf8')
    .digest('hex');
}

export function commandSigningBytes(command: Command): Buffer {
  const issuedAt = command.issuedAt
    ? `${command.issuedAt.seconds}.${command.issuedAt.nanos}`
    : '0.0';
  return lengthPrefixed([
    command.id,
    commandKind(command),
    commandPayloadHash(command),
    issuedAt,
    command.instanceName,
  ]);
}

export function signCommand(command: Command, privateKeyPem: string): Buffer {
  const signer = createSign(SIGNING_ALGORITHM);
  signer.update(commandSigningBytes(command));
  signer.end();
  return signer.sign(privateKeyPem);
}

export function verifyCommandSignature(command: Command, publicKeyPem: string): boolean {
  if (!command.signature || command.signature.length === 0) return false;
  const verifier = createVerify(SIGNING_ALGORITHM);
  verifier.update(commandSigningBytes(command));
  verifier.end();
  try {
    return verifier.verify(publicKeyPem, Buffer.from(command.signature));
  } catch {
    return false;
  }
}

/**
 * Replay window. A command whose issued_at is outside this window is rejected
 * even with a valid signature — signatures alone do not prevent a captured
 * command being replayed later. Idempotency records (command UUIDs, stored by
 * the worker) close the gap inside the window.
 */
export const MAX_COMMAND_AGE_MS = 15 * 60 * 1000;
/** Tolerance for the worker's clock running behind the control plane's. */
export const MAX_COMMAND_CLOCK_SKEW_MS = 60 * 1000;

export function isCommandFresh(issuedAtMs: number, nowMs: number): boolean {
  const age = nowMs - issuedAtMs;
  return age <= MAX_COMMAND_AGE_MS && age >= -MAX_COMMAND_CLOCK_SKEW_MS;
}
