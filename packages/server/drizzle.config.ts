import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.RSAGENT_DATABASE_URL ??
      'postgres://rsagent:rsagent_dev_password@localhost:5433/rsagent',
  },
  strict: true,
  verbose: true,
});
