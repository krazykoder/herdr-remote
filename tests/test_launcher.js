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
               'launcherBatch', 'launcherBatchNext', 'launcherBatchDone',
               'launcherWantsConv', 'launcherWantsArb'];

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
   startOptions: {agents: ['claude', 'codex'], roles: ['implementer', 'reviewer'], terminal: true}},
  over);

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
  assert.deepEqual(msg, {type: 'start_agent', name: 'claude', role: 'implementer',
                         project_id: 'p1', placement: 'new_workspace'});
  for (const k of Object.keys(msg)) assert.ok(START_AGENT_FIELDS.includes(k), `leaked ${k}`);
  assert.ok(!('members' in msg));
  assert.ok(!('id' in msg));
  // Never the tile's label: that names the group, and two panes asking for one name is two
  // collisions the relay has to rename its way out of.
  assert.ok(!('label' in msg), 'an unnamed member is named by the relay, from its role');
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
  assert.match(launcherValid(runTile({project_id: ''})), /Project/);
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

test('a conversation is for several members; one pane has nothing to compare', () => {
  const {launcherWantsConv} = pure();
  assert.equal(launcherWantsConv(spawnTile()), true);
  assert.equal(launcherWantsConv(spawnTile({members: [{name: 'claude'}]})), false);
});

test('an arbitrator is only meaningful at exactly two, and is kept when it is not', () => {
  const {launcherWantsArb} = pure();
  const arb = {name: 'claude', role: 'arbitrator'};
  assert.equal(launcherWantsArb(spawnTile({arbitrator: arb})), true);
  const three = spawnTile({arbitrator: arb,
    members: [{name: 'claude'}, {name: 'codex'}, {name: 'claude'}]});
  assert.equal(launcherWantsArb(three), false);
  // Ignored, not erased: edited back down to two it works again, which it could not do if
  // widening the roster had dropped the field.
  assert.equal(three.arbitrator, arb);
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
