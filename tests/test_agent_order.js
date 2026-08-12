// The same browser-local order drives landing cards and pane tabs.
//
// Nothing here is on the wire — the relay owns membership and status, and this only says which
// live cards come first. That makes the stored value the thing worth pinning: it outlives the
// panes it names, so what a stale, hand-edited or unwritable one does is the whole risk. The
// gesture that writes it lives in the reorder sheet and is covered in the browser, where there
// are pointers to drag with; this is the half that survives a reload.
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
assert.ok(from !== -1 && to > from, 'agent order block not found in web/index.html');

function ctx(agents, store = {}) {
  const context = vm.createContext({
    agents,
    localStorage: {getItem: k => store[k] || null, setItem: (k, v) => { store[k] = String(v); }},
  });
  vm.runInContext(html.slice(from, to), context);
  return {store, run: code => vm.runInContext(code, context)};
}

const ids = c => [...c.run('orderedAgents(agents).map(a => a.pane_id)')];

test('saved agent order leads the snapshot and leaves new agents after it', () => {
  const c = ctx([{pane_id: 'a'}, {pane_id: 'b'}, {pane_id: 'c'}], {herdr_agent_order: '["b","a"]'});
  c.run('loadAgentOrder()');
  assert.deepEqual(ids(c), ['b', 'a', 'c']);
});

test('an unordered snapshot is left exactly as it arrived', () => {
  // The default has to be "no change at all" — an install that never opens the sheet must see the
  // list it has always seen, and a sort with one key for every unranked pane would not promise it.
  const c = ctx([{pane_id: 'c'}, {pane_id: 'a'}, {pane_id: 'b'}]);
  c.run('loadAgentOrder()');
  assert.deepEqual(ids(c), ['c', 'a', 'b']);
});

test('an order naming panes that are gone still orders the ones that are here', () => {
  // pane_ids are herdr's and get reused; the order is this browser's and outlives them. A stored
  // name with no pane behind it has to be stepped over rather than leaving a hole in the list.
  const c = ctx([{pane_id: 'b'}, {pane_id: 'c'}], {herdr_agent_order: '["gone","c","b"]'});
  c.run('loadAgentOrder()');
  assert.deepEqual(ids(c), ['c', 'b']);
});

test('a stored value that is not a list of names is dropped, not trusted', () => {
  for (const bad of ['null', '{"a":1}', '7', 'not json at all', '["a",3,"a"]']) {
    const c = ctx([{pane_id: 'a'}, {pane_id: 'b'}], {herdr_agent_order: bad});
    c.run('loadAgentOrder()');
    // Either emptied outright or filtered down to the usable names — never a crash, and never a
    // number or a repeat left in where a pane_id is expected.
    for (const id of c.run('agentOrder')) assert.equal(typeof id, 'string', `stored ${bad}`);
    assert.deepEqual(ids(c), ['a', 'b'], `stored ${bad}`);
  }
});

test('private mode keeps the order for this session rather than failing the drag', () => {
  const context = vm.createContext({
    agents: [{pane_id: 'a'}, {pane_id: 'b'}],
    localStorage: {getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }},
  });
  vm.runInContext(html.slice(from, to), context);
  vm.runInContext("agentOrder = ['b', 'a']; saveAgentOrder()", context);
  assert.deepEqual([...vm.runInContext('orderedAgents(agents).map(a => a.pane_id)', context)], ['b', 'a']);
});
