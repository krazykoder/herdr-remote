// What the browser draws about an arbitration session, and what it puts on the wire to start one.
//
// The states worth pinning are the ones nobody is sitting in front of: a session paused at 3am, a
// session running over a conversation the reader is not looking at, a relay with the feature off.
// All three are "draw nothing" or "draw exactly this", and both are cheap to assert here and
// expensive to notice in a browser.
//
//   node --test tests/test_arbitration_ui.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'arbitration.js'), 'utf8');

const PANE_A = {pane_id: 'w1:p1', label: 'Architect 1', agent: 'claude', cwd: '/a', host: 'local'};
const PANE_B = {pane_id: 'w1:p2', label: 'Reviewer 1', agent: 'codex', cwd: '/b', host: 'local'};
const PANE_C = {pane_id: 'w1:p3', label: 'Arbiter', agent: 'claude', cwd: '/c', host: 'local'};

const key = a => JSON.stringify([a.host || '', a.pane_id || '', a.agent || '', a.cwd || '']);

const CONV = {id: 'c-1', name: 'Footer', members: [{key: key(PANE_A)}, {key: key(PANE_B)}]};

const SESSION = {
  id: 's-20260817-1103', state: 'active', pause_reason: null, conversation: 'c-1',
  scope: 'Get the footer reviewed.',
  members: [{id: 'member-1', label: 'Architect 1', pane_id: 'w1:p1', status: 'idle'},
            {id: 'member-2', label: 'Reviewer 1', pane_id: 'w1:p2', status: 'working'}],
  arbitrator: {pane_id: 'w1:p3', status: 'idle'},
  budget: {steps_left: 7, consecutive_left: 3, minutes_left: 44},
  last_decision: null,
};

function ctx({live = [PANE_A, PANE_B, PANE_C], convs = [CONV], ready = 1} = {}) {
  const els = {};
  const el = id => els[id] || (els[id] = {id, value: '', innerHTML: '', textContent: ''});
  const sent = [], toasts = [];
  const g = {
    document: {getElementById: el},
    console, window: {},
    agents: live,
    ws: {readyState: ready, send: s => sent.push(JSON.parse(s))},
    convMemberKey: key,
    paneLabel: a => a.label,
    escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    loadConvIndex: () => convs,
    convCurrentId: () => 'c-1',
    showToast: t => toasts.push(t),
    armButton() {},
  };
  g.globalThis = g;
  vm.createContext(g);
  vm.runInContext(SRC, g);
  return {g, els, sent, toasts};
}

test('nothing is drawn until the relay offers the feature', () => {
  const {g} = ctx();
  assert.equal(g.arbStripHtml(null, CONV, false, false), '');
  // And the gate is the message arriving at all, empty list included.
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  assert.ok(g.arbStripHtml(null, CONV, true, false).includes('Arbitrate'));
});

test('a session over another conversation draws nothing here', () => {
  const {g} = ctx();
  const elsewhere = {...SESSION, conversation: 'c-2'};
  assert.equal(g.arbStripHtml(elsewhere, CONV, true, false), '');
});

test('a running session shows its state, budget and one way to stop it', () => {
  const {g} = ctx();
  const html = g.arbStripHtml(SESSION, CONV, true, false);
  assert.ok(html.includes('Arbitrating'), html);
  assert.ok(html.includes('7 steps · 44 min'), html);
  assert.ok(html.includes('arb_pause'), html);
  assert.ok(html.includes('arb_cancel'), html);
  assert.ok(!html.includes('arb_resume'), 'a running session is not offered a Resume');
});

test('a paused session says why, and offers Resume instead of Pause', () => {
  const {g} = ctx();
  const html = g.arbStripHtml({...SESSION, state: 'paused', pause_reason: 'budget_steps'},
                              CONV, true, false);
  assert.ok(html.includes('Paused — budget steps'), html);
  assert.ok(html.includes('arb_resume'), html);
  assert.ok(!html.includes('arb_pause'), html);
});

test('the last decision is shown by gate, target and why — never its instruction', () => {
  const {g} = ctx();
  const s = {...SESSION, last_decision: {sequence: 1, gate: 'review', to: 'member-2',
                                         why: 'Ready for an independent check.', ambiguity: 'low'}};
  const html = g.arbStripHtml(s, CONV, true, false);
  assert.ok(html.includes('review · Reviewer 1 · Ready for an independent check.'), html);
});

test('an ended session leaves no strip behind', () => {
  const {g} = ctx();
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  g.arbReceiveSession({type: 'arb_session', session: {...SESSION, state: 'ended'}});
  assert.equal(g.arbStripHtml(null, CONV, true, false).includes('Arbitrating'), false);
});

test('a conversation that is not two live panes is not offered arbitration', () => {
  // v1 runs one shape: two members and an arbitrator outside them. Everything else gets no
  // button rather than a refusal after the tap.
  assert.equal(ctx({live: [PANE_A, PANE_C]}).g.arbStripHtml(null, CONV, true, false), '');
  assert.equal(ctx({live: [PANE_A, PANE_B]}).g.arbStripHtml(null, CONV, true, false), '',
               'no pane outside the conversation is no arbitrator');
});

test('start sends pane ids and a scope, and no identity of its own', () => {
  const {g, els, sent} = ctx();
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  els.arbScope = {id: 'arbScope', value: '  Review the footer.  '};
  els.arbWho = {id: 'arbWho', value: 'w1:p3'};
  g.arbStart();
  assert.deepEqual(sent, [{
    type: 'arb_start', conversation: 'c-1', scope: 'Review the footer.',
    members: [{pane_id: 'w1:p1'}, {pane_id: 'w1:p2'}],
    arbitrator: {pane_id: 'w1:p3'},
  }]);
});

test('an empty scope is refused here rather than on the wire', () => {
  const {g, els, sent, toasts} = ctx();
  els.arbScope = {id: 'arbScope', value: '   '};
  els.arbWho = {id: 'arbWho', value: 'w1:p3'};
  g.arbStart();
  assert.deepEqual(sent, []);
  assert.equal(toasts.length, 1);
});

test('an arbitrator that is not a live candidate is refused', () => {
  const {g, els, sent} = ctx();
  els.arbScope = {id: 'arbScope', value: 'Review the footer.'};
  els.arbWho = {id: 'arbWho', value: 'w1:p1'};   // a member, not a candidate
  g.arbStart();
  assert.deepEqual(sent, []);
});

test('a working or blocked pane is not offered as the arbitrator', () => {
  for (const status of ['working', 'blocked']) {
    const live = [PANE_A, PANE_B, {...PANE_C, status}];
    const {g, els, sent} = ctx({live});
    els.arbScope = {id: 'arbScope', value: 'Review the footer.'};
    els.arbWho = {id: 'arbWho', value: 'w1:p3'};
    g.arbStart();
    assert.deepEqual(sent, [], status);
  }
});

test('an open form is not rebuilt when a candidate changes status under it', () => {
  // The candidate list is derived from live pane status, so it moves whenever any pane does.
  // Rebuilding this element would take a half-written scope away with it — which is the whole
  // reason the form freezes the list it was opened on.
  const live = [PANE_A, PANE_B, {...PANE_C}, {...PANE_C, pane_id: 'w1:p4', label: 'Spare'}];
  const {g, els} = ctx({live});
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  g.arbToggleForm();
  const drawn = els.arbStrip.innerHTML;
  assert.ok(drawn.includes('arbScope'), drawn);

  live[3].status = 'working';
  g.arbRender();
  assert.equal(els.arbStrip.innerHTML, drawn);
});

test('an arbitrator that went busy while the scope was written is said out loud', () => {
  const live = [PANE_A, PANE_B, {...PANE_C}];
  const {g, els, sent, toasts} = ctx({live});
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  g.arbToggleForm();
  g.document.getElementById('arbScope').value = 'Review the footer.';
  g.document.getElementById('arbWho').value = 'w1:p3';
  live[2].status = 'working';
  g.arbStart();
  assert.deepEqual(sent, []);
  assert.equal(toasts.length, 1);
  assert.equal(g.document.getElementById('arbScope').value, 'Review the footer.',
               'the scope is kept');
});

test('pause, resume and cancel name the session the relay assigned', () => {
  const {g, sent} = ctx();
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  g.arbCommand('arb_pause');
  g.arbCommand('arb_cancel');
  assert.deepEqual(sent, [{type: 'arb_pause', session: 's-20260817-1103'},
                          {type: 'arb_cancel', session: 's-20260817-1103'}]);
});

test('nothing is sent with no session, and nothing is sent with no socket', () => {
  const {g, sent} = ctx();
  g.arbCommand('arb_pause');
  assert.deepEqual(sent, []);

  const down = ctx({ready: 3});
  down.g.arbReceiveSession({type: 'arb_session', session: SESSION});
  down.g.arbCommand('arb_pause');
  assert.deepEqual(down.sent, []);
  assert.equal(down.toasts.length, 1);
});

test('a reconnect drops the capability rather than remembering it', () => {
  const {g} = ctx();
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  g.arbReset();
  assert.equal(g.arbStripHtml(null, CONV, true, false).includes('Arbitrate'), true,
               'the pure function still draws what it is handed');
  g.arbRender();
  assert.equal(g.document.getElementById('arbStrip').innerHTML, '',
               'but the element is cleared, and nothing redraws until the next arb_sessions');
});
