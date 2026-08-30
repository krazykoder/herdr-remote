// Filing a live pane into a conversation of its own — and the two absences it must not do it for.
//
//   node --test tests/test_conv_autojoin.js
//
// convAutoJoin is what gives a pane nobody grouped a record of its own. It reads the conversation
// index, and the index is shared: every browser holds the same one. So an emptiness it reads is
// only sometimes a fact. A browser that has never connected reads one, and so does a browser whose
// storage was cleared under it, and so does one whose adopt of a 52 KB document was refused for
// space. Filing every live pane against any of those mints a copy of the index that is then pushed
// at a revision the relay accepts — which is one browser replacing every conversation every other
// browser had. It happened, twice.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'src', 'conversation_view.js'), 'utf8');
const IDX = 'herdr_conversations';

const index = ids => JSON.stringify(
  {version: 1, items: ids.map(id => ({id, name: id, members: []}))});

// conversation_view.js resolves everything it borrows at call time, so the context holds only what
// convAutoJoin itself reaches for.
function boot({stored = {}, agents = [], pending = false, held = null} = {}) {
  const store = Object.assign({}, stored);
  const saved = [];
  const ctx = vm.createContext({
    console, JSON, Math, Date, Object, Array, Set, Map, String, Number,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    document: {getElementById: () => null},
    window: {},
    agents,
    parseConvIndex: raw => {
      try {
        const d = JSON.parse(raw || '');
        return d && d.version === 1 && Array.isArray(d.items) ? d.items : [];
      } catch (e) { return []; }
    },
    loadConvIndex: () => ctx.parseConvIndex(store[IDX]),
    saveConvIndex: items => { saved.push(items); store[IDX] = index(items.map(c => c.id)); },
    convFit: items => items,
    convMemberKey: a => 'k_' + a.pane_id,
    convMemberOf: a => ({key: 'k_' + a.pane_id, added: 1}),
    convStartClaimed: () => false,
    profileFor: () => ({}),
    paneLabel: a => a.pane_id,
    renderConversations: () => {},
    stateSyncPending: () => pending,
    stateSyncHeld: () => held,
  });
  vm.runInContext(SRC, ctx);
  return {saved, store, run: s => vm.runInContext(s, ctx)};
}

const PANES = [{pane_id: 'w1:p1', agent: 'claude'}, {pane_id: 'w1:p2', agent: 'claude'}];

test('an unfiled pane gets a conversation of its own', () => {
  const e = boot({agents: PANES});
  e.run('convAutoJoin()');
  assert.equal(e.saved.length, 1);
  assert.equal(e.saved[0].length, 2, 'one each, not one between them');
});

test('nothing is minted while the shared index is still in the air', () => {
  const e = boot({agents: PANES, pending: true});
  e.run('convAutoJoin()');
  assert.deepEqual(e.saved, []);
});

test('nothing is minted when the relay holds an index this browser has lost', () => {
  // Storage cleared under a live page, or an adopt refused for space. The relay's copy is the
  // fact; this browser's absence is not.
  const e = boot({agents: PANES, held: index(['c1', 'c2', 'c3'])});
  e.run('convAutoJoin()');
  assert.deepEqual(e.saved, [], 'and above all nothing is written back over the real index');
});

test('an index the relay really is empty of is filed against', () => {
  // The honest empty: a first-ever fleet. Refusing here would mean no pane is ever filed.
  const e = boot({agents: PANES, held: index([])});
  e.run('convAutoJoin()');
  assert.equal(e.saved.length, 1);
});

test('a browser that holds conversations files against them however many the relay holds', () => {
  const e = boot({agents: PANES, stored: {[IDX]: index(['c1'])}, held: index(['c1', 'c2'])});
  e.run('convAutoJoin()');
  assert.equal(e.saved.length, 1, 'the guard is about emptiness, not about agreeing with the relay');
  assert.equal(e.saved[0].length, 3);
});
