import * as grpc from '@grpc/grpc-js';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { EnrolmentClient, type EnrolResponse } from '@remote-sql-agent/protocol';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { buildChannelCredentials, writeWorkerKey, acquireEntraToken } from './credentials.js';
import { loadOrCreateCredentialKey } from './credential-key.js';

/**
 * One-time enrolment (§6.2).
 *
 * Run once per host, by the installer or by hand:
 *
 *   rsagent enrol --config worker.yaml --token rsen_...
 *
 * Exchanges a single-use enrolment token for a durable credential. The private
 * key in mTLS mode is generated here and never leaves the host — only the CSR
 * is sent.
 */

export interface EnrolOptions {
  configPath: string;
  token: string;
}

export async function enrol(options: EnrolOptions): Promise<void> {
  const config = loadWorkerConfig(options.configPath);
  const mode = config.controlPlane.auth.mode;

  const client = new EnrolmentClient(
    config.controlPlane.address,
    buildChannelCredentials(config),
  );

  let csrPem = '';
  let privateKeyPem = '';
  if (mode === 'mtls') {
    ({ csrPem, privateKeyPem } = generateCsr(config.hostName));
  }

  const metadata = new grpc.Metadata();
  if (mode === 'entra') {
    const audience = config.controlPlane.auth.audience;
    if (!audience) {
      throw new Error('controlPlane.auth.audience must be set to enrol with Entra.');
    }
    metadata.set(
      'authorization',
      `Bearer ${await acquireEntraToken(audience, config.controlPlane.auth.clientId)}`,
    );
  }

  const response = await new Promise<EnrolResponse>((resolve, reject) => {
    client.enrol(
      {
        enrolmentToken: options.token,
        hostName: config.hostName,
        workerVersion: '0.1.0',
        csrPem,
      },
      metadata,
      (err, value) => (err ? reject(err) : resolve(value)),
    );
  });

  switch (mode) {
    case 'token': {
      const keyFile = config.controlPlane.auth.keyFile;
      if (!keyFile) throw new Error('controlPlane.auth.keyFile must be set to enrol in token mode.');
      if (!response.workerKey) {
        throw new Error(
          'The control plane did not return a worker key. Check that the enrolment token was issued for token mode.',
        );
      }
      writeWorkerKey(keyFile, response.workerKey);
      console.log(`Enrolled as worker ${response.workerId}.`);
      console.log(`Worker key written to ${keyFile} (mode 0600).`);
      break;
    }

    case 'mtls': {
      const { clientCertPath, clientKeyPath, caCertPath } = config.controlPlane.tls;
      if (!clientCertPath || !clientKeyPath) {
        throw new Error('controlPlane.tls.clientCertPath and clientKeyPath must be set for mTLS.');
      }
      writeSecret(clientKeyPath, privateKeyPem);
      writeSecret(clientCertPath, response.certificatePem);
      if (caCertPath && response.caCertificatePem) {
        writeSecret(caCertPath, response.caCertificatePem, 0o644);
      }
      console.log(`Enrolled as worker ${response.workerId}.`);
      console.log(`Client certificate written to ${clientCertPath}.`);
      break;
    }

    case 'entra':
      console.log(`Enrolled as worker ${response.workerId} using this host's managed identity.`);
      console.log('No secret was stored: authentication uses a fresh token on every connection.');
      break;
  }

  // Generated here rather than on first connect so an admin who enrols a worker
  // and immediately opens the dashboard can configure it, instead of being told
  // to come back once it has published a key.
  const credentialKey = loadOrCreateCredentialKey(config.credentialKeyFile);
  console.log(`Credential key ready at ${config.credentialKeyFile} (mode 0600).`);
  console.log(`  fingerprint ${credentialKey.fingerprint.slice(0, 32)}…`);
  console.log(
    'SQL credentials entered in the dashboard are encrypted to this key in the browser,\n' +
      'so the control plane stores a credential it cannot itself read.',
  );

  if (config.instances.length === 0) {
    console.log('\nNext: open the dashboard and tell this worker which SQL instances to monitor.');
  }

  client.close();
}

function writeSecret(path: string, contents: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { encoding: 'utf8', mode });
  try {
    chmodSync(path, mode);
  } catch {
    // Windows: no POSIX modes. DPAPI protection is applied by the installer.
  }
}

/**
 * Generate a keypair and a PKCS#10 CSR.
 *
 * Hand-built rather than pulled from a library: the worker package should not
 * take a certificate-authoring dependency just to make one request, and the
 * control plane ignores everything in the CSR except the public key and the
 * self-signature anyway.
 */
function generateCsr(commonName: string): { csrPem: string; privateKeyPem: string } {
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

export type { WorkerConfig };
