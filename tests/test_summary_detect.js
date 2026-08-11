// Which lines of a finished pane are the agent's closing message.
//
// The interesting cases are not synthetic — they are two panes read off a live herdr on
// 2026-08-11 and checked in under tests/fixtures/. A pane is mostly tool output, so what the
// parse has to get right is the boundary between the last command the agent ran and the last
// thing it said. Asserting against the real reads is what makes a harness changing its gutter
// glyphs break here rather than in front of a user.
//
// Runs the block straight out of web/index.html so the single-file app keeps its no-build-step
// property, the same trick tests/test_attention.js uses.
//
//   node --test tests/test_summary_detect.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const from = HTML.indexOf('    // --- Final message detection ---');
const to = HTML.indexOf('    // --- Line ruler ---', from);
assert.ok(from !== -1 && to > from, 'final message block not found in web/index.html');

// suggestFinalMessage() reaches for activePane, paneOf and drawSel; the parse itself does not.
// Stubbing them keeps the slice loadable while the tests stay on findFinalMessage.
const ctx = vm.createContext({console, activePane: null, paneOf: () => null, drawSel: () => {}});
vm.runInContext(HTML.slice(from, to), ctx);
const find = (rows, agent) => ctx.findFinalMessage(rows, agent);

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
