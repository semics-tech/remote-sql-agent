import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the dashboard.
 *
 * These exist because nothing else in the repository renders a component. The
 * unit tests cover pure functions, and the integration suite stops at the API —
 * so a React, Vite or Monaco upgrade could break every screen while CI stayed
 * green. That is not hypothetical: it is exactly the gap that made a React 19
 * bump unreviewable.
 *
 * They run against the **built** dashboard rather than the dev server, because
 * what ships is the build: chunking, lazy imports and the Monaco split only
 * exist there, and those are the parts an upgrade breaks.
 *
 * The API is stubbed per test (see e2e/fixtures.ts). The point here is the
 * front end; the server is already covered end to end against real SQL Server.
 */
export default defineConfig({
  testDir: './e2e',
  // Every assertion is against a stubbed API, so anything slow is a hang.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  // A test that only passes on a retry is a flaky test, and a flaky UI test is
  // worse than none — it teaches people to ignore the suite.
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: {
    // --host is load-bearing: vite preview otherwise binds ::1 only, and
    // Playwright polls 127.0.0.1, so the server comes up and the run still
    // times out waiting for it.
    command: 'pnpm build && pnpm preview --port 4173 --strictPort --host 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
