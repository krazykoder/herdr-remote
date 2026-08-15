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

test('pane header Back always returns directly to the agent list',
  async ({page}) => {
    await openPane(page);
    await page.locator('.term-header .back').click();
    await expect(page.locator('#agentListView')).toBeVisible();
    await expect(page.locator('#statusBar #navBack')).toBeDisabled();
  });

test('the browser holds the cursor, so its own Back is the same step as ‹', async ({page}) => {
  await openPane(page);
  await page.locator('#navSettings').click();
  await expect(page.locator('#settingsView')).toBeVisible();
  // Not a mirror of the walk — the walk itself. Two cursors would be one gesture moving one of
  // them, which is how Back and ‹ end up pointing at different entries.
  await page.goBack();
  await expect(page.locator('#terminalView')).toBeVisible();
  await page.goForward();
  await expect(page.locator('#settingsView')).toBeVisible();
  // And the app's own arrow agrees about where it now stands, rather than having been left behind.
  await expect(page.locator('#statusBar #navBack')).toHaveAttribute(
    'aria-label', new RegExp(`Back to ${AGENT}`));
});

test('the browser can go back out of the first destination, not just between them',
  async ({page}) => {
    await openPane(page);
    // The landing page is not on the walk, so there is nothing behind this pane to step to — but
    // the entry the document was loaded on is still there, and Back has to reach it. Without that
    // the phone's Back gesture out of the first pane opened left the screen exactly as it was, and
    // quietly put the app's cursor and the browser's out of step for everything after.
    await page.goBack();
    await expect(page.locator('#agentListView')).toBeVisible();
    await expect(page.locator('#statusBar #navBack')).toBeDisabled();
    await page.goForward();
    await expect(page.locator('#terminalView')).toBeVisible();
  });

test('leaving by the header chevron rewinds the browser too', async ({page}) => {
  await openPane(page);
  await page.locator('#navSettings').click();
  await expect(page.locator('#settingsView')).toBeVisible();
  await page.locator('#navSettings').click();          // back onto the pane, one entry down
  await expect(page.locator('#terminalView')).toBeVisible();
  await page.locator('.term-header .back').click();
  await expect(page.locator('#agentListView')).toBeVisible();
  // The chevron is an exit, so the browser is standing where the screen is. A cursor left parked
  // on the panel would answer the next Back gesture with the pane before it — from a screen the
  // user had already left.
  await expect(page.locator('#statusBar #navBack')).toBeDisabled();
  expect(await page.evaluate(() => history.state && history.state.herdrNav)).toBeFalsy();
});

test('desktop < and > walk history without stealing composer input', async ({page}) => {
  await openPane(page);
  await page.locator('#navSettings').click();
  await page.keyboard.press('Shift+Comma');
  await expect(page.locator('#terminalView')).toBeVisible();
  await page.keyboard.press('Shift+Period');
  await expect(page.locator('#settingsView')).toBeVisible();
  await page.locator('#settingsView input').first().focus();
  await page.keyboard.press('Shift+Comma');
  await expect(page.locator('#settingsView')).toBeVisible();
});

test('the landing page is not an app history entry', async ({page}) => {
  // Nothing has been visited, so there is nowhere back.
  await expect(page.locator('#statusBar #navBack')).toBeDisabled();
  await expect(page.locator('#statusBar #navFwd')).toBeDisabled();
  // No state is pushed until a real destination is opened.
  const before = await page.evaluate(() => history.length);
  expect(await page.evaluate(() => history.state && history.state.herdrNav)).toBeFalsy();
  await page.reload();
  expect(await page.evaluate(() => history.length)).toBe(before);
});

test('phone navigation keeps the arrows at the safe edges', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  const box = id => page.locator(id).evaluate(el => {
    const r = el.getBoundingClientRect(); return {left: r.left, right: r.right, width: r.width};
  });
  const [back, forward] = await Promise.all([box('#navBack'), box('#navFwd')]);
  expect(back.left).toBeGreaterThanOrEqual(38);
  expect(forward.right).toBeLessThanOrEqual(352);
  expect(back.width).toBe(68);
  expect(forward.width).toBe(68);
  await expect(page.locator('#statusBarLeft')).toHaveCSS('font-size', '8px');
  await expect(page.locator('#statusBarRight')).toHaveCSS('font-size', '8px');
});
