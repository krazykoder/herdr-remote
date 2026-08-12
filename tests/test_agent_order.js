// The same browser-local order drives landing cards and pane tabs.
//
// Nothing here is on the wire — the relay owns membership and status, and this only says which
// live cards come first. That makes the stored value the thing worth pinning: it outlives the
// panes it names, so what a stale, hand-edited or unwritable one does is the whole risk.
//
// Runs the block straight out of web/index.html so the single-file app keeps its no-build-step
// property, the same trick tests/test_sections.js uses.
//
//   node --test tests/test_agent_order.js
const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const from = html.indexOf('    // --- Agent order ---');
const to = html.indexOf('    // Pinned tabs, newest pin first', from);
assert.ok(from !== -1 && to > from, 'agent order block not found');

function ctx(agents, store = {}) {
  let renders = 0;
  const context = vm.createContext({
    agents,
    render: () => { renders++; },
    localStorage: {getItem: k => store[k] || null, setItem: (k, v) => { store[k] = String(v); }},
  });
  vm.runInContext(html.slice(from, to), context);
  return {store, run: code => vm.runInContext(code, context), renders: () => renders};
}

test('saved agent order leads the snapshot and leaves new agents after it', () => {
  const c = ctx([{pane_id: 'a'}, {pane_id: 'b'}, {pane_id: 'c'}], {herdr_agent_order: '["b","a"]'});
  c.run('loadAgentOrder()');
  assert.deepEqual([...c.run('orderedAgents(agents).map(a => a.pane_id)')], ['b', 'a', 'c']);
});

test('moving two agents persists their order and re-renders both surfaces', () => {
  const c = ctx([{pane_id: 'a'}, {pane_id: 'b'}, {pane_id: 'c'}]);
  c.run("moveAgent('c', 'a')");
  assert.deepEqual(JSON.parse(c.store.herdr_agent_order), ['c', 'b', 'a']);
  assert.equal(c.renders(), 1);
});

test('an order naming panes that are gone still orders the ones that are here', () => {
  // pane_ids are herdr's and get reused; the order is this browser's and outlives them. A stored
  // name with no pane behind it has to be stepped over rather than leaving a hole in the list.
  const c = ctx([{pane_id: 'b'}, {pane_id: 'c'}], {herdr_agent_order: '["gone","c","b"]'});
  c.run('loadAgentOrder()');
  assert.deepEqual([...c.run('orderedAgents(agents).map(a => a.pane_id)')], ['c', 'b']);
});

test('a stored value that is not a list of names is dropped, not trusted', () => {
  for (const bad of ['null', '{"a":1}', '7', 'not json at all', '["a",3,"a"]']) {
    const c = ctx([{pane_id: 'a'}, {pane_id: 'b'}], {herdr_agent_order: bad});
    c.run('loadAgentOrder()');
    // Either emptied outright or filtered down to the usable names — never a crash, and never a
    // number or a repeat left in where a pane_id is expected.
    for (const id of c.run('agentOrder')) assert.equal(typeof id, 'string', `stored ${bad}`);
    assert.deepEqual([...c.run('orderedAgents(agents).map(a => a.pane_id)')], ['a', 'b'], `stored ${bad}`);
  }
});

test('a pane_id two panes answer to is left alone', () => {
  // herdr reuses ids across hosts, and the app guards every write the same way. Swapping on an
  // ambiguous id would move whichever card sorted first, which is a coin toss the user cannot see.
  const c = ctx([{pane_id: 'a'}, {pane_id: 'a'}, {pane_id: 'b'}]);
  c.run("moveAgent('b', 'a')");
  assert.equal(c.store.herdr_agent_order, undefined, 'nothing written');
  assert.equal(c.renders(), 0, 'and nothing repainted');
});

test('moving a pane onto itself is not a move', () => {
  const c = ctx([{pane_id: 'a'}, {pane_id: 'b'}]);
  c.run("moveAgent('a', 'a')");
  assert.equal(c.renders(), 0);
});

test('private mode keeps the move for this session rather than failing it', () => {
  const context = vm.createContext({
    agents: [{pane_id: 'a'}, {pane_id: 'b'}],
    render: () => {},
    localStorage: {getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }},
  });
  vm.runInContext(html.slice(from, to), context);
  vm.runInContext("moveAgent('b', 'a')", context);
  assert.deepEqual([...vm.runInContext('orderedAgents(agents).map(a => a.pane_id)', context)], ['b', 'a']);
});
