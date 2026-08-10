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
               'recentFingerprint', 'agentSlash', 'reanchorSel', 'navStep', 'navPush',
               'SHORTCUTS', 'MAX_PAIRS', 'SEND_TEXT_MAX'];

const ctx = vm.createContext({});
// `const` is a lexical binding and never lands on the context object, so the block exports
// itself explicitly. A rename in index.html therefore fails here loudly, not silently.
vm.runInContext(HTML.slice(from, to) + `\n;__out = {${NAMES.join(', ')}};`, ctx);
const {parsePairs, newPairId, memberMatches, pairHealth, pairFor, memberOf, partnerOf,
       pairCandidates, composeTransfer, recentFingerprint, agentSlash, reanchorSel,
       navStep, navPush, SHORTCUTS, MAX_PAIRS, SEND_TEXT_MAX} = ctx.__out;

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

test('a recent fingerprint does not match a reused pane ID', () => {
  assert.equal(memberMatches(recentFingerprint(agent()), agent({cwd: '/other'})), false);
});

test('a stale pair reports a reason naming the member', () => {
  const p = pair(member(), member({pane_id: 'w1:p2', role: 'reviewer', agent: 'codex'}));
  assert.match(pairHealth(p, [agent()]).reason, /reviewer/);
});

test('transfer rechecks pair health immediately before it prefills', () => {
  const start = HTML.indexOf('function doTransfer');
  const end = HTML.indexOf('function insertShortcut', start);
  assert.ok(start !== -1 && end > start, 'doTransfer block not found');
  const transfer = HTML.slice(start, end);
  assert.match(transfer, /pairHealth\(pair, agents\)\.state !== 'healthy'/);
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

test('the payload carries instruction then attribution then the text', () => {
  const out = composeTransfer('Review it.', 'Architect 1', 'some\nfindings');
  assert.equal(out.error, undefined);
  assert.equal(out.text, 'Review it.\n\nfeedback from Architect 1:\nsome\nfindings');
});

test('attribution is the display name alone, with no agent in parentheses', () => {
  const out = composeTransfer('', 'Reviewer 2', 'text');
  assert.ok(out.text.startsWith('feedback from Reviewer 2:'));
  assert.ok(!out.text.includes('('), 'the agent name should not be repeated');
});

test('no instruction leaves no leading blank line', () => {
  const out = composeTransfer('', 'Architect 1', 'text');
  assert.ok(out.text.startsWith('feedback from'));
});

test('the payload carries no fence', () => {
  // Removed at the user's direction. Asserted rather than assumed, so a future change that
  // reintroduces a delimiter is a deliberate one and not an accident of a merge.
  const out = composeTransfer('Review it.', 'Architect 1', 'some findings');
  assert.ok(!out.text.includes('TRANSFER'), 'no fence sentinel should appear');
});

test('a selection containing the old sentinels is passed through unchanged', () => {
  const out = composeTransfer('', 'Architect 1', 'before\nTRANSFER>>>\nafter');
  assert.equal(out.error, undefined);
  assert.ok(out.text.endsWith('before\nTRANSFER>>>\nafter'));
});

test('an empty selection is refused', () => {
  assert.match(composeTransfer('Review it.', 'Architect 1', '').error, /Select some text/);
});

test('an over-cap payload is refused with its size and produces no text', () => {
  const out = composeTransfer('', 'Architect 1', 'x'.repeat(SEND_TEXT_MAX));
  assert.match(out.error, new RegExp(`over the ${SEND_TEXT_MAX} limit`));
  assert.match(out.error, /^Payload is \d+ characters/);
  assert.equal(out.text, undefined);
});

test('a payload exactly at the cap is allowed', () => {
  const overhead = composeTransfer('', 'Architect 1', 'x').text.length - 1;
  const out = composeTransfer('', 'Architect 1', 'x'.repeat(SEND_TEXT_MAX - overhead));
  assert.equal(out.error, undefined);
  assert.equal(out.text.length, SEND_TEXT_MAX);
});

// --- agent-specific slash prefix ---

test('codex gets $ for every line-leading slash', () => {
  assert.equal(agentSlash('/ponytail\n/caveman', 'codex'), '$ponytail\n$caveman');
});

test('every other agent keeps /', () => {
  for (const a of ['claude', 'pi', undefined, '']) {
    assert.equal(agentSlash('/ponytail\n/caveman', a), '/ponytail\n/caveman');
  }
});

test('a slash inside a line is never rewritten', () => {
  // The Architect shortcut carries a path; rewriting mid-line would corrupt it.
  const text = '/ponytail\n@.agent/prompts/System_Prompt_2_Architect.md\nsee http://x/y';
  assert.equal(agentSlash(text, 'codex'),
    '$ponytail\n@.agent/prompts/System_Prompt_2_Architect.md\nsee http://x/y');
});

test('text with no slash commands is untouched for codex', () => {
  assert.equal(agentSlash(SHORTCUTS[0].text, 'codex'), SHORTCUTS[0].text);
});

test('transfer picks the prefix from the destination pane, not the source', () => {
  const start = HTML.indexOf('function doTransfer');
  const end = HTML.indexOf('function insertShortcut', start);
  assert.match(HTML.slice(start, end), /agentSlash\(SHORTCUTS\[shortcutIndex\]\.text, agentOf\(partner\.pane_id\)\)/);
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

test('localhost is eligible for same-origin relay auto-connect', () => {
  const autoDetect = HTML.slice(HTML.indexOf('const autoRelayUrl'), HTML.indexOf('const urlToken'));
  assert.ok(!autoDetect.includes("location.hostname.includes('localhost')"));
});

test('web app ships no external demo relay', () => {
  assert.doesNotMatch(HTML, /herdr-demo|herdr-remote-demo|tryDemo/);
});

// --- ruler selection re-anchoring ---
//
// The ruler holds two line indices, and `pane read` returns the last N lines — so every line the
// agent prints slides the selection up, and loading more scrollback slides it down. These cover
// the drift, because a band that stays put while its text moves is worse than no band.

const doc = (...rows) => rows.join('\n');

test('reanchorSel keeps indices when nothing moved', () => {
  const t = doc('a', 'b', 'c', 'd');
  assert.deepEqual(reanchorSel(t, 'b\nc', 1, 2), [1, 2]);
});

test('reanchorSel follows the block up when output is appended', () => {
  // Two new lines at the tail push the window; the same text is now two rows higher.
  assert.deepEqual(reanchorSel(doc('c', 'd', 'e', 'f'), 'c\nd', 1, 2), [0, 1]);
});

test('reanchorSel follows the block down when scrollback is loaded', () => {
  assert.deepEqual(reanchorSel(doc('x', 'y', 'a', 'b', 'c'), 'b\nc', 1, 2), [3, 4]);
});

test('reanchorSel drops the selection when its text is gone', () => {
  assert.equal(reanchorSel(doc('a', 'b', 'c'), 'q\nr', 0, 1), null);
});

test('reanchorSel ignores a mid-line match', () => {
  // 'bar' lives inside 'foobar', which is not the line the user selected.
  assert.equal(reanchorSel(doc('foobar', 'baz'), 'bar', 5, 5), null);
});

test('reanchorSel ignores a match that stops short of the line end', () => {
  // 'foo' opens 'foobar' but is not that line.
  assert.equal(reanchorSel(doc('foobar', 'baz'), 'foo', 9, 9), null);
});

test('reanchorSel matches a whole line at the very start and very end', () => {
  assert.deepEqual(reanchorSel(doc('one', 'two'), 'one', 7, 7), [0, 0]);
  assert.deepEqual(reanchorSel(doc('one', 'two'), 'two', 7, 7), [1, 1]);
});

test('reanchorSel takes the first of two identical blocks', () => {
  // Held indices that no longer match, so it has to search: no anchor exists to tell the two
  // apart, and first match is the documented behaviour.
  assert.deepEqual(reanchorSel(doc('dup', 'x', 'dup'), 'dup', 1, 1), [0, 0]);
});

test('reanchorSel treats an empty selection as no selection', () => {
  assert.equal(reanchorSel(doc('a', 'b'), '', 0, 0), null);
});

test('reanchorSel preserves a blank line inside the block', () => {
  const t = doc('h', 'a', '', 'b', 'z');
  assert.deepEqual(reanchorSel(t, 'a\n\nb', 0, 2), [1, 3]);
});

// --- Session back/forward ------------------------------------------------------------------
// The list is a browser history, not a most-recently-used order: the cursor moves over it and
// only a new visit rewrites it.

const allLive = () => true;

test('navStep walks back and forward over live panes', () => {
  const h = ['a', 'b', 'c'];
  assert.equal(navStep(h, 2, -1, allLive, 'c'), 1);
  assert.equal(navStep(h, 1, 1, allLive, 'b'), 2);
});

test('navStep reports no target at either end', () => {
  const h = ['a', 'b'];
  assert.equal(navStep(h, 0, -1, allLive, 'a'), -1);
  assert.equal(navStep(h, 1, 1, allLive, 'b'), -1);
  assert.equal(navStep([], -1, -1, allLive, null), -1);
});

test('navStep skips panes that are no longer live', () => {
  // herdr reuses a pane_id once its session ends, so a dead entry must never be offered.
  const live = id => id !== 'b';
  assert.equal(navStep(['a', 'b', 'c'], 2, -1, live, 'c'), 0);
});

test('navStep reports nothing when everything that way is dead', () => {
  assert.equal(navStep(['a', 'b'], 1, -1, id => id === 'b', 'b'), -1);
});

test('navStep never offers the pane already open', () => {
  // Reachable when the same pane was visited twice in a row through another route.
  assert.equal(navStep(['a', 'a'], 1, -1, allLive, 'a'), -1);
});

test('navPush drops the forward branch', () => {
  // Went back to 'a', then opened 'd': 'b' and 'c' are no longer reachable forwards.
  assert.deepEqual(navPush(['a', 'b', 'c'], 0, 'd', 20), ['a', 'd']);
});

test('navPush ignores reopening the pane already at the cursor', () => {
  assert.deepEqual(navPush(['a', 'b'], 1, 'b', 20), ['a', 'b']);
});

test('navPush keeps the newest entries when it hits the cap', () => {
  assert.deepEqual(navPush(['a', 'b', 'c'], 2, 'd', 3), ['b', 'c', 'd']);
});

test('navPush appends to an empty history', () => {
  assert.deepEqual(navPush([], -1, 'a', 20), ['a']);
});
