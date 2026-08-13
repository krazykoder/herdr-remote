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

test('two reads arriving together keep both transcript updates', async ({page}) => {
  await open(page);
  const key = await join(page);
  await page.evaluate(async text => {
    const rows = text.split('\n');
    await Promise.all([
      recordPane(activePane, rows),
      recordPane(activePane, rows.concat(['', '❯ follow up', '', '⏺ Followed up.', '', '❯'])),
    ]);
  }, PANE);
  const rec = await held(page, key);
  expect(rec.entries.map(e => e.text)).toContain('Followed up.');
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

// --- The switch, the sheet, and the thread ---

test('a pane in no conversation is offered one, and starting it begins the recording', async ({page}) => {
  await open(page);
  await expect(page.locator('#quickActions .qa-conv')).toHaveCount(0);
  await page.locator('#termMenuBtn').click();
  await expect(page.locator('#menuConv')).toHaveText('Start conversation…');
  await page.locator('#menuConv').click();
  await page.locator('#convName').fill('new authentication feature');
  await page.locator('#convSubmit').click();
  await expect(page.locator('#convSheet')).toBeHidden();
  // The switch is the confirmation: it is offered only on a pane that is in a conversation.
  await expect(page.locator('#quickActions .qa-conv')).toBeVisible();
  await read(page);
  const key = await page.evaluate(() => convMemberKey(paneOf(activePane)));
  expect((await held(page, key)).entries.length).toBe(2);
});

test('on a phone, the menu scrolls and conversation controls keep the nav to one line', async ({page}) => {
  await open(page);
  await join(page);
  await page.evaluate(() => renderQuickActions());
  await page.setViewportSize({width: 320, height: 400});
  const nav = await page.locator('#quickActions .qa-nav').evaluate(el => ({
    children: el.children.length,
    rows: [...el.children].map(child => {
      const r = child.getBoundingClientRect();
      return Math.round(r.y);
    }),
  }));
  expect(nav.children).toBe(3);
  expect(Math.max(...nav.rows) - Math.min(...nav.rows)).toBeLessThanOrEqual(1);

  await page.locator('#termMenuBtn').click();
  const scroll = await page.locator('#termMenu').evaluate(el => {
    const before = el.scrollTop;
    el.scrollTop = el.scrollHeight;
    return {before, after: el.scrollTop, client: el.clientHeight, height: el.scrollHeight, overflow: getComputedStyle(el).overflowY};
  });
  expect(scroll.overflow).toBe('auto');
  expect(scroll.height).toBeGreaterThan(scroll.client);
  expect(scroll.after).toBeGreaterThan(scroll.before);
});

test('a name is required, and the sheet says so rather than filing an unnamed thread', async ({page}) => {
  await open(page);
  await page.locator('#termMenuBtn').click();
  await page.locator('#menuConv').click();
  await page.locator('#convSubmit').click();
  await expect(page.locator('#convError')).toHaveText('A conversation needs a name.');
  await expect(page.locator('#convSheet')).toBeVisible();
  expect(await page.evaluate(() => loadConvIndex().length)).toBe(0);
});

test('the switch swaps the rows for the thread, and back, without a read', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  await expect(page.locator('#convThread')).toBeVisible();
  await expect(page.locator('#termContent')).toBeHidden();
  await expect(page.locator('#convThread .conv-head .name')).toHaveText('new authentication feature');
  // Agent left, user right — the bubble's side is the whole of "who", before any label is read.
  const msgs = page.locator('#convThread .conv-msg');
  await expect(msgs).toHaveCount(2);
  await expect(msgs.nth(0)).not.toHaveClass(/user/);
  await expect(msgs.nth(0)).toContainText('Ready. Name the change.');
  await expect(msgs.nth(1)).toHaveClass(/user/);
  await page.locator('#quickActions .qa-conv').click();
  await expect(page.locator('#convThread')).toBeHidden();
  await expect(page.locator('#termContent')).toBeVisible();
});

test('the view a pane was last read in is the one it opens on', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  await expect(page.locator('#convThread')).toBeVisible();
  await page.reload();
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#convThread')).toBeVisible();
  await expect(page.locator('#convThread .conv-msg')).toHaveCount(2);
});

test('leaving a conversation takes the switch with it and keeps what was recorded', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  await page.locator('#termMenuBtn').click();
  await expect(page.locator('#menuConv')).toHaveText('In "new authentication feature"…');
  await page.locator('#menuConv').click();
  await page.locator('#convList .pair-pick').click();      // the tick is membership; tapping toggles it
  await page.locator('#convSheet [aria-label="Close"]').click();
  await expect(page.locator('#quickActions .qa-conv')).toHaveCount(0);
  expect((await held(page, key)).entries.length).toBe(2);   // still readable, and re-joining resumes
});

// Two members, one thread. The second member is seeded straight into the store: what is being
// proved here is the render, and driving a second pane's reads would prove the recorder again.
const joinBoth = page => page.evaluate(async () => {
  const mine = convMemberKey(paneOf(activePane));
  const other = convMemberKey(agents.find(a => a.label === 'scratch'));
  await convPut({key: other, label: 'scratch', first: 1, touched: 2,
    spawn: {agent: 'codex', role: 'reviewer', project: 'charts'},
    entries: [{who: 'agent', text: 'the other pane spoke first', seen: 1, label: 'scratch'},
      {who: 'agent', text: 'and again, last', seen: 9e12, label: 'scratch'}]});
  saveConvIndex([{
    id: 'c1', name: 'new authentication feature', created: Date.now(),
    members: [{key: mine, added: 1, label: 'Architect 1', messages: 2},
      {key: other, added: 1, label: 'scratch', messages: 2}],
    pair_id: 'p1',
  }]);
  return [mine, other];
});

test('a conversation of two opens on the joint thread, both members in it', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  const msgs = page.locator('#convThread .conv-msg');
  // Merged on `seen`: the other pane's first line predates this pane's read, its last follows it.
  await expect(msgs).toHaveCount(4);
  await expect(msgs.nth(0)).toContainText('the other pane spoke first');
  await expect(msgs.nth(3)).toContainText('and again, last');
  // Every agent bubble names its member — colour alone stops working past two.
  await expect(msgs.nth(0)).toContainText('scratch');
  await expect(msgs.nth(1)).toContainText('Architect 1');
  await expect(page.locator('#convThread .conv-head')).toContainText('4 messages');
});

test('a paired thread fills the pane, keeps agent colors, and keeps prompts beside their agent', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  const msgs = page.locator('#convThread .conv-msg');
  await expect(msgs).toHaveCount(4);
  const layout = await page.evaluate(() => {
    const thread = document.getElementById('convThread').getBoundingClientRect();
    const wrap = document.getElementById('termWrap').getBoundingClientRect();
    return Array.from(document.querySelectorAll('#convThread .conv-msg')).map(m => ({
      right: getComputedStyle(m).alignSelf, color: m.style.getPropertyValue('--conv-agent'),
      thread: Math.round(thread.width), wrap: Math.round(wrap.width), width: Math.round(m.getBoundingClientRect().width), user: m.classList.contains('user'),
    }));
  });
  expect(layout[0].thread).toBe(layout[0].wrap);
  expect(new Set(layout.map(m => m.width)).size).toBe(1);
  expect(layout[0].color).toBe('var(--blue)');       // scratch is codex
  expect(layout[1].color).toBe('var(--agent-claude)');
  expect(layout[0].right).toBe('flex-end');
  expect(layout[1].right).toBe('flex-start');
  expect(layout[2].user).toBe(true);
  expect(layout[2].right).toBe('flex-start');         // prompt sent to Architect 1
});

test('conversation text has its own menu font control', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  await page.locator('#termMenuBtn').click();
  await expect(page.locator('#menuConvFont')).toBeVisible();
  await expect(page.locator('#convFontValue')).toHaveText('9px');
  await page.locator('#convFontInc').click();
  await expect(page.locator('#convFontValue')).toHaveText('10px');
  await expect(page.locator('#convThread .conv-msg').first()).toHaveCSS('font-size', '10px');
});

test('the members strip names who is in it, and what each session was', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  const members = page.locator('#convThread .conv-member');
  await expect(members).toHaveCount(2);
  await expect(members.nth(0)).toContainText('Architect 1');
  // Both panes are live in the fake herdr, so neither is tagged — and the spawn line is what a
  // conversation whose panes have exited still says about them.
  await expect(page.locator('#convThread .conv-member .tag')).toHaveCount(0);
  await expect(members.nth(1).locator('.spawn')).toContainText('codex · reviewer · charts');
});

test('"Show this pane alone" leaves the pane\'s own transcript exactly as it was', async ({page}) => {
  await open(page);
  const [mine] = await joinBoth(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  await expect(page.locator('#convThread .conv-msg')).toHaveCount(4);
  await page.locator('#termMenuBtn').click();
  await expect(page.locator('#menuConvJoint')).toHaveText('Show this pane alone');
  await page.locator('#menuConvJoint').click();
  await expect(page.locator('#convThread .conv-msg')).toHaveCount(2);
  await expect(page.locator('#convThread .conv-members')).toHaveCount(0);
  // The joint view is only ever a render: nothing was merged on disk.
  const rec = await held(page, mine);
  expect(rec.entries.map(e => e.text)).not.toContain('the other pane spoke first');
});

test('self-upgrade keeps a newer fallback tail beside an existing database record', async ({page}) => {
  await open(page);
  const key = await page.evaluate(async () => {
    const k = convMemberKey(paneOf(activePane));
    await convPut({key: k, label: 'Architect 1', first: 1, touched: 2,
      entries: [{who: 'agent', text: 'kept in the database', seen: 1}]});
    localStorage.setItem('herdr_transcripts', JSON.stringify({
      [k]: {key: k, label: 'Architect 1', first: 1, touched: 3,
        entries: [{who: 'agent', text: 'kept in the database', seen: 1},
          {who: 'agent', text: 'written while IndexedDB was away', seen: 3}]},
    }));
    await convUpgradeFallback(convDB);
    return k;
  });
  const rec = await held(page, key);
  expect(rec.entries.map(e => e.text)).toEqual([
    'kept in the database', 'written while IndexedDB was away',
  ]);
});
