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
