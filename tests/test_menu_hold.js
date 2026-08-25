// A message the relay refused because the pane was at a menu.
//
//   node --test tests/test_menu_hold.js
//
// A pane showing a numbered menu takes no text: the characters go into a modal that ignores them
// and the Enter behind them answers the question. The relay refuses the send rather than typing it
// — see pane_menu_options — which leaves the message in the client's hands, and the case that
// matters is a start: the opening prompt of a codex that came up asking whether it may trust the
// directory used to be lost to the trust prompt *and* dismiss it, so the session arrived silent.
//
// Held here until the pane has moved off the question, and sent then.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', f), 'utf8');
const NAMES = ['submitText', 'holdForMenu', 'sendHeldAfterMenu', 'lastSubmitted'];

function harness(agents) {
  const wire = [];
  const ctx = vm.createContext({
    console, agents, shells: [], startOptions: {agents: ['codex']}, activePane: null,
    paneOf: id => agents.find(a => a.pane_id === id) || null,
    isShell: () => false,
    paneLabel: a => a.label || a.pane_id,
    convMemberKey: a => a.pane_id,
    loadConvIndex: () => [],
    ws: {readyState: 1, send: m => { const o = JSON.parse(m); wire.push([o.pane_id, o.text]); }},
    chunkText: text => [text],
    burstPoll: () => {}, showToast: () => {},
    Date: {now: () => 1000},
    document: {
      getElementById: () => ({addEventListener: () => {}, style: {}, dataset: {},
                              classList: {add: () => {}, remove: () => {}, toggle: () => {}}}),
      addEventListener: () => {},
    },
    setTimeout: () => 0, clearTimeout: () => {},
  });
  vm.runInContext(src('controls.js') + `\n;__out = {${NAMES.join(', ')}};`, ctx);
  return Object.assign({}, ctx.__out, {wire});
}

const PANE = {pane_id: 'w5:p1', agent: 'codex', label: 'ARCH', status: 'blocked', host: 'local'};

test('the text a send was refused for goes in once the pane is off the menu', () => {
  const h = harness([PANE]);
  h.submitText('w5:p1', '$ponytail\n$caveman');
  assert.deepEqual(h.wire, [['w5:p1', '$ponytail\n$caveman']], 'the first attempt reached the wire');
  // What the relay answers with: nothing was typed, and the pane is still at its question.
  h.holdForMenu('w5:p1', h.lastSubmitted.get('w5:p1'));
  h.sendHeldAfterMenu([PANE]);
  assert.equal(h.wire.length, 1, 'still blocked, so nothing is sent at it');
  h.sendHeldAfterMenu([Object.assign({}, PANE, {status: 'idle'})]);
  assert.deepEqual(h.wire[1], ['w5:p1', '$ponytail\n$caveman'], 'answered, so the message goes in');
});

test('a held message is sent once and not on every snapshot after it', () => {
  const h = harness([PANE]);
  h.holdForMenu('w5:p1', 'hello');
  const live = [Object.assign({}, PANE, {status: 'idle'})];
  h.sendHeldAfterMenu(live);
  h.sendHeldAfterMenu(live);
  assert.deepEqual(h.wire, [['w5:p1', 'hello']]);
});

test('nothing is held for a send that was never refused', () => {
  const h = harness([PANE]);
  h.submitText('w5:p1', 'hello');
  h.sendHeldAfterMenu([Object.assign({}, PANE, {status: 'idle'})]);
  assert.deepEqual(h.wire, [['w5:p1', 'hello']]);
});
