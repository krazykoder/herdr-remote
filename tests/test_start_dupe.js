// Duplicate, and start-a-session-to-pair-with, over a stub DOM.
//
// Both bypass parts of the start dialog, so the message they put on the wire is the thing worth
// pinning: the relay refuses an agent outside its allowlist, an unknown role, and any field the
// placement did not ask for. The other half is what happens when the session finally lands —
// which of the two intents claims it, and what happens when neither does. Runs the block straight
// out of web/index.html so the single-file app keeps its no-build-step property, the same trick
// tests/test_bottom_dock.js uses.
//
//   node --test tests/test_start_dupe.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const PAIRS_PURE = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'pairs_pure.js'), 'utf8');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'start_dialog.js'), 'utf8');

const PANE = {
  pane_id: 'w1:p1', label: 'Architect 1', agent: 'claude', project_id: 'proj',
  project: 'charts', workspace_id: 'w1', host: 'local',
};

// A fresh context per test: pendingStart and startIntent are module state and an abandoned
// dialog's intent must not leak into the next one.
function startCtx({pane = PANE, options = {roles: ['architect', 'reviewer', 'agent'], agents: ['claude', 'codex']}, pairs = [], starter = '', store = {}} = {}) {
  const els = {};
  const el = id => els[id] || (els[id] =
    {id, value: '', textContent: '', hidden: false, style: {}, options: [], disabled: false,
     innerHTML: '', focus() {}});
  const sent = [];
  const calls = [];
  const live = pane ? [pane] : [];
  // The pair half of the dialog, stubbed to the two things this block reads back off it: which
  // pane the dialog is open on, and whether saving closed it. The real savePair is covered in
  // tests/test_pairs.js and in the browser.
  const g = {
    document: {getElementById: el},
    // A real one, not a null: what the dialog opens on turns on the difference between a key
    // that was never written and one written empty, so a stub that answers null to both cannot
    // see the behaviour under test.
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    window: {}, console,
    // Captured rather than dropped: the status card's busy state ends on a timer, and a test
    // that cannot fire it cannot see the one state that has no other way out.
    clearTimeout() { g.timer = null; },
    setTimeout: (fn) => { g.timer = fn; return 1; },
    ws: {send: s => sent.push(JSON.parse(s))},
    agents: live,
    shells: [],
    startOptions: options,
    activePane: pane ? pane.pane_id : null,
    slotFor: () => 'wide',
    paneOf: id => live.find(a => a.pane_id === id) || null,
    openTerminal: id => calls.push(['open', id]),
    openPairDialog: id => { calls.push(['pair', id]); g.pairSource = live.find(a => a.pane_id === id); },
    choosePartner: id => { calls.push(['partner', id]); g.pairPartner = live.find(a => a.pane_id === id); },
    savePair: () => { calls.push(['save']); g.pairSource = null; },
    pairs,
    pairSource: null,
    pairPartner: null,
    pairFor: (list, id) => list.find(p => p.members.some(m => m.pane_id === id)) || null,
    projects: [{id: 'proj', label: 'charts'}, {id: 'root', label: 'Common', root: true}],
    fillSelect: () => 1,
    renderStartTarget() {},
    agentColor: () => 'var(--blue)',
    badgeHtml: () => '',
    renderStartProjects() {},
    setStartError() {},
    escapeHtml: t => String(t),
    // conversation_store's, which this slice does not load. It answers what a pane was started
    // as; duplicating is meant to carry that, not drop it.
    convStarterOf: () => starter,
    // agent_configs.js's one question, stubbed to the aliases this relay still offers.
    agentConfigLive: (id, kind) => (options && (options.configs || [])
      .some(c => c.id === id && c.kind === kind)),
    showToast: t => calls.push(['toast', t]),
    // status_bar.js's, which this slice does not load: which Project the strip is filtered to,
    // and the one call the new-project sheet makes back into it.
    activeProject: null,
    selectProject: id => calls.push(['select', id]),
    syncStartProjectBadge() {}, renderStartRoles() {}, renderStartAgents() {},
    restoreStartChoice() {}, startRoles: () => [],
    // What submitStart reaches for outside this module: the role row, the opening prompt that
    // goes with it, and the pane a swap spends on the way out.
    startRoleOf: () => ({at: 'architect', role: 'architect'}),
    roleStarter: () => '', NO_STARTER: 'none', startMode: 'agent',
    endPane: id => { calls.push(['end', id]); return true; },
  };
  const ctx = vm.createContext(g);
  vm.runInContext(PAIRS_PURE, ctx);
  vm.runInContext(SRC, ctx);
  return {el, sent, calls, g, run: src => vm.runInContext(src, ctx)};
}

test('a duplicate carries the pane\'s harness into the pane\'s own tab', () => {
  const {sent, run} = startCtx();
  run('duplicatePane()');
  assert.deepEqual(sent, [{
    type: 'start_agent', name: 'claude', role: 'architect', project_id: 'proj',
    placement: 'new_tab', slot: 'wide', workspace_id: 'w1',
  }]);
  // No label: the relay names it for the role, so the copy is "Architect 2" and not a second
  // pane wearing the first one's name.
  assert.ok(!('label' in sent[0]));
});

test('a pane whose workspace the snapshot does not name gets its own', () => {
  const {sent, run} = startCtx({pane: {...PANE, workspace_id: null}});
  run('duplicatePane()');
  assert.equal(sent[0].placement, 'new_workspace');
  // new_workspace takes no target field — the relay rejects the message outright if one rides along.
  assert.ok(!('workspace_id' in sent[0]));
});

test('the role comes off the label, and a renamed pane falls back rather than sending nonsense', () => {
  assert.equal(startCtx({pane: {...PANE, label: 'Reviewer 3'}}).run('roleOf(agents[0])'), 'reviewer');
  assert.equal(startCtx({pane: {...PANE, label: 'nightly build'}}).run('roleOf(agents[0])'), 'architect');
  assert.equal(startCtx({pane: {...PANE, label: null}}).run('roleOf(agents[0])'), 'architect');
});

test('nothing to duplicate is offered when the relay would only refuse it', () => {
  const no = (over, opts) => {
    const {sent, run} = startCtx({pane: {...PANE, ...over}, ...(opts || {})});
    assert.equal(run('canDuplicate(agents[0])'), false);
    run('duplicatePane()');
    assert.deepEqual(sent, [], 'sent a start the relay would have refused');
  };
  no({agent: 'gemini'});             // outside HERDR_START_AGENTS
  no({agent: null});                 // a terminal has no harness to copy
  no({project_id: null});            // cwd comes from the Project, so there has to be one
  no({}, {options: null});           // write extensions off
});

test('a duplicate lands in the new session even though the old one is open', () => {
  const {calls, run} = startCtx();
  run('duplicatePane()');
  run("agents.push({pane_id: 'w1:p2', label: 'Architect 2', agent: 'claude'}); pendingStart = 'w1:p2'; openPendingStart()");
  assert.deepEqual(calls, [['open', 'w1:p2']], 'the pane the user asked for is the one they get');
});

test('a plain start still defers to the pane the user is reading', () => {
  const {calls, run} = startCtx();
  run("agents.push({pane_id: 'w1:p2'}); pendingStart = 'w1:p2'; openPendingStart()");
  assert.deepEqual(calls, [], 'no intent means do not yank them out of it');
  run("activePane = null; pendingStart = 'w1:p2'; openPendingStart()");
  assert.deepEqual(calls, [['open', 'w1:p2']]);
});

test('start-and-pair comes back to the dialog with the new session chosen, and saves it', () => {
  const {calls, run} = startCtx();
  run("startIntent = {pair: 'w1:p1'}");
  run("agents.push({pane_id: 'w1:p2'}); pendingStart = 'w1:p2'; openPendingStart()");
  // The pair the button named is made, not left as a form. Asking to start a session *and pair
  // with it* is the whole decision; a dialog waiting on Save is the request half-done.
  assert.deepEqual(calls, [['pair', 'w1:p1'], ['partner', 'w1:p2'], ['save']]);
});

test('a pane already in a pair is never replaced without being asked', () => {
  // savePair drops whichever pair holds either pane. That is fine as an answer to a Save the user
  // pressed and unacceptable as one nobody was asked — so the dialog is left open on the warning.
  const existing = [{id: 'p1', name: 'Old pair', members: [{pane_id: 'w1:p1'}, {pane_id: 'w0:p9'}]}];
  const {calls, g, run} = startCtx({pairs: existing});
  run("startIntent = {pair: 'w1:p1'}");
  run("agents.push({pane_id: 'w1:p2'}); pendingStart = 'w1:p2'; openPendingStart()");
  assert.deepEqual(calls, [['pair', 'w1:p1'], ['partner', 'w1:p2']], 'saved over an existing pair');
  assert.ok(g.pairSource, 'the dialog closed on a pair the user has not confirmed');
});

test('an intent is spent once, so the next start is a plain one', () => {
  const {calls, run} = startCtx();
  run("startIntent = {pair: 'w1:p1'}");
  run("agents.push({pane_id: 'w1:p2'}); pendingStart = 'w1:p2'; openPendingStart()");
  run("agents.push({pane_id: 'w1:p3'}); pendingStart = 'w1:p3'; openPendingStart()");
  assert.deepEqual(calls.slice(3), [], 'the second start reopened the pair dialog');
});

test('opening the dialog any other way clears an abandoned intent', () => {
  const {run} = startCtx();
  run("startIntent = {pair: 'w1:p1'}; openStartDialog('proj')");
  assert.equal(run('startIntent'), null);
});

test('a pair source that has since exited leaves the session opened, not stranded', () => {
  const {calls, run} = startCtx();
  run("startIntent = {pair: 'gone'}");
  run("agents.push({pane_id: 'w1:p2'}); activePane = null; pendingStart = 'w1:p2'; openPendingStart()");
  assert.deepEqual(calls, [['open', 'w1:p2']]);
});

test('a start the poll has not seen yet stays pending', () => {
  const {calls, run} = startCtx();
  run("pendingStart = 'w9:p9'; openPendingStart()");
  assert.deepEqual(calls, []);
  assert.equal(run('pendingStart'), 'w9:p9', 'dropping it would strand the session for good');
});

test('a duplicate opens the way the pane it came from opened', () => {
  // The bare name a record written before the suffix carries — it still has to resolve.
  const {run} = startCtx({starter: 'architect'});
  run('duplicatePane()');
  // Both: the text is what gets typed at the new pane, and the name is what the conversation
  // records, so ending and starting it again still opens the same way.
  assert.equal(run('startStarter'), 'architect-prompt');
  assert.ok(run('startPrompt').includes('System_Prompt_2_Architect'),
    'the duplicate went out with no opening prompt');
});

test('a pane that was started as nothing duplicates as nothing', () => {
  const {run} = startCtx();
  run('duplicatePane()');
  assert.equal(run('startStarter'), '');
  assert.equal(run('startPrompt'), '');
});

test('the dialog opens on a starter until one is deliberately taken off', () => {
  // Never opened before: the first badge offered, rather than a start with no opening words.
  const first = startCtx();
  first.run("openStartDialog('proj')");
  assert.equal(first.run('startRolePick'), 'architect-prompt');

  // Tapping the lit badge off is how "no starter" is asked for, and it is remembered as such.
  first.run("pickStartRole('architect-prompt')");
  assert.equal(first.run('startRolePick'), '');
  const store = {};
  const off = startCtx({store: Object.assign(store, {herdr_start_role: ''})});
  off.run("openStartDialog('proj')");
  assert.equal(off.run('startRolePick'), '', 'a start deliberately left bare came back with a role');

  // And a badge this relay has since stopped offering falls to none rather than to a different
  // way of working — the same answer it always gave.
  const gone = startCtx({store: {herdr_start_role: 'gone-prompt'},
    options: {roles: ['architect'], agents: ['claude']}});
  gone.run("openStartDialog('proj')");
  assert.equal(gone.run('startRolePick'), '');
});

// --- an alias carried, and an alias gone ---

const OCLAUDE = {agents: ['claude', 'codex'], roles: ['architect', 'reviewer', 'agent'],
                 unattended: ['claude', 'codex'],
                 configs: [{id: 'oclaude1', label: 'oclaude1', kind: 'claude'}]};

test('a duplicate carries the agent config the pane was started under', () => {
  // Otherwise the copy is a second pane wearing the first one's name on a different endpoint,
  // which is the one way this item could lie about what it did.
  const {sent, run} = startCtx({pane: {...PANE, config: 'oclaude1'}, options: OCLAUDE});
  run('duplicatePane()');
  assert.equal(sent[0].config, 'oclaude1');
  assert.equal(sent[0].name, 'claude', 'and the harness is still what goes on the wire');
});

test('a duplicate of a config the relay has dropped asks rather than falls back', () => {
  // Coming up on the stock endpoint under the same name is the one outcome worth refusing: the
  // reader would have no way to tell the copy apart from the pane it came from.
  const {sent, calls, run} = startCtx({pane: {...PANE, config: 'gone'}, options: OCLAUDE});
  run('duplicatePane()');
  assert.deepEqual(sent, [], 'nothing is started');
  assert.ok(calls.some(c => c[0] === 'toast' && /gone/.test(c[1])), 'and it says why');
});

test('a duplicate comes up as unattended when the pane it copies was on a config', () => {
  // The snapshot does not say how the original was started, so the config is the whole of what is
  // known about it — and it is the same thing the Start dialog defaults on.
  const {sent, run} = startCtx({pane: {...PANE, config: 'oclaude1'}, options: OCLAUDE});
  run('duplicatePane()');
  assert.equal(sent[0].unattended, true);
});

test('a duplicate of a stock pane still asks before it acts', () => {
  const {sent, run} = startCtx({pane: PANE, options: OCLAUDE});
  run('duplicatePane()');
  assert.ok(!('unattended' in sent[0]));
});

test('the box is offered only where the relay has a flag for the harness', () => {
  const {run} = startCtx({options: Object.assign({}, OCLAUDE, {unattended: []})});
  assert.equal(run("startUnattendedOffered('claude')"), false);
  const {run: run2} = startCtx({options: OCLAUDE});
  assert.equal(run2("startUnattendedOffered('claude')"), true);
  assert.equal(run2("startUnattendedOffered('pi')"), false);
});

test('a busy status card gives up waiting rather than spinning for ever', () => {
  // Every other state on this card ends by timing out. Busy ends only when the pane it is waiting
  // for turns up in a snapshot — so a start whose pane never arrives left a spinner running until
  // the page was reloaded, over a session that had in fact come up and was working.
  const {el, g, run} = startCtx();
  run('showSpawnStatus("Session started — opening…", "busy")');
  assert.equal(el('spawnSpinner').hidden, false);
  assert.equal(el('spawnStatus').style.display, 'flex');
  assert.ok(g.timer, 'busy arms a timer of its own');
  g.timer();
  assert.equal(el('spawnSpinner').hidden, true, 'and stops spinning when it fires');
  assert.match(el('spawnStatusText').textContent, /no pane has appeared yet/);
  // Which is an ordinary transient state from there: the next timer is the one that hides it.
  g.timer();
  assert.equal(el('spawnStatus').style.display, 'none');
});

test('a card that resolves normally never fires the give-up timer', () => {
  const {el, g, run} = startCtx();
  run('showSpawnStatus("Starting claude…", "busy")');
  run('showSpawnStatus("Solo started.", "success")');
  assert.equal(el('spawnSpinner').hidden, true);
  g.timer();
  assert.equal(el('spawnStatus').style.display, 'none', 'success times out to hidden, not to a warning');
});


// --- Restart as… ------------------------------------------------------------------------------
//
// A pane runs one CLI, so replacing a member's harness costs the session it is running. What is
// under test is *when* that is spent: at the submit, not at the menu that opened the dialog.

function swapCtx() {
  const c = startCtx();
  c.el('startPlacement').value = 'new_tab';
  c.el('startTarget').value = 'w1';
  c.el('startName').value = '';
  c.run("startProjectId = 'proj'; startAgentPick = 'codex';" +
        "startIntent = {conv: 'c1', replace: 'k1', endFirst: 'w1:p1'};");
  return c;
}

test('a swap ends the pane it replaces when the start is submitted, not before', () => {
  const c = swapCtx();
  assert.deepEqual(c.calls, [], 'opening the dialog spends nothing');
  c.run('submitStart()');
  assert.deepEqual(c.calls, [['end', 'w1:p1']]);
  assert.equal(c.sent.length, 1, 'and the start goes out behind it');
  assert.equal(c.sent[0].type, 'start_agent');
});

test('a dialog closed without starting leaves the session running', () => {
  const c = swapCtx();
  c.run('closeStart()');
  assert.deepEqual(c.calls, [], 'nothing was ended, so there is nothing to have paused');
});

test('a second submit does not quit a pane id herdr may have recycled', () => {
  const c = swapCtx();
  c.run('submitStart()');
  c.run("document.getElementById('startSubmit').disabled = false; submitStart()");
  assert.deepEqual(c.calls, [['end', 'w1:p1']], 'the pane is spent once');
});

test('a start under a root can name the directory it makes', () => {
  const {el, sent, run} = startCtx();
  run("startAgentPick = 'claude'; startPickProject('root')");
  el('startPlacement').value = 'new_workspace';   // needs no target, so the sheet can be sent
  // The row is drawn because the relay called this Project a root, and the input inside it is
  // what a phone types into.
  assert.ok(/New folder/.test(el('startChildRow').innerHTML));
  el('startChild').value = ' notes ';
  run('submitStart()');
  // Trimmed, like the Name field beside it. The relay refuses a name outside the charset either
  // way — whitespace is not in it — so this only decides whether a phone's stray space costs a
  // round trip and an error about a word that looks right on screen.
  assert.equal(sent[0].child, 'notes');
  assert.equal(sent[0].project_id, 'root');
});

test('a Project that is not a root offers nothing to name', () => {
  const {el, sent, run} = startCtx();
  run("startAgentPick = 'claude'; startPickProject('proj')");
  el('startPlacement').value = 'new_workspace';
  assert.equal(el('startChildRow').innerHTML, '');
  assert.equal(el('startChildRow').hidden, true);
  run('submitStart()');
  assert.ok(!('child' in sent[0]), 'sent a child the relay would refuse');
});

test('an empty field is not a child, and a terminal never carries one', () => {
  const {el, sent, run} = startCtx();
  run("startAgentPick = 'claude'; startPickProject('root')");
  el('startPlacement').value = 'new_workspace';
  el('startChild').value = '';
  run('submitStart()');
  assert.ok(!('child' in sent[0]), 'blank text is "start in the root itself"');

  // Spaces are not blank. The field looks empty and is not, so it goes to the relay to be refused
  // rather than being trimmed away into a start in the root nobody asked for.
  const spaces = startCtx();
  spaces.run("startAgentPick = 'claude'; startPickProject('root')");
  spaces.el('startPlacement').value = 'new_workspace';
  spaces.el('startChild').value = '   ';
  spaces.run('submitStart()');
  assert.equal(spaces.sent[0].child, '   ');

  // open_terminal refuses `child` as an unexpected field, so the field is not drawn and its value
  // is not read even if something left one behind.
  const t = startCtx();
  t.run("startMode = 'terminal'; startPickProject('root')");
  t.el('startPlacement').value = 'new_workspace';
  t.el('startChild').value = 'notes';
  t.run('submitStart()');
  assert.equal(t.sent[0].type, 'open_terminal');
  assert.ok(!('child' in t.sent[0]));
});

// --- New project ---
//
// Making a Project is a mkdir on the relay's machine and nothing else, so the message is the
// whole of what this side does. The recency helpers come out of utils.js, which this slice does
// not otherwise load: they decide which Projects are offered and in what order.

const UTILS = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'utils.js'), 'utf8');
const recentFrom = UTILS.indexOf('const PROJECT_RECENT_KEY');
const recentTo = UTILS.indexOf('// --- Compact sections ---', recentFrom);
assert.ok(recentFrom !== -1 && recentTo > recentFrom, 'project recency helpers not in utils.js');
const RECENT = UTILS.slice(recentFrom, recentTo);

test('a new project names the root it goes under and the folder to make', () => {
  const {el, sent, run} = startCtx();
  run('openNewProject()');
  el('newProjectName').value = 'notes';
  run('submitNewProject()');
  assert.deepEqual(sent, [{type: 'create_project', project_id: 'root', name: 'notes'}]);
});

test('a folder nobody named is refused here rather than sent', () => {
  const {el, sent, run} = startCtx();
  run('openNewProject()');
  el('newProjectName').value = '';
  run('submitNewProject()');
  assert.deepEqual(sent, []);
  assert.match(el('newProjectError').textContent, /Name the folder/);
});

test('a name that is only spaces goes as it stands, for the relay to refuse', () => {
  // It looks empty and is not. Trimming it away would create the wrong thing quietly.
  const {el, sent, run} = startCtx();
  run('openNewProject()');
  el('newProjectName').value = '  ';
  run('submitNewProject()');
  assert.deepEqual(sent, [{type: 'create_project', project_id: 'root', name: '  '}]);
});

test('a refusal is said in the sheet, which stays open on what was typed', () => {
  const {el, run} = startCtx();
  run('openNewProject()');
  el('newProjectName').value = '../escape';
  run('submitNewProject()');
  run('newProjectResult({ok: false, error: "child must be 1-64 characters"})');
  assert.match(el('newProjectError').textContent, /child must be/);
  assert.equal(el('newProjectSheet').style.display, 'block');
  assert.equal(el('newProjectName').value, '../escape');
  assert.equal(el('newProjectSubmit').disabled, false, 'left the button dead after a refusal');
});

test('a project that was made is opened, not merely announced', () => {
  const {el, calls, run} = startCtx();
  run('openNewProject()');
  el('newProjectName').value = 'notes';
  run('submitNewProject()');
  run('newProjectResult({ok: true, project_id: "root-notes"})');
  assert.equal(el('newProjectSheet').style.display, 'none');
  assert.deepEqual(calls.filter(c => c[0] === 'select'), [['select', 'root-notes']]);
});

test('the sheet asks which root only when there is more than one', () => {
  const {el, g, run} = startCtx();
  run('openNewProject()');
  assert.equal(el('newProjectRootRow').hidden, true);
  g.projects = [{id: 'root', label: 'Common', root: true},
                {id: 'scratch', label: 'Scratch', root: true}];
  run('openNewProject()');
  assert.equal(el('newProjectRootRow').hidden, false);
});

test('it opens under the project being looked at when that project is a root', () => {
  const {el, sent, g, run} = startCtx();
  g.projects = [{id: 'root', label: 'Common', root: true},
                {id: 'scratch', label: 'Scratch', root: true}];
  g.activeProject = 'scratch';
  run('openNewProject()');
  el('newProjectName').value = 'notes';
  run('submitNewProject()');
  assert.equal(sent[0].project_id, 'scratch');
});

test('projects are offered most recently picked first, and a container is not offered', () => {
  const {g, run} = startCtx();
  g.projects = [{id: 'a', label: 'A'}, {id: 'b', label: 'B'},
                {id: 'c', label: 'C', root: true, container: true}];
  run(RECENT);
  // Nothing picked yet: roster order, which is what every browser saw before this existed.
  assert.deepEqual(run('projectsForPicking().map(p => p.id)'), ['a', 'b']);
  run('noteProjectUse("b")');
  assert.deepEqual(run('projectsForPicking().map(p => p.id)'), ['b', 'a']);
  // "All" is not a Project and never displaces one.
  run('noteProjectUse(null)');
  assert.deepEqual(run('projectsForPicking().map(p => p.id)'), ['b', 'a']);
});
