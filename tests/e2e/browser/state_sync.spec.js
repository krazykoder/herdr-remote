// Shared user state, end to end: two browsers, one relay, one set of pairs.
//
//   npx playwright test state_sync
//
// The vm slice in tests/test_state_sync.js drives the client's decisions against a recording
// socket. It cannot see the half that matters most here — that the relay stores what the app
// sends, hands it to a browser that has never seen it, and pushes a change to a browser that is
// already looking at it. Every one of those is a message the slice fakes.
//
// **A second page is not a second browser.** `context.newPage()` opens a tab that shares one
// origin's localStorage with the first, so every assertion here would read back the writer's own
// storage and pass against a relay that stored nothing at all. The whole feature is two stores
// agreeing, so the second browser must be its own BrowserContext.
const {test, expect} = require('./fixtures');

const PAIRS = 'herdr_pairs';

// A pair as pairs_ui.js writes one. Two members, because parsePairs drops anything else.
const pairsBlob = name => JSON.stringify({
  version: 1,
  pairs: [{
    id: 'p_sync', name: name,
    members: [
      {pane_id: 'w1:p1', host: 'local', agent: 'claude', cwd: '/work', role: 'architect'},
      {pane_id: 'w1:p2', host: 'local', agent: 'codex', cwd: '/work', role: 'implementer'},
    ],
  }],
});

test.beforeEach(async ({page}) => {
  await page.goto('/');
});

const connected = page => expect.poll(() => page.evaluate(() => ws && ws.readyState)).toBe(1);
const synced = page =>
  expect.poll(() => page.evaluate(() => stateRev.pairs !== undefined)).toBe(true);

// Its own cookie jar and its own localStorage — a different machine as far as this feature is
// concerned. The caller closes it.
async function otherBrowser(browser, relayURL) {
  const context = await browser.newContext({baseURL: relayURL});
  const page = await context.newPage();
  await page.goto('/');
  await connected(page);
  await synced(page);
  return {context, page};
}

// Write the key the way the app does — through savePairs, so the mark and the debounce are the
// ones the app really uses rather than a localStorage.setItem the module never hears about.
const savePair = (page, name) => page.evaluate(blob => {
  pairs = parsePairs(blob);
  savePairs();
}, pairsBlob(name));

const storedPairName = page => page.evaluate(k => {
  const raw = localStorage.getItem(k);
  return raw ? (JSON.parse(raw).pairs[0] || {}).name : null;
}, PAIRS);

// The store outlives a test: one relay per worker, and four rows that are the point of the
// feature. So "the relay has my write" is the revision *moving*, never the revision being
// non-zero — an earlier test in this worker already left one behind.
const revision = page => page.evaluate(() => stateRev.pairs);

async function saveAndLand(page, name) {
  const before = await revision(page);
  await savePair(page, name);
  await expect.poll(() => revision(page)).toBeGreaterThan(before);
}

test('a pair named in one browser reaches a browser that has never seen it',
     async ({page, browser, relayURL}) => {
  await connected(page);
  await synced(page);
  await saveAndLand(page, 'sync-cold');

  const fresh = await otherBrowser(browser, relayURL);
  await expect.poll(() => storedPairName(fresh.page)).toBe('sync-cold');
  await fresh.context.close();
});

test('a rename in one browser lands in another that is already open',
     async ({page, browser, relayURL}) => {
  const other = await otherBrowser(browser, relayURL);
  await connected(page);
  await synced(page);

  await saveAndLand(page, 'first-name');
  await expect.poll(() => storedPairName(other.page)).toBe('first-name');

  await saveAndLand(page, 'second-name');
  await expect.poll(() => storedPairName(other.page)).toBe('second-name');

  // The writer is excluded from the broadcast, so its own document is the one it wrote and not an
  // echo that arrived after it.
  expect(await storedPairName(page)).toBe('second-name');
  await other.context.close();
});

test('replacing a browser socket keeps state sync live', async ({page}) => {
  await connected(page);
  await synced(page);
  await page.evaluate(async () => {
    const old = ws;
    connect();
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => {
        if (ws !== old && ws.readyState === 1 && stateMode === 'live') return resolve();
        if (Date.now() > deadline) return reject(new Error('replacement socket did not sync'));
        setTimeout(check, 25);
      };
      check();
    });
  });
  await saveAndLand(page, 'after-reconnect');
});

test('the browser that adopts keeps a recoverable copy of what it had',
     async ({page, browser, relayURL}) => {
  const other = await otherBrowser(browser, relayURL);
  await connected(page);
  await synced(page);

  await saveAndLand(page, 'shared');
  await expect.poll(() => storedPairName(other.page)).toBe('shared');

  // `other` now has a pair the relay has never heard of, and a rename from `page` is about to take
  // it. Overwriting is what one shared answer costs; losing it without a copy is not part of it.
  await other.page.evaluate(blob => localStorage.setItem('herdr_pairs', blob),
                            pairsBlob('only-mine'));
  await saveAndLand(page, 'from-page');

  await expect.poll(() => storedPairName(other.page)).toBe('from-page');
  const backup = await other.page.evaluate(k => localStorage.getItem(k + '_local'), PAIRS);
  expect(backup, 'the overwritten document must be recoverable by hand').toContain('only-mine');
  await other.context.close();
});

test('the relay refuses the second write at a revision and hands back the winner',
     async ({page}) => {
  // The guard, forced. Two puts at one revision is what the 500 ms debounce exists to make rare,
  // so the app's own path cannot be relied on to produce one — this drives the wire directly.
  await connected(page);
  await synced(page);
  const result = await page.evaluate(async () => {
    const seen = [];
    const real = ws.onmessage;
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'state_ack' || m.type === 'state_conflict') seen.push(m);
      return real(e);
    };
    const rev = stateRev.pairs;
    ws.send(JSON.stringify({type: 'state_put', name: 'pairs', rev: rev, body: '{"race":"a"}'}));
    ws.send(JSON.stringify({type: 'state_put', name: 'pairs', rev: rev, body: '{"race":"b"}'}));
    await new Promise(r => setTimeout(r, 1000));
    ws.onmessage = real;
    return {seen, rev};
  });
  const acks = result.seen.filter(m => m.type === 'state_ack');
  const conflicts = result.seen.filter(m => m.type === 'state_conflict');
  expect(acks, 'exactly one writer may advance a revision').toHaveLength(1);
  expect(conflicts, 'the other must be refused, not silently applied').toHaveLength(1);
  expect(acks[0].rev).toBe(result.rev + 1);
  expect(conflicts[0].rev).toBe(result.rev + 1);
  // The refusal carries the winner, so the loser needs no second round trip to find out what won.
  expect(conflicts[0].body).toBe('{"race":"a"}');
});

test('the relay refuses a document it does not know and one that is too large', async ({page}) => {
  await connected(page);
  await synced(page);
  const errors = await page.evaluate(async () => {
    const seen = [];
    const real = ws.onmessage;
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.type === 'error') seen.push(m.message);
      return real(e);
    };
    ws.send(JSON.stringify({type: 'state_put', name: 'herdr_relay_token', rev: 0, body: 'x'}));
    ws.send(JSON.stringify({type: 'state_put', name: 'conv_hidden', rev: 0,
                            body: 'x'.repeat(256 * 1024 + 1)}));
    await new Promise(r => setTimeout(r, 800));
    ws.onmessage = real;
    return seen;
  });
  expect(errors.join('\n')).toContain('unknown document');
  expect(errors.join('\n')).toContain('too large');
});

test('state survives the browser entirely: cleared storage, reload, same pairs', async ({page}) => {
  await connected(page);
  await synced(page);
  await saveAndLand(page, 'durable');

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await connected(page);
  await expect.poll(() => storedPairName(page)).toBe('durable');
});

test('the relay token is never sent to the relay as a document', async ({page}) => {
  await connected(page);
  await synced(page);
  const sent = await page.evaluate(async () => {
    const seen = [];
    const real = ws.send.bind(ws);
    ws.send = d => { seen.push(d); return real(d); };
    localStorage.setItem('herdr_relay_token', 'sekrit-not-for-the-wire');
    pairs = [];
    savePairs();
    await new Promise(r => setTimeout(r, 1200));
    return seen.filter(d => d.includes('state_put'));
  });
  expect(sent.length).toBeGreaterThan(0);
  for (const d of sent) {
    expect(d).not.toContain('sekrit-not-for-the-wire');
    expect(d).not.toContain('herdr_relay_token');
  }
});
