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

const ctx = vm.createContext({Date});
vm.runInContext(HTML.slice(from, to), ctx);
const {fmtAgo, fmtStamp} = ctx;

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
