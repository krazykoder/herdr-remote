// The history ceiling and the poll it pauses, in a real browser.
//
// The vm slice in tests/test_pane_history.js covers the arithmetic — which ceiling, which step,
// which reads are skipped. What it cannot see is the wiring around it: that the 3s interval is
// the caller passing auto, that the scroll handler is what turns a paused pane live again, and
// that the setting is on the settings screen and survives a reload.
//
//   npx playwright test
const {test, expect} = require('@playwright/test');

const AGENT = 'Architect 1';   // the fake herdr reports this one idle
const WORKING = 'scratch';     // and this one working

// Records what actually leaves the page. The relay is real, so this is the request itself and
// not a stub of it.
async function tapWire(page) {
  await page.evaluate(() => {
    window.__sent = [];
    const send = ws.send.bind(ws);
    ws.send = m => { window.__sent.push(JSON.parse(m)); send(m); };
  });
}
const reads = page => page.evaluate(() => window.__sent.filter(m => m.type === 'read_pane'));

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

test('the ceiling is on the settings screen and survives a reload', async ({page}) => {
  await page.locator('#navSettings, [onclick*="settings"]').first().click();
  const pick = page.locator('#historyPick');
  await expect(pick).toBeVisible();
  await expect(pick).toHaveValue('5000');

  await pick.selectOption('20000');
  await page.reload();
  await page.locator('#navSettings, [onclick*="settings"]').first().click();
  await expect(page.locator('#historyPick')).toHaveValue('20000');
  await expect.poll(() => page.evaluate(() => paneHistoryMax())).toBe(20000);
});

test('a working pane is followed on the 3s poll', async ({page}) => {
  await page.locator('#agents .agent', {hasText: WORKING}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  await tapWire(page);
  await expect.poll(() => reads(page).then(r => r.length), {timeout: 8000}).toBeGreaterThan(0);
  expect((await reads(page))[0].lines).toBe(200);
});

test('an idle pane is polled at the slow cadence', async ({page}) => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  expect(await page.evaluate(() => paneIsIdle())).toBe(true);
  await tapWire(page);
  // Two ticks of the fast cadence, which an idle pane must sit out. The status is still arriving
  // on the snapshot broadcast throughout — backing off the pane read is not backing off the app.
  await page.waitForTimeout(7000);
  expect(await reads(page), 'an idle pane was read at the working cadence').toEqual([]);
});

test('a deep read pauses the poll, and the tail turns it back on', async ({page}) => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  // Stood in for rather than scrolled to: the fake herdr's pane is five lines, and what is under
  // test is the depth, not how the user reached it.
  await page.evaluate(() => { paneLines = 20000; });
  await tapWire(page);

  await page.waitForTimeout(4000);   // more than one tick of the 3s interval
  expect(await reads(page), 'the poll re-fetched 20,000 lines').toEqual([]);

  // Back at the newest line. The handler is the real one; only the scroll is synthesised.
  await page.evaluate(() => {
    const el = document.getElementById('termContent');
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.evaluate(() => paneLines)).toBe(200);
  await expect.poll(() => reads(page).then(r => r.length)).toBeGreaterThan(0);
  expect((await reads(page)).every(r => r.lines === 200)).toBe(true);
});

test('the refresh button still reads at full depth while the poll is paused', async ({page}) => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  await page.evaluate(() => { paneLines = 20000; });
  await tapWire(page);

  await page.locator('button[aria-label="Refresh pane"]').click();
  await expect.poll(() => reads(page).then(r => r.length)).toBe(1);
  expect((await reads(page))[0].lines).toBe(20000);
});
