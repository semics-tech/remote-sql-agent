import { createSign, generateKeyPairSync } from 'node:crypto';

/**
 * PKCS#10 certificate signing requests.
 *
 * Shared by enrolment and by renewal (`cert-renewal.ts`), which must produce
 * byte-identical requests: a renewal that the control plane's CSR parser handled
 * differently from an enrolment would only be discovered at renewal time, on a
 * worker that is about to lose its certificate.
 *
 * Hand-built rather than pulled from a library: the worker package should not
 * take a certificate-authoring dependency just to make one request, and the
 * control plane ignores everything in the CSR except the public key and the
 * self-signature anyway.
 */

export interface GeneratedCsr {
  csrPem: string;
  privateKeyPem: string;
}

export function generateCsr(commonName: string): GeneratedCsr {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 3072,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const subject = derSequence(
    derSet(
      derSequence(
        Buffer.concat([Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]), derUtf8(commonName)]),
      ),
    ),
  );

  const certificationRequestInfo = derSequence(
    Buffer.concat([
      Buffer.from([0x02, 0x01, 0x00]), // version 0
      subject,
      publicKey as unknown as Buffer,
      Buffer.from([0xa0, 0x00]), // empty attributes
    ]),
  );

  const signer = createSign('RSA-SHA256');
  signer.update(certificationRequestInfo);
  signer.end();
  const signature = signer.sign(privateKey);

  // sha256WithRSAEncryption
  const algorithm = Buffer.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b, 0x05, 0x00,
  ]);

  const csr = derSequence(
    Buffer.concat([certificationRequestInfo, algorithm, derBitString(signature)]),
  );

  const base64 = csr.toString('base64').replace(/(.{64})/gu, '$1\n');
  return {
    csrPem: `-----BEGIN CERTIFICATE REQUEST-----\n${base64}\n-----END CERTIFICATE REQUEST-----\n`,
    privateKeyPem: privateKey as unknown as string,
  };
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag: number, contents: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(contents.length), contents]);
}

const derSequence = (contents: Buffer): Buffer => derWrap(0x30, contents);
const derSet = (contents: Buffer): Buffer => derWrap(0x31, contents);
const derUtf8 = (value: string): Buffer => derWrap(0x0c, Buffer.from(value, 'utf8'));
const derBitString = (contents: Buffer): Buffer =>
  derWrap(0x03, Buffer.concat([Buffer.from([0x00]), contents]));
