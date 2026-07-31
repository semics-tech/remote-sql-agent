import { expect, test, type Page } from '@playwright/test';
import { INSTANCE_ID, JOB_UUID, environmentGrants, mockApi } from './fixtures.js';

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
    ['Admin', '/admin', /Workers|Administration/i],
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

/**
 * The Access tab.
 *
 * Environment grants decide who may write to production, so the screen that
 * describes them has to be right about what they do. The assertion below is on
 * the wording rather than the table: "grant" reads to most people as though it
 * might also *restrict*, and an administrator who believes these rows hide
 * production from everybody else has drawn exactly the wrong conclusion.
 */
test.describe('administration: access', () => {
  test('says grants add and never remove, and lists them', async ({ page }) => {
    const errors = watchForCrashes(page);
    await mockApi(page);
    await page.goto('/admin');

    await page.getByRole('button', { name: 'Access', exact: true }).click();

    await expect(page.getByText(/adds/).first()).toBeVisible();
    await expect(page.getByText(/never removes anything/)).toBeVisible();
    await expect(page.getByText(/Nothing here hides an instance/)).toBeVisible();

    const row = page.getByRole('row', { name: /production DBAs/ });
    await expect(row).toContainText('production');
    await expect(row).toContainText('Editor');

    expect(errors).toEqual([]);
  });

  test('warns about instances no named grant can reach', async ({ page }) => {
    await mockApi(page, {
      routes: {
        '/api/environment-grants': environmentGrants({
          untaggedInstances: [
            { instanceId: 'i1', instanceName: 'MSSQLSERVER', hostName: 'SQLOLD01' },
          ],
        }),
      },
    });
    await page.goto('/admin');
    await page.getByRole('button', { name: 'Access', exact: true }).click();

    // The quiet failure mode: from the operator's side an untagged instance
    // looks identical to a permissions bug.
    await expect(page.getByText(/does not reach these/)).toBeVisible();
    await expect(page.getByRole('row', { name: /SQLOLD01/ })).toBeVisible();
  });
});
