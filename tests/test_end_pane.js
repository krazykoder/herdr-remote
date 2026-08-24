// Ending a session: the two lines End types, and when the second one goes.
//
//   node --test tests/test_end_pane.js
//
// There is no relay verb for this. End is `/quit` at an agent and then `exit` at the shell herdr
// leaves behind, and the only thing that says the first line worked is a poll snapshot showing the
// pane has moved out of `agents` and into `shells`. That gap is the whole of what is worth pinning
// here, because it is where a plausible implementation goes wrong:
//
//   - sending both lines back to back, so `exit` lands in the agent's composer instead of a shell;
//   - watching for ever, so a pane that ignored `/quit` is silently never reported;
//   - watching a relay that lists no shells at all, where the second line can never be sent;
//   - typing at a blocked pane, whose box is a permission prompt the relay refuses text at.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', f), 'utf8');

const NAMES = ['endPane', 'endShell', 'endTick', 'endConversation', 'endPending',
               'END_TIMEOUT_MS'];

// submitText lives in controls.js itself, so it is not stubbed — the socket under it is, and what
// a test reads is the `send_text` that reached the wire. Closer to the truth than a stub, and it
// keeps the chunking and the `submit` flag inside what is being checked. Everything from another
// module is stubbed, so a failure here points at End rather than at one of them.
function harness({agents = [], shells = [], terminal = true, socket = true, convs = []} = {}) {
  const wire = [];
  const sent = wire;
  const toasts = [];
  let now = 1000;
  const ctx = vm.createContext({
    console,
    agents, shells,
    startOptions: terminal ? {agents: ['claude'], terminal: true} : {agents: ['claude']},
    activePane: null,
    paneOf: id => agents.find(a => a.pane_id === id) || shells.find(s => s.pane_id === id) || null,
    isShell: id => shells.some(s => s.pane_id === id),
    paneLabel: a => a.label || a.agent || a.pane_id,
    convMemberKey: a => JSON.stringify([a.host || '', a.pane_id || '', a.agent || '', a.cwd || '']),
    loadConvIndex: () => convs,
    ws: socket ? {readyState: 1, send: m => {
      const msg = JSON.parse(m);
      wire.push([msg.pane_id, msg.text]);
    }} : null,
    chunkText: text => [text],
    burstPoll: () => {},
    showToast: (text) => { toasts.push(text); },
    Date: {now: () => now},
    // armFire and the header's own controls are not exercised here; the block defines them, so the
    // context needs whatever they close over at load time and nothing more.
    // controls.js wires the header's own controls at load. None of them is exercised here, so every
    // node is the same inert stub — what this suite reads is what was sent, not what was drawn.
    document: {
      getElementById: () => ({addEventListener: () => {}, style: {}, dataset: {},
                              classList: {add: () => {}, remove: () => {}, toggle: () => {}}}),
      addEventListener: () => {},
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  vm.runInContext(src('controls.js') + `\n;__out = {${NAMES.join(', ')}};`, ctx);
  return Object.assign({}, ctx.__out, {
    sent, toasts,
    // The clock End reads, so a test can walk past the timeout without waiting for it.
    advance: ms => { now += ms; },
    // A poll landing: what the next snapshot says the two lists are.
    snapshot: (nextAgents, nextShells) => {
      agents.length = 0;
      for (const a of nextAgents) agents.push(a);
      shells.length = 0;
      for (const s of nextShells) shells.push(s);
    },
  });
}

const AGENT = {pane_id: '%1', agent: 'claude', label: 'Architect 1', status: 'idle', host: 'local'};
const SHELL = {pane_id: '%1', label: 'Architect 1', host: 'local'};

test('an agent is told to quit, and nothing else until a snapshot says it did', () => {
  const h = harness({agents: [AGENT]});
  assert.equal(h.endPane('%1'), true);
  assert.deepEqual(h.sent, [['%1', '/quit']]);
  // The pane is still an agent on this poll — the TUI is on its way out. A second line here would
  // land in the composer of an agent that has not gone yet.
  h.endTick();
  assert.deepEqual(h.sent, [['%1', '/quit']]);
});

test('the shell it leaves behind is exited on the snapshot that shows it', () => {
  const h = harness({agents: [AGENT]});
  h.endPane('%1');
  h.snapshot([], [SHELL]);
  h.endTick();
  assert.deepEqual(h.sent, [['%1', '/quit'], ['%1', 'exit']]);
  // And once. A pane already sent `exit` is no longer watched, so the poll after it is quiet.
  h.snapshot([], [SHELL]);
  h.endTick();
  assert.deepEqual(h.sent, [['%1', '/quit'], ['%1', 'exit']]);
});

test('a pane herdr closed itself is not chased', () => {
  // Some harnesses close their own pane on /quit. It is gone from both lists, which is where this
  // was trying to get to — so there is nothing to send and nothing to report.
  const h = harness({agents: [AGENT]});
  h.endPane('%1');
  h.snapshot([], []);
  h.endTick();
  assert.deepEqual(h.sent, [['%1', '/quit']]);
  assert.equal(h.toasts.filter(t => /did not quit/.test(t)).length, 0);
});

test('an agent that ignores the line is given up on, and said so', () => {
  const h = harness({agents: [AGENT]});
  h.endPane('%1');
  h.advance(h.END_TIMEOUT_MS + 1);
  h.endTick();
  assert.deepEqual(h.sent, [['%1', '/quit']]);
  assert.match(h.toasts.at(-1), /did not quit/);
  // Given up on, not retried on the next poll.
  h.endTick();
  assert.equal(h.toasts.filter(t => /did not quit/.test(t)).length, 1);
});

test('a shell is one line and no watching', () => {
  const h = harness({shells: [SHELL]});
  assert.equal(h.endPane('%1'), true);
  assert.deepEqual(h.sent, [['%1', 'exit']]);
  h.snapshot([], [SHELL]);
  h.endTick();
  assert.deepEqual(h.sent, [['%1', 'exit']]);
});

test('a blocked pane is not typed at', () => {
  // Its box is a permission prompt and the relay refuses send_text there. Answering it is the
  // user's one tap, and saying so is more use than a send that goes nowhere.
  const h = harness({agents: [Object.assign({}, AGENT, {status: 'blocked'})]});
  assert.equal(h.endPane('%1'), false);
  assert.deepEqual(h.sent, []);
  assert.match(h.toasts.at(-1), /waiting on a prompt/);
});

test('with terminal mode off it stops at one line and says the pane may remain', () => {
  // The relay lists no shells, so the pane leaves `agents` and turns up nowhere — there is no
  // second snapshot to act on. Watching for one would mean reporting "did not quit" 30s later
  // about a pane that quit immediately.
  const h = harness({agents: [AGENT], terminal: false});
  assert.equal(h.endPane('%1'), true);
  assert.deepEqual(h.sent, [['%1', '/quit']]);
  assert.match(h.toasts.at(-1), /may remain/);
  h.snapshot([], []);
  h.endTick();
  assert.deepEqual(h.sent, [['%1', '/quit']]);
});

test('a pane that is already gone is not an error', () => {
  const h = harness({});
  assert.equal(h.endPane('%1'), false);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.toasts, []);
});

test('a send the socket refused is not watched for', () => {
  const h = harness({agents: [AGENT], socket: false});
  assert.equal(h.endPane('%1'), false);
  assert.deepEqual(h.sent, []);
  h.snapshot([], [SHELL]);
  h.endTick();
  assert.deepEqual(h.sent, []);
});

// --- what the button is drawn from ---
//
// A send in flight is the third state of every End button: the word, the question, then Ending…
// greyed while this is true. There is no fourth — a failure is this going false again, which is
// what puts the word back rather than a state of its own.

test('a pane with a send in flight is pending, and stops being when it is given up on', () => {
  const h = harness({agents: [AGENT]});
  assert.equal(h.endPending('%1'), false);
  h.endPane('%1');
  assert.equal(h.endPending('%1'), true, 'Ending… from the moment the line goes out');
  // Still on its way: the agent is out but its shell has not been sent `exit` yet.
  h.snapshot([], [SHELL]);
  h.endTick();
  assert.equal(h.endPending('%1'), true, 'and across both halves of the exit');
  h.advance(h.END_TIMEOUT_MS + 1);
  h.endTick();
  assert.equal(h.endPending('%1'), false, 'and back to End once it is given up on');
});

test('a pane that goes is not left pending', () => {
  const h = harness({agents: [AGENT]});
  h.endPane('%1');
  h.snapshot([], []);
  h.endTick();
  assert.equal(h.endPending('%1'), false);
});

test('a pane on a relay that lists no shells is pending, and never reported', () => {
  // The second line can never be timed there, so the deadline is what ends the wait — quietly.
  // A toast saying it did not quit would be about a pane that quit immediately.
  const h = harness({agents: [AGENT], terminal: false});
  h.endPane('%1');
  assert.equal(h.endPending('%1'), true);
  h.advance(h.END_TIMEOUT_MS + 1);
  h.endTick();
  assert.equal(h.endPending('%1'), false);
  assert.equal(h.toasts.filter(t => /did not quit/.test(t)).length, 0);
});

test('ending a conversation ends its live members and leaves the ended one alone', () => {
  const a = {pane_id: '%1', agent: 'claude', label: 'One', status: 'idle', host: 'local', cwd: '/w'};
  const b = {pane_id: '%2', agent: 'codex', label: 'Two', status: 'idle', host: 'local', cwd: '/w'};
  const key = x => JSON.stringify([x.host, x.pane_id, x.agent, x.cwd]);
  const dead = JSON.stringify(['local', '%9', 'claude', '/w']);
  const h = harness({
    agents: [a, b],
    convs: [{id: 'c1', members: [{key: key(a)}, {key: key(b)}, {key: dead}]}],
  });
  assert.equal(h.endConversation('c1'), true);
  assert.deepEqual(h.sent, [['%1', '/quit'], ['%2', '/quit']]);
});

test('ending a conversation with nothing live says so and sends nothing', () => {
  const dead = JSON.stringify(['local', '%9', 'claude', '/w']);
  const h = harness({convs: [{id: 'c1', members: [{key: dead}]}]});
  assert.equal(h.endConversation('c1'), false);
  assert.deepEqual(h.sent, []);
  assert.match(h.toasts.at(-1), /still running/);
});
