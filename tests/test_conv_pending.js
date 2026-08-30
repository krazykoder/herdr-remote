// A start in flight, and the note in the conversation index that says what it was for.
//
//   node --test tests/test_conv_pending.js
//
// The relay stamps a client-chosen `ref` on the pane it makes and repeats it on every snapshot, so
// which pane a start produced is a durable, backend-carried fact. What the ref *means* — which
// member of which conversation it was going to continue — used to live in one sessionStorage slot
// with a two-minute deadline, in one tab, cleared by anything that opened the Start dialog. It
// lives in the conversation index now, which is synced and which every tab reads, so a reader who
// presses Restart and then changes view, opens another agent, or reloads still gets their member
// back on the pane the press made.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const KEY = 'herdr_conversations';

// conversation_store.js resolves everything it borrows at call time, so a context holding the few
// things the note store and the landing touch is the whole of what this needs. The index itself is
// real — parsed and written through the module's own loadConvIndex/saveConvIndex — because what is
// being pinned is that a note survives a round trip through storage.
function boot({conv = null, agents = []} = {}) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'src', 'conversation_store.js'), 'utf8');
  const store = {};
  if (conv) store[KEY] = JSON.stringify({version: 1, items: [conv]});
  const log = [];
  const sandbox = {
    console, JSON, Math, Date, Object, Array, Set, Map, String, Number, Promise,
    setTimeout, clearTimeout,
    localStorage: {
      getItem: k => (store[k] === undefined ? null : store[k]),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    agents: agents,
    // conversation_pure.js's, which this module calls but does not define.
    parseConvIndex: raw => {
      try {
        const d = JSON.parse(raw || '');
        return d && d.version === 1 && Array.isArray(d.items) ? d.items : [];
      } catch (e) { return []; }
    },
    convMemberKey: a => (a ? 'k_' + a.pane_id : ''),
    convKeyPaneId: k => String(k || '').replace(/^k_/, ''),
    convMemberOf: a => ({key: 'k_' + a.pane_id, added: 1, label: a.label || '',
                         agent: a.agent || '', project: a.project || ''}),
    convWasFpPatch: () => ({}),
    CONV_WAS_MAX: 20, CONV_CONV_MAX: 50, CONV_ROSTER_MAX: 50,
    paneLabel: a => a.label || a.pane_id,
    repointPair: (old, next) => log.push(['repointPair', old, next.pane_id]),
    convSetView: (a, id) => log.push(['convSetView', a.pane_id, id]),
    convContinueTranscript: () => Promise.resolve(true),
    showSpawnStatus: (t, s) => log.push(['status', t, s]),
    renderConversations: () => log.push(['renderConversations']),
    stateSyncMark: () => {},
    // The immediate push a note asks for, recorded so a test can see it happened.
    flushed: [],
    stateSyncFlush: name => sandbox.flushed.push(name),
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx);
  return {
    log,
    read: () => JSON.parse(store[KEY] || '{"items":[]}').items,
    run: s => vm.runInContext(s, ctx),
  };
}

const CONV = {id: 'c1', name: 'Charts', members: [{key: 'k_w1:p1', label: 'ARCH'}]};

// --- the note ---

test('a note is written on the member the start will continue', () => {
  const e = boot({conv: CONV});
  assert.equal(e.run("convNotePending('c1', 'rABC', 'k_w1:p1', '')"), true);
  const m = e.read()[0].members[0];
  assert.equal(m.pending.ref, 'rABC');
  assert.ok(m.pending.at > 0, 'stamped, because the note has a deadline');
});

test('a note with no member key goes on the conversation, for a start that joins', () => {
  const e = boot({conv: CONV});
  assert.equal(e.run("convNotePending('c1', 'rNEW', '', 'Reviewer')"), true);
  assert.deepEqual(e.read()[0].members[0].pending, undefined, 'and on no member');
  assert.equal(e.read()[0].pending[0].ref, 'rNEW');
  assert.equal(e.read()[0].pending[0].label, 'Reviewer');
});

test('a note against a conversation or a member that is gone is not written', () => {
  const e = boot({conv: CONV});
  assert.equal(e.run("convNotePending('nope', 'rABC', '', '')"), false);
  assert.equal(e.run("convNotePending('c1', 'rABC', 'k_gone', '')"), false);
  assert.equal(e.run('convPendingRefs().size'), 0);
});

test('an expired note is ignored, and pruned by the next write', () => {
  // Ten minutes — long enough for herdr to wait out a cold agent's own startup twice over, and
  // short enough that the pane running an hour later is somebody else's.
  const stale = {id: 'c1', name: 'Charts',
                 members: [{key: 'k_w1:p1', pending: {ref: 'rOLD', at: 1}}],
                 pending: [{ref: 'rALSOOLD', at: 1}]};
  const e = boot({conv: stale});
  assert.equal(e.run('convPendingRefs().size'), 0, 'ignored on read whether or not it is gone yet');
  assert.equal(e.run("convFindPending('rOLD')"), null);
  e.run("convNotePending('c1', 'rNEW', 'k_w1:p1', '')");
  assert.equal(e.read()[0].members[0].pending.ref, 'rNEW', 'and dropped on the way past');
  assert.equal(e.read()[0].pending, undefined);
});

test('two members hold their own notes', () => {
  // One global slot meant the second Restart threw the first one away, which is exactly what
  // Restart all does five times in a row.
  const two = {id: 'c1', name: 'Charts', members: [{key: 'k_w1:p1'}, {key: 'k_w1:p2'}]};
  const e = boot({conv: two});
  e.run("convNotePending('c1', 'rONE', 'k_w1:p1', '')");
  e.run("convNotePending('c1', 'rTWO', 'k_w1:p2', '')");
  assert.deepEqual(Array.from(e.run('convPendingRefs()')).sort(), ['rONE', 'rTWO']);
});

test('a note is found by its ref, and says which member it was for', () => {
  const e = boot({conv: CONV});
  e.run("convNotePending('c1', 'rABC', 'k_w1:p1', '')");
  e.run("convNotePending('c1', 'rNEW', '', 'Reviewer')");
  assert.equal(e.run("convFindPending('rABC').key"), 'k_w1:p1');
  assert.equal(e.run("convFindPending('rNEW').key"), '', 'a join names no member');
  assert.equal(e.run("convFindPending('rNEW').conv.id"), 'c1');
  assert.equal(e.run("convFindPending('rNOPE')"), null);
});

test('a member reports its own note and no one else\'s', () => {
  const two = {id: 'c1', name: 'Charts', members: [{key: 'k_w1:p1'}, {key: 'k_w1:p2'}]};
  const e = boot({conv: two});
  e.run("convNotePending('c1', 'rONE', 'k_w1:p1', '')");
  assert.equal(e.run("convMemberPending('c1', 'k_w1:p1').ref"), 'rONE');
  assert.equal(e.run("convMemberPending('c1', 'k_w1:p2')"), null);
});

test('a note given up on is dropped', () => {
  const e = boot({conv: CONV});
  e.run("convNotePending('c1', 'rABC', 'k_w1:p1', '')");
  assert.equal(e.run("convDropPending('rABC')"), true);
  assert.equal(e.run('convPendingRefs().size'), 0);
  assert.equal(e.run("convDropPending('rABC')"), false, 'and dropping it twice is not an error');
});

// --- the landing ---

test('landing moves the member onto the new pane and spends the note', () => {
  const e = boot({conv: CONV});
  e.run("convNotePending('c1', 'rABC', 'k_w1:p1', '')");
  return e.run("convLandMember({pane_id: 'w1:p9', label: 'ARCH'}, 'c1', 'k_w1:p1', 'rABC')")
    .then(conv => {
      assert.equal(conv.name, 'Charts');
      const m = e.read()[0].members;
      assert.equal(m.length, 1, 'the same member, not a second one beside it');
      assert.equal(m[0].key, 'k_w1:p9');
      assert.equal(m[0].label, 'ARCH', 'under the name the thread knows it by');
      assert.deepEqual(m[0].was, ['w1:p1'], 'and remembering the pane it continues');
      assert.equal(m[0].pending, undefined, 'the note is spent in the same write');
      assert.ok(e.log.some(l => l[0] === 'repointPair' && l[1] === 'w1:p1'));
      assert.ok(e.log.some(l => l[0] === 'convSetView' && l[2] === 'c1'));
    });
});

test('landing with no member to replace joins as a new one', () => {
  const e = boot({conv: CONV});
  e.run("convNotePending('c1', 'rNEW', '', 'Reviewer')");
  return e.run("convLandMember({pane_id: 'w1:p9', label: 'REV'}, 'c1', '', 'rNEW')")
    .then(() => {
      assert.deepEqual(e.read()[0].members.map(m => m.key), ['k_w1:p1', 'k_w1:p9']);
      assert.equal(e.read()[0].pending, undefined);
    });
});

test('landing the same pane twice does not add a second row', () => {
  // herdr recycles pane ids, and a replace key that no longer matches would otherwise append a
  // second member for a key already in the list: two rows, one pane, both drawing one transcript.
  const e = boot({conv: CONV});
  return e.run("convLandMember({pane_id: 'w1:p9'}, 'c1', 'k_w1:p1', '')")
    .then(() => e.run("convLandMember({pane_id: 'w1:p9'}, 'c1', 'k_gone', '')"))
    .then(() => assert.equal(e.read()[0].members.length, 1));
});

test('a snapshot lands every note whose pane has turned up, and nothing else', () => {
  const e = boot({conv: CONV, agents: [{pane_id: 'w1:p9', ref: 'rABC', label: 'ARCH'},
                                       {pane_id: 'w1:p8', ref: 'rOTHER'}]});
  e.run("convNotePending('c1', 'rABC', 'k_w1:p1', '')");
  return e.run('convLandPending()').then(() => {
    assert.equal(e.read()[0].members[0].key, 'k_w1:p9');
    assert.equal(e.run('convPendingRefs().size'), 0);
    assert.ok(!e.log.some(l => l[0] === 'openTerminal'), 'a recovery never moves the reader');
  });
});

test('a snapshot with nothing pending writes nothing', () => {
  const e = boot({conv: CONV, agents: [{pane_id: 'w1:p9', ref: 'rABC'}]});
  return e.run('convLandPending()').then(() => {
    assert.deepEqual(e.read()[0].members.map(m => m.key), ['k_w1:p1']);
    assert.deepEqual(e.log, []);
  });
});

test('a note is pushed to the relay immediately, not after the batching delay', () => {
  // The whole point of a note is that the page it was written on may be gone in a moment. One
  // still sitting in a debounce timer when the tab reloads is a note nothing ever sees — and the
  // pane it was waiting for is then filed into an auto conversation of its own.
  const e = boot({conv: CONV});
  assert.deepEqual(e.run('flushed'), []);
  e.run("convNotePending('c1', 'rNEW', 'k_w1:p1', '')");
  assert.deepEqual(e.run('flushed'), ['conversations']);
});
