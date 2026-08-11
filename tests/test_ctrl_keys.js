// Ctrl presets, over a stub DOM.
//
// The presets now render in two places — the keys pad's disclosure and the terminal's own dock —
// and the arm-and-fire state is shared between them. This runs the block straight out of
// web/index.html so the single-file app keeps its no-build-step property, the same trick
// tests/test_pairs.js uses.
//
//   node --test tests/test_ctrl_keys.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const from = HTML.indexOf('    let keyQueue = [], armedMod = null, ctrlConfirm = null;');
const to = HTML.indexOf('    function toggleArrows()', from);
assert.ok(from !== -1 && to > from, 'ctrl preset block not found in web/index.html');

// A fresh context per test: ctrlConfirm is module state and an arm must not leak into the next one.
function ctrlCtx() {
  const els = {};
  const el = id => els[id] || (els[id] =
    // display starts hidden, as every dock does in the markup, so toggleDock's read is honest.
    // classes is a plain Set so a test can assert which tab ended up active.
    {id, innerHTML: '', textContent: '', style: {display: 'none'}, addEventListener() {},
     classes: new Set(),
     get classList() {
       return {toggle: (c, on) => { on ? this.classes.add(c) : this.classes.delete(c); }};
     }});
  const sent = [];
  const ctx = vm.createContext({
    document: {getElementById: el, addEventListener() {}},
    localStorage: {getItem: () => null, setItem() {}},
    setTimeout: () => {},           // the 3s disarm is asserted by calling disarmCtrl directly
    window: {}, console,
    sendKeys: k => sent.push(k),
    renderKeyQueue() {},
  });
  vm.runInContext(HTML.slice(from, to), ctx);
  return {el, sent, run: src => vm.runInContext(src, ctx)};
}

test('both hosts paint the same buttons', () => {
  const {el, run} = ctrlCtx();
  run('paintCtrlPresets()');
  assert.match(el('ctrlPresets').innerHTML, /Ctrl C/);
  assert.equal(el('ctrlDockGrid').innerHTML, el('ctrlPresets').innerHTML);
});

test('the rail button paints before it opens, so the dock is never empty', () => {
  const {el, run} = ctrlCtx();
  run('toggleCtrlDock()');
  assert.match(el('ctrlDockGrid').innerHTML, /Ctrl C/);
  assert.equal(el('ctrlDock').style.display, '', 'the dock is open');
  run('toggleCtrlDock()');
  assert.equal(el('ctrlDock').style.display, 'none', 'and the same button closes it');
});

test('a safe key fires on the first tap', () => {
  const {sent, run} = ctrlCtx();
  run("pressCtrl('Ctrl C')");
  assert.deepEqual(sent, [['ctrl+c']]);
});

test('a dangerous key arms in both hosts and fires on the second tap', () => {
  const {el, sent, run} = ctrlCtx();
  run("paintCtrlPresets(); pressCtrl('Ctrl D')");
  assert.deepEqual(sent, [], 'the first tap must not send');
  assert.match(el('ctrlDockGrid').innerHTML, /Confirm\?/);
  assert.match(el('ctrlPresets').innerHTML, /Confirm\?/, 'the pad shows the dock arm');
  run("pressCtrl('Ctrl D')");
  assert.deepEqual(sent, [['ctrl+d']]);
  assert.doesNotMatch(el('ctrlDockGrid').innerHTML, /Confirm\?/, 'disarmed after firing');
});

test('disarmCtrl repaints, so an expiring arm leaves no live trigger on screen', () => {
  const {el, run} = ctrlCtx();
  run("paintCtrlPresets(); pressCtrl('Ctrl Z'); disarmCtrl()");
  assert.doesNotMatch(el('ctrlPresets').innerHTML, /Confirm\?/);
  assert.doesNotMatch(el('ctrlDockGrid').innerHTML, /Confirm\?/);
});

test('the ^C tab replaces the pad content rather than sitting under it', () => {
  const {el, run} = ctrlCtx();
  run("switchKeyTab('ctrl')");
  assert.equal(el('keysPad').style.display, 'none');
  assert.equal(el('digitsPad').style.display, 'none');
  assert.equal(el('ctrlPresets').style.display, 'grid');
  assert.match(el('ctrlPresets').innerHTML, /Ctrl C/);
  assert.ok(el('tabCtrl').classes.has('active'));
  assert.ok(!el('tabKeys').classes.has('active'), 'only one tab is active');
});

test('an arm survives leaving the ^C tab and coming back', () => {
  const {el, run} = ctrlCtx();
  run("switchKeyTab('ctrl'); pressCtrl('Ctrl D')");
  assert.match(el('ctrlPresets').innerHTML, /Confirm\?/);
  run("switchKeyTab('keys')");
  assert.equal(el('ctrlPresets').style.display, 'none');
  assert.equal(el('keysPad').style.display, '', 'the keys pad comes back');
  // Repainted on entry, not filled once: a stale label here would offer a one-tap Ctrl D.
  run("switchKeyTab('ctrl')");
  assert.match(el('ctrlPresets').innerHTML, /Confirm\?/);
});

test('a queued composition stages the keys instead of sending them', () => {
  const {sent, run} = ctrlCtx();
  run("keyQueue.push('Escape'); pressCtrl('Ctrl D')");
  assert.deepEqual(sent, []);
  assert.deepEqual(run('keyQueue'), ['Escape', 'ctrl+d']);
});
