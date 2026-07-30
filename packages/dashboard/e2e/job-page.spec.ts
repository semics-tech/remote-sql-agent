import { expect, test } from '@playwright/test';
import { INSTANCE_ID, JOB_UUID, jobDetail, mockApi } from './fixtures.js';

const JOB_URL = `/instances/${INSTANCE_ID}/jobs/${JOB_UUID}`;

test.describe('job page: enable and disable', () => {
  test('shows the change landing on the button, not in a banner', async ({ page }) => {
    let issued = false;
    await mockApi(page, {
      onUnmatched: async (route, pathname) => {
        if (pathname.endsWith('/actions/toggle') || route.request().method() === 'POST') {
          issued = true;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ requiresApproval: false, commandId: 'c-1' }),
          });
          return true;
        }
        return false;
      },
    });
    await page.goto(JOB_URL);

    const toggle = page.getByRole('button', { name: 'Disable' });
    await expect(toggle).toBeVisible();
    await toggle.click();

    // The old behaviour was a banner reading "Disable job sent to the worker",
    // which tells an operator what the software did rather than what happened
    // to their job. The state belongs where they are already looking.
    await expect(page.getByRole('button', { name: 'Disabling…' })).toBeVisible();
    expect(issued).toBe(true);
  });

  test('settles to the server’s answer once it confirms', async ({ page }) => {
    let confirmed = false;
    await mockApi(page, {
      routes: {
        // Answers differently once the toggle has been issued, standing in for
        // the worker having applied it and the next poll seeing the result.
        [`/api/instances/${INSTANCE_ID}/jobs/${JOB_UUID}`]: () =>
          confirmed ? jobDetail({ enabled: false }) : jobDetail(),
      },
      onUnmatched: async (route) => {
        if (route.request().method() === 'POST') {
          confirmed = true;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ requiresApproval: false, commandId: 'c-1' }),
          });
          return true;
        }
        return false;
      },
    });
    await page.goto(JOB_URL);

    await page.getByRole('button', { name: 'Disable' }).click();

    // Reconciled against what the server actually reports, so the optimistic
    // state can never outlive the truth.
    await expect(page.getByRole('button', { name: 'Enable' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Disabled')).toBeVisible();
  });
});

test.describe('job page: versions', () => {
  test('loads the Monaco diff viewer lazily when a command changed', async ({ page }) => {
    await mockApi(page, {
      routes: {
        [`/api/instances/${INSTANCE_ID}/jobs/${JOB_UUID}/versions`]: {
          versions: [
            {
              id: 'v-2',
              versionNo: 2,
              definitionHash: 'b'.repeat(64),
              origin: 'remote',
              commandId: 'c-1',
              createdBy: 'admin',
              detectedAt: '2026-07-30T10:00:00.000Z',
            },
            {
              id: 'v-1',
              versionNo: 1,
              definitionHash: 'a'.repeat(64),
              origin: 'initial',
              commandId: null,
              createdBy: null,
              detectedAt: '2026-07-29T10:00:00.000Z',
            },
          ],
        },
        [`/api/instances/${INSTANCE_ID}/jobs/${JOB_UUID}/diff`]: {
          from: { versionNo: 1, detectedAt: '2026-07-29T10:00:00.000Z', origin: 'initial' },
          to: { versionNo: 2, detectedAt: '2026-07-30T10:00:00.000Z', origin: 'remote' },
          changes: [
            {
              kind: 'step',
              change: 'modified',
              stepId: 2,
              stepName: 'Rebuild indexes',
              commandBefore: 'ALTER INDEX ALL ON dbo.Orders REBUILD;',
              commandAfter: 'ALTER INDEX ALL ON dbo.Orders REORGANIZE;',
            },
          ],
        },
      },
    });
    await page.goto(JOB_URL);
    await page.getByRole('button', { name: 'Versions' }).click();

    // Monaco is ~2 MB and deliberately split into its own chunk so it does not
    // block first paint. That split is exactly what a Vite or Monaco upgrade
    // breaks, and the failure is silent: the tab renders, the diff never
    // arrives.
    //
    // Asserted on rendered content rather than on a .monaco-editor element —
    // Monaco puts that class on hidden gutters too, so the element existing
    // proves the chunk loaded but not that anything was drawn.
    await expect(page.getByText('REORGANIZE').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Loading diff viewer…')).toHaveCount(0);
  });

  test('says so plainly when there are no versions', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);
    await page.getByRole('button', { name: 'Versions' }).click();

    await expect(page.getByText('No versions recorded')).toBeVisible();
  });
});
