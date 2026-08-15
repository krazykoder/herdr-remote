// The walk, in a real browser: one list over every destination, and the browser's own history
// holding the cursor.
//
// The vm slice in tests/test_pairs.js covers navPush and navStep — the list arithmetic. What it
// cannot see is which of those destinations is on screen afterwards, and it certainly cannot see
// a popstate. Both of those are what this file is for: a walk that steps to the right index and
// then shows the wrong thing is the failure that matters here.
//
//   npx playwright test tests/e2e/browser/navigation.spec.js
const {test, expect} = require('@playwright/test');

const AGENT = 'Architect 1';

const openPane = async page => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
};

test.beforeEach(async ({page}) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors;
  await page.goto('/');
});

test.afterEach(async ({page}) => {
  expect(page.__errors, 'the page logged errors').toEqual([]);
});

test('a panel is a stop on the walk, and stacking two of them keeps both', async ({page}) => {
  await openPane(page);
  await page.locator('#navSettings').click();
  await expect(page.locator('#settingsView')).toBeVisible();
  await page.locator('#navTimeline').click();
  await expect(page.locator('#timelineView')).toBeVisible();
  // The one-deep panelReturnPane this replaced could only remember a pane, and only one — opening
  // Activity over Settings lost Settings, so leaving went straight back to the pane.
  await page.locator('#statusBar #navBack').click();
  await expect(page.locator('#settingsView')).toBeVisible();
  await page.locator('#statusBar #navBack').click();
  await expect(page.locator('#terminalView')).toBeVisible();
  await expect(page.locator('#termTitle')).toContainText(AGENT);
});

test('the agent list is a stop too, so Back off the first pane is a step and not a special case',
  async ({page}) => {
    await openPane(page);
    await expect(page.locator('#statusBar #navBack')).toHaveAttribute(
      'aria-label', 'Back to the agent list');
    await page.locator('.term-header .back').click();
    await expect(page.locator('#agentListView')).toBeVisible();
    // And forward again, which the old closeTerminal had no way to offer: leaving a pane used to
    // be a dead end rather than a move.
    const fwd = page.locator('#statusBar #navFwd');
    await expect(fwd).toHaveAttribute('aria-label', new RegExp(`Forward to ${AGENT}`));
    await fwd.click();
    await expect(page.locator('#terminalView')).toBeVisible();
  });

test('the browser holds the cursor, so its own Back is the same step as ‹', async ({page}) => {
  await openPane(page);
  await page.locator('#navSettings').click();
  await expect(page.locator('#settingsView')).toBeVisible();
  // Not a mirror of the walk — the walk itself. Two cursors would be one gesture moving one of
  // them, which is how Back and ‹ end up pointing at different entries.
  await page.goBack();
  await expect(page.locator('#terminalView')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#agentListView')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#terminalView')).toBeVisible();
  // And the app's own arrow agrees about where it now stands, rather than having been left behind.
  await expect(page.locator('#statusBar #navBack')).toHaveAttribute(
    'aria-label', 'Back to the agent list');
});

test('the landing page is the bottom of the stack, not a state of our own', async ({page}) => {
  // Nothing has been visited, so there is nowhere back.
  await expect(page.locator('#statusBar #navBack')).toBeDisabled();
  await expect(page.locator('#statusBar #navFwd')).toBeDisabled();
  // The list anchored the document's own entry rather than pushing a second one on top of it —
  // otherwise the browser's Back would spend a press going nowhere before it could leave the app.
  const before = await page.evaluate(() => history.length);
  expect(await page.evaluate(() => history.state && history.state.herdrNav)).toBe(1);
  await page.reload();
  expect(await page.evaluate(() => history.length)).toBe(before);
});
