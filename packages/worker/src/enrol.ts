import * as grpc from '@grpc/grpc-js';
import { writeSecretFile } from './secret-file.js';
import { generateCsr } from './csr.js';
import { EnrolmentClient, type EnrolResponse } from '@remote-sql-agent/protocol';
import { loadWorkerConfig, type WorkerConfig } from './config.js';
import { buildChannelCredentials, writeWorkerKey, acquireEntraToken } from './credentials.js';
import { loadOrCreateCredentialKey } from './credential-key.js';
import { WORKER_VERSION } from './version.js';

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
        workerVersion: WORKER_VERSION,
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
      // The mode is chosen twice — once when an administrator mints the token,
      // once in worker.yaml — and nothing until here compares them. A token
      // minted for `token` mode makes the server ignore the CSR and return a
      // worker key, so without this the installer wrote an empty file to
      // clientCertPath and the mismatch surfaced later as an unexplained
      // authentication failure against a certificate that was never issued.
      if (!response.certificatePem) {
        throw new Error(
          'This worker is configured for mTLS but the control plane issued no certificate, ' +
            'which means the enrolment token was minted for a different auth mode.\n' +
            'Either mint a new token with mode "mtls" (Administration > Workers), or set ' +
            'controlPlane.auth.mode in worker.yaml to the mode the token was issued for.',
        );
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
  // See secret-file.ts. This writes the mTLS private key, among other things.
  writeSecretFile(path, contents, mode);
}

export type { WorkerConfig };
