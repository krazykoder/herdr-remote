// T15 — off means off (N10), from the browser's side.
//
// Every other spec runs against a relay with arbitration on, which is the only way to tell the
// gate from a broken render. This one is the other half: a relay that was never told the feature
// exists, and an app that must therefore show no arbitration surface at all. Not "a disabled
// button" and not "a strip that says no" — nothing, on a page that is otherwise identical.
//
//   npx playwright test tests/e2e/browser/arbiter_off.spec.js
const path = require('node:path');
const {test, expect, startRelay, PORT0, ROOT} = require('./fixtures');

// Its own relay, because the fixture's is configured for the rest of the suite. Well above the
// worker ports so a full parallel run cannot collide with it.
let relay = null;

test.beforeAll(async ({}, workerInfo) => {
  relay = await startRelay({
    port: PORT0 + 100 + workerInfo.parallelIndex * 2,
    logs: path.join(ROOT, 'tests', 'e2e', 'logs', `off-w${workerInfo.parallelIndex}`),
    name: 'relay_arbiter_off.out',
    // Unset, not '0'. The relay reads either as off, but a person who never enabled the feature
    // is the case this is about.
    env: {HERDR_ENABLE_ARBITER: undefined},
  });
});

test.afterAll(() => { if (relay) relay.stop(); });

// The same conversation the arbitration spec builds, on the relay with the feature off.
const openConv = async page => {
  await page.goto(relay.url);
  await expect(page.locator('#agents .agent').first()).toBeVisible();
  await page.evaluate(() => {
    const names = ['Architect 1', 'scratch'];
    const keys = names.map(n => convMemberKey(agents.find(a => a.label === n)));
    saveConvIndex([{
      id: 'c1', name: 'footer change', created: Date.now(),
      members: keys.map((k, i) => ({key: k, added: Date.now(), label: names[i]})),
    }]);
    openConversation('c1');
  });
  await expect(page.locator('#convViewTitle')).toHaveText('footer change');
};

test('a conversation on a relay with arbitration off offers none of it', async ({page}) => {
  await openConv(page);
  // The thread itself is there and working, which is what makes the absence meaningful.
  await expect(page.locator('#convViewThread')).toBeVisible();
  await expect(page.locator('#arbStrip')).toBeEmpty();
  await expect(page.locator('#arbStrip button')).toHaveCount(0);
});

test('the gate message never arrives on the socket at all', async ({page}) => {
  // Read off the socket rather than from inside the page: `arb_sessions` is sent immediately
  // after the snapshot, so any hook installed once the app is up is installed too late to prove
  // anything. This sees the connection's first frame.
  const frames = [];
  page.on('websocket', ws => ws.on('framereceived', f => frames.push(String(f.payload))));
  await openConv(page);
  await page.waitForTimeout(4500);      // two poll intervals: what was coming has come
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.filter(f => f.includes('"arb_'))).toEqual([]);
});
