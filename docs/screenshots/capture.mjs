// Captures the README screenshots from the running demo stack
// (deploy/docker-compose.demo.yml). Run by .github/workflows/readme-screenshots.yml;
// to run it locally, start the demo, then:
//
//   pnpm --filter @remote-sql-agent/dashboard exec node ../../docs/screenshots/capture.mjs
//
// Environment: BASE_URL (default http://localhost:8080), OUT_DIR (default docs/screenshots/out).
// The credentials are the throwaway demo admin published in the compose file.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const OUT = process.env.OUT_DIR ?? 'docs/screenshots/out';
const FAILED_JOB = 'RSAgent Fixture - Known Failure';
const DRIFT_JOB = 'RSAgent Fixture - Heartbeat Log';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);

async function shot(name) {
  // Let fonts, polling and Monaco settle before the frame is taken.
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(OUT, `${name}.png`), type: 'png' });
  console.log(`captured ${name}.png`);
}

async function openJob(name) {
  await page.goto('/jobs');
  await page.getByRole('link', { name, exact: true }).first().click();
  await page.getByRole('button', { name: 'History', exact: true }).waitFor();
}

// Sign in.
await page.goto(`${BASE}/`);
await page.getByLabel('Username').fill('admin');
await page.getByLabel('Password').fill('rsagent-demo');
await page.getByRole('button', { name: /sign in/i }).click();
await page.getByRole('link', { name: 'Estate' }).waitFor();

// 1. Estate grid. Give the first poll time to land.
await page.goto(`${BASE}/estate`);
await page.getByText('DEMO-SQLHOST01').first().waitFor();
await page.waitForTimeout(15_000);
await shot('1-estate-grid');

// 2. Failed job history with step detail.
await openJob(FAILED_JOB);
await page.getByRole('button', { name: 'History', exact: true }).click();
const run = page.locator('tr.expandable').first();
await run.waitFor();
await run.click();
await page.getByText(/^Step 1/).first().waitFor();
await shot('2-failed-job-history');

// 3. Cross-server search.
await page.goto(`${BASE}/search`);
await page.getByLabel('Search job names and step bodies').fill('LEGACYFIN01');
await page.getByRole('button', { name: /search/i }).click();
await page.getByText('LEGACYFIN01').nth(1).waitFor();
await shot('3-cross-server-search');

// 4. Drift diff. The workflow runs the drift profile before this script; wait
// for the badge, then open the job's Versions tab and its newest diff.
await page.goto(`${BASE}/jobs`);
await page.getByText(/drift/i).first().waitFor({ timeout: 120_000 });
await openJob(DRIFT_JOB);
await page.getByRole('button', { name: 'Versions', exact: true }).click();
const edit = page.getByText(/on-premise edit/i).first();
await edit.waitFor();
await edit.click();
await page.locator('.monaco-diff-editor').waitFor({ timeout: 60_000 });
await shot('4-drift-diff');

// 5. Workers and capabilities.
await page.goto(`${BASE}/admin`);
await page.getByRole('button', { name: 'Workers', exact: true }).click();
await page.getByText('DEMO-SQLHOST01').first().waitFor();
await shot('5-workers-capabilities');

await browser.close();
