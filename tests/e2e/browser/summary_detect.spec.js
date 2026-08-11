// Preselecting the agent's closing message, in a real browser.
//
// The vm slice in tests/test_summary_detect.js covers which lines the parse picks. What it cannot
// see is the wiring: that a pane read is what runs it, that only a finished pane gets a
// suggestion, that the band and the footer actually paint, and above all that a range the user is
// holding — or one they deliberately cleared — is never overwritten by the 3s poll.
//
// The pane text is the same checked-in read of a live Claude pane the vm slice asserts against.
//
//   npx playwright test
const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Architect 1';   // the fake herdr reports this one as a claude pane
const PANE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'fixtures', 'pane_claude_done.txt'), 'utf8');

// The relay's fake herdr always reports this pane idle, and the closing message only matters once
// the agent has finished. Setting the status here is the same merge an agent_update performs.
const feed = (page, text, status = 'done') => page.evaluate(([text, status]) => {
  const a = paneOf(activePane);
  a.status = status;
  setPaneText(text);
}, [text, status]);

const sel = page => page.evaluate(() => (selA === null ? null : [selA, selB]));

test.beforeEach(async ({page}) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors;
  await page.goto('/');
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
});

test.afterEach(async ({page}) => {
  expect(page.__errors, 'the page logged errors').toEqual([]);
});

test('a finished pane opens with its closing message selected and named', async ({page}) => {
  await feed(page, PANE);
  await expect(page.locator('#selBand')).toBeVisible();
  await expect(page.locator('#selCount')).toHaveText(/· final message$/);
  const text = await page.evaluate(() => selText);
  expect(text.split('\n')[0]).toMatch(/^⏺ Ready\. Name the change\./);
  expect(text).not.toMatch(/⎿/);       // no tool results
  expect(text).not.toMatch(/✻ Baked/); // no turn footer
});

test('a pane still working is left alone', async ({page}) => {
  await feed(page, PANE, 'working');
  expect(await sel(page)).toBeNull();
  await expect(page.locator('#selBand')).toBeHidden();
});

test('a range the user is holding survives the next read', async ({page}) => {
  await feed(page, PANE);
  await page.evaluate(() => { clearSel(); selA = 2; selB = 4; drawSel(); });
  await feed(page, PANE);          // the same text again, exactly what the 3s poll re-delivers
  expect(await sel(page)).toEqual([2, 4]);
  await expect(page.locator('#selCount')).not.toHaveText(/final message/);
});

test('a read that destroys the range does not replace it with a guess', async ({page}) => {
  await page.evaluate(() => { selA = 2; selB = 4; drawSel(); });
  await feed(page, PANE);          // wholly different text, so the range cannot be re-anchored
  expect(await sel(page)).toBeNull();
});

test('a suggestion the user cleared does not come back on the poll', async ({page}) => {
  await feed(page, PANE);
  expect(await sel(page)).not.toBeNull();
  await page.evaluate(() => clearSel());
  await feed(page, PANE);          // identical text, exactly what the 3s poll re-delivers
  expect(await sel(page)).toBeNull();
});

test('switching panes drops the suggestion with the rest of the ruler', async ({page}) => {
  await feed(page, PANE);
  expect(await sel(page)).not.toBeNull();
  await page.locator('.back').first().click();
  await page.locator('#agents .agent', {hasText: 'scratch'}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  expect(await sel(page)).toBeNull();
  await expect(page.locator('#selBar')).toBeHidden();
  await expect(page.locator('#selBand')).toBeHidden();
});
