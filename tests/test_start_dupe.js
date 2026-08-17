// Duplicate, and start-a-session-to-pair-with, over a stub DOM.
//
// Both bypass parts of the start dialog, so the message they put on the wire is the thing worth
// pinning: the relay refuses an agent outside its allowlist, an unknown role, and any field the
// placement did not ask for. The other half is what happens when the session finally lands —
// which of the two intents claims it, and what happens when neither does. Runs the block straight
// out of web/index.html so the single-file app keeps its no-build-step property, the same trick
// tests/test_bottom_dock.js uses.
//
//   node --test tests/test_start_dupe.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const PAIRS_PURE = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'pairs_pure.js'), 'utf8');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'start_dialog.js'), 'utf8');

const PANE = {
  pane_id: 'w1:p1', label: 'Architect 1', agent: 'claude', project_id: 'proj',
  project: 'charts', workspace_id: 'w1', host: 'local',
};

// A fresh context per test: pendingStart and startIntent are module state and an abandoned
// dialog's intent must not leak into the next one.
function startCtx({pane = PANE, options = {roles: ['architect', 'reviewer', 'agent'], agents: ['claude', 'codex']}, pairs = []} = {}) {
  const els = {};
  const el = id => els[id] || (els[id] =
    {id, value: '', textContent: '', hidden: false, style: {}, options: [], disabled: false});
  const sent = [];
  const calls = [];
  const live = pane ? [pane] : [];
  // The pair half of the dialog, stubbed to the two things this block reads back off it: which
  // pane the dialog is open on, and whether saving closed it. The real savePair is covered in
  // tests/test_pairs.js and in the browser.
  const g = {
    document: {getElementById: el},
    localStorage: {getItem: () => null, setItem() {}},
    window: {}, console,
    clearTimeout() {}, setTimeout: () => 1,
    ws: {send: s => sent.push(JSON.parse(s))},
    agents: live,
    shells: [],
    startOptions: options,
    activePane: pane ? pane.pane_id : null,
    slotFor: () => 'wide',
    paneOf: id => live.find(a => a.pane_id === id) || null,
    openTerminal: id => calls.push(['open', id]),
    openPairDialog: id => { calls.push(['pair', id]); g.pairSource = live.find(a => a.pane_id === id); },
    choosePartner: id => { calls.push(['partner', id]); g.pairPartner = live.find(a => a.pane_id === id); },
    savePair: () => { calls.push(['save']); g.pairSource = null; },
    pairs,
    pairSource: null,
    pairPartner: null,
    pairFor: (list, id) => list.find(p => p.members.some(m => m.pane_id === id)) || null,
    projects: [{id: 'proj', label: 'charts'}],
    fillSelect: () => 1,
    renderStartTarget() {},
    agentColor: () => 'var(--blue)',
  };
  const ctx = vm.createContext(g);
  vm.runInContext(PAIRS_PURE, ctx);
  vm.runInContext(SRC, ctx);
  return {el, sent, calls, g, run: src => vm.runInContext(src, ctx)};
}

test('a duplicate carries the pane\'s harness into the pane\'s own tab', () => {
  const {sent, run} = startCtx();
  run('duplicatePane()');
  assert.deepEqual(sent, [{
    type: 'start_agent', name: 'claude', role: 'architect', project_id: 'proj',
    placement: 'new_tab', slot: 'wide', workspace_id: 'w1',
  }]);
  // No label: the relay names it for the role, so the copy is "Architect 2" and not a second
  // pane wearing the first one's name.
  assert.ok(!('label' in sent[0]));
});

test('a pane whose workspace the snapshot does not name gets its own', () => {
  const {sent, run} = startCtx({pane: {...PANE, workspace_id: null}});
  run('duplicatePane()');
  assert.equal(sent[0].placement, 'new_workspace');
  // new_workspace takes no target field — the relay rejects the message outright if one rides along.
  assert.ok(!('workspace_id' in sent[0]));
});

test('the role comes off the label, and a renamed pane falls back rather than sending nonsense', () => {
  assert.equal(startCtx({pane: {...PANE, label: 'Reviewer 3'}}).run('roleOf(agents[0])'), 'reviewer');
  assert.equal(startCtx({pane: {...PANE, label: 'nightly build'}}).run('roleOf(agents[0])'), 'architect');
  assert.equal(startCtx({pane: {...PANE, label: null}}).run('roleOf(agents[0])'), 'architect');
});

test('nothing to duplicate is offered when the relay would only refuse it', () => {
  const no = (over, opts) => {
    const {sent, run} = startCtx({pane: {...PANE, ...over}, ...(opts || {})});
    assert.equal(run('canDuplicate(agents[0])'), false);
    run('duplicatePane()');
    assert.deepEqual(sent, [], 'sent a start the relay would have refused');
  };
  no({agent: 'gemini'});             // outside HERDR_START_AGENTS
  no({agent: null});                 // a terminal has no harness to copy
  no({project_id: null});            // cwd comes from the Project, so there has to be one
  no({}, {options: null});           // write extensions off
});

test('a duplicate lands in the new session even though the old one is open', () => {
  const {calls, run} = startCtx();
  run('duplicatePane()');
  run("agents.push({pane_id: 'w1:p2', label: 'Architect 2', agent: 'claude'}); pendingStart = 'w1:p2'; openPendingStart()");
  assert.deepEqual(calls, [['open', 'w1:p2']], 'the pane the user asked for is the one they get');
});

test('a plain start still defers to the pane the user is reading', () => {
  const {calls, run} = startCtx();
  run("agents.push({pane_id: 'w1:p2'}); pendingStart = 'w1:p2'; openPendingStart()");
  assert.deepEqual(calls, [], 'no intent means do not yank them out of it');
  run("activePane = null; pendingStart = 'w1:p2'; openPendingStart()");
  assert.deepEqual(calls, [['open', 'w1:p2']]);
});

test('start-and-pair comes back to the dialog with the new session chosen, and saves it', () => {
  const {calls, run} = startCtx();
  run("startIntent = {pair: 'w1:p1'}");
  run("agents.push({pane_id: 'w1:p2'}); pendingStart = 'w1:p2'; openPendingStart()");
  // The pair the button named is made, not left as a form. Asking to start a session *and pair
  // with it* is the whole decision; a dialog waiting on Save is the request half-done.
  assert.deepEqual(calls, [['pair', 'w1:p1'], ['partner', 'w1:p2'], ['save']]);
});

test('a pane already in a pair is never replaced without being asked', () => {
  // savePair drops whichever pair holds either pane. That is fine as an answer to a Save the user
  // pressed and unacceptable as one nobody was asked — so the dialog is left open on the warning.
  const existing = [{id: 'p1', name: 'Old pair', members: [{pane_id: 'w1:p1'}, {pane_id: 'w0:p9'}]}];
  const {calls, g, run} = startCtx({pairs: existing});
  run("startIntent = {pair: 'w1:p1'}");
  run("agents.push({pane_id: 'w1:p2'}); pendingStart = 'w1:p2'; openPendingStart()");
  assert.deepEqual(calls, [['pair', 'w1:p1'], ['partner', 'w1:p2']], 'saved over an existing pair');
  assert.ok(g.pairSource, 'the dialog closed on a pair the user has not confirmed');
});

test('an intent is spent once, so the next start is a plain one', () => {
  const {calls, run} = startCtx();
  run("startIntent = {pair: 'w1:p1'}");
  run("agents.push({pane_id: 'w1:p2'}); pendingStart = 'w1:p2'; openPendingStart()");
  run("agents.push({pane_id: 'w1:p3'}); pendingStart = 'w1:p3'; openPendingStart()");
  assert.deepEqual(calls.slice(3), [], 'the second start reopened the pair dialog');
});

test('opening the dialog any other way clears an abandoned intent', () => {
  const {run} = startCtx();
  run("startIntent = {pair: 'w1:p1'}; openStartDialog('proj')");
  assert.equal(run('startIntent'), null);
});

test('a pair source that has since exited leaves the session opened, not stranded', () => {
  const {calls, run} = startCtx();
  run("startIntent = {pair: 'gone'}");
  run("agents.push({pane_id: 'w1:p2'}); activePane = null; pendingStart = 'w1:p2'; openPendingStart()");
  assert.deepEqual(calls, [['open', 'w1:p2']]);
});

test('a start the poll has not seen yet stays pending', () => {
  const {calls, run} = startCtx();
  run("pendingStart = 'w9:p9'; openPendingStart()");
  assert.deepEqual(calls, []);
  assert.equal(run('pendingStart'), 'w9:p9', 'dropping it would strand the session for good');
});
