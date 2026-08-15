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

const PAIRS_PURE = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'pairs_pure.js'), 'utf8');
const TRANSFER = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'transfer.js'), 'utf8');
const SETTINGS = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'settings.js'), 'utf8');
const START_DIALOG = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'start_dialog.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');

const NAMES = ['parsePairs', 'newPairId', 'memberMatches', 'pairHealth', 'pairFor', 'memberOf',
               'partnerOf', 'pairCandidates', 'composeTransfer',
               'recentFingerprint', 'agentSlash', 'reanchorSel', 'navStep', 'navPush',
               'SHORTCUTS', 'MAX_PAIRS', 'SEND_TEXT_MAX', 'chunkText',
               'parseTermShortcuts', 'DEFAULT_TERM_SHORTCUTS', 'MAX_TERM_SHORTCUTS', 'escapeHtml',
               'enterAction', 'ctrlChord'];

const ctx = vm.createContext({});
// `const` is a lexical binding and never lands on the context object, so the block exports
// itself explicitly. A rename in source therefore fails here loudly, not silently.
vm.runInContext(PAIRS_PURE + `\n;__out = {${NAMES.join(', ')}};`, ctx);
const {parsePairs, newPairId, memberMatches, pairHealth, pairFor, memberOf, partnerOf,
       pairCandidates, composeTransfer, recentFingerprint, agentSlash, reanchorSel,
       navStep, navPush, SHORTCUTS, MAX_PAIRS, SEND_TEXT_MAX, chunkText,
       parseTermShortcuts, DEFAULT_TERM_SHORTCUTS, MAX_TERM_SHORTCUTS, escapeHtml,
       enterAction, ctrlChord} = ctx.__out;

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
  assert.match(TRANSFER, /pairHealth\(pair, agents\)\.state !== 'healthy'/);
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

test('a payload past one message is built, not refused', () => {
  // It used to come back as "select less", which read as advice about the work and was really the
  // wire's limit in disguise. The composer splits it now.
  const out = composeTransfer('', 'Architect 1', 'x'.repeat(SEND_TEXT_MAX * 3));
  assert.equal(out.error, undefined);
  assert.ok(out.text.length > SEND_TEXT_MAX * 3);
});

// --- chunkText ---

test('text that fits is one chunk, and the same string', () => {
  assert.deepEqual(chunkText('hello'), ['hello']);
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('x'.repeat(SEND_TEXT_MAX)), ['x'.repeat(SEND_TEXT_MAX)]);
});

test('every chunk is within the cap and they concatenate back to the input', () => {
  const text = Array.from({length: 900}, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n');
  const out = chunkText(text);
  assert.ok(out.length > 1);
  for (const c of out) assert.ok(c.length <= SEND_TEXT_MAX, `chunk of ${c.length}`);
  assert.equal(out.join(''), text);
});

test('a chunk ends on a line boundary when the text has one', () => {
  const out = chunkText(('a'.repeat(99) + '\n').repeat(20), 300);
  assert.ok(out.length > 1);
  // Every chunk but the last ends where a line ended: the audit log records one line per message.
  for (const c of out.slice(0, -1)) assert.equal(c[c.length - 1], '\n');
});

test('a single line longer than the cap is cut, because there is nothing to cut on', () => {
  const out = chunkText('z'.repeat(250), 100);
  assert.deepEqual(out.map(c => c.length), [100, 100, 50]);
  assert.equal(out.join(''), 'z'.repeat(250));
});

test('a cut never lands inside a surrogate pair', () => {
  // Half an emoji arrives at the agent as a replacement character, and the halves never rejoin.
  const out = chunkText('a'.repeat(9) + '\u{1F600}'.repeat(4), 10);
  for (const c of out) assert.ok(!/[\uD800-\uDBFF]$/.test(c), 'chunk ends on a high surrogate');
  assert.equal(out.join(''), 'a'.repeat(9) + '\u{1F600}'.repeat(4));
});

test('blank lines survive the split', () => {
  assert.equal(chunkText('a\n\n\nb', 3).join(''), 'a\n\n\nb');
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
  assert.match(TRANSFER, /agentSlash\(SHORTCUTS\[shortcutIndex\]\.text, agentOf\(partner\.pane_id\)\)/);
});

// --- constants ---

test('the chunk size matches the cap the relay enforces', () => {
  // This is what makes a client-side split work against a relay this app did not ship with: the
  // number is the *oldest* relay's, and the app never sends a message past it.
  const relay = fs.readFileSync(path.join(__dirname, '..', 'relay', 'herdr_relay.py'), 'utf8');
  assert.match(relay, new RegExp(`len\\(text\\) > ${SEND_TEXT_MAX}`),
    'web/src/pairs_pure.js and herdr_relay.py disagree about the send_text cap');
});

test('a transfer never ends in a send, and exactly one function says otherwise', () => {
  // The rule and its one documented bypass, asserted against the source because it is a rule about
  // what a function may do rather than about what it returns. doTransfer is the checkpoint the
  // pane view keeps; transferNow is the conversation view's decision to skip it (spec §4).
  const body = TRANSFER.slice(TRANSFER.indexOf('function doTransfer'),
                             TRANSFER.indexOf('function transferNow'));
  assert.ok(!/\bsendText\(/.test(body), 'doTransfer must never end in a send');
  assert.match(TRANSFER, /function transferNow[\s\S]*?sendText\(\)/);
  // And the bypass is scoped: a chip in the pane view would be a one-tap send of a guess at where
  // a message starts.
  assert.match(TRANSFER, /function transferNow\(shortcutIndex\) \{\s*\n\s*if \(!convThreadOn\(\)\) return;/);
});

test('every shortcut has a chip name, and no two chips are the same', () => {
  const ats = SHORTCUTS.map(s => s.at);
  for (const at of ats) assert.match(at, /^[a-z][a-z0-9-]*$/, `"${at}" is not a chip name`);
  assert.equal(new Set(ats).size, ats.length, 'two shortcuts claim the same @name');
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
  assert.match(SETTINGS, /const autoRelayUrl/);
  assert.ok(!SETTINGS.includes("location.hostname.includes('localhost')"));
});

test('web app ships no external demo relay', () => {
  assert.doesNotMatch(INDEX_HTML, /herdr-demo|herdr-remote-demo|tryDemo/);
  assert.doesNotMatch(SETTINGS, /herdr-demo|herdr-remote-demo|tryDemo/);
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

// --- Start dialog placement ----------------------------------------------------------------
// renderStartTarget runs against the DOM, so it is sliced out and evaluated over a stub. What
// is being pinned is one rule: New workspace asks for no target, so it must clear the error and
// the disabled submit that a previous placement left behind. Without that, choosing New
// workspace after "No live workspaces in this project" left the button dead and no session
// could be started at all.

function startDialogCtx(agents, placement, mode = 'agent', shells = []) {
  const els = {
    startPlacement: {value: placement},
    startTargetRow: {innerHTML: 'stale'},
    startError: {textContent: 'No live workspaces in this project',
                 style: {display: 'block'}},
    startSubmit: {disabled: true},
  };
  return {
    els,
    ctx: vm.createContext({
      agents,
      shells,
      startMode: mode,
      startProjectId: 'charts',
      document: {getElementById: id => els[id] || (els[id] = {innerHTML: '', style: {}})},
      fillSelect: (id, options) => { els[id + 'Options'] = options; return options.length; },
      setStartError: text => {
        els.startError.textContent = text || '';
        els.startError.style.display = text ? 'block' : 'none';
      },
    }),
  };
}

function runRenderStartTarget(agents, placement, mode = 'agent', shells = []) {
  const start = START_DIALOG.indexOf('function renderStartTarget');
  const end = START_DIALOG.indexOf('function submitStart', start);
  const {els, ctx} = startDialogCtx(agents, placement, mode, shells);
  vm.runInContext(START_DIALOG.slice(start, end) + '\n;renderStartTarget();', ctx);
  return els;
}

test('New workspace clears an error left by a placement that needed a target', () => {
  // The reported bug: a Project with nothing running shows "No live workspaces in this project"
  // on New tab, and switching to New workspace has to make the dialog usable again.
  const els = runRenderStartTarget([], 'new_workspace');
  assert.equal(els.startSubmit.disabled, false);
  assert.equal(els.startError.textContent, '');
  assert.equal(els.startTargetRow.innerHTML, '');
});

test('New tab with no live workspace still refuses, and says why', () => {
  const els = runRenderStartTarget([], 'new_tab');
  assert.equal(els.startSubmit.disabled, true);
  assert.match(els.startError.textContent, /No live workspaces/);
});

test('New tab with a live workspace in this project is offered', () => {
  const els = runRenderStartTarget(
    [{pane_id: 'w1:p1', project_id: 'charts', workspace_id: 'w1', project: 'Charts'}], 'new_tab');
  assert.equal(els.startSubmit.disabled, false);
  assert.equal(els.startError.textContent, '');
});

// --- terminal shortcuts (T2) ---
// The grid sends into a shell, so a blob that survives parsing is a blob whose entries will be
// run. Everything below is about what must not survive it.

const shortcut = (o = {}) => ({label: 'ls', text: 'ls -la', ...o});
const blob = items => JSON.stringify({version: 1, items});

test('parseTermShortcuts reads a well-formed blob', () => {
  assert.deepEqual(parseTermShortcuts(blob([shortcut()])),
                   [{label: 'ls', text: 'ls -la', danger: false}]);
});

test('parseTermShortcuts discards corrupt, wrong-version, and malformed values', () => {
  for (const raw of ['', 'not json', '{', 'null', '[]',
                     JSON.stringify({version: 2, items: [shortcut()]}),
                     JSON.stringify({version: 1, items: 'nope'}),
                     JSON.stringify({version: 1, pairs: [shortcut()]})]) {
    assert.deepEqual(parseTermShortcuts(raw), [], `should be empty for ${JSON.stringify(raw)}`);
  }
});

test('parseTermShortcuts drops entries with no label, no text, or the wrong types', () => {
  const items = [shortcut({label: ''}), shortcut({text: ''}), shortcut({label: 7}),
                 shortcut({text: ['ls']}), {}, null, shortcut()];
  assert.deepEqual(parseTermShortcuts(blob(items)).map(s => s.label), ['ls']);
});

test('parseTermShortcuts drops a command the relay would refuse anyway', () => {
  const items = [shortcut({label: 'huge', text: 'x'.repeat(SEND_TEXT_MAX + 1)}), shortcut()];
  assert.deepEqual(parseTermShortcuts(blob(items)).map(s => s.label), ['ls']);
});

test('parseTermShortcuts caps the grid and coerces danger to a boolean', () => {
  const items = Array.from({length: MAX_TERM_SHORTCUTS + 5}, () => shortcut({danger: 'yes'}));
  const out = parseTermShortcuts(blob(items));
  assert.equal(out.length, MAX_TERM_SHORTCUTS);
  assert.equal(out[0].danger, true);
});

test('parseTermShortcuts keeps only the three fields the grid renders', () => {
  const [only] = parseTermShortcuts(blob([shortcut({onclick: 'alert(1)', danger: true})]));
  assert.deepEqual(Object.keys(only).sort(), ['danger', 'label', 'text']);
});

test('escapeHtml keeps an armed shortcut label as text', () => {
  assert.equal(escapeHtml('Run <img src=x onerror=alert(1)>?'),
               'Run &lt;img src=x onerror=alert(1)&gt;?');
});

test('every shipped default is a read-only command and survives its own parser', () => {
  assert.deepEqual(parseTermShortcuts(blob(DEFAULT_TERM_SHORTCUTS)).map(s => s.label),
                   DEFAULT_TERM_SHORTCUTS.map(s => s.label));
  for (const s of DEFAULT_TERM_SHORTCUTS) {
    assert.equal(s.danger, undefined, `${s.label} ships marked destructive`);
    assert.doesNotMatch(s.text, /\b(rm|sudo|kill|reset|clean|mv|dd)\b/, `${s.label} writes`);
  }
});

// --- New terminal placement (T3) ---
// The same dialog, one list wider: a terminal may be opened beside a terminal, and in a
// workspace that holds nothing else. Reading only `agents` here refused both.

test('a workspace holding only terminals is a target for a new terminal', () => {
  const shell = {pane_id: 'w1:p1', project_id: 'charts', workspace_id: 'w1', label: 'build'};
  const els = runRenderStartTarget([], 'new_tab', 'terminal', [shell]);
  assert.equal(els.startSubmit.disabled, false);
  assert.equal(els.startError.textContent, '');
});

test('but not for a new session, which needs a pane of its own', () => {
  const shell = {pane_id: 'w1:p1', project_id: 'charts', workspace_id: 'w1', label: 'build'};
  const els = runRenderStartTarget([], 'new_tab', 'agent', [shell]);
  assert.equal(els.startSubmit.disabled, true);
  assert.match(els.startError.textContent, /No live workspaces/);
});

test('a terminal is offered as a split source, and named rather than "undefined"', () => {
  // A shell has no `agent`, and the option label used to fall through to it.
  const shell = {pane_id: 'w1:p1', project_id: 'charts', workspace_id: 'w1', label: ''};
  const els = runRenderStartTarget([], 'split', 'terminal', [shell]);
  assert.equal(els.startSubmit.disabled, false);
  assert.deepEqual(els.startTargetOptions, [['w1:p1', 'w1:p1 · w1:p1']]);
});

// --- Start status line ---
// One element says both "this is running" and "this is how it ended", so what is pinned here is
// that the two states are distinguishable and that a refusal the user can only answer by pressing
// again says so.

function runStartStatus(body) {
  const el = {textContent: '', style: {}};
  const ctx = vm.createContext({document: {getElementById: () => el}});
  vm.runInContext(START_DIALOG + '\n;' + body, ctx);
  return el;
}

test('the running state is muted and the failed one is not', () => {
  const busy = runStartStatus('setStartStatus("Starting session…", true)');
  assert.match(busy.textContent, /Starting session/);
  assert.equal(busy.style.display, 'block');
  assert.equal(busy.style.color, 'var(--muted)');

  const failed = runStartStatus('setStartError("herdr agent start: agent_pane_busy")');
  assert.equal(failed.style.color, 'var(--red)');

  assert.equal(runStartStatus('setStartStatus("", true)').style.display, 'none');
});

test('a refusal the user can only answer by pressing again says try again', () => {
  const hint = body => runStartStatus(`setStartError(withRetryHint(${JSON.stringify(body)}))`).textContent;
  assert.match(hint('herdr agent start: agent_pane_busy'), /try again\.$/);
  assert.match(hint('herdr agent start: not an available shell'), /try again\.$/);
  assert.match(hint('herdr pane split failed: timed out'), /try again\.$/);
  // Something to fix in the dialog is not something to press through, and a message that already
  // says it does not say it twice.
  assert.equal(hint('project is not configured'), 'project is not configured');
  assert.equal(hint('Select a target first'), 'Select a target first');
  assert.equal(hint('pane is busy — try again.'), 'pane is busy — try again.');
});

function runSpawnStatus(body) {
  const els = {
    spawnStatus: {style: {}}, spawnSpinner: {hidden: false}, spawnStatusText: {textContent: ''},
  };
  const ctx = vm.createContext({
    document: {getElementById: id => els[id]}, clearTimeout: () => {}, setTimeout: () => 1,
  });
  vm.runInContext(START_DIALOG + '\n;' + body, ctx);
  return els;
}

test('the floating start card carries progress, warnings, and errors', () => {
  const busy = runSpawnStatus('showSpawnStatus("Duplicating Architect 1…", "busy")');
  assert.equal(busy.spawnStatus.style.display, 'flex');
  assert.equal(busy.spawnSpinner.hidden, false);
  assert.equal(busy.spawnStatus.style.borderColor, 'var(--blue)');

  const warning = runSpawnStatus('showSpawnStatus("Name taken", "warning")');
  assert.equal(warning.spawnSpinner.hidden, true);
  assert.equal(warning.spawnStatus.style.borderColor, 'var(--orange)');

  const error = runSpawnStatus('showSpawnStatus("start failed", "error")');
  assert.equal(error.spawnStatus.style.borderColor, 'var(--red)');
  assert.equal(error.spawnStatusText.textContent, 'start failed');
});

// --- Enter in the composer ---

const key = (over) => Object.assign({key: 'Enter', metaKey: false, ctrlKey: false, shiftKey: false}, over);

test('Ctrl/Cmd+Enter sends whatever the pane is and whatever the setting is', () => {
  for (const shell of [true, false]) for (const enterSends of [true, false]) {
    assert.equal(enterAction(key({metaKey: true}), {shell, enterSends}), 'send');
    assert.equal(enterAction(key({ctrlKey: true}), {shell, enterSends}), 'send');
  }
});

test('a bare Enter sends only over a terminal with the setting on', () => {
  assert.equal(enterAction(key(), {shell: true, enterSends: true}), 'send');
  assert.equal(enterAction(key(), {shell: true, enterSends: false}), 'newline');
  assert.equal(enterAction(key(), {shell: false, enterSends: true}), 'newline');
  assert.equal(enterAction(key(), {shell: false, enterSends: false}), 'newline');
});

test('Shift+Enter always writes a newline', () => {
  assert.equal(enterAction(key({shiftKey: true}), {shell: true, enterSends: true}), 'newline');
});

test('other keys are not the composer key handler business', () => {
  assert.equal(enterAction(key({key: 'a'}), {shell: true, enterSends: true}), 'none');
});

// --- Ctrl chords in the composer ---

const ALLOWED = ['ctrl+c', 'ctrl+d', 'ctrl+u', 'ctrl+r', 'ctrl+l', 'ctrl+z'];
const chord = (over) => Object.assign(
  {key: 'c', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false}, over);
const at = (over) => Object.assign({shell: true, empty: true, allowed: ALLOWED}, over);

test('an allowed Ctrl chord in an empty terminal composer goes to the pane', () => {
  assert.equal(ctrlChord(chord(), at()), 'ctrl+c');
  assert.equal(ctrlChord(chord({key: 'Z'}), at()), 'ctrl+z', 'case does not matter');
});

test('the browser keeps the chord when there is text to copy, cut, or undo', () => {
  assert.equal(ctrlChord(chord(), at({empty: false})), null);
});

test('an agent composer never sends a chord', () => {
  assert.equal(ctrlChord(chord(), at({shell: false})), null);
});

test('Cmd, Alt, and Shift are left to the platform', () => {
  for (const mod of ['metaKey', 'altKey', 'shiftKey']) {
    assert.equal(ctrlChord(chord({[mod]: true}), at()), null, `${mod} must not send`);
  }
  assert.equal(ctrlChord(chord({ctrlKey: false}), at()), null, 'a bare letter is typing');
});

test('a letter outside the allowlist is typed, not sent', () => {
  assert.equal(ctrlChord(chord({key: 'a'}), at()), null);
  assert.equal(ctrlChord(chord({key: 'v'}), at()), null, 'paste survives');
});
