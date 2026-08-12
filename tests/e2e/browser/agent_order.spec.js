// Dragging agents into an order, in a real browser.
//
// The vm slice in tests/test_agent_order.js covers the stored order and what a bad one does. What
// it cannot see is the gesture that writes it: the sheet is DOM and pointer events, and the whole
// reason it is a sheet rather than handles on the cards is that #agents has its innerHTML
// rewritten on every poll. A drag that survives one of those is the thing under test here, and
// only a browser can hold a pointer down across it.
//
//   npx playwright test agent_order
const {test, expect} = require('@playwright/test');

// The fake herdr's three agents, in the order it reports them. `scratch` is the working one and
// the other two are idle, which is what makes this fixture worth naming: the main page groups by
// status, so an order set across all three shows up as two of them swapping inside Idle.
const SNAPSHOT = ['Architect 1', 'scratch', 'amp'];
const GROUPED = ['scratch', 'Architect 1', 'amp'];

const rows = page => page.locator('#orderRows .order-row');
const names = page => rows(page).evaluateAll(els => els.map(e => e.querySelector('.name').textContent));
// What the main page lists, top to bottom. Read off the aria-label, whose first field is the pane
// name — .project carries the agent emoji and the host too, which is chrome and not identity.
const cards = page => page.locator('#agents .agent')
  .evaluateAll(els => els.map(e => e.getAttribute('aria-label').split(',')[0]));

const backdrop = page => page.locator('#orderSheet > div').first();

async function openSheet(page) {
  await page.locator('#navSettings').click();
  await page.getByRole('button', {name: 'Reorder agents…'}).click();
  await expect(page.locator('#orderSheet')).toBeVisible();
  await expect(rows(page).first()).toBeVisible();
}

// Drags row `from` onto row `to`'s slot, the way a finger would: press, several moves, release.
// From the grip, because that is the only part of the row that drags — the rest is left to the
// browser so a sheet longer than the screen can still be scrolled by touch.
async function drag(page, from, to) {
  const a = await rows(page).nth(from).locator('.grip').boundingBox();
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

test('dragging a row to the top reorders the main page, and it survives a reload', async ({page}) => {
  await openSheet(page);
  await drag(page, 2, 0);              // amp, to the front
  expect(await names(page)).toEqual(['amp', 'Architect 1', 'scratch']);

  await backdrop(page).click();
  // Status still wins — scratch is working and stays hoisted above the idle pair. What the drag
  // decided is the order *inside* Idle, which is the promise the sheet's own hint makes.
  expect(await cards(page)).toEqual(['scratch', 'amp', 'Architect 1']);

  await page.reload();
  await expect(page.locator('#agents .agent').first()).toBeVisible();
  expect(await cards(page), "the order is this browser's and outlives the tab")
    .toEqual(['scratch', 'amp', 'Architect 1']);
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

  expect(await names(page)).toEqual(['scratch', 'amp', 'Architect 1']);
});

test('only the grip drags, so a sheet longer than the screen can still be scrolled', async ({page}) => {
  // touch-action: none has to be somewhere or iOS pans the page out from under the gesture. On the
  // whole row it would mean every finger landing on the list lands on something that refuses to
  // scroll, and a user with more agents than fit could not reach the rest of them.
  await openSheet(page);
  const a = await rows(page).nth(2).locator('.name').boundingBox();
  const b = await rows(page).nth(0).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, {steps: 6});
  await page.mouse.up();
  expect(await names(page), 'a drag off the grip moves nothing').toEqual(SNAPSHOT);

  const touch = await rows(page).nth(0).evaluate(el => [
    getComputedStyle(el).touchAction, getComputedStyle(el.querySelector('.grip')).touchAction]);
  expect(touch, 'the row scrolls, the grip does not').toEqual(['auto', 'none']);
});

test('the arrow keys move a focused row, for anyone without a pointer', async ({page}) => {
  await openSheet(page);

  await rows(page).nth(1).focus();
  await page.keyboard.press('ArrowUp');
  expect(await names(page)).toEqual(['scratch', 'Architect 1', 'amp']);
  // Focus follows the row it moved, or a second press acts on whatever slid into its place.
  await expect(rows(page).nth(0)).toBeFocused();

  await page.keyboard.press('ArrowUp');
  expect(await names(page), 'the top row has nowhere to go').toEqual(['scratch', 'Architect 1', 'amp']);
  await page.keyboard.press('ArrowDown');
  expect(await names(page)).toEqual(SNAPSHOT);
});

test('Reset puts the snapshot order back', async ({page}) => {
  await openSheet(page);
  await drag(page, 2, 0);
  expect(await names(page)).toEqual(['amp', 'Architect 1', 'scratch']);

  await page.getByRole('button', {name: 'Reset to default order'}).click();
  expect(await names(page)).toEqual(SNAPSHOT);
  await backdrop(page).click();
  expect(await cards(page)).toEqual(GROUPED);
});
