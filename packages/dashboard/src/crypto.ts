/**
 * Client-side credential encryption.
 *
 * A SQL password typed into the dashboard is encrypted *here*, in the browser,
 * to the public key the target worker generated on its own SQL host. The
 * control plane receives and stores ciphertext it has no key for, so a password
 * for fifty instances never exists in one place that every network segment can
 * reach. See docs/security.md and packages/worker/src/credential-key.ts.
 *
 * Everything in this file must stay symmetric with `decryptCredential` on the
 * worker: RSA-OAEP with SHA-256 over UTF-8 `{"password":"..."}`.
 */

export class CredentialEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialEncryptionError';
  }
}

/**
 * WebCrypto exists only in a secure context.
 *
 * Worth checking explicitly: on plain HTTP to anything other than localhost,
 * `crypto.subtle` is simply undefined, and the failure would otherwise read as
 * a bug in the form rather than as the deployment issue it is.
 */
export function canEncryptCredentials(): boolean {
  return typeof globalThis.crypto?.subtle?.importKey === 'function';
}

/**
 * Smallest RSA modulus this will encrypt a SQL credential to.
 *
 * The worker generates 4096-bit keys, so nothing legitimate is near this. It
 * exists because the key comes from the control plane and there is nothing in a
 * browser to pin it against — a floor removes the cheapest substitution, which
 * is a small factorable key that `importKey` would otherwise accept in silence.
 */
export const MINIMUM_MODULUS_BITS = 2048;

export const INSECURE_CONTEXT_MESSAGE =
  'Your browser will not encrypt credentials over an insecure connection. ' +
  'Serve the dashboard over HTTPS, then enter the credential. ' +
  'The password is encrypted in your browser so the control plane never holds a usable SQL login — ' +
  'sending it in clear would defeat that.';

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/u, '')
    .replace(/-----END [^-]+-----/u, '')
    .replace(/\s+/gu, '');

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  // Chunked: spreading a 512-byte array is fine, but this stays correct if the
  // key size ever grows past the argument limit.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/**
 * Encrypt a SQL password to a worker's public key.
 *
 * Returns base64 ciphertext to post to the control plane. The plaintext exists
 * only as a local in this function and in the form state that called it.
 */
export async function encryptCredential(
  publicKeyPem: string,
  password: string,
): Promise<string> {
  if (!canEncryptCredentials()) {
    throw new CredentialEncryptionError(INSECURE_CONTEXT_MESSAGE);
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'spki',
      pemToArrayBuffer(publicKeyPem),
      { name: 'RSA-OAEP', hash: 'SHA-256' },
      false,
      ['encrypt'],
    );
  } catch (err) {
    throw new CredentialEncryptionError(
      `The worker published a key this browser cannot use: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The key arrives from the control plane, which by design cannot read what is
  // encrypted to it — so a control plane that substituted a key of its own
  // could. Pinning is not available in a browser, but a *size* floor is, and it
  // removes the cheapest version of the attack: `importKey` happily accepts a
  // 1024-bit modulus, which is factorable and would have been used silently.
  const modulusBits = (key.algorithm as RsaHashedKeyAlgorithm).modulusLength;
  if (modulusBits < MINIMUM_MODULUS_BITS) {
    throw new CredentialEncryptionError(
      `That worker published a ${modulusBits}-bit key, and this will not encrypt a SQL ` +
        `credential to anything below ${MINIMUM_MODULUS_BITS} bits. The worker generates ` +
        '4096-bit keys, so a key this small did not come from one.',
    );
  }

  const plaintext = new TextEncoder().encode(JSON.stringify({ password }));

  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, plaintext);
    return toBase64(ciphertext);
  } catch (err) {
    // RSA-OAEP has a hard size limit; a very long password is the only
    // realistic way to hit it, and the generic DOMException does not say so.
    throw new CredentialEncryptionError(
      `Could not encrypt that credential${plaintext.length > 400 ? ' — it is too long' : ''}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
