// The recent switcher, in a real browser: the one control in the app's last row.
//
// It exists because the landing page's Recents section can only be reached from the landing page,
// and "put me back where I was" is not a question about the screen it is asked from. So what these
// tests are for is the *reach* of it — the button being on screen in every view, and the list
// holding terminals as well as agents — none of which a vm slice can see.
//
//   npx playwright test tests/e2e/browser/recent.spec.js
const {test, expect} = require('./fixtures');

const AGENT = 'Architect 1';
const OTHER = 'scratch';

test.beforeEach(async ({page}) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors;
  await page.goto('/');
  // The list is the live snapshot, so nothing is recent until the first one has landed.
  await expect(page.locator('#agents .agent').first()).toBeVisible();
});

test.afterEach(async ({page}) => {
  expect(page.__errors, 'the page logged errors').toEqual([]);
});

const openPane = async (page, label) => {
  await page.locator('#agents .agent', {hasText: label}).first().click();
  await expect(page.locator('#terminalView')).toBeVisible();
};

const rows = page => page.locator('#recentList .pair-pick');

test('the button is in the last row of every view', async ({page}) => {
  const btn = page.locator('#statusBar .recent-btn');
  // The landing page.
  await expect(btn).toBeVisible();
  await openPane(page, AGENT);
  await expect(btn).toBeVisible();
  // A conversation window, which replaces the whole screen above the bar.
  await page.evaluate(() => {
    const key = convMemberKey(paneOf(activePane));
    saveConvIndex([{id: 'c1', name: 'a thread', created: Date.now(),
      members: [{key, added: 1, label: 'Architect 1'}]}]);
  });
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card[data-conv-id="c1"]').click();
  await expect(page.locator('#convView')).toBeVisible();
  await expect(btn).toBeVisible();
  // Settings, which is a panel over everything else.
  await page.locator('#navSettings').click();
  await expect(btn).toBeVisible();
});

test('the button is centred on the screen, not on what is left of the bar', async ({page}) => {
  await openPane(page, AGENT);
  // The left half of this bar is a timestamp that changes on every read, so a button placed after
  // it would move under the thumb between one read and the next.
  const bar = await page.locator('#statusBar').boundingBox();
  const btn = await page.locator('#statusBar .recent-btn').boundingBox();
  expect(Math.abs((btn.x + btn.width / 2) - (bar.x + bar.width / 2))).toBeLessThan(2);
});

test('the list is every live pane, most recently opened first', async ({page}) => {
  await openPane(page, AGENT);
  await page.locator('.term-header .back').click();
  await openPane(page, OTHER);
  await page.locator('#statusBar .recent-btn').click();
  const names = await rows(page).locator('.name').allTextContents();
  // The one just left is first, the one before it second: this is a visit log, not the agent list
  // in another sheet.
  expect(names[0]).toContain(OTHER);
  expect(names[1]).toContain(AGENT);
  // And a pane this device has never opened is still reachable from here — it simply sorts after
  // the ones that were.
  expect(names.length).toBe(await page.evaluate(() => agents.length + shells.length));
});

test('terminals are in it too, and the row says which is which', async ({page}) => {
  await page.locator('#statusBar .recent-btn').click();
  const agentCount = await page.evaluate(() => agents.length);
  await expect(rows(page).filter({has: page.locator('.kind .agent-glyph')})).toHaveCount(agentCount);
  const shell = rows(page).filter({hasText: 'build watch'});
  await expect(shell).toHaveCount(1);
  await expect(shell.locator('.kind')).toHaveText('⬛');
  await expect(shell.locator('.meta')).toContainText('/work/charts/relay');
});

test('a conversation visited is in the same list, in the same order', async ({page}) => {
  await openPane(page, AGENT);
  await page.evaluate(() => {
    const key = convMemberKey(paneOf(activePane));
    saveConvIndex([{id: 'c1', name: 'a thread', created: Date.now(),
      members: [{key, added: 1, label: 'Architect 1'}]}]);
  });
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card[data-conv-id="c1"]').click();
  await expect(page.locator('#convView')).toBeVisible();
  await page.locator('#statusBar .recent-btn').click();
  // The conversation was the last thing opened, so it is first — above the pane that was open
  // before it. One order for both kinds: "where was I" has one answer.
  const names = await rows(page).locator('.name').allTextContents();
  expect(names[0]).toContain('a thread');
  expect(names[1]).toContain(AGENT);
  // Drawn, not typed: the mark is an SVG taking currentColor, so its colour is the stylesheet's
  // and not the emoji font's — which is what "green" could not be while it was a codepoint.
  await expect(rows(page).first().locator('.kind .conv-glyph')).toBeVisible();
  const [mark, green] = await rows(page).first().locator('.kind').evaluate(el => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--green)';
    el.appendChild(probe);
    const pair = [getComputedStyle(el).color, getComputedStyle(probe).color];
    probe.remove();
    return pair;
  });
  expect(mark).toBe(green);
  await expect(rows(page).first().locator('.meta')).toContainText('1 pane · 1 live');
  // Only visited ones: every conversation is already one tap away on the landing page.
  await page.evaluate(() => {
    const items = loadConvIndex();
    items.push({id: 'c2', name: 'never opened', created: Date.now(), members: []});
    saveConvIndex(items);
  });
  await page.locator('#recentSheet .pair-pick').first().click();
  await page.locator('#statusBar .recent-btn').click();
  expect(await rows(page).filter({hasText: 'never opened'}).count()).toBe(0);
});

test('a conversation row opens the conversation, not a pane', async ({page}) => {
  await openPane(page, AGENT);
  await page.evaluate(() => {
    const key = convMemberKey(paneOf(activePane));
    saveConvIndex([{id: 'c1', name: 'a thread', created: Date.now(),
      members: [{key, added: 1, label: 'Architect 1'}]}]);
    openConversation('c1');
  });
  await expect(page.locator('#convView')).toBeVisible();
  // Then a pane, so the conversation is not the most recent thing and the row has to be found.
  await page.evaluate(o => openTerminal(agents.find(a => a.label === o).pane_id), OTHER);
  await expect(page.locator('#terminalView')).toBeVisible();
  await page.locator('#statusBar .recent-btn').click();
  await rows(page).filter({hasText: 'a thread'}).click();
  await expect(page.locator('#recentSheet')).toBeHidden();
  await expect(page.locator('#convView')).toBeVisible();
  await expect(page.locator('#convViewTitle')).toHaveText('a thread');
});

test('a row opens that pane and closes the sheet', async ({page}) => {
  await page.locator('#statusBar .recent-btn').click();
  await rows(page).filter({hasText: OTHER}).first().click();
  await expect(page.locator('#recentSheet')).toBeHidden();
  await expect(page.locator('#terminalView')).toBeVisible();
  await expect(page.locator('.term-header')).toContainText(OTHER);
});

test('the open pane is marked rather than missing, and the sheet closes on a tap past it',
  async ({page}) => {
    await openPane(page, AGENT);
    await page.locator('#statusBar .recent-btn').click();
    await expect(rows(page).filter({hasText: AGENT})).toHaveClass(/ on\b|\bon$/);
    await page.locator('#recentSheet > div').first().click();
    await expect(page.locator('#recentSheet')).toBeHidden();
  });
