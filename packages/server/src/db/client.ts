import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export type Database = ReturnType<typeof createDatabase>['db'];

export function createDatabase(databaseUrl: string, options: { max?: number } = {}) {
  const sql = postgres(databaseUrl, {
    max: options.max ?? 10,
    // Timestamps are stored with time zone; keep them as Date objects rather
    // than strings so comparisons and JSON encoding behave predictably.
    transform: { undefined: null },
  });
  const db = drizzle(sql, { schema });
  return { db, sql, close: async () => sql.end({ timeout: 5 }) };
}

export { schema };
