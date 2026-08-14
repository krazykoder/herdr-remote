// Preselecting the agent's closing message, in a real browser.
//
// The vm slice in tests/test_summary_detect.js covers which lines the parse picks. What it cannot
// see is the wiring: that a pane read is what runs it, that only a finished pane gets a
// suggestion, that the band and the footer actually paint, and above all that a range the user is
// holding — or one they deliberately cleared — is never overwritten by the 3s poll.
//
// The pane text is the same checked-in read of a live Claude pane the vm slice asserts against.
//
//   npx playwright test
const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const AGENT = 'Architect 1';   // the fake herdr reports this one as a claude pane
const PANE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'fixtures', 'pane_claude_done.txt'), 'utf8');

// The relay's fake herdr always reports this pane idle, and the closing message only matters once
// the agent has finished. Setting the status here is the same merge an agent_update performs.
const feed = (page, text, status = 'done') => page.evaluate(([text, status]) => {
  const a = paneOf(activePane);
  a.status = status;
  setPaneText(text);
}, [text, status]);

const sel = page => page.evaluate(() => (selA === null ? null : [selA, selB]));

test.beforeEach(async ({page}) => {
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.__errors = errors;
  await page.goto('/');
  await page.locator('#agents .agent', {hasText: AGENT}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
});

test.afterEach(async ({page}) => {
  expect(page.__errors, 'the page logged errors').toEqual([]);
});

test('a finished pane opens with its closing message selected and named', async ({page}) => {
  await feed(page, PANE);
  await expect(page.locator('#selBand')).toBeVisible();
  await expect(page.locator('#selCount')).toHaveText(/· final message$/);
  const text = await page.evaluate(() => selText);
  expect(text.split('\n')[0]).toMatch(/^⏺ Ready\. Name the change\./);
  expect(text).not.toMatch(/⎿/);       // no tool results
  expect(text).not.toMatch(/✻ Baked/); // no turn footer
});

test('a pane still working is left alone', async ({page}) => {
  await feed(page, PANE, 'working');
  expect(await sel(page)).toBeNull();
  await expect(page.locator('#selBand')).toBeHidden();
});

test('a range the user is holding survives the next read', async ({page}) => {
  await feed(page, PANE);
  await page.evaluate(() => { clearSel(); selA = 2; selB = 4; drawSel(); });
  await feed(page, PANE);          // the same text again, exactly what the 3s poll re-delivers
  expect(await sel(page)).toEqual([2, 4]);
  await expect(page.locator('#selCount')).not.toHaveText(/final message/);
});

test('a read that destroys the range does not replace it with a guess', async ({page}) => {
  await page.evaluate(() => { selA = 2; selB = 4; drawSel(); });
  await feed(page, PANE);          // wholly different text, so the range cannot be re-anchored
  expect(await sel(page)).toBeNull();
});

test('a suggestion the user cleared does not come back on the poll', async ({page}) => {
  await feed(page, PANE);
  expect(await sel(page)).not.toBeNull();
  await page.evaluate(() => clearSel());
  await feed(page, PANE);          // identical text, exactly what the 3s poll re-delivers
  expect(await sel(page)).toBeNull();
});

test('Summary is offered only on a pane that has one, and selects it', async ({page}) => {
  const btn = page.locator('#quickActions .qa-summary');
  await feed(page, '⏺ Bash(x)\n  ⎿  y\n', 'working');   // last block ran a tool
  await expect(btn).toHaveCount(0);

  await feed(page, PANE, 'working');   // no status gate on the button, unlike the suggestion
  await expect(btn).toBeVisible();
  expect(await sel(page)).toBeNull();
  await btn.click();
  await expect(page.locator('#selBand')).toBeVisible();
  expect(await page.evaluate(() => selText)).toMatch(/^⏺ Ready\. Name the change\./);
});

test('Summary scrolls to the message it selected', async ({page}) => {
  // The message is only near the foot on a short pane. Push it up behind 300 lines of tool
  // output and selecting it without scrolling leaves the user looking at nothing.
  const filler = '⏺ Bash(x)\n' + '  ⎿  y\n'.repeat(300);
  await feed(page, filler + PANE, 'working');
  const term = page.locator('#termContent');
  await term.evaluate(el => { el.scrollTop = el.scrollHeight; });

  await page.locator('#quickActions .qa-summary').click();

  const seen = await page.evaluate(() => {
    const el = document.getElementById('termContent');
    const row = el.children[Math.min(selA, selB)].getBoundingClientRect();
    const box = el.getBoundingClientRect();
    return row.top >= box.top && row.bottom <= box.bottom;
  });
  expect(seen, 'the selected line is on screen').toBe(true);
});

test('an auto-selected band reads orange, and a dragged one does not', async ({page}) => {
  await feed(page, PANE);
  const band = page.locator('#selBand');
  await expect(band).toHaveClass(/auto/);
  const auto = await band.evaluate(el => getComputedStyle(el).borderTopColor);

  // A finger on the bottom handle: it is the user's range now, whatever it started as.
  const h = await page.locator('#rulerBot').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + 40, {steps: 4});
  await page.mouse.up();

  await expect(band).not.toHaveClass(/auto/);
  await expect(page.locator('#selCount')).not.toHaveText(/final message/);
  expect(await band.evaluate(el => getComputedStyle(el).borderTopColor)).not.toBe(auto);
});

test('the Claude user turn is coloured and ruled, and nothing is filled', async ({page}) => {
  await feed(page, '❯ allow the test commands\n  confirmation\n\n⏺ Done.\n', 'working');
  const row = page.locator('#termContent .term-line.user-prompt');
  // The gutter line and its continuation. The blank line before the agent answers is the gap
  // between turns, not part of one, so the rule stops at the last line with text on it.
  await expect(row).toHaveCount(2);
  await expect(row.first()).toHaveText('❯ allow the test commands');
  await expect(row.last()).toHaveText('  confirmation');
  await expect(page.locator('#termContent .term-line', {hasText: '⏺ Done.'})).not.toHaveClass(/user-prompt/);

  // Colour and a rule left of the text. A fill behind monospace is what this must not become.
  const seen = await row.first().evaluate(el => {
    const cs = getComputedStyle(el);
    const plain = getComputedStyle(el.parentElement.querySelector('.term-line:not(.user-prompt)'));
    return {
      colour: cs.color, plainColour: plain.color,
      fill: cs.backgroundColor, width: cs.borderLeftWidth,
      x: el.getBoundingClientRect().left,
      textX: el.parentElement.querySelector('.term-line:not(.user-prompt)').getBoundingClientRect().left,
    };
  });
  expect(seen.colour).not.toBe(seen.plainColour);
  expect(seen.fill).toBe('rgba(0, 0, 0, 0)');
  expect(parseFloat(seen.width)).toBeGreaterThan(0);
  // The rule sits in the pane's padding, left of where the first character starts, so the glyph
  // it belongs to is never underneath it.
  expect(seen.x).toBeLessThan(seen.textX);
});

test('every turn back through the scrollback is marked, not only the newest', async ({page}) => {
  await feed(page, [
    '⏺ Older answer.', '  with a second line', '',
    '❯ next request',
    '⏺ Bash(git status)', '  ⎿  clean',
    '⏺ Newer answer.', '',
    '❯ ',
  ].join('\n'), 'working');
  const marked = page.locator('#termContent .summary-highlight');
  await expect(marked).toHaveCount(3);
  await expect(marked.nth(0)).toHaveText('⏺ Older answer.');
  await expect(marked.nth(1)).toHaveText('  with a second line');
  await expect(marked.nth(2)).toHaveText('⏺ Newer answer.');
  // The tool block between the two turns is output, not an answer.
  await expect(page.locator('#termContent .term-line', {hasText: '⎿'})).not.toHaveClass(/summary-highlight/);
});

test('highlight settings repaint the current pane and persist', async ({page}) => {
  await feed(page, '⏺ Complete summary.\n  Ready to transfer.\n❯ next request\n  with context\n', 'working');
  await expect(page.locator('#termContent .user-prompt')).toHaveCount(2);
  await expect(page.locator('#termContent .summary-highlight')).toHaveCount(2);

  await page.evaluate(() => {
    document.getElementById('userHighlight').click();
    document.getElementById('summaryHighlight').click();
  });
  await expect(page.locator('#termContent .user-prompt')).toHaveCount(0);
  await expect(page.locator('#termContent .summary-highlight')).toHaveCount(0);

  expect(await page.evaluate(() => localStorage.getItem('herdr_highlight_user'))).toBe('off');
  expect(await page.evaluate(() => localStorage.getItem('herdr_highlight_summary'))).toBe('off');

  await page.locator('#navSettings').click();
  await expect(page.locator('#userHighlight')).not.toBeChecked();
  await expect(page.locator('#summaryHighlight')).not.toBeChecked();
});

// Walking back through the conversation. Three blocks with a tool execution between them, which is
// the thing ↓↑ has to step over — the user is reading what the agent said, not what it ran.
const CHAT = [
  '⏺ First thing I said.', '', '⏺ Bash(git status)', '  ⎿  clean', '',
  '⏺ Second thing I said.', '  over two lines', '', '✻ Worked for 3s', '',
].join('\n');

test('the pill steps between messages and passes over tool blocks', async ({page}) => {
  await feed(page, CHAT, 'working');
  await expect(page.locator('#blockNav')).toBeVisible();
  const [next, prev] = ['↓', '↑'].map(g => page.locator('#blockNav button', {hasText: g}));

  await prev.click();                       // from the end of the pane: the last message
  expect(await sel(page)).toEqual([5, 6]);
  await expect(page.locator('#selCount')).toHaveText(/· final message$/);

  await prev.click();                       // and past the Bash block, not onto it
  expect(await sel(page)).toEqual([0, 0]);
  await expect(page.locator('#selBand')).toHaveClass(/auto/);
  await expect(page.locator('#selCount')).toHaveText(/· agent message$/);

  await next.click();
  expect(await sel(page)).toEqual([5, 6]);
});

// The fake herdr reports this one as `amp`, which the app ships no gutter profile for.
const UNKNOWN = 'amp';
const UNKNOWN_PANE = '◆ Ran the build\n  compiled\n\n◆ All finished.\n  and here is why\n';

const openUnknown = async page => {
  await page.locator('.term-header .back').click();
  await page.locator('#agents .agent', {hasText: UNKNOWN}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
};

test('the pill stays away from a harness the app has never seen', async ({page}) => {
  await openUnknown(page);
  await feed(page, UNKNOWN_PANE, 'working');
  await expect(page.locator('#blockNav')).toBeHidden();
  await expect(page.locator('#quickActions .qa-summary')).toHaveCount(0);
});

test('Learn teaches an unknown harness its marker, once confirmed', async ({page}) => {
  await openUnknown(page);
  // A dialog round-trip outlasts the poll, and a real read of the fake pane arriving mid-test
  // would replace the fed text — and with it the range, permanently, since nothing puts it back.
  // The reads are what this test does not exercise, so they are switched off; a read already in
  // flight when they were is dropped by its text, which is the fake herdr's rows of x.
  await page.evaluate(() => {
    refreshPane = () => {};
    const set = setPaneText;
    setPaneText = t => { if (!t.startsWith('x')) set(t); };
  });
  const select = async (a, b) => {
    await feed(page, UNKNOWN_PANE, 'working');
    await page.evaluate(([a, b]) => { selA = a; selB = b; drawSel(); }, [a, b]);
  };

  await select(3, 4);
  page.once('dialog', d => {
    expect(d.message()).toContain('◆');     // the character itself, which is the confirmation
    d.dismiss();
  });
  await page.locator('#selLearn').click();
  await expect(page.locator('#blockNav')).toBeHidden();   // declined, so nothing was stored

  await select(3, 4);
  page.once('dialog', d => d.accept());
  await page.locator('#selLearn').click();
  await expect(page.locator('#selLearn')).toHaveText('Learned ✓');
  await expect(page.locator('#blockNav')).toBeVisible();

  // Navigation, yes. A silent guess on the next read, no — without a result glyph it cannot tell
  // a command from a sentence.
  await feed(page, UNKNOWN_PANE, 'working');
  await page.evaluate(() => clearSel());
  await page.locator('#blockNav button', {hasText: '↑'}).click();
  expect(await sel(page)).toEqual([3, 4]);
  await page.evaluate(() => clearSel());
  await feed(page, UNKNOWN_PANE);              // a finished pane, and still no suggestion
  expect(await sel(page)).toBeNull();
});

test('Learn records the trim, and says what it recorded', async ({page}) => {
  await feed(page, CHAT, 'working');
  await page.evaluate(() => { selA = 6; selB = 6; drawSel(); });   // dropped the opening line
  await page.locator('#selLearn').click();
  await expect(page.locator('#selLearn')).toHaveText('Learned 1/0 ✓');

  await page.evaluate(() => clearSel());
  await page.locator('#blockNav button', {hasText: '↑'}).click();
  expect(await sel(page)).toEqual([6, 6], 'the next found range arrives already trimmed');
});

test('Learn asks the user to trim an untouched suggestion first', async ({page}) => {
  await feed(page, PANE);
  await page.locator('#selLearn').click();
  await expect(page.locator('#selLearn')).toHaveText('Trim it first');
});

test('switching panes drops the suggestion with the rest of the ruler', async ({page}) => {
  await feed(page, PANE);
  expect(await sel(page)).not.toBeNull();
  await page.locator('.term-header .back').click();
  await page.locator('#agents .agent', {hasText: 'scratch'}).click();
  await expect(page.locator('#termContent')).toContainText('done.');
  expect(await sel(page)).toBeNull();
  await expect(page.locator('#selBar')).toBeHidden();
  await expect(page.locator('#selBand')).toBeHidden();
});
