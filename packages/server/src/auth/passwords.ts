import argon2 from 'argon2';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Password and secret hashing (§6.5).
 *
 * argon2id with parameters at the OWASP recommended floor. These are
 * deliberately not configurable: the failure mode of a tunable cost factor is
 * that somebody tunes it down to make tests fast and it ships that way.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
  // Explicit so TypeScript selects the string-returning overload rather than
  // the raw Buffer one.
  raw: false,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // A malformed hash must read as "wrong password", never as an exception
    // that a caller might mistake for success.
    return false;
  }
}

/** Generate a URL-safe secret with 256 bits of entropy. */
export function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Generate a worker API key with a recognisable prefix.
 *
 * The prefix makes leaked keys greppable in logs and CI output, and lets
 * secret scanners recognise them. The stored `prefix` is the first 8 characters
 * of the random part — enough to identify a key in the dashboard, useless on
 * its own.
 */
export function generateWorkerKey(): { key: string; prefix: string } {
  const secret = generateSecret(32);
  return { key: `rsak_${secret}`, prefix: secret.slice(0, 8) };
}

export function workerKeyPrefix(key: string): string {
  return key.replace(/^rsak_/u, '').slice(0, 8);
}

/**
 * Hash a bearer-style token for storage or lookup.
 *
 * Session and enrolment tokens are high-entropy random values, not
 * user-chosen passwords, so a plain SHA-256 is correct here: there is nothing
 * to brute-force, and we need a deterministic value to index on. Worker API
 * keys use argon2id instead because they are long-lived and worth the extra
 * margin.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison for values already reduced to fixed-length hex. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function hashWorkerKey(key: string): Promise<string> {
  return argon2.hash(key, ARGON2_OPTIONS);
}

export async function verifyWorkerKey(hash: string, key: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, key);
  } catch {
    return false;
  }
}
