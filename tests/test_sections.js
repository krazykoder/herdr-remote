// Which sections the main page shows, and in what order.
//
// The order *is* the setting — switching a section on appends it, so there is no separate ranking
// to fall out of step with the checkboxes. That makes the stored value the thing worth
// pinning: what a hand-edited or older value does, what the last remaining section does when you
// try to switch it off, and that a section with nothing in it leaves no bare separator behind.
//
// Runs the block straight out of web/index.html so the single-file app keeps its no-build-step
// property, the same trick tests/test_attention.js uses.
//
//   node --test tests/test_sections.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'sections.js'), 'utf8');

// A section node, with the two things the block touches: the style it sets and the class it
// toggles for the top gap. Content is what decides whether a section is drawn at all, so it is
// settable per node.
function sectionNode(id, html) {
  const classes = new Set();
  return {
    id,
    innerHTML: html === undefined ? `<div>${id}</div>` : html,
    style: {},
    classList: {
      toggle: (name, on) => { classes[on ? 'add' : 'delete'](name); },
      contains: name => classes.has(name),
    },
  };
}

// The landing-section nodes and checkboxes, as the block reaches for them.
function sectionsCtx({stored, content = {}, landing = true} = {}) {
  const store = stored === undefined ? {} : {herdr_sections: stored};
  const el = id => sectionNode(id, content[id]);
  // The launcher is empty unless a test says otherwise: renderLauncher writes '' when there are
  // no tiles, which is what keeps a section nobody has used off the page. Defaulting it to
  // content instead would put a launcher in front of every test that is about something else.
  const nodes = {launcher: sectionNode('launcher', content.launcher === undefined ? '' : content.launcher), agents: el('agents'), terminals: el('terminals'), pairs: el('pairs'), recents: el('recents'), conversations: el('conversations')};
  const boxes = {
    sectionLauncher: {checked: false, disabled: false},
    sectionAgents: {checked: false, disabled: false},
    sectionTerminals: {checked: false, disabled: false},
    sectionPairs: {checked: false, disabled: false},
    sectionRecents: {checked: false, disabled: false},
    sectionConversations: {checked: false, disabled: false},
  };
  // The header strip and the landing view it belongs to. The strip writes markup and its own
  // hidden flag; the view is only read, for whether the landing page is the thing on screen.
  // Which button is held down is set on the node rather than written into the markup, so the stub
  // has to hand back buttons: one per key that the last written markup actually named.
  const tabs = {
    id: 'sectionTabs', innerHTML: '', hidden: false, buttons: {},
    querySelector(sel) {
      const key = (/data-section="(\w+)"/.exec(sel) || [])[1];
      if (!key || !this.innerHTML.includes(`data-section="${key}"`)) return null;
      this.buttons[key] = this.buttons[key]
        || {attrs: {}, setAttribute(name, value) { this.attrs[name] = value; }};
      return this.buttons[key];
    },
  };
  const view = {id: 'agentListView', style: {display: landing ? '' : 'none'}};
  const ctx = vm.createContext({
    console,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {
      getElementById: id => nodes[id] || boxes[id]
        || (id === 'sectionTabs' ? tabs : id === 'agentListView' ? view : null),
    },
  });
  vm.runInContext(SRC, ctx);
  return {store, nodes, boxes, tabs, view, run: src => vm.runInContext(src, ctx)};
}

// Which sections the header strip offers, and which one it is holding down.
const offered = tabs => [...tabs.innerHTML.matchAll(/toggleSectionFilter\('(\w+)'\)/g)].map(m => m[1]);
const pressed = tabs => offered(tabs).filter(key =>
  (tabs.buttons[key] || {attrs: {}}).attrs['aria-pressed'] === 'true');

// What is on screen, in the order it is painted. Reads the same two style properties the browser
// does, so a section switched on but left empty is absent here exactly as it is on the page.
const painted = nodes => Object.values(nodes)
  .filter(n => n.style.display !== 'none')
  .sort((a, b) => Number(a.style.order) - Number(b.style.order))
  .map(n => n.id);

// The launcher leads, and it is the one section whose default position was chosen rather than
// inherited: a launcher under four lists of what is already running is a launcher nobody presses.
// An install that predates it keeps its stored order untouched — see loadSections — so this is
// what a *new* install sees, not what an upgrade does.
test('an install that never opens Settings sees today’s layout', () => {
  const {run, nodes} = sectionsCtx({content: {launcher: '<div>launcher</div>'}});
  const all = ['launcher', 'agents', 'terminals', 'pairs', 'recents', 'conversations'];
  assert.deepEqual(run('sectionOrder'), all);
  run('applySections()');
  assert.deepEqual(painted(nodes), all);
});

test('a stored order written before the launcher existed is left exactly as it is', () => {
  // "Off" and "not offered yet" are the same shape in storage, so adopting at load time would
  // undo a deliberate switch-off on every reload. The section is turned on when the first tile is
  // saved instead — see ensureLauncherSection in launcher_store.js.
  const stored = ['agents', 'terminals', 'pairs', 'recents', 'conversations'];
  const {run, nodes} = sectionsCtx({stored: JSON.stringify(stored)});
  assert.deepEqual(run('sectionOrder'), stored);
  run('applySections()');
  assert.deepEqual(painted(nodes), stored);
});

test('a stored order is honoured, and the checkboxes agree with it', () => {
  const {run, nodes, boxes} = sectionsCtx({stored: JSON.stringify(['recents', 'agents'])});
  run('applySections()');
  assert.deepEqual(painted(nodes), ['recents', 'agents']);
  assert.equal(boxes.sectionRecents.checked, true);
  assert.equal(boxes.sectionAgents.checked, true);
  assert.equal(boxes.sectionTerminals.checked, false, 'left out of the stored order');
  assert.equal(boxes.sectionPairs.checked, false, 'left out of the stored order');
});

test('switching a section on puts it at the bottom', () => {
  const {run, nodes} = sectionsCtx({stored: JSON.stringify(['agents'])});
  run("toggleSection('recents', true)");
  run("toggleSection('terminals', true)");
  assert.deepEqual(run('sectionOrder'), ['agents', 'recents', 'terminals']);
  assert.deepEqual(painted(nodes), ['agents', 'recents', 'terminals']);
});

test('off and on again is how a section is moved', () => {
  // The whole ordering model in one go: there is no drag handle, and this is the gesture that
  // replaces it. Documented in the settings hint, so it is worth a test that would catch a change.
  const {run} = sectionsCtx();
  run("toggleSection('agents', false)");
  assert.deepEqual(run('sectionOrder'), ['launcher', 'terminals', 'pairs', 'recents', 'conversations']);
  run("toggleSection('agents', true)");
  assert.deepEqual(run('sectionOrder'), ['launcher', 'terminals', 'pairs', 'recents', 'conversations', 'agents']);
});

test('switching on something already on changes nothing', () => {
  const {run} = sectionsCtx();
  run("toggleSection('terminals', true)");
  assert.deepEqual(run('sectionOrder'), ['launcher', 'agents', 'terminals', 'pairs', 'recents', 'conversations'], 'not moved, not doubled');
});

test('the last section on cannot be switched off', () => {
  // An empty main page is not a state worth being able to reach by accident: the only content
  // left would be an explanation of how to get the content back.
  const {run, nodes, boxes} = sectionsCtx({stored: JSON.stringify(['recents'])});
  assert.equal(boxes.sectionRecents.disabled, true, 'and the box says so before it is tried');
  run("toggleSection('recents', false)");
  assert.deepEqual(run('sectionOrder'), ['recents']);
  // The click already unchecked the box in the browser, so refusing it has to put it back.
  assert.equal(boxes.sectionRecents.checked, true);
  run('applySections()');
  assert.deepEqual(painted(nodes), ['recents']);
});

test('the lock lifts as soon as there is a second section', () => {
  const {run, boxes} = sectionsCtx({stored: JSON.stringify(['agents'])});
  assert.equal(boxes.sectionAgents.disabled, true);
  run("toggleSection('recents', true)");
  assert.equal(boxes.sectionAgents.disabled, false);
  assert.equal(boxes.sectionRecents.disabled, false);
});

test('a section switched on with nothing in it draws no separator', () => {
  // Emptiness stays each renderer's own business — terminalsHtml returns '' when there are no
  // shells. Showing the node anyway is a heading with nothing under it.
  const {run, nodes} = sectionsCtx({content: {terminals: ''}});
  run('applySections()');
  assert.deepEqual(painted(nodes), ['agents', 'pairs', 'recents', 'conversations']);
  assert.equal(nodes.terminals.style.display, 'none');
});

test('the first section drawn gets the top gap, wherever it came from', () => {
  // CSS cannot do this one: :first-child follows source order and these are ordered by flex.
  const {run, nodes} = sectionsCtx({stored: JSON.stringify(['recents', 'agents'])});
  run('applySections()');
  assert.equal(nodes.recents.classList.contains('section-first'), true);
  assert.equal(nodes.agents.classList.contains('section-first'), false, 'and only the first one');
});

test('an empty section does not take the top gap with it', () => {
  const {run, nodes} = sectionsCtx({content: {agents: ''}});
  run('applySections()');
  assert.equal(nodes.terminals.classList.contains('section-first'), true, 'the first one drawn');
  assert.equal(nodes.agents.classList.contains('section-first'), false);
});

test('the gap moves when the order does', () => {
  // Reordering is a live gesture, not something only read at load: the class has to come off the
  // section that is no longer on top, or two sections carry the gap and one of them is mid-page.
  const {run, nodes} = sectionsCtx();
  run('applySections()');
  assert.equal(nodes.agents.classList.contains('section-first'), true);
  run("toggleSection('agents', false)");
  assert.equal(nodes.agents.classList.contains('section-first'), false, 'switched off entirely');
  assert.equal(nodes.terminals.classList.contains('section-first'), true, 'and it moved up');
});

// --- The header's section shortcuts ---
// A filter is a way of reading the landing page, not a setting: it narrows what is drawn without
// touching the order Settings owns, and it is gone on the next load.

test('a shortcut narrows the page to its own section', () => {
  const {run, nodes, tabs} = sectionsCtx();
  run('applySections()');
  // The row has its own fixed order, led by what is read most — not the sections' and not the
  // order Settings is holding.
  assert.deepEqual(offered(tabs), ['conversations', 'agents', 'terminals', 'pairs', 'recents']);
  run("toggleSectionFilter('conversations')");
  assert.deepEqual(painted(nodes), ['conversations']);
  assert.deepEqual(pressed(tabs), ['conversations'], 'and the button says which one');
  assert.equal(nodes.conversations.classList.contains('section-first'), true, 'it is the top of the page now');
});

test('the same shortcut again is the way back', () => {
  const {run, nodes} = sectionsCtx();
  run("toggleSectionFilter('pairs')");
  run("toggleSectionFilter('pairs')");
  assert.deepEqual(painted(nodes), ['agents', 'terminals', 'pairs', 'recents', 'conversations']);
  assert.equal(nodes.agents.classList.contains('section-first'), true, 'and the top gap went back with it');
});

test('one shortcut replaces another rather than stacking', () => {
  const {run, nodes} = sectionsCtx();
  run("toggleSectionFilter('recents')");
  run("toggleSectionFilter('agents')");
  assert.deepEqual(painted(nodes), ['agents']);
});

test('a shortcut shows a section Settings has switched off', () => {
  // This is the whole point of the row: reaching a list without first going to Settings to put it
  // back, and without the visit changing what the page looks like afterwards.
  const {run, nodes, store} = sectionsCtx({stored: JSON.stringify(['agents'])});
  run("toggleSectionFilter('conversations')");
  assert.deepEqual(painted(nodes), ['conversations']);
  assert.deepEqual(run('sectionOrder'), ['agents'], 'the order is untouched');
  assert.equal(store.herdr_sections, JSON.stringify(['agents']), 'and nothing was stored');
  run("toggleSectionFilter('conversations')");
  assert.deepEqual(painted(nodes), ['agents']);
});

test('a section with nothing in it is not offered', () => {
  const {run, tabs} = sectionsCtx({content: {terminals: '', pairs: ''}});
  run('applySections()');
  assert.deepEqual(offered(tabs), ['conversations', 'agents', 'recents']);
});

test('a filter whose section empties out lets the page back', () => {
  // The last pair closes while the page is filtered to Pairs. Holding it would leave a blank
  // screen with nothing on it to press.
  const {run, nodes, tabs} = sectionsCtx();
  run("toggleSectionFilter('pairs')");
  nodes.pairs.innerHTML = '';
  run('applySections()');
  assert.deepEqual(painted(nodes), ['agents', 'terminals', 'recents', 'conversations']);
  assert.deepEqual(pressed(tabs), []);
});

test('one section is nothing to choose between, so no row is drawn', () => {
  const {run, tabs} = sectionsCtx({content: {terminals: '', pairs: '', recents: '', conversations: ''}});
  run('applySections()');
  assert.equal(tabs.innerHTML, '');
  assert.equal(tabs.hidden, true);
});

test('the row is the landing page’s own, and leaves with it', () => {
  const {run, tabs} = sectionsCtx({landing: false});
  run('applySections()');
  assert.equal(tabs.innerHTML, '', 'a pane or a panel is on screen, not the sections');
  assert.equal(tabs.hidden, true);
});

test('a stored value that is not a list is ignored', () => {
  for (const bad of ['null', '"agents"', '{}', '7', 'not json at all']) {
    const {run} = sectionsCtx({stored: bad});
    assert.deepEqual(run('sectionOrder'), ['launcher', 'agents', 'terminals', 'pairs', 'recents', 'conversations'], `stored ${bad}`);
  }
});

test('unknown and repeated names are dropped rather than trusted', () => {
  const {run} = sectionsCtx({stored: JSON.stringify(['recents', 'nope', 'recents', 'agents'])});
  assert.deepEqual(run('sectionOrder'), ['recents', 'agents']);
});

test('a stored list with nothing usable in it falls back rather than blanking the page', () => {
  const {run} = sectionsCtx({stored: JSON.stringify(['nope', 'gone'])});
  assert.deepEqual(run('sectionOrder'), ['launcher', 'agents', 'terminals', 'pairs', 'recents', 'conversations']);
});

test('an unknown section name is refused', () => {
  const {run} = sectionsCtx();
  run("toggleSection('timeline', true)");
  assert.deepEqual(run('sectionOrder'), ['launcher', 'agents', 'terminals', 'pairs', 'recents', 'conversations']);
});

test('a change is written back, and read on the next load', () => {
  const {run, store} = sectionsCtx();
  run("toggleSection('terminals', false)");
  assert.deepEqual(JSON.parse(store.herdr_sections), ['launcher', 'agents', 'pairs', 'recents', 'conversations']);
  const next = sectionsCtx({stored: store.herdr_sections});
  assert.deepEqual(next.run('sectionOrder'), ['launcher', 'agents', 'pairs', 'recents', 'conversations']);
});

test('private mode is session-only rather than an error', () => {
  const nodes = {
    agents: sectionNode('agents'), terminals: sectionNode('terminals'), pairs: sectionNode('pairs'), recents: sectionNode('recents'), conversations: sectionNode('conversations'),
  };
  const ctx = vm.createContext({
    console,
    localStorage: {getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }},
    document: {getElementById: id => nodes[id] || null},
  });
  vm.runInContext(SRC, ctx);
  vm.runInContext("toggleSection('agents', false)", ctx);
  assert.deepEqual(vm.runInContext('sectionOrder', ctx), ['launcher', 'terminals', 'pairs', 'recents', 'conversations']);
});
