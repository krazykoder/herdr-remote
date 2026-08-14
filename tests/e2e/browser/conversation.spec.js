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

// Hold a pane at a status the fake herdr never reports. Setting it on the `agents` array alone
// loses the race with the 3s poll, which replaces that array wholesale — so the snapshot itself is
// what gets rewritten, on the way in and every time.
const forceStatus = (page, label, status) => page.evaluate(([label, status]) => {
  const orig = ws.onmessage;
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'agents') {
      for (const a of d.agents) if (a.label === label) a.status = status;
      return orig({data: JSON.stringify(d)});
    }
    return orig(e);
  };
  const a = agents.find(x => x.label === label);
  if (a) a.status = status;
}, [label, status]);

const held = (page, key) => page.evaluate(async k => (await convGet([k]))[0] || null, key);
const tapWire = page => page.evaluate(() => {
  window.__sent = [];
  const send = ws.send.bind(ws);
  ws.send = message => { window.__sent.push(JSON.parse(message)); send(message); };
});

// The default recorder files every agent pane under a conversation of its own on the first
// snapshot (D5). Every test below that is about the recorder rather than about the default starts
// with it off, so what a pane is in is what the test put it in. The three that own the default
// switch it back on for themselves.
const autoOff = page => page.addInitScript(
  () => localStorage.setItem('herdr_conv_auto', 'off'));
const autoOn = page => page.addInitScript(
  () => localStorage.setItem('herdr_conv_auto', 'on'));

test.beforeEach(async ({page}) => {
  await autoOff(page);
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

test('a card opens the conversation itself, not a pane', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();

  // The record, read as itself: no pane open, no composer, no rows behind it.
  await expect(page.locator('#convView')).toBeVisible();
  await expect(page.locator('#convViewTitle')).toHaveText('new authentication feature');
  await expect(page.locator('#convViewThread .conv-msg')).toHaveCount(2);
  await expect(page.locator('#convViewCount')).toHaveText('2 messages');
  expect(await page.evaluate(() => activePane)).toBe(null);
  // Read-only: a bubble here is not a selection, so it carries no tick.
  await expect(page.locator('#convViewThread .conv-pick')).toHaveCount(0);

  // Conversation tabs replace pane tabs in the shared bottom header. A separate strip would make
  // two tab rows compete for the same thumb space.
  const bottom = await page.evaluate(() => {
    const header = document.querySelector('.header').getBoundingClientRect();
    const status = document.getElementById('statusBar').getBoundingClientRect();
    return {paneTabs: getComputedStyle(document.getElementById('agentTabs')).display,
      convTabs: getComputedStyle(document.getElementById('convStrip')).display,
      stripInHeader: document.getElementById('convStrip').parentElement.classList.contains('header'),
      headerBottom: header.bottom, statusTop: status.top};
  });
  expect(bottom.paneTabs).toBe('none');
  expect(bottom.convTabs).toBe('flex');
  expect(bottom.stripInHeader).toBe(true);
  expect(bottom.headerBottom).toBeLessThanOrEqual(bottom.statusTop);

  // And back where it came from.
  await page.locator('#convView .back').click();
  await expect(page.locator('#conversations .conversation-card')).toBeVisible();
});

test('a conversation whose panes have all exited is still the record it was', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  // The pane leaves the snapshot: the member stays, the words stay, and the card still names the
  // thing worth reading. This is the case the view exists for — it used to be a dead end.
  await page.evaluate(() => { agents = []; renderBody(); });
  await page.locator('#conversations .conversation-card').click();
  await expect(page.locator('#convViewTitle')).toHaveText('new authentication feature');
  await expect(page.locator('#convViewThread .conv-msg')).toHaveCount(2);
  // Nothing to open, said by not offering it rather than by a toast after the tap.
  await expect(page.locator('#convViewOpen')).toBeHidden();
});

test('the live member is one tap on, in its own thread', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();
  await page.locator('#convViewOpen').click();
  await expect(page.locator('#termTitle')).toContainText(AGENT);
  // Opened on the thread and not on the rows: the conversation is what the reader was reading.
  await expect(page.locator('#convThread')).toBeVisible();
  await expect(page.locator('#convView')).toBeHidden();
});

// The card, then the view: every action below is the conversation's own rather than a pane's.
const openCard = async page => {
  await open(page);
  const key = await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();
  await expect(page.locator('#convView')).toBeVisible();
  // The roster and the conversation's own actions live behind the header's disclosure, so every
  // test that acts on one opens it first — which is also the user's first tap.
  await openRoster(page);
  return key;
};

const openRoster = async page => {
  await page.locator('#convViewWho').click();
  await expect(page.locator('#convViewRoster')).toBeVisible();
};

test('naming a conversation is what promotes it out of the evictable tier', async ({page}) => {
  await openCard(page);
  // It starts as one the app filed for itself. Naming is the whole ceremony (D4): no keep
  // checkbox, no archive, no second concept — and the tier is what eviction reads.
  await page.evaluate(() => {
    const items = loadConvIndex();
    items[0].auto = true;
    saveConvIndex(items);
    renderConvStandalone(false);
  });
  page.once('dialog', d => d.accept('the auth rewrite'));
  await page.locator('#convView .conv-roster-actions button', {hasText: 'Rename'}).click();
  await expect(page.locator('#convViewTitle')).toHaveText('the auth rewrite');
  const conv = await page.evaluate(() => loadConvIndex()[0]);
  expect(conv.name).toBe('the auth rewrite');
  expect(conv.auto).toBeUndefined();
  // And the card the view was opened from says the new name too.
  await page.locator('#convView .back').click();
  await expect(page.locator('#conversations .conversation-card')).toContainText('the auth rewrite');
});

test('conversation management actions keep their intended order', async ({page}) => {
  await openCard(page);
  await expect(page.locator('#convView .conv-roster-actions button')).toHaveText([
    'Delete', 'Copy', 'Duplicate', 'Rename', 'Add pane',
  ]);
});

test('a live pane can be added to a conversation from the conversation', async ({page}) => {
  await openCard(page);
  await expect(page.locator('#convView .conv-roster-row')).toHaveCount(1);
  await page.locator('#convView .conv-roster-actions button', {hasText: 'Add pane'}).click();
  await page.locator('#convView .conv-roster-add .conv-chip', {hasText: 'scratch'}).click();
  await expect(page.locator('#convView .conv-roster-row')).toHaveCount(2);
  await expect(page.locator('#convView .conv-roster-row').nth(1)).toContainText('recording');
  // The picker closes behind the pick, and the roster is what changed on disk.
  await expect(page.locator('#convView .conv-roster-add')).toHaveCount(0);
  expect(await page.evaluate(() => loadConvIndex()[0].members.length)).toBe(2);
});

test('a member removed is asked about first, and takes its words with it', async ({page}) => {
  const key = await openCard(page);
  await expect(page.locator('#convViewThread .conv-msg')).toHaveCount(2);
  // One tap only arms, and says what the second will do. An accidental tap on the one control
  // here that loses history changes nothing.
  const drop = page.locator('#convView .conv-drop');
  await drop.click();
  await expect(drop).toHaveText('Remove?');
  await expect(drop).toHaveAttribute('data-armed', '1');
  await expect(page.locator('#convView .conv-roster-row')).toHaveCount(1);
  // And an arm left alone expires rather than waiting to be pressed.
  await expect(drop).toHaveText('Remove', {timeout: 4000});

  await drop.click();
  await drop.click();
  await expect(page.locator('#convView .conv-roster-row')).toHaveCount(0);
  await expect(page.locator('#convViewThread .conv-msg')).toHaveCount(0);
  // The record is still on disk — removal unreferences a transcript, it does not delete one.
  expect(await page.evaluate(() => loadConvIndex()[0].members.length)).toBe(0);
  expect((await held(page, key)).entries.length).toBe(2);
});

test('every session records itself, into a conversation named for the pane', async ({page}) => {
  await autoOn(page);
  // Book-keeping is not served by a switch you have to remember to throw before the thing worth
  // keeping happens (D5), so this is what the app does on its own, on the first snapshot.
  await page.goto('/');
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  const items = await page.evaluate(() => loadConvIndex());
  expect(items.every(c => c.auto)).toBe(true);
  expect(items.map(c => c.name).sort()).toEqual(['relay · Architect 1', 'tmp · scratch']);
  expect(items.every(c => c.members.length === 1)).toBe(true);
  // One per pane and not one per project: a project runs several threads of work at once.
  expect(new Set(items.map(c => c.members[0].key)).size).toBe(items.length);
  // amp has no gutter profile, so there is nothing to record and no record is filed — the same
  // gate the menu item uses.
  expect(items.some(c => c.name.includes('amp'))).toBe(false);
});

test('the default recorder records, without anybody joining anything', async ({page}) => {
  await autoOn(page);
  // The whole of D5 end to end: open a pane, read it, and the words are kept — no dialog, no
  // membership edit, nothing the user had to remember before the thing worth keeping happened.
  await open(page);
  await read(page);
  const out = await page.evaluate(async () => {
    const conv = convsForPane(paneOf(activePane))[0];
    const rec = (await convGet([convMemberKey(paneOf(activePane))]))[0];
    return {name: conv.name, auto: !!conv.auto, texts: rec.entries.map(e => e.text)};
  });
  expect(out.auto).toBe(true);
  expect(out.name).toBe('relay · Architect 1');
  expect(out.texts[0]).toMatch(/^Ready\. Name the change\./);
  // And it is on screen in the thread, which is the only part of this the user ever sees.
  await page.evaluate(() => { toggleConvView(); });
  await expect(page.locator('#convThread .conv-msg').first()).toContainText('Ready.');
});

test('a pane is filed once ever, so removing it does not undo itself', async ({page}) => {
  await autoOn(page);
  await page.goto('/');
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  await page.evaluate(() => saveConvIndex([]));
  // Every later snapshot, and a reload on top: "already in an auto conversation" is deliberately
  // not the question asked, or a member the user removed would come back on the next poll.
  await page.evaluate(() => { convAutoJoin(); convAutoJoin(); });
  expect(await page.evaluate(() => loadConvIndex().length)).toBe(0);
  await page.reload();
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  expect(await page.evaluate(() => loadConvIndex().length)).toBe(0);
});

test('switched off, nothing new is filed', async ({page}) => {
  await autoOn(page);
  await page.goto('/');
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  await page.evaluate(() => {
    saveConvIndex([]);
    localStorage.removeItem('herdr_conv_auto_seen');
    toggleConvAuto();
    convAutoJoin();
  });
  expect(await page.evaluate(() => loadConvIndex().length)).toBe(0);
  expect(await page.evaluate(() => convAutoOn())).toBe(false);
});

test('at the conversation ceiling it is the auto tier that gives way', async ({page}) => {
  await page.goto('/');
  const kept = await page.evaluate(() => {
    const items = [];
    for (let i = 0; i < CONV_CONV_MAX + 5; i++) {
      items.push({id: 'c' + i, name: 'c' + i, created: i, members: [], auto: i % 2 === 0});
    }
    saveConvIndex(items);
    return loadConvIndex();
  });
  expect(kept.length).toBe(200);
  // The five dropped are the oldest autos, and every named one is still there: new conversations
  // are prepended, so slicing the tail would have taken the named ones first.
  expect(kept.filter(c => !c.auto).length).toBe(102);
  // c0..c8 even are the five oldest autos and are the five that went; every named one stayed.
  expect(kept.some(c => c.id === 'c8')).toBe(false);
  expect(kept.some(c => c.id === 'c10')).toBe(true);
  expect(kept.some(c => c.id === 'c1')).toBe(true);
});

test('a full named index is never trimmed, and a pane refused a slot retries later', async ({page}) => {
  await autoOn(page);
  await page.goto('/');
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  const result = await page.evaluate(() => {
    const recordable = agents.filter(a => profileFor(a.agent)).map(a => convMemberKey(a));
    const named = n => Array.from({length: n}, (_, i) =>
      ({id: 'named' + i, name: 'named' + i, created: i, members: []}));
    localStorage.removeItem('herdr_conv_auto_seen');
    // One past the ceiling and every one of them named. Nothing may go: a named record is a floor
    // (D2), and a ceiling is not a licence to delete one.
    saveConvIndex(named(CONV_CONV_MAX + 1));
    convAutoJoin();
    const full = {
      count: loadConvIndex().length,
      auto: loadConvIndex().filter(c => c.auto).length,
      seen: convAutoSeen().length,
    };
    // Room for exactly the panes that record. A pane refused a slot was never marked filed, so
    // this is its retry — without it its transcript would be lost for good.
    saveConvIndex(named(CONV_CONV_MAX - recordable.length));
    convAutoJoin();
    return {full, recordable: recordable.length, after: {
      autos: loadConvIndex().filter(c => c.auto).length,
      seen: recordable.every(k => convAutoSeen().includes(k)),
    }};
  });
  expect(result.full).toEqual({count: 201, auto: 0, seen: 0});
  expect(result.after).toEqual({autos: result.recordable, seen: true});
});

test('the card says what the conversation is doing and what was last said', async ({page}) => {
  await openCard(page);
  await page.locator('#convView .back').click();
  const card = page.locator('#conversations .conversation-card');
  await expect(card.locator('.conversation-last')).toHaveText('allow the test commands without prompting');
  // The tier is on the card, never in the name — promotion is a rename the user makes.
  await expect(card.locator('.conversation-tier')).toHaveCount(0);
  await page.evaluate(() => {
    const items = loadConvIndex();
    items[0].auto = true;
    saveConvIndex(items);
    // Auto records are behind their own control on the landing page; this is that control.
    localStorage.setItem(CONV_LANDING_AUTO_KEY, 'on');
    renderConversations();
  });
  await expect(card.locator('.conversation-tier')).toHaveText('auto');
});

test('a live conversation carries its agent’s own dot, pulse and all', async ({page}) => {
  await autoOn(page);
  await page.goto('/');
  await expect(page.locator('#agents .agent', {hasText: AGENT})).toBeVisible();
  await page.evaluate(() => {
    toggleSection('conversations', true);
    localStorage.setItem(CONV_LANDING_AUTO_KEY, 'on');   // every card here is an auto one
    renderConversations();
  });
  // The card stands in for the panes in it, so it says what they say. scratch is the pane the
  // fake herdr reports as working — the one whose card pulses.
  const shown = await page.evaluate(() => {
    const card = Array.from(document.querySelectorAll('#conversations .conversation-card'))
      .find(c => c.textContent.includes('scratch'));
    const mine = card.querySelector('.dot'), theirs = document.querySelector('#agents .agent .dot');
    const seen = el => {
      const c = getComputedStyle(el);
      return {fill: c.backgroundColor, beat: c.animationName, size: c.width};
    };
    return {card: seen(mine), agent: seen(theirs)};
  });
  expect(shown.card).toEqual(shown.agent);
  expect(shown.card.beat).toBe('pulse');
});

test('landing keeps auto conversations optional and bounded', async ({page}) => {
  await page.goto('/');
  await page.evaluate(() => {
    const named = {id: 'named', name: 'named', created: 1, members: []};
    const autos = Array.from({length: 12}, (_, i) =>
      ({id: 'auto' + i, name: 'auto' + i, created: i + 2, members: [], auto: true}));
    localStorage.removeItem(CONV_LANDING_AUTO_KEY);
    saveConvIndex([named].concat(autos));
    toggleSection('conversations', true);
    renderConversations();
  });
  await expect(page.locator('#conversations .conversation-card')).toHaveCount(1);
  await expect(page.locator('#conversations .section-action')).toHaveText('Show auto (12)');
  await page.locator('#conversations .section-action').click();
  await expect(page.locator('#conversations .conversation-card')).toHaveCount(11);
  await expect(page.locator('#conversations .section-action')).toHaveText('Hide auto (12)');
});

test('a conversation copies out as Markdown, roster included', async ({page, context}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCard(page);
  await page.locator('#convView .conv-roster-actions button', {hasText: 'Copy'}).click();
  await expect(page.locator('#convCopyBtn')).toHaveText('Copied');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('# new authentication feature');
  expect(text).toContain('- Architect 1 — claude');
  expect(text).toContain('### Architect 1 — ');
  expect(text).toContain('Ready. Name the change.');
  expect(text).toContain('allow the test commands without prompting');
});

// A dead member with a startable record behind it. The harness relay runs without Projects, so
// both halves of canRespawn's gate are seeded here — what is being tested is the message the tap
// sends, and the member the reply becomes.
const endMember = page => page.evaluate(async () => {
  projects = [{id: 'p1', label: 'herdr-remote', host: 'local'}];
  startOptions = {type: 'start_options', agents: ['claude', 'codex'], roles: ['architect', 'coder']};
  const items = loadConvIndex();
  const old = items[0].members[0];
  const rec = (await convGet([old.key]))[0];
  rec.key = 'dead:pane';
  rec.spawn = {agent: 'claude', role: 'architect', label: 'Architect 1', project_id: 'p1',
    project: 'herdr-remote', cwd: '/work/herdr-remote', host: 'local', workspace_id: 'w404'};
  await convPut(rec);
  items[0].members = [{key: 'dead:pane', added: Date.now(), label: 'Architect 1'}];
  saveConvIndex(items);
  await renderConvStandalone(false);
});

test('an ended session can be started again, and the new pane joins as a new member', async ({page}) => {
  await openCard(page);
  await endMember(page);
  await tapWire(page);
  await expect(page.locator('#convView .conv-roster-row.gone')).toHaveCount(1);

  // Two taps, because the second one starts a real session on a real host. The first says where
  // it will land — the drain cannot carry a sentence, so the toast does.
  const again = page.locator('#convView .conv-again');
  await again.click();
  await expect(again).toHaveText('Start again?');
  await expect(page.locator('#toast')).toContainText('new claude session in herdr-remote');
  expect(await page.evaluate(() => window.__sent.filter(m => m.type === 'start_agent'))).toEqual([]);

  await again.click();
  await expect.poll(() => page.evaluate(() => window.__sent.filter(m => m.type === 'start_agent')))
    .toHaveLength(1);
  const sent = await page.evaluate(() => window.__sent.find(m => m.type === 'start_agent'));
  expect(sent.name).toBe('claude');
  expect(sent.role).toBe('architect');
  expect(sent.project_id).toBe('p1');
  // The relay takes a new session's cwd from the Project and never from the client. The recorded
  // cwd is a record of where it ran, and sending it would make it an instruction.
  expect(sent.cwd).toBeUndefined();
  // w404 is not a live workspace, so a stale ID is not trusted to place it — herdr recycles them.
  expect(sent.placement).toBe('new_workspace');
  expect(sent.workspace_id).toBeUndefined();

  // The reply lands, the pane shows up on the next snapshot, and it joins as a NEW member: a new
  // pane means a new key, which means a new transcript, so no recycled id inherits dead words.
  await page.evaluate(() => {
    handleMessage({type: 'command_result', command: 'start_agent', ok: true, pane_id: 'w1:p1'});
    openPendingStart();
  });
  const members = await page.evaluate(() => loadConvIndex()[0].members.map(m => m.key));
  expect(members.length).toBe(2);
  expect(members[0]).toBe('dead:pane');
  expect(members[1]).not.toBe('dead:pane');
  // And it opens on the thread — continuing a conversation is asking to say the next thing in it.
  await expect(page.locator('#convThread')).toBeVisible();
});

test('an ended session with no Project the relay knows is offered no button', async ({page}) => {
  await openCard(page);
  await endMember(page);
  await expect(page.locator('#convView .conv-again')).toHaveCount(1);
  // Every one of canRespawn's three gates, one at a time: an unstartable session gets no button
  // rather than a refusal after the tap.
  for (const kill of ['projects = []',
                      'startOptions = {agents: ["codex"], roles: ["architect"]}',
                      'startOptions = null']) {
    await page.evaluate(k => { eval(k); renderConvStandalone(false); }, kill);
    await expect(page.locator('#convView .conv-again')).toHaveCount(0);
    await endMember(page);
  }
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

test('a named conversation keeps its record when the store is full', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  // Fill the store past its ceiling with transcripts nobody named, then run the same eviction pass
  // a write runs. The named record is a floor: deleting it to make room is the one failure this
  // feature cannot absorb, so the loose ones go and it stays.
  const left = await page.evaluate(async k => {
    for (let i = 0; i < 6; i++) {
      await convPut({key: 'loose' + i, label: 'x', first: 1, touched: 1, entries:
        [{who: 'agent', text: 'noise', at: 1, at_src: 'read'}]});
    }
    const db = await openConvDB();
    const all = await idbReq(db.transaction('transcripts', 'readonly')
      .objectStore('transcripts').getAll());
    // A ceiling of 2 against 7 records, one of which is named.
    const drop = convEvictable(all, convReferenced(), convKept(), 2);
    return {drop: drop, named: drop.includes(k), total: all.length};
  }, key);
  expect(left.total).toBe(7);
  expect(left.named).toBe(false);
  expect(left.drop.length).toBe(5);
});

test('a store full of named records is left alone, and says so', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  const toast = await page.evaluate(async () => {
    // A second record, and the conversation names it too — so every transcript in the store is
    // held by a name and the ceiling has nothing it is allowed to take.
    await convPut({key: 'k2', label: 'x', first: 1, touched: 1,
      entries: [{who: 'agent', text: 'also kept', at: 1, at_src: 'read'}]});
    const items = loadConvIndex();
    items[0].members.push({key: 'k2', added: Date.now(), label: 'x'});
    saveConvIndex(items);
    const db = await openConvDB();
    const all = await idbReq(db.transaction('transcripts', 'readonly')
      .objectStore('transcripts').getAll());
    const drop = convEvictable(all, convReferenced(), convKept(), 1);
    return {drop: drop.length, kept: all.length,
            said: document.getElementById('toast').textContent};
  });
  expect(toast.kept).toBe(2);
  expect(toast.drop).toBe(0);
  expect(toast.said).toMatch(/nothing was deleted/i);
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

test('a send before the first pane read is written once, before its reply', async ({page}) => {
  await open(page);
  const key = await join(page);
  await page.evaluate(async () => {
    const now = Date.now(), pane = activePane;
    paneOf(pane).status = 'done';
    statusAt[pane] = {last: 'done', working: now - 2, done: now - 1};
    await convRecordSend(pane, 'second question', null, now - 3);
    await recordPane(pane, [
      '❯ first question', '', '⏺ First answer.', '', '❯ second question', '',
      '⏺ Second answer.', '', '❯',
    ]);
  });
  expect((await held(page, key)).entries.map(e => e.text)).toEqual([
    'first question', 'First answer.', 'second question', 'Second answer.',
  ]);
});

test('a working first read keeps replies before its live draft', async ({page}) => {
  await open(page);
  const key = await join(page);
  await page.evaluate(async () => {
    const now = Date.now(), pane = activePane;
    paneOf(pane).status = 'working';
    await convRecordSend(pane, 'first question', null, now - 2);
    await convRecordSend(pane, 'second question', null, now - 1);
    await recordPane(pane, [
      '❯ old business', '', '⏺ Older answer.', '',
      '❯ first question', '', '⏺ First answer.', '',
      '❯ second question', '', '⏺ Still working.', '', '❯',
    ]);
  });
  expect((await held(page, key)).entries.map(e => e.text)).toEqual([
    'old business', 'Older answer.', 'first question', 'second question', 'First answer.',
  ]);
});

test('a member found already finished is read once, and recorded only if it is new',
  async ({page}) => {
    await open(page);
    const key = await join(page);
    await read(page);
    const before = (await held(page, key)).entries.length;

    // What a reload looks like from inside: the socket's first snapshot, with no previous status
    // for any pane. The fake herdr's claude pane reports `idle`, so the status the recorder cares
    // about is put on the snapshot rather than on the fixture — every other spec counts those
    // panes. `prevStatuses` is emptied because that, and not the reload itself, is what makes a
    // status first-sight.
    await tapWire(page);
    await page.evaluate(() => {
      for (const k of Object.keys(prevStatuses)) delete prevStatuses[k];
      delete statusAt[activePane];
      handleMessage({type: 'agents', agents: agents.map(a =>
        a.pane_id === activePane ? Object.assign({}, a, {status: 'done'}) : a)});
    });
    // Nothing transitioned — it was already finished when the page arrived — and it is read
    // anyway. That read is the only way a turn that ended while the tab was closed is ever seen.
    await expect.poll(() => page.evaluate(() =>
      window.__sent.filter(m => m.type === 'read_pane' && m.pane_id === 'w1:p1').length)).toBe(1);
    // And the turn it finds is the one already recorded, so coming back costs no duplicate.
    await read(page);
    expect((await held(page, key)).entries.length).toBe(before);
  });

test('a turn that ended while nothing was connected is recovered off the pane', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);

  await page.evaluate(() => {
    for (const k of Object.keys(prevStatuses)) delete prevStatuses[k];
    delete statusAt[activePane];
    handleMessage({type: 'agents', agents: agents.map(a =>
      a.pane_id === activePane ? Object.assign({}, a, {status: 'done'}) : a)});
  });
  // The pane says something the transcript has never heard, which is what a turn that ended while
  // the tab was closed looks like from here.
  await read(page, '❯ what changed?\n\n⏺ The relay now polls slower.\n\n❯\n');
  const rec = await held(page, key);
  expect(rec.entries.map(e => e.text)).toContain('The relay now polls slower.');
  // Found, not watched: the reconnect is not when the agent finished, and the stamp says so.
  expect(rec.entries[rec.entries.length - 1].at_src).toBe('read');
});

test('a turn that ends the way herdr really reports it is recorded', async ({page}) => {
  // The regression this exists for. herdr 0.8.0's agent lifecycle vocabulary is
  // `idle, working, blocked, unknown` — `herdr pane report-agent --state` enumerates exactly those
  // four — so an agent finishing is `working -> idle` and nothing ever reports `done`. The turn
  // clock watched `done` and `blocked`, so it never moved, and a transcript kept whatever its
  // first read backfilled and never gained another word the agent said.
  //
  // Every other test in this file forces `done` onto a pane, which is why the suite stayed green
  // through it. This one drives the transition the relay actually delivers, through the handler
  // that actually receives it.
  await open(page);
  const key = await join(page);
  // The first read backfills whatever is on screen whatever the status is, which is the half that
  // kept working and the reason this went a day unnoticed.
  await page.evaluate(async text => {
    setPaneText(text);
    await recordPane(activePane, paneRows);
  }, PANE);
  const before = (await held(page, key)).entries.length;
  expect(before).toBeGreaterThan(0);

  const snapshot = (page, status) => page.evaluate(s => handleMessage({
    type: 'agents',
    agents: agents.map(a => (a.pane_id === activePane ? Object.assign({}, a, {status: s}) : a)),
  }), status);
  await snapshot(page, 'working');
  await snapshot(page, 'idle');

  await page.evaluate(async () => {
    setPaneText('\u276f what changed?\n\n\u23fa The relay now polls slower.\n\n\u276f\n');
    await recordPane(activePane, paneRows);
  });
  const rec = await held(page, key);
  expect(rec.entries.map(e => e.text)).toContain('The relay now polls slower.');
  expect(rec.entries.length).toBeGreaterThan(before);
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
    conversationWidth: Math.round(el.querySelector('.qa-conv').getBoundingClientRect().width),
    rows: [...el.children].map(child => {
      const r = child.getBoundingClientRect();
      return Math.round(r.y);
    }),
  }));
  expect(nav.children).toBe(3);
  expect(nav.conversationWidth).toBe(34);
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
  expect(layout[0].right).toBe('flex-start');
  expect(layout[1].right).toBe('flex-end');
  expect(layout[2].user).toBe(true);
  expect(layout[2].right).toBe('flex-end');           // prompt sent to Architect 1
  // The user's own text carries one colour of its own, and it is not any agent's.
  await expect(msgs.nth(2)).toHaveCSS('color', 'rgb(158, 206, 106)');
});

test('thread Transfer targets selected member’s partner', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await page.evaluate(() => {
    pairs = [{id: 'p1', members: [recentFingerprint(paneOf(activePane)),
      recentFingerprint(agents.find(a => a.label === 'scratch'))]}];
  });
  await read(page);
  // After the read and not before: read() forces the open pane to `done`, which is the status the
  // transfer sheet would then have drawn.
  await forceStatus(page, 'Architect 1', 'working');
  await page.locator('#quickActions .qa-conv').click();
  // First bubble belongs to scratch, while Architect 1 remains the open pane.
  await page.locator('#convThread .conv-msg').first().locator('.conv-pick').click();
  await page.locator('#selTransfer').click();
  await expect(page.locator('#transferSheet')).toBeVisible();
  await expect(page.locator('#transferTarget')).toHaveText('Architect 1');
  // One agent's output entering another's context: which agent is the fact the reader has to be
  // sure of, so the sheet says it the way the agent list does — name, harness badge, live dot.
  await expect(page.locator('#transferBadge')).toHaveText('claude');
  await expect(page.locator('#transferSheet .transfer-head .who')).toHaveCSS('justify-content', 'center');
  const dot = await page.evaluate(() => {
    const c = getComputedStyle(document.getElementById('transferDot'));
    return {fill: c.backgroundColor, size: c.width, beat: c.animationName};
  });
  expect(dot.size).toBe('8px');
  expect(dot.fill).not.toBe('rgba(0, 0, 0, 0)');
  expect(dot.beat).toBe('pulse');
});

test('pair strip names its composer target and switching keeps composer focus', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    pairs = [{id: 'p1', members: [recentFingerprint(paneOf(activePane)),
      recentFingerprint(agents.find(a => a.label === 'scratch'))]}];
    renderPairStrip();
  });
  await expect(page.locator('#pairStrip .pair-target')).toContainText('Architect 1');
  await expect(page.locator('#pairStrip .pair-target')).toContainText('claude');
  await page.locator('#termInput').focus();
  await page.locator('#pairStrip .switch').click();
  await expect.poll(() => page.evaluate(() => ({pane: paneLabel(paneOf(activePane)), focus: document.activeElement.id})))
    .toEqual({pane: 'scratch', focus: 'termInput'});
  await expect(page.locator('#pairStrip .pair-target')).toContainText('scratch');
});

test('folding the composer away takes the typing target with it', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    pairs = [{id: 'p1', members: [recentFingerprint(paneOf(activePane)),
      recentFingerprint(agents.find(a => a.label === 'scratch'))]}];
    renderPairStrip();
  });
  await expect(page.locator('#pairStrip .pair-target')).toContainText('Architect 1');
  // The strip names the pane the composer types into, so it is only true while there is one. The
  // fold is the button that decides that, and it has to redraw the strip itself — the poll is
  // three seconds away.
  await page.locator('#quickActions .qa-fold').click();
  await expect(page.locator('#pairStrip .pair-target')).toHaveCount(0);
  await expect(page.locator('#pairStrip .pair-name')).toBeVisible();
  await page.locator('#quickActions .qa-fold').click();
  await expect(page.locator('#pairStrip .pair-target')).toContainText('Architect 1');
});

test('an auto conversation says how to make it permanent', async ({page}) => {
  await openCard(page);
  await expect(page.locator('#convView .conv-tier-note')).toHaveCount(0);
  await page.evaluate(() => {
    const items = loadConvIndex();
    items[0].auto = true;
    saveConvIndex(items);
    renderConvStandalone(false);
  });
  // The question an auto record raises is "how do I make this one mine", and the answer is the
  // button directly above this line.
  await expect(page.locator('#convView .conv-tier-note')).toContainText('Rename it to keep it');
  page.once('dialog', d => d.accept('mine now'));
  await page.locator('#convView .conv-roster-actions button', {hasText: 'Rename'}).click();
  await expect(page.locator('#convView .conv-tier-note')).toHaveCount(0);
});

test('an auto conversation sheds its oldest ended sessions, and a named one never does', async ({page}) => {
  await open(page);
  const counts = await page.evaluate(async () => {
    const live = convMemberKey(paneOf(activePane));
    // Thirty sessions that have exited, plus the one still recording. The named conversation is
    // the control: the same roster, the tier the only difference.
    const ended = Array.from({length: 30}, (_, i) => ({key: 'gone' + i, added: i, label: 'old'}));
    saveConvIndex([
      {id: 'auto', name: 'auto one', created: 1, auto: true, members: ended.concat({key: live, added: 99})},
      {id: 'kept', name: 'named one', created: 1, members: ended.concat({key: live, added: 99})},
    ]);
    convPruneAuto();
    const by = Object.fromEntries(loadConvIndex().map(c => [c.id, c.members]));
    return {
      auto: by.auto.length, named: by.kept.length,
      // The live pane survives whatever else goes, and what goes is the oldest.
      autoLive: by.auto.some(m => m.key === live),
      oldestGone: !by.auto.some(m => m.key === 'gone0'),
      newestKept: by.auto.some(m => m.key === 'gone29'),
    };
  });
  expect(counts).toEqual({auto: 20, named: 31, autoLive: true, oldestGone: true, newestKept: true});
});

test('the prune never drops a recording member to make room', async ({page}) => {
  await open(page);
  const kept = await page.evaluate(async () => {
    const live = agents.map(a => convMemberKey(a)).filter(Boolean);
    saveConvIndex([{id: 'auto', name: 'auto one', created: 1, auto: true,
      members: live.map((key, i) => ({key, added: i}))
        .concat(Array.from({length: 25}, (_, i) => ({key: 'gone' + i, added: 100 + i})))}]);
    convPruneAuto();
    const members = loadConvIndex()[0].members;
    return {live: live.length, recording: members.filter(m => live.includes(m.key)).length,
      total: members.length};
  });
  // Every live pane stays, even though the ended ones it is holding above the cap are newer.
  expect(kept.recording).toBe(kept.live);
  expect(kept.total).toBe(20);
});

test('a conversation can be duplicated, and the copy is nobody\'s auto record', async ({page}) => {
  await openCard(page);
  await page.evaluate(() => {
    const items = loadConvIndex();
    items[0].auto = true;
    saveConvIndex(items);
    renderConvStandalone(false);
  });
  const dup1084 = page.locator('#convView .conv-roster-actions button', {hasText: 'Duplicate'});
  await dup1084.click();
  await dup1084.click();
  const out = await page.evaluate(() => {
    const items = loadConvIndex();
    return {names: items.map(c => c.name), autos: items.map(c => !!c.auto),
      rosters: items.map(c => c.members.map(m => m.key)), open: convViewId};
  });
  // Two groupings over the same transcripts. The copy is named, because making one is the
  // assertion that this grouping matters (D4) — and an evictable copy would not survive the
  // comparison it was made for.
  expect(out.names).toEqual(['new authentication feature (copy)', 'new authentication feature']);
  expect(out.autos).toEqual([false, true]);
  expect(out.rosters[0]).toEqual(out.rosters[1]);
  // And the view followed, because the next thing to do is add the pane it was copied for.
  expect(out.open).toBe(await page.evaluate(() => loadConvIndex()[0].id));
  await expect(page.locator('#convViewTitle')).toHaveText('new authentication feature (copy)');
});

test('a conversation deleted ends the grouping and keeps the words', async ({page}) => {
  const key = await openCard(page);
  await page.evaluate(key => localStorage.setItem('herdr_conv_view',
    JSON.stringify({[key]: 'c1', anotherPane: 'another conversation'})), key);
  const del = page.locator('#convView .conv-del');
  // One tap arms, and the record is still there.
  await del.click();
  await expect(del).toHaveText('Delete?');
  expect(await page.evaluate(() => loadConvIndex().length)).toBe(1);

  await del.click();
  expect(await page.evaluate(() => loadConvIndex().length)).toBe(0);
  // The view it was read in goes with it, and so does its per-conversation reading state.
  await expect(page.locator('#convView')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('herdr_conv_hidden'))).toBe('{}');
  expect(await page.evaluate(() => localStorage.getItem('herdr_conv_view')))
    .toBe(JSON.stringify({anotherPane: 'another conversation'}));
  // But not the transcript: a conversation is a roster and a name, and deleting one unreferences
  // words rather than erasing them.
  expect((await held(page, key)).entries.length).toBe(2);
});

test('a session that has already ended can be added from its recording', async ({page}) => {
  await openCard(page);
  // A pane this browser recorded and that is not running now — the whole reason to assemble a
  // conversation after the fact.
  await page.evaluate(async () => {
    await convPut({key: 'ghost', label: 'yesterday\'s codex', touched: Date.now() - 7200000,
      spawn: {agent: 'codex'},
      entries: [{who: 'agent', text: 'Shipped the migration.', at: Date.now() - 7200000,
        at_src: 'state'}]});
  });
  await page.locator('#convView .conv-roster-actions button', {hasText: 'Add pane'}).click();
  const chip = page.locator('#convView .conv-chip.past');
  await expect(chip).toHaveText(/yesterday's codex/);
  await expect(page.locator('#convView .conv-pick-head').last()).toHaveText('Recorded');
  await chip.click();
  await expect(page.locator('#convView .conv-roster-row')).toHaveCount(2);
  // Its words are in the thread, merged into the chronology rather than copied anywhere.
  await expect(page.locator('#convViewThread')).toContainText('Shipped the migration.');
  expect(await page.evaluate(() => loadConvIndex()[0].members.map(m => m.key)))
    .toContain('ghost');
});

test('the picker names every session the same way, running or recorded', async ({page}) => {
  await openCard(page);
  await page.evaluate(async () => {
    await convPut({key: 'ghost', label: "yesterday's codex", touched: Date.now() - 7200000,
      spawn: {agent: 'codex'}, entries: [{who: 'agent', text: 'done', at: 1, at_src: 'state'}]});
  });
  await page.locator('#convView .conv-roster-actions button', {hasText: 'Add pane'}).click();
  await expect(page.locator('#convView .conv-pick-head')).toHaveText(['Running', 'Recorded']);
  // A live session is the same kind of choice as an ended one, so it is named the same way: the
  // pane's label and the harness it runs, in the badge every other surface uses.
  const live = page.locator('#convView .conv-chip:not(.past)', {hasText: 'scratch'});
  await expect(live.locator('.badge')).toHaveText('codex');
  await expect(page.locator('#convView .conv-chip.past .badge')).toHaveText('codex');
  // Same chip, so the badge sits the same way in both.
  for (const el of [live, page.locator('#convView .conv-chip.past')]) {
    await expect(el).toHaveCSS('display', 'flex');
    await expect(el).toHaveCSS('align-items', 'center');
  }
});

test('the picker does not offer a pane the conversation already holds', async ({page}) => {
  await openCard(page);
  await page.locator('#convView .conv-roster-actions button', {hasText: 'Add pane'}).click();
  // The open pane is already a member and its transcript is in the store, so it must appear in
  // neither group — the live chips or the recorded ones.
  const keys = await page.locator('#convView .conv-chip').evaluateAll(
    els => els.map(e => e.dataset.key));
  const mine = await page.evaluate(() => convMemberKey(paneOf(activePane)));
  expect(keys).not.toContain(mine);
});

test('three members read by colour, name and badge, with no left or right', async ({page}) => {
  await open(page);
  await page.evaluate(async () => {
    const key = convMemberKey(paneOf(activePane));
    for (const k of ['m2', 'm3']) {
      await convPut({key: k, label: k, touched: Date.now(), spawn: {agent: 'codex'},
        entries: [{who: 'agent', text: 'said by ' + k, at: Date.now(), at_src: 'state'}]});
    }
    // Membership before the read: recording is bound to the conversation, so a pane in none of
    // them records nothing.
    saveConvIndex([{id: 'c1', name: 'three of us', created: 1, members: [
      {key, added: 1, label: 'Architect 1'}, {key: 'm2', added: 2}, {key: 'm3', added: 3}]}]);
  });
  await read(page);
  const dots = await page.evaluate(async () => {
    toggleConvView();
    await renderConvView();
    return Array.from(document.querySelectorAll('#convThread .conv-msg .conv-who .dot'))
      .map(d => d.style.background);
  });
  // Sides are a pair's affordance and stop at two members; past that colour, name and badge are
  // what say who spoke.
  await expect(page.locator('#convThread .conv-msg.conv-right')).toHaveCount(0);
  await expect(page.locator('#convThread')).toContainText('said by m2');
  await expect(page.locator('#convThread')).toContainText('said by m3');
  expect(new Set(dots).size).toBe(3);
});

test('the roster is a disclosure under the header, not a block above the thread', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();
  // Closed on the way in: a reader opened a conversation to read it.
  await expect(page.locator('#convViewRoster')).toBeHidden();
  await expect(page.locator('#convViewWho')).toHaveText('1 pane ▾');
  await expect(page.locator('#convViewWho')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#convViewWho').click();
  await expect(page.locator('#convViewRoster')).toBeVisible();
  await expect(page.locator('#convViewWho')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#convViewRoster .conv-roster-row')).toHaveCount(1);
  // The thread is not inside it, and did not move to make room.
  await expect(page.locator('#convViewThread .conv-roster')).toHaveCount(0);
  await page.locator('#convViewWho').click();
  await expect(page.locator('#convViewRoster')).toBeHidden();
});

test('a member can be folded out of the thread without leaving the conversation', async ({page}) => {
  await openCard(page);
  await page.evaluate(async () => {
    await convPut({key: 'ghost', label: 'the other one', touched: Date.now(),
      spawn: {agent: 'codex'},
      entries: [{who: 'agent', text: 'said by the other one', at: Date.now(), at_src: 'state'}]});
    convEdit(c => { c.members = c.members.concat({key: 'ghost', added: 2, label: 'the other one'}); });
  });
  await expect(page.locator('#convViewThread')).toContainText('said by the other one');
  const before = await page.locator('#convViewThread .conv-msg').count();

  await page.locator('#convViewRoster .conv-roster-row', {hasText: 'the other one'})
    .locator('.conv-eye').click();
  await expect(page.locator('#convViewThread')).not.toContainText('said by the other one');
  await expect(page.locator('#convViewThread .conv-msg')).toHaveCount(before - 1);
  // Hiding is a reading state and nothing else: the member is still in the roster, still in the
  // conversation on disk, and its transcript is still referenced.
  await expect(page.locator('#convViewRoster .conv-roster-row')).toHaveCount(2);
  await expect(page.locator('#convViewRoster .conv-roster-row.hidden-member')).toHaveCount(1);
  await expect(page.locator('#convViewWho')).toHaveText('1/2 panes ▾');
  expect(await page.evaluate(() => loadConvIndex()[0].members.length)).toBe(2);
  expect(await page.evaluate(async () => ((await convGet(['ghost']))[0] || {}).entries.length)).toBe(1);

  await page.locator('#convViewRoster .conv-roster-row', {hasText: 'the other one'})
    .locator('.conv-eye').click();
  await expect(page.locator('#convViewThread')).toContainText('said by the other one');
  await expect(page.locator('#convViewWho')).toHaveText('2 panes ▾');
});

test('hiding is remembered per conversation, not per pane', async ({page}) => {
  await openCard(page);
  // From the roster, not from activePane: the standalone view has no open pane by design.
  const key = await page.evaluate(() => loadConvIndex()[0].members[0].key);
  await page.locator('#convViewRoster .conv-eye').click();
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('herdr_conv_hidden')));
  expect(stored).toEqual({c1: [key]});
  // The same pane in a second grouping is unaffected — being noise in one reading does not make it
  // noise in another, which is the whole reason a pane may be in several.
  await page.evaluate(() => {
    const items = loadConvIndex();
    items.push({id: 'c2', name: 'the release', created: 2, members: items[0].members.slice()});
    saveConvIndex(items);
    openConversation('c2');
  });
  await expect(page.locator('#convViewThread .conv-msg').first()).toBeVisible();
});

test('every live member opens its own pane, and the header opens the first visible one',
  async ({page}) => {
  await openCard(page);
  await page.evaluate(() => {
    convEdit(c => {
      c.members = c.members.concat(convMemberOf(agents.find(a => a.label === 'scratch')));
    });
  });
  // Two Open buttons, one per live member — the header's single button picks the first, and a
  // conversation of four is exactly where that is the wrong one.
  await expect(page.locator('#convViewRoster .conv-open')).toHaveCount(2);
  await page.locator('#convViewRoster .conv-roster-row', {hasText: 'scratch'})
    .locator('.conv-open').click();
  await expect(page.locator('#termTitle')).toContainText('scratch');
  // And it lands on this conversation's thread rather than whichever one that pane last read
  // under.
  expect(await page.evaluate(() => convViewConv(paneOf(activePane)).id)).toBe('c1');
});

test('the header button skips a member folded out of the thread', async ({page}) => {
  await openCard(page);
  await page.evaluate(() => {
    convEdit(c => {
      c.members = c.members.concat(convMemberOf(agents.find(a => a.label === 'scratch')));
    });
  });
  await expect(page.locator('#convViewOpen')).toBeVisible();
  // Hide the first, and the header follows the reader's own filter rather than the roster order.
  await page.locator('#convViewRoster .conv-roster-row').first().locator('.conv-eye').click();
  await page.locator('#convViewOpen').click();
  await expect(page.locator('#termTitle')).toContainText('scratch');
});

test('with every member hidden the view says so rather than looking empty', async ({page}) => {
  await openCard(page);
  await page.locator('#convViewRoster .conv-eye').click();
  await expect(page.locator('#convViewThread .conv-empty')).toContainText('Every member is hidden');
  // And the one action that needs a live pane goes, because there is no visible one to open.
  await expect(page.locator('#convViewOpen')).toBeHidden();
});

test('the conversation view carries the conversations as tabs', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    const key = convMemberKey(paneOf(activePane));
    saveConvIndex([
      {id: 'c1', name: 'new authentication feature', created: 1,
       members: [{key, added: 1, label: 'Architect 1', seen: 3, messages: 2}]},
      {id: 'c2', name: 'the release', created: 2, members: [{key, added: 2, seen: 9, messages: 5}]},
      {id: 'c3', name: 'relay · Architect 1', created: 3, auto: true,
       members: [{key, added: 3, seen: 5, messages: 1}]},
    ]);
    localStorage.setItem('herdr_conv_landing_auto', 'on');
  });
  // No read: recording would stamp all three with the same `seen`, and the order under test is
  // the one the landing list sorts by.
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card', {hasText: 'the release'}).click();
  const tabs = page.locator('#convStrip .conv-tab');
  // Same list and same order as the landing page it was opened from — newest message first.
  await expect(tabs).toHaveCount(3);
  await expect(tabs.locator('.name')).toHaveText(
    ['the release', 'relay · Architect 1', 'new authentication feature']);
  await expect(tabs.nth(0)).toHaveAttribute('aria-current', 'true');
  await expect(tabs.nth(1).locator('.tier')).toHaveText('auto');
  // And a tab is how you move between them, without going back to the list.
  await tabs.nth(2).click();
  await expect(page.locator('#convViewTitle')).toHaveText('new authentication feature');
  await expect(page.locator('#convStrip .conv-tab[aria-current="true"] .name'))
    .toHaveText('new authentication feature');
});

test('the strip hides the auto conversations exactly when the landing list does', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    const key = convMemberKey(paneOf(activePane));
    saveConvIndex([
      {id: 'c1', name: 'the release', created: 1, members: [{key, added: 1, seen: 9}]},
      {id: 'c2', name: 'relay · Architect 1', created: 2, auto: true,
       members: [{key, added: 2, seen: 5}]},
    ]);
    localStorage.setItem('herdr_conv_landing_auto', 'off');
  });
  await read(page);
  await page.locator('.term-header .back').click();
  await expect(page.locator('#conversations .conversation-card')).toHaveCount(1);
  await page.locator('#conversations .conversation-card').click();
  await expect(page.locator('#convStrip .conv-tab')).toHaveCount(1);
  await page.locator('#convView .back').click();
  await page.locator('#conversations .section-action').click();
  await expect(page.locator('#conversations .conversation-card')).toHaveCount(2);
  await page.locator('#conversations .conversation-card', {hasText: 'the release'}).click();
  await expect(page.locator('#convStrip .conv-tab')).toHaveCount(2);
});

test('an auto conversation opened while auto is hidden still gets its own tab', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    const key = convMemberKey(paneOf(activePane));
    saveConvIndex([
      {id: 'c1', name: 'the release', created: 1, members: [{key, added: 1, seen: 9}]},
      {id: 'c2', name: 'relay · Architect 1', created: 2, auto: true,
       members: [{key, added: 2, seen: 5}]},
    ]);
    localStorage.setItem('herdr_conv_landing_auto', 'off');
    openConversation('c2');
  });
  // A strip that cannot show what is on screen is worse than one carrying an extra tab — the same
  // rule the pane strip follows for the open pane.
  await expect(page.locator('#convStrip .conv-tab')).toHaveCount(2);
  await expect(page.locator('#convStrip .conv-tab[aria-current="true"] .name'))
    .toHaveText('relay · Architect 1');
});

test('a conversation read on its own uses the whole width', async ({page}) => {
  await openCard(page);
  const w = await page.evaluate(() => {
    const box = document.getElementById('convViewThread');
    const msg = box.querySelector('.conv-msg');
    return {msg: msg.getBoundingClientRect().width, box: box.clientWidth,
      pad: getComputedStyle(box).paddingLeft};
  });
  // Nothing sits opposite anything here — there is no pair and no side, so the width a pane's
  // thread reserves for the other half is dead space.
  expect(w.msg).toBeCloseTo(w.box - 2 * parseFloat(w.pad), 0);
});

test('a pane reading a thread can manage the conversation from it', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  // Only with the thread on screen: the rows have no conversation to manage.
  const who = page.locator('#paneConvWho');
  await expect(who).toBeHidden();
  await page.evaluate(() => { toggleConvView(); });
  // In the pane's own header, left of QUIT — the same control the conversation view carries, in
  // the same place relative to the thread it opens onto.
  await expect(who).toHaveText('1 pane ▾');
  expect(await page.evaluate(() =>
    document.getElementById('paneConvWho').nextElementSibling.contains(document.getElementById('quitBtn'))))
    .toBe(true);
  await expect(page.locator('#convPaneRoster')).toBeHidden();
  await who.click();
  await expect(page.locator('#convPaneRoster .conv-roster-row')).toHaveCount(1);
  // Hanging off the bottom of the header, over the thread rather than pushing it down — the same
  // shape the conversation view's panel has.
  const box = await page.evaluate(() => {
    const b = e => document.getElementById(e).getBoundingClientRect();
    return {panel: b('convPaneRoster'), head: b('termWrap'), thread: b('convThread')};
  });
  expect(box.panel.top).toBeCloseTo(box.head.top, 0);
  expect(box.panel.width).toBeCloseTo(box.head.width, 0);
  expect(box.thread.top).toBeCloseTo(box.head.top, 0);
  // The same actions the standalone view owns, acting on the conversation this pane is reading.
  page.once('dialog', d => d.accept('named from the pane'));
  await page.locator('#convPaneRoster .conv-roster-actions button', {hasText: 'Rename'}).click();
  await expect(page.locator('#convThread .conv-head .name')).toHaveText('named from the pane');
  expect(await page.evaluate(() => loadConvIndex()[0].name)).toBe('named from the pane');
  // Back to the rows takes both with it: the panel acts on a conversation that is no longer what
  // the pane is showing.
  await page.evaluate(() => { toggleConvView(); });
  await expect(who).toBeHidden();
  await expect(page.locator('#convPaneRoster')).toBeHidden();
});

test('the pane reading a thread is the one member it cannot hide', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.evaluate(async () => {
    await convPut({key: 'ghost', label: 'the other one', touched: Date.now(),
      spawn: {agent: 'codex'},
      entries: [{who: 'agent', text: 'said by the other one', at: Date.now(), at_src: 'state'}]});
    convViewId = 'c1';
    convEdit(c => { c.members = c.members.concat({key: 'ghost', added: 2, label: 'the other one'}); });
    toggleConvView();
    toggleConvPaneRoster();
  });
  await expect(page.locator('#convThread')).toContainText('said by the other one');
  // The open pane's row offers no switch at all, so there is no way to end up reading an empty
  // screen with the way back on the thing you just hid.
  await expect(page.locator('#convPaneRoster .conv-roster-row', {hasText: 'Architect 1'})
    .locator('button.conv-eye')).toHaveCount(0);
  await expect(page.locator('#convPaneRoster .conv-roster-row', {hasText: 'Architect 1'})
    .locator('.conv-eye.reading')).toHaveCount(1);

  await page.locator('#convPaneRoster .conv-roster-row', {hasText: 'the other one'})
    .locator('.conv-eye').click();
  await expect(page.locator('#convThread')).not.toContainText('said by the other one');
  // The pane's own words stay, and the filter is the same one the standalone view reads.
  await expect(page.locator('#convThread .conv-msg').first()).toContainText('Ready.');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('herdr_conv_hidden'))))
    .toEqual({c1: ['ghost']});
});

test('duplicating from a pane keeps the reader in the pane, on the copy', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.evaluate(() => { toggleConvView(); toggleConvPaneRoster(); });
  const dup1449 = page.locator('#convPaneRoster .conv-roster-actions button', {hasText: 'Duplicate'});
  await dup1449.click();
  await dup1449.click();
  // Still in the pane — the copy holds this pane, so it is a grouping the pane can be read under.
  await expect(page.locator('#convView')).toBeHidden();
  await expect(page.locator('#convThread')).toBeVisible();
  await expect(page.locator('#convThread select.name')).toHaveValue(
    await page.evaluate(() => loadConvIndex()[0].id));
  await expect(page.locator('#convThread select.name option'))
    .toHaveText(['new authentication feature (copy)', 'new authentication feature']);
});

// A pane may be in any number of conversations — the store never stopped it, and grouping is a
// view over one transcript rather than a copy of it. These are about which grouping the pane's own
// thread is showing.
const twoConvs = page => page.evaluate(() => {
  const key = convMemberKey(paneOf(activePane));
  saveConvIndex([
    {id: 'c1', name: 'new authentication feature', created: 1,
     members: [{key, added: 1, label: 'Architect 1'}]},
    {id: 'c2', name: 'the release', created: 2, members: [{key, added: 2, label: 'Architect 1'}]},
  ]);
  return key;
});

test('a pane in two conversations picks which one its thread shows', async ({page}) => {
  await open(page);
  await twoConvs(page);
  await read(page);
  await page.evaluate(() => { toggleConvView(); });
  const pick = page.locator('#convThread select.name');
  await expect(pick).toHaveValue('c1');
  await expect(pick.locator('option')).toHaveText(['new authentication feature', 'the release']);
  await pick.selectOption('c2');
  await expect(pick).toHaveValue('c2');
  // And it survives the redraw a poll brings, which is what makes it a preference rather than a
  // click.
  await read(page);
  await expect(page.locator('#convThread select.name')).toHaveValue('c2');
});

test('opening a selected card keeps that conversation on its live pane', async ({page}) => {
  await open(page);
  await twoConvs(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card', {hasText: 'the release'}).click();
  await page.locator('#convViewOpen').click();
  await expect(page.locator('#convThread select.name')).toHaveValue('c2');
});

test('a stored conversation the pane has left falls back rather than showing nothing', async ({page}) => {
  await open(page);
  await twoConvs(page);
  await read(page);
  await page.evaluate(() => {
    const a = paneOf(activePane);
    convSetView(a, 'c2');
    // The grouping is deleted from under the preference, which is what removing a member or
    // dropping a conversation does.
    saveConvIndex(loadConvIndex().filter(c => c.id !== 'c2'));
    renderConvView();
  });
  await expect(page.locator('#convThread .conv-head .name')).toHaveText('new authentication feature');
  await expect(page.locator('#convThread .conv-msg').first()).toContainText('Ready.');
});

test('a thread switched on before the picker existed still opens', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  // `1` is what every version before this one stored, and it has to keep meaning "on, the first".
  await page.evaluate(k => {
    localStorage.setItem('herdr_conv_view', JSON.stringify({[k]: 1}));
    renderConvView();
  }, key);
  await expect(page.locator('#convThread .conv-head .name')).toHaveText('new authentication feature');
  await expect(page.locator('#convThread select.name')).toHaveCount(0);
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
  // The switch returns before the thread does — the entries come out of IndexedDB — so measuring
  // the scroll box straight after the click measures an empty one, and an empty one does not
  // overflow. Wait for the bubbles, not for the click.
  await expect(page.locator('#convThread .conv-msg')).toHaveCount(40);
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

// --- Recovering what was missed ---
//
// A browser that was closed, asleep, or off the network saw none of the turns that happened while
// it was away, and the pane still holds them. These are about getting them into the record: the
// free half, which is any read pulled deeper than the transcript was written from, and the button
// for the times a gap is visible on screen and nothing automatic has closed it.

// A claude pane of `n` turns, numbered so the assertions can name which ones came back.
const turns = n => Array.from({length: n},
  (_, i) => `❯ question ${i + 1}\n\n⏺ Answer ${i + 1}.\n`).join('\n') + '\n❯\n';

test('a read pulled deeper records the turns nobody was connected for', async ({page}) => {
  await open(page);
  const key = await join(page);
  // What the browser saw before it went away, and what the pane holds now.
  await read(page, turns(2));
  await read(page, turns(6));
  const rec = await held(page, key);
  expect(rec.entries.map(e => e.text)).toContain('Answer 6.');
  expect(rec.entries.filter(e => e.who === 'agent').length).toBe(6);
  // Once, however many times the same window is read back.
  await read(page, turns(6));
  expect((await held(page, key)).entries.length).toBe(12);
});

test('Recover history asks the relay for everything it has, and says what came back',
  async ({page}) => {
    await open(page);
    const key = await join(page);
    await read(page, turns(2));
    await tapWire(page);
    await page.evaluate(() => recoverConvHistory());
    // No ceiling of the app's own: the relay clamps this at whatever it is configured for, which is
    // what lets an operator raise it without the app being edited.
    const asked = await page.evaluate(() => window.__sent.filter(m => m.type === 'read_pane'));
    expect(asked.at(-1).lines).toBe(1e9);
    // The reply arrives on the ordinary draw path, and the recorder reports on the write it lands on.
    await read(page, turns(6));
    await expect(page.locator('#toast')).toContainText('Recovered 8 messages');
    expect((await held(page, key)).entries.filter(e => e.who === 'agent').length).toBe(6);
  });

test('a recovery that finds nothing new says so rather than nothing at all', async ({page}) => {
  await open(page);
  await join(page);
  await read(page, turns(2));
  await page.evaluate(() => recoverConvHistory());
  await read(page, turns(2));
  await expect(page.locator('#toast')).toContainText('Nothing new to recover');
});

test('a window the record cannot be located in marks the break instead of guessing',
  async ({page}) => {
    await open(page);
    const key = await join(page);
    await read(page, turns(2));
    // /clear, or a scrollback that no longer reaches the record. Longer, so it is a deep read, and
    // with nothing in it the transcript can be joined to.
    await page.evaluate(() => recoverConvHistory());
    await read(page, turns(6).replace(/Answer/g, 'Something else'));
    await expect(page.locator('#toast')).toContainText('Could not find where the record left off');
    // Nothing written, and the break remembered for the next thing that is.
    expect((await held(page, key)).entries.filter(e => e.who === 'agent').length).toBe(2);
    expect((await held(page, key)).gap).toBe(true);
  });

test('the button is offered on a pane with a transcript and on no other', async ({page}) => {
  await open(page);
  await page.locator('#termMenuBtn').click();
  await expect(page.locator('#menuConvRecover')).toBeHidden();
  await page.keyboard.press('Escape');
  await join(page);
  await read(page);
  await page.locator('#termMenuBtn').click();
  await expect(page.locator('#menuConvRecover')).toBeVisible();
});

// --- Coming back after being away (T2) ---
//
// T1 covers the pane in front of you and T3 is the button. Neither covers the members of a
// conversation whose panes were never opened this session — and those are most of a joint thread.
// What follows is the only read this feature issues on its own, and most of these are about the
// times it must not.

// A second member, recorded and then dated: what a partner's transcript looks like after an
// afternoon of nobody looking at it. `stale` is how long ago it was last written.
const partner = (page, stale) => page.evaluate(async stale => {
  const other = agents.find(a => a.pane_id !== activePane && profileFor(a.agent));
  const key = convMemberKey(other);
  const items = loadConvIndex();
  items[0].members.push({key: key, added: Date.now(), label: other.label});
  saveConvIndex(items);
  // Written straight at the store rather than through a read: this pane is whatever harness the
  // fake herdr gave it, and the question here is what recovery does with an old record, not what
  // the parser does with that harness's gutters.
  const then = Date.now() - stale;
  await convPut({key: key, first: then, touched: then, label: other.label, depth: 200,
    backfilled: true, entries: [{who: 'agent', text: 'Answered.', at: then, at_src: 'backfill',
      seen: then}]});
  convHeld.delete(key);
  return {key: key, pane: other.pane_id};
}, stale);

// The socket having been down, without taking the socket down: the app cannot tell the difference,
// and a real 40-minute outage is not something a test can wait for.
const wasAway = (page, ms) => page.evaluate(ms => {
  wsDownSince = ms ? Date.now() - ms : 0;
  convSawSnapshot = true;      // the page has been up a while; this is not its first snapshot
}, ms);

const snapshot = page => page.evaluate(() => handleMessage({type: 'agents', agents: agents}));
const deepReads = page => page.evaluate(() =>
  window.__sent.filter(m => m.type === 'read_pane' && m.lines === 5000));

test('a session that never dropped pulls no history it was not asked for', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  const mate = await partner(page, 60 * 60 * 1000);
  await tapWire(page);
  await wasAway(page, 0);
  await snapshot(page);
  // The members are stale enough. Nothing was missed, so nothing is read: a healthy connected
  // session is the case this must cost nothing at all.
  expect(await deepReads(page)).toEqual([]);
  expect(mate.pane).toBeTruthy();
});

test('a three-second flap is not an outage', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await partner(page, 60 * 60 * 1000);
  await tapWire(page);
  await wasAway(page, 3000);
  await snapshot(page);
  expect(await deepReads(page)).toEqual([]);
});

test('a real outage recovers the members nobody had open', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  const mate = await partner(page, 60 * 60 * 1000);
  await tapWire(page);
  await wasAway(page, 40 * 60 * 1000);
  await snapshot(page);
  await expect.poll(() => deepReads(page)).toEqual([
    {type: 'read_pane', pane_id: mate.pane, lines: 5000, source: 'recent-unwrapped'},
  ]);
});

test('a member written moments ago has nothing worth a read', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await partner(page, 30 * 1000);
  await tapWire(page);
  await wasAway(page, 40 * 60 * 1000);
  await snapshot(page);
  expect(await deepReads(page)).toEqual([]);
});

test('a recovery that found nothing is not tried again on the next outage', async ({page}) => {
  // `touched` cannot answer this: it moves only when something is written, so a quiet transcript
  // would buy a deep read on every reconnect and every reload forever.
  await open(page);
  await join(page);
  await read(page);
  await partner(page, 60 * 60 * 1000);
  await tapWire(page);
  await wasAway(page, 40 * 60 * 1000);
  await snapshot(page);
  await expect.poll(() => deepReads(page)).toHaveLength(1);
  await page.evaluate(() => { window.__sent = []; });
  await wasAway(page, 40 * 60 * 1000);
  await snapshot(page);
  expect(await deepReads(page)).toEqual([]);
});

test('the open pane recovers by pulling its own history, not behind its own back',
  async ({page}) => {
    // Its reply lands on the draw branch and would replace the rows under the reader's finger, so
    // it takes the one path that is already correct for it: Load more, to the same depth.
    await open(page);
    const key = await join(page);
    await read(page);
    await page.evaluate(async k => {
      const held = (await convGet([k]))[0];
      held.touched = Date.now() - 60 * 60 * 1000;
      convHeld.delete(k);
      await convPut(held);
    }, key);
    await wasAway(page, 40 * 60 * 1000);
    await snapshot(page);
    await expect.poll(() => page.evaluate(() => paneLines)).toBe(5000);
  });
