// The main page's sections, ordered by the user, in a real browser.
//
// The vm slice in tests/test_sections.js covers the stored order and the rules around it against a
// stub DOM. What it cannot see is the only thing that matters to a reader: whether the page is
// actually painted in that order. Order is a flex property, so the DOM stays in source order and
// nothing but layout tells you it worked — a stub that records style.order would agree with a
// stylesheet that had never been given `display: flex` at all.
//
//   npx playwright test sections
const {test, expect} = require('./fixtures');

const AGENT = 'Architect 1';

// Where each section's box actually sits on screen, top first. Empty sections are absent, which is
// what makes this readable as "what the user sees" rather than "what the DOM holds".
async function painted(page) {
  return page.evaluate(() => ['agents', 'terminals', 'pairs', 'recents']
    .map(id => document.getElementById(id))
    .filter(el => el.offsetParent !== null && el.getBoundingClientRect().height > 0)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map(el => el.id));
}

const setSections = (page, order) => page.evaluate(o => {
  localStorage.setItem('herdr_sections', JSON.stringify(o));
}, order);

// Every section's cards start on one left edge. Conversations arrived last and was the one
// section never added to the rule that gives the others their outer spacing, which put its cards
// and its header 12px left of everything above them.
test('every landing section starts on the same left edge', async ({page}) => {
  await page.goto('/');
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  await page.evaluate(() => {
    for (const id of ['terminals', 'recents', 'conversations']) toggleSection(id, true);
    renderBody();
    renderConversations();
  });
  const edges = await page.evaluate(() => {
    const at = sel => {
      const el = document.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().x) : null;
    };
    return {
      agent: at('#agents .agent'),
      terminal: at('#terminals .agent'),
      conversation: at('#conversations .conversation-card'),
      header: at('#conversations .section-header'),
      agentHeader: at('#agents .section-header'),
    };
  });
  expect(new Set(Object.values(edges).filter(x => x !== null)).size).toBe(1);
});

test.beforeEach(async ({page}) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors;
  await page.goto('/');
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
});

test.afterEach(async ({page}) => {
  expect(page.__errors, 'the page logged errors').toEqual([]);
});

test('out of the box the page is laid out the way it always was', async ({page}) => {
  // Agents then Terminals. Pairs and Recents are empty until the user creates one or opens a pane.
  expect(await painted(page)).toEqual(['agents', 'terminals']);
  await expect(page.locator('#terminals .section-header')).toHaveText('Terminals');
});

test('a stored order is what the page is painted in', async ({page}) => {
  await setSections(page, ['terminals', 'agents']);
  await page.reload();
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();

  expect(await painted(page)).toEqual(['terminals', 'agents']);
  // Ordered, not moved: the DOM is still in source order, which is what keeps renderBody's
  // innerHTML rewrites from fighting the layout.
  const domOrder = await page.evaluate(() =>
    [...document.getElementById('agentListView').children].map(el => el.id));
  expect(domOrder).toEqual(['agents', 'terminals', 'pairs', 'recents', 'conversations']);
});

// Settings is a panel over the list, not beside it, so the list is display:none while it is open
// and nothing in it can be measured. Every check of the layout happens with the panel shut.
const settings = page => page.locator('#navSettings');

test('switching a section off takes it off the page, and on again puts it last', async ({page}) => {
  await settings(page).click();
  const agents = page.locator('#sectionAgents');
  await expect(agents).toBeChecked();

  await agents.uncheck();
  await settings(page).click();
  expect(await painted(page)).toEqual(['terminals']);

  await settings(page).click();
  await agents.check();
  await settings(page).click();
  // Appended, so it now sits after Terminals rather than returning to the top. This is the whole
  // ordering gesture — there is no drag handle.
  expect(await painted(page)).toEqual(['terminals', 'agents']);
});

test('the last section on cannot be switched off', async ({page}) => {
  await setSections(page, ['agents']);
  await page.reload();
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  await settings(page).click();

  await expect(page.locator('#sectionAgents')).toBeChecked();
  await expect(page.locator('#sectionAgents'), 'the box refuses before it is tried').toBeDisabled();
  await expect(page.locator('#sectionTerminals')).not.toBeDisabled();
});

// Pairs the first two local agents and reloads into it. The relay's fake herdr reports no pair, so
// this is stored the way the pane menu would have stored it rather than driven through the dialog —
// what is under test here is the landing section, not the dialog that fills it.
async function addPair(page) {
  await page.evaluate(() => {
    const [left, right] = agents.filter(a => (a.host || 'local') === 'local').slice(0, 2);
    localStorage.setItem('herdr_pairs', JSON.stringify({version: 1, pairs: [{
      id: 'p_landing', name: 'Landing pair', members: [fingerprint(left, paneLabel(left)), fingerprint(right, paneLabel(right))],
    }]}));
  });
  await page.reload();
  await expect(page.locator('#pairs .pair-row')).toBeVisible();
}

test('a healthy pair gets two cards and a link', async ({page}) => {
  await addPair(page);
  await expect(page.locator('#pairs')).toBeVisible();
  await expect(page.locator('#pairs .pair-row')).toHaveCount(1);
  await expect(page.locator('#pairs .pair-row .agent')).toHaveCount(2);
  await expect(page.locator('#pairs .pair-link')).toHaveText('↔');
  // The ordinary cards keep the Pair button that opens the dialog; inside a pair row it is the one
  // thing the row already says, so it is the width that gets spent on the name instead.
  await expect(page.locator('#agents .agent .pair-btn').first()).toBeVisible();
  await page.locator('#navSettings').click();
  const pairs = page.locator('#sectionPairs');
  await expect(pairs).toBeChecked();
  await pairs.uncheck();
  await page.locator('#navSettings').click();
  await expect(page.locator('#pairs')).toBeHidden();
  await page.locator('#navSettings').click();
  await pairs.check();
  await page.locator('#navSettings').click();
  await expect(page.locator('#pairs')).toBeVisible();
});

test('a pair sits side by side at every width, phone included', async ({page}) => {
  // Two agents working together is what a pair is, and a stacked pair says nothing a plain list
  // does not. A phone leaves each card about 160px, so inside a pair row the card drops what the
  // row already says — the Pair button, and on the narrowest screens the chevron — and spends the
  // width on the name and its badges instead.
  await addPair(page);
  const boxes = () => page.locator('#pairs .pair-row .agent')
    .evaluateAll(cards => cards.map(c => c.getBoundingClientRect()));

  for (const width of [390, 1024]) {
    await page.setViewportSize({width, height: 900});
    const [left, right] = await boxes();
    expect(right.left, `side by side at ${width}`).toBeGreaterThanOrEqual(left.right);
    // Same height, because the two are one unit — ragged heights read as two separate lists.
    expect(Math.round(left.height), `level at ${width}`).toBe(Math.round(right.height));
    // And neither is squeezed to the point of wrapping into a third line.
    expect(left.height, `unwrapped at ${width}`).toBeLessThan(90);
  }

  await page.setViewportSize({width: 390, height: 900});
  await expect(page.locator('#pairs .pair-row .pair-btn').first()).toBeHidden();
  await page.setViewportSize({width: 1024, height: 900});
  await expect(page.locator('#pairs .pair-row .pair-btn').first()).toBeVisible();
});

test('every section lays its cards out the same way', async ({page}) => {
  // They are interchangeable in the column, so the page must not change shape depending on
  // which one is read first. Terminals used to be a child of .agents and inherited its responsive
  // grid for free; pulling it out into its own orderable node dropped that, and it went full-width
  // beside a two-column grid of agent cards without a single test noticing.
  await page.setViewportSize({width: 1024, height: 900});
  await page.locator('#agents .agent', {hasText: AGENT}).click();   // fills Recents
  await page.locator('.term-header .back').click();
  expect(await painted(page)).toEqual(['agents', 'terminals', 'recents']);

  const columns = page.evaluate(() => ['agents', 'terminals', 'recents']
    .map(id => getComputedStyle(document.getElementById(id)).gridTemplateColumns));
  const [agentCols, ...rest] = await columns;
  expect(agentCols, 'the reference is a real multi-column grid').toMatch(/px \d/);
  for (const cols of rest) expect(cols).toBe(agentCols);
});

test('the order survives a reload', async ({page}) => {
  await settings(page).click();
  await page.locator('#sectionAgents').uncheck();
  await page.locator('#sectionAgents').check();
  await settings(page).click();
  expect(await painted(page)).toEqual(['terminals', 'agents']);

  await page.reload();
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  expect(await painted(page)).toEqual(['terminals', 'agents']);
});
