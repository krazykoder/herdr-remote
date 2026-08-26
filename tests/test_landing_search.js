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

function boot({agents = [], shells = [], convs = [], tiles = [], pairs = [],
               stored = null, landing = true} = {}) {
  const fields = {};
  const el = id => (fields[id] = fields[id] || {id, value: '', style: {}, innerHTML: '', hidden: false,
                                                classList: {add: n => frameClasses.add(n),
                                                            remove: n => frameClasses.delete(n)},
                                                blur() { this.blurred = true; }});
  const body = {classes: {}, classList: {toggle: (n, on) => { body.classes[n] = !!on; }}};
  // The frame's own class list, for the open/closed state, and the status bar it is measured
  // against — neither is what these tests are about, so both are the smallest thing that answers.
  const frameClasses = new Set();
  const went = [];
  const ctx = vm.createContext({
    console, JSON, Math, Date, Object, Array, Set, Map, String, Number,
    document: {getElementById: el, body,
               documentElement: {style: {setProperty() {}}},
               querySelector: () => ({getBoundingClientRect: () => ({height: 56})})},
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
    launcherPress: id => went.push(['tile', id]),
    loadLauncher: () => tiles,
    launcherPreview: t => t.command || (t.members || []).map(m => m.name).join(' + '),
    pairs, pairHealth: () => ({state: 'healthy'}),
    memberMatches: (m, a) => m.pane_id === a.pane_id,
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

test('a section is findable by what it is called, not only by what is in it', () => {
  const e = boot({agents: [{pane_id: 'p1', label: 'Architect 1', agent: 'claude'}],
                  shells: [{pane_id: 's1', label: 'build watch'}]});
  const html = search(e, 'terminal');
  assert.match(html, /build watch/);
  assert.doesNotMatch(html, /Architect 1/, 'the word names one section, so it lists that one');
  // And the two together narrow rather than widen: each typed word has to land in one field.
  assert.match(search(e, 'terminal build'), /build watch/);
  assert.doesNotMatch(search(e, 'terminal architect'), /Architect 1/);
});

test('a tile is found by what it runs, not only by what it was called', () => {
  const e = boot({tiles: [{id: 't1', label: 'Nightly', action: 'run', command: 'pytest -q'},
                          {id: 't2', label: 'Review', action: 'spawn',
                           members: [{name: 'claude'}, {name: 'codex'}]}]});
  assert.match(search(e, 'pytest'), /Nightly/);
  assert.match(search(e, 'codex'), /Review/, 'a roster is the tile\'s definition too');
  assert.match(search(e, 'tile'), /Nightly/, 'and the section answers to its own name');
  e.run("landingSearchGo('Launcher', 't1')");
  assert.deepEqual(e.went, [['tile', 't1']], 'pressed the way a tile is pressed, through its sheet');
});

test('a pair opens the first of its two panes', () => {
  const e = boot({agents: [{pane_id: 'p1', label: 'Architect 1'}, {pane_id: 'p2', label: 'Critic'}],
                  pairs: [{id: 'pr1', name: 'Review desk',
                           members: [{pane_id: 'p1'}, {pane_id: 'p2'}]}]});
  assert.match(search(e, 'desk'), /Review desk/);
  assert.match(search(e, 'pair'), /Review desk/);
  e.run("landingSearchGo('Pairs', 'pr1')");
  assert.deepEqual(e.went, [['pane', 'p1']]);
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
  e.run("landingSearchGo('Agents', 'p1')");
  e.run("landingSearchGo('Conversations', 'c1')");
  e.run("landingSearchGo('Agents', 'gone')");
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
