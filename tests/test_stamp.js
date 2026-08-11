// How recently a pane moved, and the two things drawn from it: the bottom bar's left field and
// word, and the status dot's colour.
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
// so the context supplies them and each test sets what it needs. LIVE_MS is declared with the
// other recency thresholds, above this block.
const ctx = vm.createContext({
  Date, activePane: null, agents: [], paneStampAt: null, LIVE_MS: 5 * 60 * 1000,
});
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

// --- The dot's colour ---

const dotFrom = HTML.indexOf('    function activityBucket(paneId) {');
const dotTo = HTML.indexOf('    let activeWorkspace = null;', dotFrom);
assert.ok(dotFrom !== -1 && dotTo > dotFrom, 'activityBucket/statusColor not found in web/index.html');

const dotCtx = vm.createContext({
  Date, lastSeen: {},
  LIVE_MS: 5 * MIN, RECENT_MS: 60 * MIN,
});
vm.runInContext(HTML.slice(dotFrom, dotTo), dotCtx);

// Colour for an agent with the given herdr status that last moved `agoMs` ago.
function dot(status, agoMs) {
  dotCtx.lastSeen = agoMs === null ? {} : {'w1:p0': Date.now() - agoMs};
  return dotCtx.statusColor({pane_id: 'w1:p0', status});
}

test('a pane that finished seconds ago is as green as one still running', () => {
  // The bug this replaces: leaving 'working' flipped the dot straight to amber, so an agent
  // read as going cold at the exact moment it had something to show.
  assert.strictEqual(dot('working', SEC), 'var(--green)');
  assert.strictEqual(dot('done', SEC), 'var(--green)');
  assert.strictEqual(dot('idle', 4 * MIN), 'var(--green)');
});

test('amber means idle, not "recently touched at some point in the last hour"', () => {
  assert.strictEqual(dot('done', 6 * MIN), 'var(--orange)');
  assert.strictEqual(dot('idle', 59 * MIN), 'var(--orange)');
});

test('past an hour the dot goes cold', () => {
  assert.strictEqual(dot('done', 2 * HOUR), 'var(--muted)');
  assert.strictEqual(dot('idle', null), 'var(--muted)', 'never seen move is cold too');
});

test('working outranks recency, blocked outranks everything', () => {
  assert.strictEqual(dot('working', 5 * HOUR), 'var(--green)');
  assert.strictEqual(dot('blocked', 5 * HOUR), 'var(--red)');
  assert.strictEqual(dot('blocked', SEC), 'var(--red)');
});

test('a shell keeps its own blue when cold, rather than going grey like an agent', () => {
  // A shell only stamps while it is open, so cold is where most of them sit. Muting them would
  // have traded the one cue that says "terminal" for a cue that says nothing.
  const shell = agoMs => {
    dotCtx.lastSeen = agoMs === null ? {} : {'w1:p0': Date.now() - agoMs};
    return vm.runInContext(`shellColor('w1:p0')`, dotCtx);
  };
  assert.strictEqual(shell(30 * SEC), 'var(--green)');
  assert.strictEqual(shell(20 * MIN), 'var(--orange)');
  assert.strictEqual(shell(3 * HOUR), 'var(--shell)');
  assert.strictEqual(shell(null), 'var(--shell)', 'never seen is the same as cold here');
});

test('the bands line up end to end, with no gap and no overlap', () => {
  // The tab strip caches on this, so a pane must be in exactly one band at any moment.
  const bucket = agoMs => {
    dotCtx.lastSeen = {'w1:p0': Date.now() - agoMs};
    return vm.runInContext(`activityBucket('w1:p0')`, dotCtx);
  };
  assert.strictEqual(bucket(0), 'live');
  assert.strictEqual(bucket(5 * MIN + SEC), 'idle');
  assert.strictEqual(bucket(60 * MIN + SEC), 'cold');
});
