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
const OPTIONS = {agents: ['claude', 'codex'], roles: ['agent'], terminal: true,
                 configs: [{id: 'oclaude', label: 'oClaude', kind: 'claude'}]};

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
    // launcher_ui draws the glyphs; pairs_pure holds the chips a member's first prompt is picked
    // from. Both are stubbed rather than pulled in — this suite is about the shape the form
    // produces, and dragging either module behind it would make a failure here point at it.
    launcherIcon: name => `<svg data-icon="${name}"></svg>`,
    // arbitration.js's own controls, borrowed by the launcher's arbitrator block. Stubbed to the
    // shape the form depends on — an element carrying the id it will be read back by — rather
    // than pulled in, so a failure here points at the launcher.
    arbRoleField: (id, v) => `<div class="arb-role"><input id="${id}" value="${v || ''}"></div>`,
    arbClockOptions: (choices, sel) => choices.map(m =>
      `<option value="${m}"${String(m) === String(sel) ? ' selected' : ''}>${m || 'Never'}</option>`).join(''),
    arbLimitField: (id, label, v, range) =>
      `<label>${label}<input id="${id}" type="number" value="${v || range[0]}"></label>`,
    ARB_IDLE_CHOICES: [0, 5, 15, 30],
    ARB_RUNTIME_CHOICES: [0, 15, 30, 60],
    ARB_LIMITS: {arbSteps: [8, 50], arbRuns: [8, 20], arbMinutes: [45, 480]},
    canonAt: at => at || '',
    SHORTCUTS: [{at: 'architect', label: 'Architect prompt', text: '@architect-brief'},
                {at: 'implement', label: 'Implement', text: 'Proceed to implement.'}],
    // The phrases the role pills write, which is what the launcher's defaults are resolved
    // through — the tags are the launcher's, the words are arbitration's.
    ARB_ROLE_TAGS: [{tag: 'implement', text: 'writes the code'},
                    {tag: 'fix-code', text: 'fixes what review finds'},
                    {tag: 'review', text: 'reviews the other one\u2019s work'},
                    {tag: 'test-min', text: 'minimal focused test'},
                    {tag: 'next', text: 'proposes the next steps'}],
    agentBadge: kind => ` <span class="badge">${kind}</span>`,
    agentConfigRows: () => startOptions.configs || [],
    // The launch sheet's two-tap Start. Recorded rather than armed: what this suite checks is
    // that the second tap is what reaches launcherPressIn.
    armButton: (btn, label, run) => { log.push(['arm', label]); run(); },
    launcherPressIn: (id, project, name) => { log.push(['pressIn', id, project, name]); return true; },
    launcherConfirmLines: t => [`Start ${t.label} on ${t.project_id}?`],
    launcherNoun: () => 'conversation',
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

test('the insecure box is kept on the tile, and absent rather than false when unticked', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('run')");
  e.field('qlName', 'Free model');
  e.field('qlCommand', 'pytest -q');
  assert.match(e.body(), /id="qlInsecure"/, 'the form offers it');
  e.dom.get('qlInsecure').checked = true;
  assert.equal(e.run('launcherSaveTile()'), true);
  const [tile] = e.tiles();
  assert.equal(tile.insecure, true);
  assert.equal(e.run(`launcherInsecure(${JSON.stringify({insecure: true})})`), true);
  // Unticked writes nothing: a tile that never made the claim should not carry a field saying so.
  e.run(`launcherEditTile('${tile.id}')`);
  assert.match(e.body(), /id="qlInsecure" checked/, 'and reopens ticked');
  e.dom.get('qlInsecure').checked = false;
  assert.equal(e.run('launcherSaveTile()'), true);
  assert.equal('insecure' in e.tiles()[0], false);
});

test('a new tile opens on no Project, because a template is the more useful tile', () => {
  const e = editor();
  e.run('openLauncherEdit()');
  assert.equal(e.dom.nodes.launcherModal.style.display, 'block');
  e.run('launcherNewTile()');
  assert.equal(e.title(), 'New tile');
  // Opening on one Project would make the narrower tile the one people build by accident. None is
  // a template: the same roster pressed into whichever tree wants it, asked for at the press.
  assert.equal(e.draft().project_id, '');
  // Sessions first: it is what the launcher is mostly for, and it is the first badge offered.
  assert.equal(e.draft().action, 'spawn');
  assert.match(e.body(), /launcherPickProject\(''\)/, 'and the strip offers it by name');
});

test('a template saves without a Project, and says so on the tile', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('run')");
  e.field('qlName', 'Tests');
  e.field('qlCommand', 'pytest -q');
  assert.equal(e.run('launcherSaveTile()'), true);
  assert.equal(e.tiles()[0].project_id, '');
});

test('a relay with terminals off opens the form on the half that works', () => {
  // A form whose first act is to refuse is a form that has asked nothing.
  const e = editor({startOptions: {agents: ['claude'], terminal: false}});
  e.run('launcherNewTile()');
  assert.equal(e.draft().action, 'spawn');
});

test('a relay that starts nothing opens the form on a terminal', () => {
  const e = editor({startOptions: {agents: [], terminal: true}});
  e.run('launcherNewTile()');
  assert.equal(e.draft().action, 'term');
});

test('a terminal tile needs no command, and keeps one if it was typed', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('term')");
  e.field('qlName', 'Shell');
  assert.equal(e.run('launcherSaveTile()'), true);
  const [t] = e.tiles();
  assert.equal(t.action, 'term');
  assert.equal(t.command, '');
  // Switching between the two keeps what was typed: they differ by whether the line is required.
  e.run(`launcherEditTile('${t.id}')`);
  e.field('qlCommand', 'htop');
  e.run("launcherPickAction('run')");
  assert.equal(e.run('launcherSaveTile()'), true);
  assert.equal(e.tiles()[0].command, 'htop');
});

test('a run tile saved from the form carries a command and no roster', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('run')");
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
  e.run("launcherPickAction('run')");
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
  // `at` comes with every member added: a session started with no opening instruction is the
  // rarer answer, so the default is the one that says something.
  assert.deepEqual(e.tiles()[0].members,
    [{name: 'claude', role: 'proposer', at: 'architect-prompt'},
     {name: 'codex', role: 'critic', at: 'architect-prompt'}]);
});

test('custom aliases are offered in both tile pickers and retain their config id', () => {
  const e = editor();
  e.run('openLauncherEdit()');
  e.run('launcherNewTile()');
  assert.match(e.body(), /\+custom/);
  e.run("launcherToggleCustom('members')");
  assert.match(e.body(), /oClaude/);
  e.run("launcherAddMember('claude', 'oclaude')");
  e.run("launcherAddMember('codex')");
  e.run("launcherPickArb('claude', 'oclaude')");
  e.field('qlName', 'Custom pair');
  e.field('qlScope', 'Review it');
  assert.equal(e.run('launcherSaveTile()'), true);
  const tile = e.tiles()[0];
  assert.equal(tile.members[0].config, 'oclaude');
  assert.equal(tile.arbitrator.config, 'oclaude');
});

test('a member can be named and given a first prompt, and both are stored', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  e.field('qlName', 'Review pair');
  e.run("launcherAddMember('claude')");
  e.field('qlMemberName0', 'Reviewer');
  e.field('qlAt0', 'implement');
  assert.equal(e.run('launcherSaveTile()'), true);
  assert.deepEqual(e.tiles()[0].members,
    [{name: 'claude', label: 'Reviewer', at: 'implement'}]);
});

test('no first prompt is a real answer, and is stored as none', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  e.field('qlName', 'Quiet');
  e.run("launcherAddMember('claude')");
  e.field('qlAt0', '');
  e.run('launcherSaveTile()');
  assert.deepEqual(e.tiles()[0].members, [{name: 'claude'}]);
});

test('a roster of more than one says it is a conversation, with the mark it will wear', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  e.run("launcherAddMember('claude')");
  assert.ok(!/ql-conv/.test(e.body()), 'one agent is not a room');
  e.run("launcherAddMember('codex')");
  assert.match(e.body(), /class="ql-conv"/);
  assert.match(e.body(), /data-icon="conv"/);
  assert.match(e.body(), /These 2 start together in one conversation/);
});

test('a role left blank is left off rather than sent empty', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  e.field('qlName', 'Solo');
  e.run("launcherAddMember('claude')");
  e.field('qlAt0', '');
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
  assert.match(e.body(), /@arbitrator starter prompt — not defined yet/);
  assert.equal(e.run('launcherSaveTile()'), false, 'a scope is not optional for an arbitrator');
  assert.match(e.dom.nodes.qlError.textContent, /deciding about/);
  e.field('qlScope', 'Which approach ships');
  assert.equal(e.run('launcherSaveTile()'), true);
  const t = e.tiles()[0];
  assert.deepEqual(t.arbitrator, {name: 'claude'});
  assert.equal(t.scope, 'Which approach ships');
});

test('an arbitrator stays offered as the roster grows past the pair it decides between', () => {
  // The pair is two and stays two; the room is not. Widening a roster used to hide the arbitrator
  // field, which read as the tile having lost it.
  const e = editor({tiles: [spawnTile({arbitrator: {name: 'claude'}, scope: 'ships'})]});
  e.run("launcherEditTile('t2')");
  e.run("launcherAddMember('codex')");
  assert.ok(/launcherPickArb/.test(e.body()), 'still offered at three');
  // Two role fields and no third: the third member is in the conversation, not in the pair.
  assert.ok(/id="qlRole1"/.test(e.body()));
  assert.ok(!/id="qlRole2"/.test(e.body()), 'and nothing is asked about the one outside the pair');
  assert.match(e.body(), /the arbitrator is not deciding between them/);
  assert.equal(e.run('launcherSaveTile()'), true);
  assert.deepEqual(e.tiles()[0].arbitrator, {name: 'claude'});
});

test('which two are arbitrated is a pair of selects, and picking moves the member up', () => {
  const e = editor({tiles: [spawnTile({arbitrator: {name: 'claude'}, scope: 'ships',
    members: [{name: 'claude', label: 'A'}, {name: 'codex', label: 'B'},
              {name: 'pi', label: 'C'}]})]});
  e.run("launcherEditTile('t2')");
  const body = e.body();
  assert.match(body, /id="qlPair0"/);
  assert.match(body, /id="qlPair1"/);
  // Slot 2 may not name what slot 1 already holds — a pair of the same pane is not a pair.
  const slot1 = body.slice(body.indexOf('id="qlPair1"'));
  assert.ok(!/value="0"/.test(slot1.slice(0, slot1.indexOf('</select>'))));
  // Picking C for slot 1 swaps it with A, because the pair is the first two of the roster.
  e.run('launcherPickPair(0, 2)');
  assert.deepEqual(e.draft().members.map(m => m.label), ['C', 'B', 'A']);
});

test('None switches the arbitrator off', () => {
  const e = editor({tiles: [spawnTile({arbitrator: {name: 'claude'}, scope: 'ships'})]});
  e.run("launcherEditTile('t2')");
  e.run("launcherPickArb('')");
  e.run('launcherSaveTile()');
  assert.equal(e.tiles()[0].arbitrator, undefined);
});

// --- the list: reorder and delete ---

test('a role is asked for only once there is an arbitrator to read it', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  e.field('qlName', 'Review pair');
  e.run("launcherAddMember('claude')");
  e.run("launcherAddMember('codex')");
  // A role means nothing to the agent — it is never shown it and is not started differently
  // because of it. So the member cards do not ask.
  assert.ok(!/id="qlRole0"/.test(e.body()), 'no role on the member card');
  e.run("launcherPickArb('claude')");
  assert.match(e.body(), /id="qlRole0"/);
  assert.match(e.body(), /id="qlRole1"/);
  // Listed by agent, so it is clear which role is being assigned to which.
  assert.match(e.body(), /class="ql-arb-member"/);
  assert.match(e.body(), /id="qlScope"/);
  e.run("launcherPickArb('')");
  assert.ok(!/id="qlRole0"/.test(e.body()), 'and it goes away with the arbitrator');
});

test('the clocks and limits are offered under the arbitrator, and stored when set', () => {
  const e = editor();
  e.run('launcherNewTile()');
  e.run("launcherPickAction('spawn')");
  e.field('qlName', 'Review pair');
  e.run("launcherAddMember('claude')");
  e.run("launcherAddMember('codex')");
  e.run("launcherPickArb('claude')");
  assert.match(e.body(), /Clocks and limits/);
  e.field('qlScope', 'Which approach ships');
  e.field('qlRole0', 'writes the code');
  e.field('qlIdle', '15');
  e.field('qlSteps', '20');
  assert.equal(e.run('launcherSaveTile()'), true);
  const t = e.tiles()[0];
  assert.equal(t.idle, 15);
  assert.equal(t.steps, 20);
  assert.equal(t.members[0].role, 'writes the code');
  // Never and the relay's own default are both "not answered", and are stored as absent rather
  // than as a copy of a number the relay owns.
  assert.ok(!('runtime' in t));
  assert.ok(!('warmup' in t));
});

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

// --- the arbitrator's two slots ---

test('appointing an arbitrator puts the pair in slot order and fills in what each is for', () => {
  const e = editor({tiles: [spawnTile({members: [{name: 'codex'}, {name: 'claude'}]})]});
  e.run("launcherEditTile('t2')");
  e.run("launcherPickArb('claude')");
  const d = e.draft();
  // claude implements, codex reviews — and the roster is reordered so Agent 1 is the implementer
  // rather than whichever was added first.
  assert.deepEqual(d.members.map(m => m.name), ['claude', 'codex']);
  assert.equal(d.members[0].role, 'writes the code, minimal focused test, '
    + 'fixes what review finds, proposes the next steps');
  assert.match(d.members[1].role, /^fixes what review finds, reviews the other one/);
  assert.match(d.members[1].role, /proposes the next steps$/);
});

test('a role somebody typed is never overwritten by the suggestion', () => {
  const e = editor({tiles: [spawnTile({members: [{name: 'claude', role: 'mine'},
                                                 {name: 'codex'}]})]});
  e.run("launcherEditTile('t2')");
  e.run("launcherPickArb('claude')");
  assert.equal(e.draft().members[0].role, 'mine');
});

test('each role field is headed by the name that member will launch under, and its badge', () => {
  const e = editor({tiles: [spawnTile({members: [{name: 'claude', label: 'Lead'},
                                                 {name: 'codex'}]})]});
  e.run("launcherEditTile('t2')");
  e.run("launcherPickArb('claude')");
  const body = e.body();
  // The heading is the slot, then the select saying who is in it, then that member's badge.
  assert.match(body, /Agent 1<\/span><select id="qlPair0"[\s\S]*?<\/select> <span class="badge">claude<\/span>/);
  assert.match(body, /Agent 2<\/span><select id="qlPair1"[\s\S]*?<\/select> <span class="badge">codex<\/span>/);
  // A member with a name of its own is offered under it; one without falls back to the kind, so
  // an option is never blank.
  assert.match(body, /<option value="0"[^>]*>Lead — claude<\/option>/);
  assert.match(body, /<option value="1"[^>]*>codex<\/option>/);
});

// --- the launch sheet ---

test('pressing a tile asks for the Project and the name in one sheet, and starts nothing', () => {
  const e = editor({tiles: [spawnTile({project_id: ''})]});
  assert.equal(e.run("launcherLaunchSheet(loadLauncher()[0])"), false);
  const body = e.body();
  assert.match(body, /launcherLaunchProject\('p1'\)/, 'every Project is offered');
  assert.match(body, /id="qlLaunchName"/, 'and the name is asked for in the same place');
  assert.match(body, /launcherLaunchFire\(this\)/);
  assert.deepEqual(e.log.filter(l => l[0] === 'pressIn'), []);
});

test('a template with no Project chosen refuses the Start rather than guessing one', () => {
  const e = editor({tiles: [spawnTile({project_id: ''})]});
  e.run("launcherLaunchSheet(loadLauncher()[0])");
  e.run('launcherLaunchFire({})');
  assert.deepEqual(e.log.filter(l => l[0] === 'pressIn'), []);
  assert.ok(e.log.some(l => l[0] === 'toast' && /Pick a Project/.test(l[1])));
});

test('the name survives picking a Project, and both reach the press', () => {
  const e = editor({tiles: [spawnTile({project_id: ''})]});
  e.run("launcherLaunchSheet(loadLauncher()[0])");
  e.field('qlLaunchName', 'Tonight');
  e.run("launcherLaunchProject('p2')");
  assert.match(e.body(), /value="Tonight"/, 'the redraw keeps what was typed');
  e.run('launcherLaunchFire({})');
  assert.deepEqual(e.log.filter(l => l[0] === 'pressIn'), [['pressIn', 't2', 'p2', 'Tonight']]);
  // Two taps, because this starts sessions in someone else's checkout.
  assert.ok(e.log.some(l => l[0] === 'arm' && l[1] === 'Start?'));
  // The tile is what it was — the Project chosen for one press is never written back.
  assert.equal(e.tiles()[0].project_id, '');
});
