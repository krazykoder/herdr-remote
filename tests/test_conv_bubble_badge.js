// Which agent a bubble says it came from.
//
//   node --test tests/test_conv_bubble_badge.js
//
// The thread is the one place a conversation is actually read, so a bubble that names the harness
// where the session ran under an alias is the header and the roster telling the truth and the
// words themselves telling a different one. An entry never carries the alias — it is a fact about
// the session, not about a message — so this pins the two places it is read from instead: the live
// pane, and the spawn record for a member whose pane has ended.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot({live = [], recs = []} = {}) {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'web', 'src', 'conversation_view.js'), 'utf8');
  const ctx = vm.createContext({
    console, JSON, Math, Date, Object, Array, Set, Map, String, Number, setTimeout, clearTimeout,
    document: {getElementById: () => null, querySelector: () => null,
               createElement: () => ({style: {}}), addEventListener() {}},
    window: {addEventListener() {}}, localStorage: {getItem: () => null, setItem() {}},
    escapeHtml: s => String(s), agentColor: () => 'var(--x)',
    // terminal.js's, stubbed to the answer it gives: the config where there is one, the harness
    // where there is not. The badge itself is covered in tests/test_agent_badge.js.
    configBadge: (kind, config) => ` <span class="badge">${config || kind}</span>`,
    convMemberKey: a => a.pane_id || '', convAt: e => e.at || 0, convAtRank: () => 1,
    convSpan: () => '', CONV_RULE_GAP: 1e9, arbSign: () => '', paneLabel: a => a.label || '',
    convGitHtml: () => '', convPickHtml: () => '', convStatusDot: () => '',
    paneStatus: () => '', convCommitsHtml: () => '', statusColor: () => 'var(--muted)',
    agents: live, convViewRecs: recs,
  });
  vm.runInContext(src + '\n;__out = {convEntriesHtml};', ctx);
  return ctx.__out.convEntriesHtml;
}

const SAID = {who: 'agent', key: 'p1', agent: 'claude', text: 'hi', at: 1, label: 'ARCH'};

test('a bubble from a live pane is named by the alias that pane runs under', () => {
  const html = boot({live: [{pane_id: 'p1', agent: 'claude', config: 'oclaude-1'}]})(
    [SAID], {key: 'p1'}, false);
  assert.match(html, /badge">oclaude-1</);
});

test('a bubble from a member that has exited is named by what the record kept', () => {
  // The pane is gone, so the only thing left that knows is the spawn record — which is also what
  // answers this after a relay restart, since the relay holds pane_config in memory.
  const html = boot({recs: [{key: 'p1', spawn: {agent: 'claude', config: 'oclaude-1'}}]})(
    [SAID], {key: 'p1'}, false);
  assert.match(html, /badge">oclaude-1</);
});

test('a bubble from a stock session still says the harness', () => {
  assert.match(boot()([SAID], {key: 'p1'}, false), /badge">claude</);
});
