import { expect, test, type Locator, type Page } from '@playwright/test';
import { INSTANCE_ID, JOB_UUID, mockApi, panel } from './fixtures.js';

const JOB_URL = `/instances/${INSTANCE_ID}/jobs/${JOB_UUID}`;

/**
 * The job editor is where a mistake reaches a customer's SQL Server, so the
 * behaviour worth pinning is not "the form renders" but what the flow-editing
 * controls actually do to the definition.
 *
 * These drive the real controls rather than calling the pure helpers — those
 * already have unit tests. What is unproven without a browser is that the
 * controls are wired to them at all.
 */

/**
 * Type a body into a step that starts empty.
 *
 * Deliberately not "replace the body". Monaco renders through the EditContext
 * API here rather than a hidden textarea, and Playwright's synthetic select-all
 * and Delete do not drive it — only `insertText` does. The previous version of
 * this helper pressed select-all/Delete and then inserted, which silently
 * *appended* to the fixture body. Every test still passed, because they only
 * asserted which findings appeared and never on which line.
 *
 * `insertText` rather than `type` for a separate reason: typing fires a key
 * event per character and Monaco's suggestion widget consumes some of them, so
 * an earlier version intermittently ended up with `R10, 1);` in the buffer
 * instead of the RAISERROR it typed. The insertion still goes through the
 * editor's real change pipeline, which is what these tests are about.
 *
 * The empty-body assertion is first because a helper that quietly appends is
 * exactly what this is here to prevent recurring.
 */
async function typeBody(page: Page, editor: Locator, body: string): Promise<void> {
  await expect(editor.locator('.view-line')).toHaveText(['']);
  await editor.locator('.view-lines').click();
  await page.keyboard.insertText(body);
  await expect(editor.locator('.view-line').first()).toContainText(body.split('\n')[0]!);
}

/**
 * A step with an empty body, made the way an operator makes one.
 *
 * Using the product's own Add step rather than a fixture step keeps the
 * reachability tests looking at the three-step job they were written against —
 * an unreachable fourth step in the fixture changes what every one of them
 * counts.
 */
async function addEmptyStep(page: Page): Promise<Locator> {
  const steps = panel(page, /^Steps/);
  await steps.getByRole('button', { name: 'Add step' }).click();
  const editor = steps.locator('.monaco-editor').first();
  await expect(editor).toBeVisible();
  return editor;
}

test.describe('job editor: steps', () => {
  test('lists steps collapsed, and expands the one clicked', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);

    const steps = panel(page, /^Steps/);
    await expect(steps.getByRole('row', { name: /Rebuild indexes/ })).toBeVisible();

    // Collapsed by default: a three-step job should be readable as a list
    // without scrolling past three command editors.
    await expect(steps.getByText('▾')).toHaveCount(0);

    await steps.getByRole('row', { name: /Rebuild indexes/ }).click();
    await expect(steps.getByText('▾')).toHaveCount(1);
  });

  test('clearing Runs routes the job around the step and says so', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);

    const steps = panel(page, /^Steps/);
    const runs = steps.getByRole('checkbox', { name: 'Rebuild indexes runs' });
    await expect(runs).toBeChecked();

    await runs.uncheck();

    // "Disabled" is read back from reachability rather than stored, so the
    // badge appearing is the definition genuinely having been rewired.
    await expect(runs).not.toBeChecked();
    await expect(steps.getByText('1 step will not run')).toBeVisible();
    await expect(
      steps.getByRole('row', { name: /Rebuild indexes/ }).getByText('off', { exact: true }),
    ).toBeVisible();
  });

  test('ticking Runs again puts the step back with nothing stored', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);

    const steps = panel(page, /^Steps/);
    const runs = steps.getByRole('checkbox', { name: 'Rebuild indexes runs' });

    await runs.uncheck();
    await expect(steps.getByText('1 step will not run')).toBeVisible();

    await runs.check();

    // Nothing was persisted to make this work: step ids are positions, so a
    // step at 2 belongs between 1 and 3.
    await expect(runs).toBeChecked();
    await expect(steps.getByText(/steps? will not run/)).toHaveCount(0);
  });

  test('warns about a step nothing can reach, however it got that way', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);

    const steps = panel(page, /^Steps/);
    await steps.getByRole('checkbox', { name: 'Rebuild indexes runs' }).uncheck();

    // The explanation has to say the step survives, because the whole design
    // rests on it being intact in msdb rather than deleted.
    await expect(steps.getByText(/routed around the step/)).toBeVisible();
    await expect(steps.getByText(/uninstall the worker/)).toBeVisible();
  });

  test('adds a step and opens it, since the next action is always to type', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);

    const steps = panel(page, /^Steps/);
    await expect(steps.getByRole('row')).toHaveCount(4); // header + 3

    await steps.getByRole('button', { name: 'Add step' }).click();

    await expect(steps.getByText('▾')).toHaveCount(1);
    await expect(page.getByText(/^Steps \(4\)/)).toBeVisible();
  });

  /**
   * The rules themselves are unit-tested. What cannot be proven without a
   * browser is that they are wired to the editor at all: the debounce, the
   * marker owner, and Monaco actually being handed the findings. The bar has
   * been asserted rather than the squiggle because the squiggle is drawn on a
   * canvas overlay and is not queryable.
   */
  test('reports a problem in the step body as it is typed', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);

    const steps = panel(page, /^Steps/);
    const editor = await addEmptyStep(page);
    // Nothing typed yet, so nothing should be claimed.
    await expect(steps.locator('.lint-bar')).toHaveCount(0);

    await typeBody(page, editor, "RAISERROR('Import failed', 10, 1);");

    const bar = steps.locator('.lint-bar');
    await expect(bar).toContainText('1 warning');

    await bar.getByRole('button', { name: /warning/ }).click();
    await expect(bar).toContainText('tsql/raiserror-not-fatal');
    await expect(bar).toContainText('does not fail the step');
  });

  /**
   * An emoji anywhere in the body used to move every finding onto the wrong
   * line and hide the real ones — the mask was built by code point and indexed
   * by UTF-16 offset. Asserted here as well as in the unit tests because the
   * line number is what the operator actually acts on, and it is the number
   * that travels all the way through Monaco to the screen.
   */
  test('puts the finding on the right line when the body contains an emoji', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);

    const steps = panel(page, /^Steps/);
    const editor = await addEmptyStep(page);

    await typeBody(page, editor, "-- 🚨 nightly\nRAISERROR('Backup failed 🚨', 10, 1);");

    const bar = steps.locator('.lint-bar');
    await expect(bar).toContainText('1 warning');

    await bar.getByRole('button', { name: /warning/ }).click();
    await expect(bar).toContainText('tsql/raiserror-not-fatal');
    // Line 2 — the RAISERROR — not line 1, the comment it was displaced onto.
    await expect(bar.locator('.lint-line')).toHaveText('Line 2');
  });

  test('re-lints under the other language when the step type changes', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);

    const steps = panel(page, /^Steps/);
    const editor = await addEmptyStep(page);
    await typeBody(page, editor, 'Write-Host "starting"');

    // Still T-SQL, and nothing in the T-SQL rules has anything to say about it.
    await expect(steps.locator('.lint-bar')).toHaveCount(0);

    await steps.getByLabel('Type').selectOption('PowerShell');

    // Two findings: Write-Host never reaches the job history, and nothing in
    // the script can fail the step.
    await expect(steps.locator('.lint-bar')).toContainText('2 warnings');
  });

  test('offers Schedules and Notifications as their own sections', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);

    // The step list is long; schedules and notifications were pushed below it
    // where nobody found them.
    await page.getByRole('button', { name: 'Schedules' }).click();
    await expect(panel(page, /^Steps/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Notifications' }).click();
    await expect(panel(page, /^Steps/)).toHaveCount(0);

    // Not an exact match: the tab carries its own count, so its accessible
    // name is "Steps 3" rather than "Steps".
    await page.getByRole('button', { name: /^Steps/ }).click();
    await expect(panel(page, /^Steps/)).toBeVisible();
  });
});
