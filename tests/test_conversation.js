// Turning a pane into a transcript that outlives it.
//
// Consecutive reads of one pane overlap, and the overlap is the whole problem: the pane scrolls,
// `Load more` shifts it the other way, and the newest message is still being written while it is
// read. The same words therefore arrive again and again at different line numbers, and what the
// recorder has to get right is which of them are the same message.
//
// The cases below are the ones a happy-path implementation passes by accident and a real pane
// fails on: a message that grew between two reads, a window that reaches above what is stored, a
// pane that scrolled past a whole window, and an agent that said the same short thing twice.
//
// Runs the block straight out of web/index.html so the single-file app keeps its no-build-step
// property, the same trick tests/test_summary_detect.js uses.
//
//   node --test tests/test_conversation.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const slice = (start, end) => {
  const from = HTML.indexOf(start), to = HTML.indexOf(end, from);
  assert.ok(from !== -1 && to > from, `${start} not found in web/index.html`);
  return HTML.slice(from, to);
};

// Everything the detector block reaches for and does not declare. The recorder itself needs none
// of it — that is the property being kept.
const ctx = vm.createContext({
  console,
  activePane: null, paneOf: () => null, drawSel: () => {}, renderQuickActions: () => {},
  showToast: () => {}, confirm: () => true, scrollPaneToLine: () => {}, repaintHighlights: () => {},
  paneRows: [], selA: null, selB: null,
  localStorage: {getItem: () => null, setItem: () => {}},
});
// The pair block for composeTransfer: the classifier is fed by the real payload builder, so a
// change to the payload's shape breaks the classifier's test rather than the classifier.
// Then the detector and the recorder together — the recorder reads turnSummaries and
// userInputLines, and proving it against stubs of those would prove it agrees with the stubs.
const NAMES = ['paneMessages', 'recordMessages', 'convAt', 'convKey', 'convText', 'convHash', 'convMemberKey',
               'classifyVia', 'outboxAdd', 'tagUserEntries', 'composeTransfer', 'mergeEntries',
               'parseConvIndex', 'capEntries', 'evictOrder',
               'CONV_TEXT_MAX', 'CONV_OUTBOX_MAX', 'CONV_OUTBOX_TTL', 'CONV_MEMBER_MAX'];
vm.runInContext(
  slice('// --- P3 pair logic (pure) --- start', '// --- P3 pair logic (pure) --- end')
  + slice('    // --- Final message detection ---', '    // --- Conversation recorder (pure) --- end')
  // `const` is a lexical binding and never lands on the context object, so the block exports
  // itself explicitly. A rename in index.html therefore fails here loudly, not silently.
  + `\n;__out = {${NAMES.join(', ')}};`, ctx);
const {paneMessages, recordMessages, convAt, convKey, convText, convHash, convMemberKey, classifyVia,
       outboxAdd, tagUserEntries, composeTransfer, mergeEntries,
       parseConvIndex, capEntries, evictOrder,
       CONV_TEXT_MAX, CONV_OUTBOX_MAX, CONV_OUTBOX_TTL, CONV_MEMBER_MAX} = ctx.__out;

const NOW = 1755000000000;

// A claude pane: `⏺` opens what the agent said, `❯` is the prompt gutter, and the bare `❯` at the
// foot is the empty composer every live pane ends on.
const TWO_TURNS = [
  '❯ first question',
  '',
  '⏺ First answer.',
  '',
  '❯ second question',
  '',
  '⏺ Second answer.',
  '',
  '❯',
];

// Arrays built inside the vm carry the vm's Array.prototype, which deepStrictEqual counts as a
// difference. Copying them into this realm compares the contents, which is what is being asserted.
const texts = ms => Array.from(ms, m => m.text);
const whos = ms => Array.from(ms, m => m.who);
const record = (stored, rows, now, clock) => recordMessages(stored, paneMessages(rows, 'claude'), now, clock);

test('a window is the user and the agent in the order they spoke', () => {
  const ms = paneMessages(TWO_TURNS, 'claude');
  assert.deepStrictEqual(whos(ms), ['user', 'agent', 'user', 'agent']);
  assert.deepStrictEqual(texts(ms),
    ['first question', 'First answer.', 'second question', 'Second answer.']);
});

test('the empty composer at the foot is not a message', () => {
  // It is a prompt line with nothing typed on it, and a thread full of blank user turns is the
  // most obvious way this feature could look broken.
  assert.ok(!paneMessages(TWO_TURNS, 'claude').some(m => !m.text.trim()));
});

test('the Codex composer and its status line are not a user message', () => {
  const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'pane_codex_done.txt'), 'utf8')
    .split('\n');
  assert.deepStrictEqual(texts(paneMessages(rows, 'codex')), ['S2b review clean. No edit needed.\n\nVerified: 118 Node + 19 Playwright tests pass.\n\nNext: S3. Convert poll/render path to explicit view, then remove S1 accessors under two-view browser coverage.']);
});

test('a sent Codex prompt stays when its idle composer is removed', () => {
  const rows = ['› explain this', '', '• It works.', '', '› Write tests for @filename', '',
    '  gpt-5.6-terra medium · Context 83% used'];
  const ms = paneMessages(rows, 'codex');
  assert.deepStrictEqual(whos(ms), ['user', 'agent']);
  assert.deepStrictEqual(texts(ms), ['explain this', 'It works.']);
});

test('a multi-line prompt is one message, not one per line', () => {
  const rows = ['❯ do the thing', '❯ and then the other thing', '', '⏺ Done.', '', '❯'];
  const ms = paneMessages(rows, 'claude');
  assert.deepStrictEqual(texts(ms), ['do the thing\nand then the other thing', 'Done.']);
});

test('a harness with no profile records nothing rather than guessing', () => {
  assert.deepStrictEqual(texts(paneMessages(TWO_TURNS, 'amp')), []);
  assert.deepStrictEqual(texts(paneMessages(TWO_TURNS, null)), []);
});

test('a long message is cut to TEXT_MAX and says so', () => {
  const rows = ['❯ go', '', '⏺ ' + 'word '.repeat(2000), '', '❯'];
  const text = paneMessages(rows, 'claude')[1].text;
  assert.strictEqual(text.length, CONV_TEXT_MAX);
  assert.ok(text.endsWith('…'));
});

test('the first read stores the window whole, and is not a gap', () => {
  const out = record([], TWO_TURNS, NOW);
  assert.strictEqual(out.gap, false);
  assert.strictEqual(out.added, 4);
  assert.ok(out.entries.every(e => e.seen === NOW));
});

test('the first unread frame is ordered as backfill, except a known closing turn', () => {
  const out = record([], TWO_TURNS, NOW, {end: NOW - 100});
  assert.deepStrictEqual(Array.from(out.entries, e => e.at_src), ['backfill', 'backfill', 'backfill', 'state']);
  assert.ok(out.entries.slice(0, -1).every(e => convAt(e) < NOW));
  assert.strictEqual(convAt(out.entries[3]), NOW - 100);
});

test('re-reading an unchanged pane adds nothing', () => {
  // The 3s poll re-delivers the identical window. Anything but zero here is a transcript that
  // doubles in size every three seconds.
  const first = record([], TWO_TURNS, NOW);
  const again = record(first.entries, TWO_TURNS, NOW + 3000);
  assert.strictEqual(again.added, 0);
  assert.deepStrictEqual(texts(again.entries), texts(first.entries));
});

test('a scrolled window appends only what is new', () => {
  const first = record([], TWO_TURNS, NOW);
  // The pane has scrolled: the first turn is off the top, and a third has arrived.
  const later = TWO_TURNS.slice(4).concat(
    [' ', '❯ third question', '', '⏺ Third answer.', '', '❯']);
  const out = record(first.entries, later, NOW + 60000);
  assert.strictEqual(out.gap, false);
  assert.deepStrictEqual(texts(out.entries), [
    'first question', 'First answer.', 'second question', 'Second answer.',
    'third question', 'Third answer.',
  ]);
  assert.strictEqual(out.entries[4].seen, NOW + 60000);
});

test('the same message said twice is two messages', () => {
  // The case a text-hash dedupe gets wrong, silently. Agents say "Done." constantly.
  const rows = ['❯ a', '', '⏺ Done.', '', '❯ b', '', '⏺ Done.', '', '❯'];
  const out = record([], rows, NOW);
  assert.deepStrictEqual(texts(out.entries), ['a', 'Done.', 'b', 'Done.']);
  // And the next read of the same pane still does not think one of them is new.
  assert.strictEqual(record(out.entries, rows, NOW + 3000).added, 0);
});

test('a message still being written is extended, not duplicated', () => {
  // Every poll during a reply reads a longer version of the same paragraph.
  // The composer stays at the foot while the agent writes, so the half-written reply is the block
  // above it exactly as the finished one will be.
  const half = ['❯ explain', '', '⏺ The relay polls herdr and', '', '❯'];
  const whole = ['❯ explain', '', '⏺ The relay polls herdr and broadcasts to clients.', '', '❯'];
  const first = record([], half, NOW);
  assert.deepStrictEqual(texts(first.entries), ['explain', 'The relay polls herdr and']);
  const out = record(first.entries, whole, NOW + 3000);
  assert.strictEqual(out.grew, true);
  assert.strictEqual(out.added, 0);
  assert.deepStrictEqual(texts(out.entries), ['explain', 'The relay polls herdr and broadcasts to clients.']);
  // It is the same message, so it keeps when it was first seen.
  assert.strictEqual(out.entries[1].seen, NOW);
});

test('a completed agent turn upgrades its read stamp but never rewrites a sent prompt', () => {
  const half = ['❯ explain', '', '⏺ The relay polls', '', '❯'];
  const whole = ['❯ explain', '', '⏺ The relay polls herdr.', '', '❯'];
  const first = record([{who: 'user', text: 'explain', seen: NOW - 10, at: NOW - 10, at_src: 'sent'},
    {who: 'agent', text: 'The relay polls', seen: NOW, at: NOW, at_src: 'read'}], half, NOW);
  const out = record(first.entries, whole, NOW + 100, {end: NOW + 50});
  assert.strictEqual(out.entries[0].at_src, 'sent');
  assert.strictEqual(convAt(out.entries[0]), NOW - 10);
  assert.strictEqual(out.entries[1].at_src, 'state');
  assert.strictEqual(convAt(out.entries[1]), NOW + 50);
});

test('Load more prepends the older turns and does not restamp the thread', () => {
  const later = TWO_TURNS.slice(4);
  const first = record([], later, NOW + 60000);
  assert.deepStrictEqual(texts(first.entries), ['second question', 'Second answer.']);
  const out = record(first.entries, TWO_TURNS, NOW + 90000);
  assert.strictEqual(out.gap, false);
  assert.strictEqual(out.added, 2);
  assert.deepStrictEqual(texts(out.entries),
    ['first question', 'First answer.', 'second question', 'Second answer.']);
  // Older than what follows them, and marked as arriving late — never stamped with now, which
  // would file an hour-old message as the newest thing in the thread.
  assert.ok(out.entries.slice(0, 2).every(e => e.backfill === true));
  assert.ok(out.entries.slice(0, 2).every(e => e.seen === NOW + 60000));
});

test('a pane that scrolled past a whole window is a gap, not a silent join', () => {
  const first = record([], TWO_TURNS, NOW);
  const far = ['❯ much later question', '', '⏺ Much later answer.', '', '❯'];
  const out = record(first.entries, far, NOW + 3600000);
  assert.strictEqual(out.gap, true);
  assert.strictEqual(out.entries[4].gap, true);
  assert.deepStrictEqual(texts(out.entries).slice(4), ['much later question', 'Much later answer.']);
});

test('a window re-read at a different wrap width is not new content', () => {
  // The relay reports the pane's width and the harness rewraps; the words are the same.
  const wide = ['❯ go', '', '⏺ One long sentence that fits on a single line here.', '', '❯'];
  const narrow = ['❯ go', '', '⏺ One long sentence that fits', '  on a single line here.', '', '❯'];
  const first = record([], wide, NOW);
  const out = record(first.entries, narrow, NOW + 3000);
  assert.strictEqual(out.added, 0);
  assert.strictEqual(out.gap, false);
});

test('the comparison key is not the stored text', () => {
  // Collapsing whitespace is what makes the rewrap above compare equal; storing the collapsed
  // form would run Codex's three closing paragraphs together.
  const rows = ['❯ go', '', '⏺ First paragraph.', '', '  Second paragraph.', '', '❯'];
  const text = paneMessages(rows, 'claude')[1].text;
  assert.ok(text.includes('\n'), text);
  assert.strictEqual(convKey(text), 'First paragraph. Second paragraph.');
});

test('recording never mutates what it was given', () => {
  // The caller holds the stored array and writes it only when something was added; a recorder
  // that edits it in place would make that decision meaningless.
  const first = record([], TWO_TURNS, NOW);
  const before = JSON.stringify(first.entries);
  record(first.entries, TWO_TURNS.concat(['⏺ More.', '', '❯']), NOW + 3000);
  assert.strictEqual(JSON.stringify(first.entries), before);
});

test('a real pane reads as one turn: the request, then what it concluded', () => {
  // The same fixture the detector is proved on, so a harness that changes its glyphs breaks here
  // too rather than quietly recording nothing.
  const rows = fs.readFileSync(path.join(__dirname, 'fixtures', 'pane_claude_done.txt'), 'utf8')
    .split('\n');
  // The read begins mid-block, above the closing message and below the prompt that asked for it,
  // which is what 200 lines off the foot of a real pane looks like.
  const ms = paneMessages(rows, 'claude');
  assert.deepStrictEqual(whos(ms), ['agent', 'user']);
  assert.match(ms[0].text, /^Ready\. Name the change\./);
  assert.ok(!ms[0].text.includes('⎿'), 'tool output leaked into the message');
  assert.ok(!ms[0].text.includes('Baked for'), 'the turn footer leaked into the message');
  assert.strictEqual(ms[1].text, 'allow the test commands without prompting');
  assert.strictEqual(convText(rows, [11, 11]), ms[1].text);
});

// --- provenance: typed, transferred, or both ---
//
// doTransfer prefills the composer and never sends, so what reaches the pane is whatever the user
// pressed send on. These pin the three outcomes against the real payload builder.

const SELECTION = 'The relay polls herdr every 3s and broadcasts to clients.';
const PAYLOAD = composeTransfer('Review this.', 'architect', SELECTION).text;
const pending = (o = {}) => Object.assign({
  key: 'local|w1:p1|claude|/work', label: 'Architect 1',
  body: SELECTION, payload: PAYLOAD, hash: convHash(SELECTION), at: NOW,
}, o);

test('the composed payload sent unchanged is a transfer', () => {
  const out = classifyVia(pending(), PAYLOAD, NOW + 5000);
  assert.strictEqual(out.via, 'transfer');
  assert.strictEqual(out.from.label, 'Architect 1');
  assert.strictEqual(out.from.key, 'local|w1:p1|claude|/work');
});

test('an instruction typed over the payload is mixed, which is the common case', () => {
  // The prefill is a checkpoint, and adding to what it put there is what a checkpoint is for.
  const out = classifyVia(pending(), 'Also check the tests.\n\n' + PAYLOAD, NOW + 5000);
  assert.strictEqual(out.via, 'mixed');
  assert.strictEqual(out.from.hash, convHash(SELECTION));
});

test('the payload deleted and replaced is typed, with no source attached', () => {
  const out = classifyVia(pending(), 'never mind, do the other thing', NOW + 5000);
  assert.strictEqual(out.via, 'typed');
  assert.strictEqual(out.from, undefined);
});

test('a prefill the user left for half an hour no longer answers for a send', () => {
  assert.strictEqual(classifyVia(pending(), PAYLOAD, NOW + CONV_OUTBOX_TTL + 1).via, 'typed');
});

test('a send with no prefill behind it is typed', () => {
  assert.strictEqual(classifyVia(null, 'do the thing', NOW).via, 'typed');
});

test('the payload rewrapped by the composer is still the same transfer', () => {
  // The textarea soft-wraps and the pane re-wraps again; the words are what identify it.
  const out = classifyVia(pending(), PAYLOAD.replace(/ /g, '\n'), NOW + 5000);
  assert.strictEqual(out.via, 'transfer');
});

test('the outbox keeps queued classifications in send order and forgets the old ones', () => {
  let box = [];
  for (let i = 0; i < CONV_OUTBOX_MAX + 10; i++) {
    box = outboxAdd(box, convHash('prompt ' + i), {via: 'transfer'}, NOW + i);
  }
  assert.strictEqual(box.length, CONV_OUTBOX_MAX);
  const user = t => [{who: 'user', text: t, seen: NOW + 60}];
  assert.strictEqual(tagUserEntries(user('prompt 0'), box, NOW + 60).entries[0].via, 'typed',
    'a send evicted by the cap answers nothing');
  assert.strictEqual(tagUserEntries(user('prompt 59'), box, NOW + 60).entries[0].via, 'transfer');
});

test('two identical transferred prompts each consume one outbox entry', () => {
  const note = classifyVia(pending(), PAYLOAD, NOW);
  let box = outboxAdd([], convHash(PAYLOAD), note, NOW);
  box = outboxAdd(box, convHash(PAYLOAD), note, NOW + 1);
  const first = tagUserEntries([{who: 'user', text: PAYLOAD, seen: NOW + 2}], box, NOW + 2);
  assert.strictEqual(first.entries[0].via, 'transfer');
  assert.strictEqual(first.outbox.length, 1);
  const second = tagUserEntries([{who: 'user', text: PAYLOAD, seen: NOW + 3}], first.outbox, NOW + 3);
  assert.strictEqual(second.entries[0].via, 'transfer');
  assert.strictEqual(second.outbox.length, 0);
});

test('an expired entry answers nothing, even before it is evicted', () => {
  const box = outboxAdd([], convHash('do the thing'), {via: 'mixed'}, NOW);
  const late = NOW + CONV_OUTBOX_TTL + 1;
  const out = tagUserEntries([{who: 'user', text: 'do the thing', seen: late}], box, late);
  assert.strictEqual(out.entries[0].via, 'typed');
  assert.deepStrictEqual(Array.from(out.outbox), []);
});

test('the recorder tags the prompt when it reads it back off the pane', () => {
  // The whole point of the outbox: the send is classified here and the prompt appears in the pane
  // seconds later, having been through the harness's own rendering.
  const box = outboxAdd([], convHash(PAYLOAD), classifyVia(pending(), PAYLOAD, NOW), NOW);
  const rows = ('❯ ' + PAYLOAD.split('\n').join('\n❯ ')).split('\n')
    .concat(['', '⏺ Looking now.', '', '❯']);
  const out = record([], rows, NOW + 5000);
  const tagged = tagUserEntries(out.entries, box, NOW + 5000).entries;
  assert.strictEqual(tagged[0].via, 'transfer');
  assert.strictEqual(tagged[0].from.label, 'Architect 1');
  // And what the agent said is never given a provenance: everything an agent says is its own.
  assert.strictEqual(tagged[1].via, undefined);
});

test('an unmatched prompt is typed, which is the honest failure', () => {
  // Provenance is only knowable where the send happened. A transfer made on the desktop and
  // recorded on the phone reads as typed there, because the phone never saw the transfer.
  const tagged = tagUserEntries(record([], TWO_TURNS, NOW).entries, [], NOW).entries;
  assert.deepStrictEqual(Array.from(tagged, e => e.via), ['typed', undefined, 'typed', undefined]);
});

test('a tagged entry is never reclassified', () => {
  // Which is also what keeps it cheap: the hash is computed for new entries only.
  const already = [{who: 'user', text: 'do the thing', seen: NOW, via: 'transfer', from: {label: 'x'}}];
  const box = outboxAdd([], convHash('do the thing'), {via: 'mixed'}, NOW);
  assert.strictEqual(tagUserEntries(already, box, NOW).entries[0].via, 'transfer');
});

test('a pane fingerprint is all four fields, so a recycled id cannot inherit a transcript', () => {
  const a = {host: 'local', pane_id: 'w1:p1', agent: 'claude', cwd: '/work'};
  assert.strictEqual(convMemberKey(a), '["local","w1:p1","claude","/work"]');
  assert.notStrictEqual(convMemberKey(a), convMemberKey({...a, cwd: '/other'}));
  assert.notStrictEqual(convMemberKey({...a, cwd: '/one|two'}),
    convMemberKey({...a, cwd: '/one', agent: 'two|claude'}));
  assert.strictEqual(convMemberKey(null), '');
});

// --- the index, and what gets evicted ---
//
// The store itself is a real IndexedDB and is proved in tests/e2e/browser/conversation.spec.js.
// What is here is the part that decides *what* is written and what is dropped, which is where a
// bug loses history rather than a render.

const index = items => JSON.stringify({version: 1, items: items});
// Same realm caveat as above: what is asserted is the contents, not which Array built them.
const ids = raw => Array.from(parseConvIndex(raw), c => c.id);
const dropped = (...args) => Array.from(evictOrder(...args));

test('a corrupt index loads as no conversations, never as half of one', () => {
  // It outlives the panes it describes, so one day it is read by a version that did not write it.
  assert.deepStrictEqual(ids('{not json'), []);
  assert.deepStrictEqual(ids(null), []);
  assert.deepStrictEqual(ids(index('nope')), []);
  assert.deepStrictEqual(ids(JSON.stringify({version: 99, items: [{id: 'c1'}]})), []);
});

test('a named conversation may be empty, but malformed entries are dropped', () => {
  const items = [{id: 'c1', name: 'auth', members: []}, {id: 'c2', members: []}, {name: 'x'}];
  assert.deepStrictEqual(ids(index(items)), ['c1']);
});

test('membership is capped, and the cap does not drop the conversation', () => {
  const members = Array.from({length: 20}, (_, i) => ({key: 'local|w1:p' + i + '|claude|/work'}));
  const [conv] = parseConvIndex(index([{id: 'c1', name: 'auth', members: members}]));
  assert.strictEqual(conv.members.length, CONV_MEMBER_MAX);
  assert.strictEqual(conv.name, 'auth');
});

test('a transcript past its ceiling loses its oldest entries, not its newest', () => {
  const entries = Array.from({length: 30}, (_, i) => ({who: 'agent', text: 'm' + i, seen: NOW + i}));
  const kept = capEntries(entries, 10);
  assert.strictEqual(kept.length, 10);
  assert.strictEqual(kept[0].text, 'm20');
  assert.strictEqual(kept[9].text, 'm29');
  // Under the ceiling it is the same array, so the common case allocates nothing.
  assert.strictEqual(capEntries(entries, 100), entries);
});

test('eviction drops what nobody named before anything anyone did', () => {
  // Naming a conversation is what protects its history — the promise the name makes.
  const rec = (key, touched) => ({key: key, touched: touched});
  const all = [rec('a', 1), rec('b', 2), rec('c', 3), rec('d', 4)];
  // 'a' is the oldest, but it is in a conversation and 'b' and 'c' are not.
  assert.deepStrictEqual(dropped(all, new Set(['a', 'd']), 2), ['b', 'c']);
});

test('with everything referenced, the oldest touched goes first', () => {
  const all = [{key: 'a', touched: 3}, {key: 'b', touched: 1}, {key: 'c', touched: 2}];
  assert.deepStrictEqual(dropped(all, new Set(['a', 'b', 'c']), 1), ['b', 'c']);
});

test('nothing is evicted while there is room', () => {
  assert.deepStrictEqual(dropped([{key: 'a', touched: 1}], new Set(), 500), []);
});

// --- The joint thread ---
// Several members are one thread on screen and never one record on disk, so the merge is a render
// and this is the property that lets it be: every member's own order survives it.

test('three members interleave by when each was seen', () => {
  const at = (who, text, seen) => ({who: who, text: text, seen: seen});
  const recs = [
    {key: 'a', member: 0, entries: [at('user', 'a1', 10), at('agent', 'a2', 40)]},
    {key: 'b', member: 1, entries: [at('agent', 'b1', 20)]},
    {key: 'c', member: 2, entries: [at('agent', 'c1', 30), at('agent', 'c2', 50)]},
  ];
  assert.deepStrictEqual(texts(mergeEntries(recs)), ['a1', 'b1', 'c1', 'a2', 'c2']);
  // The colour comes from member order, and it travels with the entry.
  assert.deepStrictEqual(Array.from(mergeEntries(recs), e => e.member), [0, 1, 2, 0, 2]);
});

test('the joint merge prefers a message time to its later observation time', () => {
  const recs = [
    {key: 'a', member: 0, entries: [{who: 'agent', text: 'a', seen: 100, at: 20, at_src: 'state'}]},
    {key: 'b', member: 1, entries: [{who: 'agent', text: 'b', seen: 10, at: 30, at_src: 'read'}]},
  ];
  assert.deepStrictEqual(texts(mergeEntries(recs)), ['a', 'b']);
});

test('no member’s own order is ever broken, whatever the clocks say', () => {
  // Two panes on two hosts have two clocks. A merge that sorted globally would reorder one pane's
  // own turns against each other, which is the one thing reading a member alone must not lose.
  const recs = [
    {key: 'a', member: 0, entries: [
      {who: 'user', text: 'a1', seen: 100}, {who: 'agent', text: 'a2', seen: 99}]},
    {key: 'b', member: 1, entries: [{who: 'agent', text: 'b1', seen: 99}]},
  ];
  const out = texts(mergeEntries(recs));
  assert.ok(out.indexOf('a1') < out.indexOf('a2'), 'the pane said a1 before a2');
});

test('a tie is broken by member order, so the thread is stable between renders', () => {
  const recs = [
    {key: 'a', member: 0, entries: [{who: 'agent', text: 'a1', seen: 5}]},
    {key: 'b', member: 1, entries: [{who: 'agent', text: 'b1', seen: 5}]},
  ];
  assert.deepStrictEqual(texts(mergeEntries(recs)), ['a1', 'b1']);
});

test('a member with nothing recorded yet contributes nothing and breaks nothing', () => {
  const recs = [
    {key: 'a', member: 0, entries: []},
    {key: 'b', member: 1, entries: [{who: 'agent', text: 'b1', seen: 5}]},
  ];
  assert.deepStrictEqual(texts(mergeEntries(recs)), ['b1']);
  assert.deepStrictEqual(texts(mergeEntries([])), []);
});
