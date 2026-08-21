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
  const el = id => els[id] || (els[id] = {id, value: '', innerHTML: '', textContent: '', style: {}});
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
    // Both clocks off unless the form was asked for them: a trigger nobody chose is an
    // unattended loop spending budget on a conversation that had stopped on purpose.
    triggers: {on_turn_end: true, idle_ms: 0, runtime_ms: 0},
  }]);
});

test('the clocks are sent in the unit the relay counts in, not the one the form asks in', () => {
  const {g, els, sent} = ctx();
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  els.arbScope = {id: 'arbScope', value: 'Review the footer.'};
  els.arbWho = {id: 'arbWho', value: 'w1:p3'};
  els.arbIdle = {id: 'arbIdle', value: '15'};
  els.arbRuntime = {id: 'arbRuntime', value: '30'};
  g.arbStart();
  assert.deepEqual(sent[0].triggers,
                   {on_turn_end: true, idle_ms: 900000, runtime_ms: 1800000});
});

test('the arbitrator’s pane is marked, and typing at it is asked twice', () => {
  const {g, toasts} = ctx();
  assert.equal(g.arbMark('w1:p3'), '', 'nothing running, nothing marked');
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  assert.match(g.arbMark('w1:p3'), /⚖/);
  assert.equal(g.arbMark('w1:p1'), '', 'a member is not the arbitrator');

  assert.equal(g.arbGuardSend('w1:p1'), true, 'a member is typed at freely');
  assert.equal(g.arbGuardSend('w1:p3'), false, 'the first send at the arbitrator is held');
  assert.equal(toasts.length, 1);
  assert.equal(g.arbGuardSend('w1:p3'), true, 'the second goes — this arms, it does not forbid');
});

test('arming one arbitrator never arms a later session’s arbitrator', () => {
  const {g} = ctx();
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  assert.equal(g.arbGuardSend('w1:p3'), false);
  const next = {...SESSION, id: 's-next', arbitrator: {pane_id: 'w1:p4', status: 'idle'}};
  g.arbReceiveSession({type: 'arb_session', session: next});
  assert.equal(g.arbGuardSend('w1:p4'), false);
});

test('a blocked arbitrator is said out loud, with the way to its pane', () => {
  // From the strip a blocked arbitrator is indistinguishable from one that is thinking, and the
  // session will not move until somebody answers the prompt in that pane.
  const {g} = ctx();
  const stuck = {...SESSION, state: 'awaiting',
                 arbitrator: {pane_id: 'w1:p3', status: 'blocked'}};
  const html = g.arbStripHtml(stuck, CONV, true, null);
  assert.match(html, /Arbitrator needs you/);
  assert.match(html, /openTerminal\('w1:p3'\)/);
  assert.ok(!/Arbitrator needs you/.test(g.arbStripHtml(SESSION, CONV, true, null)),
            'and an arbitrator that is merely working is not news');
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

test('a frozen arbitrator form is discarded when the reader changes conversation', () => {
  const second = {...CONV, id: 'c-2', name: 'Another conversation'};
  const {g, els} = ctx({convs: [CONV, second]});
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  g.arbToggleForm();
  assert.ok(els.arbStrip.innerHTML.includes('arb-form'));
  g.convCurrentId = () => 'c-2';
  g.arbRender();
  assert.ok(els.arbStrip.innerHTML.includes('⚖ Arbitrate'));
  assert.ok(!els.arbStrip.innerHTML.includes('arb-form'));
});

// The other half of a session a person did not watch: what the thread says about a prompt nobody
// typed. The record grades it by `origin`; the thread grades provenance by `via`, which is the
// field it already draws a transfer's badge from — so an arbitrated send has to arrive spelled the
// thread's way or it renders as something the reader wrote themselves (N8).
test('a prompt the arbitrator delivered is not drawn as one the reader typed', () => {
  const LIVE = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'conv_live.js'), 'utf8');
  const g = {console, window: {}, convMemberKey: key, escapeHtml: String,
             renderConvView() {}, localStorage: {getItem: () => 'on', setItem() {}}};
  g.globalThis = g;
  vm.createContext(g);
  vm.runInContext(LIVE, g);

  g.convLiveReceive({turns: [
    {kind: 'arbitrated', origin: 'arbitrator', text: 'Check the footer on mobile.',
     pane_id: 'w1:p2', agent: 'codex', cwd: '/b', host: 'local', at: 2, at_src: 'sent'},
    {kind: 'human_prompt', origin: 'human_web', text: 'Have a look at this.',
     pane_id: 'w1:p1', agent: 'claude', cwd: '/a', host: 'local', at: 1, at_src: 'sent'},
  ]});
  // Entries come back in the record's own order, which is chronological — so pick them by
  // what they say rather than by where they land.
  const entries = g.convLiveEntries([key(PANE_B), key(PANE_A)]);
  const arbitrated = entries.find(e => e.text.startsWith('Check the footer'));
  const typed = entries.find(e => e.text.startsWith('Have a look'));
  assert.equal(arbitrated.who, 'user', 'a prompt is a prompt, whoever wrote it');
  assert.equal(arbitrated.via, 'arbitrator');
  assert.equal(typed.via, undefined, 'and a person’s own prompt carries no badge');
});

// --- the detail sheet ---------------------------------------------------------------------
//
// The record, the prompt that produced it and the send it caused (§15.3). A keystroke nobody typed
// is only accountable if all three can be read back together, so what this asserts is mostly that
// none of them is quietly dropped.

const DECISION = {
  sequence: 1, at: 1755423862000, valid: true, reject_code: null, gate: 'review', to: 'member-2',
  why: 'Ready for an independent check.', instruction: 'Check the footer on mobile.',
  ambiguity: 'low', complexity: 'low',
  prompt: {trigger: 'turn_end — member-1', at: 1755423861000, body: 'member-1 said: done.'},
  send: {pane_id: 'w1:p2', to: 'member-2', at: 1755423863000, text: 'Please review…'},
};

test('a sheet with no answer yet says so, and an empty session says something else', () => {
  const {g} = ctx();
  assert.match(g.arbDetailHtml(null, SESSION), /Reading the session/);
  assert.match(g.arbDetailHtml([], SESSION), /Nothing decided yet/);
});

test('a decision shows what it decided, what it was shown, and what was typed', () => {
  const {g} = ctx();
  const html = g.arbDetailHtml([DECISION], SESSION);
  assert.match(html, /#1 · review · Reviewer 1/);
  assert.match(html, /Ready for an independent check\./);
  assert.match(html, /ambiguity low · complexity low/);
  assert.match(html, /member-1 said: done\./, 'the prompt it answered');
  assert.match(html, /Check the footer on mobile\./, 'what it wrote');
  assert.match(html, /Please review…/, 'and what was actually typed');
  assert.match(html, /w1:p2/, 'at which pane');
});

test('a refused decision says which rule refused it and shows no send', () => {
  const {g} = ctx();
  const html = g.arbDetailHtml([{...DECISION, valid: false, reject_code: 'unknown_gate',
                                 send: null}], SESSION);
  assert.match(html, /#1 · refused · unknown gate/);
  assert.ok(!html.includes('Please review…'), html);
  assert.ok(!/Nothing recorded as delivered/.test(html), 'a refusal delivered nothing by design');
});

test('a valid decision with no send says the delivery was never confirmed', () => {
  // The one a person has to go and look at: the text probably landed, and the relay will not say
  // that it did.
  const {g} = ctx();
  assert.match(g.arbDetailHtml([{...DECISION, send: null}], SESSION),
               /Nothing recorded as delivered/);
});

test('the newest decision is at the top', () => {
  const {g} = ctx();
  const html = g.arbDetailHtml([DECISION, {...DECISION, sequence: 2, why: 'Second.'}], SESSION);
  assert.ok(html.indexOf('#2') < html.indexOf('#1'), html);
});

test('opening the sheet asks the relay for the session it is open on', () => {
  const {g, els, sent} = ctx();
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  g.arbOpenDetail();
  assert.deepEqual(sent, [{type: 'arb_detail', session: 's-20260817-1103'}]);
  assert.equal(els.arbSheet.style.display, 'block');
  assert.match(els.arbDetailBody.innerHTML, /Reading the session/);

  g.arbReceiveDetail({type: 'arb_detail', session: 's-20260817-1103', decisions: [DECISION]});
  assert.match(els.arbDetailBody.innerHTML, /#1 · review/);
});

test('an answer about another session is not drawn into this sheet', () => {
  const {g, els} = ctx();
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  g.arbOpenDetail();
  g.arbReceiveDetail({type: 'arb_detail', session: 's-other', decisions: [DECISION]});
  assert.match(els.arbDetailBody.innerHTML, /Reading the session/);
});

test('a reconnect closes the sheet rather than leaving another relay’s prose on screen', () => {
  const {g, els} = ctx();
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  g.arbOpenDetail();
  g.arbReset();
  assert.equal(els.arbSheet.style.display, 'none');
  g.arbReceiveDetail({type: 'arb_detail', session: 's-20260817-1103', decisions: [DECISION]});
  assert.match(els.arbDetailBody.innerHTML, /Reading the session/, 'and nothing lands in it after');
});

// A stopped loop has to reach somebody who is not looking at this thread.
//
// The strip says "Paused — call human" and that is the whole of what it said: a person on the pane
// list, in another conversation, or with the tab in the background was told nothing at all, which
// is exactly the person a `call_human` is addressed to.

test('a session that stops announces itself once, not on every poll', () => {
  const {g, toasts} = ctx();
  g.arbReceiveSession({session: SESSION});
  assert.deepStrictEqual(toasts, [], 'a running session is not news');

  const paused = Object.assign({}, SESSION, {
    state: 'paused', pause_reason: 'call_human',
    last_decision: {gate: 'call_human', to: null, why: 'The two disagree about the footer.'},
  });
  g.arbReceiveSession({session: paused});
  assert.strictEqual(toasts.length, 1);
  assert.match(toasts[0], /The two disagree about the footer\./);

  // Every arb_session for the same standing pause — a budget line ticking down, a member changing
  // status — arrives here. An alarm with no off switch is one nobody leaves on.
  g.arbReceiveSession({session: Object.assign({}, paused, {budget: {minutes_left: 43}})});
  assert.strictEqual(toasts.length, 1, 'the pause is announced on the transition, not on the state');
});

test('a pause without a decision behind it still says why it stopped', () => {
  const {g, toasts} = ctx();
  g.arbReceiveSession({session: SESSION});
  g.arbReceiveSession({session: Object.assign({}, SESSION,
    {state: 'paused', pause_reason: 'send_unconfirmed'})});
  assert.match(toasts[0], /send unconfirmed/);
});

test('a paused session is one thing waiting on you; anything else is none', () => {
  const {g} = ctx();
  assert.strictEqual(g.arbNeedsHuman(), false, 'no session at all');
  g.arbReceiveSession({session: SESSION});
  assert.strictEqual(g.arbNeedsHuman(), false, 'a session doing its job is not waiting on anyone');
  g.arbReceiveSession({session: Object.assign({}, SESSION,
    {state: 'paused', pause_reason: 'call_human'})});
  assert.strictEqual(g.arbNeedsHuman(), true);
  // Ended clears the session outright, and a badge for a session that is over is a badge that
  // cannot be cleared by doing anything.
  g.arbReceiveSession({session: Object.assign({}, SESSION, {state: 'ended'})});
  assert.strictEqual(g.arbNeedsHuman(), false);
});
