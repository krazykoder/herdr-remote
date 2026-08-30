// The order the launcher's tiles are drawn in.
//
// The bands are the one thing in that section a person does not arrange: manual order inside a
// band, band order fixed. Which makes the band order the thing that decides what a thumb lands
// on, and the thing worth pinning.
//
//   node --test tests/test_launcher_bands.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', f), 'utf8');

function ctx(projects = []) {
  const g = {
    console, window: {},
    document: {getElementById: () => null, addEventListener() {}},
    localStorage: {getItem: () => null, setItem() {}, removeItem() {}},
    projects, agents: [], shells: [], escapeHtml: s => String(s),
  };
  g.globalThis = g;
  vm.createContext(g);
  vm.runInContext(src('launcher_pure.js'), g);
  vm.runInContext(src('launcher_ui.js'), g);
  return g;
}

const tile = (id, extra) => Object.assign(
  {id, label: id, action: 'spawn', project_id: '', members: [{name: 'claude'}]}, extra);

// A tile the user marked, which is all launcherInsecure reads.
const INSECURE = tile('leaky', {insecure: true});

test('bots are the first band, ahead of the insecure warning', () => {
  const g = ctx();
  assert.ok(g.launcherInsecure(INSECURE), 'the fixture is the thing it is standing in for');
  const groups = g.launcherGroups([INSECURE, tile('plain'), tile('jarvis', {bot: 'jarvis'})]);
  assert.deepEqual(groups.map(b => b.label), ['Bots', '[insecure]', 'Templates']);
  assert.deepEqual(groups[0].tiles.map(t => t.id), ['jarvis']);
});

test('a bot is in the Bots band whatever its payload carries', () => {
  // The warning is on the tile, which is where it is read. Sorting it into another band would
  // move the one row that is always the same room out from under the thumb that goes for it.
  const g = ctx();
  const leaky = Object.assign({}, INSECURE, {bot: 'jarvis'});
  const groups = g.launcherGroups([tile('plain'), leaky]);
  assert.deepEqual(groups.map(b => b.label), ['Bots', 'Templates']);
  assert.deepEqual(groups[0].tiles.map(t => t.id), ['leaky']);
});

test('projects keep their own bands, in the roster’s order, after the two above', () => {
  const g = ctx([{id: 'p-a', label: 'Alpha'}, {id: 'p-b', label: 'Beta'}]);
  const groups = g.launcherGroups([
    tile('b', {project_id: 'p-b'}), tile('a', {project_id: 'p-a'}),
    tile('gone', {project_id: 'p-zz'}), tile('tpl'), tile('jarvis', {bot: 'jarvis'})]);
  assert.deepEqual(groups.map(b => b.label),
                   ['Bots', 'Templates', 'Alpha', 'Beta', 'Missing Project']);
});
