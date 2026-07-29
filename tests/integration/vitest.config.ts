import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    environment: 'node',
    // Real SQL Server + Postgres. The SQL Server image is amd64 and runs under
    // emulation on ARM, and several assertions wait for a job to actually
    // execute, so the defaults are far too tight.
    testTimeout: 180_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
