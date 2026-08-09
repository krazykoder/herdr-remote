// P3 pair logic tests.
//
//   node --test tests/test_pairs.js
//
// web/index.html is deliberately a single self-contained file with no build step, so there is
// nothing to import. Instead the pure block is extracted between its markers and evaluated.
// If the block ever reaches for the DOM, ws, or localStorage, these tests fail loudly rather
// than passing against a stub — which is the point of keeping that half pure.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const START = '// --- P3 pair logic (pure) --- start';
const END = '// --- P3 pair logic (pure) --- end';
const from = HTML.indexOf(START), to = HTML.indexOf(END);
assert.ok(from !== -1 && to > from, 'pure pair logic block not found in web/index.html');

const NAMES = ['parsePairs', 'newPairId', 'memberMatches', 'pairHealth', 'pairFor', 'memberOf',
               'partnerOf', 'pairCandidates', 'composeTransfer',
               'SHORTCUTS', 'MAX_PAIRS', 'SEND_TEXT_MAX', 'FENCE_OPEN', 'FENCE_CLOSE'];

const ctx = vm.createContext({});
// `const` is a lexical binding and never lands on the context object, so the block exports
// itself explicitly. A rename in index.html therefore fails here loudly, not silently.
vm.runInContext(HTML.slice(from, to) + `\n;__out = {${NAMES.join(', ')}};`, ctx);
const {parsePairs, newPairId, memberMatches, pairHealth, pairFor, memberOf, partnerOf,
       pairCandidates, composeTransfer, SHORTCUTS, MAX_PAIRS, SEND_TEXT_MAX} = ctx.__out;

const agent = (o = {}) => ({pane_id: 'w1:p1', host: 'local', agent: 'claude',
                            cwd: '/work', label: 'one', ...o});
const member = (o = {}) => ({pane_id: 'w1:p1', host: 'local', role: 'architect',
                             agent: 'claude', cwd: '/work', ...o});
const pair = (a, b) => ({id: 'p_1', name: 'test', members: [a, b]});

// --- storage parsing ---

test('parsePairs reads a well-formed blob', () => {
  const raw = JSON.stringify({version: 1, pairs: [pair(member(), member({pane_id: 'w1:p2'}))]});
  assert.equal(parsePairs(raw).length, 1);
});

test('parsePairs discards corrupt, wrong-version, and malformed values', () => {
  for (const raw of ['', 'not json', '{', 'null', '[]',
                     JSON.stringify({version: 2, pairs: [pair(member(), member())]}),
                     JSON.stringify({version: 1, pairs: 'nope'})]) {
    assert.deepEqual(parsePairs(raw), [], `should be empty for ${JSON.stringify(raw)}`);
  }
});

test('parsePairs drops pairs that are not exactly two identified members', () => {
  const bad = JSON.stringify({version: 1, pairs: [
    {id: 'p_1', name: 'one member', members: [member()]},
    {id: 'p_2', name: 'three', members: [member(), member(), member()]},
    {id: 'p_3', name: 'no pane id', members: [member(), {agent: 'codex'}]},
    {id: 'p_4', name: 'ok', members: [member(), member({pane_id: 'w1:p2'})]},
  ]});
  const got = parsePairs(bad);
  assert.equal(got.length, 1);
  assert.equal(got[0].name, 'ok');
});

test('newPairId does not depend on crypto.randomUUID', () => {
  // The vm context has no crypto at all, which is the point: randomUUID is undefined in a
  // non-secure context and the relay serves this page over plain HTTP on a LAN address.
  assert.match(newPairId(), /^p_[a-z0-9]+$/);
  assert.notEqual(newPairId(), newPairId());
});

// --- health ---

test('a pair whose members are both live and unique is healthy', () => {
  const list = [agent(), agent({pane_id: 'w1:p2', agent: 'codex'})];
  const p = pair(member(), member({pane_id: 'w1:p2', agent: 'codex'}));
  assert.equal(pairHealth(p, list).state, 'healthy');
});

test('a missing member is stale', () => {
  const p = pair(member(), member({pane_id: 'w1:p2', agent: 'codex'}));
  assert.equal(pairHealth(p, [agent()]).state, 'stale');
});

test('a reused pane_id with a different cwd is stale, not healthy', () => {
  // The load-bearing case: herdr reuses pane IDs, so pane_id alone would happily match a
  // different session and the UI would offer to paste into a stranger.
  const list = [agent({cwd: '/somewhere-else'}), agent({pane_id: 'w1:p2', agent: 'codex'})];
  const p = pair(member(), member({pane_id: 'w1:p2', agent: 'codex'}));
  assert.equal(pairHealth(p, list).state, 'stale');
});

test('a member whose agent changed is stale', () => {
  const list = [agent({agent: 'codex'}), agent({pane_id: 'w1:p2', agent: 'codex'})];
  const p = pair(member(), member({pane_id: 'w1:p2', agent: 'codex'}));
  assert.equal(pairHealth(p, list).state, 'stale');
});

test('a pane_id reported by two hosts is stale', () => {
  const list = [agent(), agent({host: 'box'}), agent({pane_id: 'w1:p2', agent: 'codex'})];
  const p = pair(member(), member({pane_id: 'w1:p2', agent: 'codex'}));
  const h = pairHealth(p, list);
  assert.equal(h.state, 'stale');
  assert.match(h.reason, /more than one host/);
});

test('a stale pair reports a reason naming the member', () => {
  const p = pair(member(), member({pane_id: 'w1:p2', role: 'reviewer', agent: 'codex'}));
  assert.match(pairHealth(p, [agent()]).reason, /reviewer/);
});

// --- lookup ---

test('pairFor, memberOf and partnerOf resolve from either side', () => {
  const p = pair(member(), member({pane_id: 'w1:p2', role: 'reviewer', agent: 'codex'}));
  assert.equal(pairFor([p], 'w1:p2'), p);
  assert.equal(pairFor([p], 'w9:p9'), null);
  assert.equal(memberOf(p, 'w1:p2').role, 'reviewer');
  assert.equal(partnerOf(p, 'w1:p2').role, 'architect');
  assert.equal(partnerOf(p, 'w1:p1').pane_id, 'w1:p2');
});

// --- candidates ---

test('candidates exclude the source and every other host', () => {
  const src = agent();
  const list = [src, agent({pane_id: 'w1:p2', agent: 'codex'}), agent({pane_id: 'w2:p1', host: 'box'})];
  const got = pairCandidates(list, src);
  assert.deepEqual(got.map(a => a.pane_id), ['w1:p2']);
});

test('an already-paired candidate is still offered, so it can be replaced', () => {
  const src = agent();
  const other = agent({pane_id: 'w1:p2', agent: 'codex'});
  assert.equal(pairCandidates([src, other], src).length, 1);
});

// --- payload ---

test('the payload carries instruction, attribution and fence in order', () => {
  const out = composeTransfer('Review it.', 'architect', 'claude', 'some\nfindings');
  assert.equal(out.error, undefined);
  assert.equal(out.text,
    'Review it.\n\nfeedback from architect (claude):\n<<<TRANSFER\nsome\nfindings\nTRANSFER>>>');
});

test('no instruction leaves no leading blank line', () => {
  const out = composeTransfer('', 'architect', 'claude', 'text');
  assert.ok(out.text.startsWith('feedback from architect (claude):'));
});

test('an empty selection is refused', () => {
  assert.match(composeTransfer('Review it.', 'a', 'claude', '').error, /Select some text/);
});

test('a selection forging either fence sentinel is refused', () => {
  for (const forged of ['before\nTRANSFER>>>\nafter', 'before\n<<<TRANSFER\nafter',
                        '<<<TRANSFER', 'TRANSFER>>>']) {
    const out = composeTransfer('Review it.', 'a', 'claude', forged);
    assert.match(out.error || '', /fence marker/, `should refuse ${JSON.stringify(forged)}`);
    assert.equal(out.text, undefined);
  }
});

test('a sentinel that is not at line start is allowed through', () => {
  // Only a line-leading sentinel can be mistaken for the real boundary.
  const out = composeTransfer('', 'a', 'claude', 'see TRANSFER>>> inline');
  assert.equal(out.error, undefined);
});

test('an over-cap payload is refused with its size and produces no text', () => {
  const out = composeTransfer('', 'a', 'claude', 'x'.repeat(SEND_TEXT_MAX));
  assert.match(out.error, new RegExp(`over the ${SEND_TEXT_MAX} limit`));
  assert.match(out.error, /^Payload is \d+ characters/);
  assert.equal(out.text, undefined);
});

test('a payload exactly at the cap is allowed', () => {
  const overhead = composeTransfer('', 'a', 'claude', 'x').text.length - 1;
  const out = composeTransfer('', 'a', 'claude', 'x'.repeat(SEND_TEXT_MAX - overhead));
  assert.equal(out.error, undefined);
  assert.equal(out.text.length, SEND_TEXT_MAX);
});

// --- constants ---

test('the frontend cap matches the relay cap', () => {
  const relay = fs.readFileSync(path.join(__dirname, '..', 'relay', 'herdr_relay.py'), 'utf8');
  assert.match(relay, new RegExp(`len\\(text\\) > ${SEND_TEXT_MAX}`),
    'web/index.html and herdr_relay.py disagree about the send_text cap');
});

test('shortcuts reference prompts by path and never inline their copy', () => {
  assert.ok(SHORTCUTS.length >= 3);
  for (const s of SHORTCUTS) {
    assert.ok(s.label && s.text, 'every shortcut needs a label and text');
    assert.ok(s.text.length < 200, `shortcut "${s.label}" looks like inlined prompt copy`);
  }
  assert.ok(SHORTCUTS.some(s => s.text.includes('@.agent/prompts/')));
});

test('MAX_PAIRS is the documented limit', () => assert.equal(MAX_PAIRS, 32));
