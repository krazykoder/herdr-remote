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

const PAIRS_PURE = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'pairs_pure.js'), 'utf8');
const SUMMARY_DETECT = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'summary_detect.js'), 'utf8');
const CONV_PURE = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'conversation_pure.js'), 'utf8');

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
const NAMES = ['paneMessages', 'backfillEntries', 'splitFirstRead', 'sentTurnEntries', 'turnMessages', 'newTurnMessages', 'recoveredTurn', 'turnEntries',
               'convAt', 'convKey', 'convText', 'convHash', 'convMemberKey',
               'classifyVia', 'outboxAdd', 'tagUserEntries', 'composeTransfer', 'mergeEntries', 'convDedupe',
               'parseConvIndex', 'capEntries', 'fitPrepend', 'deepEntries', 'evictOrder', 'convCopyName',
               'CONV_TEXT_MAX', 'CONV_OUTBOX_MAX', 'CONV_OUTBOX_TTL', 'CONV_MEMBER_MAX', 'CONV_ROSTER_MAX'];
vm.runInContext(
  PAIRS_PURE + '\n' + SUMMARY_DETECT + '\n' + CONV_PURE
  // `const` is a lexical binding and never lands on the context object, so the block exports
  // itself explicitly. A rename in source therefore fails here loudly, not silently.
  + `\n;__out = {${NAMES.join(', ')}};`, ctx);
const {paneMessages, backfillEntries, splitFirstRead, sentTurnEntries, turnMessages, newTurnMessages, recoveredTurn, turnEntries,
       convAt, convKey, convText, convHash, convMemberKey, classifyVia,
       outboxAdd, tagUserEntries, composeTransfer, mergeEntries, convDedupe,
       parseConvIndex, capEntries, fitPrepend, deepEntries, evictOrder, convCopyName,
       CONV_TEXT_MAX, CONV_OUTBOX_MAX, CONV_OUTBOX_TTL, CONV_MEMBER_MAX,
       CONV_ROSTER_MAX} = ctx.__out;

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
// The two writes a transcript ever takes, as the recorder makes them: the first read of a pane,
// and the end of one of its turns.
const backfill = (rows, now) => backfillEntries(paneMessages(rows, 'claude'), now);
const turn = (stored, rows, now, end) => turnEntries(paneMessages(rows, 'claude'), stored, now, end);

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

// --- The two writes ---
//
// Nothing below compares one read against another, because nothing in the recorder does. A
// transcript is written when a pane is first read, when one of its turns ends, and when this app
// sends a prompt — three events, each happening once.

test('the first read of a pane is its history, ordered and marked as such', () => {
  const out = backfill(TWO_TURNS, NOW);
  assert.deepStrictEqual(texts(out),
    ['first question', 'First answer.', 'second question', 'Second answer.']);
  assert.ok(out.every(e => e.at_src === 'backfill'), 'nobody watched any of it happen');
  // Ordered against each other and placed before now, which is the whole of what can be said.
  assert.ok(out.every((e, i) => i === 0 || convAt(out[i - 1]) < convAt(e)));
  assert.ok(out.every(e => convAt(e) < NOW));
});

test('a turn is the closing message and the prompt that opened it', () => {
  assert.deepStrictEqual(texts(turnMessages(paneMessages(TWO_TURNS, 'claude'))),
    ['second question', 'Second answer.']);
});

test('an agent that answers one prompt twice records the prompt once', () => {
  // Both turns have the same prompt above them in the window — it is the newest one either way.
  const rows = ['❯ go', '', '⏺ First pass.', '', '❯'];
  const stored = backfill(rows, NOW);
  const again = ['❯ go', '', '⏺ First pass.', '', '⏺ Second pass.', '', '❯'];
  assert.deepStrictEqual(texts(turn(stored, again, NOW + 1000, NOW + 900)), ['Second pass.']);
});

test('a prompt already committed at the send is not read back off the pane', () => {
  // The transcript ends on a user entry, which is what "this app sent it" looks like from here.
  const stored = [{who: 'user', text: 'second question', at: NOW - 10, at_src: 'sent'}];
  const out = turn(stored, TWO_TURNS, NOW, NOW - 1);
  assert.deepStrictEqual(texts(out), ['Second answer.'], 'the prompt is already in the transcript');
});

test('a first read keeps a sent prompt in place and appends its completed reply', () => {
  const stored = [{who: 'user', text: 'second question', at: NOW - 10, at_src: 'sent'}];
  const first = splitFirstRead(paneMessages(TWO_TURNS, 'claude'), stored);
  const history = backfillEntries(first.history, NOW);
  const reply = turnEntries(first.turn, stored, NOW, NOW - 1);
  assert.deepStrictEqual(texts(history), ['first question', 'First answer.']);
  assert.deepStrictEqual(texts(reply), ['Second answer.']);
  assert.deepStrictEqual(texts(history.concat(stored, reply)),
    ['first question', 'First answer.', 'second question', 'Second answer.']);
  assert.strictEqual(reply[0].at_src, 'state');
});

test('two sends before a first read cost neither its prompt nor its reply', () => {
  // Both prompts reached the store before the pane was ever read, so both echoes are already
  // entries and the older reply is not scrollback.
  const rows = ['\u276f old business', '', '\u23fa Older answer.', '',
                '\u276f first question', '', '\u23fa First answer.', '',
                '\u276f second question', '', '\u23fa Second answer.', '', '\u276f'];
  const stored = [{who: 'user', text: 'first question', at: NOW - 20, at_src: 'sent'},
                  {who: 'user', text: 'second question', at: NOW - 10, at_src: 'sent'}];
  const first = splitFirstRead(paneMessages(rows, 'claude'), stored);
  const history = backfillEntries(first.history, NOW);
  const reply = sentTurnEntries(first.turn, stored, NOW, NOW - 1);
  assert.deepStrictEqual(texts(history), ['old business', 'Older answer.'],
    'the seam is the oldest sent prompt, so neither prompt is filed twice');
  assert.deepStrictEqual(texts(reply), ['First answer.', 'Second answer.']);
  assert.strictEqual(reply[0].at_src, 'read', 'only the closing message carries the transition');
  assert.strictEqual(reply[1].at_src, 'state');
});

test('a sent prompt that also sits far up the scrollback splits at its echo', () => {
  const rows = ['\u276f go', '', '\u23fa Older answer.', '',
                '\u276f go', '', '\u23fa Newer answer.', '', '\u276f'];
  const stored = [{who: 'user', text: 'go', at: NOW - 10, at_src: 'sent'}];
  const first = splitFirstRead(paneMessages(rows, 'claude'), stored);
  assert.deepStrictEqual(texts(backfillEntries(first.history, NOW)), ['go', 'Older answer.']);
  assert.deepStrictEqual(texts(sentTurnEntries(first.turn, stored, NOW, NOW - 1)),
    ['Newer answer.']);
});

test('a copy is named apart from what it was copied from', () => {
  assert.strictEqual(convCopyName('the release', []), 'the release (copy)');
  // The second copy is the third grouping of the same work, and two rows called the same is a list
  // nobody can pick from.
  assert.strictEqual(convCopyName('the release', ['the release', 'the release (copy)']),
    'the release (copy 2)');
  // Copying a copy does not stack the suffix.
  assert.strictEqual(convCopyName('the release (copy 2)', ['the release (copy)']),
    'the release (copy 2)');
  assert.ok(convCopyName('x'.repeat(80), []).length <= 64);
});

// A reload arms the turn clock at the reconnect, so `end` is newer than anything stored and the
// usual guard cannot tell a turn that ended while nobody was connected from the one recorded
// seconds before the tab closed. These are the rules that can.
const msgs = rows => paneMessages(rows, 'claude');

test('a turn already recorded before the tab closed is not recovered again', () => {
  const stored = backfill(TWO_TURNS, NOW);
  const found = turnEntries(msgs(TWO_TURNS), stored, NOW + 5000, 0, true);
  assert.deepStrictEqual(texts(found), [], 'the transcript already ends on this closing message');
});

test('a turn that ended while nothing was connected is recovered off the pane', () => {
  const stored = backfill(['\u276f first question', '', '\u23fa First answer.', '', '\u276f'], NOW);
  const found = turnEntries(msgs(TWO_TURNS), stored, NOW + 5000, 0, true);
  assert.deepStrictEqual(texts(found), ['second question', 'Second answer.']);
  // The reconnect is not when the agent finished, and the stamp says so rather than claiming a
  // transition this browser never saw.
  assert.ok(found.every(e => e.at_src === 'read'));
});

test('recovery consults the newest stored agent entry and no further', () => {
  // A prompt sent after the last recorded reply sits between them; the reply is still the answer.
  const stored = backfill(TWO_TURNS, NOW)
    .concat({who: 'user', text: 'third question', at: NOW + 1, at_src: 'sent'});
  assert.strictEqual(recoveredTurn(stored, turnMessages(msgs(TWO_TURNS))).length, 0);
});

test('an empty transcript recovers whatever is on the pane', () => {
  assert.deepStrictEqual(texts(turnEntries(msgs(TWO_TURNS), [], NOW, 0, true)),
    ['second question', 'Second answer.']);
});

test('a prompt typed at the keyboard is read back, because nothing else will', () => {
  const stored = [{who: 'agent', text: 'First answer.', at: NOW - 100, at_src: 'state'}];
  assert.deepStrictEqual(texts(turn(stored, TWO_TURNS, NOW, NOW - 1)),
    ['second question', 'Second answer.']);
});

test('the transition dates the closing message, and only that one', () => {
  const stored = [{who: 'agent', text: 'First answer.', at: NOW - 100, at_src: 'state'}];
  const out = turn(stored, TWO_TURNS, NOW, NOW - 50);
  assert.deepStrictEqual(Array.from(out, e => e.at_src), ['read', 'state']);
  assert.strictEqual(convAt(out[1]), NOW - 50, 'the turn ended when the pane said it did');
});

test('the same message said twice is two messages', () => {
  // The case a text-hash dedupe gets wrong, silently. Agents say "Done." constantly — and with
  // nothing matching text, two turns that both closed on "Done." simply are two entries.
  const one = ['❯ a', '', '⏺ Done.', '', '❯'];
  const two = ['❯ a', '', '⏺ Done.', '', '❯ b', '', '⏺ Done.', '', '❯'];
  const stored = backfill(one, NOW);
  const out = stored.concat(turn(stored, two, NOW + 1000, NOW + 900));
  assert.deepStrictEqual(texts(out), ['a', 'Done.', 'b', 'Done.']);
});

test('duplicate repair keeps the first text and timestamp', () => {
  const first = {who: 'agent', text: 'our loca\nl database', at: NOW, at_src: 'backfill'};
  const later = {who: 'agent', text: 'our local database', at: NOW + 3000, at_src: 'read'};
  const out = convDedupe([first, later]);
  assert.strictEqual(out.removed, 1);
  assert.deepStrictEqual(Array.from(out.entries), [first]);
});

test('a window with nothing an agent said in it writes no turn', () => {
  assert.deepStrictEqual(texts(turnMessages(paneMessages(['❯ just asked', '', '❯'], 'claude'))), []);
});

test('the comparison key is not the stored text', () => {
  // Collapsing whitespace is what the duplicate repair compares on; storing the collapsed form
  // would run Codex's three closing paragraphs together.
  const rows = ['❯ go', '', '⏺ First paragraph.', '', '  Second paragraph.', '', '❯'];
  const text = paneMessages(rows, 'claude')[1].text;
  assert.ok(text.includes('\n'), text);
  assert.strictEqual(convKey(text), 'First paragraph. Second paragraph.');
});

test('recording never mutates what it was given', () => {
  const stored = backfill(TWO_TURNS, NOW);
  const before = JSON.stringify(stored);
  turn(stored, TWO_TURNS, NOW + 3000, NOW + 2000);
  assert.strictEqual(JSON.stringify(stored), before);
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
  const tagged = tagUserEntries(backfill(rows, NOW + 5000), box, NOW + 5000).entries;
  assert.strictEqual(tagged[0].via, 'transfer');
  assert.strictEqual(tagged[0].from.label, 'Architect 1');
  // And what the agent said is never given a provenance: everything an agent says is its own.
  assert.strictEqual(tagged[1].via, undefined);
});

test('an unmatched prompt is typed, which is the honest failure', () => {
  // Provenance is only knowable where the send happened. A transfer made on the desktop and
  // recorded on the phone reads as typed there, because the phone never saw the transfer.
  const tagged = tagUserEntries(backfill(TWO_TURNS, NOW), [], NOW).entries;
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

test('the roster is capped far above the recording cap, and keeps ended members', () => {
  // MEMBER_MAX is a ceiling on how many panes record at once — a statement about the view. An
  // ended member costs a label and draws history, and a conversation continued across several
  // respawns collects them, so truncating the roster to MEMBER_MAX here would delete sessions that
  // happened on the next read of the index.
  const members = Array.from({length: 20}, (_, i) => ({key: 'local|w1:p' + i + '|claude|/work'}));
  const [conv] = parseConvIndex(index([{id: 'c1', name: 'auth', members: members}]));
  assert.strictEqual(conv.members.length, 20);
  assert.strictEqual(conv.name, 'auth');
  assert.ok(CONV_ROSTER_MAX > CONV_MEMBER_MAX);
});

test('a roster past even that ceiling is trimmed rather than dropping the conversation', () => {
  const members = Array.from({length: CONV_ROSTER_MAX + 5}, (_, i) => ({key: 'k' + i}));
  const [conv] = parseConvIndex(index([{id: 'c1', name: 'auth', members: members}]));
  assert.strictEqual(conv.members.length, CONV_ROSTER_MAX);
  assert.strictEqual(conv.members[0].key, 'k5', 'oldest ended sessions leave first');
  assert.strictEqual(conv.members.at(-1).key, 'k204', 'new live session stays recorded');
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

// The other half of the ceiling. `capEntries` keeps the newest, so the front of the union it trims
// is exactly where backfilled history lands — and a recovery that fed it an unfitted union would
// delete the history it just recovered, plus part of the record, in one statement.
const runOf = (n, tag) => Array.from({length: n}, (_, i) => ({who: 'agent', text: tag + i}));

test('a prepend takes the room left over and displaces nothing', () => {
  // 6 stored, 2 arriving, ceiling 10: two of the ten slots are spoken for by the append.
  const fitted = fitPrepend(runOf(30, 'old'), 6, 2, 10);
  assert.strictEqual(fitted.length, 2);
  // Its newest end, because the entry it joins is the transcript's current oldest and trimming the
  // other end would open a hole between them.
  assert.deepStrictEqual(fitted.map(e => e.text), ['old28', 'old29']);
});

test('a full transcript takes no prepend at all rather than shedding its record', () => {
  assert.strictEqual(fitPrepend(runOf(5, 'old'), 10, 0, 10).length, 0);
  // And over-full, which a lowered ceiling can produce out of a record written under a higher one.
  assert.strictEqual(fitPrepend(runOf(5, 'old'), 12, 1, 10).length, 0);
});

test('a prepend that fits is passed through whole, allocating nothing', () => {
  const before = runOf(3, 'old');
  assert.strictEqual(fitPrepend(before, 4, 1, 10), before);
});

test('what fits is never trimmed again by the cap it was fitted to', () => {
  // The pair as recordPaneNow composes it: fit, then concat, then cap. The second step must find
  // nothing left to do, or the fitting was for nothing.
  const before = runOf(30, 'old'), stored = runOf(6, 'kept'), add = runOf(2, 'new');
  const fitted = fitPrepend(before, stored.length, add.length, 10);
  const union = fitted.concat(stored, add);
  assert.strictEqual(union.length, 10);
  assert.strictEqual(capEntries(union, 10), union, 'the cap trims none of what was fitted');
});

test('an append at the ceiling still slides the window, as an ordinary turn does', () => {
  // Not an oversight: a recovered turn must not behave differently from a live one because the
  // words arrived late. Only the prepend is protected.
  const full = runOf(10, 'kept');
  const grown = capEntries([].concat(full, runOf(2, 'new')), 10);
  assert.deepStrictEqual(grown.slice(-2).map(e => e.text), ['new0', 'new1']);
  assert.strictEqual(grown[0].text, 'kept2', 'the oldest two left, as they always have');
});

// --- The deep window ---
//
// A pane read deeper than it has ever been recorded from holds turns nobody was connected for. The
// question is never "which of these look new" — that was the fold, and it lost — but "where in this
// window does the record's own newest message sit".
const FOUR_TURNS = [
  '❯ q1', '', '⏺ A1.', '',
  '❯ q2', '', '⏺ A2.', '',
  '❯ q3', '', '⏺ A3.', '',
  '❯ q4', '', '⏺ A4.', '',
  '❯',
];
const FIRST_TWO = FOUR_TURNS.slice(0, 8).concat(['❯']);
const LAST_TWO = FOUR_TURNS.slice(8);
const LATER = NOW + 600000;

test('a deeper window gives up the turns that ended while nobody was connected', () => {
  const stored = backfill(FIRST_TWO, NOW);
  const found = deepEntries(msgs(FOUR_TURNS), stored, LATER);
  assert.deepStrictEqual(texts(found.add), ['q3', 'A3.', 'q4', 'A4.']);
  assert.strictEqual(found.before.length, 0);
  assert.strictEqual(found.gap, false);
  // Nobody watched any of it happen, and the thread says so with a tilde rather than a clock.
  assert.ok(Array.from(found.add).every(e => e.at_src === 'backfill'));
  assert.ok(Array.from(found.add).every((e, i, all) => !i || convAt(all[i - 1]) < convAt(e)));
});

test('a window the record cannot be located in writes nothing and says a break happened', () => {
  // /clear, a scrollback shallower than the record, or an anchor whose text changed. All three
  // would be written twice by a guess, and the record is permanent.
  const stored = backfill(['❯ elsewhere', '', '⏺ Different pane entirely.', '', '❯'], NOW);
  const found = deepEntries(msgs(FOUR_TURNS), stored, LATER);
  assert.strictEqual(found.add.length, 0);
  assert.strictEqual(found.before.length, 0);
  assert.strictEqual(found.gap, true);
});

test('history above the first read is prepended, dated under what it joins', () => {
  // The pane was read late: the transcript starts mid-session and the scrollback above it is real.
  const stored = backfill(LAST_TWO, NOW);
  const found = deepEntries(msgs(FOUR_TURNS), stored, LATER);
  assert.deepStrictEqual(texts(found.before), ['q1', 'A1.', 'q2', 'A2.']);
  assert.strictEqual(found.add.length, 0, 'the anchor is the last thing in the window');
  // Ordering is all these stamps claim, and a joint thread sorts by them — dated `now` they would
  // sort after the history they were prepended to.
  assert.ok(Array.from(found.before).every(e => convAt(e) < convAt(stored[0])));
});

test('the same window twice is one recovery, without a watermark to stop it', () => {
  // What makes the manual button safe to bypass every gate: idempotence, not the guard.
  const stored = backfill(FIRST_TWO, NOW);
  const first = deepEntries(msgs(FOUR_TURNS), stored, LATER);
  const grown = stored.concat(Array.from(first.add));
  const again = deepEntries(msgs(FOUR_TURNS), grown, LATER + 1000);
  assert.strictEqual(again.add.length, 0);
  assert.strictEqual(again.before.length, 0);
  assert.strictEqual(again.gap, false);
});

test('an anchor said twice picks the occurrence that recovers less', () => {
  // Duplicating what is already recorded is the worse of the two wrongs, so the newest occurrence
  // wins on the append side and a short recovery is the price.
  const said = FOUR_TURNS.map(r => (r === '⏺ A3.' ? '⏺ A2.' : r));
  const found = deepEntries(msgs(said), backfill(FIRST_TWO, NOW), LATER);
  assert.deepStrictEqual(texts(found.add), ['q4', 'A4.']);
});

test('a prompt this app already committed is not recovered as well', () => {
  // The send wrote it with an exact clock before the pane was ever read at this depth; its echo in
  // the window is the same prompt.
  const stored = backfill(FIRST_TWO, NOW)
    .concat([{who: 'user', text: 'q3', at: NOW + 1, at_src: 'sent', seen: NOW + 1}]);
  const found = deepEntries(msgs(FOUR_TURNS), stored, LATER);
  assert.deepStrictEqual(texts(found.add), ['A3.', 'q4', 'A4.']);
});

test('nothing stored and nothing read are both nothing recovered', () => {
  assert.strictEqual(deepEntries(msgs(FOUR_TURNS), [], LATER).add.length, 0);
  assert.strictEqual(deepEntries([], backfill(FIRST_TWO, NOW), LATER).gap, false);
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

test('a transcript a named conversation holds is never evicted', () => {
  // The floor the whole model rests on: the record outliving the panes that wrote it is the
  // feature, so deleting one to stay under a ceiling is the failure it cannot absorb.
  const rec = (key, touched) => ({key: key, touched: touched});
  const all = [rec('a', 1), rec('b', 2), rec('c', 3)];
  assert.deepStrictEqual(dropped(all, new Set(['a', 'b', 'c']), 1, new Set(['a'])), ['b', 'c']);
});

test('a ceiling reached with everything named drops nothing at all', () => {
  const all = [{key: 'a', touched: 1}, {key: 'b', touched: 2}];
  assert.deepStrictEqual(dropped(all, new Set(['a', 'b']), 1, new Set(['a', 'b'])), []);
});

test('what nobody named goes before what only the recorder named', () => {
  // The tier split: auto conversations are book-keeping, and they are what stays evictable so
  // that recording by default cannot grow forever.
  const all = [{key: 'auto', touched: 1}, {key: 'loose', touched: 9}];
  assert.deepStrictEqual(dropped(all, new Set(['auto']), 1, new Set()), ['loose']);
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
