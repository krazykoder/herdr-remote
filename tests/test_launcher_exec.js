// Pressing a launcher tile: what goes on the wire, in what order, and what the user was shown
// before any of it did.
//
//   node --test tests/test_launcher_exec.js
//
// launcher_exec.js is the wiring and nothing else — every payload is built by launcher_pure under
// launcherStrict. So what is worth pinning here is the sequencing, which is the part that has no
// other guard: a `run` is two messages with a pane id discovered between them, and a multi-member
// spawn is one message per member with the *next* one only sent once the last has landed. A loop
// that did not wait would collide on next_role_label and hand back a roster nobody picked.
//
// The relay is a recording stub. The pane a start would produce is handed back by calling
// openPendingStart's launcher branch directly — the poll snapshot is status_bar's business and
// tests/e2e/browser covers it.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', f), 'utf8');
const PURE = src('launcher_pure.js');
const STORE = src('launcher_store.js');
const EXEC = src('launcher_exec.js');

const NAMES = ['launcherPress', 'launcherConfirmLines', 'launcherFailed', 'launcherLanded',
               'saveLauncher', 'launcherGate'];

const PROJECTS = [{id: 'p1', label: 'herdr', host: 'local'},
                  {id: 'p2', label: 'mini', host: 'box'}];
const OPTIONS = {agents: ['claude', 'codex'], roles: ['agent'], terminal: true};

// Everything launcher_exec reaches for that lives in another module. Stubbed rather than pulled
// in: this suite is about the order of the sends, and dragging conversation_store and shortcuts
// in behind it would make a failure here point at either of them.
function press({tiles, answer = true, projects = PROJECTS, startOptions = OPTIONS,
                open = true, convs = [], arb = true} = {}) {
  const sent = [];
  const log = [];
  const store = {};
  const ctx = vm.createContext({
    console,
    SEND_TEXT_MAX: 4000,
    CONV_CONV_MAX: 20,
    projects, startOptions,
    // arbitration.js's own gate — whether this relay sent arb_sessions on this connection — and
    // its one-line sender, which is the only thing launcher_exec uses out of that whole module.
    arbOn: arb,
    arbSend: m => sent.push(m),
    // Two states worth having: a socket that takes messages, and one that is not there at all.
    ws: open ? {readyState: 1, send: m => sent.push(JSON.parse(m))} : null,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    confirm: text => { log.push(['confirm', text]); return answer; },
    showToast: t => log.push(['toast', t]),
    showSpawnStatus: (t, s) => log.push(['status', t, s]),
    openTerminal: id => log.push(['openTerminal', id]),
    openConversation: id => log.push(['openConversation', id]),
    sendTextTo: (id, text) => { log.push(['sendTextTo', id, text]); return true; },
    noteTermCommand: t => log.push(['noteTermCommand', t]),
    isShell: () => true,
    renderConversations: () => log.push(['renderConversations']),
    convSetView: (a, id) => log.push(['convSetView', a.pane_id, id]),
    convMemberOf: a => ({key: 'k_' + a.pane_id, label: a.label}),
    loadConvIndex: () => convs.slice(),
    saveConvIndex: items => { convs.length = 0; convs.push(...items); },
    stateSyncMark: () => {},
    // start_dialog owns these two. Declared here so the exec block can assign them, and readable
    // afterwards so a test can see which intent a start was made under.
    startIntent: null,
  });
  vm.runInContext(PURE + '\n' + STORE + '\n' + EXEC + `\n;__out = {${NAMES.join(', ')}};`, ctx);
  const out = vm.runInContext('__out', ctx);
  out.saveLauncher(tiles);
  return {
    sent, log, convs, out,
    press: id => vm.runInContext(`launcherPress(${JSON.stringify(id)})`, ctx),
    intent: () => vm.runInContext('startIntent', ctx),
    // A pane arriving for whatever intent is currently set — which is what openPendingStart does
    // after the poll has seen it.
    land: pane => vm.runInContext('(async () => { const i = startIntent; startIntent = null;'
      + ' await launcherLanded(' + JSON.stringify(pane) + ', i.ql); })()', ctx),
    fail: () => vm.runInContext('launcherFailed()', ctx),
  };
}

const RUN = {id: 'ql_a', label: 'Tests', action: 'run', project_id: 'p1',
             command: 'npm test'};
const ONE = {id: 'ql_b', label: 'Solo', action: 'spawn', project_id: 'p1',
             members: [{name: 'claude', role: 'agent'}]};
const THREE = {id: 'ql_c', label: 'Trio', action: 'spawn', project_id: 'p2',
               members: [{name: 'claude', role: 'agent', label: 'A'},
                         {name: 'codex', role: 'agent', label: 'B'},
                         {name: 'claude', role: 'agent', label: 'C'}]};

const pane = (id, label) => ({pane_id: id, label: label || id, agent: 'claude'});
const kinds = sent => sent.map(m => m.type);

// --- The confirm ---

test('the confirm quotes the command rather than describing it', () => {
  const p = press({tiles: [RUN]});
  p.press('ql_a');
  const text = p.log.find(l => l[0] === 'confirm')[1];
  assert.match(text, /new terminal on herdr/);
  assert.ok(text.includes('npm test'), 'the command itself, verbatim');
});

test('the confirm names the host when the Project is not local', () => {
  const p = press({tiles: [THREE]});
  p.press('ql_c');
  const text = p.log.find(l => l[0] === 'confirm')[1];
  assert.match(text, /on mini on box/);
  assert.match(text, /claude, codex, claude/, 'and the whole roster');
  assert.match(text, /one at a time/);
});

test('the confirm never carries a path, because the relay never sent one', () => {
  // public_projects strips cwd on purpose (D4): where a Project points is the relay's, and a
  // confirm claiming to show a path would be showing one the browser made up.
  const p = press({tiles: [RUN]});
  p.press('ql_a');
  assert.deepEqual(p.out.launcherConfirmLines(RUN, {projects: PROJECTS}),
    ['Run this in a new terminal on herdr?', '', 'npm test']);
});

test('saying no sends nothing at all', () => {
  const p = press({tiles: [RUN], answer: false});
  assert.equal(p.press('ql_a'), false);
  assert.deepEqual(p.sent, []);
  assert.equal(p.intent(), null, 'and leaves no intent for the next start to inherit');
});

// --- What refuses before the confirm ---

test('a tile whose gate is shut says why instead of asking', () => {
  // Terminal mode off. The tile is already drawn with this reason in its title, so a press is a
  // stale render or a keyboard reaching an aria-disabled button — and a button that does nothing
  // is worse than one that says why.
  const p = press({tiles: [RUN], startOptions: {agents: ['claude'], terminal: false}});
  assert.equal(p.press('ql_a'), false);
  assert.deepEqual(p.log, [['toast', 'Terminal mode is off on this relay']]);
  assert.deepEqual(p.sent, []);
});

test('a tile pointing at a Project this relay has never heard of does not dispatch', () => {
  const p = press({tiles: [Object.assign({}, RUN, {project_id: 'gone'})]});
  assert.equal(p.press('ql_a'), false);
  assert.equal(p.log[0][1], 'That Project is not configured on this relay');
  assert.deepEqual(p.sent, []);
});

test('a closed socket refuses rather than asking a question it cannot act on', () => {
  const p = press({tiles: [RUN], open: false});
  assert.equal(p.press('ql_a'), false);
  assert.deepEqual(p.log, [['toast', 'Not connected — nothing was started.']]);
});

test('a tile that is not there is not a crash', () => {
  const p = press({tiles: [RUN]});
  assert.equal(p.press('ql_nope'), false);
  assert.deepEqual(p.sent, []);
});

// --- run ---

test('a run opens a terminal, then types the command into the pane it got back', () => {
  const p = press({tiles: [RUN]});
  assert.equal(p.press('ql_a'), true);
  assert.deepEqual(p.sent, [{type: 'open_terminal', project_id: 'p1',
                             placement: 'new_workspace', label: 'Tests'}]);
  assert.deepEqual(p.intent().ql.command, 'npm test', 'the command waits for a pane to type it at');
  return p.land(pane('w1:p1')).then(() => {
    assert.deepEqual(p.log.filter(l => l[0] === 'sendTextTo'),
      [['sendTextTo', 'w1:p1', 'npm test']]);
    assert.ok(p.log.some(l => l[0] === 'openTerminal' && l[1] === 'w1:p1'),
      'and the user lands on it');
    assert.ok(p.log.some(l => l[0] === 'noteTermCommand'),
      'recorded in the terminal history, because it is a command the user ran');
  });
});

test('the command is sent through sendTextTo, not straight down the socket', () => {
  // sendTextTo is where the arbitration guard, the chunk cap and the record of what the user sent
  // all live. A launcher press is the user typing a command by proxy, so it goes the same way.
  const p = press({tiles: [RUN]});
  p.press('ql_a');
  return p.land(pane('w1:p1')).then(() => {
    assert.deepEqual(kinds(p.sent), ['open_terminal'], 'no send_text was written directly');
  });
});

// --- spawn, one member ---

test('one member is one start_agent and no conversation', () => {
  const p = press({tiles: [ONE]});
  assert.equal(p.press('ql_b'), true);
  assert.deepEqual(p.sent, [{type: 'start_agent', name: 'claude', role: 'agent',
                             project_id: 'p1', placement: 'new_workspace'}]);
  return p.land(pane('w2:p1', 'Agent 1')).then(() => {
    assert.ok(p.log.some(l => l[0] === 'openTerminal' && l[1] === 'w2:p1'));
    assert.deepEqual(p.convs, [], 'a conversation of one has nothing to compare');
    assert.equal(p.press('ql_b'), true, 'and the launcher is free again straight away');
  });
});

test('a member carries its own label, never the tile’s', () => {
  // Three panes sharing the tile's name would be three collisions the relay has to rename its
  // way out of, and a roster the user did not pick.
  const p = press({tiles: [THREE]});
  p.press('ql_c');
  assert.equal(p.sent[0].label, 'A');
});

// --- spawn, several members ---

test('members go out one at a time, each after the last has landed', async () => {
  const p = press({tiles: [THREE]});
  p.press('ql_c');
  assert.equal(p.sent.length, 1, 'one in flight, not three');
  assert.equal(p.sent[0].name, 'claude');
  await p.land(pane('w1:p1'));
  assert.equal(p.sent.length, 2, 'the second only after the first landed');
  assert.equal(p.sent[1].name, 'codex');
  await p.land(pane('w2:p1'));
  assert.deepEqual(p.sent.map(m => m.label), ['A', 'B', 'C'], 'and in the order the tile lists');
  await p.land(pane('w3:p1'));
  assert.equal(p.sent.length, 3, 'and stops at the roster');
});

test('every start in a batch is made under a launcher intent, so nothing else claims the pane', async () => {
  const p = press({tiles: [THREE]});
  p.press('ql_c');
  assert.equal(p.intent().ql.tile.id, 'ql_c');
  await p.land(pane('w1:p1'));
  assert.equal(p.intent().ql.tile.id, 'ql_c', 'the second start too');
  assert.equal(p.intent().ql.batch.sent, 2, 'and the cursor moved with it');
});

test('the last member lands the roster in one conversation named for the tile', async () => {
  const p = press({tiles: [THREE]});
  p.press('ql_c');
  await p.land(pane('w1:p1'));
  await p.land(pane('w2:p1'));
  assert.deepEqual(p.convs, [], 'nothing is filed until the roster is whole');
  await p.land(pane('w3:p1'));
  assert.equal(p.convs.length, 1);
  assert.equal(p.convs[0].name, 'Trio');
  assert.equal(p.convs[0].members.length, 3);
  assert.ok(p.log.some(l => l[0] === 'openConversation' && l[1] === p.convs[0].id),
    'and that is where the user lands, not on one of the three panes');
  assert.equal(p.log.filter(l => l[0] === 'convSetView').length, 3,
    'each pane opens on the grouping it was started for');
});

test('pressing the same tile twice does not make two conversations with one name', async () => {
  const p = press({tiles: [THREE], convs: [{id: 'c_old', name: 'Trio', members: []}]});
  p.press('ql_c');
  await p.land(pane('w1:p1'));
  await p.land(pane('w2:p1'));
  await p.land(pane('w3:p1'));
  assert.equal(p.convs[0].name, 'Trio 2');
});

test('a second press while a batch is running is refused, not queued', () => {
  const p = press({tiles: [THREE, RUN]});
  p.press('ql_c');
  assert.equal(p.press('ql_a'), false);
  assert.deepEqual(p.log.filter(l => l[0] === 'toast'),
    [['toast', 'Still starting the last one — give it a moment.']]);
  assert.equal(p.sent.length, 1, 'six panes from two taps that looked like one is the bug');
});

test('a refusal partway through ends the batch rather than filing half a roster', async () => {
  const p = press({tiles: [THREE]});
  p.press('ql_c');
  await p.land(pane('w1:p1'));
  p.fail();
  assert.equal(p.intent(), null, 'the intent goes with it');
  assert.deepEqual(p.convs, [], 'and nothing is grouped');
  assert.ok(p.log.some(l => l[0] === 'toast' && /Started 1 of 3/.test(l[1])),
    'said plainly, because two of the three panes the user asked for do not exist');
  // And the launcher is free again, which is the half that would otherwise wedge the section.
  assert.equal(p.press('ql_c'), true);
});

test('a conversation ceiling leaves the panes started rather than losing them', async () => {
  const full = Array.from({length: 20}, (_, i) => ({id: 'c' + i, name: 'x' + i, members: []}));
  const p = press({tiles: [THREE], convs: full});
  p.press('ql_c');
  await p.land(pane('w1:p1'));
  await p.land(pane('w2:p1'));
  await p.land(pane('w3:p1'));
  assert.equal(p.convs.length, 20, 'nothing was pushed past the ceiling');
  assert.ok(p.log.some(l => l[0] === 'toast' && /ungrouped/.test(l[1])));
  assert.ok(p.log.some(l => l[0] === 'openTerminal'), 'and the user still lands somewhere real');
});

// --- spawn, with an arbitrator ---------------------------------------------------------------
// A tile of exactly two members that names an arbitrator starts *three* panes and ends in an
// arbitration session, not a plain conversation. Everything either side of that line is
// unchanged, which is the other half of what these pin: launcherWantsArb is the only switch.

const ARB = {id: 'ql_d', label: 'Review', action: 'spawn', project_id: 'p1',
             scope: 'Which approach ships',
             members: [{name: 'claude', role: 'proposer', label: 'A'},
                       {name: 'codex', role: 'critic', label: 'B'}],
             arbitrator: {name: 'claude', label: 'Arb'}};

async function landAll(p, n) {
  for (let i = 1; i <= n; i++) await p.land(pane('w' + i + ':p1'));
}

test('an arbitrated tile starts three panes, the arbitrator last', async () => {
  const p = press({tiles: [ARB]});
  p.press('ql_d');
  assert.equal(p.sent.length, 1);
  await p.land(pane('w1:p1'));
  await p.land(pane('w2:p1'));
  assert.equal(p.sent.length, 3, 'the third is the arbitrator, and it is still serial');
  assert.deepEqual(p.sent.map(m => m.name), ['claude', 'codex', 'claude']);
  // Last on purpose: it is briefed with the roster it decides between, so it is the pane that
  // most wants the other two to already exist.
  assert.equal(p.sent[2].label, 'Arb');
  assert.deepEqual(kinds(p.sent), ['start_agent', 'start_agent', 'start_agent'],
    'and nothing is appointed until every pane is real');
});

test('the finished roster becomes an arbitration session, not just a conversation', async () => {
  const p = press({tiles: [ARB]});
  p.press('ql_d');
  await landAll(p, 3);
  const start = p.sent.find(m => m.type === 'arb_start');
  assert.ok(start, 'an arb_start went out');
  assert.equal(start.conversation, p.convs[0].id, 'against the conversation just made');
  assert.equal(start.scope, 'Which approach ships');
  // Pane ids and roles, and nothing else about who they are: the relay reads a participant's
  // identity off its own pane list, because a fingerprint this browser supplies can be stale.
  assert.deepEqual(start.members, [{pane_id: 'w1:p1', role: 'proposer'},
                                   {pane_id: 'w2:p1', role: 'critic'}]);
  assert.deepEqual(start.arbitrator, {pane_id: 'w3:p1'}, 'the third pane, by position');
  assert.deepEqual(start.triggers, {on_turn_end: true, idle_ms: 0, runtime_ms: 0});
  assert.equal(start.paused, false, 'armed — a tile has already said what it wants');
});

test('the arbitrator is outside the conversation it decides about', async () => {
  // It is not a participant, it is the one reading. A conversation carrying it would show its
  // brief as a third voice in the thread.
  const p = press({tiles: [ARB]});
  p.press('ql_d');
  await landAll(p, 3);
  assert.equal(p.convs[0].members.length, 2);
  assert.deepEqual(p.convs[0].members.map(m => m.key), ['k_w1:p1', 'k_w2:p1']);
  assert.deepEqual(p.log.filter(l => l[0] === 'convSetView').map(l => l[1]),
    ['w1:p1', 'w2:p1'], 'and it is not opened on it either');
  assert.ok(p.log.some(l => l[0] === 'openConversation'), 'the user still lands on the record');
});

test('the confirm counts the arbitrator and says what it is deciding about', () => {
  const p = press({tiles: [ARB]});
  p.press('ql_d');
  const text = p.log.find(l => l[0] === 'confirm')[1];
  assert.match(text, /Start 3 sessions/, 'three, because three panes are started');
  assert.match(text, /decides between the other two, on: Which approach ships/);
});

test('a relay with arbitration off refuses the tile rather than downgrading it', () => {
  // What was asked for was the third agent. Quietly starting two and calling it a conversation
  // is the tile doing something other than what it says on it.
  const p = press({tiles: [ARB], arb: false});
  assert.equal(p.press('ql_d'), false);
  assert.deepEqual(p.log, [['toast', 'Arbitration is off on this relay']]);
  assert.deepEqual(p.sent, []);
});

test('an arbitrator kind this relay will not start is caught with the members', () => {
  const p = press({tiles: [Object.assign({}, ARB, {arbitrator: {name: 'pi'}})]});
  assert.equal(p.press('ql_d'), false);
  assert.match(p.log[0][1], /does not start pi/);
});

test('an arbitrated tile with no scope is refused before anything starts', () => {
  // The relay refuses an empty scope outright, and rightly: the scope is the whole of what the
  // arbitrator is told the session is for.
  const p = press({tiles: [Object.assign({}, ARB, {scope: '   '})]});
  assert.equal(p.press('ql_d'), false);
  assert.match(p.log[0][1], /deciding about/);
});

// --- and everything that is not exactly two members with an arbitrator ---

test('three members with a leftover arbitrator is still a plain conversation', async () => {
  // §14.1 fixes an arbitrated roster at two. A tile edited up to three keeps the arbitrator it
  // had — losing it silently would be worse — and simply does not use it.
  const p = press({tiles: [Object.assign({}, THREE, {arbitrator: {name: 'claude'}, scope: 'x'})]});
  p.press('ql_c');
  await landAll(p, 3);
  assert.equal(p.sent.length, 3, 'three starts and no fourth pane');
  assert.equal(p.sent.filter(m => m.type === 'arb_start').length, 0);
  assert.equal(p.convs[0].members.length, 3, 'all three are in the conversation');
});

test('two members and no arbitrator is the step-5 path, untouched', async () => {
  const p = press({tiles: [Object.assign({}, ARB, {arbitrator: undefined})]});
  p.press('ql_d');
  await landAll(p, 2);
  assert.deepEqual(kinds(p.sent), ['start_agent', 'start_agent']);
  assert.equal(p.convs.length, 1);
  assert.equal(p.convs[0].members.length, 2);
});

test('one member and an arbitrator is one pane and no session', async () => {
  const p = press({tiles: [Object.assign({}, ONE, {arbitrator: {name: 'claude'}, scope: 'x'})]});
  p.press('ql_b');
  await landAll(p, 1);
  assert.equal(p.sent.length, 1, 'an arbitrator with one agent has nobody to decide between');
  assert.deepEqual(p.convs, []);
});

test('a refusal partway through an arbitrated roster appoints nothing', async () => {
  const p = press({tiles: [ARB]});
  p.press('ql_d');
  await p.land(pane('w1:p1'));
  p.fail();
  assert.equal(p.sent.filter(m => m.type === 'arb_start').length, 0);
  assert.deepEqual(p.convs, [], 'and files no conversation to appoint against');
});
