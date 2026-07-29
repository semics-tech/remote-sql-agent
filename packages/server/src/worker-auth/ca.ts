import forge from 'node-forge';
import { eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { serverKeys } from '../db/schema.js';

/**
 * Minimal embedded certificate authority for worker mTLS (§6.2).
 *
 * Only used when a site opts into `mtls` worker auth. It is deliberately small:
 * issue client certificates, nothing else. There is no OCSP responder and no
 * CRL distribution point — revocation is checked against the database on every
 * connection, which is both simpler and more immediate than a published CRL.
 */

const CA_KEY_ID = 'worker-ca';
const CA_COMMON_NAME = 'Remote SQL Agent Worker CA';

export interface CaMaterial {
  privateKeyPem: string;
  certificatePem: string;
}

export async function loadOrCreateCa(db: Database, validityYears = 10): Promise<CaMaterial> {
  const [existing] = await db.select().from(serverKeys).where(eq(serverKeys.id, CA_KEY_ID));
  if (existing?.certificatePem) {
    return { privateKeyPem: existing.privateKeyPem, certificatePem: existing.certificatePem };
  }

  const keys = forge.pki.rsa.generateKeyPair({ bits: 3072 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(urandomLen))}`;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + validityYears);

  const attrs = [{ name: 'commonName', value: CA_COMMON_NAME }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const material: CaMaterial = {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
  };

  await db
    .insert(serverKeys)
    .values({
      id: CA_KEY_ID,
      privateKeyPem: material.privateKeyPem,
      publicKeyPem: forge.pki.publicKeyToPem(keys.publicKey),
      certificatePem: material.certificatePem,
    })
    .onConflictDoNothing();

  // Re-read: a concurrent boot may have won the insert, and two nodes must not
  // end up trusting different CAs.
  const [row] = await db.select().from(serverKeys).where(eq(serverKeys.id, CA_KEY_ID));
  if (!row?.certificatePem) throw new Error('Failed to persist the worker CA.');
  return { privateKeyPem: row.privateKeyPem, certificatePem: row.certificatePem };
}

const urandomLen = 16;

export interface IssuedCertificate {
  certificatePem: string;
  serial: string;
  fingerprint: string;
  notAfter: Date;
}

/**
 * Issue a client certificate from a worker-supplied CSR.
 *
 * The CSR's subject is ignored except for verification: the issued certificate's
 * common name is set from the worker identity the control plane already
 * established during enrolment. Trusting the CSR's own subject would let a
 * worker name itself anything it liked.
 */
export function issueClientCertificate(
  ca: CaMaterial,
  csrPem: string,
  workerId: string,
  hostName: string,
  validityDays: number,
): IssuedCertificate {
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  if (!csr.verify()) {
    throw new Error('Certificate signing request failed its own signature check.');
  }
  if (!csr.publicKey) {
    throw new Error('Certificate signing request carries no public key.');
  }

  const caCert = forge.pki.certificateFromPem(ca.certificatePem);
  const caKey = forge.pki.privateKeyFromPem(ca.privateKeyPem);

  const cert = forge.pki.createCertificate();
  cert.publicKey = csr.publicKey;
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(urandomLen))}`;
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + validityDays);

  cert.setSubject([
    { name: 'commonName', value: workerId },
    { name: 'organizationalUnitName', value: hostName },
  ]);
  cert.setIssuer(caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', clientAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostName }] },
  ]);
  cert.sign(caKey, forge.md.sha256.create());

  const certificatePem = forge.pki.certificateToPem(cert);
  return {
    certificatePem,
    serial: cert.serialNumber,
    fingerprint: fingerprintOf(certificatePem),
    notAfter: cert.validity.notAfter,
  };
}

/** SHA-256 fingerprint of a certificate, lowercase hex, colon-free. */
export function fingerprintOf(certificatePem: string): string {
  const cert = forge.pki.certificateFromPem(certificatePem);
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha256.create();
  md.update(der);
  return md.digest().toHex();
}
