// Launcher tiles: the schema, the gates, and the two messages a tile turns into.
//
//   node --test tests/test_launcher.js
//
// The pure block is evaluated with nothing but `window` defined, which is what keeps it honest
// about reaching for the DOM, ws or localStorage. The store half is evaluated over a recording
// localStorage, so the pending outbox can be read back.
//
// The test that matters most here is the payload one. relay/start_agent.py refuses a message
// carrying a key it does not expect — `extra = set(msg) - base_fields` rejects the *whole*
// message — so a stray `id` riding along on a start_agent is not a warning, it is a spawn that
// silently does nothing. That failure is invisible from the browser, which is why it needs a test
// rather than an eye.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', f), 'utf8');
const PURE = src('launcher_pure.js');
const STORE = src('launcher_store.js');

const NAMES = ['LAUNCHER_KEY', 'LAUNCHER_PENDING_KEY', 'LAUNCHER_MAX', 'LAUNCHER_LABEL_MAX',
               'LAUNCHER_MEMBERS_MAX', 'LAUNCHER_ACTIONS', 'LAUNCHER_PLACEMENT',
               'OPEN_TERMINAL_FIELDS', 'START_AGENT_FIELDS',
               'launcherId', 'parseLauncher', 'serializeLauncher', 'launcherValid', 'launcherGate',
               'launcherPreview', 'launcherStrict', 'launcherRunMsg', 'launcherSpawnMsg',
               'launcherBatch', 'launcherBatchNext', 'launcherBatchDone', 'launcherRoster',
               'launcherArbMsg',
               'launcherWantsConv', 'launcherWantsArb',
               'LAUNCHER_DEFAULT_AT', 'launcherTag', 'launcherNoun', 'launcherAutoName',
               'launcherClean', 'launcherMemberName', 'launcherNamed', 'launcherUnattended',
               'LAUNCHER_ARB_SLOTS', 'launcherArbOrder'];

const EXPORT = `\n;__out = {${NAMES.join(', ')}};`;

// SEND_TEXT_MAX lives in pairs_pure.js; the launcher reads it for its command cap. Supplied here
// rather than pulling that whole file in, so a failure points at this module.
const PRELUDE = 'const SEND_TEXT_MAX = 4000;\n';

function pure() {
  const ctx = vm.createContext({window: {}});
  vm.runInContext(PRELUDE + PURE + EXPORT, ctx);
  return ctx.__out;
}

// The pure block plus the store, over a localStorage the test can read back.
function booted(stored = {}) {
  const store = Object.assign({}, stored);
  const marked = [];
  const ctx = vm.createContext({
    window: {},
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    stateSyncMark: name => marked.push(name),
    JSON, Set, Math, Array, Object,
  });
  vm.runInContext(PRELUDE + PURE + STORE +
    `\n;__out = {${NAMES.join(', ')}, loadLauncher, saveLauncher, putLauncherTile,` +
    ` removeLauncherTile, moveLauncherTile};`, ctx);
  return Object.assign({}, ctx.__out, {store, marked,
    pending: () => JSON.parse(store.herdr_launcher_pending || '[]')});
}

const runTile = (over = {}) => Object.assign(
  {id: 't1', label: 'Run tests', action: 'run', project_id: 'p1', command: 'pytest -q'}, over);
const spawnTile = (over = {}) => Object.assign(
  {id: 't2', label: 'Review pair', action: 'spawn', project_id: 'p1',
   members: [{name: 'claude', role: 'implementer'}, {name: 'codex', role: 'reviewer'}]}, over);

const env = (over = {}) => Object.assign(
  {projects: [{id: 'p1', label: 'proj'}],
   startOptions: {agents: ['claude', 'codex'], roles: ['implementer', 'reviewer'], terminal: true},
   // arbitration.js's arbOn. Read only for a tile that wants an arbitrator, which is why every
   // gate test above this line is unaffected by it.
   arb: true},
  over);

// A tile of exactly two that names a third to decide between them. Everything a plain spawn
// tile has, plus the two fields §14.1 needs: who decides, and what about.
const arbTile = (over = {}) => spawnTile(Object.assign(
  {id: 't3', scope: 'Which approach ships', arbitrator: {name: 'claude', label: 'Arb'}}, over));

// --- load-time purity -------------------------------------------------------

test('the pure block evaluates with no localStorage, no socket and no DOM', () => {
  const ctx = vm.createContext({window: {}});
  assert.doesNotThrow(() => vm.runInContext(PRELUDE + PURE + EXPORT, ctx));
  assert.equal(typeof ctx.__out.launcherValid, 'function');
});

// --- the payload is exactly what the relay accepts --------------------------

test('a run tile becomes an open_terminal carrying no key the relay would refuse', () => {
  const {launcherRunMsg, OPEN_TERMINAL_FIELDS} = pure();
  const msg = launcherRunMsg(runTile({slot: 'wide'}));
  assert.deepEqual(msg, {type: 'open_terminal', project_id: 'p1', placement: 'new_workspace',
                         label: 'Run tests', slot: 'wide'});
  for (const k of Object.keys(msg)) assert.ok(OPEN_TERMINAL_FIELDS.includes(k), `leaked ${k}`);
  // The command is emphatically not in it: open_terminal has nowhere to carry one, and a shell is
  // not started with an argument. It is typed into the pane afterwards.
  assert.ok(!('command' in msg));
  assert.ok(!('id' in msg), 'the tile id is internal and must never reach the wire');
  assert.ok(!('action' in msg));
});

test('a spawn member becomes a start_agent carrying no key the relay would refuse', () => {
  const {launcherSpawnMsg, START_AGENT_FIELDS} = pure();
  const tile = spawnTile();
  const msg = launcherSpawnMsg(tile, tile.members[0]);
  // The wire role is the relay's, not the tile's. start_agent knows architect, reviewer and agent
  // and refuses the whole message for anything else — and the role the user typed is not one of
  // those. It rides on arb_start and nowhere else: it is what the *arbitrator* is told this member
  // is for, and it means nothing to the agent, which is never shown it.
  assert.deepEqual(msg, {type: 'start_agent', name: 'claude', role: 'agent',
                         project_id: 'p1', placement: 'new_workspace'});
  for (const k of Object.keys(msg)) assert.ok(START_AGENT_FIELDS.includes(k), `leaked ${k}`);
  assert.ok(!('members' in msg));
  assert.ok(!('id' in msg));
  // Never the tile's label: that names the group, and two panes asking for one name is two
  // collisions the relay has to rename its way out of.
  assert.notEqual(msg.label, tile.label);
});

test('a member with its own label carries it, and nothing empty is ever sent', () => {
  const {launcherSpawnMsg} = pure();
  const tile = spawnTile({members: [{name: 'claude', role: 'implementer', label: 'Lead'}]});
  assert.equal(launcherSpawnMsg(tile, tile.members[0]).label, 'Lead');
  // An absent slot is an absent key, not slot:'' — the relay refuses a blank label and derives
  // one from an absent it.
  const bare = launcherSpawnMsg(spawnTile({slot: ''}), {name: 'codex', role: 'reviewer'});
  assert.ok(!('slot' in bare));
});

test('a custom member carries its provider-backed config id', () => {
  const {launcherSpawnMsg} = pure();
  const tile = spawnTile({members: [{name: 'claude', config: 'oclaude'}]});
  assert.equal(launcherSpawnMsg(tile, tile.members[0]).config, 'oclaude');
});

test('a member on an agent config is started without approval prompts, and a stock one is not', () => {
  // The default, and the whole of why it is a default: an alias names an endpoint the user set up
  // for work that runs without them, and a stock harness is the one they are sitting in front of.
  const {launcherSpawnMsg, launcherUnattended} = pure();
  const custom = spawnTile({members: [{name: 'claude', config: 'oclaude'}]});
  assert.equal(launcherSpawnMsg(custom, custom.members[0]).unattended, true);
  const stock = spawnTile({members: [{name: 'claude'}]});
  assert.ok(!('unattended' in launcherSpawnMsg(stock, stock.members[0])),
            'off is the relay default, and saying so on the wire says nothing');
  // Answered either way, the answer wins — including a stock member somebody wants left alone.
  assert.equal(launcherUnattended({name: 'claude', config: 'oclaude', unattended: false}), false);
  assert.equal(launcherUnattended({name: 'claude', unattended: true}), true);
});

test('a role never becomes a pane label, however short it is', () => {
  const {launcherSpawnMsg} = pure();
  // The role field is the arbitration setup's own — 240 characters of prose, and a
  // comma-separated line as soon as two pills are tapped — and validate_pane_label refuses a label
  // over 32 outright. A role riding here as the label is not a bad name: it is the whole
  // start_agent rejected, and the batch behind it. It is also simply not a name.
  const long = spawnTile({members: [{name: 'claude',
    role: 'writes the code, review only, minimal focused test'}]});
  assert.ok(!('label' in launcherSpawnMsg(long, long.members[0])),
            'absent, so the relay names the pane');
  const short = spawnTile({members: [{name: 'claude', role: 'review only'}]});
  assert.ok(!('label' in launcherSpawnMsg(short, short.members[0])));
  // The member's own name is what names the pane, and the only thing that does.
  const named = spawnTile({members: [{name: 'claude', role: 'review only', label: 'Lead'}]});
  assert.equal(launcherSpawnMsg(named, named.members[0]).label, 'Lead');
});

test('an arbitrated tile with no clocks and no limits leaves both to the relay', () => {
  const {launcherArbMsg} = pure();
  const msg = launcherArbMsg(arbTile(), 'c_1', [{pane_id: 'w1:p1'}, {pane_id: 'w2:p1'},
                                                {pane_id: 'w3:p1'}]);
  assert.deepEqual(msg.triggers, {on_turn_end: true, idle_ms: 0, runtime_ms: 0});
  // Absent, not restated: an absent budget is the relay's own DEFAULT_BUDGET, and a second copy of
  // those numbers here is one to keep in step by hand for no gain.
  assert.ok(!('budget' in msg));
  assert.ok(!('warmup' in msg));
  assert.equal(msg.paused, true, 'a tile lays out a room, it does not make its first decision');
});

test('the clocks and limits a tile was given ride with it', () => {
  const {launcherArbMsg} = pure();
  const tile = arbTile({idle: 5, runtime: 30, steps: 12, runs: 4, minutes: 90, warmup: true});
  const msg = launcherArbMsg(tile, 'c_1', [{pane_id: 'w1:p1'}, {pane_id: 'w2:p1'},
                                           {pane_id: 'w3:p1'}]);
  // Minutes on a tile, milliseconds on the wire — the unit a person thinks about a stuck agent in
  // is not the one the relay counts in.
  assert.deepEqual(msg.triggers, {on_turn_end: true, idle_ms: 300000, runtime_ms: 1800000});
  assert.deepEqual(msg.budget,
    {max_steps: 12, max_consecutive: 4, max_wall_clock_ms: 5400000});
  assert.equal(msg.warmup, true);
});

test('a tile that changed one limit sends that one and leaves the rest alone', () => {
  const {launcherArbMsg} = pure();
  const msg = launcherArbMsg(arbTile({steps: 20}), 'c_1',
                             [{pane_id: 'w1:p1'}, {pane_id: 'w2:p1'}, {pane_id: 'w3:p1'}]);
  assert.deepEqual(msg.budget, {max_steps: 20});
});

test('a tile that names no Project is pressable — the press is where that is asked', () => {
  const {launcherGate} = pure();
  const env = {projects: [{id: 'p1'}], startOptions: {terminal: true, agents: ['claude', 'codex']}};
  assert.deepEqual(launcherGate(runTile({project_id: ''}), env), {ok: true, reason: '', badge: ''});
  // Not repointable, because nothing is pointing anywhere. A relay with no Projects at all is the
  // one thing that makes a template unpressable, and it says so rather than opening an empty sheet.
  const none = launcherGate(runTile({project_id: ''}), {projects: [], startOptions: env.startOptions});
  assert.equal(none.badge, 'No Projects');
  // A tile that *does* name one this relay has never heard of is still the stale pointer it was.
  assert.equal(launcherGate(runTile({project_id: 'gone'}), env).badge, 'Missing Project');
});

test('launcherStrict is what makes a leak a test failure instead of a silent no-op', () => {
  const {launcherStrict} = pure();
  assert.throws(() => launcherStrict({type: 'start_agent', id: 'x', nope: 1},
                                     ['type', 'name']),
                /unexpected field\(s\): id, nope/);
});

test('every tile always asks for new_workspace, the one placement naming no live pane', () => {
  const {launcherRunMsg, launcherSpawnMsg, LAUNCHER_PLACEMENT} = pure();
  assert.equal(LAUNCHER_PLACEMENT, 'new_workspace');
  assert.equal(launcherRunMsg(runTile()).placement, 'new_workspace');
  const tile = spawnTile();
  assert.equal(launcherSpawnMsg(tile, tile.members[0]).placement, 'new_workspace');
});

// --- what the editor may save -----------------------------------------------

test('launcherValid names the one thing wrong, and accepts a good tile', () => {
  const {launcherValid, LAUNCHER_LABEL_MAX} = pure();
  assert.equal(launcherValid(runTile()), '');
  assert.equal(launcherValid(spawnTile()), '');
  assert.match(launcherValid(runTile({label: ' '})), /name/);
  assert.match(launcherValid(runTile({label: 'x'.repeat(LAUNCHER_LABEL_MAX + 1)})), /characters/);
  // No Project is legal and is the more useful tile: a template, pressed into whichever tree wants
  // it. The Project is mandatory at the press instead — see launcherAskProject.
  assert.equal(launcherValid(runTile({project_id: ''})), '');
  assert.match(launcherValid(runTile({command: '  '})), /command/);
  assert.match(launcherValid(runTile({command: 'x'.repeat(4001)})), /too long/);
  assert.match(launcherValid(spawnTile({members: []})), /at least one/);
  assert.match(launcherValid(spawnTile({members: [{role: 'x'}]})), /kind/);
});

test('a control character in a label is refused, because it becomes a pane label', () => {
  const {launcherValid} = pure();
  // Exactly what relay/start_agent.py validate_pane_label refuses: ord < 0x20, or 0x7F.
  for (const bad of ['a\tb', 'a\nb', 'a\u001bb', 'a\u007fb']) {
    assert.match(launcherValid(runTile({label: bad})), /control/, `allowed ${JSON.stringify(bad)}`);
  }
  assert.equal(launcherValid(runTile({label: 'Run tests — fast'})), '',
               'ordinary punctuation and em dashes are fine');
});

// --- what can be pressed right now ------------------------------------------

test('a tile whose Project is gone is disabled and says which', () => {
  const {launcherGate} = pure();
  const gate = launcherGate(runTile({project_id: 'vanished'}), env());
  assert.equal(gate.ok, false);
  assert.equal(gate.badge, 'Missing Project');
});

test('a run tile is disabled when terminal mode is off, and that is the whole boundary', () => {
  const {launcherGate} = pure();
  const off = env({startOptions: {agents: ['claude'], terminal: false}});
  assert.equal(launcherGate(runTile(), off).ok, false);
  assert.equal(launcherGate(runTile(), off).badge, 'No terminals');
  assert.equal(launcherGate(runTile(), env()).ok, true);
});

test('a spawn naming an agent this relay does not start is disabled and names it', () => {
  const {launcherGate} = pure();
  const gate = launcherGate(spawnTile(), env({startOptions: {agents: ['claude'], terminal: true}}));
  assert.equal(gate.ok, false);
  assert.match(gate.reason, /codex/);
});

test('a custom tile is disabled when its provider-backed config is gone', () => {
  const {launcherGate} = pure();
  const tile = spawnTile({members: [{name: 'claude', config: 'oclaude'}]});
  assert.match(launcherGate(tile, env()).reason, /oclaude.*not available/);
  const live = env({startOptions: {agents: ['claude', 'codex'], terminal: true,
                                   configs: [{id: 'oclaude', kind: 'claude'}]}});
  assert.equal(launcherGate(tile, live).ok, true);
});

test('a relay that advertises no start options disables every tile', () => {
  const {launcherGate} = pure();
  assert.equal(launcherGate(runTile(), env({startOptions: null})).ok, false);
  assert.equal(launcherGate(spawnTile(), env({startOptions: null})).ok, false);
});

test('an action from a newer app is disabled, not called broken', () => {
  const {launcherGate} = pure();
  const gate = launcherGate({id: 'x', label: 'Future', action: 'teleport'}, env());
  assert.equal(gate.ok, false);
  assert.equal(gate.badge, 'Unsupported');
});

// --- the extension rule -----------------------------------------------------

test('parseLauncher keeps a tile whose action this build cannot press', () => {
  const {parseLauncher} = pure();
  // The rule the whole extension story rests on: a browser on an older build that dropped these
  // would destroy, on its next state_put, an action every other browser can see.
  const body = JSON.stringify({version: 1, items: [
    {id: 'a', label: 'Known', action: 'run'},
    {id: 'b', label: 'Future', action: 'teleport', beam: {to: 'mars'}}]});
  const items = parseLauncher(body);
  assert.deepEqual(items.map(t => t.id), ['a', 'b']);
  assert.deepEqual(items[1].beam, {to: 'mars'}, 'unknown fields are carried untouched');
});

test('parseLauncher drops what cannot be drawn or merged, and never throws', () => {
  const {parseLauncher} = pure();
  assert.deepEqual(parseLauncher('not json'), []);
  assert.deepEqual(parseLauncher(null), []);
  assert.deepEqual(parseLauncher('{"items":"nope"}'), []);
  const body = JSON.stringify({items: [
    {label: 'no id', action: 'run'},          // cannot survive a merge
    {id: 'x', action: 'run'},                 // cannot be drawn
    {id: 'y', label: 'no action'},
    {id: 'z', label: 'fine', action: 'run'},
    {id: 'z', label: 'dupe', action: 'run'}]});
  assert.deepEqual(parseLauncher(body).map(t => t.id), ['z']);
});

test('serialize and parse round-trip, and the cap holds on both sides', () => {
  const {parseLauncher, serializeLauncher, LAUNCHER_MAX} = pure();
  const many = Array.from({length: LAUNCHER_MAX + 5},
                          (_, i) => ({id: 'i' + i, label: 'L', action: 'run'}));
  assert.equal(parseLauncher(serializeLauncher(many)).length, LAUNCHER_MAX);
});

// --- rosters ----------------------------------------------------------------

test('every spawn lands on a conversation, including a spawn of one', () => {
  const {launcherWantsConv} = pure();
  assert.equal(launcherWantsConv(spawnTile()), true);
  // One member gets one too: it is what carries the name the launch was given, and it outlives
  // the pane id. Only a tile with no roster at all — which launcherValid refuses — has none.
  assert.equal(launcherWantsConv(spawnTile({members: [{name: 'claude'}]})), true);
  assert.equal(launcherWantsConv(runTile()), false);
});

// --- the name a launch runs under -------------------------------------------

test('an unnamed launch is named for what it makes, plus a tag', () => {
  const {launcherNamed, launcherNoun} = pure();
  assert.equal(launcherNoun(runTile()), 'terminal');
  assert.equal(launcherNoun(spawnTile({members: [{name: 'claude'}]})), 'agent');
  assert.equal(launcherNoun(spawnTile()), 'conversation');
  assert.match(launcherNamed(runTile(), '').label, /^terminal [a-z0-9]{5}$/);
  assert.match(launcherNamed(spawnTile(), '   ').label, /^conversation [a-z0-9]{5}$/);
});

test('a typed name is used as typed, and scrubbed of what a pane label cannot carry', () => {
  const {launcherNamed, LAUNCHER_LABEL_MAX} = pure();
  // The tag is on the launch name too: one press is one tag, worn by the conversation and by
  // every pane in it.
  assert.match(launcherNamed(runTile(), '  Nightly run  ').label, /^Nightly run [a-z0-9]{5}$/);
  // validate_pane_label refuses these outright, so an unscrubbed name is a launch the relay
  // rejects with nothing on screen saying why.
  assert.match(launcherNamed(runTile(), 'a\u0007b\u007f').label, /^ab [a-z0-9]{5}$/);
  assert.equal(launcherNamed(runTile(), 'x'.repeat(80)).label.length, LAUNCHER_LABEL_MAX);
});

test('the stored tile is never renamed by a press', () => {
  const {launcherNamed} = pure();
  const tile = spawnTile();
  const named = launcherNamed(tile, 'Tonight');
  assert.equal(tile.label, 'Review pair');
  assert.match(named.label, /^Tonight [a-z0-9]{5}$/);
  assert.notEqual(named.members, tile.members);
});

test('a named member carries the launch tag, so two presses are two panes apart', () => {
  const {launcherNamed} = pure();
  const tile = spawnTile({members: [{name: 'claude', label: 'Reviewer'},
                                    {name: 'codex', label: 'Builder'}]});
  const named = launcherNamed(tile, 'Tonight');
  const tag = named.label.split(' ').pop();
  assert.match(tag, /^[a-z0-9]{5}$/);
  assert.deepEqual(named.members.map(m => m.label),
                   [`Reviewer ${tag}`, `Builder ${tag}`]);
  // Every member of one launch shares the tag: that is what says they belong together.
  assert.equal(named.members[0].label.split(' ').pop(),
               named.members[1].label.split(' ').pop());
});

test('a member the template never named is named for its kind, and still tagged', () => {
  const {launcherNamed} = pure();
  const named = launcherNamed(spawnTile(), 'Tonight');
  const tag = named.label.split(' ').pop();
  assert.deepEqual(named.members.map(m => m.label), [`claude ${tag}`, `codex ${tag}`]);
  // Except when it is the only one — pane and conversation both wear the launch name, with no
  // second copy of the tag.
  const solo = launcherNamed(spawnTile({members: [{name: 'claude'}]}), 'Tonight');
  assert.equal(solo.members[0].label, solo.label);
  assert.match(solo.label, /^Tonight [a-z0-9]{5}$/);
  const unnamed = launcherNamed(spawnTile({members: [{name: 'claude'}]}), '');
  assert.match(unnamed.members[0].label, /^agent [a-z0-9]{5}$/);
});

test('a long member name is trimmed to fit its tag, never the other way round', () => {
  const {launcherNamed, LAUNCHER_LABEL_MAX} = pure();
  const named = launcherNamed(
    spawnTile({members: [{name: 'claude', label: 'x'.repeat(60)}]}), '');
  assert.ok(named.members[0].label.length <= LAUNCHER_LABEL_MAX);
  assert.match(named.members[0].label, /^x+ [a-z0-9]{5}$/);
});

// --- who is Agent 1 --------------------------------------------------------

test('the implementer is picked first, and is then off the table for the reviewer', () => {
  const {launcherArbOrder} = pure();
  const kinds = ms => launcherArbOrder(ms).map(m => m.name);
  // The plain case: the preferred pair, whichever order they were added in.
  assert.deepEqual(kinds([{name: 'codex'}, {name: 'claude'}]), ['claude', 'codex']);
  // One preferred kind and one that is on neither list: the preferred one takes the slot that
  // wants it and the stranger fills what is left, whichever order they were added in.
  assert.deepEqual(kinds([{name: 'zed'}, {name: 'codex'}]), ['zed', 'codex']);
  assert.deepEqual(kinds([{name: 'codex'}, {name: 'zed'}]), ['zed', 'codex']);
  // Two of the same kind. The first is Agent 1 and is then gone, so Agent 2 is the second copy
  // and not the same pane named twice.
  const two = launcherArbOrder([{name: 'claude', label: 'A'}, {name: 'claude', label: 'B'}]);
  assert.deepEqual(two.map(m => m.label), ['A', 'B']);
  // Down the lists: kiro is on both, and claude's slot claims it before codex's can.
  assert.deepEqual(kinds([{name: 'agy'}, {name: 'kiro'}]), ['kiro', 'agy']);
  // Nothing to order is not a crash, and anything past the two slots keeps its place.
  assert.deepEqual(kinds([]), []);
  assert.deepEqual(kinds([{name: 'agy'}, {name: 'claude'}, {name: 'pi'}]),
                   ['claude', 'pi', 'agy']);
});

test('an arbitrator decides between two of the roster, whatever size the roster is', () => {
  // The relay's MEMBERS_REQUIRED is two and stays two. That fixes the size of the *pair*, not the
  // size of the room — a conversation of three can have two of them arbitrated, which is what the
  // setup dialog has always allowed by asking Agent 1 and Agent 2 as selects.
  const {launcherWantsArb} = pure();
  const arb = {name: 'claude', role: 'arbitrator'};
  assert.equal(launcherWantsArb(spawnTile({arbitrator: arb})), true);
  const three = spawnTile({arbitrator: arb,
    members: [{name: 'claude'}, {name: 'codex'}, {name: 'claude'}]});
  assert.equal(launcherWantsArb(three), true);
  // One member is still nothing to decide between, and the field is kept rather than erased: a
  // roster narrowed to one and widened again must still have the arbitrator it was given.
  const one = spawnTile({arbitrator: arb, members: [{name: 'claude'}]});
  assert.equal(launcherWantsArb(one), false);
  assert.equal(one.arbitrator, arb);
});

test('the roster a spawn starts is the members, plus the arbitrator last when there is one', () => {
  const {launcherRoster} = pure();
  assert.deepEqual(launcherRoster(spawnTile()).map(m => m.name), ['claude', 'codex']);
  const three = launcherRoster(arbTile());
  assert.deepEqual(three.map(m => m.name), ['claude', 'codex', 'claude']);
  // Flagged rather than positional-only, and last because it is briefed with the roster it
  // decides between — so it is the pane that most wants the other two to already be there.
  assert.equal(three[2].arb, true);
  assert.equal(three[2].label, 'Arb');
  // Four panes: the whole roster starts, and the arbitrator is still last. It decides between the
  // first two of them — see launcherArbMsg — and the third is simply in the room.
  assert.deepEqual(launcherRoster(spawnTile({arbitrator: {name: 'claude'},
    members: [{name: 'claude'}, {name: 'codex'}, {name: 'pi'}]})).map(m => m.name),
    ['claude', 'codex', 'pi', 'claude']);
  // One member is nothing to decide between, so the arbitrator is carried and not started.
  assert.equal(launcherRoster(spawnTile({arbitrator: {name: 'claude'},
    members: [{name: 'claude'}]})).length, 1);
});

test('an arbitrated tile needs a kind to decide and something to decide about', () => {
  const {launcherValid} = pure();
  assert.equal(launcherValid(arbTile()), '');
  assert.match(launcherValid(arbTile({arbitrator: {}})), /needs a kind/);
  // The relay refuses an empty scope outright, so an editor that saved one would be saving a
  // tile that can only fail.
  assert.match(launcherValid(arbTile({scope: '  '})), /deciding about/);
  // Three members with an arbitrator is an arbitrated tile too, so it is held to the same two
  // answers — a scope nobody wrote is a session the relay refuses.
  assert.match(launcherValid(spawnTile({arbitrator: {}, scope: '',
    members: [{name: 'claude'}, {name: 'codex'}, {name: 'pi'}]})), /needs a kind/);
  // But only when it is actually going to be used. A tile narrowed to one member keeps its
  // arbitrator and must stay savable, or narrowing a roster becomes a trap.
  assert.equal(launcherValid(spawnTile({arbitrator: {}, scope: '',
    members: [{name: 'claude'}]})), '');
});

test('arbitration being off on the relay closes the gate rather than dropping the arbitrator', () => {
  const {launcherGate} = pure();
  assert.equal(launcherGate(arbTile(), env()).ok, true);
  const off = launcherGate(arbTile(), env({arb: false}));
  assert.equal(off.ok, false);
  assert.equal(off.badge, 'No arbitration');
  // And it is not asked about for a tile that never wanted one, which is what keeps every
  // pre-arbitrator tile working against a relay that has arbitration switched off.
  assert.equal(launcherGate(spawnTile(), env({arb: false})).ok, true);
});

test('the arbitrator is checked against the same allowlist as the members', () => {
  const {launcherGate} = pure();
  const g = launcherGate(arbTile({arbitrator: {name: 'pi'}}), env());
  assert.equal(g.ok, false);
  assert.match(g.reason, /does not start pi/);
});

test('the arb_start a finished roster turns into is the one the setup dialog sends', () => {
  const {launcherArbMsg} = pure();
  const panes = [{pane_id: 'w1:p1'}, {pane_id: 'w2:p1'}, {pane_id: 'w3:p1'}];
  const msg = launcherArbMsg(arbTile(), 'c_x', panes);
  assert.deepEqual(msg, {
    type: 'arb_start', conversation: 'c_x', scope: 'Which approach ships',
    members: [{pane_id: 'w1:p1', role: 'implementer'}, {pane_id: 'w2:p1', role: 'reviewer'}],
    arbitrator: {pane_id: 'w3:p1'},
    triggers: {on_turn_end: true, idle_ms: 0, runtime_ms: 0}, paused: true,
  });
  // Pane ids and nothing else about who they are: the relay reads a participant's identity off
  // its own pane list, because a fingerprint this browser supplies is one it can have stale.
  msg.members.forEach(m => assert.deepEqual(Object.keys(m).sort(), ['pane_id', 'role']));
  // A member with no role asked for sends none, rather than an empty string the relay would
  // have to decide what to do with.
  const bare = launcherArbMsg(arbTile({members: [{name: 'claude'}, {name: 'codex'}]}), 'c_x', panes);
  assert.deepEqual(bare.members, [{pane_id: 'w1:p1'}, {pane_id: 'w2:p1'}]);
});

test('a batch hands out its members one at a time and knows when it is finished', () => {
  const {launcherBatch, launcherBatchNext, launcherBatchDone} = pure();
  const b = launcherBatch(spawnTile());
  assert.equal(launcherBatchDone(b), false);
  assert.equal(launcherBatchNext(b).name, 'claude');
  b.sent++; b.panes.push('w1:p1');
  assert.equal(launcherBatchNext(b).name, 'codex', 'serial: the second only after the first lands');
  b.sent++; b.panes.push('w2:p1');
  assert.equal(launcherBatchNext(b), null);
  assert.equal(launcherBatchDone(b), true);
});

// --- the preview is the security boundary -----------------------------------

test('the preview shows the payload, because the label is not evidence of it', () => {
  const {launcherPreview} = pure();
  // A tile another browser wrote can be labelled anything. What it will actually do is this.
  assert.equal(launcherPreview(runTile({label: 'Run tests', command: 'rm -rf /tmp/x'})),
               'rm -rf /tmp/x');
  assert.equal(launcherPreview(spawnTile()), 'claude + codex');
  // The arbitrator is named apart from the two rather than joined into them: "claude + codex +
  // claude" would read as three of a kind, which is not what this tile is.
  assert.equal(launcherPreview(arbTile()), 'claude + codex ⚖ claude');
});

// --- the store and its outbox -----------------------------------------------

test('a saved tile is marked for sync and enters the outbox', () => {
  const s = booted();
  s.putLauncherTile(runTile());
  assert.deepEqual(s.loadLauncher().map(t => t.id), ['t1']);
  assert.deepEqual(s.pending(), ['t1'], 'the relay has never seen it, so the merge must carry it');
  assert.deepEqual(s.marked, ['launcher']);
});

test('a tile deleted before it ever synced leaves the outbox with it', () => {
  const s = booted();
  s.putLauncherTile(runTile());
  s.removeLauncherTile('t1');
  assert.deepEqual(s.loadLauncher(), []);
  assert.deepEqual(s.pending(), [], 'an outbox that only grows is a key that never stops');
});

test('editing an existing tile replaces it rather than appending a second', () => {
  const s = booted();
  s.putLauncherTile(runTile());
  s.putLauncherTile(runTile({label: 'Renamed'}));
  const items = s.loadLauncher();
  assert.equal(items.length, 1);
  assert.equal(items[0].label, 'Renamed');
});

test('reordering moves one place and refuses to fall off either end', () => {
  const s = booted();
  s.saveLauncher([runTile({id: 'a'}), runTile({id: 'b'}), runTile({id: 'c'})]);
  assert.deepEqual(s.moveLauncherTile('c', -1).map(t => t.id), ['a', 'c', 'b']);
  assert.deepEqual(s.moveLauncherTile('a', -1).map(t => t.id), ['a', 'c', 'b']);
  assert.deepEqual(s.moveLauncherTile('b', 1).map(t => t.id), ['a', 'c', 'b']);
});

test('a store with no localStorage at all reads empty instead of throwing', () => {
  const ctx = vm.createContext({window: {}, JSON, Set, Math, Array, Object,
    localStorage: {getItem() { throw new Error('private mode'); },
                   setItem() { throw new Error('private mode'); }}});
  vm.runInContext(PRELUDE + PURE + STORE + '\n;__out = {loadLauncher, saveLauncher};', ctx);
  assert.deepEqual(ctx.__out.loadLauncher(), []);
  assert.doesNotThrow(() => ctx.__out.saveLauncher([runTile()]));
});

test('a terminal tile is a run without the command, and is pressable with none', () => {
  const {launcherValid, launcherGate, launcherNoun} = pure();
  const term = {id: 't9', label: 'Shell', action: 'term', project_id: 'p1'};
  const env = {projects: [{id: 'p1'}], startOptions: {terminal: true, agents: ['claude']}};
  assert.equal(launcherValid(term), '');
  assert.equal(launcherNoun(term), 'terminal');
  // The same gate as a run tile: both open a terminal, so both need terminal mode on.
  assert.equal(launcherGate(term, env).ok, true);
  assert.equal(launcherGate(term, {projects: env.projects,
    startOptions: {agents: ['claude']}}).badge, 'No terminals');
  // And a run tile still has to have one.
  assert.equal(launcherValid({id: 'r', label: 'R', action: 'run', project_id: 'p1'}),
    'Give it a command to run');
});
