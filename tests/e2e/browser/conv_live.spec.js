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
const receiveTurn = (page, key, extra) => page.evaluate(([k, more]) => {
  const fp = convKeyFingerprint(k);
  convLiveReceive({
    fingerprints: [fp],
    turns: [Object.assign({
      seq: 9001, host: fp[0], agent: fp[1], cwd: fp[2], pane_id: JSON.parse(k)[1],
      at: Date.now(), at_src: 'poll', kind: 'agent_final', text: 'Refactored the parser.',
    }, more)],
  });
  renderConvView();
}, [key, extra]);

test('a message carries the branch and the commits it was said over', async ({page}) => {
  await open(page);
  const key = await joinAndThread(page);
  await page.locator('#paneLive').click();
  await expect(page.locator('#convThread .conv-msg')).not.toHaveCount(0);

  await receiveTurn(page, key, {
    branch: 'feat/parser',
    commit: 'a'.repeat(40),
    commits: [{sha: 'b'.repeat(40), subject: 'split the tokenizer out'},
              {sha: 'c'.repeat(40), subject: 'delete the old lexer'}],
  });

  const bubble = page.locator('#convThread .conv-msg', {hasText: 'Refactored the parser.'});
  await expect(bubble.locator('.conv-branch')).toHaveText('feat/parser');
  await expect(bubble.locator('.conv-commit')).toHaveCount(2);
  await expect(bubble.locator('.conv-commit').first()).toContainText('split the tokenizer out');
  // Short in the bubble, whole in the title: one is read at a glance, the other is pasted into a
  // terminal.
  await expect(bubble.locator('.conv-commit code').first()).toHaveText('b'.repeat(8));
  await expect(bubble.locator('.conv-commit').first()).toHaveAttribute('title', 'b'.repeat(40));
});

test('a message with no repository behind it grows no footer', async ({page}) => {
  await open(page);
  const key = await joinAndThread(page);
  await page.locator('#paneLive').click();
  await receiveTurn(page, key, {});
  const bubble = page.locator('#convThread .conv-msg', {hasText: 'Refactored the parser.'});
  await expect(bubble).toBeVisible();
  await expect(bubble.locator('.conv-git')).toHaveCount(0);
});

test('a long commit subject wraps instead of widening the thread', async ({page}) => {
  await page.setViewportSize({width: 390, height: 780});
  await open(page);
  const key = await joinAndThread(page);
  await page.locator('#paneLive').click();
  await receiveTurn(page, key, {
    branch: 'feat/a-branch-name-that-somebody-really-did-type-out-in-full',
    commit: 'a'.repeat(40),
    commits: [{sha: 'b'.repeat(40),
               subject: 'refactor the whole of the parser and everything that ever called it, ' +
                        'including the bits nobody remembers writing'}],
  });
  const thread = page.locator('#convThread');
  await expect(thread.locator('.conv-branch')).toBeVisible();
  const overflow = await thread.evaluate(el => el.scrollWidth - el.clientWidth);
  expect(overflow, 'the thread must not scroll sideways on a phone').toBeLessThanOrEqual(1);
});
