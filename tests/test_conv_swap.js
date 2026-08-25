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
    document: {getElementById: id => (fields[id] = fields[id] || {id, value: '', style: {}, innerHTML: ''}),
               querySelector: () => null, createElement: () => ({style: {}}), addEventListener() {}},
    window: {addEventListener() {}}, localStorage: {getItem: () => null, setItem() {}},
    escapeHtml: s => String(s), agents: live, shells: [], startOptions: options,
    loadConvIndex: () => [{id: 'c1', members: [{key: 'k1'}]}],
    convMemberKey: a => a.pane_id || '',
    sessionStorage: {
      getItem: k => (store[k] === undefined ? null : store[k]),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    openStartDialog: p => log.push(['open', p || '']),
    renderStartAgents: () => log.push(['render']),
    endPane: id => log.push(['end', id]),
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

test('swapping a live member ends its session first', () => {
  // There is no changing the agent inside a running pane. The button asks twice; this is what
  // happens after the second tap.
  const e = boot({live: [{pane_id: 'w1:p1', project_id: 'p2'}],
                  recs: [Object.assign({}, REC, {key: 'w1:p1'})]});
  assert.equal(e.run("convSwapLive('w1:p1')"), true);
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
