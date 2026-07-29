import * as grpc from '@grpc/grpc-js';
import { eq } from 'drizzle-orm';
import { generateCommandSigningKeyPair } from '@rsagent/protocol';
import { loadConfig } from './config.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { serverKeys } from './db/schema.js';
import { createLogger } from './logger.js';
import { createApp } from './api/app.js';
import { createGrpcServer } from './hub/hub.js';
import { WorkerRegistry } from './hub/registry.js';
import { pruneRetention } from './domain/ingest.js';

const COMMAND_SIGNING_KEY_ID = 'command-signing';

/**
 * Load the command-signing keypair, generating it on first boot. Keeping it in
 * the database rather than an env var means a fresh Compose deployment works
 * with no key ceremony, and the public half can be handed to workers in
 * HelloAck so they can verify commands independently of the transport (§6.4).
 */
async function loadOrCreateSigningKey(
  db: ReturnType<typeof createDatabase>['db'],
): Promise<{ privateKeyPem: string; publicKeyPem: string }> {
  const [existing] = await db
    .select()
    .from(serverKeys)
    .where(eq(serverKeys.id, COMMAND_SIGNING_KEY_ID));
  if (existing) {
    return { privateKeyPem: existing.privateKeyPem, publicKeyPem: existing.publicKeyPem };
  }

  const pair = generateCommandSigningKeyPair();
  await db
    .insert(serverKeys)
    .values({
      id: COMMAND_SIGNING_KEY_ID,
      privateKeyPem: pair.privateKeyPem,
      publicKeyPem: pair.publicKeyPem,
    })
    .onConflictDoNothing();

  const [row] = await db
    .select()
    .from(serverKeys)
    .where(eq(serverKeys.id, COMMAND_SIGNING_KEY_ID));
  if (!row) throw new Error('Failed to persist command signing key');
  return { privateKeyPem: row.privateKeyPem, publicKeyPem: row.publicKeyPem };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  logger.info('Applying database migrations...');
  await runMigrations(config.databaseUrl);

  const { db, close } = createDatabase(config.databaseUrl);
  const registry = new WorkerRegistry();
  const signingKey = await loadOrCreateSigningKey(db);

  // ---- gRPC worker hub -----------------------------------------------------
  // M1 runs plain TLS-less gRPC for local development; mTLS enforcement is
  // wired in M3 along with the embedded CA and enrolment flow.
  const grpcServer = createGrpcServer({
    db,
    config,
    logger,
    registry,
    commandSigningPublicKey: signingKey.publicKeyPem,
  });

  await new Promise<void>((resolve, reject) => {
    grpcServer.bindAsync(
      `${config.grpcHost}:${config.grpcPort}`,
      grpc.ServerCredentials.createInsecure(),
      (err, port) => {
        if (err) return reject(err);
        logger.info({ port }, 'Worker hub listening');
        resolve();
      },
    );
  });

  // ---- REST API + dashboard ------------------------------------------------
  const app = await createApp({ db, config, logger, registry });
  await app.listen({ host: config.httpHost, port: config.httpPort });
  logger.info({ port: config.httpPort }, 'API listening');

  // ---- Retention -----------------------------------------------------------
  const retentionTimer = setInterval(
    () => {
      pruneRetention(db, config.historyRetentionDays).catch((err: unknown) => {
        logger.error({ err }, 'Retention prune failed');
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
        .then(() => close())
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    });
    // Do not let a wedged connection hold the process open forever.
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
