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

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const from = HTML.indexOf("    const QA_KEY = 'herdr_quick_actions';");
const to = HTML.indexOf('    let paneLines = 200;', from);
assert.ok(from !== -1 && to > from, 'quick actions block not found in web/index.html');

// A fresh context per test: both switches are localStorage-backed module state.
function dockCtx({status = 'idle', store = {}} = {}) {
  const els = {};
  const el = id => els[id] || (els[id] =
    {id, innerHTML: '', style: {}, setAttribute() {}, scrollTop: 0, scrollHeight: 4000,
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
    agents: [{pane_id: 'p1', status}],
    navTarget: () => 0,          // both arrows enabled, so the row renders in full
    navGo() {}, renderTermMenuState() {}, syncPromptsBtn() {},
    syncComposerMode() {}, isShell: () => false,
  });
  vm.runInContext(HTML.slice(from, to), ctx);
  return {el, store, run: src => vm.runInContext(src, ctx)};
}

test('open by default, and the v offers to fold', () => {
  const {el, run} = dockCtx();
  run('syncBottomDock(); renderQuickActions()');
  assert.ok(!el('terminalView').classes.has('dock-folded'));
  assert.match(el('quickActions').innerHTML, /qa-fold[^>]*>v</);
});

test('the fold hides the composer and flips the glyph to ^', () => {
  const {el, run} = dockCtx();
  run('toggleBottomDock()');
  assert.ok(el('terminalView').classes.has('dock-folded'), 'the CSS hook the docks hang off');
  assert.match(el('quickActions').innerHTML, /qa-fold[^>]*>\^</, 'the way back is on screen');
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
  assert.match(el('quickActions').innerHTML, /qa-fold[^>]*>\^</);
});

test('the bar switched off while unfolded is still empty, as it was before', () => {
  const {el, run} = dockCtx();
  run("localStorage.setItem('herdr_quick_actions', 'off'); renderQuickActions()");
  assert.equal(el('quickActions').innerHTML, '');
});

test('Last rides the other edge of the same row', () => {
  const {el, run} = dockCtx();
  run('renderQuickActions()');
  assert.match(el('quickActions').innerHTML, /qa-last[^>]*>Last</);
});

test('Last goes to the end of the pane, not part way', () => {
  const {el, run} = dockCtx();
  el('termContent').scrollTop = 120;
  run('scrollPaneToBottom()');
  assert.equal(el('termContent').scrollTop, el('termContent').scrollHeight);
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
  const {el, run} = dockCtx({status: 'blocked'});
  run("localStorage.setItem('herdr_quick_actions', 'off'); renderQuickActions()");
  assert.match(el('quickActions').innerHTML, /btn-yes/);
});
