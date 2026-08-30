// The member follows its agent, wherever herdr has put it.
//
//   node --test tests/test_conv_follow_aid.js
//
// A pane id is a slot. herdr assigns it, herdr reuses it, and it changes on a respawn, a kill, a
// herdr restart, a reboot. The colleague in it does not change, and the relay says which colleague
// that is: every pane carries the id of the agent in it, minted once and kept across every pane
// that agent goes on to occupy.
//
// Before this, a member only found its new pane if the browser that pressed Restart was still
// showing the conversation when the pane came up — the note in the index made that survive a view
// change and a reload, but a browser that never saw the press had nothing to go on at all, and a
// herdr restart is a press nobody made.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KEY = 'herdr_conversations';
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'src', 'conversation_store.js'), 'utf8');

// conversation_store.js resolves what it borrows at call time, so the context holds only what the
// fold and the follow touch. The index is real — written through the module's own saveConvIndex —
// because what is being pinned is a member moving from one key to another on disk.
function boot({conv = null, agents = [], pending = false} = {}) {
  const store = {};
  if (conv) store[KEY] = JSON.stringify({version: 1, items: [conv]});
  const sandbox = {
    console, JSON, Math, Date, Object, Array, Set, Map, String, Number, Promise,
    setTimeout, clearTimeout,
    localStorage: {
      getItem: k => (store[k] === undefined ? null : store[k]),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    agents,
    parseConvIndex: raw => {
      try {
        const d = JSON.parse(raw || '');
        return d && d.version === 1 && Array.isArray(d.items) ? d.items : [];
      } catch (e) { return []; }
    },
    // The pane fingerprint, exactly as conversation_pure.js builds it: the key names a pane, and
    // that is the point — `aid` names the colleague sitting in it.
    convMemberKey: a => (a ? JSON.stringify([a.host || '', a.pane_id || '', a.agent || '',
                                             a.cwd || '']) : ''),
    convKeyPaneId: k => { try { return JSON.parse(k)[1] || ''; } catch (e) { return ''; } },
    convWasFpPatch: () => ({}),
    CONV_WAS_MAX: 20, CONV_CONV_MAX: 50, CONV_ROSTER_MAX: 50,
    paneLabel: a => a.label || a.pane_id,
    repointPair: () => {},
    convSetView: () => {},
    showSpawnStatus: () => {},
    renderConversations: () => {},
    stateSyncMark: () => {},
    stateSyncFlush: () => {},
    stateSyncPending: () => pending,
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SRC, ctx);
  return {
    read: () => JSON.parse(store[KEY] || '{"items":[]}').items,
    run: s => vm.runInContext(s, ctx),
  };
}

const pane = (id, extra = {}) => Object.assign(
  {pane_id: id, host: 'local', agent: 'claude', cwd: '/w', label: 'ARCH'}, extra);
const keyFor = a => JSON.stringify([a.host, a.pane_id, a.agent, a.cwd]);
const OLD = pane('w1:p1'), NEW = pane('w1:p9');

const convWith = m => ({id: 'c1', name: 'Charts', members: [m]});

// --- the fold ---

test('a member whose pane is live takes that pane\'s agent id', () => {
  // How a roster written before any of this existed acquires one: no migration step, no version
  // number, nothing to run by hand.
  const e = boot({conv: convWith({key: keyFor(OLD), label: 'ARCH'}),
                  agents: [pane('w1:p1', {aid: 'a_abc123abc123'})]});
  return e.run('convFollowAids()').then(() => {
    assert.equal(e.read()[0].members[0].aid, 'a_abc123abc123');
    assert.equal(e.read()[0].members[0].key, keyFor(OLD), 'and stays on its own pane');
  });
});

test('a relay that mints no ids folds nothing and moves nobody', () => {
  const e = boot({conv: convWith({key: keyFor(OLD)}), agents: [pane('w1:p9')]});
  return e.run('convFollowAids()').then(() => {
    assert.deepEqual(e.read()[0].members.map(m => m.key), [keyFor(OLD)]);
    assert.equal(e.read()[0].members[0].aid, undefined);
  });
});

test('a member already folded is not written again', () => {
  const e = boot({conv: convWith({key: keyFor(OLD), aid: 'a_abc123abc123'}),
                  agents: [pane('w1:p1', {aid: 'a_abc123abc123'})]});
  const before = JSON.stringify(e.read());
  return e.run('convFollowAids()').then(() => assert.equal(JSON.stringify(e.read()), before));
});

// --- the follow ---

test('a member whose agent came back in another pane is moved onto it', () => {
  const e = boot({conv: convWith({key: keyFor(OLD), aid: 'a_abc123abc123', label: 'ARCH'}),
                  agents: [pane('w1:p9', {aid: 'a_abc123abc123'})]});
  return e.run('convFollowAids()').then(() => {
    const m = e.read()[0].members;
    assert.equal(m.length, 1, 'the same member, not a second one beside it');
    assert.equal(m[0].key, keyFor(NEW));
    assert.equal(m[0].label, 'ARCH', 'under the name the thread knows it by');
    // `was` is the visible half of the seam: convLandMember records the pane a member continues
    // in the same write that copies its transcript onto the new key.
    assert.deepEqual(m[0].was, ['w1:p1'], 'remembering the pane it continues');
  });
});

test('a member whose agent has no pane is left where it is', () => {
  // Paused, not moved. The row is what a restart is offered from.
  const e = boot({conv: convWith({key: keyFor(OLD), aid: 'a_abc123abc123'}),
                  agents: [pane('w1:p9', {aid: 'a_other0000000'})]});
  return e.run('convFollowAids()').then(() => {
    assert.equal(e.read()[0].members[0].key, keyFor(OLD));
  });
});

test('a member is never moved onto a pane its conversation already names', () => {
  // herdr recycles pane ids and something else may have moved a member a moment ago. Two rows
  // drawing one transcript is the failure convLandMember's own guard exists for, reached here.
  const conv = {id: 'c1', name: 'Charts', members: [
    {key: keyFor(OLD), aid: 'a_abc123abc123'},
    {key: keyFor(NEW), aid: 'a_other0000000'},
  ]};
  const e = boot({conv, agents: [pane('w1:p9', {aid: 'a_abc123abc123'})]});
  return e.run('convFollowAids()').then(() => {
    assert.deepEqual(e.read()[0].members.map(m => m.key), [keyFor(OLD), keyFor(NEW)]);
  });
});

test('a member is never moved onto a pane another member already is', () => {
  // Two rows for one colleague. The conversation names the agent twice — once on the pane it used
  // to be in and once on the pane it is in now — so the follow has a live pane to aim at and a
  // dead member pointing at it. Moving again would keep both rows for ever.
  const e = boot({
    conv: {id: 'c1', name: 'Charts', members: [
      {key: keyFor(OLD), aid: 'a_abc123abc123', label: 'ARCH'},
      {key: keyFor(pane('w1:p5')), aid: 'a_abc123abc123', label: 'ARCH'},
    ]},
    agents: [pane('w1:p9', {aid: 'a_abc123abc123'})]});
  const before = JSON.stringify(e.read());
  return e.run('convFollowAids()').then(() => assert.equal(JSON.stringify(e.read()), before));
});

test('nothing happens before the shared index has arrived', () => {
  // The same reason convLandPending waits: a roster read out of an empty index is one that has
  // not arrived, and moving members against it writes a fabricated one back.
  const e = boot({conv: convWith({key: keyFor(OLD), aid: 'a_abc123abc123'}),
                  agents: [pane('w1:p9', {aid: 'a_abc123abc123'})], pending: true});
  return e.run('convFollowAids()')
    .then(() => assert.equal(e.read()[0].members[0].key, keyFor(OLD)));
});

test('an empty roster is not evidence that anybody moved', () => {
  const e = boot({conv: convWith({key: keyFor(OLD), aid: 'a_abc123abc123'}), agents: []});
  return e.run('convFollowAids()')
    .then(() => assert.equal(e.read()[0].members[0].key, keyFor(OLD)));
});

test('a new member records the agent it was made for', () => {
  const e = boot({conv: convWith({key: 'k'}), agents: []});
  assert.equal(e.run("convMemberOf({pane_id: 'w1:p9', aid: 'a_abc123abc123'}).aid"),
               'a_abc123abc123');
  assert.equal(e.run("convMemberOf({pane_id: 'w1:p9'}).aid"), '',
               'and empty against a relay that mints none');
});
