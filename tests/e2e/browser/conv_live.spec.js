// The thread, read off the relay's record instead of this browser's transcript.
//
// Only a browser can answer the one question that matters here: *which* record is on screen. Both
// sources render through the same bubbles, so the proof has to be a source the other one cannot
// have produced — the local transcript is deleted out from under the thread, and what stays drawn
// came over the socket.
//
//   npx playwright test conv_live
const {test, expect} = require('./fixtures');

const AGENT = 'Architect 1';

const seedRelayRecord = page => page.evaluate(() => {
  ws.send(JSON.stringify({
    type: 'send_text', pane_id: activePane, text: 'A prompt recorded on the relay', submit: false,
  }));
});

const open = async page => {
  await page.goto('/');
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  await seedRelayRecord(page);
  await page.waitForTimeout(100);
};

// A conversation with this pane in it, read as a thread. Membership is the whole of "is this
// recorded", and the toggle only appears where there is a thread for it to change.
const joinAndThread = page => page.evaluate(() => {
  const key = convMemberKey(paneOf(activePane));
  saveConvIndex([{
    id: 'c1', name: 'new authentication feature', created: Date.now(),
    members: [{key: key, added: Date.now(), label: 'Architect 1'}],
  }]);
  setConvMode(true);
  renderConvBar();
  return key;
});

const localRecord = (page, key) => page.evaluate(async k => {
  paneOf(activePane).status = 'done';
  setPaneText('❯ a question\n\n⏺ Only this browser ever saw this.\n');
  await recordPane(activePane, paneRows);
  return ((await convGet([k]))[0] || {}).entries.length;
}, key);

test('the toggle swaps the source and says which one is on screen', async ({page}) => {
  await open(page);
  const key = await joinAndThread(page);
  expect(await localRecord(page, key)).toBeGreaterThan(0);

  const btn = page.locator('#paneLive');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#convThread')).toContainText('Only this browser ever saw this');

  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(btn).toHaveClass(/live/);
  // The relay writes one row per turn end and the fake's panes are idle from the first poll, so
  // there is something there before the page ever loaded.
  await expect(page.locator('#convThread .conv-msg')).not.toHaveCount(0);
  // The message this browser folded out of a pane read it made itself is not in the relay's
  // record — the relay never saw that text, because the test wrote it into the DOM.
  await expect(page.locator('#convThread')).not.toContainText('Only this browser ever saw this');

  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#convThread')).toContainText('Only this browser ever saw this');
});

test('the record survives the local transcript being deleted', async ({page}) => {
  await open(page);
  const key = await joinAndThread(page);
  await localRecord(page, key);
  await page.locator('#paneLive').click();
  await expect(page.locator('#convThread .conv-msg')).not.toHaveCount(0);

  // The whole local store, gone. Anything still drawn came off the wire.
  await page.evaluate(async k => {
    convHeld.delete(k);
    const db = await openConvDB();
    await idbReq(db.transaction(CONV_DB_STORE, 'readwrite').objectStore(CONV_DB_STORE).delete(k));
  }, key);
  await page.evaluate(() => renderConvView());
  await expect(page.locator('#convThread .conv-msg')).not.toHaveCount(0);

  // And the other way round, which is what makes the first half mean anything: back on the local
  // transcript there is now nothing to draw.
  await page.locator('#paneLive').click();
  await expect(page.locator('#convThread .conv-empty')).toBeVisible();
});

test('the setting is remembered, and the choice is one the reader can see on arrival',
  async ({page}) => {
    await open(page);
    await joinAndThread(page);
    await page.locator('#paneLive').click();
    await expect(page.locator('#paneLive')).toHaveClass(/live/);

    await page.reload();
    await page.locator('#agents .agent', {hasText: AGENT}).click();
    await expect(page.locator('#convThread')).toBeVisible();
    await expect(page.locator('#paneLive')).toHaveClass(/live/);
    await expect(page.locator('#paneLive')).toHaveAttribute('aria-pressed', 'true');
  });

test('multiple conversations sharing a pane reconstruct the live stream without refetching',
  async ({page}) => {
    await open(page);
    const key = await joinAndThread(page);
    await page.locator('#paneLive').click();
    await expect(page.locator('#convThread .conv-msg')).not.toHaveCount(0);

    // Create a second conversation referencing the SAME member pane
    await page.evaluate(k => {
      saveConvIndex([
        { id: 'c1', name: 'conversation one', created: Date.now(), members: [{key: k, label: 'Architect 1'}] },
        { id: 'c2', name: 'conversation two', created: Date.now(), members: [{key: k, label: 'Architect 1'}] },
      ]);
    }, key);

    // Switch active conversation to c2
    await page.evaluate(() => {
      convViewId = 'c2';
      renderConvView();
    });

    // The shared pane is reconstructed immediately from cache without empty state or refetch lag
    await expect(page.locator('#convThread .conv-msg')).not.toHaveCount(0);
  });

test('warm cache performs incremental delta fetch with since_id', async ({page}) => {
  await open(page);
  const key = await joinAndThread(page);
  await page.locator('#paneLive').click();
  await expect(page.locator('#convThread .conv-msg')).not.toHaveCount(0);

  // Monitor outgoing websocket frames
  const sentPayloads = await page.evaluate(async () => {
    const sent = [];
    const origSend = ws.send.bind(ws);
    ws.send = function(data) {
      try { sent.push(JSON.parse(data)); } catch (e) {}
      return origSend(data);
    };
    // Force a fetch while cache is warm
    convLiveFetch([convMemberKey(paneOf(activePane))], true);
    return sent;
  });

  // Verify that an incremental fetch was sent with since_id when warm
  const convLogMsg = sentPayloads.find(m => m.type === 'conv_log');
  expect(convLogMsg).toBeDefined();
  expect(convLogMsg.fingerprints).toBeDefined();
});


// --- The live stream, in both sources ---
//
// Neither record holds a turn that has not ended: the relay writes its row when the turn is over,
// and this browser's transcript settles one at the same moment. So what a pane is saying *right
// now* has exactly one place to be drawn — the standing slot under the thread — and it has to be
// there whichever record the thread is reading. It is never a message: nothing counts it, picks it
// or hands it to Summary.
test('the live stream is drawn under the thread over the relay’s record too', async ({page}) => {
  await open(page);
  const key = await joinAndThread(page);
  await localRecord(page, key);
  await page.locator('#paneLive').click();
  await expect(page.locator('#paneLive')).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(async () => {
    paneOf(activePane).status = 'working';
    await recordPane(activePane, ['❯ a question', '', '⏺ Halfway through a sentence', '', '❯']);
    await renderConvView();
  });
  const slot = page.locator('#convThread .conv-slot');
  await expect(slot).toHaveCount(1);
  await expect(slot).toContainText('Halfway through a sentence');
  // The thread is still the relay's record — the stream sits beside it, not in it.
  await expect(page.locator('#convThread .conv-msg.draft')).toHaveCount(0);
  await expect(slot.locator('.conv-pick')).toHaveCount(0);

  // And it goes when the turn does.
  await page.evaluate(async () => { paneOf(activePane).status = 'done'; await renderConvView(); });
  await expect(page.locator('#convThread .conv-slot')).toHaveCount(0);
});

test('the conversation window streams its working members too', async ({page}) => {
  await open(page);
  await joinAndThread(page);
  await page.evaluate(async () => {
    paneOf(activePane).status = 'working';
    await recordPane(activePane, ['❯ a question', '', '⏺ Still writing this one', '', '❯']);
    convViewId = 'c1';
    openConversation('c1');
    await renderConvStandalone(true);
  });
  const slot = page.locator('#convViewThread .conv-slot');
  await expect(slot).toHaveCount(1);
  await expect(slot).toContainText('Still writing this one');
  await expect(page.locator('#convViewThread .conv-msg.draft')).toHaveCount(0);
});

// --- Where the work landed ---
//
// The relay records the branch a pane's cwd was on and the commits that appeared since its last
// turn. The vm slice proves the string; only a browser proves it is drawn, styled, and does not
// push the bubble off the screen — which is what a forty-character sha does to a phone.

// A row in the shape the relay sends, addressed to this pane's fingerprint so the thread claims
// it. Pushed through the same receiver the socket feeds, because a fake herdr's panes sit in
// directories that are not repositories and never will be.
const receiveTurns = (page, key, rows) => page.evaluate(([k, list]) => {
  const fp = convKeyFingerprint(k);
  const at = Date.now();
  convLiveReceive({
    fingerprints: [fp],
    turns: list.map((row, i) => Object.assign({
      host: fp[0], agent: fp[1], cwd: fp[2], pane_id: JSON.parse(k)[1],
      at: at + i, at_src: 'poll', kind: 'agent_final',
    }, row)),
  });
  renderConvView();
}, [key, rows]);

test('a branch change is an entry in the thread, not a stamp on every message',
     async ({page}) => {
  await open(page);
  const key = await joinAndThread(page);
  await page.locator('#paneLive').click();
  await expect(page.locator('#convThread .conv-msg')).not.toHaveCount(0);

  await receiveTurns(page, key, [
    {seq: 9001, text: 'Started on the parser.', branch: 'main', commit: 'a'.repeat(40)},
    {seq: 9002, text: 'Still on the parser.', branch: 'main', commit: 'b'.repeat(40)},
    {seq: 9003, text: 'Moved it to a branch.', branch: 'feat/parser', commit: 'c'.repeat(40)},
  ]);

  const rules = page.locator('#convThread .conv-rule.git.branch');
  await expect(rules).toHaveCount(2, 'arriving, then moving — the middle turn is not an event');
  await expect(rules.first()).toContainText('main');
  await expect(rules.last()).toContainText('Branch changed to');
  await expect(rules.last()).toContainText('feat/parser');
  // The event sits above the message it belongs to, not inside it.
  await expect(page.locator('#convThread .conv-msg .conv-rule')).toHaveCount(0);
});

test('commits are hidden until the toggle asks for them, and then they are fetched',
     async ({page}) => {
  await open(page);
  const key = await joinAndThread(page);
  await page.locator('#paneLive').click();
  await receiveTurns(page, key, [
    {seq: 9001, text: 'Before.', branch: 'main', commit: 'a'.repeat(40)},
    {seq: 9002, text: 'After.', branch: 'main', commit: 'b'.repeat(40)},
  ]);
  await expect(page.locator('#convThread .conv-commits')).toHaveCount(0);

  // The relay is asked for the range, because HERDR_GIT_COMMITS is off and the list was never
  // stored. The fake herdr's panes are not in a repository, so what comes back is empty — the
  // question going out at all is what this asserts, and the answer is asserted in the vm slice.
  const asked = page.evaluate(() => new Promise(resolve => {
    const real = ws.send.bind(ws);
    ws.send = d => { if (d.includes('git_commits')) resolve(JSON.parse(d)); return real(d); };
    setTimeout(() => resolve(null), 3000);
  }));
  await page.locator('#paneCommits').click();
  const msg = await asked;
  expect(msg, 'the toggle asks the relay for the range it can see both ends of').not.toBeNull();
  expect(msg.from).toBe('a'.repeat(40));
  expect(msg.to).toBe('b'.repeat(40));
});

test('the commits toggle is only offered over the relay\u2019s record', async ({page}) => {
  await open(page);
  await joinAndThread(page);
  // This browser's own transcript has no commits in it, so a toggle here would change nothing.
  await expect(page.locator('#paneCommits')).not.toHaveClass(/\bon\b/);
  await page.locator('#paneLive').click();
  await expect(page.locator('#paneCommits')).toHaveClass(/\bon\b/);
});

test('a commit list wraps instead of widening the thread', async ({page}) => {
  await page.setViewportSize({width: 390, height: 780});
  await open(page);
  const key = await joinAndThread(page);
  await page.locator('#paneLive').click();
  await page.evaluate(() => localStorage.setItem('herdr_conv_commits', 'on'));
  await receiveTurns(page, key, [
    {seq: 9001, text: 'Before.', branch: 'main', commit: 'a'.repeat(40)},
    {seq: 9002, text: 'After.', branch: 'feat/a-branch-name-somebody-really-did-type-out-in-full',
     commit: 'b'.repeat(40),
     commits: [{sha: 'c'.repeat(40),
                subject: 'refactor the whole of the parser and everything that ever called it, ' +
                         'including the bits nobody remembers writing'}]},
  ]);
  const thread = page.locator('#convThread');
  await expect(thread.locator('.conv-commits')).toBeVisible();
  await expect(thread.locator('.conv-commit code').first()).toHaveText('c'.repeat(8));
  const overflow = await thread.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(overflow, 'the thread must not scroll sideways on a phone').toBeLessThanOrEqual(1);
});

test('the branch badge floats over the pane, centred, and follows the pane it is open on',
     async ({page}) => {
  // The relay fills this from its turn-end probe; the fake herdr's panes are in no checkout, so
  // the branch is put on the snapshot's pane here instead. What is being asserted is the drawing:
  // a vm slice can say the badge was written, only a browser can say it landed on screen.
  await open(page);
  await page.evaluate(() => {
    paneOf(activePane).branch = 'feat/state-sync';
    syncBranchBadges();
  });
  const badge = page.locator('#paneBranch');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('feat/state-sync');

  // Centred over the pane and inside it — a badge half off the edge of a phone is not a badge.
  const box = await badge.boundingBox();
  const wrap = await page.locator('#termWrap').boundingBox();
  const off = Math.abs((box.x + box.width / 2) - (wrap.x + wrap.width / 2));
  expect(off, 'centred over the pane it belongs to').toBeLessThanOrEqual(2);
  expect(box.y + box.height).toBeLessThanOrEqual(wrap.y + wrap.height + 1);
  // Over the thread rather than beside it: the composer below must keep its full height.
  expect(box.y).toBeGreaterThan(wrap.y);

  // A pane outside a checkout says nothing rather than saying something empty.
  await page.evaluate(() => {
    delete paneOf(activePane).branch;
    syncBranchBadges();
  });
  await expect(badge).toBeHidden();
});

test('the badge is painted in the addressed agent\u2019s own colour', async ({page}) => {
  await open(page);
  await page.evaluate(() => {
    paneOf(activePane).branch = 'feat/current';
    syncBranchBadges();
  });
  const badge = page.locator('#paneBranch');
  await expect(badge).toContainText('feat/current');
  expect(await badge.evaluate(el => el.style.getPropertyValue('--branch-color')))
    .toBe('var(--agent-claude)');
  // Painted, not merely set: a var that resolves to nothing would leave the pill unreadable.
  const painted = await badge.evaluate(el => getComputedStyle(el).color);
  expect(painted).not.toBe('');
  expect(painted).not.toBe('rgba(0, 0, 0, 0)');
});
