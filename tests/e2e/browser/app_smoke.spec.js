// The app, in a real browser, against a real relay backed by the fake herdr in tests/e2e/bin.
//
// This is the floor the harness exists to hold: the page boots, the socket connects, a pane opens
// and reads, and going back leaves nothing behind. The node --test suites slice pure blocks out of
// index.html and cannot see any of it — every one of them passes against a page that throws on
// load.
//
//   npx playwright test
const {test, expect} = require('@playwright/test');

// Elements are addressed by the ids the single-file app gives them.
const R = name => `#${name}`;
const AGENT = 'Architect 1';
const TERMINAL = 'build watch';

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

// The app is one file with no build step, so "it loaded" is not a given the way it is behind a
// bundler that would have failed the build instead.
test('the page boots and connects to its own relay', async ({page}) => {
  await expect(page.locator('#agents')).toBeVisible();
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
});

test('Activity tracks local WebSocket payload bytes in twelve five-minute buckets', async ({page}) => {
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  // Off means no collection and no empty telemetry panel claiming an hour it did not observe.
  await page.locator('#navTimeline').click();
  await expect(page.locator('#bandwidth')).toBeHidden();
  await page.locator('#navSettings').click();
  await page.locator('#bandwidthOn').check();
  await page.locator('#navTimeline').click();
  await expect(page.locator('#bandwidth')).toBeVisible();

  // A real request and its real relay reply exercise both central WebSocket hooks, rather than
  // testing the counters by calling them directly.
  await page.evaluate(() => ws.send(JSON.stringify(
    {type: 'read_pane', pane_id: 'w1:p1', lines: 200, source: 'recent-unwrapped'})));
  await expect.poll(() => page.evaluate(() => bandwidthBuckets().at(-1).sent)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => bandwidthBuckets().at(-1).received)).toBeGreaterThan(0);

  await expect(page.locator('#bandwidthRows .bandwidth-row')).toHaveCount(3);
  for (const row of await page.locator('#bandwidthRows .bandwidth-row').all()) {
    await expect(row.locator('.bandwidth-chip')).toHaveCount(12);
  }
  expect(await page.evaluate(() => {
    const b = bandwidthBuckets().at(-1);
    return b.sent + b.received;
  })).toBeGreaterThan(0);

  // A second tap on Activity leaves it, which is what every other panel button does.
  await page.locator('#navTimeline').click();
  await expect(page.locator('#timelineView')).toBeHidden();
});

test('the newest bucket is the one filling, and it is drawn while it fills', async ({page}) => {
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  await page.locator('#navSettings').click();
  await page.locator('#bandwidthOn').check();
  await page.locator('#navTimeline').click();
  // The clock row names each bucket by its start, and says "now" for the one still being filled —
  // the numbers underneath it are minutes old at most, and the difference between a small total
  // and a stopped one is the whole reason to look.
  const times = page.locator('#bandwidthRows .bandwidth-time');
  await expect(times).toHaveCount(12);
  await expect(times.last()).toHaveText('now');
  await expect(times.last()).toHaveClass(/now/);
  await expect(times.first()).toHaveText(/^\d\d:\d\d$/);

  // And it is redrawn where it stands, without leaving Activity and coming back.
  const live = page.locator('#bandwidthRows .bandwidth-row').first().locator('.bandwidth-chip.now');
  const before = await live.textContent();
  await page.evaluate(() => ws.send(JSON.stringify(
    {type: 'read_pane', pane_id: 'w1:p1', lines: 200, source: 'recent-unwrapped'})));
  await expect.poll(() => live.textContent()).not.toBe(before);
});

test('the clock row and all three rows are one table in one scroller', async ({page}) => {
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  await page.locator('#navSettings').click();
  await page.locator('#bandwidthOn').check();
  await page.locator('#navTimeline').click();
  // Three scrollers of their own would let a reader line Sent up against a Received from half an
  // hour earlier and never see that they had. One grid: every column starts at one x.
  const columns = await page.locator('#bandwidthRows').evaluate(rows => {
    const cells = r => [...r.querySelectorAll('.bandwidth-chip, .bandwidth-time')]
      .map(c => Math.round(c.getBoundingClientRect().x));
    return [...rows.querySelectorAll('.bandwidth-head, .bandwidth-row')].map(cells);
  });
  expect(columns).toHaveLength(4);
  for (const row of columns) expect(row).toEqual(columns[0]);
  await expect(page.locator('#bandwidthRows')).toHaveCSS('overflow-x', 'auto');
});

test('the bucket and the span are settings, and the heading says which is in force',
  async ({page}) => {
    await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
    await page.locator('#navSettings').click();
    await page.locator('#bandwidthOn').check();
    await page.locator('#bandwidthStep').selectOption('30');
    await page.locator('#bandwidthSpan').selectOption('5');
    await page.locator('#navTimeline').click();
    // Five hours in half-hour steps is ten buckets, and the heading says so rather than leaving a
    // reader to count chips to find out what one of them covers.
    await expect(page.locator('#bandwidthTitle')).toHaveText('Data exchange · 30 min · last 5 hours');
    await expect(page.locator('#bandwidthRows .bandwidth-time')).toHaveCount(10);
    await expect(page.locator('#bandwidthRows .bandwidth-row').first().locator('.bandwidth-chip'))
      .toHaveCount(10);
    // Half-hour boundaries, not the five-minute ones the buckets were cut on before the change.
    const clocks = await page.locator('#bandwidthRows .bandwidth-time').allTextContents();
    for (const t of clocks.slice(0, -1)) expect(t).toMatch(/:(00|30)$/);
    // And it survives a reload, like every other setting.
    await page.reload();
    await page.locator('#navSettings').click();
    await expect(page.locator('#bandwidthStep')).toHaveValue('30');
    await expect(page.locator('#bandwidthSpan')).toHaveValue('5');
  });

test('the compiled distribution single-file boots and connects', async ({page}) => {
  await page.goto('/dist/');
  await expect(page.locator('#agents')).toBeVisible();
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
});

test('the agent list shows what the relay is polling', async ({page}) => {
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  // Terminals are agents' equals in this list when the relay has terminal mode on, which the
  // harness turns on — a shell missing here is the wire, not the CSS.
  // Scoped to the whole list view and not to #agents: Terminals is its own section node so the
  // user can order it, and this test is about the wire, not about which node it landed in.
  await expect(page.locator('#agentListView .agent', {hasText: TERMINAL})).toBeVisible();
});

test('opening a pane reads it, and going back leaves the list', async ({page}) => {
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#terminalView')).toHaveClass(/active/);
  await expect(page.locator(R('termContent'))).toContainText('done.');
  await expect(page.locator(R('termTitle'))).toContainText(AGENT);

  await page.locator('.term-header .back').click();
  await expect(page.locator('#terminalView')).not.toHaveClass(/active/);
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
});

test('a notification opens its pane in a fresh or focused app', async ({page}) => {
  await page.goto('/?pane=w1:p1');
  await expect(page.locator(R('termContent'))).toContainText('pane w1:p1');
  await expect(page).not.toHaveURL(/pane=/);

  await page.locator('.term-header .back').click();
  // On navigator.serviceWorker, because that is where a service worker's postMessage lands. A
  // window.dispatchEvent here would pass against a listener no real browser ever calls.
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', {
    data: {type: 'navigate', url: location.origin + '/?pane=w1:p1'},
  })));
  await expect(page.locator(R('termContent'))).toContainText('pane w1:p1');
  await expect(page).not.toHaveURL(/pane=/);
});

test('switching panes does not leave the first pane’s text behind', async ({page}) => {
  // The fake herdr writes each pane's own id into its output, so a stale paint is visible rather
  // than indistinguishable. This is the failure that made the harness worth having.
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator(R('termContent'))).toContainText('pane w1:p1');

  await page.locator('.term-header .back').click();
  await page.locator('#agentListView .agent', {hasText: TERMINAL}).click();
  await expect(page.locator(R('termContent'))).toContainText('pane w9:p1');
  await expect(page.locator(R('termContent'))).not.toContainText('pane w1:p1');
});

test('the composer sends to the pane that is open', async ({page}) => {
  // The agent, not the terminal: this is the ordinary "type something and send it" path.
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator(R('termContent'))).toContainText('done.');

  const sent = [];
  await page.exposeFunction('__note', d => sent.push(JSON.parse(d)));
  await page.evaluate(() => {
    const send = ws.send.bind(ws);
    ws.send = d => { window.__note(d); return send(d); };
  });
  await page.locator(R('termInput')).fill('echo hi');
  await page.locator(R('termInput')).press('Control+Enter');

  // Text and the Enter that submits it are two messages: the text goes as a bracketed paste so a
  // multi-line prompt cannot be executed a line at a time.
  await expect.poll(() => sent.filter(m => m.type === 'send_text').length).toBe(1);
  const text = sent.find(m => m.type === 'send_text');
  expect(text.pane_id).toBe('w1:p1');
  expect(text.text).toBe('echo hi');
  expect(sent.some(m => m.type === 'send_keys' && m.keys.includes('Enter'))).toBe(true);
  // And the composer is cleared, which is the only sign the user gets that it left.
  await expect(page.locator(R('termInput'))).toHaveValue('');
});

test('Esc is beside a working pane badge, and takes two taps like CLS', async ({page}) => {
  // The codex pane is the one the fake herdr reports as genuinely working, so the chip is on
  // screen because the pane is working — not because the test set a field that the next snapshot,
  // three seconds later, sets back.
  await page.locator('#agents .agent', {hasText: 'scratch'}).click();
  await expect(page.locator('#statusBarRight')).toHaveText('working');
  const sent = [];
  await page.exposeFunction('__noteEsc', d => sent.push(JSON.parse(d)));
  await page.evaluate(() => {
    const send = ws.send.bind(ws);
    ws.send = d => { window.__noteEsc(d); return send(d); };
  });
  const esc = page.locator('#abortBtn');
  await expect(esc).toBeVisible();

  // The first tap only arms, and says so. Stopping an agent mid-run is not undoable, and this
  // button sits under the thumb for as long as the pane is busy.
  await esc.click();
  await expect(esc).toHaveText('Esc?');
  await expect(esc).toHaveAttribute('data-armed', '1');
  expect(sent.filter(m => m.type === 'send_keys')).toEqual([]);

  await esc.click();
  await expect.poll(() => sent).toContainEqual(
    {type: 'send_keys', pane_id: 'w8:p1', keys: ['Escape']});
  await expect(esc).toHaveText('Esc');
});

test('an Esc left armed disarms itself rather than waiting', async ({page}) => {
  await page.locator('#agents .agent', {hasText: 'scratch'}).click();
  const esc = page.locator('#abortBtn');
  await esc.click();
  await expect(esc).toHaveText('Esc?');
  // 1.5s is the whole window, and a button left armed across a pocket is the accident the pair
  // exists to stop.
  await expect(esc).toHaveText('Esc', {timeout: 4000});
});

test('an armed button is painted armed, not just labelled armed', async ({page}) => {
  // The drain is the deadline made visible: the fill empties over exactly the window the second
  // tap has. It is also the part a selector change can quietly drop while every other assertion
  // still passes — the animation keeps running, over a fill nobody painted — so it is measured
  // here rather than eyeballed. Armed and read in one evaluate, because the arm expires in 1.5s.
  await page.locator('#agents .agent', {hasText: 'scratch'}).click();
  const painted = ([id, arm]) => {
    window[arm]();
    const c = getComputedStyle(document.getElementById(id));
    return {fill: c.backgroundImage.startsWith('linear-gradient'), drain: c.animationName};
  };
  expect(await page.evaluate(painted, ['clsBtn', 'armClear']))
    .toEqual({fill: true, drain: 'arm-drain'});
  expect(await page.evaluate(painted, ['abortBtn', 'abortWorking']))
    .toEqual({fill: true, drain: 'arm-drain'});
});
