import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'protocol',
      root: './packages/protocol',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'server',
      root: './packages/server',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'worker',
      root: './packages/worker',
      environment: 'node',
      include: ['test/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'integration',
      root: './tests/integration',
      environment: 'node',
      include: ['**/*.test.ts'],
      // Real SQL Server + Postgres containers; the SQL Server image is amd64
      // and runs under emulation on ARM, so it is slow to start.
      testTimeout: 180_000,
      hookTimeout: 300_000,
      fileParallelism: false,
    },
  },
]);
