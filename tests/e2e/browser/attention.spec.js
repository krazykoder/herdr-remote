// What a pane that needs you looks like, in a real browser.
//
// The vm slice in tests/test_attention.js covers the predicate and the acking rule. What it cannot
// see is the five surfaces the predicate feeds — the hoist, the card, the Space chips, the pane
// strip, and the browser tab — or that they agree with each other. The fake herdr reports no
// blocked or done pane, so the status is set on the client and the socket is silenced first:
// otherwise the next real snapshot lands mid-assertion and puts the status back.
//
//   npx playwright test
const {test, expect} = require('@playwright/test');

const AGENT = 'Architect 1';   // w1:p1, which the fake herdr reports idle
const PANE = 'w1:p1';

// Stops the relay overwriting what the test just set, then re-renders from the local state. The
// render path is the real one — only the arrival of the status is synthesised. Snapshots are
// dropped rather than the whole socket being silenced: pane_content still has to arrive, or
// opening a pane never finishes loading.
async function freezeWith(page, status) {
  await page.evaluate(([pane, s]) => {
    const pass = ws.onmessage;
    ws.onmessage = e => {
      const type = JSON.parse(e.data).type;
      if (type !== 'agents' && type !== 'agent_update') pass(e);
    };
    agents.find(a => a.pane_id === pane).status = s;
    render();
  }, [PANE, status]);
}

const faviconFill = page => page.evaluate(
  // Either quote: the icon in <head> is written by hand and the swapped-in one by a template.
  () => decodeURIComponent(document.getElementById('favicon').getAttribute('href'))
    .match(/circle[^>]*fill=['"]([^'"]+)/)[1]);

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

test('a blocked pane is hoisted, highlighted, and listed once', async ({page}) => {
  await freezeWith(page, 'blocked');

  const hoist = page.locator('#agents .section-header', {hasText: 'Needs you'});
  await expect(hoist).toBeVisible();
  await expect(hoist).toContainText('(1)');
  await expect(page.locator('#agents .agent.attention')).toHaveCount(1);
  await expect(page.locator('#agents .agent.attention')).toContainText(AGENT);
  // Red, not the done variant: the two are told apart by class, and that class is what carries
  // both the colour and the blink.
  await expect(page.locator('#agents .agent.attention.alert-done')).toHaveCount(0);
  // Hoisted means moved, not copied. Repeating it below is the bug this guards.
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toHaveCount(1);
});

test('a done pane is marked where it sits, and never claims to need you', async ({page}) => {
  // The other half of the split. A finished agent is worth a badge and worth reading, but it is
  // not waiting on an answer — hoisting it into "Needs you" in red is what made that header stop
  // meaning anything, because on a busy herd almost everything is finished.
  await freezeWith(page, 'done');

  await expect(page.locator('#agents .section-header', {hasText: 'Needs you'})).toHaveCount(0);
  await expect(page.locator('#agents .section-header', {hasText: 'Done'})).toBeVisible();
  // Still marked, still unacked — in blue, and holding still.
  const card = page.locator('#agents .agent.attention');
  await expect(card).toHaveCount(1);
  await expect(card).toHaveClass(/alert-done/);
  await expect(card).toContainText(AGENT);
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toHaveCount(1);
});

// The badge itself lives on the pane strip and the chips, not on the card — the card says it with
// its border. Both are read computed rather than off the class, so a stylesheet that stops
// honouring the modifier fails here instead of shipping.
test('the blink belongs to blocked, and blue belongs to done', async ({page}) => {
  const badge = page.locator('#agentTabs .agent-tab.alert');
  const after = () => badge.evaluate(el => {
    const s = getComputedStyle(el, '::after');
    return {animation: s.animationName, background: s.backgroundColor};
  });

  await freezeWith(page, 'blocked');
  const red = await after();
  expect(red.animation, 'a blocked pane sits still').toBe('attention');
  expect(red.background).toBe('rgb(247, 118, 142)');      // --red

  await freezeWith(page, 'done');
  const blue = await after();
  expect(blue.animation, 'a finished pane is blinking at you').toBe('none');
  expect(blue.background).toBe('rgb(122, 162, 247)');      // --blue
});

test('the Space chip and the pane strip carry the same badge', async ({page}) => {
  await expect(page.locator('.chip.alert')).toHaveCount(0);
  await freezeWith(page, 'done');

  // w1 is the Space Architect 1 lives in; the other Spaces must stay quiet.
  await expect(page.locator('.chip-strip .chip.alert')).toHaveCount(1);

  // The strip is built on the list screen too — it is display:none there, not unbuilt — so this
  // is checked without opening a pane, which would ack the very badge under test.
  await expect(page.locator('#agentTabs .agent-tab.alert')).toHaveCount(1);
  await expect(page.locator('#agentTabs .agent-tab.alert')).toHaveAttribute('data-pane', PANE);
});

test('the browser tab counts both, and turns red only for blocked', async ({page}) => {
  await expect(page).toHaveTitle('herdr-remote');
  expect(await faviconFill(page)).toBe('#7aa2f7');

  // A finished pane is counted — it is still something you have not read — but it does not turn
  // the icon red. Red is the tab saying an agent cannot go on without you, and spending it on
  // "one of your agents finished" is what leaves it ignored when it matters.
  await freezeWith(page, 'done');
  await expect(page).toHaveTitle('(1) herdr-remote');
  expect(await faviconFill(page)).toBe('#7aa2f7');

  await page.evaluate(() => {
    agents.find(a => a.pane_id === 'w8:p1').status = 'blocked';
    render();
  });
  await expect(page).toHaveTitle('(2) herdr-remote');
  expect(await faviconFill(page), 'the favicon is the half that survives a truncated title')
    .toBe('#f7768e');
});

test('opening the pane clears it everywhere at once', async ({page}) => {
  await freezeWith(page, 'done');
  await expect(page).toHaveTitle('(1) herdr-remote');

  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');

  await expect(page).toHaveTitle('herdr-remote');
  expect(await faviconFill(page)).toBe('#7aa2f7');
  await expect(page.locator('#agentTabs .agent-tab.alert')).toHaveCount(0);
  await page.locator('#termBack').click();
  await expect(page.locator('#agents .agent.attention')).toHaveCount(0);
  await expect(page.locator('#agents .section-header', {hasText: 'Needs you'})).toHaveCount(0);
});

test('sound is synthesised in the page, not fetched', async ({page, context}) => {
  // The file's whole property is being self-contained. This used to be an ES module import from a
  // CDN, so a LAN relay with no route out, a strict CSP, or an offline PWA launch left the app
  // silent — and silently, since every call site is guarded with `if (window.cue)`.
  const external = [];
  context.on('request', r => { if (new URL(r.url()).host !== new URL(page.url()).host) external.push(r.url()); });
  await page.reload();
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  expect(external, 'the page reached off-host').toEqual([]);

  // Defined synchronously, which the module version was not — its first cues never played.
  expect(await page.evaluate(() => typeof window.cue)).toBe('function');
  // Every name any call site uses, played for real. Chromium runs headless with no output device,
  // so what is under test is that the graph builds and nothing throws.
  const threw = await page.evaluate(() => {
    for (const n of ['tick', 'toggle', 'page', 'droplet', 'success', 'ready', 'sparkle', 'error', 'chime']) {
      try { cue(n); } catch (e) { return `${n}: ${e}`; }
    }
    return null;
  });
  expect(threw).toBeNull();
});

test('the ack survives a reload, and the pane is listed normally again', async ({page}) => {
  await freezeWith(page, 'done');
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');

  await page.reload();
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  // The real relay reports it idle again, so the stored ack is now stale and syncAcked drops it.
  // What must not happen is the badge coming back for a status nobody has looked at since.
  await expect(page).toHaveTitle('herdr-remote');
  await expect(page.locator('#agents .agent.attention')).toHaveCount(0);
});
