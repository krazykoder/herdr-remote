// The pane history ceiling, over a stub DOM.
//
// The depth reached is re-read every three seconds for as long as the pane is open, so this
// setting is a standing cost rather than a one-off fetch — which is why the stored value is
// validated against the offered list instead of trusted, and why lowering it takes effect on the
// open pane rather than at the next pane switch. Runs the block straight out of web/index.html so
// the single-file app keeps its no-build-step property, the same trick tests/test_bottom_dock.js
// uses.
//
//   node --test tests/test_pane_history.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const from = HTML.indexOf("    const HISTORY_KEY = 'herdr_pane_history';");
const to = HTML.indexOf('    // --- Slots ---', from);
assert.ok(from !== -1 && to > from, 'pane history block not found in web/index.html');

function historyCtx({stored = null, paneLines = 200} = {}) {
  const store = stored === null ? {} : {herdr_pane_history: String(stored)};
  const el = {value: ''};
  const reads = [];
  const ctx = vm.createContext({
    document: {getElementById: () => el},
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    window: {}, console,
    paneLines,
    // The slice carries the real refreshPane, so the read is observed on the wire rather than
    // through a stub of it — which is the thing that would silently stop happening.
    activePane: 'w1:p1',
    paneSource: 'recent-unwrapped',
    ws: {send: s => reads.push(JSON.parse(s))},
  });
  vm.runInContext(HTML.slice(from, to), ctx);
  return {el, store, reads, run: src => vm.runInContext(src, ctx)};
}

test('the default is what the ceiling has always been', () => {
  assert.equal(historyCtx().run('paneHistoryMax()'), 5000);
  assert.equal(historyCtx().run('historyStep()'), 500, 'and so is the step at that ceiling');
});

test('a stored choice is honoured', () => {
  assert.equal(historyCtx({stored: 20000}).run('paneHistoryMax()'), 20000);
});

test('a stored value that is not on offer falls back rather than being used', () => {
  // It reaches the relay as a read depth. The relay clamps it too, but a number this side that
  // nothing in the UI can produce is a number nothing in the UI can undo either.
  for (const bad of ['999999', 'lots', '', '-1', '5000.5']) {
    assert.equal(historyCtx({stored: bad}).run('paneHistoryMax()'), 5000, `stored ${bad}`);
  }
});

test('the step scales, so a deep ceiling is not fifty taps away', () => {
  assert.equal(historyCtx({stored: 50000}).run('historyStep()'), 5000);
  assert.equal(historyCtx({stored: 2000}).run('historyStep()'), 500, 'and never smaller than 500');
});

test('choosing a ceiling stores it and shows it', () => {
  const {store, el, run} = historyCtx();
  run("setPaneHistoryMax('20000')");
  assert.equal(store.herdr_pane_history, '20000');
  assert.equal(el.value, '20000', 'the select carries the choice back');
});

test('a ceiling that is not on offer is stored as the default, not as itself', () => {
  const {store, run} = historyCtx();
  run("setPaneHistoryMax('999999')");
  assert.equal(store.herdr_pane_history, '5000');
});

test('lowering it below the open pane re-reads at the new ceiling', () => {
  const {reads, run} = historyCtx({stored: 50000, paneLines: 30000});
  run("setPaneHistoryMax('2000')");
  assert.equal(run('paneLines'), 2000, 'the open pane comes back down');
  assert.deepEqual(reads, [{type: 'read_pane', pane_id: 'w1:p1', lines: 2000, source: 'recent-unwrapped'}],
    'and does so now, not at the next pane switch');
});

test('a deep read is not re-polled, because scrollback does not change', () => {
  const {reads, run} = historyCtx({stored: 50000, paneLines: 20000});
  run('refreshPane(true)');
  assert.deepEqual(reads, [], 'the 3s tick re-fetched 20,000 lines');
  // What the user asks for is never skipped — the refresh button, Load more, a key just sent.
  run('refreshPane()');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].lines, 20000);
});

test('a shallow pane still follows the tail', () => {
  const {reads, run} = historyCtx({paneLines: 200});
  run('refreshPane(true)');
  assert.equal(reads.length, 1, 'the ordinary case must not have been paused');
});

test('raising it leaves the open pane where it is', () => {
  const {reads, run} = historyCtx({stored: 2000, paneLines: 2000});
  run("setPaneHistoryMax('50000')");
  assert.equal(run('paneLines'), 2000, 'more history is fetched when asked for, not on the setting');
  assert.deepEqual(reads, [], 'no read the user did not ask for');
});
