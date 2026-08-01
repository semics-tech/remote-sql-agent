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
    /**
     * Reporting only, with no threshold, and that is deliberate for now.
     *
     * A gate added at the same time as the measurement turns the first red
     * build into an argument about policy rather than a bug to fix. The number
     * is here to be looked at: `agent-writer.ts` is the only code in this
     * repository that writes to a customer's msdb, and it had no dedicated test
     * at all — the kind of gap that is obvious once counted and invisible until
     * then. Add a threshold once the number has stopped moving.
     */
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        // Generated from .proto.
        'packages/protocol/src/gen/**',
        // Entry points and wiring: exercised end to end by the integration
        // suite, and a unit test of them would only assert the wiring back.
        'packages/*/src/index.ts',
        'packages/dashboard/src/main.tsx',
      ],
    },
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
