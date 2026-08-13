// Turning a pane into a transcript that outlives it.
//
// Consecutive reads of one pane overlap, and the overlap is the whole problem: the pane scrolls,
// `Load more` shifts it the other way, and the newest message is still being written while it is
// read. The same words therefore arrive again and again at different line numbers, and what the
// recorder has to get right is which of them are the same message.
//
// The cases below are the ones a happy-path implementation passes by accident and a real pane
// fails on: a message that grew between two reads, a window that reaches above what is stored, a
// pane that scrolled past a whole window, and an agent that said the same short thing twice.
//
// Runs the block straight out of web/index.html so the single-file app keeps its no-build-step
// property, the same trick tests/test_summary_detect.js uses.
//
//   node --test tests/test_conversation.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
// The detector and the recorder together: the recorder is a reader of turnSummaries and
// userInputLines, and testing it against stubs of those would prove it agrees with the stubs.
const from = HTML.indexOf('    // --- Final message detection ---');
const to = HTML.indexOf('    // --- Conversation recorder (pure) --- end', from);
assert.ok(from !== -1 && to > from, 'conversation recorder block not found in web/index.html');

// Everything the detector block reaches for and does not declare. The recorder itself needs none
// of it — that is the property being kept.
const ctx = vm.createContext({
  console,
  activePane: null, paneOf: () => null, drawSel: () => {}, renderQuickActions: () => {},
  showToast: () => {}, confirm: () => true, scrollPaneToLine: () => {}, repaintHighlights: () => {},
  paneRows: [], selA: null, selB: null,
  localStorage: {getItem: () => null, setItem: () => {}},
});
vm.runInContext(HTML.slice(from, to), ctx);
const {paneMessages, recordMessages, convKey, convText} = ctx;
// A const is a lexical binding rather than a property of the context object, so the ceilings are
// read back by evaluating their names in the context they live in — as the browser specs do.
const CONV_TEXT_MAX = vm.runInContext('CONV_TEXT_MAX', ctx);

const NOW = 1755000000000;

// A claude pane: `⏺` opens what the agent said, `❯` is the prompt gutter, and the bare `❯` at the
// foot is the empty composer every live pane ends on.
const TWO_TURNS = [
  '❯ first question',
  '',
  '⏺ First answer.',
  '',
  '❯ second question',
  '',
  '⏺ Second answer.',
  '',
  '❯',
];

// Arrays built inside the vm carry the vm's Array.prototype, which deepStrictEqual counts as a
// difference. Copying them into this realm compares the contents, which is what is being asserted.
const texts = ms => Array.from(ms, m => m.text);
const whos = ms => Array.from(ms, m => m.who);
const record = (stored, rows, now) => recordMessages(stored, paneMessages(rows, 'claude'), now);

test('a window is the user and the agent in the order they spoke', () => {
  const ms = paneMessages(TWO_TURNS, 'claude');
  assert.deepStrictEqual(whos(ms), ['user', 'agent', 'user', 'agent']);
  assert.deepStrictEqual(texts(ms),
    ['first question', 'First answer.', 'second question', 'Second answer.']);
});

test('the empty composer at the foot is not a message', () => {
  // It is a prompt line with nothing typed on it, and a thread full of blank user turns is the
  // most obvious way this feature could look broken.
  assert.ok(!paneMessages(TWO_TURNS, 'claude').some(m => !m.text.trim()));
});

test('a multi-line prompt is one message, not one per line', () => {
  const rows = ['❯ do the thing', '❯ and then the other thing', '', '⏺ Done.', '', '❯'];
  const ms = paneMessages(rows, 'claude');
  assert.deepStrictEqual(texts(ms), ['do the thing\nand then the other thing', 'Done.']);
});

test('a harness with no profile records nothing rather than guessing', () => {
  assert.deepStrictEqual(texts(paneMessages(TWO_TURNS, 'amp')), []);
  assert.deepStrictEqual(texts(paneMessages(TWO_TURNS, null)), []);
});

test('a long message is cut to TEXT_MAX and says so', () => {
  const rows = ['❯ go', '', '⏺ ' + 'word '.repeat(2000), '', '❯'];
  const text = paneMessages(rows, 'claude')[1].text;
  assert.strictEqual(text.length, CONV_TEXT_MAX);
  assert.ok(text.endsWith('…'));
});

test('the first read stores the window whole, and is not a gap', () => {
  const out = record([], TWO_TURNS, NOW);
  assert.strictEqual(out.gap, false);
  assert.strictEqual(out.added, 4);
  assert.ok(out.entries.every(e => e.seen === NOW));
});

test('re-reading an unchanged pane adds nothing', () => {
  // The 3s poll re-delivers the identical window. Anything but zero here is a transcript that
  // doubles in size every three seconds.
  const first = record([], TWO_TURNS, NOW);
  const again = record(first.entries, TWO_TURNS, NOW + 3000);
  assert.strictEqual(again.added, 0);
  assert.deepStrictEqual(texts(again.entries), texts(first.entries));
});

test('a scrolled window appends only what is new', () => {
  const first = record([], TWO_TURNS, NOW);
  // The pane has scrolled: the first turn is off the top, and a third has arrived.
  const later = TWO_TURNS.slice(4).concat(
    [' ', '❯ third question', '', '⏺ Third answer.', '', '❯']);
  const out = record(first.entries, later, NOW + 60000);
  assert.strictEqual(out.gap, false);
  assert.deepStrictEqual(texts(out.entries), [
    'first question', 'First answer.', 'second question', 'Second answer.',
    'third question', 'Third answer.',
  ]);
  assert.strictEqual(out.entries[4].seen, NOW + 60000);
});

test('the same message said twice is two messages', () => {
  // The case a text-hash dedupe gets wrong, silently. Agents say "Done." constantly.
  const rows = ['❯ a', '', '⏺ Done.', '', '❯ b', '', '⏺ Done.', '', '❯'];
  const out = record([], rows, NOW);
  assert.deepStrictEqual(texts(out.entries), ['a', 'Done.', 'b', 'Done.']);
  // And the next read of the same pane still does not think one of them is new.
  assert.strictEqual(record(out.entries, rows, NOW + 3000).added, 0);
});

test('a message still being written is extended, not duplicated', () => {
  // Every poll during a reply reads a longer version of the same paragraph.
  // The composer stays at the foot while the agent writes, so the half-written reply is the block
  // above it exactly as the finished one will be.
  const half = ['❯ explain', '', '⏺ The relay polls herdr and', '', '❯'];
  const whole = ['❯ explain', '', '⏺ The relay polls herdr and broadcasts to clients.', '', '❯'];
  const first = record([], half, NOW);
  assert.deepStrictEqual(texts(first.entries), ['explain', 'The relay polls herdr and']);
  const out = record(first.entries, whole, NOW + 3000);
  assert.strictEqual(out.grew, true);
  assert.strictEqual(out.added, 0);
  assert.deepStrictEqual(texts(out.entries), ['explain', 'The relay polls herdr and broadcasts to clients.']);
  // It is the same message, so it keeps when it was first seen.
  assert.strictEqual(out.entries[1].seen, NOW);
});

test('Load more prepends the older turns and does not restamp the thread', () => {
  const later = TWO_TURNS.slice(4);
  const first = record([], later, NOW + 60000);
  assert.deepStrictEqual(texts(first.entries), ['second question', 'Second answer.']);
  const out = record(first.entries, TWO_TURNS, NOW + 90000);
  assert.strictEqual(out.gap, false);
  assert.strictEqual(out.added, 2);
  assert.deepStrictEqual(texts(out.entries),
    ['first question', 'First answer.', 'second question', 'Second answer.']);
  // Older than what follows them, and marked as arriving late — never stamped with now, which
  // would file an hour-old message as the newest thing in the thread.
  assert.ok(out.entries.slice(0, 2).every(e => e.backfill === true));
  assert.ok(out.entries.slice(0, 2).every(e => e.seen === NOW + 60000));
});

test('a pane that scrolled past a whole window is a gap, not a silent join', () => {
  const first = record([], TWO_TURNS, NOW);
  const far = ['❯ much later question', '', '⏺ Much later answer.', '', '❯'];
  const out = record(first.entries, far, NOW + 3600000);
  assert.strictEqual(out.gap, true);
  assert.strictEqual(out.entries[4].gap, true);
  assert.deepStrictEqual(texts(out.entries).slice(4), ['much later question', 'Much later answer.']);
});

test('a window re-read at a different wrap width is not new content', () => {
  // The relay reports the pane's width and the harness rewraps; the words are the same.
  const wide = ['❯ go', '', '⏺ One long sentence that fits on a single line here.', '', '❯'];
  const narrow = ['❯ go', '', '⏺ One long sentence that fits', '  on a single line here.', '', '❯'];
  const first = record([], wide, NOW);
  const out = record(first.entries, narrow, NOW + 3000);
  assert.strictEqual(out.added, 0);
  assert.strictEqual(out.gap, false);
});

test('the comparison key is not the stored text', () => {
  // Collapsing whitespace is what makes the rewrap above compare equal; storing the collapsed
  // form would run Codex's three closing paragraphs together.
  const rows = ['❯ go', '', '⏺ First paragraph.', '', '  Second paragraph.', '', '❯'];
  const text = paneMessages(rows, 'claude')[1].text;
  assert.ok(text.includes('\n'), text);
  assert.strictEqual(convKey(text), 'First paragraph. Second paragraph.');
});

test('recording never mutates what it was given', () => {
  // The caller holds the stored array and writes it only when something was added; a recorder
  // that edits it in place would make that decision meaningless.
  const first = record([], TWO_TURNS, NOW);
  const before = JSON.stringify(first.entries);
  record(first.entries, TWO_TURNS.concat(['⏺ More.', '', '❯']), NOW + 3000);
  assert.strictEqual(JSON.stringify(first.entries), before);
});

test('a real pane reads as one turn: the request, then what it concluded', () => {
  // The same fixture the detector is proved on, so a harness that changes its glyphs breaks here
  // too rather than quietly recording nothing.
  const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'pane_claude_done.txt'), 'utf8')
    .split('\n');
  // The read begins mid-block, above the closing message and below the prompt that asked for it,
  // which is what 200 lines off the foot of a real pane looks like.
  const ms = paneMessages(rows, 'claude');
  assert.deepStrictEqual(whos(ms), ['agent', 'user']);
  assert.match(ms[0].text, /^Ready\. Name the change\./);
  assert.ok(!ms[0].text.includes('⎿'), 'tool output leaked into the message');
  assert.ok(!ms[0].text.includes('Baked for'), 'the turn footer leaked into the message');
  assert.strictEqual(ms[1].text, 'allow the test commands without prompting');
  assert.strictEqual(convText(rows, [11, 11]), ms[1].text);
});
