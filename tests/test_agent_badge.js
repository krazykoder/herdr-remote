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
  });
  vm.runInContext(src + '\n;__out = {agentColor, agentBadge};', ctx);
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
