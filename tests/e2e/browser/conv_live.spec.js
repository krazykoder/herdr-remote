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

const open = async page => {
  await page.goto('/');
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
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
