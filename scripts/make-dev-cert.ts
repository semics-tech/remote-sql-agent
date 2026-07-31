/**
 * Generate a self-signed certificate for the worker hub, for a lab.
 *
 * The hub refuses to start without a certificate, and `*.crt` / `*.key` are
 * gitignored — so `deploy/tls/` does not exist in a fresh clone and
 * `docker compose up -d` fails on the bind mount before anything has run. This
 * is the shortest path from clone to a control plane that boots.
 *
 * Not for production, and it does not pretend otherwise: workers will refuse to
 * verify it unless every one of them is given this CA explicitly, which is a
 * worse operational position than using the certificate authority you already
 * have. See docs/deployment.md for the real options.
 *
 *   pnpm dev:cert rsagent.corp.example.com
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.env.RSAGENT_TLS_DIR ?? join(repoRoot, 'deploy', 'tls');

const host = process.argv[2];
if (!host) {
  console.error('Usage: pnpm dev:cert <hostname>\n');
  console.error('The hostname must be the one workers will dial, because that is');
  console.error('what they check the certificate against. "localhost" is fine for a');
  console.error('worker on the same machine.');
  process.exit(1);
}

const certPath = join(outDir, 'server.crt');
const keyPath = join(outDir, 'server.key');

if (existsSync(certPath) || existsSync(keyPath)) {
  console.error(`Refusing to overwrite the certificate already in ${outDir}.`);
  console.error('Delete server.crt and server.key first if you meant to replace it.');
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// subjectAltName, not just the common name: every current TLS client ignores CN
// for host verification, so a cert without a SAN is rejected by the worker with
// an error that says nothing about the real cause.
//
// An IP address has to go in as IP: rather than DNS:, or verification fails for
// a reason that reads like a mismatch.
const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$|:/u.test(host);
const altName = `subjectAltName=${isIpAddress ? 'IP' : 'DNS'}:${host}`;

execFileSync(
  'openssl',
  [
    'req', '-x509',
    '-newkey', 'rsa:2048',
    '-nodes',
    '-days', '365',
    '-keyout', keyPath,
    '-out', certPath,
    '-subj', `/CN=${host}`,
    '-addext', altName,
  ],
  { stdio: 'inherit' },
);

console.log(`
Wrote ${certPath}
      ${keyPath}

  ⚠  Self-signed, and for a lab only.

Workers will not trust it unless each one is given this certificate as its CA:

  --ca-cert /path/to/server.crt        (Linux)
  -CaCertPath C:\\path\\to\\server.crt    (Windows)

For anything real, use a certificate from the CA your estate already trusts.
See docs/deployment.md.
`);
