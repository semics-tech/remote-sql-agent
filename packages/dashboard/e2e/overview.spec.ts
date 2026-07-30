import { expect, test } from '@playwright/test';
import { mockApi, overview, panel, runningJob } from './fixtures.js';

/**
 * The overview's running table is the most upgrade-fragile thing in the
 * dashboard: it is a component driven by an interval, reading a value the
 * server measured at reply time and moving it forward locally. That is exactly
 * the shape that breaks quietly when React changes how effects are scheduled —
 * the page still renders, the number just stops moving.
 */

test.describe('overview: running now', () => {
  test('names the step the job is actually on, with its position', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    const row = panel(page, 'Running now').getByRole('row', { name: /Nightly Maintenance/ });
    await expect(row).toBeVisible();

    // The whole point of inferring the running step: msdb reports the step that
    // last *finished*, so naming it directly would say "Check integrity" here.
    await expect(row).toContainText('2. Rebuild indexes');
    await expect(row).toContainText('(2 of 3)');
  });

  test('counts the duration up without another request', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    const durationCell = panel(page, 'Running now')
      .getByRole('row', { name: /Nightly Maintenance/ })
      .locator('td')
      .nth(3);
    const first = (await durationCell.textContent())?.trim();
    expect(first).toBeTruthy();

    // Ticking is local, so this must advance even though the stubbed API keeps
    // returning elapsedSeconds: 90 on every poll.
    await expect(durationCell).not.toHaveText(first!, { timeout: 15_000 });
  });

  test('offers the average and last duration behind the running time', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    const durationCell = panel(page, 'Running now')
      .getByRole('row', { name: /Nightly Maintenance/ })
      .locator('td')
      .nth(3);
    const tooltip = await durationCell.getAttribute('title');

    // An operator asking "is this slow?" needs the job's own history, not a
    // number in isolation.
    expect(tooltip).toMatch(/average/i);
    expect(tooltip).toMatch(/last/i);
  });

  test('says why there is no estimate rather than showing a bare dash', async ({ page }) => {
    await mockApi(page, {
      routes: {
        // Fewer than three successful runs: the server withholds the average
        // rather than estimating from one data point.
        '/api/overview': overview({
          running: [runningJob({ averageSeconds: null, lastDurationSeconds: null })],
        }),
      },
    });
    await page.goto('/');

    const row = panel(page, 'Running now').getByRole('row', { name: /Nightly Maintenance/ });
    await expect(row.locator('[title*="fewer than three"]')).toBeVisible();
  });

  test('marks a job past its own average as long-running', async ({ page }) => {
    await mockApi(page, {
      routes: {
        '/api/overview': overview({
          totals: { ...overview().totals, longRunning: 1 },
          running: [runningJob({ elapsedSeconds: 900, isLongRunning: true })],
        }),
      },
    });
    await page.goto('/');

    // Scoped to the dedicated panel: a long-running job is deliberately listed
    // in both, so this also proves it reached the one that exists to surface it.
    const row = panel(page, 'Running longer than usual').getByRole('row', {
      name: /Nightly Maintenance/,
    });
    await expect(row.getByText('long', { exact: true })).toBeVisible();
  });

  test('shows the empty state when nothing is running', async ({ page }) => {
    await mockApi(page, {
      routes: {
        '/api/overview': overview({
          totals: { ...overview().totals, runningNow: 0 },
          running: [],
        }),
      },
    });
    await page.goto('/');

    await expect(page.getByText('Nothing running')).toBeVisible();
  });
});
