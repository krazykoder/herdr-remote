// The pane-view chrome, in a real browser: the composer fold, Last, the loading pill, the pulse,
// and the section headers that lost their dot.
//
// The vm slices in tests/test_bottom_dock.js cover the branches — which glyph, which flag, what is
// stored. None of them can see a stylesheet, so none can tell whether the fold actually removes
// the composer from the page, whether the pill lands over the pane instead of pushing it, or
// whether the pulse rule survives being written. That is what this file is for.
//
//   npx playwright test
const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Architect 1';
// A finished Claude pane, which is what puts Summary next to Last and doubles the right edge.
const DONE_PANE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'fixtures', 'pane_claude_done.txt'), 'utf8');
const WORKING = 'scratch';   // the fake herdr reports this one as working, so its dot pulses

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

test('section headers carry their word and nothing else', async ({page}) => {
  const header = page.locator('#agents .section-header').first();
  await expect(header).toBeVisible();
  expect(await page.locator('#agents .section-header .dot').count()).toBe(0);
  // The cards below still have theirs — a dot in that position means status, which is the whole
  // reason it had no business in a heading.
  expect(await page.locator('#agents .agent .dot').count()).toBeGreaterThan(0);
});

test('a working agent gets the size pulse, an idle one gets nothing', async ({page}) => {
  const dotOf = name => page.locator('#agents .agent', {hasText: name}).locator('.dot');
  await expect(dotOf(WORKING)).toBeVisible();
  const anim = await dotOf(WORKING).evaluate(el => {
    const cs = getComputedStyle(el);
    return {name: cs.animationName, duration: cs.animationDuration};
  });
  expect(anim.name).toBe('pulse');
  expect(anim.duration).toBe('1.4s');
  // Sampled across a full beat: the disc shrinks and comes back, and full size is the ceiling —
  // a pulsing dot must never read larger than a still one beside it.
  const scales = [];
  for (let i = 0; i < 24; i++) {
    scales.push(await dotOf(WORKING).evaluate(el => {
      const m = new DOMMatrix(getComputedStyle(el).transform);
      return m.a;
    }));
    await page.waitForTimeout(70);
  }
  expect(Math.max(...scales), 'the pulse grew past the resting diameter').toBeLessThanOrEqual(1.001);
  expect(Math.min(...scales), 'the pulse is not visible as a size change').toBeLessThan(0.7);
  await expect(dotOf(AGENT)).toHaveCSS('animation-name', 'none');
});

test('the v folds the composer away and leaves the quick actions bar', async ({page}) => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('.term-input')).toBeVisible();

  await page.locator('#quickActions .qa-fold').click();
  await expect(page.locator('.term-input')).toBeHidden();
  await expect(page.locator('#quickActions')).toBeVisible();
  await expect(page.locator('#quickActions .qa-fold')).toHaveText('^');
  // The pane takes the height the composer gave up rather than leaving a gap.
  await expect(page.locator('#quickActions .qa-last')).toBeVisible();

  await page.locator('#quickActions .qa-fold').click();
  await expect(page.locator('.term-input')).toBeVisible();
  await expect(page.locator('#quickActions .qa-fold')).toHaveText('v');
});

test('an open keys dock folds away with the rest of the stack', async ({page}) => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await page.locator('#keysBtn').click();
  await expect(page.locator('#termKeys')).toBeVisible();

  await page.locator('#quickActions .qa-fold').click();
  // The dock's own display is inline and still says "open" — the fold has to outrank it, which is
  // the one thing the !important in that rule is buying.
  await expect(page.locator('#termKeys')).toBeHidden();
});

test('the fold survives a reload', async ({page}) => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await page.locator('#quickActions .qa-fold').click();
  await expect(page.locator('.term-input')).toBeHidden();

  await page.reload();
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('.term-input')).toBeHidden();
  await expect(page.locator('#quickActions .qa-fold')).toHaveText('^');
});

// One DOM turn: renderQuickActions replaces this whole row, so separate locator measurements can
// straddle a poll and leave one detached even though all of them were visible on screen.
const navBoxes = page => page.locator('#quickActions .qa-nav').evaluate(el => {
  const box = node => {
    const {x, width} = node.getBoundingClientRect();
    return {x, width};
  };
  return {
    row: box(el), fold: box(el.querySelector('.qa-fold')),
    right: box(el.querySelector('.qa-right')),
    arrows: [...el.querySelectorAll('button.nav')].map(box),
  };
});

test('the fold and Last sit on opposite edges of the nav row', async ({page}) => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  // Settled before it is measured. renderQuickActions re-runs on every 2s snapshot, so measuring
  // straight off the click can catch the row mid-rebuild and read a stale width for one of three
  // boxes — which is what made this fail about one run in three.
  await expect(page.locator('#termContent')).toContainText('done.');
  const {row, fold, right} = await navBoxes(page);
  expect(fold.x).toBeCloseTo(row.x, 0);
  expect(right.x + right.width).toBeCloseTo(row.x + row.width, 0);
});

test('Summary never lands on an arrow, at any phone width', async ({page}) => {
  // The right edge roughly doubles when a pane has a closing message to offer. The arrows used to
  // reserve room for it by hand, with a min-width under the reserve that silently outranked it —
  // so on every phone width Summary was drawn straight over the ›.
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  // The poll re-reads the pane every few seconds and would put the fake herdr's rows of x back,
  // taking Summary with them. The reads are not what this measures.
  await page.evaluate(pane => {
    refreshPane = () => {};
    const set = setPaneText;
    setPaneText = t => { if (!t.startsWith('x')) set(t); };
    paneOf(activePane).status = 'done';
    setPaneText(pane);
  }, DONE_PANE);
  await expect(page.locator('#quickActions .qa-summary')).toBeVisible();

  for (const width of [320, 390, 430]) {
    await page.setViewportSize({width, height: 844});
    const {fold, right, arrows} = await navBoxes(page);
    expect(arrows.length, `both arrows are there at ${width}`).toBe(2);
    for (const b of arrows) {
      expect(b.width, `an arrow collapsed at ${width}`).toBeGreaterThan(24);
      expect(b.x, `an arrow runs under the fold at ${width}`).toBeGreaterThanOrEqual(fold.x + fold.width);
      expect(b.x + b.width, `an arrow runs under Summary at ${width}`).toBeLessThanOrEqual(right.x);
    }
  }
});

test('QUIT and CLS fold behind f() on a phone, and sit in the row on a desktop', async ({page}) => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  const fire = page.locator('#fireBtn'), quit = page.locator('#quitBtn'), cls = page.locator('#clsBtn');
  // Wide: unchanged. The fold exists for the width it is not needed at.
  await expect(fire).toBeHidden();
  await expect(quit).toBeVisible();

  for (const width of [320, 390, 430]) {
    await page.setViewportSize({width, height: 844});
    await expect(fire, `f() missing at ${width}`).toBeVisible();
    await expect(quit, `QUIT still in the row at ${width}`).toBeHidden();
    await expect(cls).toBeHidden();
    // The header is what this buys: nothing may run off the edge of it.
    const over = await page.evaluate(() => {
      const h = document.querySelector('#terminalView .term-header'), b = h.getBoundingClientRect();
      return [...h.querySelectorAll('button, .fire-menu')].map(e => e.getBoundingClientRect())
        .filter(r => r.width && (r.left < b.left - 0.5 || r.right > b.right + 0.5)).length;
    });
    expect(over, `something runs off the header at ${width}`).toBe(0);
  }

  await fire.click();
  await expect(quit).toBeVisible();
  await expect(cls).toBeVisible();
  // One tap only arms, exactly as it does in the row.
  await quit.click();
  await expect(quit).toHaveText('QUIT?');
  // And closing the fold takes the arm with it — the promise was about a button about to vanish.
  await page.locator('#termTitle').click();
  await expect(page.locator('#fireMenu')).toBeHidden();
  await expect(quit).toHaveText('QUIT');
});

test('Option+Tab walks the tab strip on a wide screen', async ({page}) => {
  // The fake herdr's w1 is the one Space with two tabs in it.
  await page.locator('.chip-strip', {hasText: 'Spaces'}).locator('.chip').nth(1).click();
  const tabs = page.locator('.chip-strip', {hasText: 'Tabs'}).locator('.chip:not(.chip-add)');
  await expect(tabs).toHaveCount(3);                 // All, and the two tabs
  await expect(tabs.nth(0)).toHaveClass(/active/);

  await page.keyboard.press('Alt+Tab');
  await expect(tabs.nth(1)).toHaveClass(/active/);
  await page.keyboard.press('Alt+Tab');
  await expect(tabs.nth(2)).toHaveClass(/active/);
  await page.keyboard.press('Alt+Tab');              // round the ring, back to All
  await expect(tabs.nth(0)).toHaveClass(/active/);
  await page.keyboard.press('Alt+Shift+Tab');
  await expect(tabs.nth(2)).toHaveClass(/active/);

  // Safari may provide the physical key code but no printable key value for Option+Tab.
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', {
    bubbles: true, cancelable: true, altKey: true, code: 'Tab',
  })));
  await expect(tabs.nth(0)).toHaveClass(/active/);

  // Not while a pane is open: the strip is not on screen, and Tab there belongs to the composer.
  // The ring is on All from the press above, and coming back it is still on All.
  await page.locator('#agents .agent').first().click();
  await expect(page.locator('#termContent')).toContainText('done.');
  await page.keyboard.press('Alt+Tab');
  await page.locator('.term-header .back').click();
  await expect(tabs.nth(0)).toHaveClass(/active/);
});

test('Last returns a scrolled-up pane to the newest line, and to following it', async ({page}) => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  // The fake herdr's pane is five lines and cannot overflow a desktop viewport, so the backscroll
  // is stood in for. The button, the handler and the follow flag under test are all the real ones.
  await page.evaluate(() => {
    const el = document.getElementById('termContent');
    el.textContent = Array.from({length: 400}, (_, i) => `line ${i}`).join('\n');
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => page.evaluate(() => userScrolledUp)).toBe(true);

  await page.locator('#quickActions .qa-last').click();
  await expect.poll(() => page.evaluate(() => {
    const el = document.getElementById('termContent');
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  })).toBeLessThanOrEqual(1);
  // The point of the button is not the jump but what the jump restores: live reads follow again.
  await expect.poll(() => page.evaluate(() => userScrolledUp)).toBe(false);
});

test('the loading pill hangs over the pane without moving the composer', async ({page}) => {
  // The working pane, because the last assertion waits for the poll to clear the pill and an idle
  // pane is read every 12s rather than every 3. Nothing else here cares which pane it is.
  await page.locator('#agents .agent', {hasText: WORKING}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  await expect(page.locator('#termLoading')).toBeHidden();

  const composerBefore = await page.locator('.term-input').boundingBox();
  // The wait itself is over in milliseconds against a local fake, so it is re-entered rather than
  // raced for. The flag is the same one openTerminal clears; what is under test here is where the
  // pill lands and what it does to the text, which is CSS and invisible to a vm slice.
  await page.evaluate(() => { paneTextPrimed = false; syncPaneLoading(); });

  await expect(page.locator('#termLoading')).toBeVisible();
  await expect(page.locator('#termLoading')).toHaveText('Loading…');

  const wrap = await page.locator('#termWrap').boundingBox();
  const pill = await page.locator('#termLoading').boundingBox();
  expect(pill.x + pill.width / 2).toBeCloseTo(wrap.x + wrap.width / 2, 0);
  expect(pill.y + pill.height / 2).toBeCloseTo(wrap.y + wrap.height / 2, 0);
  expect(pill.y + pill.height, 'the pill hangs above the composer').toBeLessThan(composerBefore.y);
  // Out of flow, so nothing below it moved to make room.
  expect(await page.locator('.term-input').boundingBox()).toEqual(composerBefore);
  // And the stale text behind it is dimmed, which is what makes the pill mean "not this pane yet".
  await expect(page.locator('#termContent')).toHaveCSS('opacity', '0.3');
  await expect(page.locator('#termLoading')).toHaveCSS('pointer-events', 'none');

  // The next read clears it, the same way the first one does after a real switch.
  await expect(page.locator('#termLoading')).toBeHidden({timeout: 6000});
  await expect(page.locator('#termContent')).toHaveCSS('opacity', '1');
});
