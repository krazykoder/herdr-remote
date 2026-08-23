// The tile editor: what a form turns into, and what the list does to it afterwards.
//
//   node --test tests/test_launcher_edit.js
//
// The editor writes nothing itself — every change goes through launcher_store, and every refusal
// comes from launcherValid. So what is worth pinning is the shape the form produces (a `run` that
// carries no roster, an arbitrator that survives a roster the wrong size for it) and that the list
// controls round-trip through storage rather than through anything the dialog is holding.
//
// The DOM is a recording stub with just enough in it to be typed into: the fields the editor reads
// back are read by id, so a stub that answers getElementById is the whole of what it needs.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', f), 'utf8');
const PURE = src('launcher_pure.js');
const STORE = src('launcher_store.js');
const EDIT = src('launcher_edit.js');

const PROJECTS = [{id: 'p1', label: 'herdr', host: 'local'},
                  {id: 'p2', label: 'mini', host: 'box'}];
const OPTIONS = {agents: ['claude', 'codex'], roles: ['agent'], terminal: true};

// Every element the editor writes into or reads back, invented on demand. `innerHTML` is recorded
// rather than parsed: what is drawn is checked by looking for the call it wired up, which is what
// a tap would actually reach.
function dom() {
  const nodes = {};
  return {
    nodes,
    get: id => (nodes[id] = nodes[id] || {id, value: '', textContent: '', innerHTML: '',
                                          style: {}}),
  };
}

function editor({tiles = [], projects = PROJECTS, startOptions = OPTIONS, confirmed = true} = {}) {
  const store = {};
  const log = [];
  const d = dom();
  const ctx = vm.createContext({
    console, JSON, Set, Math, Array, Object, String,
    SEND_TEXT_MAX: 4000,
    projects, startOptions,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {getElementById: id => d.nodes[id] || null},
    escapeHtml: s => String(s).replace(/[&<>"]/g,
      c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])),
    badgeHtml: (label, on, call) => `<button onclick="${call}" aria-pressed="${on}">${label}</button>`,
    confirm: t => { log.push(['confirm', t]); return confirmed; },
    showToast: t => log.push(['toast', t]),
    renderLauncher: () => log.push(['renderLauncher']),
    stateSyncMark: () => log.push(['mark']),
    // The section is switched on when the first tile is saved — launcher_store's own doing, and
    // stubbed here so this suite is not also a sections test.
    toggleSection: (k, on) => log.push(['toggleSection', k, on]),
    launcherEnv: () => ({projects, startOptions, arb: true}),
  });
  vm.runInContext(PURE + '\n' + STORE + '\n' + EDIT, ctx);
  const run = s => vm.runInContext(s, ctx);
  // The two nodes the dialog itself owns exist before it opens; every field is made by the first
  // draw that mentions it, which is why `field` is how a test types into one.
  d.get('launcherModal'); d.get('launcherEditTitle'); d.get('launcherEditBody');
  // qlError is in every draw of the form rather than in some of them, so it is here rather than
  // waiting to be typed into — nothing types into it, the editor writes it.
  d.get('qlError');
  run(`saveLauncher(${JSON.stringify(tiles)})`);
  return {
    run, log, store, dom: d,
    tiles: () => run('loadLauncher()'),
    body: () => d.nodes.launcherEditBody.innerHTML,
    title: () => d.nodes.launcherEditTitle.textContent,
    // Typing into a field the form has drawn. The stub invents it, which is the same thing the
    // browser does when the markup naming it is written.
    field: (id, value) => { d.get(id).value = value; },
    draft: () => run('launcherDraft'),
  };
}

const runTile = (over = {}) => Object.assign(
  {id: 't1', label: 'Tests', action: 'run', project_id: 'p1', command: 'pytest -q'}, over);
const spawnTile = (over = {}) => Object.assign(
  {id: 't2', label: 'Pair', action: 'spawn', project_id: 'p1',
   members: [{name: 'claude'}, {name: 'codex'}]}, over);

// --- add ---

test('a new tile opens on a Project already chosen rather than on an unmade choice', () => {
  const e = editor();
  e.run('openLauncherEdit()');
  assert.equal(e.dom.nodes.launcherModal.style.display, 'block');
  e.run('launcherNewTile()');
  assert.equal(e.title(), 'New tile');
  assert.equal(e.draft().project_id, 'p1');
  assert.equal(e.draft().action, 'run');
});

test('a relay with terminals off opens the form on the half that works', () => {
  // A form whose first act is to refuse is a form that has asked nothing.
  const e = editor({startOptions: {agents: ['claude'], terminal: false}});
  e.run('launcherNewTile()');
  assert.equal(e.draft().action, 'spawn');
});

test('a run tile saved from the form carries a command and no roster', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.field('qlName', '  Run the tests  ');
  e.field('qlCommand', ' pytest -q ');
  assert.equal(e.run('launcherSaveTile()'), true);
  const [t] = e.tiles();
  assert.equal(t.label, 'Run the tests', 'trimmed');
  assert.equal(t.command, 'pytest -q');
  // A `run` carrying an empty members array would be a stored shape saying something about a
  // roster it does not have.
  assert.deepEqual(Object.keys(t).sort(), ['action', 'command', 'id', 'label', 'project_id']);
  assert.ok(e.log.some(l => l[0] === 'renderLauncher'), 'and the section repaints');
});

test('a tile the form cannot save says why and writes nothing', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.field('qlCommand', 'pytest');
  assert.equal(e.run('launcherSaveTile()'), false);
  assert.equal(e.dom.nodes.qlError.textContent, 'Give it a name');
  assert.deepEqual(e.tiles(), [], 'nothing was stored');
  // launcherValid and not a second opinion written in the editor: an editor with its own idea of
  // what is legal is how a tile gets saved that the presser then refuses.
  e.field('qlName', 'Tests');
  e.field('qlCommand', '  ');
  assert.equal(e.run('launcherSaveTile()'), false);
  assert.equal(e.dom.nodes.qlError.textContent, 'Give it a command to run');
});

test('a tile that is legal but not startable here is saved, and said out loud', () => {
  // The gate is a different question from the validation. A tile can be perfectly well written
  // and not pressable on the relay connected right now — and the relay it is for may be the next.
  const e = editor({startOptions: {agents: ['claude'], terminal: false}});
  e.run('launcherNewTile()');
  e.run("launcherPickAction('run')");
  e.field('qlName', 'Tests');
  e.field('qlCommand', 'pytest');
  assert.equal(e.run('launcherSaveTile()'), true);
  assert.equal(e.tiles().length, 1);
  assert.ok(e.log.some(l => l[0] === 'toast' && /Terminal mode is off/.test(l[1])));
});

// --- edit ---

test('editing a tile replaces it in place rather than appending a second', () => {
  const e = editor({tiles: [runTile(), spawnTile()]});
  e.run("launcherEditTile('t1')");
  assert.equal(e.title(), 'Edit tile');
  e.field('qlName', 'Renamed');
  e.field('qlCommand', 'pytest -x');
  e.run('launcherSaveTile()');
  const tiles = e.tiles();
  assert.equal(tiles.length, 2);
  assert.equal(tiles[0].id, 't1', 'and in the same place');
  assert.equal(tiles[0].label, 'Renamed');
  assert.equal(tiles[0].command, 'pytest -x');
});

test('abandoning the form leaves the stored tile exactly as it was', () => {
  const e = editor({tiles: [runTile()]});
  e.run("launcherEditTile('t1')");
  e.field('qlName', 'Half a thought');
  e.run('launcherDrawList()');
  assert.equal(e.tiles()[0].label, 'Tests');
  assert.equal(e.draft(), null);
});

test('switching what a tile does keeps the name that was typed', () => {
  // The form rebuilds around the badge, so anything typed has to be harvested first — otherwise
  // the name goes away with the fields that were replaced.
  const e = editor();
  e.run('launcherNewTile()');
  e.field('qlName', 'Review pair');
  e.run("launcherPickAction('spawn')");
  assert.equal(e.draft().label, 'Review pair');
  assert.equal(e.draft().action, 'spawn');
});

// --- the roster, and the arbitrator ---

test('agents are added one tap at a time and each keeps its own role', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  e.field('qlName', 'Review pair');
  e.run("launcherAddMember('claude')");
  e.run("launcherAddMember('codex')");
  e.field('qlRole0', 'proposer');
  e.field('qlRole1', 'critic');
  assert.equal(e.run('launcherSaveTile()'), true);
  assert.deepEqual(e.tiles()[0].members,
    [{name: 'claude', role: 'proposer'}, {name: 'codex', role: 'critic'}]);
});

test('a role left blank is left off rather than sent empty', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  e.field('qlName', 'Solo');
  e.run("launcherAddMember('claude')");
  e.run('launcherSaveTile()');
  assert.deepEqual(e.tiles()[0].members, [{name: 'claude'}]);
});

test('dropping a member takes the right one out', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  e.run("launcherAddMember('claude')");
  e.run("launcherAddMember('codex')");
  e.run("launcherAddMember('claude')");
  e.run('launcherDropMember(1)');
  assert.deepEqual(e.draft().members.map(m => m.name), ['claude', 'claude']);
});

test('the roster is capped where the schema caps it', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  for (let i = 0; i < 9; i++) e.run("launcherAddMember('claude')");
  assert.equal(e.draft().members.length, 8);
  assert.ok(e.log.some(l => l[0] === 'toast' && /At most 8/.test(l[1])));
});

test('the arbitrator is offered at exactly two, and needs something to decide about', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  e.field('qlName', 'Review');
  e.run("launcherAddMember('claude')");
  assert.ok(!/launcherPickArb/.test(e.body()), 'not at one — nobody to decide between');
  e.run("launcherAddMember('codex')");
  assert.ok(/launcherPickArb/.test(e.body()), 'offered at two');
  e.run("launcherPickArb('claude')");
  assert.equal(e.run('launcherSaveTile()'), false, 'a scope is not optional for an arbitrator');
  assert.match(e.dom.nodes.qlError.textContent, /deciding about/);
  e.field('qlScope', 'Which approach ships');
  assert.equal(e.run('launcherSaveTile()'), true);
  const t = e.tiles()[0];
  assert.deepEqual(t.arbitrator, {name: 'claude'});
  assert.equal(t.scope, 'Which approach ships');
});

test('an arbitrator survives a roster widened past the size it works at', () => {
  // Step 6's rule, from the other side: launcherWantsArb ignores it at three, and a tile edited
  // back down to two must still have the one it was given.
  const e = editor({tiles: [spawnTile({arbitrator: {name: 'claude'}, scope: 'ships'})]});
  e.run("launcherEditTile('t2')");
  e.run("launcherAddMember('codex')");
  assert.ok(!/launcherPickArb/.test(e.body()), 'and the field is hidden, not the value cleared');
  assert.equal(e.run('launcherSaveTile()'), true, 'three with a spare arbitrator is savable');
  assert.deepEqual(e.tiles()[0].arbitrator, {name: 'claude'});
  e.run("launcherEditTile('t2')");
  e.run('launcherDropMember(2)');
  assert.ok(/launcherPickArb/.test(e.body()), 'back at two, it is offered again');
  assert.equal(e.draft().arbitrator.name, 'claude');
});

test('None switches the arbitrator off', () => {
  const e = editor({tiles: [spawnTile({arbitrator: {name: 'claude'}, scope: 'ships'})]});
  e.run("launcherEditTile('t2')");
  e.run("launcherPickArb('')");
  e.run('launcherSaveTile()');
  assert.equal(e.tiles()[0].arbitrator, undefined);
});

// --- the list: reorder and delete ---

test('reordering moves one place and persists past a reload', () => {
  const e = editor({tiles: [runTile({id: 'a', label: 'A'}), runTile({id: 'b', label: 'B'}),
                            runTile({id: 'c', label: 'C'})]});
  e.run('openLauncherEdit()');
  e.run("launcherMove('c', -1)");
  assert.deepEqual(e.tiles().map(t => t.id), ['a', 'c', 'b']);
  // Read back out of storage by a second editor over the same localStorage, which is the only
  // question worth asking about an order: not what the dialog is holding, but what was written.
  const again = editor({tiles: []});
  again.store.herdr_launcher = e.store.herdr_launcher;
  assert.deepEqual(again.tiles().map(t => t.id), ['a', 'c', 'b']);
});

test('the ends do not fall off', () => {
  const e = editor({tiles: [runTile({id: 'a'}), runTile({id: 'b'})]});
  e.run("launcherMove('a', -1)");
  e.run("launcherMove('b', 1)");
  assert.deepEqual(e.tiles().map(t => t.id), ['a', 'b']);
});

test('the first and last rows do not offer the arrow that would do nothing', () => {
  const e = editor({tiles: [runTile({id: 'a', label: 'A'}), runTile({id: 'b', label: 'B'})]});
  e.run('openLauncherEdit()');
  const rows = e.body().split('class="ql-row"').slice(1);
  assert.match(rows[0], /Move A up"[^>]*disabled/);
  assert.ok(!/Move A down"[^>]*disabled/.test(rows[0]), 'the first row can still go down');
  assert.match(rows[1], /Move B down"[^>]*disabled/);
  assert.ok(!/Move B up"[^>]*disabled/.test(rows[1]), 'and the last can still go up');
});

test('delete asks first, and a refusal keeps the tile', () => {
  const no = editor({tiles: [runTile()], confirmed: false});
  no.run("launcherDelete('t1')");
  assert.equal(no.tiles().length, 1);
  const yes = editor({tiles: [runTile(), spawnTile()]});
  yes.run("launcherDelete('t1')");
  assert.deepEqual(yes.tiles().map(t => t.id), ['t2']);
  assert.ok(yes.log.some(l => l[0] === 'renderLauncher'));
});

test('an empty list still offers the one thing there is to do', () => {
  const e = editor();
  e.run('openLauncherEdit()');
  assert.match(e.body(), /launcherNewTile\(\)/);
});

// --- repoint ---

test('a tile whose Project is gone is opened on the field that is wrong', () => {
  const e = editor({tiles: [runTile({project_id: 'deleted'})]});
  e.run("launcherRepoint('t1')");
  assert.equal(e.dom.nodes.launcherModal.style.display, 'block', 'the dialog is up');
  assert.equal(e.title(), 'Edit tile');
  assert.equal(e.draft().id, 't1');
  assert.ok(e.log.some(l => l[0] === 'toast' && /pick another/.test(l[1])));
  // Both live Projects are on offer, and neither is the one it points at.
  assert.match(e.body(), /launcherPickProject\('p1'\)/);
  assert.match(e.body(), /launcherPickProject\('p2'\)/);
});

test('repointing re-enables the tile, and changes nothing else about it', () => {
  const e = editor({tiles: [spawnTile({project_id: 'deleted', arbitrator: {name: 'claude'},
                                       scope: 'ships'})]});
  const before = e.tiles()[0];
  assert.equal(e.run(`launcherGate(${JSON.stringify(before)}, launcherEnv()).badge`),
               'Missing Project');
  e.run("launcherRepoint('t2')");
  e.run("launcherPickProject('p2')");
  assert.equal(e.run('launcherSaveTile()'), true);
  const after = e.tiles()[0];
  assert.equal(after.project_id, 'p2');
  assert.equal(e.run(`launcherGate(${JSON.stringify(after)}, launcherEnv()).ok`), true);
  // A repoint is one field. Everything the tile was carrying is still on it.
  assert.equal(after.label, before.label);
  assert.deepEqual(after.members, before.members);
  assert.deepEqual(after.arbitrator, before.arbitrator);
  assert.equal(after.scope, before.scope);
});
