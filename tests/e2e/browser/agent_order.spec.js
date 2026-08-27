// Dragging agents into an order, in a real browser.
//
// The vm slice in tests/test_agent_order.js covers the stored order and what a bad one does. What
// it cannot see is the gesture that writes it: the sheet is DOM and pointer events, and the whole
// reason it is a sheet rather than handles on the cards is that #agents has its innerHTML
// rewritten on every poll. A drag that survives one of those is the thing under test here, and
// only a browser can hold a pointer down across it.
//
//   npx playwright test agent_order
const {test, expect} = require('./fixtures');

// The fake herdr's three agents, in the order it reports them. `scratch` is the working one and
// the other two are idle, which is what makes this fixture worth naming: the main page groups by
// status, so an order set across all three shows up as two of them swapping inside Idle.
const SNAPSHOT = ['Architect 1', 'scratch', 'amp', 'build watch', 'charts'];
const GROUPED = ['scratch', 'Architect 1', 'amp'];

const rows = page => page.locator('#orderRows .order-row');
const names = page => rows(page).evaluateAll(els => els.map(e => e.querySelector('.name').textContent));
// What the main page lists, top to bottom. Read off the aria-label, whose first field is the pane
// name — .project carries the agent emoji and the host too, which is chrome and not identity.
const cards = page => page.locator('#agents .agent')
  .evaluateAll(els => els.map(e => e.getAttribute('aria-label').split(',')[0]));
const tabs = page => page.locator('#agentTabs .agent-tab .label')
  .evaluateAll(els => els.map(e => e.textContent));

const backdrop = page => page.locator('#orderSheet > div').first();

async function openSheet(page) {
  await page.getByRole('button', {name: 'Reorder tabs'}).click();
  await expect(page.locator('#orderSheet')).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
}

// A mouse may grab the whole row. Touch keeps using the grip so a long sheet still scrolls.
async function drag(page, from, to) {
  const a = await rows(page).nth(from).boundingBox();
  const b = await rows(page).nth(to).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {steps: 6});
  await page.mouse.up();
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

test('the sheet lists the live agents, and out of the box changes nothing', async ({page}) => {
  expect(await cards(page)).toEqual(GROUPED);
  await openSheet(page);
  // Flat and in snapshot order — the sheet is the order itself, not the page's view of it.
  expect(await names(page)).toEqual(SNAPSHOT);

  await backdrop(page).click();
  await expect(page.locator('#orderSheet')).toBeHidden();
  expect(await cards(page), 'opening and closing is not a change').toEqual(GROUPED);
});

test('rows identify agents and terminals without making the second line compete with the name', async ({page}) => {
  await openSheet(page);
  const agent = rows(page).filter({hasText: 'Architect 1'});
  const terminal = rows(page).filter({hasText: 'build watch'});
  await expect(agent.locator('.kind .agent-glyph')).toBeVisible();
  await expect(agent.locator('.meta .badge')).toHaveText('claude');
  await expect(terminal.locator('.kind')).toHaveText('⬛');
  await expect(terminal.locator('.meta')).toContainText('charts/relay');
  const sizes = await agent.evaluate(el => [
    parseFloat(getComputedStyle(el.querySelector('.name')).fontSize),
    parseFloat(getComputedStyle(el.querySelector('.meta')).fontSize),
  ]);
  expect(sizes[1], 'metadata is smaller than the pane name').toBeLessThan(sizes[0]);
});

test('dragging a row to the top reorders tabs and survives a reload', async ({page}) => {
  await openSheet(page);
  await drag(page, 2, 0);              // amp, to the front
  expect(await names(page)).toEqual(['amp', 'Architect 1', 'scratch', 'build watch', 'charts']);
  expect(await tabs(page), 'terminal shares the reordered bottom tab strip')
    .toEqual(['amp', 'Architect 1', 'scratch', 'build watch', 'charts']);

  await backdrop(page).click();
  // Cards are deliberately most-recently-active first; tab order never moves this live feed.
  expect(await cards(page)).toEqual(GROUPED);

  await page.reload();
  await expect(page.locator('#agents .agent').first()).toBeVisible();
  expect(await tabs(page), "the tab order is this browser's and outlives the tab")
    .toEqual(['amp', 'Architect 1', 'scratch', 'build watch', 'charts']);
  expect(await cards(page), 'cards remain newest-first after reload').toEqual(GROUPED);
});

test('a poll arriving mid-drag does not move the row under the pointer', async ({page}) => {
  // Why this is a sheet at all. #agents is rewritten wholesale every few seconds; if the rows were
  // those nodes, a snapshot landing between pointerdown and pointerup would replace the element
  // the pointer had captured and the drag would end nowhere.
  await openSheet(page);
  const a = await rows(page).nth(0).locator('.grip').boundingBox();
  const b = await rows(page).nth(2).boundingBox();

  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {steps: 4});
  await page.evaluate(() => render());   // the poll, at the worst possible moment
  await page.mouse.up();

  expect(await names(page)).toEqual(['scratch', 'amp', 'Architect 1', 'build watch', 'charts']);
});

test('a desktop mouse drags the whole row; touch keeps a right-side grip for scrolling', async ({page}) => {
  await openSheet(page);
  const a = await rows(page).nth(2).locator('.name').boundingBox();
  const b = await rows(page).nth(0).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {steps: 6});
  await page.mouse.up();
  expect(await names(page), 'a desktop row drag reorders').toEqual(['amp', 'Architect 1', 'scratch', 'build watch', 'charts']);

  const touch = await rows(page).nth(0).evaluate(el => {
    const grip = el.querySelector('.grip');
    const row = el.getBoundingClientRect(), handle = grip.getBoundingClientRect();
    return [getComputedStyle(el).touchAction, getComputedStyle(grip).touchAction, handle.right, row.right];
  });
  expect(touch.slice(0, 2), 'the row scrolls, the grip does not').toEqual(['auto', 'none']);
  expect(touch[2], 'grip is on the right edge').toBeCloseTo(touch[3], 0);
});

test('the arrow keys move a focused row, for anyone without a pointer', async ({page}) => {
  await openSheet(page);

  await rows(page).nth(1).focus();
  await page.keyboard.press('ArrowUp');
  expect(await names(page)).toEqual(['scratch', 'Architect 1', 'amp', 'build watch', 'charts']);
  // Focus follows the row it moved, or a second press acts on whatever slid into its place.
  await expect(rows(page).nth(0)).toBeFocused();

  await page.keyboard.press('ArrowUp');
  expect(await names(page), 'the top row has nowhere to go').toEqual(['scratch', 'Architect 1', 'amp', 'build watch', 'charts']);
  await page.keyboard.press('ArrowDown');
  expect(await names(page)).toEqual(SNAPSHOT);
});

test('Reset puts the snapshot order back', async ({page}) => {
  await openSheet(page);
  await drag(page, 2, 0);
  expect(await names(page)).toEqual(['amp', 'Architect 1', 'scratch', 'build watch', 'charts']);

  await page.getByRole('button', {name: 'Reset to default tab order'}).click();
  expect(await names(page)).toEqual(SNAPSHOT);
  await backdrop(page).click();
  expect(await cards(page)).toEqual(GROUPED);
});

test('a terminal can move to the front of the bottom tab strip', async ({page}) => {
  await openSheet(page);
  await drag(page, 4, 0);              // charts terminal, to the front
  expect(await names(page)).toEqual(['charts', 'Architect 1', 'scratch', 'amp', 'build watch']);
  expect(await tabs(page)).toEqual(['charts', 'Architect 1', 'scratch', 'amp', 'build watch']);

  // Terminal cards are also the newest-first landing feed, independent of stable tab positions.
  await backdrop(page).click();
  const terminals = await page.locator('#terminals .agent')
    .evaluateAll(els => els.map(e => e.getAttribute('aria-label').split(',')[0]));
  expect(terminals).toEqual(['Terminal build watch', 'Terminal charts']);
});
