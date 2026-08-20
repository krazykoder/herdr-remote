// The two controls that hang over a thread, in the three places a conversation is read: the pane
// as rows, the pane as a thread, and the conversation window.
//
// Only a browser can answer either question these ask. "Is the reader at the end" is a scroll
// position in a real scroll box, and the window's own box is the view rather than the thread
// inside it — a distinction that exists only once there is layout. And the refresh is two actions
// bolted together, one of which writes to IndexedDB.
//
//   npx playwright test hang_controls
const {test, expect} = require('./fixtures');

const AGENT = 'Architect 1';

// Long enough to overflow a 900px viewport several times over, and shaped like a pane so the
// thread built from it has messages in it.
const LONG = (() => {
  const out = [];
  for (let i = 1; i <= 40; i++) {
    out.push(`❯ question ${i}`, '', `⏺ Answer number ${i}.`, '');
  }
  return out.concat(['❯']).join('\n');
})();

const open = async page => {
  await page.goto('/');
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
};

const join = page => page.evaluate(() => {
  const key = convMemberKey(paneOf(activePane));
  saveConvIndex([{
    id: 'c1', name: 'new authentication feature', created: Date.now(),
    members: [{key: key, added: Date.now(), label: 'Architect 1'}],
  }]);
  return key;
});

// One read, recorded, and left where a read leaves the reader: the pane_content handler scrolls to
// the end after it draws, and "am I at the end" is the whole question these controls ask.
const read = (page, text = LONG) => page.evaluate(async text => {
  paneOf(activePane).status = 'done';
  setPaneText(text);
  scrollPaneToBottom();
  await recordPane(activePane, paneRows);
}, text);

// Scroll a box to its top and let the listener run. Playwright's own wheel needs a hover target
// and a real pointer; the control reads scrollTop, and so does the event it listens for.
const toTop = (page, id) => page.evaluate(id => {
  const el = id === 'convView' ? (document.getElementById('convViewThread') || document.getElementById(id)) : document.getElementById(id);
  el.scrollTop = 0;
  el.dispatchEvent(new Event('scroll'));
}, id);

test('the rows tell the reader they are not at the end, and put them back', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await expect(page.locator('#paneLast')).toBeHidden();
  await toTop(page, 'termContent');
  await expect(page.locator('#paneLast')).toBeVisible();
  await page.locator('#paneLast').click();
  await expect(page.locator('#paneLast')).toBeHidden();
  // Back at the end, not merely somewhere lower down.
  expect(await page.evaluate(() => {
    const el = document.getElementById('termContent');
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  })).toBeLessThan(60);
});

test('the same button follows the pane into its thread', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('#quickActions .qa-conv').click();
  await expect(page.locator('#convThread .conv-msg').first()).toBeVisible();
  await expect(page.locator('#paneLast')).toBeHidden();
  // The rows are still scrolled up underneath — the button must be reading the box on screen.
  await toTop(page, 'termContent');
  await expect(page.locator('#paneLast')).toBeHidden();
  await toTop(page, 'convThread');
  await expect(page.locator('#paneLast')).toBeVisible();
  await page.locator('#paneLast').click();
  await expect(page.locator('#paneLast')).toBeHidden();
});

test('the conversation window scrolls as a whole, and its button knows that', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();
  await expect(page.locator('#convViewThread .conv-msg').first()).toBeVisible();
  await expect(page.locator('#convLast')).toBeHidden();
  // The thread does not scroll; the view around it does.
  await toTop(page, 'convView');
  await expect(page.locator('#convLast')).toBeVisible();
  await page.locator('#convLast').click();
  await expect(page.locator('#convLast')).toBeHidden();
});

// One column, two corners. The jump sits at the bottom and the refresh at the top, and a button a
// couple of dozen pixels off the one above it reads as a button that missed rather than as a pair.
const rightEdge = (page, id) => page.locator(id).evaluate(el =>
  Math.round(el.getBoundingClientRect().right));

// Polled rather than measured once. Both of these views keep loading after the button appears —
// the record answers, the thread redraws, a scrollbar comes and goes — and each of those moves the
// right edge by a pixel or two for one frame. A single measurement catches whichever frame it
// landed in, which is a test that fails on a busy machine and passes on a quiet one; the assertion
// is still exact equality, it just waits for the layout to stop moving first.
const edgesLineUp = (page, a, b) => expect.poll(async () =>
  (await rightEdge(page, a)) - (await rightEdge(page, b))).toBe(0);

test('the jump lines up under the row it belongs to, in both views', async ({page}) => {
  await open(page);
  await join(page);
  await read(page);
  await toTop(page, 'termContent');
  await expect(page.locator('#paneLast')).toBeVisible();
  // Against the row rather than against the refresh in it: the pane's row ends with the ↑↓ step
  // buttons, and it is the edge of the row the eye reads as the column.
  await edgesLineUp(page, '#paneLast', '#termWrap .hang-float');

  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();
  await toTop(page, 'convView');
  await expect(page.locator('#convLast')).toBeVisible();
  // The row here too, and for the same reason: it ends with the record toggle beside the refresh,
  // and the eye reads the column off the edge of the row rather than off whichever button it
  // happens to start with.
  await edgesLineUp(page, '#convLast', '#convView .hang-float');
});

test('the pane refresh reads again and tidies without asking', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  await page.evaluate(async k => {
    const stored = (await convGet([k]))[0];
    const last = stored.entries[stored.entries.length - 1];
    stored.entries.push(Object.assign({}, last, {at: last.at + 1, seen: last.at + 1}));
    convHeld.delete(k);
    await convPut(stored);
  }, key);
  const before = await page.evaluate(async k => (await convGet([k]))[0].entries.length, key);
  await expect(page.locator('#paneTidy')).toBeVisible();
  await page.locator('#paneTidy').click();
  // No dialog stands between the reader and this, and the duplicate is gone.
  await expect(page.locator('#toast')).toContainText('Removed 1 duplicate message');
  await expect.poll(() => page.evaluate(async k => (await convGet([k]))[0].entries.length, key))
    .toBe(before - 1);
});

test('the window refresh tidies every member and draws the thread again', async ({page}) => {
  await open(page);
  const key = await join(page);
  await read(page);
  await page.locator('.term-header .back').click();
  await page.locator('#conversations .conversation-card').click();
  await expect(page.locator('#convViewThread .conv-msg').first()).toBeVisible();
  const before = await page.locator('#convViewThread .conv-msg').count();
  await page.evaluate(async k => {
    const stored = (await convGet([k]))[0];
    const last = stored.entries[stored.entries.length - 1];
    stored.entries.push(Object.assign({}, last, {at: last.at + 1, seen: last.at + 1}));
    convHeld.delete(k);
    await convPut(stored);
  }, key);
  await expect(page.locator('#convTidy')).toBeVisible();
  await page.locator('#convTidy').click();
  await expect(page.locator('#toast')).toContainText('Removed 1 duplicate message');
  // Redrawn from the record rather than diffed against what was already on screen: the copy that
  // went is off the thread too.
  await expect(page.locator('#convViewThread .conv-msg')).toHaveCount(before);
});
