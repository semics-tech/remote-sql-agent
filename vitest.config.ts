import { defineConfig } from 'vitest/config';

/**
 * Test projects.
 *
 * This was vitest.workspace.ts until vitest 4, which dropped the workspace file
 * and `defineWorkspace` in favour of `test.projects` here. The two are not
 * equivalent in how they fail: vitest 4 does not warn about a workspace file it
 * no longer reads, it simply finds no projects. `pnpm test:unit` names its
 * projects with --project and so errored, which is the only reason the removal
 * was visible at all — an unfiltered `vitest run` would have collected nothing,
 * reported no failures and exited 0.
 */
export default defineConfig({
  test: {
    projects: [
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
          // Each test file provisions its own Postgres database (see
          // test/helpers/db.ts), so files are isolated. The generous timeouts cover
          // migration on first run and argon2id hashing, which is slow by design.
          testTimeout: 20_000,
          hookTimeout: 60_000,
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
          // Pure functions only — the timeline and ETA arithmetic. No DOM, because
          // what is worth pinning here is the numbers behind the chart, not that
          // React renders a div.
          name: 'dashboard',
          root: './packages/dashboard',
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
    ],
  },
});
