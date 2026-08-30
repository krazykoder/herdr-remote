// Starting a session over a roster that is not running yet.
//
// One press means "wake what is missing and then begin". The restarts are the roster panel's own
// restarts — same queue, same durable binding — and what is held is only the send, until every
// slot has a pane. Which makes the trio start (three paused members woken and enrolled) the same
// mechanism as one, rather than a second one.
//
//   node --test tests/test_arb_hold.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'arbitration.js'), 'utf8');

const key = a => JSON.stringify([a.host || '', a.pane_id || '', a.agent || '', a.cwd || '']);

const PANE_A = {pane_id: 'w1:p1', label: 'Architect', agent: 'claude', cwd: '/a', host: 'local'};
const PANE_B = {pane_id: 'w1:p2', label: 'Reviewer', agent: 'codex', cwd: '/b', host: 'local'};
const PANE_C = {pane_id: 'w1:p3', label: 'Arbiter', agent: 'claude', cwd: '/c', host: 'local'};
// What PANE_B comes back as: herdr recycles pane ids, so a restart is a new fingerprint under the
// same member, which is exactly what the hold has to follow.
const PANE_B2 = {pane_id: 'w1:p7', label: 'Reviewer', agent: 'codex', cwd: '/b', host: 'local'};

function ctx({live, members} = {}) {
  const els = {};
  const el = id => els[id] || (els[id] = {
    id, value: '', innerHTML: '', textContent: '', className: '', style: {}, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    classList: {toggle() {}},
  });
  const conv = {id: 'c-1', name: 'Footer', members: members.map(m => ({...m}))};
  const sent = [], toasts = [], restarted = [];
  const g = {
    document: {getElementById: el},
    // The host's, so a test can move the clock the module reads.
    Date,
    console, window: {},
    agents: live,
    activePane: null,
    ws: {readyState: 1, send: s => sent.push(JSON.parse(s))},
    convMemberKey: key,
    paneLabel: a => a.label,
    escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    loadConvIndex: () => [conv],
    saveConvIndex: () => {},
    convCurrentId: () => 'c-1',
    showToast: t => toasts.push(t),
    openTerminal() {}, syncBrowserTab() {}, armButton() {}, sendTextTo() {},
    canStartFromConv: () => true,
    openNewAgent() {},
    convMemberOf: a => ({key: key(a), added: 0, label: a.label}),
    convViewRecs: members.map(m => ({key: m.key, spawn: m.spawn || null})),
    canRespawn: spawn => !!spawn,
    convMemberName: (k, ...rest) => rest.find(Boolean) || '',
    convKeyPaneId: k => JSON.parse(k)[1],
    convRestartQueue: [],
    convRestartStep() { while (g.convRestartQueue.length) restarted.push(g.convRestartQueue.shift()); },
    localStorage: (() => {
      const store = new Map();
      return {getItem: k => (store.has(k) ? store.get(k) : null),
              setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)};
    })(),
    badgeHtml: (label, on, call) => `<button onclick="${call}">${label}</button>`,
  };
  g.globalThis = g;
  vm.createContext(g);
  vm.runInContext(SRC, g);
  g.arbReceiveSessions({type: 'arb_sessions', sessions: []});
  return {g, els, conv, sent, toasts, restarted};
}

// A room of two where one has been closed, and a spare pane to referee.
const ONE_PAUSED = () => ctx({
  live: [PANE_A, PANE_C],
  members: [{key: key(PANE_A), label: 'Architect', spawn: {agent: 'claude'}},
            {key: key(PANE_B), label: 'Reviewer', spawn: {agent: 'codex'}}],
});

function fill(g, {first, second, who}) {
  g.openArbSetup();
  g.document.getElementById('arbScope').value = 'Review the footer.';
  g.document.getElementById('arbFirst').value = first;
  g.document.getElementById('arbSecond').value = second;
  g.document.getElementById('arbWho').value = who;
}

test('a paused pick restarts the member and holds the send', () => {
  const {g, els, sent, restarted} = ONE_PAUSED();
  fill(g, {first: 'w1:p1', second: 'paused:' + key(PANE_B), who: 'w1:p3'});
  g.arbStart();
  assert.deepEqual(restarted, [key(PANE_B)], 'the roster’s own restart, through its own queue');
  assert.deepEqual(sent.filter(m => m.type === 'arb_start'), [], 'and nothing on the wire yet');
  assert.match(els.arbSetupBody.innerHTML, /Waiting for 1 agent to come up/);
  assert.match(els.arbSetupBody.innerHTML, /disabled onclick="arbStart\(\)"/,
               'the button is disabled rather than gone — it is the same form, mid-answer');
});

test('the send goes once the woken member has landed under its new pane', () => {
  const {g, conv, sent} = ONE_PAUSED();
  fill(g, {first: 'w1:p1', second: 'paused:' + key(PANE_B), who: 'w1:p3'});
  g.arbStart();
  // What the landing does: the member keeps its row and takes the new pane's key, with the pane it
  // was is recorded in `was`.
  g.agents.push(PANE_B2);
  conv.members[1] = {key: key(PANE_B2), label: 'Reviewer', was: ['w1:p2']};
  g.arbHoldStep();
  const start = sent.filter(m => m.type === 'arb_start');
  assert.equal(start.length, 1);
  assert.deepEqual(start[0].members.map(m => m.pane_id), ['w1:p1', 'w1:p7'],
                   'the pane it came back as, not the one it was picked by');
  assert.equal(start[0].arbitrator.pane_id, 'w1:p3');
});

test('a member found only by the pane it used to be is still followed', () => {
  // The key moves when the landing runs, and the landing is a different tab away. `was` is the
  // other end of the thread, and it is what the index keeps for exactly this.
  const {g, conv, sent} = ONE_PAUSED();
  fill(g, {first: 'w1:p1', second: 'paused:' + key(PANE_B), who: 'w1:p3'});
  g.arbStart();
  g.agents.push(PANE_B2);
  conv.members[1] = {key: key(PANE_B2), label: 'Reviewer', was: ['w1:p2']};
  // The key the hold is holding is the old one, and the roster no longer has a row under it.
  g.arbHoldStep();
  assert.equal(sent.filter(m => m.type === 'arb_start').length, 1);
});

test('a hold sends nothing until every slot has come up', () => {
  const {g, sent, restarted} = ctx({
    live: [PANE_C],
    members: [{key: key(PANE_A), label: 'Architect', spawn: {agent: 'claude'}},
              {key: key(PANE_B), label: 'Reviewer', spawn: {agent: 'codex'}}],
  });
  fill(g, {first: 'paused:' + key(PANE_A), second: 'paused:' + key(PANE_B), who: 'w1:p3'});
  g.arbStart();
  assert.deepEqual(restarted, [key(PANE_A), key(PANE_B)]);
  g.agents.push(PANE_A);
  g.arbHoldStep();
  assert.deepEqual(sent.filter(m => m.type === 'arb_start'), [], 'one of two is not a roster');
  g.agents.push(PANE_B);
  g.arbHoldStep();
  assert.equal(sent.filter(m => m.type === 'arb_start').length, 1);
});

test('a roster that never comes up gives up and says so, rather than starting half a session', () => {
  const {g, sent, toasts} = ONE_PAUSED();
  fill(g, {first: 'w1:p1', second: 'paused:' + key(PANE_B), who: 'w1:p3'});
  g.arbStart();
  // The clock the module reads — handed in by `ctx`, because a vm otherwise has its own.
  const real = g.Date.now;
  g.Date.now = () => real() + 121000;
  try { g.arbHoldStep(); } finally { g.Date.now = real; }
  assert.deepEqual(sent.filter(m => m.type === 'arb_start'), []);
  assert.match(toasts.at(-1), /did not come up in time/);
  // And it is over: a later landing does not resurrect it.
  g.agents.push(PANE_B2);
  g.arbHoldStep();
  assert.deepEqual(sent.filter(m => m.type === 'arb_start'), []);
});

test('a second press while one is held starts nothing', () => {
  const {g, restarted} = ONE_PAUSED();
  fill(g, {first: 'w1:p1', second: 'paused:' + key(PANE_B), who: 'w1:p3'});
  g.arbStart();
  g.arbStart();
  assert.deepEqual(restarted, [key(PANE_B)], 'one restart, not two');
});

test('a roster with everything already running sends straight away', () => {
  const {g, sent, restarted} = ctx({
    live: [PANE_A, PANE_B, PANE_C],
    members: [{key: key(PANE_A), spawn: {agent: 'claude'}},
              {key: key(PANE_B), spawn: {agent: 'codex'}}],
  });
  fill(g, {first: 'w1:p1', second: 'w1:p2', who: 'w1:p3'});
  g.arbStart();
  assert.deepEqual(restarted, [], 'nothing to wake');
  assert.equal(sent.filter(m => m.type === 'arb_start').length, 1);
});
