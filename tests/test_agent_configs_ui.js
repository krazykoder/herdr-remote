// Agent configs in the browser: the document, the bands, and what the row says.
//
//   node --test tests/test_agent_configs_ui.js
//
// The rows on screen are the *relay's* answer about each alias — its harness, whether the key
// variable is set over there, the command line the spawn will run — and this browser only ever
// writes the alias. That split is what these tests hold: the section draws nothing without a
// provider file, a saved config is the id it was named after, and a key variable's name may
// appear on screen while its value never can.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'src', 'agent_configs.js'), 'utf8');

const NAMES = ['AGENT_CONFIG_KEY', 'AGENT_CONFIG_MAX', 'parseAgentConfigs', 'loadAgentConfigs',
               'saveAgentConfigs', 'agentConfigRows', 'agentConfigProviders', 'agentConfigRow',
               'agentConfigKind', 'agentConfigBands', 'agentConfigRowHtml', 'agentConfigsHtml',
               'openAgentConfig', 'agentConfigSet', 'agentConfigType', 'agentConfigName', 'saveAgentConfig',
               'agentConfigModelHtml', 'MODEL_SUGGESTIONS',
               'deleteAgentConfig'];

const CLAUDE = {id: 'oclaude1', label: 'oclaude1', kind: 'claude', provider: 'router',
                provider_label: 'AgentRouter', model: 'claude-opus-5', model_option: '',
                key: 'ROUTER_KEY', key_set: true,
                command: 'export ANTHROPIC_API_KEY="$ROUTER_KEY"; claude'};
const CODEX = {id: 'ocodex', label: 'ocodex', kind: 'codex', provider: 'oai',
               provider_label: 'OpenAI', model: '', key: 'OPENAI_KEY', key_set: false,
               command: 'export OPENAI_API_KEY="$OPENAI_KEY"; codex'};

function boot(opts = {}) {
  const store = Object.assign({}, opts.store);
  const marked = [];
  const drawn = {};
  const ctx = vm.createContext({
    window: {},
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    startOptions: opts.startOptions === undefined
      ? {agents: ['claude'],
         providers: opts.providers || [{id: 'router', label: 'AgentRouter', kind: 'claude',
                                        base_url: 'https://cc.example.dev',
                                        keys: [{name: 'ROUTER_KEY', set: true}],
                                        has_model: true, has_model_option: true,
                                        models: ['claude-opus-5', 'claude-opus-4-6[1m]']}],
         configs: opts.configs || []}
      : opts.startOptions,
    stateSyncMark: name => marked.push(name),
    escapeHtml: s => String(s).replace(/[&<>"]/g, c =>
      ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])),
    agentBadge: (text, kind) => ` <span class="badge" data-kind="${kind || text}">${text}</span>`,
    badgeHtml: (label, on) => `<button>${label}${on ? '*' : ''}</button>`,
    document: {getElementById: id =>
      (drawn[id] = drawn[id] || {innerHTML: '', textContent: '', style: {}})},
    closeLauncherEdit: () => { drawn.closed = true; },
    renderLauncher: () => { drawn.rendered = (drawn.rendered || 0) + 1; },
    JSON, Object, Array, Set, Math,
  });
  vm.runInContext(SRC + `\n;__out = {${NAMES.join(', ')}};`, ctx);
  return Object.assign({}, ctx.__out, {store, marked, drawn});
}

test('a document that is not one is an empty list, never a throw', () => {
  const s = boot();
  for (const raw of [null, '', 'not json', '[]', '{"aliases":"x"}', '{"aliases":[{}]}']) {
    assert.deepEqual(s.parseAgentConfigs(raw), [], JSON.stringify(raw));
  }
});

test('a save mirrors the document and marks it for the relay', () => {
  const s = boot();
  s.saveAgentConfigs([{id: 'oclaude1', label: 'oclaude1', provider: 'router'}]);
  assert.deepEqual(JSON.parse(s.store.herdr_agent_configs).aliases.map(a => a.id), ['oclaude1']);
  assert.deepEqual(s.marked, ['agent_configs']);
});

test('the section draws nothing without a provider file', () => {
  // Nothing to be an alias *of*, and a header over a list that can never fill is worse than none.
  const s = boot({startOptions: {agents: ['claude'], providers: [], configs: []}});
  assert.equal(s.agentConfigsHtml(), '');
  assert.equal(boot({startOptions: null}).agentConfigsHtml(), '');
});

test('rows band by harness, in the order the relay listed them', () => {
  const s = boot({configs: [CLAUDE, CODEX, Object.assign({}, CLAUDE, {id: 'oclaude2'})]});
  assert.deepEqual(s.agentConfigBands().map(b => [b.kind, b.rows.length]),
                   [['claude', 2], ['codex', 1]]);
});

test('a row wears its harness colour, not one of its own', () => {
  // agentColor matches on the text, and `oclaude1` does not start with `claude` — so the kind is
  // passed explicitly. A colour meaning "custom" would be a twelfth thing for a reader to learn.
  const s = boot({configs: [CLAUDE]});
  assert.match(s.agentConfigRowHtml(CLAUDE), /data-kind="claude"/);
});

test('a row names the key variable and says when the relay has not got it', () => {
  const s = boot({configs: [CLAUDE, CODEX]});
  assert.match(s.agentConfigRowHtml(CLAUDE), /\$ROUTER_KEY/);
  assert.doesNotMatch(s.agentConfigRowHtml(CLAUDE), /cfg-unset/);
  assert.match(s.agentConfigRowHtml(CODEX), /cfg-unset/);
});

test('the effective command is on the row it belongs to, verbatim', () => {
  const s = boot({configs: [CLAUDE]});
  s.openAgentConfig('oclaude1');
  assert.match(s.drawn.launcherEditBody.innerHTML, /ANTHROPIC_API_KEY=&quot;\$ROUTER_KEY&quot;/);
});

test('naming a new config names its id; renaming a saved one does not', () => {
  const s = boot({configs: [CLAUDE], store: {herdr_agent_configs: JSON.stringify(
    {aliases: [{id: 'oclaude1', label: 'oclaude1', provider: 'router'}]})}});
  s.openAgentConfig('');
  s.agentConfigName('OClaude 2');
  s.saveAgentConfig();
  const ids = JSON.parse(s.store.herdr_agent_configs).aliases.map(a => a.id);
  assert.deepEqual(ids, ['oclaude1', 'oclaude-2']);

  s.openAgentConfig('oclaude1');
  s.agentConfigName('Router opus');
  s.saveAgentConfig();
  const after = JSON.parse(s.store.herdr_agent_configs).aliases;
  assert.deepEqual(after.map(a => a.id), ['oclaude1', 'oclaude-2']);
  assert.equal(after[0].label, 'Router opus');
});

test('changing the provider drops a key the new one never offered', () => {
  const s = boot({configs: [CLAUDE]});
  s.openAgentConfig('oclaude1');
  s.agentConfigSet('key', 'ROUTER_KEY');
  s.agentConfigSet('provider', 'oai');
  s.saveAgentConfig();
  assert.equal(JSON.parse(s.store.herdr_agent_configs).aliases[0].key, '');
});

test('deleting one leaves the others and tells the relay', () => {
  const s = boot({store: {herdr_agent_configs: JSON.stringify({aliases: [
    {id: 'oclaude1', label: 'oclaude1', provider: 'router'},
    {id: 'ocodex', label: 'ocodex', provider: 'oai'}]})}});
  s.openAgentConfig('oclaude1');
  s.deleteAgentConfig();
  assert.deepEqual(JSON.parse(s.store.herdr_agent_configs).aliases.map(a => a.id), ['ocodex']);
  assert.deepEqual(s.marked, ['agent_configs']);
});

test('typing in a model field does not redraw the form under the cursor', () => {
  // The dialog is one innerHTML write, so a redraw per keystroke replaces the input the caret is
  // in — which is a field that drops focus after one character. Only choices redraw.
  const s = boot({configs: [CLAUDE]});
  s.openAgentConfig('oclaude1');
  const before = s.drawn.launcherEditBody.innerHTML;
  s.agentConfigType('model', 'claude-sonnet-5');
  assert.equal(s.drawn.launcherEditBody.innerHTML, before, 'the form was redrawn mid-edit');
  s.saveAgentConfig();
  assert.equal(JSON.parse(s.store.herdr_agent_configs).aliases[0].model, 'claude-sonnet-5');
});

test('the model field offers the provider\'s own names, and stays free text', () => {
  const s = boot({configs: [CLAUDE]});
  s.openAgentConfig('oclaude1');
  const html = s.drawn.launcherEditBody.innerHTML;
  assert.match(html, /<datalist id="cfgModels">/);
  assert.match(html, /value="claude-opus-5"/);
  assert.match(html, /list="cfgModels"/);
  assert.doesNotMatch(html, /<select[^>]*cfgModels/, 'the model must not become a closed list');
});

test('a provider with no model variable says where the model lives instead', () => {
  // codex reads CODEX_HOME/config.toml. A box that silently goes nowhere is worse than no box.
  const s = boot({providers: [{id: 'oai', label: 'Codex', kind: 'codex',
                               keys: [{name: 'OPENAI_KEY', set: true}],
                               has_model: false, has_model_option: false, models: []}]});
  s.openAgentConfig('');
  const html = s.drawn.launcherEditBody.innerHTML;
  assert.doesNotMatch(html, /Model option/);
  assert.match(html, /takes its model from the CLI/);
});
