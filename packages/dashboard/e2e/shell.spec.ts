import { expect, test, type Page } from '@playwright/test';
import { INSTANCE_ID, JOB_UUID, mockApi } from './fixtures.js';

/**
 * The shell: signing in, getting around, and not falling over.
 *
 * The last of those is the reason this file exists in the form it does. A
 * React error during render unmounts the tree and leaves an empty body — the
 * page does not error visibly, it simply becomes blank. Every assertion below
 * would pass on a page that had already crashed somewhere else, so the crash
 * has to be watched for directly.
 */

/** Fail the test on an uncaught error, wherever in the run it happened. */
function watchForCrashes(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe('sign-in', () => {
  test('shows the sign-in screen and nothing else when signed out', async ({ page }) => {
    await mockApi(page, { routes: { '/api/auth/me': { user: null, permissions: [] } } });
    await page.goto('/');

    await expect(page.getByRole('button', { name: /sign in/i })).toBeVisible();
    // The server enforces this independently; the point here is that no screen
    // which would 401 on every request is rendered behind the wall.
    await expect(page.getByRole('link', { name: 'Estate' })).toHaveCount(0);
  });

  test('shows the estate once signed in', async ({ page }) => {
    await mockApi(page);
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByText('Ada Lovelace')).toBeVisible();
  });
});

test.describe('navigation', () => {
  const pages: Array<[string, string, RegExp]> = [
    ['Overview', '/', /Running now/],
    ['Estate', '/estate', /Workers|Instances|No workers/i],
    ['Jobs', '/jobs', /Jobs|No jobs/i],
    ['Search', '/search', /Search/i],
    ['Commands', '/commands', /Commands|No commands/i],
  ];

  for (const [name, path, expected] of pages) {
    test(`renders ${name} without crashing`, async ({ page }) => {
      const errors = watchForCrashes(page);
      await mockApi(page);
      await page.goto(path);

      await expect(page.getByText(expected).first()).toBeVisible();
      expect(errors, `${name} raised an uncaught error`).toEqual([]);
    });
  }

  test('renders every job editor section without crashing', async ({ page }) => {
    const errors = watchForCrashes(page);
    await mockApi(page);
    await page.goto(`/instances/${INSTANCE_ID}/jobs/${JOB_UUID}`);

    // Regression guard with a real history: the Notifications section read a
    // field the fixture did not have and took the whole page down with it. A
    // blank page passes any assertion that only looks for absence.
    for (const section of [/^Schedules/, /^Notifications/, /^Steps/]) {
      await page.getByRole('button', { name: section }).click();
      await expect(page.locator('.app')).toBeVisible();
    }

    for (const tab of ['History', 'Versions', 'Job']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await expect(page.locator('.app')).toBeVisible();
    }

    expect(errors, 'a section raised an uncaught error').toEqual([]);
  });

  test('keeps the app up when the API fails', async ({ page }) => {
    const errors = watchForCrashes(page);
    await mockApi(page, { routes: { '/api/overview': null } });
    await page.goto('/');

    // A 404 from one endpoint should surface as an error on that panel, not as
    // a blank window with the nav gone.
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
