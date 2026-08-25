// What a conversation writes down about how a member was started.
//
//   node --test tests/test_conv_spawn.js
//
// The spawn record is what a restart is rebuilt from, so what it keeps decides what a restart can
// be. This pins the one field that is not a fact about the pane at all — the agent config it was
// started under, which is an id the relay resolves and which outlives the relay's own memory of
// it: pane_config there is in memory, so a relay restart drops `config` off the snapshot while
// the pane it describes runs on.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// conversation_store.js resolves everything it borrows at call time, so a context holding the few
// things convSpawn itself reads is the whole of what this needs.
function boot() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'src', 'conversation_store.js'), 'utf8');
  const ctx = vm.createContext({
    console, JSON, Math, Date, Object, Array, Set, Map, String, Number,
    setTimeout, clearTimeout,
    localStorage: {getItem: () => null, setItem() {}},
    paneLabel: a => a.label || '', roleOf: a => a.role || '',
    startRoleFromLabel: () => null, paneStarter: new Map(),
  });
  vm.runInContext(src + '\n;__out = {convSpawn, convContinued};', ctx);
  return ctx.__out;
}

test('the record keeps the agent config, by id and by nothing else', () => {
  // By id, so a restart resolves it again: an alias whose provider or model has been edited since
  // comes back on what it says now rather than on a snapshot of how it was born.
  const {convSpawn} = boot();
  const rec = convSpawn({agent: 'claude', config: 'oclaude1', label: 'ARCH'}, 1, null);
  assert.equal(rec.config, 'oclaude1');
  assert.equal(rec.agent, 'claude', 'and the harness is still the thing everything else keys off');
  assert.deepEqual(Object.keys(rec).filter(k => /model|provider|key/.test(k)), [],
    'nothing the relay owns is copied into the record');
});

test('a pane the relay has forgotten the config of keeps the one already recorded', () => {
  // The relay holds pane_config in memory. A relay restart leaves the pane running and the alias
  // off the snapshot — and this record is the only place it still exists.
  const {convSpawn} = boot();
  assert.equal(convSpawn({agent: 'claude'}, 1, {config: 'oclaude1'}).config, 'oclaude1');
  assert.equal(convSpawn({agent: 'claude'}, 1, null).config, '', 'and a session that never had one says so');
});

test('a member swapped to another harness stops wearing the old one\'s alias', () => {
  // The record for the pane that ended says `oclaude`; the pane running now is a stock codex. What
  // the relay says about the live pane wins, and what it does not say is not filled in from a
  // session that was a different agent.
  const {convSpawn} = boot();
  const rec = convSpawn({agent: 'codex'}, 2, {agent: 'claude', config: 'oclaude1'});
  assert.equal(rec.config, '');
  assert.equal(rec.agent, 'codex');
});

test('continuing a transcript carries the starter and nothing else about the pane that ended', () => {
  // Swap keeps the row, the name and the history — the transcript is the conversation. The spawn
  // record is not: it describes a pane that has exited, down to the alias it came up under.
  const {convContinued} = boot();
  const next = convContinued({key: 'old', entries: [{text: 'hi'}], label: 'ARCH',
    spawn: {agent: 'claude', config: 'oclaude1', label: 'ARCH', starter: '@architect'}},
    'new', 'ARCH');
  assert.equal(next.entries.length, 1, 'the history is what continues');
  assert.deepEqual(next.spawn, {starter: '@architect'});
  assert.equal(next.continued, true);
});
