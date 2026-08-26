// The landing page's search bar.
//
//   node --test tests/test_landing_search.js
//
// Loads pane_picker.js beside it, because the whole point of this box is that it matches the way
// the pair sheet matches — a test with its own matcher would pass while the two drifted apart.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = ['pane_picker.js', 'landing_search.js']
  .map(f => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', f), 'utf8')).join('\n');

function boot({agents = [], shells = [], convs = [], stored = null, landing = true} = {}) {
  const fields = {};
  const el = id => (fields[id] = fields[id] || {id, value: '', style: {}, innerHTML: '', hidden: false,
                                                blur() { this.blurred = true; }});
  const body = {classes: {}, classList: {toggle: (n, on) => { body.classes[n] = !!on; }}};
  const went = [];
  const ctx = vm.createContext({
    console, JSON, Math, Date, Object, Array, Set, Map, String, Number,
    document: {getElementById: el, body},
    localStorage: {getItem: () => stored, setItem() {}},
    escapeHtml: s => String(s),
    agents, shells,
    convLandingList: () => ({all: convs}),
    convGlyph: () => '#',
    // pickPaneRow is the picker's own, so the fields a row is searched on are the real ones.
    paneLabel: a => a.label || a.pane_id,
    paneBadge: a => `<span class="badge">${a.agent}</span>`,
    statusColor: () => 'green', shellColor: () => 'grey', agentGlyph: () => '@',
    jumpToPane: id => went.push(['pane', id]),
    openConversation: id => went.push(['conv', id]),
  });
  vm.runInContext(SRC, ctx);
  el('agentListView').style.display = landing ? '' : 'none';
  return {fields, body, went, el, run: s => vm.runInContext(s, ctx)};
}

function search(e, q) {
  e.el('landingSearchInput').value = q;
  e.run('renderLandingSearch()');
  return e.el('landingSearchResults').innerHTML;
}

test('a subsequence reaches a pane, the same way it does in the pair sheet', () => {
  const e = boot({agents: [{pane_id: 'p1', label: 'Architect 1', agent: 'codex'},
                           {pane_id: 'p2', label: 'Scribe', agent: 'claude'}]});
  assert.match(search(e, 'cdx'), /Architect 1/);
  assert.doesNotMatch(search(e, 'cdx'), /Scribe/, 'and only what it reaches');
  assert.match(search(e, 'arch 1'), /Architect 1/, 'two words, each inside one field');
});

test('conversations are searchable too, including the ones the page keeps behind a mode', () => {
  const e = boot({convs: [{id: 'c1', name: 'Nightly', archived: true, members: [{label: 'A'}]}]});
  const html = search(e, 'night');
  assert.match(html, /Nightly/);
  assert.match(html, /Archived/, 'and the row says which mode it is filed under');
});

test('an empty box shows nothing at all, and a miss says so', () => {
  const e = boot({agents: [{pane_id: 'p1', label: 'Scribe'}]});
  assert.equal(search(e, ''), '');
  assert.equal(e.el('landingSearchResults').hidden, true);
  assert.match(search(e, 'zzz'), /Nothing here matches/);
});

test('the list is capped, so it never covers the page it is a way into', () => {
  const many = Array.from({length: 20}, (_, i) => ({pane_id: 'p' + i, label: 'pane ' + i}));
  const e = boot({agents: many});
  const rows = search(e, 'pane').match(/class="pair-pick"/g) || [];
  assert.equal(rows.length, 8);
});

test('a row goes where its pane is now, and an id that has gone goes nowhere', () => {
  const e = boot({agents: [{pane_id: 'p1', label: 'Scribe'}], convs: [{id: 'c1', name: 'Nightly'}]});
  e.run("landingSearchGo('0', 'p1')");
  e.run("landingSearchGo('1', 'c1')");
  e.run("landingSearchGo('0', 'gone')");
  assert.deepEqual(e.went, [['pane', 'p1'], ['conv', 'c1']]);
});

test('switched off, the bar is not on the page and holds no query', () => {
  const e = boot({agents: [{pane_id: 'p1', label: 'Scribe'}], stored: 'off'});
  search(e, 'scr');
  e.run('syncLandingSearch()');
  assert.equal(e.el('landingSearch').hidden, true);
  assert.equal(e.el('landingSearchInput').value, '', 'a hidden box that kept its text would filter nothing and remember everything');
  assert.equal(e.body.classes['landing-search-on'], false, 'and the page takes its foot back');
});

test('on, but only where there is a landing page under it', () => {
  const e = boot({landing: false});
  e.run('syncLandingSearch()');
  assert.equal(e.el('landingSearch').hidden, true);
  e.el('agentListView').style.display = '';
  e.run('syncLandingSearch()');
  assert.equal(e.el('landingSearch').hidden, false);
});
