import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { type CaMaterial, issueClientCertificate } from '../src/worker-auth/ca.js';

// CSR signature checks without a database: the CA is built in memory, with
// node:crypto generating the keys because forge's pure-JS RSA keygen is slow.

function rsaKeys(): { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    privateKey: forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey,
    publicKey: forge.pki.publicKeyFromPem(publicKey) as forge.pki.rsa.PublicKey,
  };
}

function testCa(): CaMaterial {
  const keys = rsaKeys();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86_400_000);
  const attrs = [{ name: 'commonName', value: 'Test CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
  };
}

function csrPem(md: forge.md.MessageDigest): string {
  const keys = rsaKeys();
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: 'commonName', value: 'worker' }]);
  csr.sign(keys.privateKey, md);
  return forge.pki.certificationRequestToPem(csr);
}

/** Flip one bit near the end of the PEM body, which lands in the signature. */
function tamper(pem: string): string {
  const body = pem.replace(/-----[^-]+-----/gu, '').replace(/\s/gu, '');
  const der = Buffer.from(body, 'base64');
  const at = der.length - 5;
  der[at] = (der[at] ?? 0) ^ 0x01;
  const base64 = der.toString('base64').replace(/(.{64})/gu, '$1\n');
  return `-----BEGIN CERTIFICATE REQUEST-----\n${base64}\n-----END CERTIFICATE REQUEST-----\n`;
}

describe('issueClientCertificate CSR signature check', () => {
  const ca = testCa();

  it('issues for a sha256WithRSAEncryption request', () => {
    const issued = issueClientCertificate(ca, csrPem(forge.md.sha256.create()), 'w-1', 'sql1', 30);
    expect(issued.certificatePem).toContain('BEGIN CERTIFICATE');
  });

  it('rejects a request whose signature has been altered', () => {
    expect(() =>
      issueClientCertificate(ca, tamper(csrPem(forge.md.sha256.create())), 'w-1', 'sql1', 30),
    ).toThrow(/signature check/u);
  });

  it('rejects any signature algorithm other than sha256WithRSAEncryption', () => {
    expect(() =>
      issueClientCertificate(ca, csrPem(forge.md.sha1.create()), 'w-1', 'sql1', 30),
    ).toThrow(/signature check/u);
  });
});
