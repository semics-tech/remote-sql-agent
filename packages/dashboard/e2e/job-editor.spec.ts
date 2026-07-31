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
 * Replace the step body Monaco is showing.
 *
 * `insertText` rather than `type`. Typing fires a key event per character, and
 * Monaco's suggestion widget consumes some of them — the first version of this
 * test intermittently ended up with `R10, 1);` in the buffer instead of the
 * RAISERROR it typed, and passed or failed on the timing of a popup. The
 * insertion still goes through the editor's real change pipeline, which is what
 * these tests are actually about.
 */
async function replaceBody(page: Page, editor: Locator, body: string): Promise<void> {
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(body);
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
    await steps.getByRole('row', { name: /Rebuild indexes/ }).click();

    const editor = steps.locator('.monaco-editor').first();
    await expect(editor).toBeVisible();
    // The fixture body is clean, so nothing should be claimed before typing.
    await expect(steps.locator('.lint-bar')).toHaveCount(0);

    await replaceBody(page, editor, "RAISERROR('Import failed', 10, 1);");

    const bar = steps.locator('.lint-bar');
    await expect(bar).toContainText('1 warning');

    await bar.getByRole('button', { name: /warning/ }).click();
    await expect(bar).toContainText('tsql/raiserror-not-fatal');
    await expect(bar).toContainText('does not fail the step');
  });

  test('re-lints under the other language when the step type changes', async ({ page }) => {
    await mockApi(page);
    await page.goto(JOB_URL);

    const steps = panel(page, /^Steps/);
    await steps.getByRole('row', { name: /Rebuild indexes/ }).click();

    const editor = steps.locator('.monaco-editor').first();
    await replaceBody(page, editor, 'Write-Host "starting"');

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
