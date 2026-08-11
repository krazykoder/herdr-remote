// The bottom bar's left field — how long ago the open pane last changed.
//
// Run straight out of web/index.html so the single-file app keeps its no-build-step property,
// the same trick tests/test_pairs.js and tests/test_ctrl_keys.js use.
//
//   node --test tests/test_stamp.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const from = HTML.indexOf('    function fmtStamp(d) {');
const to = HTML.indexOf('    function renderStatusBar()', from);
assert.ok(from !== -1 && to > from, 'fmtStamp/fmtAgo not found in web/index.html');

// activePane / agents / paneStampAt are module state in the app; paneStatusWord reads all three,
// so the context supplies them and each test sets what it needs.
const ctx = vm.createContext({Date, activePane: null, agents: [], paneStampAt: null});
vm.runInContext(HTML.slice(from, to), ctx);
const {fmtAgo, fmtStamp} = ctx;

// Returns [word, tone] for a pane with the given herdr status (null for a shell) that last
// changed `agoMs` ago (null for a pane never seen to change).
function word(status, agoMs) {
  ctx.activePane = 'w1:p0';
  ctx.agents = status === null ? [] : [{pane_id: 'w1:p0', status}];
  ctx.paneStampAt = agoMs === null ? null : new Date(Date.now() - agoMs);
  // Spread back into this realm: the array comes out of the vm context with that context's
  // Array prototype, and deepStrictEqual compares prototypes.
  return [...vm.runInContext('paneStatusWord()', ctx)];
}

const ago = ms => fmtAgo(new Date(Date.now() - ms));
const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;

test('the first few seconds are not worth counting', () => {
  assert.strictEqual(ago(0), 'just now');
  assert.strictEqual(ago(9 * SEC), 'just now');
});

test('seconds, then minutes, then hours', () => {
  assert.strictEqual(ago(11 * SEC), '11s ago');
  assert.strictEqual(ago(59 * SEC), '59s ago');
  assert.strictEqual(ago(MIN), '1m ago');
  assert.strictEqual(ago(59 * MIN), '59m ago');
  assert.strictEqual(ago(HOUR), '1h ago');
  assert.strictEqual(ago(23 * HOUR), '23h ago');
});

test('each step floors rather than rounds, so the label never runs ahead of the clock', () => {
  // 119s is one minute and 59 seconds. Rounding would call that "2m ago" — a label claiming
  // more staleness than has actually elapsed.
  assert.strictEqual(ago(119 * SEC), '1m ago');
  assert.strictEqual(ago(119 * MIN), '1h ago');
});

test('past a day it hands over to the date, where relative stops being readable', () => {
  const old = new Date(Date.now() - 30 * HOUR);
  assert.strictEqual(fmtAgo(old), fmtStamp(old));
  assert.match(fmtAgo(old), / · /, 'the absolute form keeps its separator');
});

// --- The right-hand word ---

test("an agent reports herdr's own status, not a word invented here", () => {
  // All four survive the trip. The old code collapsed them to active/idle, which made a finished
  // agent read the same as one that had never started.
  assert.deepStrictEqual(word('blocked', SEC), ['blocked', 'alert']);
  assert.deepStrictEqual(word('working', SEC), ['working', 'on']);
  assert.deepStrictEqual(word('done', SEC), ['done', '']);
  assert.deepStrictEqual(word('idle', SEC), ['idle', '']);
});

test('a working agent stays working however long it has been silent', () => {
  // Recency must not outrank herdr here: an agent three hours into a task with nothing new on
  // screen is still working, and saying otherwise is the one error that would matter.
  assert.deepStrictEqual(word('working', 3 * HOUR), ['working', 'on']);
});

test('a shell has no status, so recency is the whole answer', () => {
  assert.deepStrictEqual(word(null, 10 * SEC), ['live', 'on']);
  assert.deepStrictEqual(word(null, 4 * MIN), ['live', 'on']);
  assert.deepStrictEqual(word(null, 6 * MIN), ['idle', '']);
  assert.deepStrictEqual(word(null, 5 * HOUR), ['idle', '']);
});

test('a status outside the reported set falls through to recency', () => {
  // 'unknown' is a real herdr value; the landing page already lumps it in with idle rather than
  // showing it. Inventing a label for it here would be the reinvention this avoids.
  assert.deepStrictEqual(word('unknown', 10 * SEC), ['live', 'on']);
  assert.deepStrictEqual(word('unknown', 6 * MIN), ['idle', '']);
});

test('no evidence reads blank rather than claiming the pane is quiet', () => {
  assert.deepStrictEqual(word(null, null), ['', '']);
  assert.deepStrictEqual(word('unknown', null), ['', '']);
});
