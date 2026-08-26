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

// Closed, the control is the left part of the same bar — so the glyph has to be inside it. The
// icon is positioned against the box, which is full width in both states, so a rule that placed
// it against the *field* is the one thing that can silently put it out in the middle of the page.
test('the closed search pill keeps its icon, and grows from it', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('/');
  await expect(page.locator('#agents .agent').first()).toBeVisible();

  const shut = await page.locator('#landingSearchInput').boundingBox();
  const icon = await page.locator('.landing-search-icon').boundingBox();
  expect(icon.x, 'the glyph sits outside the pill').toBeGreaterThanOrEqual(shut.x);
  expect(icon.x + icon.width).toBeLessThanOrEqual(shut.x + shut.width);
  expect(icon.y).toBeGreaterThanOrEqual(shut.y);

  await page.locator('#landingSearchInput').focus();
  // The width is animated, so the first measurement after focus is a frame of the transition.
  await expect.poll(async () =>
    (await page.locator('#landingSearchInput').boundingBox()).width)
    .toBeGreaterThan(shut.width);
  const open = await page.locator('#landingSearchInput').boundingBox();
  expect(open.height, 'the height changes with the state').toBe(shut.height);
  expect(open.x, 'it grows from somewhere else').toBe(shut.x);
});
