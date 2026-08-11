// Which lines of a finished pane are the agent's closing message.
//
// The fixtures are minimal, sanitized excerpts from panes read off a live herdr on 2026-08-11.
// A pane is mostly tool output, so what the parse has to get right is the boundary between the
// last command the agent ran and the last thing it said. Keeping only that shape avoids checking
// unrelated terminal history into the repository.
//
// Runs the block straight out of web/index.html so the single-file app keeps its no-build-step
// property, the same trick tests/test_attention.js uses.
//
//   node --test tests/test_summary_detect.js

const {test, beforeEach} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const from = HTML.indexOf('    // --- Final message detection ---');
const to = HTML.indexOf('    // --- Line ruler ---', from);
assert.ok(from !== -1 && to > from, 'final message block not found in web/index.html');

// Everything the block reaches for and does not declare: the ruler's state, the pane it belongs
// to, and the store the trim is remembered in. The parse itself needs none of them.
const store = new Map();
const toasts = [];
let answer = true;                 // what the confirm dialog comes back with
const ctx = vm.createContext({
  console,
  activePane: null, paneOf: () => null, drawSel: () => {}, renderQuickActions: () => {},
  showToast: t => toasts.push(t), confirm: () => answer, scrollPaneToLine: () => {}, repaintHighlights: () => {},
  paneRows: [], selA: null, selB: null,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
});
vm.runInContext(HTML.slice(from, to), ctx);
const find = (rows, agent) => ctx.findFinalMessage(rows, agent);
// The block's own state is declared with let, which is a lexical binding rather than a property
// of the context object, so it is read back the same way the browser specs read it: by evaluating
// the name in the context it lives in.
const val = expr => vm.runInContext(expr, ctx);

// What the user has learned so far is per test, not per pane — switching panes must not forget it.
beforeEach(() => {
  store.clear();
  vm.runInContext('gutterCache = null', ctx);   // the memo outlives localStorage otherwise
  toasts.length = 0;
  answer = true;
  vm.runInContext('selSuggested = false', ctx);
});

// A pane the user is looking at, with a range on it: what learnFromSelection reads.
function open(rows, agent, a = null, b = null) {
  ctx.paneRows = rows;
  ctx.activePane = 'p1';
  ctx.paneOf = () => ({agent, status: 'done'});
  ctx.selA = a;
  ctx.selB = b;
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n');
}

test('Claude: the closing block, with no tool results inside it', () => {
  const rows = fixture('pane_claude_done.txt');
  const at = find(rows, 'claude');
  assert.ok(at, 'expected a range');
  const [a, b] = at;
  assert.match(rows[a], /^⏺ Ready\. Name the change\./);
  assert.match(rows[b], /Hooks, permission rules, env vars/);
  const picked = rows.slice(a, b + 1);
  assert.ok(!picked.some(l => l.trimStart().startsWith('⎿')), 'tool result leaked into the range');
  assert.ok(!picked.some(l => l.startsWith('✻')), 'turn footer leaked into the range');
});

test('Codex: three paragraphs, blank lines kept, footer left out', () => {
  const rows = fixture('pane_codex_done.txt');
  const at = find(rows, 'codex');
  assert.ok(at, 'expected a range');
  const [a, b] = at;
  assert.match(rows[a], /^• S2b review clean\./);
  assert.match(rows[b], /^  Next: S3\./);
  const picked = rows.slice(a, b + 1);
  assert.ok(picked.some(l => l === ''), 'the blank lines between paragraphs were dropped');
  assert.ok(!picked.some(l => l.startsWith('─')), 'turn footer leaked into the range');
});

// Both fixtures end in a prompt line, which is what a live pane always looks like: the composer
// is the last thing in it. The glyphs are the ones read off real panes on 2026-08-11 — `❯` for
// Claude, `›` for Codex — so a harness that changes either breaks a test rather than a user.
test('the composer at the foot of a real pane is a prompt line', () => {
  const claude = fixture('pane_claude_done.txt'), codex = fixture('pane_codex_done.txt');
  assert.equal(ctx.isUserInput(claude[11], 'claude'), true, claude[11]);
  assert.equal(ctx.isUserInput(codex[13], 'codex'), true, codex[13]);
  // And no line of tool output in either one is mistaken for one.
  assert.equal(claude.filter(r => ctx.isUserInput(r, 'claude')).length, 1);
  assert.equal(codex.filter(r => ctx.isUserInput(r, 'codex')).length, 1);
});

test('a pane whose last block ran a tool has nothing to offer', () => {
  const rows = [
    '⏺ Committed as dd51cea.',
    '',
    '⏺ Bash(git status --short)',
    '  ⎿  M web/index.html',
    '',
  ];
  assert.equal(find(rows, 'claude'), null);
  // Same shape in the other harness's gutter.
  assert.equal(find(['• Done.', '', '• Ran npm test', '  └ 19 passed'], 'codex'), null);
});

test('an unknown harness is never guessed at', () => {
  const rows = ['◆ All finished.', '  and here is why'];
  assert.equal(find(rows, 'pi'), null);
  assert.equal(find(rows, undefined), null);
  assert.equal(find(rows, 'claude'), null);   // right harness named, wrong glyphs present
});

test('a block runs to the next line with anything in column 0', () => {
  const rows = [
    '⏺ First message.',
    '⏺ Second message.',
    '  with a continuation',
    '',
    '  and a second paragraph',
    '',
    '✻ Worked for 3s',
    '',
    '❯ next prompt',
  ];
  assert.deepEqual(find(rows, 'claude'), [1, 4]);
});

test('the glyph line alone is a valid range', () => {
  assert.deepEqual(find(['⏺ Bash(x)', '  ⎿  y', '', '⏺ Done.'], 'claude'), [3, 3]);
});

test('the latest user prompt bounds the completed turn above it', () => {
  const rows = [
    '⏺ Older summary.', '', '❯ first request',
    '⏺ Previous summary.', '  ready to transfer.', '',
    '❯ please start the next task',
    '⏺ New work is underway.',
  ];
  assert.deepEqual(find(rows, 'claude'), [3, 4]);
});

test('empty and malformed input do not throw', () => {
  assert.equal(find([], 'claude'), null);
  assert.equal(find([''], 'claude'), null);
  assert.equal(find(null, 'claude'), null);
});

// --- what the user trims off it ---
//
// The block runs from the speaker glyph to the last line with anything on it. The trim is what
// the user takes off either end of that, learned from the transfers they actually send.

const BLOCK = ['⏺ Bash(x)', '  ⎿  y', '', '⏺ Here is what I did.', '', '  A change.', '', ''];
const scan = () => { ctx.scanFinalMessage(); return val('finalAt'); };

test('the range as parsed: whole block, no trailing blanks', () => {
  open(BLOCK, 'claude');
  assert.deepEqual(scan(), [3, 5]);
});

test('a transfer teaches the trim, and the next read arrives already trimmed', () => {
  open(BLOCK, 'claude', 5, 5);       // user kept only the last line of the message
  ctx.scanFinalMessage();
  ctx.learnFromSelection();
  open(BLOCK, 'claude');
  assert.deepEqual(scan(), [5, 5]);
});

test('an untouched suggestion teaches no 0/0 trim', () => {
  open(BLOCK, 'claude', 3, 5);
  vm.runInContext('selSuggested = true', ctx);
  assert.equal(ctx.learnFromSelection(), null);
  open(BLOCK, 'claude');
  assert.deepEqual(scan(), [3, 5]);
});

test('a trim that lands on a blank line keeps walking', () => {
  open(BLOCK, 'claude');
  ctx.noteTrim('claude', 1, 0);      // index 4, which is blank
  assert.deepEqual(scan(), [5, 5]);
});

test('the trim is per harness', () => {
  open(BLOCK, 'claude', 5, 5);
  ctx.scanFinalMessage();
  ctx.learnFromSelection();
  open(['• Said a thing.', '  and another'], 'codex');
  assert.deepEqual(scan(), [0, 1], "claude's trim left codex alone");
});

test('a selection outside the block teaches nothing', () => {
  open(BLOCK, 'claude', 0, 1);       // the tool block above it, not the message
  ctx.scanFinalMessage();
  ctx.learnFromSelection();
  open(BLOCK, 'claude');
  assert.deepEqual(scan(), [3, 5]);
});

test('a trim that would leave nothing keeps the block whole', () => {
  open(BLOCK, 'claude');
  ctx.noteTrim('claude', 9, 9);
  assert.deepEqual(scan(), [3, 5]);
});

test('a corrupt or stale store is no trim, never a broken pane', () => {
  open(BLOCK, 'claude');
  store.set('herdr_summary_trim', '{not json');
  assert.deepEqual(scan(), [3, 5]);
  store.set('herdr_summary_trim', JSON.stringify({version: 0, byAgent: {claude: {'2,0': 9}}}));
  assert.deepEqual(scan(), [3, 5], 'a trim written by an older shape is ignored');
});

// --- stepping between messages ---
//
// A different question from "which is the closing one": here a tool block is passed over rather
// than stopped on, because the user is walking the conversation and a command is not part of it.

const CHAT = [
  '⏺ First thing I said.',
  '',
  '⏺ Bash(git status)',
  '  ⎿  clean',
  '',
  '⏺ Second thing I said.',
  '  over two lines',
  '',
  '✻ Worked for 3s',
];

test('previous walks up past tool blocks', () => {
  assert.deepEqual(ctx.blockBefore(CHAT, 'claude', CHAT.length), [5, 6]);
  assert.deepEqual(ctx.blockBefore(CHAT, 'claude', 5), [0, 0], 'the tool block in between is skipped');
  assert.equal(ctx.blockBefore(CHAT, 'claude', 0), null, 'nothing above the first');
});

test('next walks down the same way', () => {
  assert.deepEqual(ctx.blockAfter(CHAT, 'claude', 0), [0, 0]);
  assert.deepEqual(ctx.blockAfter(CHAT, 'claude', 1), [5, 6]);
  assert.equal(ctx.blockAfter(CHAT, 'claude', 6), null, 'nothing below the last');
});

// A conversation with prompts in it: two turns, each with a tool block and chatter before the
// message that actually answers. Stepping must land on the answers, not on the chatter.
const TURNS = [
  '⏺ Starting on it.',            // 0
  '',
  '⏺ Bash(git status)',
  '  ⎿  clean',
  '⏺ Nothing to commit, so here is the plan.',   // 4  <- turn 1's closing message
  '',
  '❯ go ahead',                   // 6
  '⏺ Working.',                   // 7
  '',
  '⏺ Done: two files changed.',   // 9  <- turn 2's closing message
  '  and the tests pass',         // 10
  '',
  '❯ ',                           // 12  the composer, always the last line of a live pane
];

test('a turn is one entry, taken from just above each prompt', () => {
  assert.deepEqual(ctx.turnSummaries(TURNS, 'claude'), [[4, 4], [9, 10]]);
  assert.deepEqual(ctx.turnSummaries(CHAT, 'claude'), [], 'no prompt gutter, no turns');
});

test('stepping walks turns, not every block the agent emitted', () => {
  open(TURNS, 'claude');
  ctx.scanFinalMessage();
  ctx.stepBlock(-1);
  assert.deepEqual([ctx.selA, ctx.selB], [9, 10], 'the newest turn, not `⏺ Working.` above it');
  ctx.stepBlock(-1);
  assert.deepEqual([ctx.selA, ctx.selB], [4, 4], 'past the whole of turn 1 in one press');
  ctx.stepBlock(1);
  assert.deepEqual([ctx.selA, ctx.selB], [9, 10]);
});

test('every turn is marked, not only the newest one', () => {
  open(TURNS, 'claude');
  ctx.scanFinalMessage();
  assert.deepEqual(Array.from(ctx.summaryRows(TURNS, 'claude')), [4, 9, 10]);
  // Trimmed the way the user trims: the mark and the range ↑ selects are the same lines.
  ctx.noteTrim('claude', 1, 0);
  assert.deepEqual(Array.from(ctx.summaryRows(TURNS, 'claude')), [4, 10]);
});

test('with no prompt gutter there is one mark: the final message', () => {
  open(CHAT, 'claude');
  ctx.scanFinalMessage();
  assert.deepEqual(Array.from(ctx.summaryRows(CHAT, 'claude')), [5, 6]);
});

test('the block a line sits in, and the lines that sit in none', () => {
  assert.deepEqual(ctx.blockContaining(CHAT, 'claude', 6), [5, 6], 'a continuation line');
  assert.deepEqual(ctx.blockContaining(CHAT, 'claude', 5), [5, 6], 'the glyph line itself');
  assert.equal(ctx.blockContaining(CHAT, 'claude', 3), null, 'inside a tool block');
  assert.equal(ctx.blockContaining(CHAT, 'claude', 8), null, 'the turn footer');
});

// --- an unknown harness, taught by one selection ---

const OTHER = ['◆ Ran the build', '  compiled', '', '◆ All finished.', '  and here is why'];

test('an unknown harness is inert until it is taught', () => {
  open(OTHER, 'pi');
  assert.equal(scan(), null);
  assert.equal(ctx.blockBefore(OTHER, 'pi', OTHER.length), null);
});

test('Learn takes the marker off the line the selection starts on', () => {
  open(OTHER, 'pi', 3, 4);
  assert.equal(ctx.learnGutter('pi'), true);
  assert.deepEqual(ctx.profileFor('pi'), { speaker: '◆', result: [] });
  assert.deepEqual(scan(), [3, 4]);
  assert.deepEqual(ctx.blockBefore(OTHER, 'pi', 3), [0, 1], 'and navigation works from then on');
});

test('a declined confirmation stores nothing', () => {
  open(OTHER, 'pi', 3, 4);
  answer = false;
  assert.equal(ctx.learnGutter('pi'), false);
  assert.equal(scan(), null);
});

test('a letter in column 0 is prose and is refused', () => {
  open(['Summary of the work', '  and the rest'], 'pi', 0, 1);
  assert.equal(ctx.learnGutter('pi'), false);
  assert.match(toasts[0], /marker/);
  open(['  indented, so no marker at all'], 'pi', 0, 0);
  assert.equal(ctx.learnGutter('pi'), false);
});

test('a learned harness never suggests on its own', () => {
  open(OTHER, 'pi', 3, 4);
  ctx.learnGutter('pi');
  ctx.selA = ctx.selB = null;
  vm.runInContext('suggestedKey = ""', ctx);
  ctx.scanFinalMessage();
  ctx.suggestFinalMessage();
  assert.equal(ctx.selA, null, 'no result glyph means no way to tell a command from a sentence');
  // Asking is different from being told: Summary still selects it.
  ctx.selectFinalMessage();
  assert.deepEqual([ctx.selA, ctx.selB], [3, 4]);
});

test('the most-confirmed trim wins, ties use the latest explicit trim', () => {
  open(BLOCK, 'claude');
  ctx.noteTrim('claude', 3, 0);
  ctx.noteTrim('claude', 3, 0);
  ctx.noteTrim('claude', 1, 0);
  assert.deepEqual(ctx.learnedTrim('claude'), [3, 0]);
  ctx.noteTrim('claude', 1, 0);
  assert.deepEqual(ctx.learnedTrim('claude'), [1, 0], 'tied at two each, so the later trim wins');
});

test('known prompt gutters identify user input at column zero', () => {
  assert.equal(ctx.isUserInput('❯ allow it', 'claude'), true);
  assert.equal(ctx.isUserInput('> allow it', 'claude'), true);
  assert.equal(ctx.isUserInput('› continue', 'codex'), true);
  assert.equal(ctx.isUserInput(' > indented', 'claude'), false);
});

test('a prompt rule covers its continuation and stops at the last line with text', () => {
  const rows = ['❯ inspect this', '  with both files', '', '⏺ I found it.', '  details'];
  assert.deepEqual(Array.from(ctx.userInputLines(rows, 'claude')), [0, 1]);
  // A blank inside the turn is kept: the rule must not break in the middle of one message.
  const gapped = ['❯ first line', '', '  second line', '', '⏺ Answer.'];
  assert.deepEqual(Array.from(ctx.userInputLines(gapped, 'claude')), [0, 1, 2]);
});
