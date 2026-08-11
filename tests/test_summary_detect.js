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
const ctx = vm.createContext({
  console,
  activePane: null, paneOf: () => null, drawSel: () => {},
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
beforeEach(() => store.clear());

// A pane the user is looking at, with a range on it: what noteTransferTrim reads.
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
  assert.deepEqual(val('finalRaw'), [3, 5]);
});

test('a transfer teaches the trim, and the next read arrives already trimmed', () => {
  open(BLOCK, 'claude', 5, 5);       // user kept only the last line of the message
  ctx.scanFinalMessage();
  ctx.noteTransferTrim();
  open(BLOCK, 'claude');
  assert.deepEqual(scan(), [5, 5]);
});

test('a trim that lands on a blank line keeps walking', () => {
  open(BLOCK, 'claude');
  ctx.noteTrim('claude', 1, 0);      // index 4, which is blank
  assert.deepEqual(scan(), [5, 5]);
});

test('the trim is per harness', () => {
  open(BLOCK, 'claude', 5, 5);
  ctx.scanFinalMessage();
  ctx.noteTransferTrim();
  open(['• Said a thing.', '  and another'], 'codex');
  assert.deepEqual(scan(), [0, 1], "claude's trim left codex alone");
});

test('a selection outside the block teaches nothing', () => {
  open(BLOCK, 'claude', 0, 1);       // the tool block above it, not the message
  ctx.scanFinalMessage();
  ctx.noteTransferTrim();
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

test('the most-confirmed trim wins, ties keep more of the block', () => {
  open(BLOCK, 'claude');
  ctx.noteTrim('claude', 3, 0);
  ctx.noteTrim('claude', 3, 0);
  ctx.noteTrim('claude', 1, 0);
  assert.deepEqual(ctx.learnedTrim('claude'), [3, 0]);
  ctx.noteTrim('claude', 1, 0);
  assert.deepEqual(ctx.learnedTrim('claude'), [1, 0], 'tied at two each, so the smaller trim wins');
});
