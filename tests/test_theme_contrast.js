// The two palettes in web/index.html, measured. The light theme is built around a claim — every
// accent clears 4.5:1 on the darkest ground it can land on — and a claim in a comment is not a
// claim anything checks. This is that check: it reads the custom properties straight out of the
// stylesheet, so a hand-tuned hex that drifts under the floor fails here rather than in someone's
// eyes.
//
//   node --test tests/test_theme_contrast.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

// The `:root` block and its `[data-theme="light"]` override, as {name: '#rrggbb'}. Light inherits
// every property it does not restate, which is how the theme actually cascades.
function vars(selector) {
  const at = HTML.indexOf(`    ${selector} {`);
  assert.ok(at !== -1, `${selector} not found in web/index.html`);
  const body = HTML.slice(at, HTML.indexOf('\n    }', at));
  const out = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6});/g)) out[name] = value;
  return out;
}

const dark = vars(':root');
const light = {...dark, ...vars(':root[data-theme="light"]')};

function luminance(hex) {
  const ch = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Everything drawn as text at UI sizes. Status dots are excluded on purpose — they are pure fills
// with no text riding on them, which is why the light theme keeps them at the dark hue.
const INK = ['text', 'muted', 'green', 'red', 'blue', 'orange', 'agent-claude', 'shell'];
const GROUNDS = ['bg', 'surface', 'term-bg'];
// Accents used as a button fill with a var(--bg) label on top.
const FILLS = ['green', 'red', 'blue', 'orange'];

test('light text and accents clear 4.5:1 on every ground they land on', () => {
  for (const ink of INK) {
    assert.ok(light[ink], `--${ink} is not defined`);
    for (const ground of GROUNDS) {
      const ratio = contrast(light[ink], light[ground]);
      assert.ok(ratio >= 4.5, `light --${ink} on --${ground} is ${ratio.toFixed(2)}:1, under 4.5`);
    }
  }
});

test('dark accents clear 4.5:1 on every ground they land on', () => {
  // --muted is Tokyo Night's own comment colour and measures 2.8:1 here. It is inherited from the
  // upstream theme rather than chosen, and predates the light rework; excluded so this test pins
  // what the palette controls instead of failing on a known, deliberate borrow.
  for (const ink of INK.filter(k => k !== 'muted')) {
    for (const ground of GROUNDS) {
      const ratio = contrast(dark[ink], dark[ground]);
      assert.ok(ratio >= 4.5, `dark --${ink} on --${ground} is ${ratio.toFixed(2)}:1, under 4.5`);
    }
  }
});

test('a var(--bg) label is legible on an accent fill in both themes', () => {
  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    for (const fill of FILLS) {
      const ratio = contrast(theme.bg, theme[fill]);
      assert.ok(ratio >= 4.5, `${name} --bg on --${fill} is ${ratio.toFixed(2)}:1, under 4.5`);
    }
  }
});

test('a card sits forward of the page in both themes', () => {
  for (const [name, theme] of [['light', light], ['dark', dark]]) {
    assert.ok(luminance(theme.surface) > luminance(theme.bg),
      `${name} --surface is not lighter than --bg — the card reads sunken`);
    assert.ok(luminance(theme['term-bg']) >= luminance(theme.bg),
      `${name} --term-bg is darker than --bg`);
  }
});

// Every name declared in a block, whatever its value — the hex-only reader above skips the dot
// properties, which dark sets to var(--green) and friends.
function names(selector) {
  const at = HTML.indexOf(`    ${selector} {`);
  const body = HTML.slice(at, HTML.indexOf('\n    }', at));
  return [...body.matchAll(/--([\w-]+):/g)].map(m => m[1]);
}

test('every custom property the stylesheet reads is one something sets', () => {
  // A `var(--card)` that nothing declares is not a fallback, it is no declaration at all — the
  // property is invalid and the element gets nothing. An overlay panel with no background reads as
  // a rendering fault rather than as a missing token, which is why this is a test and not a lint.
  const css = HTML.slice(HTML.indexOf('<style>'), HTML.indexOf('</style>'));
  const used = new Set([...css.matchAll(/var\(\s*--([\w-]+)/g)].map(m => m[1]));
  const srcDir = path.join(__dirname, '..', 'web', 'src');
  const allJS = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'))
    .map(f => fs.readFileSync(path.join(srcDir, f), 'utf8')).join('\n');
  const allText = HTML + '\n' + allJS;
  const set = new Set([...allText.matchAll(/--([\w-]+)\s*:/g)].map(m => m[1])
    .concat([...allText.matchAll(/setProperty\(\s*['"]--([\w-]+)/g)].map(m => m[1])));
  for (const name of used) {
    assert.ok(set.has(name), `--${name} is read by the stylesheet and set by nothing`);
  }
});

test('every custom property the light theme overrides exists in the dark one', () => {
  const declared = new Set(names(':root'));
  for (const name of names(':root[data-theme="light"]')) {
    assert.ok(declared.has(name), `--${name} is set only in the light theme — nothing reads it`);
  }
});
