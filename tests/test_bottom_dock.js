// The bottom dock fold, over a stub DOM.
//
// The v in the quick actions bar folds the composer stack away and the bar itself stays. The
// pair that has to hold is: the fold control is never the thing that disappears, and the class
// the CSS keys off tracks the stored state. Runs the block straight out of web/index.html so the
// single-file app keeps its no-build-step property, the same trick tests/test_ctrl_keys.js uses.
//
//   node --test tests/test_bottom_dock.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HISTORY = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'history.js'), 'utf8');

// A fresh context per test: both switches are localStorage-backed module state.
function dockCtx({status = 'idle', store = {}, convs = [], threaded = false, options = []} = {}) {
  const els = {};
  // The thread is a sibling of the pane rows, and `hidden` is what says which of the two is on
  // screen — Last and Summary both branch on it.
  const el0 = id => els[id];
  const el = id => els[id] || (els[id] =
    {id, innerHTML: '', style: {}, setAttribute() {}, scrollTop: 0, scrollHeight: 4000,
     // The bar is only rewritten when its markup changed, and the last markup is remembered here.
     dataset: {},
     classes: new Set(),
     get classList() {
       return {toggle: (c, on) => { on ? this.classes.add(c) : this.classes.delete(c); }};
     }});
  const ctx = vm.createContext({
    document: {getElementById: el},
    localStorage: {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }},
    window: {}, console,
    activePane: 'p1',
    paneTextPrimed: false,
    finalAt: null,               // no closing message found, so no Summary button in the row

    agents: [{pane_id: 'p1', status, options}],
    navTarget: () => 0,          // both arrows enabled, so the row renders in full
    navStep: () => 0,
    paneOf: () => true,
    // The arrows now name where they land, and a conversation is one of the places they can land.
    // Stubbed like the rest of the recorder: this suite owns the nav row, not the walk.
    paneLabel: () => 'a pane', convViewId: null, convDockOn: () => false, loadConvIndex: () => [],
    navGo() {}, renderTermMenuState() {}, syncPromptsBtn() {}, syncResend() {},
    syncComposerMode() {}, isShell: () => false,
    // The conversation switch reads membership and the per-pane view, both of which live in the
    // block below this one. Stubbed rather than sliced in: this suite owns the nav row, not the
    // recorder.
    convsForPane: () => convs, convViewOn: () => threaded, toggleConvView() {},
    // Which of the pane's conversations the thread is on — what the door in the middle of the row
    // is named for and goes to. Same fallback the real one ends on: the first of them.
    convViewConv: () => convs[0] || null, openConversation() {},
    // The mark is drawn by the conversation store, which this slice does not load.
    convGlyph: () => '<svg class="conv-glyph"></svg>',
    convThreadOn: () => threaded, convLastAgent: threaded ? 3 : -1, selectFinalConvMessage() {},
    // The strip's centre names the pane the composer types into, so the fold has to redraw it.
    renderPairStrip() {},
    // Resend is offered only where there is something to repeat, and this suite owns the nav row
    // rather than the composer that would have filled this in.
    lastSentText: {}, escapeHtml: s => s,
  });
  // From state.js, attached after the context exists so they read it live: the tests
  // reassign `agents` and `activePane` on it, and a value captured in the literal would
  // be the one the harness was built with. `agents` is absent in harnesses that open no
  // pane, hence the empty default.
  ctx.activeAgent = () => (ctx.agents || []).find(a => a.pane_id === ctx.activePane) || null;
  ctx.paneAddr = a => (typeof a === 'string' || !a) ? {pane_id: a || null}
    : (a.aid ? {pane_id: a.pane_id, aid: a.aid} : {pane_id: a.pane_id});
  el('convThread').hidden = !threaded;
  vm.runInContext(HISTORY, ctx);
  return {el, store, run: src => vm.runInContext(src, ctx)};
}

test('open by default, and the chevron offers to fold', () => {
  const {el, run} = dockCtx();
  run('syncBottomDock(); renderQuickActions()');
  assert.ok(!el('terminalView').classes.has('dock-folded'));
  assert.match(el('quickActions').innerHTML, /qa-fold[^>]*aria-expanded="true"/);
});

test('the fold hides the composer and turns the chevron over', () => {
  const {el, run} = dockCtx();
  run('toggleBottomDock()');
  assert.ok(el('terminalView').classes.has('dock-folded'), 'the CSS hook the docks hang off');
  assert.match(el('quickActions').innerHTML, /qa-fold[^>]*aria-expanded="false"/,
    'the way back is on screen');
  run('toggleBottomDock()');
  assert.ok(!el('terminalView').classes.has('dock-folded'), 'and the same button brings it back');
});

test('the fold is remembered, so it survives a reload', () => {
  const store = {};
  dockCtx({store}).run('toggleBottomDock()');
  const reloaded = dockCtx({store});
  reloaded.run('syncBottomDock()');
  assert.ok(reloaded.el('terminalView').classes.has('dock-folded'));
});

test('folding with the bar switched off still leaves a way back', () => {
  const {el, run} = dockCtx();
  // Off *and* folded is the corner that would otherwise strand the composer off screen with no
  // control left to restore it: an empty .quick-actions is display:none.
  run("localStorage.setItem('herdr_quick_actions', 'off'); toggleBottomDock()");
  assert.match(el('quickActions').innerHTML, /qa-fold[^>]*aria-expanded="false"/);
});

test('the bar switched off while unfolded is still empty, as it was before', () => {
  const {el, run} = dockCtx();
  run("localStorage.setItem('herdr_quick_actions', 'off'); renderQuickActions()");
  assert.equal(el('quickActions').innerHTML, '');
});

test('the conversation switch is offered only on a pane that is in one', () => {
  const none = dockCtx();
  none.run('renderQuickActions()');
  assert.doesNotMatch(none.el('quickActions').innerHTML, /qa-conv/,
    'a button that does nothing on most panes teaches people to stop pressing it');
  const inOne = dockCtx({convs: [{id: 'c1', name: 'x'}]});
  inOne.run('renderQuickActions()');
  assert.match(inOne.el('quickActions').innerHTML, /qa-conv[^>]*aria-pressed="false"/);
  const threaded = dockCtx({convs: [{id: 'c1', name: 'x'}], threaded: true});
  threaded.run('renderQuickActions()');
  assert.match(threaded.el('quickActions').innerHTML, /qa-conv on[^>]*aria-pressed="true"/);
});

test('the row carries no jump of its own — that hangs over the text', () => {
  const {el, run} = dockCtx();
  run('renderQuickActions()');
  assert.doesNotMatch(el('quickActions').innerHTML, /qa-last/);
});

test('Last goes to the end of the pane, not part way', () => {
  const {el, run} = dockCtx();
  el('termContent').scrollTop = 120;
  run('scrollPaneToBottom()');
  assert.equal(el('termContent').scrollTop, el('termContent').scrollHeight);
});

test('Last goes to the end of whichever view is on screen', () => {
  // The thread replaces the rows rather than scrolling with them, so the button has to follow it.
  const {el, run} = dockCtx({convs: [{id: 'c1', name: 'x'}], threaded: true});
  el('convThread').scrollTop = 120;
  el('termContent').scrollTop = 0;
  run('scrollPaneToBottom()');
  assert.equal(el('convThread').scrollTop, el('convThread').scrollHeight);
  assert.equal(el('termContent').scrollTop, 0, 'the rows behind it are left where they were');
});

test('Summary picks the newest bubble while the thread is on', () => {
  const {el, run} = dockCtx({convs: [{id: 'c1', name: 'x'}], threaded: true});
  run('renderQuickActions()');
  assert.match(el('quickActions').innerHTML, /selectFinalConvMessage\(\)/);
});

test('the pill hangs over the pane until its own first read lands', () => {
  const {el, run} = dockCtx();
  run('syncPaneLoading()');
  assert.equal(el('termLoading').hidden, false);
  assert.ok(el('termWrap').classes.has('loading'), 'the stale text goes quiet behind it');
  run('paneTextPrimed = true; syncPaneLoading()');
  assert.equal(el('termLoading').hidden, true);
  assert.ok(!el('termWrap').classes.has('loading'));
});

test('no open pane means no pill, however the flag was left', () => {
  const {el, run} = dockCtx();
  run('activePane = null; syncPaneLoading()');
  assert.equal(el('termLoading').hidden, true);
  assert.ok(!el('termWrap').classes.has('loading'));
});

test('an approval outranks the switch, folded or not', () => {
  // With the options the relay saw, and not without them: the fallback list is gone — a pane whose
  // choices the relay could not read gets no buttons at all rather than another harness's.
  const {el, run} = dockCtx({status: 'blocked',
                             options: ['Yes', 'No, tell Claude what to do differently']});
  run("localStorage.setItem('herdr_quick_actions', 'off'); renderQuickActions()");
  assert.match(el('quickActions').innerHTML, /btn-yes/);
});
