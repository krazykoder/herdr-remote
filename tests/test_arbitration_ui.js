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

function ctx({live = [PANE_A, PANE_B, PANE_C], convs = [CONV], ready = 1,
              canStart = false} = {}) {
  const els = {};
  const el = id => {
    if (els[id]) return els[id];
    const out = {id, value: '', innerHTML: '', textContent: '', className: '', style: {},
                 hidden: false, title: '', attrs: {},
                 setAttribute(k, v) { out.attrs[k] = v; }, scrollIntoView() {}};
    out.classList = {toggle: (name, on) => {
      const names = new Set(out.className.split(/\s+/).filter(Boolean));
      if (on) names.add(name); else names.delete(name);
      out.className = [...names].join(' ');
    }};
    return (els[id] = out);
  };
  const sent = [], toasts = [], opened = [], spawned = [];
  let tabSyncs = 0;
  const g = {
    document: {getElementById: el},
    console, window: {},
    agents: live,
    // The pane view's own scope: `arbSessionForPane` is what stands in for a conversation there.
    activePane: null,
    ws: {readyState: ready, send: s => sent.push(JSON.parse(s))},
    convMemberKey: key,
    paneLabel: a => a.label,
    escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    loadConvIndex: () => convs,
    convCurrentId: () => 'c-1',
    showToast: t => toasts.push(t),
    openTerminal: paneId => opened.push(paneId),
    syncBrowserTab: () => { tabSyncs++; },
    localStorage: (() => {
      const store = new Map();
      return {getItem: k => (store.has(k) ? store.get(k) : null),
              setItem: (k, v) => store.set(k, String(v)),
              removeItem: k => store.delete(k)};
    })(),
    armButton() {},
    // Starting an agent belongs to the New agent dialog; what arbitration owns is which slot asked
    // and what happens to the pane when it comes up.
    canStartFromConv: () => canStart,
    openNewAgent: slot => spawned.push(slot),
    convMemberOf: a => ({key: key(a), added: 0, label: a.label}),
    saveConvIndex: () => {},
    sendTextTo() {},
    // The real one lives in start_dialog.js, which drags half the app in behind it. What this file
    // asserts about a badge is the two things arbitration puts there — which call it makes and
    // whether it is lit — so it stands in with the same shape rather than loading that module.
    badgeHtml: (label, on, call, opts) =>
      `<button type="button" class="badge pick${(opts || {}).proj ? ' proj' : ''}` +
      `${on ? ' on' : ''}" onclick="${call}" aria-pressed="${on}"` +
      ` title="${(opts || {}).title || ''}">${label}</button>`,
  };
  g.globalThis = g;
  vm.createContext(g);
  vm.runInContext(SRC, g);
  return {g, els, sent, toasts, opened, spawned, tabSyncs: () => tabSyncs};
}

const setupHtml = (g, conv = CONV) =>
  g.arbSetupHtml(g.arbLiveMembers(conv), g.arbCandidates(conv), '');

const classed = (el, name) => el.className.split(/\s+/).includes(name);

test('nothing is drawn until the relay offers the feature', () => {
  const {g, els} = ctx();
  g.arbRender();
  assert.equal(els.arbStrip.innerHTML, '');
  assert.equal(classed(els.convArbitrator, 'on'), false, 'and no way in');
  // And the gate is the message arriving at all, empty list included.
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  assert.equal(classed(els.convArbitrator, 'on'), true);
});

test('a session over another conversation does not stop this one starting its own', () => {
  // This used to draw nothing at all — one loop at a time, so a session anywhere suppressed the
  // Start button everywhere. Sessions are independent now: their own roster, arbitrator, budget
  // and drop directory, and no pane in two of them.
  const {g, els} = ctx();
  // Over its own panes. Sessions share no pane by rule — the relay refuses one that is already
  // enrolled — so a session elsewhere leaves this conversation's three alone.
  const elsewhere = {...SESSION, conversation: 'c-2',
                     members: [{id: 'member-1', pane_id: 'w9:p1'},
                               {id: 'member-2', pane_id: 'w9:p2'}],
                     arbitrator: {pane_id: 'w9:p3'}};
  g.arbReceiveSessions({type: 'arb_sessions', sessions: [elsewhere]});
  g.arbRender();
  assert.equal(els.arbStrip.innerHTML, '', 'no strip: that session is not this conversation’s');
  g.arbOpenFromConv();
  assert.match(els.arbSetupBody.innerHTML, /id="arbWho"/, 'but this one may start its own');
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

test('a paused session is resumed quietly, or with a decision asked for now', () => {
  // The two ways back, because a paused loop has two shapes: one waiting on a turn that will end
  // on its own, and one whose members are all sitting idle — where arming alone is a session that
  // never moves again.
  const {g, sent} = ctx();
  const paused = {...SESSION, state: 'paused', pause_reason: 'user'};
  const html = g.arbStripHtml(paused, CONV, true);
  assert.match(html, /arbCommand\('arb_resume'\)/);
  assert.match(html, /arbCommand\('arb_resume', \{kick: true\}\)/);

  g.arbReceiveSession({session: paused});
  g.arbCommand('arb_resume', {kick: true});
  assert.deepEqual(sent.filter(m => m.type === 'arb_resume'),
                   [{type: 'arb_resume', session: 's-20260817-1103', kick: true}]);
});

test('the last decision is shown by gate, target and why — never its instruction', () => {
  const {g} = ctx();
  const s = {...SESSION, last_decision: {sequence: 1, gate: 'review', to: 'member-2',
                                         why: 'Ready for an independent check.', ambiguity: 'low'}};
  const html = g.arbStripHtml(s, CONV, true, false);
  assert.ok(html.includes('review · Reviewer 1 · Ready for an independent check.'), html);
});

test('an ended session leaves no strip behind', () => {
  const {g, els} = ctx();
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  assert.ok(els.arbStrip.innerHTML.includes('Arbitrating'));
  g.arbReceiveSession({type: 'arb_session', session: {...SESSION, state: 'ended'}});
  assert.equal(els.arbStrip.innerHTML, '');
});

test('a conversation that cannot be arbitrated says which half is missing', () => {
  // v1 runs one shape: two members and an arbitrator outside them. What is missing used to be a
  // tap that did nothing, which is indistinguishable from a broken button. Both of these are
  // things a person can fix, so both are said out loud.
  const one = ctx({live: [PANE_A, PANE_C]});
  one.g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  one.g.arbOpenFromConv();
  assert.match(one.toasts.at(-1), /one live member/);
  assert.equal(one.g.document.getElementById('arbSetupBody').innerHTML, '',
               'and no dialog it would refuse');

  const none = ctx({live: [PANE_A, PANE_B]});
  none.g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  none.g.arbOpenFromConv();
  assert.match(none.toasts.at(-1), /third agent/);
});

test('a conversation of three offers arbitration over a chosen two', () => {
  // The bug this fixes: `live.length !== 2` blanked the strip, so a conversation with a third
  // member had no arbitration and no way to find out why.
  const PANE_D = {pane_id: 'w1:p4', label: 'Architect 2', agent: 'claude', cwd: '/d', host: 'local'};
  const three = {id: 'c-1', name: 'Footer',
                 members: [{key: key(PANE_A)}, {key: key(PANE_B)}, {key: key(PANE_D)}]};
  const {g} = ctx({live: [PANE_A, PANE_B, PANE_C, PANE_D], convs: [three]});
  const form = setupHtml(g, three);
  assert.match(form, /id="arbFirst"/);
  assert.match(form, /id="arbSecond"/);
  assert.match(form, /Architect 2/, 'the third member is a choice, not an exclusion');
});

test('start sends pane ids and a scope, and no identity of its own', () => {
  const {g, els, sent} = ctx();
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  els.arbScope = {id: 'arbScope', value: '  Review the footer.  '};
  els.arbWho = {id: 'arbWho', value: 'w1:p3'};
  els.arbFirst = {id: 'arbFirst', value: 'w1:p1'};
  els.arbSecond = {id: 'arbSecond', value: 'w1:p2'};
  g.arbStart();
  assert.deepEqual(sent, [{
    type: 'arb_start', conversation: 'c-1', scope: 'Review the footer.',
    // The role is the person's own words for what that member is there to do, and is sent even
    // when it is empty: an unroled member is a fact about the roster, not a field to omit.
    members: [{pane_id: 'w1:p1', role: ''}, {pane_id: 'w1:p2', role: ''}],
    arbitrator: {pane_id: 'w1:p3'},
    // Both clocks off unless the form was asked for them: a trigger nobody chose is an
    // unattended loop spending budget on a conversation that had stopped on purpose.
    triggers: {on_turn_end: true, idle_ms: 0, runtime_ms: 0},
    // Briefed and armed, which is the default. `Brief only` is the other half of that badge pair.
    paused: false,
  }]);
});

test('brief only starts the arbitrator paused, and says so on the badge', () => {
  const {g, els, sent} = ctx();
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  const form = () => setupHtml(g);
  assert.match(form(), /aria-pressed="true"[^>]*>Start deciding</, 'armed by default');
  g.arbPickStartPaused(true);
  assert.match(form(), /aria-pressed="true"[^>]*>Brief only</);

  els.arbScope = {id: 'arbScope', value: 'Review the footer.'};
  els.arbWho = {id: 'arbWho', value: 'w1:p3'};
  els.arbFirst = {id: 'arbFirst', value: 'w1:p1'};
  els.arbSecond = {id: 'arbSecond', value: 'w1:p2'};
  g.arbStart();
  assert.equal(sent[0].paused, true);
  g.arbPickStartPaused(false);           // the badge is module state; leave it as it was found
});

test('the clocks are sent in the unit the relay counts in, not the one the form asks in', () => {
  const {g, els, sent} = ctx();
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  els.arbScope = {id: 'arbScope', value: 'Review the footer.'};
  els.arbWho = {id: 'arbWho', value: 'w1:p3'};
  els.arbFirst = {id: 'arbFirst', value: 'w1:p1'};
  els.arbSecond = {id: 'arbSecond', value: 'w1:p2'};
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

test('⚖ goes to this conversation’s arbitrator, and never to another conversation’s', () => {
  const other = {id: 'c-2', name: 'Other', members: []};
  const {g, els, opened, sent} = ctx({convs: [CONV, other]});
  const here = {...SESSION, id: 's-here', arbitrator: {pane_id: 'w1:p2'}};
  const elsewhere = {...SESSION, id: 's-other', conversation: other.id, state: 'paused',
                     members: [{id: 'member-1', pane_id: 'w9:p1'},
                               {id: 'member-2', pane_id: 'w9:p2'}],
                     arbitrator: {pane_id: 'w9:p3'}};
  g.arbReceiveSessions({type: 'arb_sessions', sessions: [elsewhere, here]});
  assert.match(els.convArbitrator.className, /live/, 'this conversation has one, so it is lit');
  g.arbOpenFromConv();
  assert.deepEqual(opened, ['w1:p2'], 'this conversation’s arbitrator');
  g.arbCommand('arb_pause');
  assert.equal(sent.at(-1).session, 's-here', 'controls act on this conversation’s session');

  // The bug this replaces: with nothing arbitrating the conversation on screen, the button used to
  // reach the newest session anywhere and open somebody else's arbitrator.
  g.arbReceiveSession({type: 'arb_session', session: {...here, state: 'ended'}});
  g.arbOpenFromConv();
  assert.deepEqual(opened, ['w1:p2'], 'no second pane was opened');
  assert.ok(!/live/.test(els.convArbitrator.className), 'and the button is not lit for one');
  // It offers to start one instead — this conversation has two live members and a free third.
  assert.match(els.convArbitrator.className, /on/, 'still there — starting one is the other answer');
  assert.match(els.convArbitrator.title, /Start arbitrating/);
  g.arbOpenFromConv();
  assert.ok(els.arbSetupBody.innerHTML.includes('arbScope'), 'the dialog is what it opened');
});

test('the pane button follows the pane, because a pane has no conversation', () => {
  const {g, els, opened} = ctx();
  const session = {...SESSION, arbitrator: {pane_id: 'w1:p3', label: 'Arbiter'}};
  g.arbReceiveSessions({type: 'arb_sessions', sessions: [session]});
  // Not in the session: nothing to go to, so nothing to tap.
  g.activePane = 'w1:p9';
  g.arbRender();
  assert.ok(!/on/.test(els.paneArbitrator.className), 'a pane outside every session gets no button');

  g.activePane = 'w1:p1';           // member-1
  g.arbRender();
  assert.match(els.paneArbitrator.className, /on live/, 'shown, and lit');
  assert.match(els.paneArbitrator.title, /Arbiter/, 'says whose pane it opens');
  g.arbOpenFromPane();
  assert.deepEqual(opened, ['w1:p3']);

  // Standing in the arbitrator's own pane, it has nowhere to go.
  g.activePane = 'w1:p3';
  g.arbOpenFromPane();
  assert.deepEqual(opened, ['w1:p3'], 'no second open');
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

test('a mixed-project roster is refused before it reaches the relay', () => {
  // A slot can start an agent in whichever Project the New agent dialog was left on, so this is
  // now reachable from inside the dialog rather than only by editing a conversation.
  const live = [{...PANE_A, project_id: 'one'}, {...PANE_B, project_id: 'two'},
                {...PANE_C, project_id: 'one'}];
  const {g, els, sent, toasts} = ctx({live});
  els.arbScope = {id: 'arbScope', value: 'Review the footer.'};
  els.arbWho = {id: 'arbWho', value: 'w1:p3'};
  els.arbFirst = {id: 'arbFirst', value: 'w1:p1'};
  els.arbSecond = {id: 'arbSecond', value: 'w1:p2'};
  g.arbStart();
  assert.deepEqual(sent, []);
  assert.match(toasts[0], /same project/);
});

test('the roster is what has to agree on a project, not the conversation around it', () => {
  // The refusal is about the three panes chosen, because that is what the relay checks. Measuring
  // the conversation instead refused a roster it would have accepted — and, with no single
  // project, left the arbitrator list empty and then reported the pick as busy.
  const PANE_D = {pane_id: 'w1:p4', label: 'Elsewhere', agent: 'claude', cwd: '/d', host: 'local',
                  project_id: 'two'};
  const three = {id: 'c-1', name: 'Footer',
                 members: [{key: key(PANE_A)}, {key: key(PANE_B)}, {key: key(PANE_D)}]};
  const live = [{...PANE_A, project_id: 'one'}, {...PANE_B, project_id: 'one'},
                {...PANE_C, project_id: 'one'}, PANE_D];
  const {g, els, sent} = ctx({live, convs: [three]});
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  g.openArbSetup();
  // The two picked agree, so the third one's checkout is somebody else's business — and the
  // arbitrator list is the one their project offers.
  g.document.getElementById('arbFirst').value = 'w1:p1';
  g.document.getElementById('arbSecond').value = 'w1:p2';
  g.document.getElementById('arbScope').value = 'Review the footer.';
  g.document.getElementById('arbWho').value = 'w1:p3';
  assert.deepEqual(g.arbCandidates(three, g.arbPickedProject(three, g.arbReadSetup()))
    .map(x => x.pane_id), ['w1:p3']);
  g.arbStart();
  assert.equal(sent.length, 1, 'and the roster goes');
  assert.equal(sent[0].arbitrator.pane_id, 'w1:p3');
});

test('a pane another session already holds is not offered, and not sent', () => {
  // The relay refuses an enrolled pane (`participant_in_session`), a paused session included — a
  // pause is not a release. Offering one here is offering a refusal, and two arbitrators over one
  // terminal is the failure that rule exists to prevent.
  const PANE_D = {pane_id: 'w1:p4', label: 'Spare', agent: 'claude', cwd: '/d', host: 'local'};
  const {g, els, sent, toasts} = ctx({live: [PANE_A, PANE_B, PANE_C, PANE_D]});
  g.arbReceiveSessions({type: 'arb_sessions', sessions: [
    {...SESSION, id: 's-other', conversation: 'c-9', state: 'paused',
     members: [{id: 'member-1', pane_id: 'w1:p1'}, {id: 'member-2', pane_id: 'w1:p2'}],
     arbitrator: {pane_id: 'w1:p3'}}]});
  g.openArbSetup();
  assert.equal(/w1:p3/.test(els.arbSetupBody.innerHTML), false, 'nor its arbitrator');
  assert.equal(/w1:p1/.test(els.arbSetupBody.innerHTML), false, 'nor its members');
  assert.match(els.arbSetupBody.innerHTML, /w1:p4/, 'and the spare is still a choice');

  // And said, not merely absent: a stale selection is what a form drawn seconds ago holds.
  g.document.getElementById('arbScope').value = 'Review the footer.';
  g.document.getElementById('arbFirst').value = 'w1:p1';
  g.document.getElementById('arbSecond').value = 'w1:p4';
  g.document.getElementById('arbWho').value = 'w1:p3';
  g.arbStart();
  assert.deepEqual(sent.filter(m => m.type === 'arb_start'), []);
  assert.match(toasts.at(-1), /already in another arbitration/);
});

test('the session being edited is not treated as a conflict with itself', () => {
  const {g, els} = ctx();
  g.arbReceiveSessions({type: 'arb_sessions', sessions: [SESSION]});
  g.arbEditHere();
  // Its own three panes are the answer to "who is this session watching", not a clash with it —
  // the form that opened with an empty arbitrator list was the bug hiding taken panes would
  // otherwise have introduced.
  assert.match(els.arbSetupBody.innerHTML, /id="arbFirst"[\s\S]*?value="w1:p1"/);
  assert.match(els.arbSetupBody.innerHTML, /id="arbWho"[\s\S]*?value="w1:p3" selected/);
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
  g.openArbSetup();
  const drawn = els.arbSetupBody.innerHTML;
  assert.ok(drawn.includes('arbScope'), drawn);

  live[3].status = 'working';
  g.arbRender();
  assert.equal(els.arbSetupBody.innerHTML, drawn);
});

test('an arbitrator that went busy while the scope was written is said out loud', () => {
  const live = [PANE_A, PANE_B, {...PANE_C}];
  const {g, els, sent, toasts} = ctx({live});
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  g.openArbSetup();
  g.document.getElementById('arbScope').value = 'Review the footer.';
  g.document.getElementById('arbWho').value = 'w1:p3';
  g.document.getElementById('arbFirst').value = 'w1:p1';
  g.document.getElementById('arbSecond').value = 'w1:p2';
  live[2].status = 'working';
  g.arbStart();
  assert.deepEqual(sent, []);
  assert.equal(toasts.length, 1);
  assert.match(els.arbSetupBody.innerHTML, /Review the footer\./,
               'and the scope is written back into the dialog it redrew');
});

test('pause, resume and cancel name the session the relay assigned', () => {
  const {g, sent} = ctx();
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  g.arbCommand('arb_pause');
  g.arbCommand('arb_cancel');
  // Reads filtered out: a session arriving also asks for its decisions, because the thread draws
  // bubbles from them. What this test is about is what a button puts on the wire.
  assert.deepEqual(sent.filter(m => m.type !== 'arb_detail'),
                   [{type: 'arb_pause', session: 's-20260817-1103'},
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
  const {g, els} = ctx();
  g.arbReceiveSession({type: 'arb_session', session: SESSION});
  assert.ok(els.arbStrip.innerHTML.includes('Arbitrating'));
  g.arbReset();
  assert.equal(els.arbStrip.innerHTML, '',
               'the element is cleared, and nothing redraws until the next arb_sessions');
  assert.equal(classed(els.convArbitrator, 'on'), false, 'and no way in until it does');
});

test('a frozen arbitrator form is discarded when the reader changes conversation', () => {
  const second = {...CONV, id: 'c-2', name: 'Another conversation'};
  const {g, els} = ctx({convs: [CONV, second]});
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  g.openArbSetup();
  assert.ok(els.arbSetupBody.innerHTML.includes('arbScope'));
  assert.equal(els.arbModal.style.display, 'block');
  g.convCurrentId = () => 'c-2';
  g.arbRender();
  assert.equal(els.arbModal.style.display, 'none', 'a Start here would land in another thread');
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
  // Twice: the thread asked when the session arrived, because it draws bubbles from the same
  // rows, and the sheet asks again because somebody is looking at it now — the held copy can be a
  // poll old, and a rejected record never moves `last_decision` for the thread's ask to notice.
  g.arbOpenDetail();
  assert.deepEqual(sent, [{type: 'arb_detail', session: 's-20260817-1103'},
                          {type: 'arb_detail', session: 's-20260817-1103'}]);
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
  const {g, toasts, tabSyncs} = ctx();
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
  assert.strictEqual(tabSyncs(), 3, 'each session update refreshes tab count and favicon');
});

test('a paused session received at reconnect refreshes tab chrome without re-alerting', () => {
  const {g, toasts, tabSyncs} = ctx();
  g.arbReceiveSessions({sessions: [Object.assign({}, SESSION, {state: 'paused'})]});
  assert.strictEqual(toasts.length, 0, 'a standing pause does not chime again on reconnect');
  assert.strictEqual(tabSyncs(), 1);
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

// --- Reusing an arbitrator ----------------------------------------------------------------------
//
// The expensive thing in a session is the arbitrator: a pane, a brief, a budget and everything it
// has already decided. Ending a session to change one member threw all of it away. These pin the
// edit that replaces that.

const CREW_SESSION = Object.assign({}, SESSION, {
  members: [{id: 'member-1', label: 'Architect 1', pane_id: 'w1:p1', agent: 'claude',
             status: 'idle', role: 'review'},
            {id: 'member-2', label: 'Reviewer 1', pane_id: 'w1:p2', agent: 'codex',
             status: 'idle', role: 'fix-code'}],
  arbitrator: {pane_id: 'w1:p3', status: 'idle', label: 'Arbiter', agent: 'claude'},
});

test('a running session is edited through the form that appointed it', () => {
  const PANE_D = {pane_id: 'w1:p4', label: 'Architect 2', agent: 'claude', cwd: '/d', host: 'local'};
  const three = {id: 'c-1', name: 'Footer',
                 members: [{key: key(PANE_A)}, {key: key(PANE_B)}, {key: key(PANE_D)}]};
  const {g, els, sent} = ctx({live: [PANE_A, PANE_B, PANE_C, PANE_D], convs: [three]});
  g.arbReceiveSession({session: CREW_SESSION});
  g.arbEditHere();

  const html = els.arbSetupBody.innerHTML;
  // The same three questions, opened on the answers the session already has — and its own panes
  // are still choosable in it, because a session is not a conflict with itself.
  assert.match(html, /Get the footer reviewed\./);
  assert.match(html, /id="arbWho"[\s\S]*?value="w1:p3" selected/);
  assert.match(html, /id="arbSecond"[\s\S]*?value="w1:p2" selected/);
  assert.match(html, /onclick="arbSave\(\)"/);
  // Not the arming choice: a running session has been armed or not already, and Pause and Resume
  // on the strip are where that is changed.
  assert.equal(/On start/.test(html), false);

  Object.assign(els, {
    arbScope: {value: 'Get the footer reviewed.'}, arbWho: {value: 'w1:p3'},
    arbFirst: {value: 'w1:p1'}, arbSecond: {value: 'w1:p4'},
    arbRoleFirst: {value: 'review'}, arbRoleSecond: {value: 'fix-code'},
    arbIdle: {value: '0'}, arbRuntime: {value: '0'},
  });
  g.arbSave();
  // Only the roster: the scope and the clocks were not touched, and naming them would re-announce
  // a change nobody made.
  assert.deepEqual(sent.filter(m => m.type === 'arb_edit'),
                   [{type: 'arb_edit', session: 's-20260817-1103',
                     members: [{pane_id: 'w1:p1', role: 'review'},
                               {pane_id: 'w1:p4', role: 'fix-code'}]}]);
});

test('what a session is for can be rewritten, and a new arbitrator appointed', () => {
  const {g, els, sent} = ctx();
  g.arbReceiveSession({session: CREW_SESSION});
  g.arbEditHere();
  Object.assign(els, {
    arbScope: {value: 'Get the footer reviewed, then stop.'}, arbWho: {value: 'w1:p3'},
    arbFirst: {value: 'w1:p1'}, arbSecond: {value: 'w1:p2'},
    arbRoleFirst: {value: 'review'}, arbRoleSecond: {value: 'fix-code'},
    arbIdle: {value: '15'}, arbRuntime: {value: '0'},
  });
  g.arbSave();
  assert.deepEqual(sent.filter(m => m.type === 'arb_edit'),
                   [{type: 'arb_edit', session: 's-20260817-1103',
                     scope: 'Get the footer reviewed, then stop.',
                     triggers: {on_turn_end: true, idle_ms: 900000, runtime_ms: 0}}]);
});

test('a form nobody changed sends nothing, and still closes', () => {
  const {g, els, sent} = ctx();
  g.arbReceiveSession({session: CREW_SESSION});
  g.arbEditHere();
  Object.assign(els, {
    arbScope: {value: 'Get the footer reviewed.'}, arbWho: {value: 'w1:p3'},
    arbFirst: {value: 'w1:p1'}, arbSecond: {value: 'w1:p2'},
    arbRoleFirst: {value: 'review'}, arbRoleSecond: {value: 'fix-code'},
    arbIdle: {value: '0'}, arbRuntime: {value: '0'},
  });
  g.arbSave();
  assert.deepEqual(sent.filter(m => m.type === 'arb_edit'), []);
  assert.equal(els.arbModal.style.display, 'none');
});

test('what each member is for is asked, sent, and shown on the strip', () => {
  const {g, els, sent} = ctx();
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  const html = setupHtml(g);
  assert.match(html, /id="arbRoleFirst"/);
  assert.match(html, /id="arbRoleSecond"/);
  // A badge per tag, and the phrase it writes as its tooltip: the tag is what fits on a pill and
  // the phrase is what the arbitrator is actually shown.
  assert.match(html, /onclick="arbPickRole\('arbRoleFirst', 'review-only'\)"/);
  assert.match(html, /title="review only"/);

  els.arbScope = {id: 'arbScope', value: 'Review the footer.'};
  els.arbWho = {id: 'arbWho', value: 'w1:p3'};
  els.arbFirst = {id: 'arbFirst', value: 'w1:p1'};
  els.arbSecond = {id: 'arbSecond', value: 'w1:p2'};
  // Overlapping on purpose — two agents that can both review is what keeps the loop moving when
  // one of them is busy. The browser sends the words; normalising them is the relay's job.
  els.arbRoleFirst = {id: 'arbRoleFirst', value: ' review, fix-code '};
  els.arbRoleSecond = {id: 'arbRoleSecond', value: 'review'};
  g.arbStart();
  assert.deepEqual(sent[0].members, [{pane_id: 'w1:p1', role: 'review, fix-code'},
                                     {pane_id: 'w1:p2', role: 'review'}]);
});

test('the brief can be given again, and is asked twice before it is', () => {
  const {g, sent} = ctx();
  g.arbReceiveSession({session: SESSION});
  const html = g.arbStripHtml(SESSION, CONV, true, null);
  assert.match(html, /arbCommand\('arb_reinit'\)/);
  // Armed like End is: it empties the arbitrator's context, which is not undoable.
  assert.match(html, /class="arb-btn arm-btn"[^>]*Re-brief\?/);
  g.arbCommand('arb_reinit');
  assert.deepEqual(sent.filter(m => m.type === 'arb_reinit'),
                   [{type: 'arb_reinit', session: 's-20260817-1103'}]);
});

// --- A slot that starts its own agent ------------------------------------------------------------
//
// A room is often assembled from nothing: two fresh agents and something to decide between them.
// Leaving the dialog to start each one loses every answer already in it, so each slot starts its
// own — and the new pane lands in the slot that asked, with the page where it was.

test('a slot offers to start its own agent only where the relay will start one', () => {
  assert.equal(/\+ New/.test(setupHtml(ctx().g)), false, 'a relay that starts nothing offers none');
  const {g, spawned} = ctx({canStart: true});
  const html = setupHtml(g);
  assert.equal((html.match(/arbSpawnFor/g) || []).length, 3, 'one per slot');
  g.arbSpawnFor('arbFirst');
  assert.deepEqual(spawned, ['arbFirst'], 'and it is the New agent dialog that starts it');
});

test('a pane started for a member slot joins the conversation and is chosen there', () => {
  const PANE_D = {pane_id: 'w1:p4', label: 'Architect 2', agent: 'claude', cwd: '/d', host: 'local'};
  const conv = {...CONV, members: [{key: key(PANE_A)}, {key: key(PANE_B)}]};
  const {g, els, opened} = ctx({live: [PANE_A, PANE_B, PANE_C, PANE_D], convs: [conv],
                                canStart: true});
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  g.openArbSetup();
  g.document.getElementById('arbScope').value = 'Half a sen';
  g.arbAdoptStarted(PANE_D, {slot: 'arbSecond', conv: 'c-1'});

  assert.equal(conv.members.length, 3, 'a member of the conversation, because that is what it is');
  assert.match(els.arbSetupBody.innerHTML,
               /id="arbSecond"[\s\S]*?value="w1:p4" selected/, 'and chosen in the slot that asked');
  assert.match(els.arbSetupBody.innerHTML, /Half a sen/, 'with everything already answered kept');
  assert.deepEqual(opened, [], 'nothing is opened — the dialog is half filled in');
});

test('an arbitrator started for the slot stands outside the conversation, and is held while it boots', () => {
  const PANE_D = {pane_id: 'w1:p4', label: 'Arbiter 2', agent: 'claude', cwd: '/d', host: 'local',
                  status: 'working'};
  const conv = {...CONV, members: [{key: key(PANE_A)}, {key: key(PANE_B)}]};
  const {g, els} = ctx({live: [PANE_A, PANE_B, PANE_C, PANE_D], convs: [conv], canStart: true});
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  g.openArbSetup();
  g.arbAdoptStarted(PANE_D, {slot: 'arbWho', conv: 'c-1'});

  assert.equal(conv.members.length, 2,
               'the arbitrator is not a participant — it decides what happens between them');
  // Still `working` while its TUI comes up, which is what drops a pane out of the candidate list.
  assert.deepEqual(g.arbCandidates(conv).map(x => x.pane_id), ['w1:p3']);
  assert.match(els.arbSetupBody.innerHTML, /id="arbWho"[\s\S]*?value="w1:p4" selected/,
               'but the slot the person just filled does not empty itself under them');
});

test('an empty conversation can still be assembled, and two projects still cannot', () => {
  const empty = {id: 'c-1', name: 'Nothing yet', members: []};
  const cannot = ctx({convs: [empty]});
  cannot.g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  cannot.g.arbOpenFromConv();
  assert.match(cannot.toasts.at(-1), /none live/, 'with no way to start one, that is the answer');

  const can = ctx({convs: [empty], canStart: true});
  can.g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  can.g.arbOpenFromConv();
  assert.match(can.els.arbSetupBody.innerHTML, /\+ New/, 'with one, the room is a slot away');

  // The one refusal no new pane fixes: the conversation's own members are in two repositories.
  const p = (a, id) => Object.assign({}, a, {project_id: id});
  const split = ctx({live: [p(PANE_A, 'proj-a'), p(PANE_B, 'proj-b'), p(PANE_C, 'proj-a')],
                     canStart: true});
  split.g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  split.g.arbOpenFromConv();
  assert.match(split.toasts.at(-1), /everyone in one project/);
  assert.equal(split.g.document.getElementById('arbSetupBody').innerHTML, '');
});

test('a badge writes its phrase into the line, and a second tap takes it out again', () => {
  const {g, els} = ctx();
  // Pure, so the toggle can be pinned without a DOM: the line is the value and the badges only
  // ever read it back.
  assert.equal(g.arbRoleToggle('', 'review only'), 'review only');
  assert.equal(g.arbRoleToggle('review only', 'no code writing'),
               'review only, no code writing');
  assert.equal(g.arbRoleToggle('review only, no code writing', 'review only'), 'no code writing');
  // A phrase typed by hand lights its badge, whatever case it was typed in — the field is the
  // truth and the badges are a view of it.
  assert.ok(g.arbRoleHas('Review Only, minimal focused test', 'review only'));
  assert.ok(!g.arbRoleHas('reviewed', 'review only'), 'a phrase, not a substring');

  els.arbRoleFirst = {id: 'arbRoleFirst', value: ''};
  g.arbPickRole('arbRoleFirst', 'review-only');
  g.arbPickRole('arbRoleFirst', 'no-code');
  g.arbPickRole('arbRoleFirst', 'test-min');
  assert.equal(els.arbRoleFirst.value, 'review only, no code writing, minimal focused test');
  assert.match(els.arbRoleFirstPills.innerHTML, /aria-pressed="true"[^>]*>#review-only</);
  g.arbPickRole('arbRoleFirst', 'no-code');
  assert.equal(els.arbRoleFirst.value, 'review only, minimal focused test');
});

test('a running session says what each member is for, and the form opens on it', () => {
  const roled = Object.assign({}, CREW_SESSION, {members: [
    {id: 'member-1', pane_id: 'w1:p1', label: 'Architect 1', status: 'idle', role: 'review'},
    {id: 'member-2', pane_id: 'w1:p2', label: 'Reviewer 1', status: 'idle', role: 'fix-code'},
  ]});
  const {g, els, sent} = ctx();
  g.arbReceiveSession({session: roled});
  assert.match(g.arbStripHtml(roled, CONV, true),
               /Architect 1 \(review\) · Reviewer 1 \(fix-code\)/);

  // The form opens on what the roster already says, so an edit that only swaps a pane does not
  // quietly drop the roles the person typed the first time.
  g.arbEditHere();
  const html = els.arbSetupBody.innerHTML;
  assert.match(html, /id="arbRoleFirst"[^>]*value="review"/);
  assert.match(html, /id="arbRoleSecond"[^>]*value="fix-code"/);

  Object.assign(els, {
    arbScope: {value: 'Get the footer reviewed.'}, arbWho: {value: 'w1:p3'},
    arbFirst: {value: 'w1:p1'}, arbSecond: {value: 'w1:p2'},
    arbRoleFirst: {value: 'review'}, arbRoleSecond: {value: 'plan, fix-code'},
    arbIdle: {value: '0'}, arbRuntime: {value: '0'},
  });
  g.arbSave();
  assert.deepEqual(sent.filter(m => m.type === 'arb_edit')[0].members,
                   [{pane_id: 'w1:p1', role: 'review'},
                    {pane_id: 'w1:p2', role: 'plan, fix-code'}]);
});

test('one agent cannot be both halves of a conversation', () => {
  const {g, els, sent, toasts} = ctx();
  g.arbReceiveSession({session: CREW_SESSION});
  g.arbEditHere();
  Object.assign(els, {
    arbScope: {value: 'Get the footer reviewed.'}, arbWho: {value: 'w1:p3'},
    arbFirst: {value: 'w1:p1'}, arbSecond: {value: 'w1:p1'},
    arbRoleFirst: {value: 'review'}, arbRoleSecond: {value: 'fix-code'},
    arbIdle: {value: '0'}, arbRuntime: {value: '0'},
  });
  g.arbSave();
  assert.deepEqual(sent.filter(m => m.type === 'arb_edit'), []);
  assert.equal(toasts.length, 1);
});

// --- The arbitrator in the thread ---------------------------------------------------------------
//
// Drawn, never enrolled. What is rendered is what it *decided* — not what its pane was showing —
// and nothing here touches the conversation's members or its record.

const DECISIONS = [
  {sequence: 1, at: 1000, valid: true, gate: 'review', to: 'member-2',
   why: 'The footer is ready for a look.', send: {pane_id: 'w1:p2'}},
  {sequence: 2, at: 2000, valid: false, reject_code: 'unknown_member', why: 'nonsense'},
  {sequence: 3, at: 3000, valid: true, gate: 'call_human', to: null,
   why: 'The two disagree and the scope does not cover it.', send: null},
];

function withDecisions() {
  const c = ctx();
  c.g.arbReceiveSession({session: CREW_SESSION});
  c.g.arbReceiveDetail({session: 's-20260817-1103', decisions: DECISIONS});
  return c;
}

test('a decision is drawn under the agent’s own name, never as member-2', () => {
  const {g} = withDecisions();
  const entries = g.arbThreadEntries('c-1');
  assert.deepEqual(entries.map(e => e.to), ['Reviewer 1', 'you']);
  assert.deepEqual(entries.map(e => e.toAgent), ['codex', '']);
  // Why this one and not the other: the roles are the person's instruction about who does what,
  // so the decision reads as an answer to it rather than a coin toss.
  assert.deepEqual(entries.map(e => e.toRole), ['fix-code', '']);
  assert.deepEqual(entries.map(e => e.who), ['arbiter', 'arbiter']);
  assert.equal(entries[0].text, 'The footer is ready for a look.');
  assert.equal(entries[0].gate, 'review');
});

test('a record the relay refused is not a step in the conversation', () => {
  const {g} = withDecisions();
  assert.equal(g.arbThreadEntries('c-1').length, 2, 'the rejected one stays in the sheet');
});

test('a delivery the relay could not prove is marked, not assumed', () => {
  const {g} = withDecisions();
  assert.deepEqual(g.arbThreadEntries('c-1').map(e => e.delivered), [true, false]);
});

test('the arbitrator is drawn in its own session’s thread and no other', () => {
  const {g} = withDecisions();
  assert.deepEqual(g.arbThreadEntries('c-2'), []);
  assert.deepEqual(g.arbThreadEntries(''), []);
});

test('hiding the arbitrator empties the thread of it and leaves the conversation alone', () => {
  const {g, convs} = withDecisions();
  const before = JSON.stringify(CONV);
  g.toggleArbBubbles();
  assert.deepEqual(g.arbThreadEntries('c-1'), []);
  assert.equal(g.arbBubblesOn(), false);
  g.toggleArbBubbles();
  assert.equal(g.arbThreadEntries('c-1').length, 2, 'and comes back');
  assert.equal(JSON.stringify(CONV), before, 'the conversation was never written to');
});

test('a thread with no answer yet draws no arbitrator rather than an empty one', () => {
  const {g} = ctx();
  g.arbReceiveSession({session: CREW_SESSION});
  assert.deepEqual(g.arbThreadEntries('c-1'), []);
});

// --- One project ---------------------------------------------------------------------------------
//
// The relay refuses a roster that spans two, so a picker that offered one would be offering a
// refusal. With no Projects configured no pane carries one, and this cannot exclude anything.

test('an arbitrator is only offered from the conversation’s own project', () => {
  const p = (a, id) => Object.assign({}, a, {project_id: id});
  const {g, toasts} = ctx({live: [p(PANE_A, 'proj-a'), p(PANE_B, 'proj-a'), p(PANE_C, 'proj-b')]});
  assert.deepEqual(g.arbCandidates(CONV), [], 'the only free pane is in another repository');
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  g.arbOpenFromConv();
  assert.match(toasts.at(-1), /third agent in this project/);
});

test('a conversation that spans two projects says so instead of offering a session', () => {
  const p = (a, id) => Object.assign({}, a, {project_id: id});
  const {g, toasts} = ctx({live: [p(PANE_A, 'proj-a'), p(PANE_B, 'proj-b'), p(PANE_C, 'proj-a')]});
  assert.equal(g.arbProject(CONV), null);
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  g.arbOpenFromConv();
  assert.match(toasts.at(-1), /everyone in one project/);
});

test('with no projects configured every free pane is still a candidate', () => {
  const {g} = ctx();
  assert.deepEqual(g.arbCandidates(CONV).map(x => x.pane_id), ['w1:p3']);
});
