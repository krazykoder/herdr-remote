// The tab bar's third scope: the pairs, and nothing else.
//
// Adjacency and a shared tint are the entire "these two are a pair" — the strip has no room for a
// link glyph between two tabs — so what is worth pinning is that the halves stay together and keep
// the same colour, and that the two cues the strip already carries, pinning and selection, do not
// take it away from them.
//
//   npx playwright test tab_pairs
const {test, expect} = require('@playwright/test');

const tabs = page => page.locator('#agentTabs .agent-tab');
const labels = page => tabs(page).evaluateAll(els => els.map(e => e.querySelector('.label').textContent));
const tints = page => tabs(page).evaluateAll(els => els.map(e => e.style.getPropertyValue('--tint')));

// Pairs the two idle agents and opens a pane, which is the only place the strip is shown.
// Seeded the way the pane menu would store it — what is under test is the strip, not the dialog.
async function setup(page, scope = 'pairs') {
  await page.evaluate(s => {
    const [left, right] = agents.filter(a => a.status !== 'working');
    localStorage.setItem('herdr_pairs', JSON.stringify({version: 1, pairs: [{
      id: 'p_tabs', name: 'Tab pair',
      members: [fingerprint(left, paneLabel(left)), fingerprint(right, paneLabel(right))],
    }]}));
    localStorage.setItem('herdr_tab_scope', s);
  }, scope);
  await page.reload();
  await page.locator('#agents .agent').first().waitFor();
  await page.locator('#agents .agent', {hasText: 'Architect 1'}).click();
  await expect(page.locator('#agentTabs')).toBeVisible();
}

test.beforeEach(async ({page}) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors;
  await page.goto('/');
  await expect(page.locator('#agents .agent').first()).toBeVisible();
});

test.afterEach(async ({page}) => {
  expect(page.__errors, 'the page logged errors').toEqual([]);
});

test('every live pane is still the strip when that is the scope', async ({page}) => {
  await setup(page, 'all');
  // Agents and terminals, and not one of them tinted — the mode is opt-in and changes nothing
  // for anyone who leaves the setting alone.
  expect((await labels(page)).length).toBeGreaterThan(2);
  expect(await tints(page)).toEqual(new Array((await labels(page)).length).fill(''));
});

test('the pairs scope shows the paired panes, side by side and in one colour', async ({page}) => {
  await setup(page);
  expect(await labels(page)).toEqual(['Architect 1', 'amp']);

  const [a, b] = await tints(page);
  expect(a, 'a tint was assigned').not.toBe('');
  expect(b, 'and both halves wear it').toBe(a);

  // Side by side is literal: the second tab starts where the first one ends.
  const [left, right] = await tabs(page).evaluateAll(els => els.map(e => e.getBoundingClientRect()));
  expect(right.left).toBeGreaterThanOrEqual(left.right);
  expect(right.left - left.right, 'and they sit tighter to each other than to what follows')
    .toBeLessThan(14);
});

test('the open pane is kept even when it is in no pair', async ({page}) => {
  // The rule the project scope already follows: a strip that cannot show the pane on screen is
  // worse than one carrying an extra tab. Untinted, so it reads as the exception.
  await setup(page);
  await page.locator('.term-header .back').click();
  await page.locator('#agents .agent', {hasText: 'scratch'}).click();

  expect(await labels(page)).toEqual(['Architect 1', 'amp', 'scratch']);
  expect((await tints(page))[2]).toBe('');
});

test('a pin cannot split a pair, and selection still outranks the tint', async ({page}) => {
  await setup(page);
  // Pinning pulls a tab to the front everywhere else. Here it would take one half of a pair away
  // from the other, which is the one thing this mode exists to prevent.
  await tabs(page).nth(1).dblclick();
  expect(await labels(page)).toEqual(['Architect 1', 'amp']);

  // The selected tab is the filled blue pill it is in every other mode — the tint rule carries
  // :not(.active) precisely so a tinted tab does not swallow the selection. Both tabs here are
  // tinted, so the difference between them is selection and nothing else.
  await expect(page.locator('#agentTabs .agent-tab.active')).toHaveCount(1);
  // Polled, because the pill transitions its background over 150ms and a computed style read
  // inside that window is the interpolated value rather than either end of it.
  const bg = sel => page.locator(`#agentTabs .agent-tab${sel} .pill`)
    .first().evaluate(e => getComputedStyle(e).backgroundColor);
  await expect.poll(() => bg('.active'), {message: 'the selection is opaque'}).not.toMatch(/rgba/);
  await expect.poll(() => bg(':not(.active)'), {message: 'the tint is a wash'})
    .toMatch(/rgba\(.+0\.14\)/);

  // The wash is what selection takes away; the ring is not. A selected tab is a filled blue pill,
  // and dropping the tint from it made the one tab being looked at the one tab that stopped
  // saying which pair it belongs to.
  const ring = sel => page.locator(`#agentTabs .agent-tab${sel} .pill`).first()
    .evaluate(e => [getComputedStyle(e).outlineWidth, getComputedStyle(e).outlineColor]);
  const [width, colour] = await ring('.active');
  expect(width, 'the selected half keeps a thick tint ring').toBe('2px');
  expect(await ring(':not(.active)'), 'and both halves wear the same one')
    .toEqual([width, colour]);
});

test('the setting says what it is hiding, and counts the pairs', async ({page}) => {
  await setup(page);
  await page.locator('#termMenuBtn').click();
  await expect(page.locator('#tabScope')).toHaveValue('pairs');
  await expect(page.locator('#tabScopeHint')).toHaveText(/1 pair running/);
});
