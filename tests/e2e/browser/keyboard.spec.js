// Every field in every sheet, above the on-screen keyboard.
//
//   npx playwright test keyboard
//
// A headless browser has no keyboard to summon, so this sets by hand the three numbers utils.js
// publishes when one appears — and sets them the way iOS Safari reports them, with the layout
// viewport scrolled down to reveal the field (`--vv-top`). That offset is the half a naive
// simulation misses: an overlay pinned with `inset: 0` is pinned to the layout viewport and does
// not follow the frame the user can see.
//
// The check is not "the sheet is short enough" but "focus each field in turn and it is visible
// after", which is what a person tapping down a form actually does.
const {test, expect} = require('./fixtures');

// A 390×844 phone with a 336px keyboard up, and Safari having scrolled 60px to reveal the field.
const KB = {top: 60, height: 508};

const summon = kb => {
  const r = document.documentElement.style;
  r.setProperty('--kb-inset', String(844 - kb.height - kb.top) + 'px');
  r.setProperty('--vv-height', kb.height + 'px');
  r.setProperty('--vv-top', kb.top + 'px');
};

// Each sheet, and what opens it with something in it. Anything that will not open is reported
// rather than skipped silently — a sheet that stopped opening is a worse bug than a low field.
const SHEETS = {
  pickSheet: () => openPanePicker({title: 'Pick', multi: true,
    groups: () => [{head: 'Panes', rows: agents.concat(shells).map(a => pickPaneRow(a))}],
    submit: () => {}}),
  convSheet: () => openConvDialog(agents[0].pane_id),
  cmdPalette: () => openPalette('prompts'),
  recentSheet: () => openRecentSheet(),
  orderSheet: () => openOrder(),
  launcherModal: () => {
    toggleSection('launcher', true);
    saveLauncher([{id: 'kb_x', label: 'Pair', action: 'spawn',
                   members: [{name: 'claude', at: 'architect-prompt'}, {name: 'codex'}]}]);
    renderLauncher();
    openLauncherEdit();
    launcherEditTile('kb_x');
  },
};

test('a field tapped in any sheet is visible after the keyboard takes half the screen', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await expect(page.locator('#agents .agent').first()).toBeVisible();
  await page.evaluate(summon, KB);

  for (const [id, open] of Object.entries(SHEETS)) {
    const out = await page.evaluate(async ([id, src, kb]) => {
      try { await eval(`(${src})()`); } catch (e) { return {id, err: String(e)}; }
      await new Promise(r => setTimeout(r, 100));
      const root = document.getElementById(id);
      if (!root || root.style.display === 'none') return {id, err: 'did not open'};
      const fields = [...root.querySelectorAll('input, textarea, select')]
        .filter(f => f.offsetParent !== null);
      const low = [];
      for (const f of fields) {
        f.focus();
        // The nudge in utils.js waits for the keyboard to finish animating before it measures.
        await new Promise(r => setTimeout(r, 260));
        const r = f.getBoundingClientRect();
        if (r.bottom > kb.top + kb.height || r.top < kb.top) {
          low.push((f.id || f.tagName) + ' at ' + Math.round(r.top) + '–' + Math.round(r.bottom));
        }
      }
      return {id, fields: fields.length, low};
    }, [id, open.toString(), KB]);

    expect(out.err, `${id} did not open`).toBeUndefined();
    expect(out.low, `${id}: fields behind the keyboard`).toEqual([]);
    await page.evaluate(id => {
      const n = document.getElementById(id);
      if (n) n.style.display = 'none';
      if (typeof picker !== 'undefined') picker = null;
    }, id);
  }
});

test('the landing search bubble is above the keyboard too, results and all', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await expect(page.locator('#agents .agent').first()).toBeVisible();
  await page.evaluate(summon, KB);
  await page.fill('#landingSearchInput', 'a');
  await expect(page.locator('#landingSearchResults .pair-pick').first()).toBeVisible();

  const seen = KB.top + KB.height;
  const bubble = await page.locator('#landingSearchInput').boundingBox();
  const results = await page.locator('#landingSearchResults').boundingBox();
  expect(bubble.y + bubble.height, 'the box types from behind the keyboard').toBeLessThanOrEqual(seen);
  expect(results.y, 'the results run up under the header').toBeGreaterThanOrEqual(KB.top);
  expect(results.y + results.height).toBeLessThanOrEqual(bubble.y + 1);
});

// Closed, the control is a short pill centred over the page — with its glyph and its one-word
// prompt inside it. The icon and the field are separate nodes in one wrapper, which is the thing
// that can silently come apart: a rule that sized the wrong one puts the glyph outside the pill.
test('the closed search pill keeps its icon, and grows from the middle', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await expect(page.locator('#agents .agent').first()).toBeVisible();

  const shut = await page.locator('.landing-search-box').boundingBox();
  const icon = await page.locator('.landing-search-icon').boundingBox();
  expect(icon.x, 'the glyph sits outside the pill').toBeGreaterThanOrEqual(shut.x);
  expect(icon.x + icon.width).toBeLessThanOrEqual(shut.x + shut.width);
  expect(Math.abs(shut.x + shut.width / 2 - 195), 'off centre').toBeLessThanOrEqual(1);
  await expect(page.locator('#landingSearchInput')).toHaveAttribute('placeholder', 'Search');

  await page.locator('#landingSearchInput').focus();
  // The width is animated, so the first measurement after focus is a frame of the transition.
  await expect.poll(async () =>
    (await page.locator('.landing-search-box').boundingBox()).width)
    .toBeGreaterThan(shut.width);
  const open = await page.locator('.landing-search-box').boundingBox();
  expect(open.height, 'the height changes with the state').toBe(shut.height);
  expect(Math.abs(open.x + open.width / 2 - 195), 'it grows off centre').toBeLessThanOrEqual(1);
});

// A tap outside the results dismisses the search. On a phone the bar floats over the cards, so the
// same tap used to press whatever card was under it — the pane the reader was trying to get *away*
// from opened instead.
test.describe('on a touch screen', () => {
  test.use({hasTouch: true, viewport: {width: 390, height: 844}});

  test('a tap outside the open search closes it without pressing what is behind it', async ({page}) => {
    await page.goto('/');
    await expect(page.locator('#agents .agent').first()).toBeVisible();
    await page.locator('#landingSearchInput').fill('a');
    await expect(page.locator('#landingSearchResults .pair-pick').first()).toBeVisible();

    const card = await page.locator('#agents .agent').first().boundingBox();
    await page.touchscreen.tap(card.x + card.width / 2, card.y + card.height / 2);

    await expect(page.locator('#landingSearchResults')).toBeHidden();
    await expect(page.locator('#landingSearchInput')).toHaveValue('');
    await expect(page.locator('#agentListView'), 'the card under the tap was pressed').toBeVisible();
  });
});
