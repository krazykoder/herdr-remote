// Which panes are asking for you, over a stub localStorage.
//
// One predicate feeds five surfaces — the card, the hoist, the chips, the pane strip and the
// browser tab — so the thing worth pinning is the predicate itself, and above all the acking
// rule: acked per status rather than per pane, which is what stops a done agent badging forever
// and what makes a pane acked while blocked speak up again when it finishes. Runs the block
// straight out of web/index.html so the single-file app keeps its no-build-step property, the
// same trick tests/test_pane_history.js uses.
//
//   node --test tests/test_attention.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const from = HTML.indexOf('    // --- Attention ---');
const to = HTML.indexOf('    // How recently a pane moved', from);
assert.ok(from !== -1 && to > from, 'attention block not found in web/index.html');

function attentionCtx({agents = [], stored = null} = {}) {
  const store = stored === null ? {} : {herdr_acked: JSON.stringify(stored)};
  const ctx = vm.createContext({
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    console,
    agents,
  });
  vm.runInContext(HTML.slice(from, to), ctx);
  return {store, agents, run: src => vm.runInContext(src, ctx)};
}

const pane = (pane_id, status) => ({pane_id, status});

test('blocked and done both ask for you; nothing else does', () => {
  const {run} = attentionCtx({
    agents: [pane('a', 'blocked'), pane('b', 'done'), pane('c', 'working'),
             pane('d', 'idle'), pane('e', 'unknown'), pane('f', undefined)],
  });
  assert.equal(run('attentionCount()'), 2);
  assert.equal(run("needsAttention(agents.find(a => a.pane_id === 'c'))"), false, 'working');
  assert.equal(run("needsAttention(agents.find(a => a.pane_id === 'f'))"), false, 'a terminal');
});

test('a pane that is not there asks for nothing', () => {
  // Every caller reaches this through a find(), and one that missed used to be a crash.
  const {run} = attentionCtx();
  assert.equal(run('needsAttention(null)'), false);
  assert.equal(run('needsAttention(undefined)'), false);
});

test('opening a pane clears it', () => {
  const {run, store} = attentionCtx({agents: [pane('a', 'blocked')]});
  assert.equal(run('attentionCount()'), 1);
  run("ackPane('a')");
  assert.equal(run('attentionCount()'), 0);
  assert.deepEqual(JSON.parse(store.herdr_acked), {a: 'blocked'}, 'and survives a reload');
});

test('a pane acked while blocked speaks up again when it finishes', () => {
  // The reason the ack is per status. Per pane this pane would never be heard from again.
  const {run, agents} = attentionCtx({agents: [pane('a', 'blocked')]});
  run("ackPane('a')");
  agents[0].status = 'done';
  assert.equal(run('attentionCount()'), 1);
});

test('a pane that finished stays quiet once looked at', () => {
  // The other half: done is sticky in herdr, so without an ack it would badge until restarted.
  const {run, agents} = attentionCtx({agents: [pane('a', 'done')]});
  run("ackPane('a')");
  agents[0].status = 'working';
  run('syncAcked(agents)');
  assert.equal(run('attentionCount()'), 0, 'went back to work');
  agents[0].status = 'done';
  run('syncAcked(agents)');
  assert.equal(run('attentionCount()'), 1, 'and finished a second time');
});

test('acking a pane twice does not rewrite storage', () => {
  const {run, store} = attentionCtx({agents: [pane('a', 'done')]});
  run("ackPane('a')");
  store.herdr_acked = 'sentinel';
  run("ackPane('a')");
  assert.equal(store.herdr_acked, 'sentinel');
});

test('acking a pane that is gone does nothing', () => {
  const {run, store} = attentionCtx({agents: []});
  run("ackPane('ghost')");
  assert.equal(store.herdr_acked, undefined);
});

test('a stored ack is honoured across a reload', () => {
  const {run} = attentionCtx({agents: [pane('a', 'done')], stored: {a: 'done'}});
  assert.equal(run('attentionCount()'), 0);
});

test('unreadable storage is treated as no acks, not as a crash', () => {
  for (const bad of ['{oh no', 'null', '[]', '"a"']) {
    const ctx = vm.createContext({
      localStorage: {getItem: () => bad, setItem: () => {}}, console,
      agents: [pane('a', 'done')],
    });
    vm.runInContext(HTML.slice(from, to), ctx);
    assert.equal(vm.runInContext('attentionCount()', ctx), 1, `stored ${bad}`);
  }
});

test('acks for panes herdr no longer reports are dropped', () => {
  // Or the map grows for the life of the browser profile, and a recycled pane ID arrives
  // pre-acked — silently, which is the bad half.
  const {run, store} = attentionCtx({stored: {a: 'done', gone: 'blocked'}});
  run("syncAcked([{pane_id: 'a', status: 'done'}])");
  assert.deepEqual(JSON.parse(store.herdr_acked), {a: 'done'});
});

test('a sync that drops nothing does not rewrite storage', () => {
  const {run, store} = attentionCtx({stored: {a: 'done'}});
  store.herdr_acked = 'sentinel';
  run("syncAcked([{pane_id: 'a', status: 'done'}])");
  assert.equal(store.herdr_acked, 'sentinel');
});

test('private mode is session-only rather than an error', () => {
  const ctx = vm.createContext({
    localStorage: {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
    },
    console, agents: [pane('a', 'done')],
  });
  vm.runInContext(HTML.slice(from, to), ctx);
  vm.runInContext("ackPane('a')", ctx);
  assert.equal(vm.runInContext('attentionCount()', ctx), 0, 'the ack still took for this session');
});
