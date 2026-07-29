import sql from 'mssql';
import type { InstanceConfig } from '../config.js';

/**
 * One connection pool per configured instance. A single worker manages every
 * named instance on its host (§3.2.5), so pools are keyed by instance name.
 */
export function buildPoolConfig(instance: InstanceConfig): sql.config {
  const base: sql.config = {
    server: instance.server,
    database: instance.database,
    options: {
      encrypt: instance.encrypt,
      trustServerCertificate: instance.trustServerCertificate,
      enableArithAbort: true,
      // msdb stores datetimes without zone information; reading them as UTC
      // keeps history timestamps stable regardless of the worker's locale.
      useUTC: true,
    },
    connectionTimeout: instance.connectionTimeoutMs,
    requestTimeout: instance.requestTimeoutMs,
    pool: { min: 0, max: 4, idleTimeoutMillis: 30_000 },
  };

  if (instance.port) base.port = instance.port;

  if (instance.user) {
    base.user = instance.user;
    base.password = instance.password ?? '';
    if (instance.domain) base.domain = instance.domain;
  } else {
    // Integrated auth: the Windows service account is the SQL principal, and no
    // credential is stored on disk at all.
    base.authentication = { type: 'ntlm', options: { domain: instance.domain ?? '' } } as never;
  }

  return base;
}

export async function connectInstance(instance: InstanceConfig): Promise<sql.ConnectionPool> {
  const pool = new sql.ConnectionPool(buildPoolConfig(instance));
  // Without a listener, a pool-level error after connect is an unhandled
  // 'error' event and takes the process down.
  pool.on('error', () => undefined);
  await pool.connect();
  return pool;
}
