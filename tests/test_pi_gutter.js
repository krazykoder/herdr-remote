// The one branch in the pi extension: does this message get its glyph inline, or on a line of
// its own?
//
// Getting it wrong is silent. Prefixing `⏺ ` onto `### Status` does not throw — it renders a
// literal paragraph where a heading belonged, and the only way anyone finds out is by looking at
// a pane. So the expression is read straight out of the extension and exercised here rather than
// being kept in step by hand.
//
//   node --test tests/test_pi_gutter.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'extensions', 'pi', 'herdr-gutter.ts'), 'utf8');

function extract(name) {
  const line = SRC.split('\n').find(l => l.startsWith(`const ${name} =`));
  assert.ok(line, `${name} is no longer declared the way this test reads it`);
  const ctx = {};
  vm.createContext(ctx);
  return vm.runInContext(`${line}\n${name}`, ctx);
}

const OWNS_ITS_LINE = extract('OWNS_ITS_LINE');

test('prose takes the glyph inline', () => {
  for (const markdown of [
    'hello there',
    "Hey! What can I help you with?",
    'TL;DR: 15 commits, ~7 feature commits.',
    '15 commits — the number leads, but it is still a sentence.',
    'feat/split-view is 15 commits ahead.',
    '"Quoted" text is prose, not a blockquote.',
    'x --- y is not a thematic break, it is a sentence.',
  ]) {
    assert.equal(OWNS_ITS_LINE.test(markdown), false, markdown);
  }
});

test('a construct that owns its line keeps the glyph on a line of its own', () => {
  for (const markdown of [
    '### 3. Split View — 15 commits',      // the heading that motivated the branch
    '# Title',
    '###### Deepest heading',
    '> a blockquote',
    '- a bullet',
    '* a bullet',
    '+ a bullet',
    '1. an ordered item',
    '2) an ordered item',
    '```bash\nls\n```',
    '~~~\nfenced\n~~~',
    '| a | table |',
    '---',
    '***',
    '___',
    '    indented code',
    '\tindented code',
  ]) {
    assert.equal(OWNS_ITS_LINE.test(markdown), true, markdown);
  }
});

test('a bare # or - without its space is prose', () => {
  // `#hashtag` and `-5 degrees` are not markdown constructs, and a message opening with one
  // should still get the tidier inline glyph.
  assert.equal(OWNS_ITS_LINE.test('#hashtag is not a heading'), false);
  assert.equal(OWNS_ITS_LINE.test('-5 degrees is not a list'), false);
});
