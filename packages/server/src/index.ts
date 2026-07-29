import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { generateCommandSigningKeyPair } from '@rsagent/protocol';
import { loadConfig, type ServerConfig } from './config.js';
import { createDatabase, type Database } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { serverKeys } from './db/schema.js';
import { createLogger } from './logger.js';
import { createApp } from './api/app.js';
import { createGrpcServer, createServerCredentials } from './hub/hub.js';
import { WorkerRegistry } from './hub/registry.js';
import { pruneRetention } from './domain/ingest.js';
import { AuditExporter } from './domain/audit-export.js';
import { WorkerAuthenticator } from './worker-auth/authenticate.js';
import { loadOrCreateCa } from './worker-auth/ca.js';
import { EntraClient } from './auth/entra.js';
import { ensureBootstrapAdmin } from './auth/users.js';
import { pruneExpiredSessions } from './auth/sessions.js';
import { generateSecret } from './auth/passwords.js';

const COMMAND_SIGNING_KEY_ID = 'command-signing';
const COOKIE_SECRET_KEY_ID = 'cookie-secret';

/**
 * Load a persisted keypair, generating it on first boot. Keeping these in the
 * database rather than env vars means a fresh Compose deployment works with no
 * key ceremony, and sessions survive a restart.
 */
async function loadOrCreateKeyPair(
  db: Database,
  id: string,
): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
  const [existing] = await db.select().from(serverKeys).where(eq(serverKeys.id, id));
  if (existing) {
    return { privateKeyPem: existing.privateKeyPem, publicKeyPem: existing.publicKeyPem };
  }

  const pair = generateCommandSigningKeyPair();
  await db
    .insert(serverKeys)
    .values({ id, privateKeyPem: pair.privateKeyPem, publicKeyPem: pair.publicKeyPem })
    .onConflictDoNothing();

  const [row] = await db.select().from(serverKeys).where(eq(serverKeys.id, id));
  if (!row) throw new Error(`Failed to persist key ${id}`);
  return { privateKeyPem: row.privateKeyPem, publicKeyPem: row.publicKeyPem };
}

async function loadOrCreateCookieSecret(db: Database): Promise<string> {
  const [existing] = await db.select().from(serverKeys).where(eq(serverKeys.id, COOKIE_SECRET_KEY_ID));
  if (existing) return existing.privateKeyPem;

  const secret = generateSecret(32);
  await db
    .insert(serverKeys)
    .values({ id: COOKIE_SECRET_KEY_ID, privateKeyPem: secret, publicKeyPem: '' })
    .onConflictDoNothing();

  const [row] = await db.select().from(serverKeys).where(eq(serverKeys.id, COOKIE_SECRET_KEY_ID));
  return row?.privateKeyPem ?? secret;
}

/**
 * Resolve TLS material for the worker hub.
 *
 * Refuses to start without it unless explicitly overridden: in token mode TLS is
 * the only thing keeping the worker's API key off the wire in clear, so a silent
 * fallback to plaintext would quietly undo the whole credential design.
 */
async function resolveHubTls(
  db: Database,
  config: ServerConfig,
  logger: ReturnType<typeof createLogger>,
) {
  const { tlsCertPath, tlsKeyPath, tlsClientCaPath, requireTls, enabledModes } = config.workerAuth;

  if (!tlsCertPath || !tlsKeyPath) {
    if (requireTls) {
      throw new Error(
        'The worker hub has no TLS certificate. Set RSAGENT_GRPC_TLS_CERT and RSAGENT_GRPC_TLS_KEY.\n' +
          'Without TLS, worker API keys travel in clear text.\n' +
          'For local development only, set RSAGENT_GRPC_REQUIRE_TLS=false.',
      );
    }
    logger.warn(
      'The worker hub is running WITHOUT TLS. Worker credentials will be sent in clear text. ' +
        'This is acceptable only on a trusted local network.',
    );
    return { tlsCert: undefined, tlsKey: undefined, clientCa: undefined };
  }

  let clientCa: Buffer | undefined;
  if (enabledModes.includes('mtls')) {
    if (tlsClientCaPath) {
      clientCa = readFileSync(tlsClientCaPath);
    } else {
      // Use the embedded CA we issue worker certificates from.
      const ca = await loadOrCreateCa(db);
      clientCa = Buffer.from(ca.certificatePem, 'utf8');
    }
  }

  return {
    tlsCert: readFileSync(tlsCertPath),
    tlsKey: readFileSync(tlsKeyPath),
    clientCa,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info('Applying database migrations...');
  await runMigrations(config.databaseUrl);

  const { db, close } = createDatabase(config.databaseUrl);
  const registry = new WorkerRegistry();

  const signingKey = await loadOrCreateKeyPair(db, COMMAND_SIGNING_KEY_ID);
  if (!config.auth.cookieSecret) {
    config.auth.cookieSecret = await loadOrCreateCookieSecret(db);
  }

  await ensureBootstrapAdmin(
    db,
    config.auth.bootstrapAdminUsername,
    config.auth.bootstrapAdminPassword,
    logger,
  );

  const entra =
    config.auth.entra && (config.auth.mode === 'entra' || config.auth.mode === 'both')
      ? new EntraClient(config.auth.entra)
      : null;

  if (entra) {
    logger.info(
      { tenantId: config.auth.entra?.tenantId, mode: config.auth.mode },
      'Microsoft Entra sign-in enabled',
    );
  }

  const authenticator = new WorkerAuthenticator(db, config);
  logger.info({ modes: authenticator.enabledModes }, 'Worker authentication modes');

  const auditExporter = new AuditExporter(db, config, logger);
  auditExporter.start();

  // ---- gRPC worker hub -----------------------------------------------------
  const tls = await resolveHubTls(db, config, logger);
  const grpcServer = createGrpcServer({
    db,
    config,
    logger,
    registry,
    authenticator,
    commandSigningPublicKey: signingKey.publicKeyPem,
  });

  await new Promise<void>((resolve, reject) => {
    grpcServer.bindAsync(
      `${config.grpcHost}:${config.grpcPort}`,
      createServerCredentials(tls),
      (err, port) => {
        if (err) return reject(err);
        logger.info({ port, tls: Boolean(tls.tlsCert) }, 'Worker hub listening');
        resolve();
      },
    );
  });

  // ---- REST API + dashboard ------------------------------------------------
  const app = await createApp({ db, config, logger, registry, entra });
  await app.listen({ host: config.httpHost, port: config.httpPort });
  logger.info({ port: config.httpPort, publicUrl: config.publicUrl }, 'API listening');

  // ---- Background maintenance ----------------------------------------------
  const retentionTimer = setInterval(
    () => {
      pruneRetention(db, config.historyRetentionDays).catch((err: unknown) => {
        logger.error({ err }, 'Retention prune failed');
      });
      pruneExpiredSessions(db).catch((err: unknown) => {
        logger.error({ err }, 'Session prune failed');
      });
    },
    6 * 60 * 60 * 1000,
  );
  retentionTimer.unref();

  // ---- Shutdown ------------------------------------------------------------
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    clearInterval(retentionTimer);

    grpcServer.tryShutdown(() => {
      void app
        .close()
        .then(() => auditExporter.stop())
        .then(() => close())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception; exiting for the supervisor to restart');
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  console.error('Failed to start control plane:', err);
  process.exit(1);
});
