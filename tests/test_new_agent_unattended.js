// The approvals checkbox in the conversation's New agent dialog.
//
//   node --test tests/test_new_agent_unattended.js
//
// The Start sheet's rule, in the other dialog that starts an agent: on under an agent config, off
// on a stock harness, and drawn at all only for a harness the relay says has a flag for it. Two
// dialogs answering the same question differently is the bug this pins.
//
// conv_dock.js is not booted whole — it wires a dock at load. The three functions are sliced out
// and run over their own state, which is what they read.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'conv_dock.js'), 'utf8');
const slice = name => {
  const from = SRC.indexOf(`function ${name}(`);
  const to = SRC.indexOf('\n    }', from) + 6;
  return SRC.slice(from, to);
};

function dialog({kind = 'claude', config = '', offered = ['claude', 'codex']} = {}) {
  const row = {style: {}};
  const box = {checked: false};
  const ctx = vm.createContext({
    console,
    startUnattendedOffered: k => offered.indexOf(k) >= 0,
    document: {getElementById: id => (id === 'newAgentUnattendedRow' ? row
      : id === 'newAgentUnattended' ? box : null)},
  });
  vm.runInContext(
    `let newAgentKind = ${JSON.stringify(kind)};`
    + `let newAgentConfig = ${JSON.stringify(config)};`
    + 'let newAgentUnattended = null;'
    + slice('newAgentUnattendedOn') + slice('renderNewAgentUnattended')
    + slice('pickNewAgentUnattended')
    + ';__out = {on: newAgentUnattendedOn, draw: renderNewAgentUnattended,'
    + ' pick: pickNewAgentUnattended};', ctx);
  return Object.assign({}, ctx.__out, {row, box});
}

test('a config is started unattended and a stock harness is not', () => {
  assert.equal(dialog({config: 'oclaude1'}).on(), true);
  assert.equal(dialog().on(), false);
});

test('the answer given wins over the default, either way', () => {
  const custom = dialog({config: 'oclaude1'});
  custom.pick(false);
  assert.equal(custom.on(), false);
  const stock = dialog();
  stock.pick(true);
  assert.equal(stock.on(), true);
});

test('no row is drawn for a harness the relay has no flag for', () => {
  // pi and kiro have none, and neither has a relay too old to say. A box drawn there is a start
  // refused on arrival.
  const pi = dialog({kind: 'pi'});
  pi.draw();
  assert.equal(pi.row.style.display, 'none');
  assert.equal(pi.on(), false, 'and it is never asked for');
  const old = dialog({offered: []});
  old.draw();
  assert.equal(old.row.style.display, 'none');
  const claude = dialog({config: 'oclaude1'});
  claude.draw();
  assert.equal(claude.row.style.display, 'flex');
  assert.equal(claude.box.checked, true);
});
