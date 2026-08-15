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
//
// One wrapper per page, holding a table of labels: called twice for the same pane, the second call
// moves it rather than stacking a second wrapper that the first would then overwrite.
const forceStatus = (page, label, status) => page.evaluate(([label, status]) => {
  window.__forced = window.__forced || {};
  window.__forced[label] = status;
  if (!window.__forcing) {
    window.__forcing = true;
    const orig = ws.onmessage;
    ws.onmessage = e => {
      const d = JSON.parse(e.data);
      if (d.type === 'agents') {
        for (const a of d.agents) if (window.__forced[a.label]) a.status = window.__forced[a.label];
        return orig({data: JSON.stringify(d)});
      }
      return orig(e);
    };
  }
  const a = agents.find(x => x.label === label);
  if (a) a.status = status;
  if (typeof syncConvBadge === 'function') syncConvBadge();
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

test('a paired pane keeps its pair strip in its conversation thread', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.evaluate(() => {
    pairs = [{id: 'p1', members: [recentFingerprint(paneOf(activePane)),
      recentFingerprint(agents.find(a => a.label === 'scratch'))]}];
    toggleConvView();
  });
  await expect(page.locator('#convThread')).toBeVisible();
  await expect(page.locator('#pairStrip')).toBeVisible();
});

test('an older bubble clock includes its short date', async ({page}) => {
  await open(page);
  const key = await join(page);
  await page.evaluate(([k, label]) => {
    convHeld.set(k, {key: k, label: label, entries: [{who: 'agent', text: 'Yesterday.',
      at: Date.now() - 24 * 60 * 60 * 1000, at_src: 'state'}]});
    convSetView(paneOf(activePane), loadConvIndex()[0].id);
    renderConvView();
  }, [key, AGENT]);
  await expect(page.locator('#convThread .conv-time')).toHaveText(/[A-Z][a-z]{2} \d{1,2} \d{1,2}:\d{2}/);
});

test('every bubble header dot reports its agent’s current state', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.evaluate(async () => {
    const a = paneOf(activePane);
    a.status = 'blocked';
    convSetView(a, loadConvIndex()[0].id);
    await renderConvView();
  });
  const dots = page.locator('#convThread .conv-msg .conv-who .dot');
  await expect(dots).toHaveCount(2);
  expect(await dots.evaluateAll(all => all.map(dot => dot.style.background))).toEqual(
    ['var(--dot-red)', 'var(--dot-red)']);
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

  // The record, read as itself: no pane open, and no pane rows behind it.
  await expect(page.locator('#convView')).toBeVisible();
  await expect(page.locator('#convViewTitle')).toHaveText('new authentication feature');
  await expect(page.locator('#convViewThread .conv-msg')).toHaveCount(2);
  await expect(page.locator('#convViewCount')).toHaveText('2 messages');
  expect(await page.evaluate(() => activePane)).toBe(null);
  // A bubble here is a selection — the dock below sends the picked ones on (§4).
  await expect(page.locator('#convViewThread .conv-pick')).toHaveCount(2);

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
  // The chevron is a home button at every depth, and home is the near end of the walk — so the
  // conversation is not behind it any more, it is the first step forward again.
  await page.locator('#termBack').click();
  await expect(page.locator('#agentListView')).toBeVisible();
  await page.locator('#navFwd').click();
  await expect(page.locator('#convView')).toBeVisible();
});

test('the conversation is a stop on the ‹ › walk, not a place outside it', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();
  await expect(page.locator('#convView')).toBeVisible();
  await page.locator('#convViewOpen').click();
  await expect(page.locator('#terminalView')).toBeVisible();
  // Reading a record, opening a member's pane out of it and wanting the record back is the ordinary
  // way round a joint thread. Before this the only way back was the pane's own Back, which lands on
  // the agent list — from where the conversation has to be found again.
  const back = page.locator('#statusBar #navBack');
  await expect(back).toBeEnabled();
  await expect(back).toHaveAttribute('aria-label', /Back to new authentication feature/);
  await back.click();
  await expect(page.locator('#convView')).toBeVisible();
  await expect(page.locator('#convViewTitle')).toHaveText('new authentication feature');
});

test('the walk is reachable from the conversation window too', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();
  await page.locator('#convViewOpen').click();
  await expect(page.locator('#terminalView')).toBeVisible();
  await page.locator('#statusBar #navBack').click();
  await expect(page.locator('#convView')).toBeVisible();
  // The window that had no way onward. Its arrows are the same two, in the row that is on screen
  // whatever is above it, so the step back into the pane is made from here rather than by finding
  // the pane again.
  const fwd = page.locator('#statusBar #navFwd');
  await expect(fwd).toBeEnabled();
  await expect(fwd).toHaveAttribute('aria-label', new RegExp(`Forward to ${AGENT}`));
  await fwd.click();
  await expect(page.locator('#terminalView')).toBeVisible();
  await expect(page.locator('#termTitle')).toContainText(AGENT);
  await expect(page.locator('#convView')).toBeHidden();
});

test('a deleted conversation is stepped over rather than opened', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();
  await page.locator('#convViewOpen').click();
  await expect(page.locator('#terminalView')).toBeVisible();
  await page.evaluate(() => saveConvIndex([]));
  // The walk skips what no longer exists, the same way it skips a pane that has exited. Behind the
  // deleted record is the pane this one is already on, which is skipped too — so Back carries on
  // to the list rather than reopening what is on screen or landing on a record that is gone.
  await page.evaluate(() => syncNavBtns());
  const back = page.locator('#statusBar #navBack');
  await expect(back).toHaveAttribute('aria-label', 'Back to the agent list');
  await back.click();
  await expect(page.locator('#agentListView')).toBeVisible();
  await expect(page.locator('#convView')).toBeHidden();
});

test('the composer fills from the top, and Send stays beside the line being written',
  async ({page}) => {
    await open(page);
    await join(page);
    await read(page);
    await page.locator('.term-header .back').click();
    await page.locator('#conversations .conversation-card').click();
    await page.locator('#convInput').fill('one line');
    // The field is shorter than the Send button until a second line arrives. Bottom-aligned, the
    // first line you type sat below the button's middle — a box you appear to be typing into from
    // underneath.
    const top = box => box.evaluate(el => el.getBoundingClientRect().top);
    const field = page.locator('#convInput');
    expect(await top(field) - await top(page.locator('#convComposer'))).toBeLessThan(8);
    // Send is the exception, and stays at the bottom: it belongs beside the last line, which on a
    // phone is also where the thumb is.
    await page.locator('#convInput').fill('one\ntwo\nthree\nfour');
    const bottom = box => box.evaluate(el => el.getBoundingClientRect().bottom);
    expect(Math.abs(await bottom(page.locator('#convSendBtn')) - await bottom(field)))
      .toBeLessThan(10);
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
  // Two groups, not three: the walk moved to the status bar and the middle is empty track now.
  expect(nav.children).toBe(2);
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

test('a pane in a pair and a wider conversation opens on the wider one', async ({page}) => {
  await open(page);
  await page.evaluate(async () => {
    const mine = paneOf(activePane), other = agents.find(a => a.label === 'scratch');
    const mineKey = convMemberKey(mine), otherKey = convMemberKey(other);
    pairs = [{id: 'p1', members: [recentFingerprint(mine), recentFingerprint(other)]}];
    await convPut({key: 'm3', label: 'third', touched: Date.now(), spawn: {agent: 'codex'},
      entries: [{who: 'agent', text: 'said by the third', at: Date.now(), at_src: 'state'}]});
    // Index order is newest first, so the auto pair record sits ahead of the named one — which is
    // exactly the arrangement a pair made after a conversation leaves behind.
    saveConvIndex([
      {id: 'pair', name: 'the pair', auto: true, created: 2, pair_id: 'p1', members: [
        {key: mineKey, added: 2, label: 'Architect 1'}, {key: otherKey, added: 2, label: 'scratch'}]},
      {id: 'wide', name: 'three of us', created: 1, members: [
        {key: mineKey, added: 1, label: 'Architect 1'},
        {key: otherKey, added: 1, label: 'scratch'},
        {key: 'm3', added: 1, label: 'third'}]},
    ]);
  });
  await read(page);
  await page.evaluate(async () => { toggleConvView(); await renderConvView(); });
  // The thread used to open on whichever conversation the index happened to list first, so a pane
  // with a pair opened on its pair — and every other member of the work was absent, with nothing
  // on screen saying a wider thread existed.
  expect(await page.evaluate(() => convViewConv(paneOf(activePane)).id)).toBe('wide');
  await expect(page.locator('#convThread')).toContainText('said by the third');
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

test('the transfer sheet names the pane it will write into', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    pairs = [{id: 'p1', members: [recentFingerprint(paneOf(activePane)),
      recentFingerprint(agents.find(a => a.label === 'scratch'))]}];
  });
  await read(page);
  // The pane view, where the sheet is still the way a range is transferred.
  await page.evaluate(() => { selA = 0; selB = 2; drawSel(); });
  await page.locator('#selTransfer').click();
  await expect(page.locator('#transferSheet')).toBeVisible();
  await expect(page.locator('#transferTarget')).toHaveText('scratch');
  // One agent's output entering another's context: which agent is the fact the reader has to be
  // sure of, so the sheet says it the way the agent list does — name, harness badge, live dot.
  await expect(page.locator('#transferBadge')).toHaveText('codex');
  await expect(page.locator('#transferSheet .transfer-head .who')).toHaveCSS('justify-content', 'center');
  const dot = await page.evaluate(() => {
    const c = getComputedStyle(document.getElementById('transferDot'));
    return {fill: c.backgroundColor, size: c.width, beat: c.animationName};
  });
  expect(dot.size).toBe('8px');
  expect(dot.fill).not.toBe('rgba(0, 0, 0, 0)');
  expect(dot.beat).toBe('pulse');            // the fake herdr reports scratch as working
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
      .map(d => ({fill: d.style.background, ring: d.style.boxShadow}));
  });
  // Sides are a pair's affordance and stop at two members; past that colour, name and badge are
  // what say who spoke.
  await expect(page.locator('#convThread .conv-msg.conv-right')).toHaveCount(0);
  await expect(page.locator('#convThread')).toContainText('said by m2');
  await expect(page.locator('#convThread')).toContainText('said by m3');
  // Status is the dot's only meaning; bubble wash, label and harness badge identify the speaker.
  expect(dots.every(d => d.ring === '')).toBe(true);
  expect(new Set(dots.map(d => d.fill)).size).toBeLessThan(3);
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

test('conversation tabs appear before its transcript finishes loading', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    const key = convMemberKey(paneOf(activePane));
    saveConvIndex([{id: 'c1', name: 'first view', created: 1,
      members: [{key, added: 1, label: 'Architect 1'}]}]);
    openConversation('c1');
  });
  await expect(page.locator('#convStrip .conv-tab')).toHaveCount(1);
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
  // Pinned through the snapshot rather than written onto `agents`: the poll replaces that array
  // wholesale every three seconds, and a status set under it is gone by the next one.
  await forceStatus(page, AGENT, 'done');
  await page.locator('#quickActions .qa-conv').click();
  const badge = page.locator('#convThread .conv-badge');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveText('done');
  await expect(page.locator('#convThread .conv-msg').last().locator('.conv-badge')).toHaveCount(1);
  // An agent that starts working says so on the thread, without the thread being rebuilt.
  await forceStatus(page, AGENT, 'working');
  await expect(badge).toHaveText('working');
  await forceStatus(page, AGENT, 'blocked');
  await expect(badge).toHaveText('blocked');
  // Idle is what a pane is nearly all of the time, so it is not a badge.
  await forceStatus(page, AGENT, 'idle');
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
// T1 covers the pane in front of you and T3 is the button. What is left is the panes you are not
// looking at, and every read this section issues is one nobody asked for — so most of what follows
// is about the times it must not fire, and the rest is about it saying so when it does.

// A second member with a record of its own, dated: what a partner's transcript looks like after an
// afternoon of nobody opening it. Written straight at the store rather than through a read — this
// pane is whatever harness the fake herdr gave it, and the question here is what recovery does with
// an old record, not what the parser does with that harness's gutters.
const partner = (page, stale) => page.evaluate(async stale => {
  const other = agents.find(a => a.pane_id !== activePane && profileFor(a.agent));
  const key = convMemberKey(other);
  const items = loadConvIndex();
  items[0].members.push({key: key, added: Date.now(), label: other.label});
  saveConvIndex(items);
  const then = Date.now() - stale;
  await convPut({key: key, first: then, touched: then, label: other.label, depth: 200,
    backfilled: true, entries: [{who: 'agent', text: 'Answered.', at: then, at_src: 'backfill',
      seen: then}]});
  convHeld.delete(key);
  return {key: key, pane: other.pane_id};
}, stale);

// How old the open pane's own record is.
const age = (page, key, stale) => page.evaluate(async ([k, stale]) => {
  const held = (await convGet([k]))[0];
  held.touched = Date.now() - stale;
  held.recovered = 0;
  convHeld.delete(k);
  await convPut(held);
}, [key, stale]);

// The socket having been down, without taking the socket down: the app cannot tell the difference,
// and a real 40-minute outage is not something a test can wait for.
const wasAway = (page, ms) => page.evaluate(ms => { wsDownSince = ms ? Date.now() - ms : 0; }, ms);
const snapshot = page => page.evaluate(() => handleMessage({type: 'agents', agents: agents}));
const deepReads = page => page.evaluate(() =>
  window.__sent.filter(m => m.type === 'read_pane' && m.lines > 1000));

test('a session that never dropped pulls no history it was not asked for', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  await age(page, key, 60 * 60 * 1000);
  await partner(page, 60 * 60 * 1000);
  await tapWire(page);
  await wasAway(page, 0);
  await snapshot(page);
  // Every record is stale enough. Nothing was missed, so nothing is read: a healthy connected
  // session is the case this must cost nothing at all.
  expect(await deepReads(page)).toEqual([]);
});

test('a three-second flap is not an outage', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  await age(page, key, 60 * 60 * 1000);
  await tapWire(page);
  await wasAway(page, 3000);
  await snapshot(page);
  expect(await deepReads(page)).toEqual([]);
});

test('an outage over the pane you are reading catches that pane up, and says so',
  async ({page}) => {
    // The one case no activation will ever fire for: the pane never went away, you did.
    await open(page);
    const key = await join(page);
    await read(page);
    await age(page, key, 60 * 60 * 1000);
    await tapWire(page);
    await wasAway(page, 40 * 60 * 1000);
    await snapshot(page);
    await expect(page.locator('#toast')).toContainText('Catching up');
    await expect.poll(() => page.evaluate(() => paneLines)).toBe(5000);
  });

test('opening a pane whose record went stale catches it up', async ({page}) => {
  // The read is paid for by the one thing that makes it worth paying: someone is about to read it.
  await open(page);
  const key = await join(page);
  await read(page);
  await age(page, key, 60 * 60 * 1000);
  await page.evaluate(() => closeTerminal());
  await tapWire(page);
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#toast')).toContainText('Catching up');
  await expect.poll(() => page.evaluate(() => paneLines)).toBe(5000);
});

test('opening a pane recorded moments ago costs nothing extra', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.evaluate(() => closeTerminal());
  await tapWire(page);
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  expect(await deepReads(page)).toEqual([]);
  expect(await page.evaluate(() => paneLines)).toBe(200);
});

test('the background sweep catches up the members nobody opened, quietly', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  const mate = await partner(page, 60 * 60 * 1000);
  await tapWire(page);
  await page.evaluate(() => convRecoverSweep());
  await expect.poll(() => deepReads(page)).toEqual([
    {type: 'read_pane', pane_id: mate.pane, lines: 5000, source: 'recent-unwrapped'},
  ]);
  // Nobody is watching a background read, and a toast for one would be an interruption reporting
  // that nothing was interrupted.
  await expect(page.locator('#toast')).toBeHidden();
});

test('the sweep leaves the open pane alone and does not repeat itself', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  await age(page, key, 60 * 60 * 1000);
  const mate = await partner(page, 60 * 60 * 1000);
  await tapWire(page);
  await page.evaluate(() => convRecoverSweep());
  await expect.poll(() => deepReads(page)).toHaveLength(1);
  // The open pane is not in it: its reply would redraw the rows under the reader's finger, and it
  // has two triggers of its own.
  expect((await deepReads(page))[0].pane_id).toBe(mate.pane);
  // And the attempt is remembered whether or not it found anything, or a quiet transcript would
  // buy a read on every sweep forever.
  await page.evaluate(async () => { window.__sent = []; await convRecoverSweep(); });
  expect(await deepReads(page)).toEqual([]);
});

test('set to everything, the same catch-up asks for everything', async ({page}) => {
  // The setting exists because the choice is not the app's to make: a read nobody asked for is
  // small by default, and someone who would rather pay it once than find the gap later says so.
  await open(page);
  await join(page);
  await read(page);
  const mate = await partner(page, 60 * 60 * 1000);
  await page.evaluate(() => setConvDeepAll(true));
  await tapWire(page);
  await page.evaluate(() => convRecoverSweep());
  // The sentinel, not a number: the relay clamps it to whatever it is configured for (§2.7).
  await expect.poll(() => deepReads(page)).toEqual([
    {type: 'read_pane', pane_id: mate.pane, lines: 1e9, source: 'recent-unwrapped'},
  ]);
});

test('both recovery settings are remembered, and the pickers show what they are',
  async ({page}) => {
    await open(page);
    expect(await page.evaluate(() => document.getElementById('deepPick').value)).toBe('day');
    expect(await page.evaluate(() => document.getElementById('sweepPick').value)).toBe('1h');
    await page.evaluate(() => { setConvDeepAll(true); setConvSweep('off'); });
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.getElementById('deepPick').value))
      .toBe('full');
    expect(await page.evaluate(() => document.getElementById('sweepPick').value)).toBe('off');
    expect(await page.evaluate(() => convDeepLines())).toBe(1e9);
    // Off is off: no timer, so a member nobody opens fills in when someone finally does.
    expect(await page.evaluate(() => convSweepTimer)).toBe(null);
  });

test('the turn-end read stands aside while a recovery is in flight', async ({page}) => {
  // `pane_content` carries no request id, so a 200-line reply landing first is indistinguishable
  // from the deep one being waited for. It is held off rather than told apart — and nothing is
  // lost, because the deep read is a superset of it.
  await open(page);
  const key = await join(page);
  await read(page);
  const pane = await page.evaluate(() => activePane);
  await page.evaluate(() => closeTerminal());
  await tapWire(page);
  await page.evaluate(k => {
    const a = agents.find(x => convMemberKey(x) === k);
    convRecoverStart(a, false);
    convReadTurnEnd(a.pane_id, 'idle');       // the turn that ended mid-recovery
  }, key);
  expect(await page.evaluate(() => window.__sent.filter(m => m.type === 'read_pane')))
    .toEqual([{type: 'read_pane', pane_id: pane, lines: 5000, source: 'recent-unwrapped'}]);
});

test('a read already in flight when a recovery starts is not mistaken for its reply',
  async ({page}) => {
    // The one the guard above cannot cover: a 200-line turn-end read sent a moment *before* the
    // recovery. Answering it as the deep reply is not a mis-counted toast — a window too shallow to
    // hold the record's newest message misses the anchor, and a miss is written down as a gap in
    // history that never happened. The watermark refuses it (§2.4).
    await open(page);
    const key = await join(page);
    await read(page);
    await tapWire(page);
    await page.evaluate(async k => {
      const h = (await convGet([k]))[0];
      h.depth = 5000;                          // this transcript has been read deeper than 200
      convHeld.delete(k);
      await convPut(h);
    }, key);
    await page.evaluate(k => convRecoverStart(paneOf(activePane), true), key);
    await page.evaluate(() => recordPane(activePane, [
      '⏺ Something else entirely.', '', '❯ ', '',
    ]));
    const stored = await held(page, key);
    expect(stored.gap).toBeFalsy();
    // Still waiting, so the deep reply behind it is the one that reports.
    expect(await page.evaluate(k => convRecovering.has(k), key)).toBe(true);
  });

test('a recovery nobody can send says so instead of pretending', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.evaluate(() => { ws = {readyState: 3, send: () => {}}; recoverConvHistory(); });
  await expect(page.locator('#toast')).toContainText('Not connected');
});

// --- Tidying what the previous recorder left ---

// A transcript as the folding recorder wrote one: the same screen in twice, and no `backfilled`
// flag, which is what dates it to before this recorder existed.
const legacy = (page, key) => page.evaluate(async k => {
  const t = Date.now() - 60 * 60 * 1000;
  const say = (who, text, i) => ({who: who, text: text, at: t + i, seen: t + i, at_src: 'backfill'});
  await convPut({key: k, first: t, touched: t, entries: [
    say('user', 'first question', 1), say('agent', 'First answer.', 2),
    say('user', 'first question', 3), say('agent', 'First   answer.', 4),
  ]});
  convHeld.delete(k);
}, key);

test('a transcript from the folding recorder is repaired the first time it is opened',
  async ({page}) => {
    await open(page);
    const key = await join(page);
    await legacy(page, key);
    await read(page);
    // The wrapped copy goes and the first stays: the earliest copy is the transcript's chronology.
    const texts = (await held(page, key)).entries.map(e => e.text);
    expect(texts.filter(t => t === 'first question')).toHaveLength(1);
    expect(texts).toContain('First answer.');
    expect(texts).not.toContain('First   answer.');
    await expect(page.locator('#toast')).toContainText('removed 2 duplicate messages');
  });

test('tidying a legacy transcript persists even when the read adds no messages', async ({page}) => {
  await open(page);
  const key = await join(page);
  await legacy(page, key);
  await page.evaluate(async () => recordPane(activePane, []));
  await page.evaluate(k => convHeld.delete(k), key);
  const stored = await held(page, key);
  expect(stored.backfilled).toBe(true);
  expect(stored.entries.filter(e => e.text === 'first question')).toHaveLength(1);
});

test('a record this recorder wrote is never offered to the repair', async ({page}) => {
  // convDedupe calls a repeat within 200 entries a duplicate, and an agent that says "Done." twice
  // inside 200 entries said it twice. The gate is `backfilled`, which every record written since
  // carries — so a sound record is never handed to a lossy rule.
  await open(page);
  const key = await join(page);
  await read(page, '❯ go\n\n⏺ Done.\n\n❯\n');
  await page.evaluate(async k => {
    const held = (await convGet([k]))[0];
    held.entries.push({who: 'agent', text: 'Done.', at: Date.now(), seen: Date.now(),
      at_src: 'state'});
    convHeld.delete(k);
    await convPut(held);
  }, key);
  await read(page, '❯ go\n\n⏺ Done.\n\n❯ again\n\n⏺ Done.\n\n❯\n');
  expect((await held(page, key)).entries.filter(e => e.text === 'Done.').length)
    .toBeGreaterThanOrEqual(2);
});

test('the repair can be turned off, and the setting is remembered', async ({page}) => {
  await open(page);
  const key = await join(page);
  await page.evaluate(() => setConvTidy(false));
  await legacy(page, key);
  await read(page);
  expect((await held(page, key)).entries.map(e => e.text)).toContain('First   answer.');
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.getElementById('tidyPick').value))
    .toBe('off');
});

// --- Between reading a pane and writing to it ---
//
// The composer, the badge, and where a switch lands. All four live in the same place: what the app
// does with a thread that is on screen, as opposed to a pane that is.

test('a text past one message goes as several, and one Enter submits them all',
  async ({page}) => {
    // The relay caps one `send_text` at 4000 and always has. Raising that cap would fix this for
    // nobody who has not upgraded the relay — the app is on GitHub Pages and the relay is on the
    // user's own machine — so the split is here, against the oldest relay's number.
    await open(page);
    await tapWire(page);
    const text = ('a diff line that is long enough to matter ' + 'x'.repeat(60) + '\n').repeat(220);
    await page.evaluate(t => {
      document.getElementById('termInput').value = t;
      sendText();
    }, text);
    const sent = await page.evaluate(() => window.__sent);
    const parts = sent.filter(m => m.type === 'send_text');
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts) expect(p.text.length).toBeLessThanOrEqual(4000);
    // The agent's composer receives exactly what was typed, and nothing between the chunks submits.
    expect(parts.map(p => p.text).join('')).toBe(text);
    const keys = sent.filter(m => m.type === 'send_keys');
    expect(keys).toHaveLength(1);
    expect(keys[0].keys).toEqual(['Enter']);
    // And the Enter is behind every chunk, or it submits half a diff.
    expect(sent.indexOf(keys[0])).toBe(sent.length - 1);
  });

test('the transcript keeps a long message whole', async ({page}) => {
  await open(page);
  const key = await join(page);
  await tapWire(page);
  const text = 'x'.repeat(9000);
  await page.evaluate(t => {
    document.getElementById('termInput').value = t;
    sendText();
  }, text);
  // What was sent is one message however many the wire took, and D1 says the record is what was
  // said — a record cut at the length of one `send_text` could not answer what was sent.
  await expect.poll(async () => {
    const rec = await held(page, key);
    return (rec && rec.entries.filter(e => e.text.length === 9000).length) || 0;
  }).toBe(1);
});

test('a working pane says WORKING on its own newest bubble, and moves', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  await forceStatus(page, AGENT, 'working');
  await page.evaluate(() => convSetView(paneOf(activePane), loadConvIndex()[0].id));
  await page.evaluate(() => renderConvView());
  const badge = page.locator('#convThread .conv-msg .conv-badge').last();
  await expect(badge).toHaveText('working');          // uppercased by the badge's own CSS
  expect(await badge.evaluate(el => getComputedStyle(el).textTransform)).toBe('uppercase');
  // The dots are CSS on a pseudo-element and not text: syncConvBadge runs on the poll and writes
  // in place so that nothing re-renders under a reader's finger.
  const dots = await badge.evaluate(el => {
    const s = getComputedStyle(el, '::after');
    return {content: s.content, animation: s.animationName};
  });
  expect(dots.content).toContain('...');
  expect(dots.animation).toBe('conv-dots');
});

test('in a joint thread, a partner working while someone else spoke last still says so',
  async ({page}) => {
    await open(page);
    const key = await join(page);
    await read(page);
    const mate = await partner(page, 0);
    await page.evaluate(([k, p]) => {
      const other = agents.find(x => x.pane_id === p);
      other.status = 'working';
      convSetView(paneOf(activePane), loadConvIndex()[0].id);
      return renderConvView();
    }, [key, mate.pane]);
    // The badge used to land on the thread's last bubble whoever wrote it, so a partner that was
    // working but not newest showed nothing — the exact case a joint thread exists for.
    const badges = page.locator('#convThread .conv-badge');
    await expect.poll(() => badges.count()).toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => Array.from(
      document.querySelectorAll('#convThread .conv-badge')).map(b => b.textContent)))
      .toContain('working');
  });

test('switching to a pane lands at the newest bubble, not where the last one sat',
  async ({page}) => {
    await open(page);
    const key = await join(page);
    // A thread long enough to scroll, then scrolled to the top of it.
    for (let i = 0; i < 12; i++) await read(page, `❯ question ${i}\n\n⏺ Answer ${i}.\n\n❯\n`);
    await page.evaluate(() => convSetView(paneOf(activePane), loadConvIndex()[0].id));
    await page.evaluate(() => renderConvView());
    await page.evaluate(() => { document.getElementById('convThread').scrollTop = 0; });
    const pane = await page.evaluate(() => activePane);
    // Away and back: `stick` is measured against the box as it stands, and on a switch that box
    // still holds the thread being left.
    await page.evaluate(() => closeTerminal());
    await page.evaluate(p => openTerminal(p), pane);
    await expect.poll(() => page.evaluate(() => {
      const b = document.getElementById('convThread');
      return b.scrollHeight - b.scrollTop - b.clientHeight;
    })).toBeLessThan(24);
  });

test('a reader who scrolled up in a thread stays there through a poll', async ({page}) => {
  await open(page);
  await join(page);
  for (let i = 0; i < 12; i++) await read(page, `❯ question ${i}\n\n⏺ Answer ${i}.\n\n❯\n`);
  await page.evaluate(() => convSetView(paneOf(activePane), loadConvIndex()[0].id));
  await page.evaluate(() => renderConvView());
  await page.evaluate(() => { document.getElementById('convThread').scrollTop = 0; });
  await page.evaluate(() => renderConvView());
  expect(await page.evaluate(() => document.getElementById('convThread').scrollTop)).toBe(0);
});

test('the composer survives the fold while a thread is on screen', async ({page}) => {
  // The fold trades height for a control you are not using while you read a long pane. Replying is
  // what reading a thread is, so in a conversation that trade takes the thing the view is for.
  await open(page);
  await join(page);
  await read(page);
  await page.evaluate(() => convSetView(paneOf(activePane), loadConvIndex()[0].id));
  await page.evaluate(() => renderConvView());
  await page.evaluate(() => {
    localStorage.setItem('herdr_bottom_dock', 'folded');
    syncBottomDock();
  });
  await expect(page.locator('#termInput')).toBeVisible();
  // The key docks still fold — this is not a way of turning the fold off.
  expect(await page.evaluate(() =>
    document.getElementById('terminalView').classList.contains('dock-folded'))).toBe(true);
});

test('with a thread up, the header row switches between that conversation’s members',
  async ({page}) => {
    await open(page);
    const key = await join(page);
    await read(page);
    const mate = await partner(page, 0);
    const before = await page.evaluate(() => Array.from(
      document.querySelectorAll('#agentTabs .agent-tab')).map(b => b.dataset.pane));
    await page.evaluate(() => {
      convSetView(paneOf(activePane), loadConvIndex()[0].id);
      renderConvBar();
    });
    const panes = await page.evaluate(() => Array.from(
      document.querySelectorAll('#agentTabs .agent-tab')).map(b => b.dataset.pane));
    // Both members, and nothing that is not one.
    const mine = await page.evaluate(() => activePane);
    expect(new Set(panes)).toEqual(new Set([mine, mate.pane]));
    // Including members the Project scope would have dropped: a conversation is free to span
    // projects, which is what makes it a conversation and not a directory.
    expect(before).not.toContain(mate.pane);
  });

// --- The conversation window's dock (§4) ---
//
// The standalone conversation view is where several agents are read together, and the dock is how
// the reader talks back: who is being addressed, what is added to what they send, a composer that
// floats over the thread, and the one send in the app with no checkpoint behind it. The pane's own
// thread keeps its sheet and is deliberately untouched, which the second test below is about.
//
// No pair is recorded anywhere in this section unless a test says so: membership in the
// conversation is what makes an agent a target. A conversation is not a pair.

// The window, opened the way a reader opens it — from the landing page's card.
const openWindow = async page => {
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();
  await expect(page.locator('#convView')).toBeVisible();
};

test('typing in the conversation composer keeps its newest bubble visible', async ({page}) => {
  await open(page);
  const key = await join(page);
  await page.evaluate(k => {
    convHeld.set(k, {key: k, label: 'Architect 1', entries: Array.from({length: 40}, (_, i) =>
      ({who: 'agent', text: `message ${i}`, at: Date.now() - (40 - i) * 1000, at_src: 'state'}))});
  }, key);
  await openWindow(page);
  await expect(page.locator('#convViewThread .conv-msg')).toHaveCount(40);
  await page.locator('#convView').evaluate(view => { view.scrollTop = 0; });
  await page.locator('#convInput').fill('reply');
  await expect.poll(() => page.locator('#convView').evaluate(view =>
    view.scrollHeight - view.scrollTop - view.clientHeight)).toBeLessThan(24);
});

// A third member, so the target row has something to choose between. Three agents in one
// conversation is the case the row exists for.
const joinThird = page => page.evaluate(async () => {
  const third = agents.find(a => a.label === 'amp');
  const key = convMemberKey(third);
  await convPut({key, label: 'amp', first: 1, touched: 2,
    entries: [{who: 'agent', text: 'the third pane', seen: 2, label: 'amp', agent: 'amp'}]});
  const items = loadConvIndex();
  items[0].members.push({key, added: 1, label: 'amp', messages: 1});
  saveConvIndex(items);
  return third.pane_id;
});

// The source of a transfer is whoever wrote the picked bubble, so which bubble is picked decides
// which way it goes. Picked by what it says rather than by position: the thread interleaves its
// members by time, and a position is a fact about the fixture.
const pickBubble = async (page, text) => {
  const msg = page.locator('#convViewThread .conv-msg', {hasText: text});
  await msg.locator('.conv-pick').click();
  await expect(msg).toHaveClass(/picked/);
};

// Instructions attached to the send rather than written into the box. The default is the other
// way round — the instruction on screen where it can be read — so the tests about lit chips say so.
const attachMode = async page => {
  await page.locator('#xferRow .xfer-chip.fill').click();
  await expect(page.locator('#xferRow .xfer-chip.fill')).toHaveAttribute('aria-pressed', 'false');
};

const whoRow = page => page.locator('#xferRow .xfer-who');
const litWho = page => page.locator('#xferRow .xfer-who.on');
const sendPicked = page => page.locator('#xferRow .xfer-send').click();

// The composer, used the way it is on a phone: type, then tap the round send.
const compose = async (page, text) => {
  await page.locator('#convInput').fill(text);
  await page.locator('#convSendBtn').click();
};

const sentText = page => page.evaluate(() =>
  window.__sent.filter(m => m.type === 'send_text'));
const sentBody = async page => (await sentText(page)).map(m => m.text).join('');

test('the dock sends a picked message straight into another member', async ({page}) => {
  await open(page);
  const [mine] = await joinBoth(page);
  await read(page);
  await tapWire(page);
  await openWindow(page);
  await attachMode(page);
  await pickBubble(page, 'the other pane spoke first');           // scratch's
  await page.locator('#xferRow .xfer-chip').first().click();      // @review
  await sendPicked(page);
  const text = await sentText(page);
  expect(text.length).toBeGreaterThan(0);
  // Into the other member, not the pane the message came from.
  for (const m of text) expect(m.pane_id).toBe('w1:p1');
  const body = text.map(m => m.text).join('');
  expect(body).toContain('Review, edit, fix');
  expect(body).toContain('the other pane spoke first');
  // Named by the member it came from, so the receiving agent is told whose words these are.
  expect(body).toContain('feedback from scratch:');
  // And submitted — that is the whole of what makes this different from the transfer sheet.
  const sent = await page.evaluate(() => window.__sent);
  expect(sent.filter(m => m.type === 'send_keys' && m.keys[0] === 'Enter')).toHaveLength(1);
  await expect(page.locator('#toast')).toContainText('Sent 1 message to Architect 1');
  // Recorded against the receiving pane, and the pick is spent.
  expect(mine).toBeTruthy();
  await expect(page.locator('#convViewThread .conv-msg.picked')).toHaveCount(0);
});

test('the pane view keeps its sheet and is offered no dock', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  // A pair, so the sheet's own button has a partner to offer and the comparison is fair.
  await page.evaluate(() => {
    const mine = paneOf(activePane), other = agents.find(a => a.label === 'scratch');
    pairs = [{id: 'p1', members: [recentFingerprint(mine), recentFingerprint(other)]}];
  });
  await page.locator('#quickActions .qa-conv').click();
  await page.locator('#convThread .conv-msg').first().locator('.conv-pick').click();
  await expect(page.locator('#selBar')).toBeVisible();
  // A selection here still ends at a checkpoint: the sheet prefills the composer and stops.
  await expect(page.locator('#selTransfer')).toBeVisible();
  await expect(page.locator('#convDock')).toBeHidden();
  await page.locator('#selTransfer').click();
  await expect(page.locator('#transferSheet')).toBeVisible();
  await expect(page.locator('#transferPreview')).not.toBeEmpty();
});

test('a conversation of one can be typed to, and has nothing to transfer to', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await tapWire(page);
  await openWindow(page);
  await expect(whoRow(page)).toHaveCount(1);
  await expect(litWho(page)).toHaveText(/Architect 1/);
  await pickBubble(page, 'Ready. Name the change.');
  // Nobody to send it to, so no button that would. The row stays: it is still who the composer is
  // addressing, and the pick is one tap from being undone. The one member is not marked as the
  // source either — the composer below it still types into that pane, and a pill drawn dead beside
  // a composer that works would be lying.
  await expect(page.locator('#xferRow .xfer-send')).toHaveCount(0);
  await expect(litWho(page)).toHaveText(/Architect 1/);
  await expect(whoRow(page)).toBeEnabled();
  await compose(page, 'carry on then');
  expect((await sentText(page)).map(m => m.pane_id)).toEqual(['w1:p1']);
});

test('a conversation whose members have all exited is offered no dock', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.evaluate(() => { agents = []; renderBody(); });
  await page.locator('#conversations .conversation-card').click();
  // The thread is still readable — that is what the record is for. A composer that could only fail
  // is worse than none.
  await expect(page.locator('#convViewThread .conv-msg').first()).toBeVisible();
  await expect(page.locator('#convDock')).toBeHidden();
});

test('no chip sends the payload with no instruction', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await tapWire(page);
  await openWindow(page);
  await pickBubble(page, 'the other pane spoke first');
  await expect(page.locator('#xferRow .xfer-send')).toHaveText('Send (1) ›');
  await sendPicked(page);
  const body = await sentBody(page);
  expect(body).toContain('the other pane spoke first');
  expect(body).not.toContain('Review, edit, fix');
});

test('chips add up, in the order they were tapped', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await tapWire(page);
  await openWindow(page);
  await pickBubble(page, 'the other pane spoke first');
  await attachMode(page);
  const at = name => page.locator(`#xferRow .xfer-chip:text-matches("^@${name}")`);
  await at('test').click();
  await at('review').click();
  // Numbered by the order they were chosen, because that order is what gets written.
  await expect(at('test')).toHaveText('@test1');
  await expect(at('review')).toHaveText('@review2');
  await expect(page.locator('#xferRow .xfer-send')).toHaveText('Send (1) ›');
  await sendPicked(page);
  const body = await sentBody(page);
  expect(body.indexOf('Write the tests')).toBeGreaterThan(-1);
  expect(body.indexOf('Write the tests')).toBeLessThan(body.indexOf('Review, edit, fix'));
});

test('a chip tapped twice comes back out', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await tapWire(page);
  await openWindow(page);
  await pickBubble(page, 'the other pane spoke first');
  await attachMode(page);
  const review = page.locator('#xferRow .xfer-chip').first();
  await review.click();
  await expect(review).toHaveAttribute('aria-pressed', 'true');
  await review.click();
  await expect(review).toHaveAttribute('aria-pressed', 'false');
  await sendPicked(page);
  expect(await sentBody(page)).not.toContain('Review, edit, fix');
});

test('the target is every other member, and the chosen one can be overridden', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  const third = await joinThird(page);
  await tapWire(page);
  await openWindow(page);
  await pickBubble(page, 'the other pane spoke first');           // scratch's
  // Every member stays in the row — a pick narrows who may receive the message, never who is in
  // the conversation — and the one that said it is marked rather than removed, because a message
  // cannot be transferred back into the session that wrote it.
  await expect(whoRow(page)).toHaveCount(3);
  await expect(whoRow(page).filter({hasText: 'scratch'})).toHaveClass(/from/);
  await expect(whoRow(page).filter({hasText: 'scratch'})).toBeDisabled();
  // The first member is lit; the rest are there, dimmed — which agents are in this conversation is
  // information, and hiding them would answer a different question.
  await expect(litWho(page)).toHaveText(/Architect 1/);
  await whoRow(page).filter({hasText: 'amp'}).click();
  await expect(litWho(page)).toHaveText(/amp/);
  await sendPicked(page);
  const to = (await sentText(page)).map(m => m.pane_id);
  expect(new Set(to)).toEqual(new Set([third]));
});

// The pair the dock defaults to: between the pane whose message gets picked and one of the other
// two members, so "the partner" and "the first pill" are different answers.
const pairScratchWithAmp = page => page.evaluate(() => {
  pairs = [{id: 'p1', members: [recentFingerprint(agents.find(a => a.label === 'scratch')),
    recentFingerprint(agents.find(a => a.label === 'amp'))]}];
});

test('a picked message defaults to the pane its author is paired with', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  const third = await joinThird(page);
  // scratch — whose message is picked — is paired with amp, and Architect 1 is the third member
  // and the row's first pill.
  await pairScratchWithAmp(page);
  await tapWire(page);
  await openWindow(page);
  await page.evaluate(() => setDockMru(false));
  await pickBubble(page, 'the other pane spoke first');           // scratch's
  // Not the row's first member: where a message goes is a fact about the message, and the pane
  // its author is paired with is that answer nearly every time.
  await expect(litWho(page)).toHaveText(/amp/);
  await sendPicked(page);
  expect(new Set((await sentText(page)).map(m => m.pane_id))).toEqual(new Set([third]));
});

test('the pair is only the default, and any pill overrides it', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  const mine = await page.evaluate(() => activePane);
  await joinThird(page);
  await pairScratchWithAmp(page);
  await tapWire(page);
  await openWindow(page);
  await page.evaluate(() => setDockMru(false));
  // Chosen before the pick, and still chosen after it: a default is what fills a blank, never
  // what corrects a reader.
  await whoRow(page).filter({hasText: 'Architect 1'}).click();
  await pickBubble(page, 'the other pane spoke first');
  await expect(litWho(page)).toHaveText(/Architect 1/);
  // And chosen after the pick, over the pair the default had picked.
  await whoRow(page).filter({hasText: 'amp'}).click();
  await expect(litWho(page)).toHaveText(/amp/);
  await whoRow(page).filter({hasText: 'Architect 1'}).click();
  await sendPicked(page);
  expect(new Set((await sentText(page)).map(m => m.pane_id))).toEqual(new Set([mine]));
});

test('a pick never takes the other members out of the row', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  const third = await joinThird(page);
  await tapWire(page);
  await openWindow(page);
  // Chosen before the pick, and still chosen after it: picking a message is not choosing who to
  // talk to, and the row that was on screen must not rearrange itself under the reader.
  await whoRow(page).filter({hasText: 'amp'}).click();
  await pickBubble(page, 'the other pane spoke first');
  await expect(whoRow(page)).toHaveCount(3);
  await expect(litWho(page)).toHaveText(/amp/);
  // The others are still one tap away, including the one the pair would have picked.
  await whoRow(page).filter({hasText: 'Architect 1'}).click();
  await expect(litWho(page)).toHaveText(/Architect 1/);
  await whoRow(page).filter({hasText: 'amp'}).click();
  await sendPicked(page);
  expect(new Set((await sentText(page)).map(m => m.pane_id))).toEqual(new Set([third]));
  // And with the pick gone the member that wrote it is a target again.
  await expect(whoRow(page).filter({hasText: 'scratch'})).toBeEnabled();
});

test('the row stays up with nothing picked, and points the composer', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  const third = await joinThird(page);
  await tapWire(page);
  await openWindow(page);
  // No selection at all. The row is the conversation's address line, not a selection bar.
  await expect(page.locator('#xferRow')).toBeVisible();
  await expect(page.locator('#xferRow .xfer-send')).toHaveCount(0);
  await expect(whoRow(page)).toHaveCount(3);
  await whoRow(page).filter({hasText: 'amp'}).click();
  await compose(page, 'over to you');
  const sent = await sentText(page);
  expect(sent.map(m => m.pane_id)).toEqual([third]);
  expect(sent[0].text).toBe('over to you');
  // Still reading the conversation: only Open pane leaves it, and no pane was opened behind it.
  await expect(page.locator('#convView')).toBeVisible();
  expect(await page.evaluate(() => activePane)).toBe(null);
  // The composer empties, because what was in it has been sent.
  await expect(page.locator('#convInput')).toHaveValue('');
});

test('an instruction is spent by the send, the agent chosen is not', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await joinThird(page);
  await tapWire(page);
  await openWindow(page);
  await attachMode(page);
  await whoRow(page).filter({hasText: 'scratch'}).click();
  await page.locator('#xferRow .xfer-chip').first().click();      // @review
  await compose(page, 'the diff is on the branch');
  // The instruction leads, then what was typed.
  expect(await sentBody(page))
    .toBe('Review, edit, fix; then propose next steps.\n\nthe diff is on the branch');
  // The chip is spent — it was attached to that message.
  await expect(page.locator('#xferRow .xfer-chip[aria-pressed=true]')).toHaveCount(0);
  // The agent is not: you go on talking to whoever you chose.
  await expect(litWho(page)).toHaveText(/scratch/);
  await compose(page, 'and the tests pass');
  const to = (await sentText(page)).map(m => m.pane_id);
  expect(new Set(to)).toEqual(new Set(['w8:p1']));
});

test('leaving the conversation takes the chosen agent and the draft with it', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await joinThird(page);
  await openWindow(page);
  // With the recency sort off, so what is being tested is the target being forgotten rather than
  // the row's order — with it on the agent last written to is deliberately still the first pill.
  await page.evaluate(() => setDockMru(false));
  await whoRow(page).filter({hasText: 'amp'}).click();
  await page.locator('#convInput').fill('half a thought');
  // Who you were talking to and what you were about to say belong to this conversation.
  await page.locator('#convView .back').click();
  await page.locator('#conversations .conversation-card').click();
  await expect(litWho(page)).toHaveText(/Architect 1/);
  await expect(page.locator('#convInput')).toHaveValue('');
});

test('a transfer keeps what was already being typed, under the quote', async ({page}) => {
  await open(page);
  const [mine] = await joinBoth(page);
  await read(page);
  await tapWire(page);
  await openWindow(page);
  // The composer is always open, so a half-written note is the ordinary state to be in when a
  // bubble is picked.
  await page.locator('#convInput').fill('this is the bit that broke');
  await pickBubble(page, 'the other pane spoke first');
  await sendPicked(page);
  const body = await sentBody(page);
  expect(body).toContain('the other pane spoke first');
  expect(body.endsWith('this is the bit that broke')).toBe(true);
  // Payload plus a note of your own is neither a clean transfer nor something typed.
  await expect.poll(async () => {
    const rec = await held(page, mine);
    const sent = (rec && rec.entries.filter(e => e.who === 'user')) || [];
    return sent.length && sent[sent.length - 1].via;
  }).toBe('mixed');
});

test('a direct transfer is recorded as a transfer, not as something typed', async ({page}) => {
  await open(page);
  const [mine] = await joinBoth(page);
  await read(page);
  await openWindow(page);
  await attachMode(page);
  await pickBubble(page, 'the other pane spoke first');
  await page.locator('#xferRow .xfer-chip').first().click();
  await sendPicked(page);
  // The classifier runs at the send, against the pendingTransfer convDockSend left — a transcript
  // that cannot tell a transfer from typing claims the reader said what another agent did.
  await expect.poll(async () => {
    const rec = await held(page, mine);
    const sent = (rec && rec.entries.filter(e => e.who === 'user')) || [];
    return sent.length && sent[sent.length - 1].via;
  }).toBe('transfer');
});

test('@+ lists every instruction, and picking there is the same pick', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await openWindow(page);
  await attachMode(page);
  await pickBubble(page, 'the other pane spoke first');
  await page.locator('#xferRow .xfer-chip.more').click();
  const menu = page.locator('#chipMenu');
  await expect(menu.locator('[role=menuitemcheckbox]')).toHaveCount(
    await page.evaluate(() => SHORTCUTS.length));
  await menu.locator('[role=menuitemcheckbox]', {hasText: 'Architect prompt'}).click();
  await expect(page.locator('#xferRow .xfer-chip[aria-pressed=true]')).toHaveText(/^@architect/);
  // The list is the same picks drawn twice, so it has to show the tap it just took.
  await expect(menu.locator('[aria-checked=true]')).toHaveText(/@architect/);
  await menu.locator('[role=menuitem]', {hasText: 'Done'}).click();
  await expect(menu).toBeHidden();
});

test('the @+ list closes on a tap past it, and on a second tap of @+', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await openWindow(page);
  const menu = page.locator('#chipMenu');
  const more = page.locator('#xferRow .xfer-chip.more');
  await more.click();
  await expect(menu).toBeVisible();
  // A menu opened by mistake closes the way every other menu on a phone does.
  await page.locator('#convViewThread .conv-msg').first().click();
  await expect(menu).toBeHidden();
  await more.click();
  await expect(menu).toBeVisible();
  // And the control that opened it is the control that closes it.
  await more.click();
  await expect(menu).toBeHidden();
});

test('the agent row has its own list, and choosing there is the same choice', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  const third = await joinThird(page);
  await tapWire(page);
  await openWindow(page);
  const menu = page.locator('#whoMenu');
  const more = page.locator('#xferRow .xfer-who-more.list');
  await more.click();
  await expect(menu).toBeVisible();
  // Every member, named the way the pills name them — this is the row, read as a list.
  await expect(menu.locator('.menu-item')).toHaveCount(3);
  await menu.locator('.menu-item', {hasText: 'amp'}).click();
  // The list has said what it was opened to say, so it closes behind the choice.
  await expect(menu).toBeHidden();
  await expect(litWho(page)).toHaveText(/amp/);
  await compose(page, 'over to you');
  expect((await sentText(page)).map(m => m.pane_id)).toEqual([third]);
});

test('the agent list closes on a tap past it, and never shares the screen with @+',
  async ({page}) => {
    await open(page);
    await joinBoth(page);
    await read(page);
    await openWindow(page);
    const who = page.locator('#whoMenu'), chips = page.locator('#chipMenu');
    const whoMore = page.locator('#xferRow .xfer-who-more.list');
    const chipMore = page.locator('#xferRow .xfer-chip.more');
    await whoMore.click();
    await expect(who).toBeVisible();
    // One list at a time: two of them stacked over the thread cover it twice for one question.
    await chipMore.click();
    await expect(who).toBeHidden();
    await expect(chips).toBeVisible();
    await whoMore.click();
    await expect(chips).toBeHidden();
    await expect(who).toBeVisible();
    await page.locator('#convViewThread .conv-msg').first().click();
    await expect(who).toBeHidden();
    // And the control that opened it is the control that closes it.
    await whoMore.click();
    await expect(who).toBeVisible();
    await whoMore.click();
    await expect(who).toBeHidden();
  });

test('the dock opens the addressed pane straight into its terminal', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  const third = await joinThird(page);
  await tapWire(page);
  await openWindow(page);
  await whoRow(page).filter({hasText: 'amp'}).click();
  await page.locator('#xferRow .xfer-who-more.open').click();
  // The pane it was addressing, and the rows — not the pane's own thread, which is what the
  // window being left already was.
  await expect(page.locator('#terminalView')).toBeVisible();
  expect(await page.evaluate(() => activePane)).toBe(third);
  await expect(page.locator('#convThread')).toBeHidden();
  await expect(page.locator('#termContent')).toBeVisible();
});

test('the agent list button wears the agent icon', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await openWindow(page);
  // Said by the button rather than by a caret that could open anything.
  await expect(page.locator('#xferRow .xfer-who-more.list')).toHaveText('🤖');
});

test('what was used last comes back to the left, and the sort can be turned off',
  async ({page}) => {
    await open(page);
    await joinBoth(page);
    await read(page);
    await joinThird(page);
    await tapWire(page);
    await openWindow(page);
    const names = () => whoRow(page).allTextContents();
    const chips = () => page.locator('#xferRow .xfer-chip-row .xfer-chip').allTextContents();
    // Roster order to begin with: nothing has been used, so nothing has been learned.
    expect((await names())[0]).toMatch(/Architect 1/);
    const firstChip = (await chips())[0];
    await whoRow(page).filter({hasText: 'amp'}).click();
    // Choosing who to talk to is not writing to them. The recency promise is about the last agent
    // written to, so an abandoned choice must not reshuffle the row under the next conversation.
    expect((await names())[0]).toMatch(/Architect 1/);
    await compose(page, 'remember this target');
    expect((await names())[0]).toMatch(/amp/);
    await page.locator(`#xferRow .xfer-chip-row .xfer-chip`).nth(1).click();
    const moved = (await chips())[0];
    expect(moved).not.toBe(firstChip);
    // Remembered, because the row a reader learned must not be reset by a reload.
    await page.reload();
    await page.locator('#conversations .conversation-card').click();
    await expect(page.locator('#convView')).toBeVisible();
    expect((await names())[0]).toMatch(/amp/);
    expect((await chips())[0]).toBe(moved);
    // Off holds the rows still — the order they had before anyone taught them anything.
    await page.evaluate(() => setDockMru(false));
    expect((await names())[0]).toMatch(/Architect 1/);
    expect((await chips())[0]).toBe(firstChip);
    // And what was learned is still there when it is turned back on.
    await page.evaluate(() => setDockMru(true));
    expect((await names())[0]).toMatch(/amp/);
  });

test('on a phone both rows scroll sideways rather than wrapping', async ({page}) => {
  await page.setViewportSize({width: 380, height: 720});
  await open(page);
  await joinBoth(page);
  await read(page);
  await joinThird(page);
  await tapWire(page);
  await openWindow(page);
  // A row that wrapped would push the thread up by an unpredictable amount every time an agent
  // joined, and the buttons that list the rest have to stay on screen to be the way back.
  for (const sel of ['#xferRow .xfer-who-row', '#xferRow .xfer-chip-row']) {
    const row = await page.evaluate(sel => {
      const el = document.querySelector(sel);
      const tops = Array.from(el.children).map(c => Math.round(c.getBoundingClientRect().top));
      return {lines: new Set(tops).size, overflow: getComputedStyle(el).overflowX,
        wrap: getComputedStyle(el).flexWrap, scrolls: el.scrollWidth > el.clientWidth,
        wide: el.clientWidth <= document.getElementById('convBubble').clientWidth};
    }, sel);
    expect(row.lines).toBe(1);
    expect(row.wrap).toBe('nowrap');
    expect(row.overflow).toBe('auto');
    expect(row.wide).toBe(true);
  }
  await expect(page.locator('#xferRow .xfer-who-more.list')).toBeVisible();
  await expect(page.locator('#xferRow .xfer-who-more.open')).toBeVisible();
  await expect(page.locator('#xferRow .xfer-chip.more')).toBeVisible();
  // Nothing overflows the bubble itself: it is the rows inside it that scroll.
  const bubble = await page.locator('#convBubble').boundingBox();
  expect(bubble.width).toBeLessThanOrEqual(380);
});

test('the composer is the pane composer: same face, same size control', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await openWindow(page);
  const size = () => page.evaluate(() => {
    const s = getComputedStyle(document.getElementById('convInput'));
    const g = getComputedStyle(document.getElementById('convGhost'));
    return [s.fontSize, s.fontFamily, s.fontFamily === g.fontFamily && s.fontSize === g.fontSize];
  });
  const [before, face, ghostMatches] = await size();
  // Monospace, because writing to an agent here is the same act as writing to it from its pane —
  // and because the block cursor is only one character wide in a box where characters are.
  expect(face).toMatch(/mono/i);
  // The ghost has to match exactly or the drawn cursor lands on the wrong character.
  expect(ghostMatches).toBe(true);
  await page.evaluate(() => setInputFont(22));
  const [after] = await size();
  expect(parseFloat(after)).toBeGreaterThan(parseFloat(before));
  expect(parseFloat(after)).toBe(22);
});

test('a tap anywhere in the composer puts the caret in the text', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await tapWire(page);
  await openWindow(page);
  const input = page.locator('#convInput');
  await expect(input).not.toBeFocused();
  // The padding around the field is the field: a phone's message box does not ask to be hit
  // exactly. Tapped at the very edge of the bubble's composer, off the textarea itself.
  const box = await page.locator('#convComposer').boundingBox();
  await page.mouse.click(box.x + 3, box.y + 3);
  await expect(input).toBeFocused();
  // The send button keeps its own tap, and an empty composer sends nothing.
  await page.locator('#convSendBtn').click();
  expect(await sentText(page)).toEqual([]);
});

test('the dock floats over the thread, at the bottom of the window', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await openWindow(page);
  const box = await page.evaluate(() => {
    const dock = document.getElementById('convDock').getBoundingClientRect();
    const view = document.getElementById('convView').getBoundingClientRect();
    const thread = document.getElementById('convViewThread').getBoundingClientRect();
    return {dockBottom: dock.bottom, viewBottom: view.bottom, threadBottom: thread.bottom,
      measured: getComputedStyle(document.getElementById('convView')).getPropertyValue('--dock-h')};
  });
  // Sitting on the bottom of the view, not halfway up it behind a short thread.
  expect(Math.abs(box.dockBottom - box.viewBottom)).toBeLessThan(2);
  // And over the thread rather than under it: the thread runs to the bottom too, behind it.
  expect(box.threadBottom).toBeGreaterThanOrEqual(box.dockBottom - 2);
  // Measured, not guessed — the row, the chip list and a growing composer all change it.
  expect(parseFloat(box.measured)).toBeGreaterThan(0);
});

test('the address row, the chips and the message are one bubble', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await openWindow(page);
  // Not three panels that happen to be near each other: one control, addressed and written.
  const bubble = page.locator('#convBubble');
  await expect(bubble.locator('#xferRow')).toBeVisible();
  await expect(bubble.locator('#convComposer')).toBeVisible();
});

test('the bubble and the lit pill wear the agent about to receive the message',
  async ({page}) => {
    await open(page);
    await joinBoth(page);
    await read(page);
    await openWindow(page);
    // A pane's harness has a colour everywhere else in the app; the thing being written into it is
    // where it matters most, because that is where the eye is while typing.
    const accent = () => page.evaluate(() =>
      document.getElementById('convBubble').style.getPropertyValue('--dock-accent'));
    expect(await accent()).toBe('var(--agent-claude)');   // Architect 1 is the claude pane
    await whoRow(page).filter({hasText: 'scratch'}).click();
    expect(await accent()).toBe('var(--blue)');           // scratch is codex
    // And the pill says which harness in words, the way the pane header does — "scratch" alone does
    // not say whether that is a codex or a claude.
    await expect(whoRow(page).filter({hasText: 'scratch'}).locator('.badge')).toHaveText('codex');
    await expect(whoRow(page).filter({hasText: 'Architect 1'}).locator('.badge'))
      .toHaveText('claude');
  });

test('the pills are sized by the conversation-text control, like the names above them',
  async ({page}) => {
    await open(page);
    await joinBoth(page);
    await read(page);
    await openWindow(page);
    const size = () => page.evaluate(() => {
      const pill = document.querySelector('#xferRow .xfer-who');
      const head = document.querySelector('#convViewThread .conv-who');
      return [getComputedStyle(pill).fontSize, getComputedStyle(head).fontSize,
        getComputedStyle(pill).fontFamily === getComputedStyle(head).fontFamily];
    });
    const [pill, head, sameFace] = await size();
    // A pill naming a member in a different type from the bubbles naming that same member reads as
    // a different member. Same face, same size, same control.
    expect(pill).toBe(head);
    expect(sameFace).toBe(true);
    await page.evaluate(() => setConvFont(20));
    const [bigger] = await size();
    expect(parseFloat(bigger)).toBeGreaterThan(parseFloat(pill));
    // The text grew; the pill keeps a floor under it at the smallest sizes.
    await page.evaluate(() => setConvFont(6));
    expect((await page.locator('#xferRow .xfer-who').first().boundingBox()).height)
      .toBeGreaterThanOrEqual(26);
  });

test('the composer draws its own block cursor, and it is always there', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await openWindow(page);
  const cursor = page.locator('#convGhost .cur');
  // Before anything is typed, and without focus: the block is what says this is a place to type.
  await expect(cursor).toHaveCount(1);
  await page.locator('#convInput').fill('ship it');
  await page.locator('#convInput').click();
  const at = async () => (await cursor.boundingBox()).x;
  const end = await at();
  // It follows the caret rather than sitting at the end of the box.
  await page.evaluate(() => {
    const i = document.getElementById('convInput');
    i.setSelectionRange(0, 0);
    syncConvCursor();
  });
  expect(await at()).toBeLessThan(end);
  // And the platform's own caret is off, so there is exactly one.
  await expect(page.locator('#convInput')).toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');
});

test('a double tap on a bubble addresses the agent that wrote it', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  const third = await joinThird(page);
  await tapWire(page);
  await openWindow(page);
  await page.evaluate(() => setDockMru(false));
  await expect(litWho(page)).toHaveText(/Architect 1/);
  // The gesture is double rather than single, because a single tap in a thread already selects
  // text and already picks a bubble for transfer.
  await page.locator('#convViewThread .conv-msg', {hasText: 'the third pane'}).dblclick();
  await expect(litWho(page)).toHaveText(/amp/);
  // And the word the double-click selected is not a selection anybody asked for.
  expect(await page.evaluate(() => String(window.getSelection()))).toBe('');
  await compose(page, 'over to you');
  expect((await sentText(page)).map(m => m.pane_id)).toEqual([third]);
});

test('a double tap on the picked message\'s own bubble changes nothing', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await joinThird(page);
  await tapWire(page);
  await openWindow(page);
  await page.evaluate(() => setDockMru(false));
  await whoRow(page).filter({hasText: 'amp'}).click();
  await pickBubble(page, 'the other pane spoke first');           // scratch's
  // scratch cannot receive what scratch said, so the gesture has nothing to do — and must not
  // quietly move the target somewhere else on the way to doing nothing.
  await page.locator('#convViewThread .conv-msg', {hasText: 'the other pane spoke first'}).dblclick();
  await expect(litWho(page)).toHaveText(/amp/);
});

test('the pane\'s own thread is not addressed by a double tap', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  // The pane view's composer types into the pane on screen: there is no target to change, and the
  // gesture belongs to the window that has one.
  await page.locator('#convThread .conv-msg').first().dblclick();
  await expect(page.locator('#toast')).toBeHidden();
  // The dock is the conversation window's and does not follow a thread into a pane.
  await expect(page.locator('#convDock')).toBeHidden();
});

test('the block follows the caret however it was moved', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await openWindow(page);
  const input = page.locator('#convInput');
  await input.click();
  await input.pressSequentially('ship it when the tests are green');
  // Read in one synchronous go rather than through the locator: the ghost is rebuilt on every
  // caret move, so a handle resolved in one call can be detached by the next.
  const at = () => page.evaluate(() =>
    document.querySelector('#convGhost .cur').getBoundingClientRect().x);
  const end = await at();
  // A held arrow repeats without ever firing keyup, which is what used to leave the block sitting
  // where the caret started. Nothing is released here until every repeat has been delivered.
  await page.keyboard.down('ArrowLeft');
  await expect.poll(at).toBeLessThan(end);
  const mid = await at();
  await page.keyboard.up('ArrowLeft');
  // A selection dragged with the mouse moves it too, with no key involved at all.
  await page.evaluate(() => {
    const i = document.getElementById('convInput');
    i.setSelectionRange(0, 4);
    i.dispatchEvent(new Event('select', {bubbles: true}));
    document.dispatchEvent(new Event('selectionchange'));
  });
  await expect.poll(at).toBeLessThan(mid);
});

test('the composer\'s own send carries the picked message too', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await tapWire(page);
  await openWindow(page);
  await pickBubble(page, 'the other pane spoke first');
  await page.locator('#convInput').fill('and this is why');
  // Two sends in one bubble that did different things would be a way to lose the quote by tapping
  // the nearer button. There is one message being written, so both send it.
  await page.locator('#convSendBtn').click();
  const body = await sentBody(page);
  expect(body).toContain('the other pane spoke first');
  expect(body.endsWith('and this is why')).toBe(true);
});

test('a chip writes its instruction into the box, and the toggle changes that',
  async ({page}) => {
    await open(page);
    await joinBoth(page);
    await read(page);
    await tapWire(page);
    await openWindow(page);
    // The default: what the agent will receive is on screen, editable, before anything is sent.
    await page.locator(`#xferRow .xfer-chip:text-matches("^@review")`).click();
    await expect(page.locator('#convInput')).toHaveValue(/^Review, edit, fix/);
    // Written at the caret, so a chip tapped mid-sentence adds to what was being typed.
    await page.locator('#convInput').fill('here is the branch: ');
    await page.evaluate(() => {
      const i = document.getElementById('convInput');
      i.setSelectionRange(i.value.length, i.value.length);
    });
    await page.locator(`#xferRow .xfer-chip:text-matches("^@test")`).click();
    await expect(page.locator('#convInput')).toHaveValue(/^here is the branch: Write the tests/);
    // Nothing is lit, because the instruction is not waiting anywhere — it is in the box.
    await expect(page.locator('#xferRow .xfer-chip[aria-pressed=true]')).toHaveCount(1);  // the toggle
    await page.locator('#convInput').fill('just this');
    await compose(page, 'just this');
    expect(await sentBody(page)).toBe('just this');
    // Turned off, a chip goes back to riding the send instead.
    await attachMode(page);
    await page.locator(`#xferRow .xfer-chip:text-matches("^@review")`).click();
    await expect(page.locator('#convInput')).toHaveValue('');
    await compose(page, 'and now this');
    expect(await sentBody(page)).toContain('Review, edit, fix; then propose next steps.\n\nand now this');
  });

test('several members working at once each say so on their own newest bubble', async ({page}) => {
  await open(page);
  await joinBoth(page);
  await read(page);
  await forceStatus(page, 'scratch', 'working');
  await forceStatus(page, AGENT, 'working');
  await openWindow(page);
  // A multi-agent panel: two panes working at the same time is the ordinary case here, not a
  // conflict to resolve into one badge.
  await expect(page.locator('#convViewThread .conv-badge.working')).toHaveCount(2);
  // On the newest bubble of each member, not on every bubble they wrote.
  const last = page.locator('#convViewThread .conv-msg').last();
  await expect(last.locator('.conv-badge.working')).toHaveCount(1);
});

test('Resend moves the last pane message into the composer without sending', async ({page}) => {
  await open(page);
  // Nothing sent yet, so nothing to repeat.
  await expect(page.locator('#resendBtn')).toBeHidden();
  await page.evaluate(() => {
    document.getElementById('termInput').value = 'run the tests';
    sendText();
  });
  const resend = page.locator('#resendBtn');
  await tapWire(page);
  await page.setViewportSize({width: 390, height: 844});
  await page.locator('#fireBtn').click();
  await expect(resend).toBeVisible();
  // One tap: this fills a box you can still edit or empty, so there is nothing for an arm to
  // protect — unlike the CLS and QUIT it sits beside, which cannot be taken back.
  await resend.click();
  // Pane mode gates the repeat through the ordinary composer: edit it or Send it yourself.
  await expect(page.locator('#termInput')).toHaveValue('run the tests');
  await expect(page.locator('#termInput')).toBeFocused();
  expect(await page.evaluate(() => window.__sent.length)).toBe(0);
  await page.locator('#termInput').press('Control+Enter');
  const body = await page.evaluate(() => window.__sent.filter(m => m.type === 'send_text')
    .map(m => m.text).join(''));
  expect(body).toBe('run the tests');
});

test('Resend is per pane, not one clipboard for all of them', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    document.getElementById('termInput').value = 'only this pane';
    sendText();
  });
  await page.evaluate(() => openTerminal(agents.find(a => a.label === 'scratch').pane_id));
  await expect(page.locator('#resendBtn')).toBeHidden();
});
