import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as grpc from '@grpc/grpc-js';
import type { WorkerConfig } from './config.js';

/**
 * Worker credential storage and presentation.
 *
 * The credential never leaves the host and is never sent to the control plane
 * except as proof of identity on connect. On Windows it should be DPAPI-wrapped;
 * that binding is a packaging concern (M5) and the file is written 0600 in the
 * meantime, which is the correct behaviour on Linux regardless.
 */

export const WORKER_KEY_METADATA = 'x-rsagent-worker-key';

export class CredentialError extends Error {}

export function readWorkerKey(path: string): string {
  if (!existsSync(path)) {
    throw new CredentialError(
      `No worker key found at ${path}.\n` +
        `Enrol this worker first:  rsagent enrol --token <enrolment-token>\n` +
        `Generate a token in the dashboard under Administration > Workers.`,
    );
  }
  const key = readFileSync(path, 'utf8').trim();
  if (!key) throw new CredentialError(`The worker key file at ${path} is empty.`);
  return key;
}

export function writeWorkerKey(path: string, key: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${key}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    // Re-apply explicitly: an existing file keeps its original mode, so the
    // mode passed to writeFileSync alone is not sufficient on a rotation.
    chmodSync(path, 0o600);
  } catch {
    // Windows has no POSIX modes; DPAPI protection is applied by the installer.
  }
}

/**
 * Acquire an Entra access token from the host's managed identity.
 *
 * @azure/identity is imported lazily so that the overwhelming majority of
 * deployments — which use token mode — never load it.
 */
export async function acquireEntraToken(audience: string, clientId?: string): Promise<string> {
  let credential: { getToken: (scope: string) => Promise<{ token: string } | null> };
  try {
    // Indirect specifier on purpose: @azure/identity is an optional peer that
    // only Entra-mode deployments install, and a literal import would make it a
    // hard build-time dependency for everyone.
    const moduleName = '@azure/identity';
    const { DefaultAzureCredential } = (await import(moduleName)) as {
      DefaultAzureCredential: new (options?: {
        managedIdentityClientId?: string;
      }) => typeof credential;
    };
    credential = new DefaultAzureCredential(
      clientId ? { managedIdentityClientId: clientId } : undefined,
    );
  } catch (err) {
    throw new CredentialError(
      'Entra authentication requires the optional @azure/identity package. ' +
        `Install it on this host, or switch controlPlane.auth.mode to "token". (${String(err)})`,
    );
  }

  const scope = audience.endsWith('/.default') ? audience : `${audience}/.default`;
  const token = await credential.getToken(scope);
  if (!token?.token) {
    throw new CredentialError(
      `Could not obtain an Entra token for ${scope}. ` +
        'Check that this host has a managed identity and that it is granted access to the control plane app registration.',
    );
  }
  return token.token;
}

/** Per-call metadata carrying the worker's credential. */
export async function buildCallMetadata(config: WorkerConfig): Promise<grpc.Metadata> {
  const metadata = new grpc.Metadata();
  const auth = config.controlPlane.auth;

  switch (auth.mode) {
    case 'token': {
      if (!auth.keyFile) {
        throw new CredentialError('controlPlane.auth.keyFile must be set when mode is "token".');
      }
      metadata.set(WORKER_KEY_METADATA, readWorkerKey(auth.keyFile));
      break;
    }
    case 'entra': {
      if (!auth.audience) {
        throw new CredentialError('controlPlane.auth.audience must be set when mode is "entra".');
      }
      metadata.set('authorization', `Bearer ${await acquireEntraToken(auth.audience, auth.clientId)}`);
      break;
    }
    case 'mtls':
      // The certificate is presented by the TLS layer; nothing goes in metadata.
      break;
  }

  return metadata;
}

/** Channel credentials for the control plane connection. */
export function buildChannelCredentials(config: WorkerConfig): grpc.ChannelCredentials {
  const tls = config.controlPlane.tls;
  if (!tls.enabled) {
    return grpc.credentials.createInsecure();
  }

  const rootCert = tls.caCertPath ? readFileSync(tls.caCertPath) : null;

  if (config.controlPlane.auth.mode === 'mtls') {
    if (!tls.clientCertPath || !tls.clientKeyPath) {
      throw new CredentialError(
        'mTLS mode requires controlPlane.tls.clientCertPath and clientKeyPath. ' +
          'Enrol this worker to obtain them.',
      );
    }
    return grpc.credentials.createSsl(
      rootCert,
      readFileSync(tls.clientKeyPath),
      readFileSync(tls.clientCertPath),
    );
  }

  return grpc.credentials.createSsl(rootCert);
}
