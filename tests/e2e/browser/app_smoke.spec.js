// The app, in a real browser, against a real relay backed by the fake herdr in tests/e2e/bin.
//
// This is the floor the harness exists to hold: the page boots, the socket connects, a pane opens
// and reads, and going back leaves nothing behind. The node --test suites slice pure blocks out of
// index.html and cannot see any of it — every one of them passes against a page that throws on
// load.
//
//   npx playwright test
const {test, expect} = require('./fixtures');

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

// The <script src> order in index.html is the program: nothing enforces it, and a module that
// reads another's binding at load time breaks at boot if the tags move. state_sync.js is loaded
// before every module that calls into it, so a reorder shows up here.
test('shared state is wired into the socket by the time it is open', async ({page}) => {
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  expect(await page.evaluate(() => typeof stateSyncMark)).toBe('function');
  expect(await page.evaluate(() => typeof savePairs)).toBe('function');
  // Answered, not merely asked: `pulling` here would mean the relay never replied to state_get.
  await expect.poll(() => page.evaluate(() => stateMode)).toBe('live');
});

test('agent filters live on the existing card separator', async ({page}) => {
  await expect.poll(() => page.evaluate(() => agents.length)).toBeGreaterThan(0);
  const kinds = await page.evaluate(() => [...new Set(agents.map(a => a.agent).filter(Boolean))]);
  expect(kinds.length).toBeGreaterThan(1);
  const filter = page.locator('#agents .section-header .agent-kind-filter');
  await expect(filter).toBeVisible();
  await expect(filter.locator('.badge.pick')).toHaveCount(kinds.length);
  const kind = kinds[0];
  await filter.locator('.badge.pick', {hasText: kind}).click();
  await expect.poll(async () => {
    const shown = await page.locator('#agents .agent .meta .badge').allTextContents();
    return shown.length && shown.every(text => text === kind);
  }).toBe(true);
});

// Two separately deployed halves. The page can only report its own build; what the relay is and
// what herdr is under it are the relay's to say, and it says them on connect.
test('Settings names the app, the relay, and the herdr under it', async ({page}) => {
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  await page.locator('#navSettings').click();
  // Served unbuilt from the working copy, which is what the relay does — so the page has no
  // stamped version and says so rather than naming the last release.
  await expect(page.locator('#verApp')).toHaveText('dev');
  await expect(page.locator('#verRelay')).toHaveText(/^\d+\.\d+\.\d+$/);
  await expect(page.locator('#verHerdr')).toHaveText('9.9.9-fake');
  await expect(page.locator('#versionHint')).toContainText('unbuilt');
});

test('Activity tracks local WebSocket payload bytes in a newest-first interval stack', async ({page}) => {
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  // Off means no collection and no empty telemetry panel claiming an hour it did not observe.
  await page.locator('#navTimeline').click();
  await expect(page.locator('#bandwidth')).toBeHidden();
  await page.locator('#navSettings').click();
  await expect(page.locator('#bandwidthStep')).toHaveValue('5');
  await page.locator('#bandwidthOn').check();
  await page.locator('#navTimeline').click();
  await expect(page.locator('#bandwidth')).toBeVisible();
  await expect(page.locator('#bandwidthRows .bandwidth-chip')).toHaveCount(39);

  // A real request and its real relay reply exercise both central WebSocket hooks, rather than
  // testing the counters by calling them directly.
  await page.evaluate(() => ws.send(JSON.stringify(
    {type: 'read_pane', pane_id: 'w1:p1', lines: 200, source: 'recent-unwrapped'})));
  await expect.poll(() => page.evaluate(() => bandwidthBuckets()[0].sent)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => bandwidthBuckets()[0].received)).toBeGreaterThan(0);
  // On the scale of what was actually measured: a fixed MB reads 0.00 for an hour of a quiet
  // relay, which is a panel saying it is not measuring anything.
  await expect(page.locator('#bandwidthTotal')).toHaveText(/^Total: [\d.]+ (B|KB|MB)$/);
  await page.locator('#bandwidthPanes').click();
  const paneRow = page.locator('#bandwidthRows [data-pane="w1:p1"]');
  await expect(paneRow).toBeVisible();
  await expect.poll(() => paneRow.locator('.bandwidth-chip').first().textContent()).not.toBe('');
  // The agent rows live in the same grid, so an interval is the same column above and below.
  const cols = await page.locator('#bandwidthRows').evaluate(rows => {
    const cells = r => [...r.querySelectorAll('.bandwidth-chip, .bandwidth-time')]
      .map(c => Math.round(c.getBoundingClientRect().x));
    return [...rows.querySelectorAll('.bandwidth-head, .bandwidth-row')].map(cells);
  });
  for (const row of cols) expect(row).toEqual(cols[0]);
  await page.locator('[data-bandwidth-metric="sent"]').click();
  await expect(page.locator('[data-bandwidth-metric="sent"]')).toHaveAttribute('aria-pressed', 'true');

  // Three metric rows, one row per agent, and the remainder row under them.
  await expect(page.locator('#bandwidthRows .bandwidth-row')).toHaveCount(
    4 + await page.locator('#agents .agent').count());
  // The split adds up: most of the wire is snapshots, which name no pane and cannot be filed
  // under one, so the agent rows alone never reach the total and Shared is what closes the gap.
  const adds = await page.locator('#bandwidthRows').evaluate(rows => {
    const bytes = t => { const [n, unit] = t.split(' ');
      return Number(n) * (unit === 'MB' ? 1024 * 1024 : unit === 'KB' ? 1024 : 1); };
    const cells = sel => [...rows.querySelectorAll(sel)].map(r =>
      [...r.querySelectorAll('.bandwidth-chip')].map(c => c.textContent));
    const [sent] = cells('.bandwidth-row:nth-child(3)');   // head, Total, Sent
    const split = cells('.pane-bandwidth-row, #otherBandwidthRow');
    return sent.map((t, i) => [bytes(t || '0 B'),
      split.reduce((n, row) => n + bytes(row[i] || '0 B'), 0)]);
  });
  // Within a rounding step of the scale the panel prints at, not to the byte: the chips are what
  // the reader adds up, and they are rounded before they are read.
  for (const [total, split] of adds) expect(Math.abs(total - split)).toBeLessThanOrEqual(total * 0.02 + 64);
  for (const row of await page.locator('#bandwidthRows .bandwidth-row').all()) {
    await expect(row.locator('.bandwidth-chip')).toHaveCount(13);
  }
  expect(await page.evaluate(() => {
    const b = bandwidthBuckets()[0];
    return b.sent + b.received;
  })).toBeGreaterThan(0);
  // Records are a stack: a quiet interval is absent, never drawn as a fabricated zero column.
  await page.evaluate(() => noteBandwidth('sent', 'older bucket', Date.now() - 30 * 60 * 1000));
  await expect(page.locator('#bandwidthRows .bandwidth-time')).toHaveCount(13);
  expect(await page.evaluate(() => bandwidthBuckets().filter(b => !b.empty).map(b => b.at))).toEqual(
    await page.evaluate(() => bandwidthBuckets().filter(b => !b.empty).map(b => b.at).slice().sort((a, b) => b - a)));

  // Hist is every closed interval added up, so it is what the row's own chips come to once the
  // one still being filled is left out — a running column has no business in a completed total.
  const hist = await page.locator('#bandwidthRows').evaluate(rows => {
    const bytes = t => { const [n, unit] = (t || '0 B').split(' ');
      return Number(n) * (unit === 'MB' ? 1024 * 1024 : unit === 'KB' ? 1024 : 1); };
    const row = rows.querySelector('.bandwidth-row');
    const closed = [...row.querySelectorAll('.bandwidth-chips .bandwidth-chip')]
      .filter(c => !c.classList.contains('now'));
    return [bytes(row.querySelector('.bandwidth-chip.bandwidth-hist').textContent),
      closed.reduce((n, c) => n + bytes(c.textContent), 0)];
  });
  expect(Math.abs(hist[0] - hist[1])).toBeLessThanOrEqual(hist[0] * 0.02 + 64);

  // And it stays beside the name when the hours scroll past: the total is what every bucket is
  // being compared against, so it has to still be on screen when the bucket is reached.
  // Narrowed to a phone's worth of table, because on a desktop the whole hour fits and nothing is
  // sticky until something scrolls. Wide enough for the name and the total together — narrower
  // than the two of them, a browser clamps the sticky column back inside the scrollport and there
  // is nothing left to hold still. Drawn again at that width: the offset is measured as the table
  // is written, so a resize is only picked up on the next draw.
  await page.evaluate(() => {
    document.getElementById('bandwidthRows').style.maxWidth = '420px';
    renderBandwidth();
  });
  const stuck = await page.locator('#bandwidthRows').evaluate(rows => {
    rows.scrollLeft = rows.scrollWidth;
    const row = rows.querySelector('.bandwidth-row');
    const name = row.querySelector('.bandwidth-label').getBoundingClientRect();
    const h = row.querySelector('.bandwidth-chip.bandwidth-hist').getBoundingClientRect();
    const at = [h.left - name.right, h.left - rows.getBoundingClientRect().left];
    rows.style.maxWidth = '';
    return at;
  });
  expect(Math.abs(stuck[0])).toBeLessThan(1);  // flush against the name, no gap to show through
  expect(stuck[1]).toBeGreaterThan(0);

  // A second tap on Activity leaves it, which is what every other panel button does.
  await page.locator('#navTimeline').click();
  await expect(page.locator('#timelineView')).toBeHidden();
});

test('a refresh resumes a recently active bandwidth bucket', async ({page}) => {
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  await page.locator('#navSettings').click();
  await page.locator('#bandwidthOn').check();
  await page.evaluate(() => ws.send(JSON.stringify(
    {type: 'read_pane', pane_id: 'w1:p1', lines: 200, source: 'recent-unwrapped'})));
  await expect.poll(() => page.evaluate(() => bandwidthBuckets()[0].last)).toBeTruthy();
  const at = await page.evaluate(() => bandwidthBuckets()[0].at);
  await page.reload();
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  await expect.poll(() => page.evaluate(() => bandwidthBuckets()[0].at)).toBe(at);
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
  await expect(times).toHaveCount(13);
  await expect(times.nth(1)).toHaveText('now');
  await expect(times.nth(1)).toHaveClass(/now/);

  // And it is redrawn where it stands, without leaving Activity and coming back.
  const live = page.locator('#bandwidthRows .bandwidth-row').first().locator('.bandwidth-chip.now');
  const before = await live.textContent();
  await page.evaluate(() => ws.send(JSON.stringify(
    {type: 'read_pane', pane_id: 'w1:p1', lines: 200, source: 'recent-unwrapped'})));
  await expect.poll(() => live.textContent()).not.toBe(before);

  // A record starts at the message that opened it, not on a clock boundary, so nothing about its
  // time says whether it is still being filled — only the collector knows, and once it stops
  // collecting no column claims to be live.
  // The marker is the record still open, not a guess made from its clock.
  expect(await page.evaluate(() => bandwidthLiveAt() === bandwidthBuckets()[0].at)).toBe(true);
  // Stopping closes it rather than leaving it to be resumed after an hour of not looking, so
  // nothing claims to be live until collection opens a fresh one.
  await page.locator('#navSettings').click();
  await page.locator('#bandwidthOn').uncheck();
  expect(await page.evaluate(() => bandwidthLiveAt())).toBe(0);
});

test('a record older than today says which day, and clearing throws the stack away',
  async ({page}) => {
    await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
    await page.locator('#navSettings').click();
    await page.locator('#bandwidthOn').check();
    await page.evaluate(() => noteBandwidth('sent', 'yesterday', Date.now() - 26 * 60 * 60 * 1000));
    await page.locator('#navTimeline').click();
    // The stack survives a reload and holds days, so a bare HH:MM would read as this morning.
    const times = page.locator('#bandwidthRows .bandwidth-time');
    await expect(times.filter({hasText: /^\w{3} \d+ \d\d:\d\d$/})).toHaveCount(1);
    await expect(times.filter({hasText: /^\d\d:\d\d$/})).toHaveCount(0);   // today's is "now"

    // Off stops collecting; it does not throw away what is already on this device. Clear does.
    await page.locator('#navSettings').click();
    await page.locator('#bandwidthOn').uncheck();
    expect(await page.evaluate(() => bandwidthBuckets().filter(b => !b.empty).length)).toBeGreaterThan(0);
    await page.locator('#navTimeline').click();
    await expect(page.locator('#bandwidth')).toBeHidden();
    await page.locator('#navSettings').click();
    // Cleared with collection still off, and deliberately: the relay broadcasts a snapshot every
    // few seconds, and with collection on one could land between the click and the assertion and
    // refill the bucket this is checking is empty. The button is not gated on the toggle, so
    // nothing is lost by clearing from here — what is being proved is that Clear throws the stack
    // away, not that it can be pressed while collecting.
    await page.getByRole('button', {name: 'Clear recorded data'}).click();
    expect(await page.evaluate(() => bandwidthBuckets().filter(b => !b.empty).length)).toBe(0);
    // Including the per-pane totals, which are the same record split another way.
    expect(await page.evaluate(() => localStorage.getItem('herdr_pane_bandwidth_data'))).toBe('{}');
    await page.reload();
    expect(await page.evaluate(() => bandwidthBuckets().filter(b => !b.empty).length)).toBe(0);
  });

test('a reconnect starts a fresh payload bucket but retains history', async ({page}) => {
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  await page.locator('#navSettings').click();
  await page.locator('#bandwidthOn').check();
  await page.evaluate(() => ws.send(JSON.stringify(
    {type: 'read_pane', pane_id: 'w1:p1', lines: 200, source: 'recent-unwrapped'})));
  await expect.poll(() => page.evaluate(() => bandwidthBuckets().filter(b => !b.empty).length)).toBe(1);
  const first = await page.evaluate(() => bandwidthBuckets()[0].at);
  await page.evaluate(() => ws.close());
  await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
  await page.evaluate(() => ws.send(JSON.stringify(
    {type: 'read_pane', pane_id: 'w1:p1', lines: 200, source: 'recent-unwrapped'})));
  await expect.poll(() => page.evaluate(() => bandwidthBuckets().filter(b => !b.empty).length)).toBe(2);
  expect(await page.evaluate(() => bandwidthBuckets()[0].at)).toBeGreaterThan(first);
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

test('bucket and stack size are settings, and records survive reload',
  async ({page}) => {
    await expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
    await page.locator('#navSettings').click();
    await page.locator('#bandwidthOn').check();
    await page.locator('#bandwidthStep').selectOption('30');
    await page.locator('#bandwidthKeep').selectOption('60');
    await page.locator('#navTimeline').click();
    await expect(page.locator('#bandwidthTitle')).toHaveText('Data exchange · 30 min buckets · latest 60');
    // Settings and collected buckets survive reload.
    await page.evaluate(() => ws.send(JSON.stringify(
      {type: 'read_pane', pane_id: 'w1:p1', lines: 200, source: 'recent-unwrapped'})));
    await expect.poll(() => page.evaluate(() => localStorage.getItem('herdr_bandwidth_data'))).not.toBeNull();
    await page.reload();
    await page.locator('#navSettings').click();
    await expect(page.locator('#bandwidthStep')).toHaveValue('30');
    await expect(page.locator('#bandwidthKeep')).toHaveValue('60');
    await page.locator('#navTimeline').click();
    await expect(page.locator('#bandwidthRows .bandwidth-chip')).not.toHaveCount(0);
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

  // One message, carrying the Enter that submits it. Two — a paste and then a keypress — is what
  // an agent still busy with the paste used to swallow, leaving the text unsent in its composer.
  await expect.poll(() => sent.filter(m => m.type === 'send_text').length).toBe(1);
  const text = sent.find(m => m.type === 'send_text');
  expect(text.pane_id).toBe('w1:p1');
  expect(text.text).toBe('echo hi');
  expect(text.submit).toBe(true);
  expect(sent.some(m => m.type === 'send_keys' && m.keys.includes('Enter'))).toBe(false);
  // And the composer is cleared, which is the only sign the user gets that it left.
  await expect(page.locator(R('termInput'))).toHaveValue('');
  // The fake herdr reports a fixed board, so this pane never reports taking the text and the
  // relay cannot prove the send landed. That is the case a cleared composer hides, and the only
  // thing that distinguishes it from a send that worked is this.
  await expect(page.locator('#toast')).toContainText('did not confirm the send');
});

// A working pane, read as a thread, with one bubble in it — which is where the Esc lives now. The
// codex pane is the one the fake herdr reports as genuinely working, so the tag is on screen
// because the pane is working, not because the test set a field the next snapshot would undo.
const workingThread = async page => {
  await page.locator('#agents .agent', {hasText: 'scratch'}).click();
  await expect(page.locator('#termContent')).toContainText('pane w8:p1');
  await page.evaluate(async () => {
    const key = convMemberKey(paneOf(activePane));
    saveConvIndex([{id: 'c1', name: 'the release', created: Date.now(),
      members: [{key: key, added: Date.now(), label: 'scratch'}]}]);
    await convRecordSend(activePane, 'go on then');
    toggleConvView();
    await renderConvView();
  });
  await expect(page.locator('#convThread .conv-msg').first()).toBeVisible();
};

test('Esc hangs off a working bubble, and takes two taps like CLS', async ({page}) => {
  await workingThread(page);
  const sent = [];
  await page.exposeFunction('__noteEsc', d => sent.push(JSON.parse(d)));
  await page.evaluate(() => {
    const send = ws.send.bind(ws);
    ws.send = d => { window.__noteEsc(d); return send(d); };
  });
  const esc = page.locator('#convThread .conv-esc');
  await expect(esc).toBeVisible();
  // Left of the tag it acts on, which is the whole reason it is here rather than in a bar.
  await expect(page.locator('#convThread .conv-live > *:first-child')).toHaveClass(/conv-esc/);
  await expect(page.locator('#convThread .conv-badge')).toHaveText('working');

  // The first tap only arms, and says so. Stopping an agent mid-run is not undoable.
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
  await workingThread(page);
  const esc = page.locator('#convThread .conv-esc');
  await esc.click();
  await expect(esc).toHaveText('Esc?');
  // 2.5s is the whole window, and a button left armed across a pocket is the accident the pair
  // exists to stop.
  await expect(esc).toHaveText('Esc', {timeout: 5000});
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
});

test('CLS submits its line with Enter rather than after it', async ({page}) => {
  await page.locator('#agents .agent', {hasText: 'scratch'}).click();
  const sent = await page.evaluate(() => {
    const out = [];
    ws.send = data => out.push(JSON.parse(data));
    armClear(); armClear();
    return out;
  });
  expect(sent).toContainEqual({type: 'send_text', pane_id: 'w8:p1', text: '/clear', submit: true});
  expect(sent.filter(m => m.type === 'send_keys')).toHaveLength(0);
});

test('the bubble Esc is painted armed too, on the longer window it gets', async ({page}) => {
  await workingThread(page);
  await page.locator('#convThread .conv-esc').click();
  expect(await page.evaluate(() => {
    const c = getComputedStyle(document.querySelector('#convThread .conv-esc'));
    return {fill: c.backgroundImage.startsWith('linear-gradient'), drain: c.animationName,
      window: c.animationDuration};
  })).toEqual({fill: true, drain: 'arm-drain', window: '2.5s'});
});
