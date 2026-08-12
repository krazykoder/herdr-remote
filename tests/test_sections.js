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

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const from = HTML.indexOf('    // --- Main page sections ---');
const to = HTML.indexOf('    // The terminal is a flex sibling, not an overlay', from);
assert.ok(from !== -1 && to > from, 'main page sections block not found in web/index.html');

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

// The four section nodes and checkboxes, as the block reaches for them.
function sectionsCtx({stored, content = {}} = {}) {
  const store = stored === undefined ? {} : {herdr_sections: stored};
  const el = id => sectionNode(id, content[id]);
  const nodes = {agents: el('agents'), terminals: el('terminals'), pairs: el('pairs'), recents: el('recents')};
  const boxes = {
    sectionAgents: {checked: false, disabled: false},
    sectionTerminals: {checked: false, disabled: false},
    sectionPairs: {checked: false, disabled: false},
    sectionRecents: {checked: false, disabled: false},
  };
  const ctx = vm.createContext({
    console,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    document: {getElementById: id => nodes[id] || boxes[id] || null},
  });
  vm.runInContext(HTML.slice(from, to), ctx);
  return {store, nodes, boxes, run: src => vm.runInContext(src, ctx)};
}

// What is on screen, in the order it is painted. Reads the same two style properties the browser
// does, so a section switched on but left empty is absent here exactly as it is on the page.
const painted = nodes => Object.values(nodes)
  .filter(n => n.style.display !== 'none')
  .sort((a, b) => Number(a.style.order) - Number(b.style.order))
  .map(n => n.id);

test('an install that never opens Settings sees today’s layout', () => {
  const {run, nodes} = sectionsCtx();
  assert.deepEqual(run('sectionOrder'), ['agents', 'terminals', 'pairs', 'recents']);
  run('applySections()');
  assert.deepEqual(painted(nodes), ['agents', 'terminals', 'pairs', 'recents']);
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
  assert.deepEqual(run('sectionOrder'), ['terminals', 'pairs', 'recents']);
  run("toggleSection('agents', true)");
  assert.deepEqual(run('sectionOrder'), ['terminals', 'pairs', 'recents', 'agents']);
});

test('switching on something already on changes nothing', () => {
  const {run} = sectionsCtx();
  run("toggleSection('terminals', true)");
  assert.deepEqual(run('sectionOrder'), ['agents', 'terminals', 'pairs', 'recents'], 'not moved, not doubled');
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
  assert.deepEqual(painted(nodes), ['agents', 'pairs', 'recents']);
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

test('a stored value that is not a list is ignored', () => {
  for (const bad of ['null', '"agents"', '{}', '7', 'not json at all']) {
    const {run} = sectionsCtx({stored: bad});
    assert.deepEqual(run('sectionOrder'), ['agents', 'terminals', 'pairs', 'recents'], `stored ${bad}`);
  }
});

test('unknown and repeated names are dropped rather than trusted', () => {
  const {run} = sectionsCtx({stored: JSON.stringify(['recents', 'nope', 'recents', 'agents'])});
  assert.deepEqual(run('sectionOrder'), ['recents', 'agents']);
});

test('a stored list with nothing usable in it falls back rather than blanking the page', () => {
  const {run} = sectionsCtx({stored: JSON.stringify(['nope', 'gone'])});
  assert.deepEqual(run('sectionOrder'), ['agents', 'terminals', 'pairs', 'recents']);
});

test('an unknown section name is refused', () => {
  const {run} = sectionsCtx();
  run("toggleSection('timeline', true)");
  assert.deepEqual(run('sectionOrder'), ['agents', 'terminals', 'pairs', 'recents']);
});

test('a change is written back, and read on the next load', () => {
  const {run, store} = sectionsCtx();
  run("toggleSection('terminals', false)");
  assert.deepEqual(JSON.parse(store.herdr_sections), ['agents', 'pairs', 'recents']);
  const next = sectionsCtx({stored: store.herdr_sections});
  assert.deepEqual(next.run('sectionOrder'), ['agents', 'pairs', 'recents']);
});

test('private mode is session-only rather than an error', () => {
  const nodes = {
    agents: sectionNode('agents'), terminals: sectionNode('terminals'), pairs: sectionNode('pairs'), recents: sectionNode('recents'),
  };
  const ctx = vm.createContext({
    console,
    localStorage: {getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }},
    document: {getElementById: id => nodes[id] || null},
  });
  vm.runInContext(HTML.slice(from, to), ctx);
  vm.runInContext("toggleSection('agents', false)", ctx);
  assert.deepEqual(vm.runInContext('sectionOrder', ctx), ['terminals', 'pairs', 'recents']);
});
