// Where a conversation is kept, in a real browser.
//
// The vm slice in tests/test_conversation.js covers what is recorded and what is dropped. What it
// cannot see is the half that is the browser's: an actual IndexedDB, a transcript surviving a
// reload, and the fallback that has to keep working when there is no database to write to. Both
// are storage bugs, and a storage bug loses history rather than a render.
//
//   npx playwright test
const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Architect 1';   // the fake herdr reports this one as a claude pane
const PANE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'fixtures', 'pane_claude_done.txt'), 'utf8');

const open = async page => {
  await page.goto('/');
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
};

// File the open pane under a conversation. Recording is bound to the conversation, so this is the
// switch every test below turns on — and one test deliberately leaves off.
const join = page => page.evaluate(() => {
  const key = convMemberKey(paneOf(activePane));
  saveConvIndex([{
    id: 'c1', name: 'new authentication feature', created: Date.now(),
    members: [{key: key, added: Date.now(), label: 'Architect 1'}],
  }]);
  return key;
});

// One read, recorded. feed() is the same merge a pane_content delivers; recordPane is what that
// handler calls once the pane is drawn.
const read = (page, text = PANE) => page.evaluate(async text => {
  paneOf(activePane).status = 'done';
  setPaneText(text);
  await recordPane(activePane, paneRows);
}, text);

const held = (page, key) => page.evaluate(async k => (await convGet([k]))[0] || null, key);

test.beforeEach(async ({page}) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors;
});

test.afterEach(async ({page}) => {
  expect(page.__errors, 'the page logged errors').toEqual([]);
});

test('a pane in a conversation is recorded into the database', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  const rec = await held(page, key);
  expect(rec.entries.map(e => e.who)).toEqual(['agent', 'user']);
  expect(rec.entries[0].text).toMatch(/^Ready\. Name the change\./);
  expect(rec.label).toBe(AGENT);
  expect(rec.touched).toBeGreaterThan(0);
});

test('the transcript is still there after a reload', async ({page}) => {
  // The whole point of the feature: the pane keeps a few hundred lines and then forgets.
  await open(page);
  const key = await join(page);
  await read(page);
  await page.reload();
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  const rec = await held(page, key);
  expect(rec.entries[0].text).toMatch(/^Ready\. Name the change\./);
});

test('the index is what says a transcript is kept, and it is read synchronously', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  // The landing list renders before any await, so the index cannot be behind a promise.
  const named = await page.evaluate(() => Array.from(convReferenced()));
  expect(named).toEqual([key]);
  const raw = await page.evaluate(() => localStorage.getItem('herdr_conversations'));
  expect(JSON.parse(raw).items[0].name).toBe('new authentication feature');
});

test('a pane in no conversation is not recorded at all', async ({page}) => {
  // Reading a pane is not filing it. Nothing is written until someone names a conversation.
  await open(page);
  const key = await page.evaluate(() => convMemberKey(paneOf(activePane)));
  await read(page);
  expect(await held(page, key)).toBeNull();
});

test('re-reading an unchanged pane does not write again', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  const first = await held(page, key);
  await page.waitForTimeout(5);
  await read(page);
  const second = await held(page, key);
  expect(second.touched).toBe(first.touched);
  expect(second.entries.length).toBe(first.entries.length);
});

test('with no database, recording still works and says history will be short', async ({page}) => {
  // Private mode, a policy-blocked store, a blocked upgrade. None of them is a reason to stop
  // rendering a pane, and none of them may lose the session's recording silently.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', {
      get() { throw new DOMException('blocked', 'SecurityError'); },
    });
  });
  await open(page);
  const key = await join(page);
  await read(page);
  const rec = await held(page, key);
  expect(rec.entries[0].text).toMatch(/^Ready\. Name the change\./);
  const stored = await page.evaluate(() => localStorage.getItem('herdr_transcripts'));
  expect(JSON.parse(stored)[key].entries.length).toBe(2);
  await expect(page.locator('#toast')).toContainText('history will be kept short');
});

test('what the fallback kept moves into the database when one appears', async ({page}) => {
  await open(page);
  const key = await page.evaluate(() => {
    const k = convMemberKey(paneOf(activePane));
    localStorage.setItem('herdr_transcripts', JSON.stringify({
      [k]: {key: k, label: 'Architect 1', first: 1, touched: 2,
            entries: [{who: 'agent', text: 'said while there was nowhere to put it', seen: 1}]},
    }));
    return k;
  });
  await page.reload();
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  const rec = await held(page, key);
  expect(rec.entries[0].text).toBe('said while there was nowhere to put it');
  // And cleared behind it, so the same words are not read a second time.
  expect(await page.evaluate(() => localStorage.getItem('herdr_transcripts'))).toBeNull();
});
