// Changing which agent a member of a conversation is.
//
//   node --test tests/test_conv_swap.js
//
// A pane runs one CLI, so "make this member a pi instead of a claude" is a start whose destination
// happens to be a member that already exists. What matters is that it ends at the Start dialog
// holding the replace intent — nothing is sent from here, and the one thing a swap must not do is
// decide the replacement for the reader. The landing half (transcript carried across, pair
// repointed) is start_dialog's and is covered in tests/test_start_dupe.js.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REC = {key: 'k1', label: 'ARCH', spawn: {agent: 'claude', project_id: 'p1'}};

// shortcuts.js resolves what it borrows at call time, so a context holding the few things these
// two functions touch is the whole of what this needs. `convViewId` and `convViewRecs` are the
// module's own bindings and are set inside the context rather than handed in — a property on the
// context object is shadowed by the module's `let`.
function boot({live = [], recs = [REC], options = {agents: ['claude', 'pi'], roles: ['agent']}} = {}) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'src', 'shortcuts.js'), 'utf8');
  const log = [];
  const fields = {};
  const store = {};
  const ctx = vm.createContext({
    console, JSON, Math, Date, Object, Array, Set, Map, String, Number, setTimeout, clearTimeout,
    document: {getElementById: id => (fields[id] = fields[id] || {id, value: '', style: {}, innerHTML: '',
                                                                 classes: new Set(),
                                                                 classList: {toggle(n, on) {
                                                                   if (on) fields[id].classes.add(n);
                                                                   else fields[id].classes.delete(n);
                                                                 }}}),
               querySelector: () => null, createElement: () => ({style: {}}), addEventListener() {}},
    window: {addEventListener() {}}, localStorage: {getItem: () => null, setItem() {}},
    escapeHtml: s => String(s), agents: live, shells: [], startOptions: options,
    // utils.js's, which this module only concatenates into a header — see compactButton there.
    compactOn: () => false,
    compactButton: () => '<button class="section-action" aria-label="Compact cards"></button>',
    loadConvIndex: () => [{id: 'c1', members: [{key: 'k1'}]}],
    convMemberKey: a => a.pane_id || '',
    sessionStorage: {
      getItem: k => (store[k] === undefined ? null : store[k]),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    // Everything convRestart asks about before it ends anything — a live socket, a Project the
    // record names, an agent the relay still starts. Without them it refuses, which is the point.
    ws: {send() {}},
    projects: [{id: 'p1'}, {id: 'p2'}],
    showToast: () => {},
    openStartDialog: p => log.push(['open', p || '']),
    renderStartAgents: () => log.push(['render']),
    endPane: id => { log.push(['end', id]); return true; },
  });
  vm.runInContext(src, ctx);
  vm.runInContext(`convViewId = 'c1'; convViewRecs = ${JSON.stringify(recs)};`, ctx);
  return {log, fields, store, run: s => vm.runInContext(s, ctx),
          intent: () => vm.runInContext('JSON.stringify(startIntent)', ctx)};
}

test('swapping an ended member opens the dialog on its Project, holding the replace intent', () => {
  const e = boot();
  assert.equal(e.run("convSwapMember('k1')"), true);
  assert.deepEqual(e.log, [['open', 'p1']], 'nothing is started, and no harness is chosen for them');
  assert.deepEqual(JSON.parse(e.intent()), {conv: 'c1', replace: 'k1'},
    'so whatever lands continues this member rather than joining beside it');
  assert.equal(e.fields.startName.value, 'ARCH', 'under the name the thread knows it by');
});

test('the intent is set after the dialog opens, because opening one clears it', () => {
  // openStartDialog nulls startIntent on every route in — an abandoned start must not attach
  // itself to whatever is started next. Set before the open, a swap would silently become a
  // plain start into the same conversation.
  const e = boot();
  e.run("convSwapMember('k1')");
  assert.notEqual(e.intent(), 'null');
});

test('restarting a live member as something else ends its session first', () => {
  // There is no changing the agent inside a running pane. The button asks twice; this is what
  // happens after the second tap.
  const e = boot({live: [{pane_id: 'w1:p1', project_id: 'p2'}],
                  recs: [Object.assign({}, REC, {key: 'w1:p1'})]});
  assert.equal(e.run("convStartAs('w1:p1')"), true);
  assert.deepEqual(e.log, [['end', 'w1:p1'], ['open', 'p2']],
    'ended, then asked — and on the Project the pane is in now, not the one it was recorded under');
});

test('a member of no conversation, or a relay that starts nothing, swaps nothing', () => {
  assert.equal(boot({options: null}).run("convSwapMember('k1')"), false);
  assert.equal(boot().run("convSwapMember('nobody')"), true,
    'an unknown key still opens the dialog — the conversation is real and the member is its own');
});


// --- Picking a restarted member back up ---
//
// The relay's answer to a start names the pane it made, and it arrives on one socket, once. Reload
// the tab in between and the agent is running with nothing tying it to the conversation it was
// started for. So the start names itself: the relay stamps that id on the pane and carries it on
// every snapshot, and what follows is an equality rather than a guess at which pane this was.

const HELD = 'herdr_conv_respawn';

function held(e) { return JSON.parse(e.store[HELD] || 'null'); }

test('the pane a restart names itself with is the one it is found by', () => {
  const e = boot({live: [{pane_id: 'w1:p9', ref: 'rABC'}, {pane_id: 'w1:p8', ref: 'rXYZ'}]});
  assert.equal(e.run("(convRespawnPane('rABC') || {}).pane_id"), 'w1:p9');
  assert.equal(e.run("convRespawnPane('rNOPE')"), null);
  assert.equal(e.run("convRespawnPane('')"), null, 'a pane carrying no ref matches no start');
});

test('a note older than the window names a pane somebody else is using by now', () => {
  const e = boot({live: [{pane_id: 'w1:p9', ref: 'rABC'}]});
  e.run(`sessionStorage.setItem('${HELD}', JSON.stringify(
    {conv: 'c1', key: 'k1', ref: 'rABC', at: Date.now() - 130000}))`);
  assert.equal(e.run('JSON.stringify(heldConvRespawn())'), 'null');
  assert.equal(held(e), null, 'and it is dropped rather than reconsidered on the next snapshot');
});

test('a pane a start in flight will land on is not filed as a fresh one', () => {
  // convAutoJoin files every unreferenced pane into a conversation of its own on the next
  // snapshot. A key some conversation names is one convContinueTranscript refuses to write over,
  // so filing this pane would split the thread it was started to continue into two members.
  const e = boot({live: [{pane_id: 'w1:p9', ref: 'rABC'}]});
  e.run(`sessionStorage.setItem('${HELD}', JSON.stringify(
    {conv: 'c1', key: 'k1', ref: 'rABC', at: Date.now()}))`);
  assert.equal(e.run("convStartClaimed({pane_id: 'w1:p9', ref: 'rABC'})"), true);
  assert.equal(e.run("convStartClaimed({pane_id: 'w1:p8', ref: 'rXYZ'})"), false,
    'and every other pane is filed exactly as before');
});

test('the note is written before the start goes out, and cleared once it is acted on', () => {
  const e = boot({live: [{pane_id: 'w1:p9', ref: 'rABC'}]});
  e.run(`sessionStorage.setItem('${HELD}', JSON.stringify(
    {conv: 'c1', key: 'k1', ref: 'rABC', at: Date.now()}))`);
  assert.equal(held(e).ref, 'rABC');
  e.run('forgetConvRespawn()');
  assert.equal(held(e), null);
});

test('only one snapshot resumes a restart while its record is loading', async () => {
  const e = boot({live: [{pane_id: 'w1:p9', ref: 'rABC'}]});
  e.run(`sessionStorage.setItem('${HELD}', JSON.stringify(
    {conv: 'c1', key: 'k1', ref: 'rABC', at: Date.now()}))`);
  e.run(`let opens = 0;
    openPendingStart = () => { opens += 1; };
    showSpawnStatus = () => {};
    paneLabel = a => a.label || a.agent || a.pane_id;
    convGet = () => new Promise(resolve => setTimeout(
      () => resolve([{spawn: {starter: 'architect'}}]), 0));`);
  await e.run('Promise.all([convResumeRespawn(), convResumeRespawn()])');
  assert.equal(e.run('opens'), 1);
  assert.equal(held(e), null);
});


// --- The archive on the landing list ---

test('an archived conversation is drawn under the archive, not lost with the button that counts it', () => {
  // The rows were built from the shown list alone, so the archived ones matched nothing when the
  // archive was opened: the button said "Archive (1)" and there was never a card under it, which
  // is a conversation put away and not gettable back.
  const e = boot();
  e.run(`
    loadConvIndex = () => [
      {id: 'c1', name: 'Active', members: [{key: 'k1', label: 'A', agent: 'claude', project: 'Charts'}]},
      {id: 'c2', name: 'Put away', members: [{key: 'k2', label: 'B', agent: 'agy', project: 'Relay'}],
       archived: true},
    ];
    convLandingAutoOn = () => false;
    convLandingArchiveOn = () => true;
    convSeenAt = () => 0;
    convNoteCounts = () => {};
    convGlyph = () => '#';
    agentBadge = a => '<span class="badge">' + a + '</span>';
    paneLabel = a => a.label || a.pane_id;
    fmtAgo = () => 'just now';
    applySections = () => {};
    renderConversations();`);
  const html = e.fields.conversations.innerHTML;
  assert.match(html, /Archived conversations/);
  assert.match(html, /Put away/, 'the archived card itself, not just its heading');
  assert.match(html, /Unarchive/, 'and the way back');
  assert.match(html, /badge">agy</, 'wearing the harness badge its members carry');
  assert.match(html, /badge proj">@Relay/, 'and the Project they are working in');
});

test('an archived conversation is not drawn among the active ones', () => {
  const e = boot();
  e.run(`
    loadConvIndex = () => [
      {id: 'c2', name: 'Put away', members: [{key: 'k2', label: 'B'}], archived: true},
    ];
    convLandingAutoOn = () => false;
    convLandingArchiveOn = () => false;
    convSeenAt = () => 0;
    convNoteCounts = () => {};
    convGlyph = () => '#';
    agentBadge = a => '';
    paneLabel = a => a.label || a.pane_id;
    fmtAgo = () => 'just now';
    applySections = () => {};
    renderConversations();`);
  const html = e.fields.conversations.innerHTML;
  assert.doesNotMatch(html, /Put away/);
  assert.match(html, /No conversations yet/, 'an all-archived list reads as an empty one');
});


// --- Reset and Restart ---

test('reset clears the harness and then says the words the session was started with', () => {
  // Two sends into one pane, in that order: the opening prompt must reach a cleared session. The
  // relay keeps a pane's messages in the order they arrived, which is why this needs no waiting.
  const e = boot({live: [{pane_id: 'w1:p1', agent: 'claude'}],
                  recs: [{key: 'w1:p1', spawn: {agent: 'claude', starter: 'architect-prompt'}}]});
  e.run(`
    sent = [];
    // The codex substitution, as agentSlash really does it: a leading slash becomes a dollar.
    // The clear must not go through it — see the codex test below.
    agentSlash = (t, a) => (a === 'codex' && t[0] === '/' ? '$' + t.slice(1) : t);
    agentHarness = a => a;
    respawnStarter = () => ({at: 'architect-prompt'});
    roleStarter = () => 'You are the architect.';
    sendTextTo = (pane, text) => { sent.push([pane, text]); return true; };`);
  assert.equal(e.run("convResetMember('w1:p1')"), true);
  assert.deepEqual(e.run('JSON.stringify(sent)') && JSON.parse(e.run('JSON.stringify(sent)')),
    [['w1:p1', '/clear'], ['w1:p1', 'You are the architect.']]);
});

test('a harness that calls it something else gets its own word', () => {
  const e = boot({live: [{pane_id: 'w1:p1', agent: 'pi'}],
                  recs: [{key: 'w1:p1', spawn: {agent: 'pi', starter: 'none'}}]});
  e.run(`
    sent = [];
    agentSlash = t => t;
    agentHarness = a => a;
    respawnStarter = () => null;
    roleStarter = r => (r ? 'never asked for' : '');
    sendTextTo = (pane, text) => { sent.push([pane, text]); return true; };`);
  e.run("convResetMember('w1:p1')");
  // NO_STARTER, so the clear is the whole of it — a session that asked for silence is started
  // again in silence.
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(sent)')), [['w1:p1', '/new']]);
});

test('reset does nothing for a member with no live pane', () => {
  const e = boot();
  e.run(`sent = []; agentSlash = t => t; agentHarness = a => a; roleStarter = () => '';
         sendTextTo = () => { sent.push(1); return true; };`);
  assert.equal(e.run("convResetMember('k1')"), false);
  assert.equal(e.run('sent.length'), 0);
});

test('restarting a live member ends it and starts the same thing again', () => {
  const e = boot({live: [{pane_id: 'w1:p1'}], recs: [Object.assign({}, REC, {key: 'w1:p1'})]});
  e.run("respawned = []; convRespawn = k => respawned.push(k);");
  e.run("convRestart('w1:p1')");
  assert.deepEqual(e.log, [['end', 'w1:p1']], 'the session it had');
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(respawned)')), ['w1:p1'],
    'and the same one started again, with no dialog in between');
});

test('restarting a paused member starts it without ending anything', () => {
  // The row's one Restart, on the half of a member's life that has no pane. Nothing to end, so
  // nothing is ended — what used to be Start again is the same button reaching the same place.
  const e = boot({live: [], recs: [Object.assign({}, REC, {key: 'w1:p1'})]});
  e.run("respawned = []; convRespawn = k => respawned.push(k);");
  assert.equal(e.run("convRestart('w1:p1')"), true);
  assert.deepEqual(e.log, [], 'no pane was touched');
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(respawned)')), ['w1:p1']);
});

test('a restart that cannot start leaves the session running', () => {
  // The order that matters: everything that can refuse is asked before the pane is quit. A
  // restart that ends a session and then finds it cannot start one leaves the member paused with
  // an orphaned pane beside it — the state this whole control exists to avoid.
  const e = boot({live: [{pane_id: 'w1:p1'}],
                  recs: [{key: 'w1:p1', spawn: {agent: 'claude', project_id: 'gone'}}]});
  e.run("respawned = []; convRespawn = k => respawned.push(k); said = []; showToast = m => said.push(m);");
  assert.equal(e.run("convRestart('w1:p1')"), false);
  assert.deepEqual(e.log, [], 'nothing was ended');
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(respawned)')), []);
  assert.match(e.run('said[0]'), /cannot be restarted/);
});

test('restart does not replace a pane that could not end', () => {
  const e = boot({live: [{pane_id: 'w1:p1'}], recs: [Object.assign({}, REC, {key: 'w1:p1'})]});
  e.run("endPane = () => false; respawned = []; convRespawn = k => respawned.push(k);");
  assert.equal(e.run("convRestart('w1:p1')"), false);
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(respawned)')), []);
});

test('restart all goes one member at a time, and waits for a start in flight', () => {
  // A restart owns startIntent and the respawn note, and there is one of each — fired in a loop
  // they would trample each other and only the last member would continue its thread.
  const e = boot({
    live: [{pane_id: 'a'}, {pane_id: 'b'}],
    recs: [{key: 'a', spawn: {agent: 'claude', project_id: 'p1'}},
           {key: 'b', spawn: {agent: 'claude', project_id: 'p1'}}],
  });
  e.run(`
    projects = [{id: 'p1'}];
    pendingStart = null;
    fired = [];
    showSpawnStatus = () => {};
    showToast = () => {};
    loadConvIndex = () => [{id: 'c1', members: [{key: 'a'}, {key: 'b'}]}];
    convRestart = k => fired.push(k);
    convRestartAll();`);
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(fired)')), ['a'], 'one out, one queued');
  e.run("pendingStart = 'w1:p9'; convRestartStep();");
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(fired)')), ['a'], 'and it waits for that one');
  e.run('pendingStart = null; convRestartStep();');
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(fired)')), ['a', 'b']);
  e.run('convRestartStep();');
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(fired)')), ['a', 'b'], 'and then stops');
});


// --- The archive as a mode ---

function bootArchive(index, on, auto) {
  const e = boot();
  e.run(`
    loadConvIndex = () => ${JSON.stringify(index)};
    convLandingAutoOn = () => ${!!auto};
    convLandingArchiveOn = () => ${on};
    CONV_LANDING_AUTO_MAX = 10;
    convSeenAt = () => 0;
    convNoteCounts = () => {};
    convGlyph = () => '#';
    agentBadge = a => '';
    paneLabel = a => a.label || a.pane_id;
    fmtAgo = () => 'just now';
    applySections = () => {};
    renderConversations();`);
  return e.fields.conversations.innerHTML;
}

test('the archive is a mode: opening it shows the archived conversations and nothing else', () => {
  const html = bootArchive([
    {id: 'c1', name: 'Active', members: [{key: 'k1', label: 'A'}]},
    {id: 'c2', name: 'Put away', members: [{key: 'k2', label: 'B'}], archived: true},
  ], true);
  assert.match(html, /Put away/);
  assert.doesNotMatch(html, /Active/, 'the active list is not underneath it as well');
  assert.doesNotMatch(html, /\+ New/, 'and nothing here makes a new conversation');
});

test('cards are newest-first, and a pane never seen move keeps its place in the snapshot', () => {
  const e = boot();
  e.run(`
    lastSeen = {b: 200, c: 100};
    agentCard = a => a.pane_id + ',';
    out = agentCards([{pane_id: 'a'}, {pane_id: 'b'}, {pane_id: 'c'}, {pane_id: 'd'}]);`);
  assert.equal(e.run('out'), 'b,c,a,d,',
    'the two with a clock lead in clock order, the two without follow in snapshot order');
  // Terminals are panes too, and they are drawn by their own function.
  e.run(`
    shells = [{pane_id: 'a'}, {pane_id: 'b'}];
    startOptions = null;
    terminalCard = a => a.pane_id + ';';
    activeProject = '';
    term = terminalsHtml();`);
  assert.match(e.run('term'), /b;a;$/, 'the terminal list follows the same clock');
});

test('auto is a mode too, and the way out of either is the same arrow', () => {
  const index = [
    {id: 'c1', name: 'Named', members: [{key: 'k1', label: 'A'}]},
    {id: 'c2', name: 'Picked up', members: [{key: 'k2', label: 'B'}], auto: true},
    {id: 'c3', name: 'Put away', members: [{key: 'k3', label: 'C'}], archived: true},
  ];
  const auto = bootArchive(index, false, true);
  assert.match(auto, /Picked up/);
  assert.doesNotMatch(auto, /Named/, 'the named list is not underneath it as well');
  assert.doesNotMatch(auto, /\+ New/);
  assert.match(auto, /\u2190 Back/);
  assert.doesNotMatch(auto, /Archive \(/, 'and the only control is the way back');

  // Both flags set is a state the toggles do not produce, but a stale localStorage can: the
  // archive wins, and the reader still gets exactly one list and one way out of it.
  const both = bootArchive(index, true, true);
  assert.match(both, /Put away/);
  assert.doesNotMatch(both, /Picked up/);

  const out = bootArchive(index, false, false);
  assert.match(out, /Named/);
  assert.match(out, /Auto \(1\)/);
  assert.match(out, /Archive \(1\)/);
  assert.doesNotMatch(out, /\u2190 Back/);
});

test('delete for good is offered on an archived card and nowhere else', () => {
  const index = [
    {id: 'c1', name: 'Active', members: [{key: 'k1', label: 'A'}]},
    {id: 'c2', name: 'Put away', members: [{key: 'k2', label: 'B'}], archived: true},
  ];
  assert.match(bootArchive(index, true), /purgeConversation/);
  assert.doesNotMatch(bootArchive(index, false), /purgeConversation/,
    'the active list keeps the reversible Delete in the roster and no other');
});

test('archive actions are armed like End, across a card redraw', () => {
  const active = bootArchive([{id: 'c1', name: 'Active', members: [{key: 'k1'}]}], false);
  const archived = bootArchive([{id: 'c1', name: 'Put away', members: [{key: 'k1'}], archived: true}], true);
  assert.match(active, /data-arm-key="archive:c1"/);
  assert.match(active, /armButton\(this, 'Archive\?'/);
  assert.match(archived, /armButton\(this, 'Unarchive\?'/);
});

test('a conversation that was never archived cannot be deleted for good', async () => {
  const e = boot();
  e.run(`
    forgot = []; saved = [];
    loadConvIndex = () => [{id: 'c1', name: 'Active', members: [{key: 'k1'}]}];
    saveConvIndex = i => saved.push(i);
    convForget = async keys => { forgot.push(keys); };
    endConvMember = () => {};
    renderConversations = () => {};
    showToast = () => {};
    out = purgeConversation('c1');`);
  await e.run('out');
  assert.equal(e.run('saved.length'), 0, 'the record is untouched');
  assert.equal(e.run('forgot.length'), 0, 'and so are the words');
});

test('deleting an archived conversation ends its panes and erases what it recorded', async () => {
  const e = boot();
  e.run(`
    forgot = [];
    ended = [];
    saved = [];
    convViewId = null;
    loadConvIndex = () => [
      {id: 'c1', name: 'Put away', members: [{key: 'k1'}, {key: 'k2'}], archived: true},
      {id: 'c2', name: 'Elsewhere', members: [{key: 'k2'}]},
    ];
    saveConvIndex = i => saved.push(i);
    convReferenced = () => new Set(['k2']);
    convForget = async keys => { forgot.push(keys); };
    endConvMember = k => ended.push(k);
    convHiddenAll = () => ({});
    convViews = () => ({});
    renderConversations = () => {};
    showToast = () => {};
    out = purgeConversation('c1');`);
  await e.run('out');
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(ended)')), ['k1', 'k2'],
    'a pane still running is the one part of "it never happened" no record can erase');
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(forgot)')), [['k1']],
    'and a member another conversation still shows keeps its words');
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(saved[0].map(c => c.id))')), ['c2']);
});


test('codex is cleared with a slash command, not with the dollar a skill wears there', () => {
  // agentSlash rewrites a leading `/` to `$` for codex because that is how a *skill* is invoked
  // there — `$ponytail`. `/clear` is a slash command and codex spells it the way everyone else
  // does; `$clear` would land in the composer as text.
  const e = boot({live: [{pane_id: 'w1:p1', agent: 'codex'}],
                  recs: [{key: 'w1:p1', spawn: {agent: 'codex', starter: 'architect-prompt'}}]});
  e.run(`
    sent = [];
    agentSlash = (t, a) => (a === 'codex' && t[0] === '/' ? '$' + t.slice(1) : t);
    agentHarness = a => a;
    respawnStarter = () => ({at: 'architect-prompt'});
    roleStarter = () => '/ponytail full';
    sendTextTo = (pane, text) => { sent.push([pane, text]); return true; };`);
  e.run("convResetMember('w1:p1')");
  assert.deepEqual(JSON.parse(e.run('JSON.stringify(sent)')),
    [['w1:p1', '/clear'], ['w1:p1', '$ponytail full']],
    'the command as typed, and the starter still through agentSlash');
});

test('compact is a class on the section and a mode the cards are drawn for', () => {
  const rows = [{id: 'c1', name: 'Nightly', members: [{key: 'k1', label: 'Arch', agent: 'claude',
                                                       messages: 3, last: 'all done'}]}];
  const e = boot();
  e.run(`
    loadConvIndex = () => ${JSON.stringify(rows)};
    convLandingAutoOn = () => false;
    convLandingArchiveOn = () => false;
    CONV_LANDING_AUTO_MAX = 10;
    convSeenAt = () => 0;
    convNoteCounts = () => {};
    convGlyph = () => '#';
    agentBadge = a => '<span class="badge">' + a + '</span>';
    paneLabel = a => a.label || a.pane_id;
    fmtAgo = () => 'just now';
    applySections = () => {};
    compactOn = () => true;
    renderConversations();`);
  assert.ok(e.fields.conversations.classes.has('compact'),
    'the mode is on the section, so the cards need no second shape to be drawn in');
  const html = e.fields.conversations.innerHTML;
  // The three meta lines are told apart by name, which is what lets a mode keep the members' kinds
  // and drop the prose. Unnamed, the only way to pick one was by its place in the card.
  assert.match(html, /conversation-meta kinds/);
  assert.match(html, /conversation-meta names/);
  assert.match(html, /conversation-meta live/);
  assert.match(html, /aria-label="Compact cards"/, 'and the header carries the toggle');
});
