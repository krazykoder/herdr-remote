// The kind badge: one colour per harness, and one argument that grew.
//
//   node --test tests/test_agent_badge.js
//
// `agentBadge` took a name and now takes an optional kind to colour by, so an agent config called
// `oclaude1` reads as the claude it is. That second argument is why this file exists: every
// point-free `list.map(agentBadge)` in the app silently starts passing an *index* as the kind, and
// one of them — the conversation view's header — threw inside the render and took the whole view
// down. A lost colour is a blemish; a render that throws is a screen that does not load.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'src', 'terminal.js'), 'utf8');
  const el = () => ({style: {}, addEventListener() {}, appendChild() {}, remove() {},
                     classList: {add() {}, remove() {}, toggle() {}}, dataset: {}});
  const ctx = vm.createContext({
    window: {addEventListener() {}},
    document: {getElementById: el, querySelector: el, querySelectorAll: () => [],
               createElement: el, addEventListener() {}, body: el()},
    navigator: {}, localStorage: {getItem: () => null, setItem() {}},
    escapeHtml: s => String(s), JSON, Math, Object, Array, Set, Map, String, Number,
    setTimeout, clearTimeout,
    // agent_configs.js's lookup, stubbed: this file is about the badge, not the store.
    agentConfigRow: id => (id === 'oclaude1'
      ? {id: 'oclaude1', label: 'oclaude1', kind: 'claude'} : null),
  });
  vm.runInContext(src + '\n;__out = {agentColor, agentBadge, paneBadge, kindBadge, configBadge};', ctx);
  return ctx.__out;
}

test('a kind is coloured by its prefix, and an unknown one is left alone', () => {
  const {agentColor} = boot();
  assert.equal(agentColor('claude-sonnet'), 'var(--agent-claude)');
  assert.equal(agentColor('codex'), 'var(--blue)');
  assert.equal(agentColor('kiro'), 'var(--agent-kiro)');
  assert.equal(agentColor('pi'), 'var(--green)');
  assert.equal(agentColor(''), '');
  assert.equal(agentColor('something-else'), '');
});

test('an agent config wears its harness colour, not one of its own', () => {
  // agentColor matches on the text, and `oclaude1` does not start with `claude`.
  const {agentBadge} = boot();
  assert.match(agentBadge('oclaude1', 'claude'), /var\(--agent-claude\)/);
  assert.match(agentBadge('oclaude1'), /class="badge" style=""/);
});

test('a non-string kind loses a colour and never throws', () => {
  // `kinds.map(agentBadge)` passes the index as the kind. That is a bug at the call site and it is
  // fixed there — but it must not be able to take a render down from inside a badge.
  const {agentColor, agentBadge} = boot();
  assert.equal(agentColor(1), '');
  for (const bad of [1, 2, {}, [], true]) {
    assert.match(agentBadge('claude', bad), /claude/, String(bad));
  }
  assert.deepEqual(['claude', 'codex'].map(k => agentBadge(k)).length, 2);
});

test('a pane started under a config wears the config\'s name and the harness\'s colour', () => {
  const {paneBadge} = boot();
  const badge = paneBadge({pane_id: 'p1', agent: 'claude', config: 'oclaude1'});
  assert.match(badge, /oclaude1/);
  assert.match(badge, /var\(--agent-claude\)/);
});

test('a pane with no config, or one since deleted, keeps its harness name', () => {
  // The kind underneath never changes — the colour, the start allowlist and the fingerprint a
  // conversation remembers a member by all key off it — so this is the true thing to fall back to.
  const {paneBadge} = boot();
  assert.match(paneBadge({agent: 'claude'}), /claude</);
  assert.match(paneBadge({agent: 'claude', config: 'gone'}), /claude</);
  assert.equal(paneBadge({}), '');
});

test('a recorded kind is upgraded only when its pane is live and custom', () => {
  const {kindBadge} = boot();
  const live = {agent: 'claude', config: 'oclaude1'};
  assert.match(kindBadge('claude', live), /oclaude1/);
  assert.match(kindBadge('claude', {agent: 'claude'}), /claude</);
  assert.match(kindBadge('claude', null), /claude</);
});

test('a tile\'s roster is badged by the config it pinned, before any pane exists', () => {
  // The launcher names members it has not started. There is no snapshot to read the alias off, so
  // the tile carries it — otherwise a tile built out of `oclaude1` reads as stock claude until it
  // is pressed, which is the one moment it is too late to notice.
  const {configBadge} = boot();
  assert.match(configBadge('claude', 'oclaude1'), /oclaude1/);
  assert.match(configBadge('claude', 'oclaude1'), /var\(--agent-claude\)/);
  assert.match(configBadge('claude', ''), /claude</);
  assert.match(configBadge('claude', 'gone'), /claude</, 'a deleted config falls back to the harness');
});

test('a member whose pane has ended is still badged by the config it ran under', () => {
  // The pane is gone, so the alias can only come from the record. Same after a relay restart,
  // which drops `config` off the snapshot while the pane lives on — the live pane still wins
  // where it has one, because it is the only source that cannot be out of date.
  const {kindBadge} = boot();
  assert.match(kindBadge('claude', null, 'oclaude1'), /oclaude1/);
  assert.match(kindBadge('claude', {agent: 'claude'}, 'oclaude1'), /oclaude1/);
  assert.match(kindBadge('claude', {agent: 'claude', config: 'oclaude1'}, ''), /oclaude1/);
  assert.match(kindBadge('claude', null, ''), /claude</);
  assert.match(kindBadge('claude', null, 'gone'), /claude</);
});
