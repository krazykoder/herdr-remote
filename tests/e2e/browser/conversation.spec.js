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
const tapWire = page => page.evaluate(() => {
  window.__sent = [];
  const send = ws.send.bind(ws);
  ws.send = message => { window.__sent.push(JSON.parse(message)); send(message); };
});

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

test('the landing page lists recorded conversations and their live members', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  const card = page.locator('#conversations .conversation-card');
  await expect(card).toContainText('new authentication feature');
  await expect(card).toContainText('2 messages');
  await expect(card).toContainText('Architect 1');
  await expect(card).toContainText('Live: Architect 1');
  await expect(card).toContainText('Last activity');
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

test('a visible frame is drawn but never folded; unwrapped scrollback is', async ({page}) => {
  await open(page);
  const key = await join(page);
  await page.evaluate(text => ws.onmessage({data: JSON.stringify({
    type: 'pane_content', pane_id: activePane, content: text, source: 'visible',
  })}), PANE);
  expect(await held(page, key)).toBeNull();
  await page.evaluate(text => ws.onmessage({data: JSON.stringify({
    type: 'pane_content', pane_id: activePane, content: text, source: 'recent-unwrapped',
  })}), PANE);
  await expect.poll(() => held(page, key)).not.toBeNull();
});

test('two writes arriving together keep both', async ({page}) => {
  // A send and a read of the same transcript race: both load the stored record, and without the
  // per-transcript queue the second put is built on a record that predates the first.
  await open(page);
  const key = await join(page);
  await page.evaluate(async text => {
    paneOf(activePane).status = 'done';
    setPaneText(text);
    await Promise.all([
      convRecordSend(activePane, 'sent while reading', null, Date.now()),
      recordPane(activePane, paneRows),
    ]);
  }, PANE);
  const rec = await held(page, key);
  expect(rec.entries.map(e => e.text)).toContain('sent while reading');
  expect(rec.entries.some(e => /^Ready\. Name the change\./.test(e.text))).toBe(true);
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
    entries: [
      {who: 'agent', text: 'the other pane spoke first', seen: 1, label: 'scratch', agent: 'codex'},
      {who: 'agent', text: 'and again, last', seen: 9e12, label: 'scratch', agent: 'codex'}]});
  saveConvIndex([{
    id: 'c1', name: 'new authentication feature', created: Date.now(),
    members: [{key: mine, added: 1, label: 'Architect 1', messages: 2},
      {key: other, added: 1, label: 'scratch', messages: 2}],
    pair_id: 'p1',
  }]);
  return [mine, other];
});

// Pairs can be made after each pane already has its own conversation. The paired reader must join
// those two stored transcripts without rewriting either conversation's membership.
const joinSeparatePair = page => page.evaluate(async () => {
  const mine = paneOf(activePane), other = agents.find(a => a.label === 'scratch');
  const mineKey = convMemberKey(mine), otherKey = convMemberKey(other);
  pairs = [{id: 'p1', members: [recentFingerprint(mine), recentFingerprint(other)]}];
  await convPut({key: otherKey, label: 'scratch', first: 1, touched: 2,
    entries: [{who: 'agent', text: 'the partner kept its own thread', seen: 1, label: 'scratch'}]});
  saveConvIndex([
    {id: 'c1', name: 'mine', created: Date.now(), members: [{key: mineKey, added: 1, label: 'Architect 1'}]},
    {id: 'c2', name: 'theirs', created: Date.now(), members: [{key: otherKey, added: 1, label: 'scratch'}]},
  ]);
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

test('a turn ending reads that pane, wherever the app is looking', async ({page}) => {
  // The read behind every append. It follows the transition rather than the view, which is what
  // records a partner's half of a conversation while you are reading the other half.
  await open(page);
  await joinBoth(page);
  await read(page);
  await tapWire(page);
  await page.evaluate(() => convReadTurnEnd('w8:p1', 'done'));
  const reads = await page.evaluate(() => window.__sent.filter(m => m.type === 'read_pane'));
  expect(reads).toEqual([{type: 'read_pane', pane_id: 'w8:p1', lines: 200, source: 'recent-unwrapped'}]);
});

test('a pane no conversation names is not read when its turn ends', async ({page}) => {
  await open(page);
  await tapWire(page);
  await page.evaluate(() => convReadTurnEnd(activePane, 'done'));
  expect(await page.evaluate(() => window.__sent.filter(m => m.type === 'read_pane'))).toEqual([]);
});

test('Show paired conversation joins separately recorded pair threads', async ({page}) => {
  await open(page);
  await joinSeparatePair(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  await expect(page.locator('#convThread .conv-msg')).toHaveCount(3);
  await expect(page.locator('#convThread')).toContainText('the partner kept its own thread');
  await page.locator('#termMenuBtn').click();
  await expect(page.locator('#menuConvJoint')).toHaveText('Show this pane alone');
  await page.locator('#menuConvJoint').click();
  await expect(page.locator('#convThread .conv-msg')).toHaveCount(2);
  await page.locator('#termMenuBtn').click();
  await page.locator('#menuConvJoint').click();
  await expect(page.locator('#convThread .conv-msg')).toHaveCount(3);
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
  // The user's own text carries one colour of its own, and it is not any agent's.
  await expect(msgs.nth(2)).toHaveCSS('color', 'rgb(158, 206, 106)');
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
  await expect(page.locator('#convThread .conv-who').first()).toHaveCSS('font-size', '9px');
});

test('final-only view counts only the bubbles it shows', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  await page.locator('#termMenuBtn').click();
  await page.locator('#menuConvFinal').click();
  // This pane's first read is backfill and filtered out; the partner's two committed entries
  // remain. The header must not keep its pre-filter cached total of four.
  await expect(page.locator('#convThread .conv-msg')).toHaveCount(2);
  await expect(page.locator('#convThread .conv-head')).toContainText('2 messages');
});

test('the conversation text size is applied before the first thread is painted', async ({page}) => {
  // The control writes a CSS custom property. Nothing else reads localStorage for it, so a boot
  // that forgets to apply it shows the default until the gear menu happens to be opened.
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  await page.evaluate(() => localStorage.setItem('herdr_conv_font_size', '16'));
  await page.reload();
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#convThread .conv-msg').first()).toHaveCSS('font-size', '16px');
});

test('every bubble names the harness beside the member, including one that has exited', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  const badges = page.locator('#convThread .conv-msg .conv-who .badge');
  await expect(badges.first()).toHaveText('codex');     // scratch, still live
  await expect(badges.nth(1)).toHaveText('claude');
  // The recorder stamps the harness on each entry, which is what lets a member that has since
  // exited keep its own badge rather than borrowing the open pane's.
  const key = await page.evaluate(() => convMemberKey(paneOf(activePane)));
  expect((await held(page, key)).entries.every(e => e.agent === 'claude')).toBe(true);
  await page.evaluate(() => { agents = agents.filter(a => a.label !== 'scratch'); renderConvView(); });
  await expect(page.locator('#convThread .conv-msg .conv-who .badge').first()).toHaveText('codex');
});

test('the newest bubble wears the pane state, and only the newest', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  const badge = page.locator('#convThread .conv-badge');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveText('done');
  await expect(page.locator('#convThread .conv-msg').last().locator('.conv-badge')).toHaveCount(1);
  // An agent that starts working says so on the thread, without the thread being rebuilt.
  await page.evaluate(() => { paneOf(activePane).status = 'working'; syncConvBadge(); });
  await expect(badge).toHaveText('working');
  await page.evaluate(() => { paneOf(activePane).status = 'blocked'; syncConvBadge(); });
  await expect(badge).toHaveText('blocked');
  // Idle is what a pane is nearly all of the time, so it is not a badge.
  await page.evaluate(() => { paneOf(activePane).status = 'idle'; syncConvBadge(); });
  await expect(badge).toHaveCount(0);
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
  await page.locator('#termMenuBtn').click();
  await expect(page.locator('#menuConvJoint')).toHaveText('Show paired conversation');
  await page.locator('#menuConvJoint').click();
  await expect(page.locator('#convThread .conv-msg')).toHaveCount(4);
  await expect(page.locator('#convThread .conv-members')).toHaveCount(1);
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

test('Last goes to the end of the thread, the same button that ends the pane', async ({page}) => {
  await open(page);
  const key = await join(page);
  await page.evaluate(async k => {
    const entries = [];
    for (let i = 0; i < 40; i++) entries.push({who: 'agent', text: 'turn ' + i, seen: i + 1});
    await convPut({key: k, label: 'Architect 1', first: 1, touched: 40, entries: entries});
  }, key);
  await page.locator('#quickActions .qa-conv').click();
  const top = await page.evaluate(() => {
    const box = document.getElementById('convThread');
    box.scrollTop = 0;
    return box.scrollHeight > box.clientHeight;
  });
  expect(top, 'the thread has to overflow for the button to have anywhere to go').toBe(true);
  await page.locator('#quickActions .qa-last').click();
  const atEnd = await page.evaluate(() => {
    const box = document.getElementById('convThread');
    return box.scrollHeight - box.scrollTop - box.clientHeight;
  });
  expect(atEnd).toBeLessThan(4);
});

test('Summary ticks the newest agent bubble, and a tick is what a selection is here', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  const msgs = page.locator('#convThread .conv-msg');
  await expect(msgs).toHaveCount(2);
  await expect(msgs.nth(0).locator('.conv-pick')).toHaveCSS('right', '10px');
  await page.locator('#quickActions .qa-summary').click();
  // The newest *agent* message, not the newest message: the user's prompt is the later of the two.
  await expect(msgs.nth(0)).toHaveClass(/picked/);
  await expect(msgs.nth(1)).not.toHaveClass(/picked/);
  await expect(page.locator('#convThread .conv-msg').nth(0).locator('.conv-pick'))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#selBar')).toBeVisible();
  await expect(page.locator('#selCount')).toHaveText('1 message');
  // Learn reads a gutter glyph off pane lines, and there are none under a bubble.
  await expect(page.locator('#selLearn')).toBeHidden();
  // The tick is the selection control: a second one adds, and unticking gives the bar back.
  await msgs.nth(1).locator('.conv-pick').click();
  await expect(page.locator('#selCount')).toHaveText('2 messages');
  // Copy and Transfer both read selText, and they read it in thread order rather than tap order.
  const sel = await page.evaluate(() => selText);
  expect(sel.indexOf('Ready. Name the change.')).toBeGreaterThan(-1);
  expect(sel.indexOf('Ready. Name the change.')).toBeLessThan(sel.indexOf('allow the test commands'));
  await msgs.nth(0).locator('.conv-pick').click();
  await msgs.nth(1).locator('.conv-pick').click();
  await expect(page.locator('#selBar')).toBeHidden();
});

test('leaving a thread clears its bubble selection', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  await page.locator('#quickActions .qa-summary').click();
  await expect(page.locator('#selBar')).toBeVisible();
  await page.locator('#quickActions .qa-conv').click();
  await expect(page.locator('#selBar')).toBeHidden();
  expect(await page.evaluate(() => selText)).toBe('');
});

test('the line ruler stays out of the thread, and comes back with the rows', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  expect(await page.evaluate(() => rulerOn())).toBe(false);
  await page.locator('#quickActions .qa-conv').click();
  expect(await page.evaluate(() => rulerOn())).toBe(true);
});

test('leaving a thread keeps an existing ruler selection', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  const kept = await page.evaluate(() => { selA = 0; selB = 0; drawSel(); return selText; });
  await page.locator('#quickActions .qa-conv').click();
  await page.locator('#quickActions .qa-conv').click();
  expect(await page.evaluate(() => ({selA, selB, selText})))
    .toEqual({selA: 0, selB: 0, selText: kept});
});

test('a conversation card opens a live member, on its thread', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#terminalView .back').click();
  const card = page.locator('#conversations .conversation-card');
  await expect(card).toContainText('new authentication feature');
  await card.click();
  // Straight to the thread: the card names a conversation, so the pane it opens shows one.
  await expect(page.locator('#convThread')).toBeVisible();
  await expect(page.locator('#convThread .conv-msg')).toHaveCount(2);
});

test('a conversation whose panes have all exited says so rather than doing nothing', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#terminalView .back').click();
  // The pane is gone from the snapshot: what is left is a record with nothing live to open.
  await page.evaluate(() => { agents = []; renderBody(); });
  await page.locator('#conversations .conversation-card').click();
  await expect(page.locator('#toast')).toContainText('No live pane');
});
