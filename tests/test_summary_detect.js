// Which lines of a finished pane are the agent's closing message.
//
// The fixtures are minimal, sanitized excerpts from panes read off a live herdr on 2026-08-11.
// A pane is mostly tool output, so what the parse has to get right is the boundary between the
// last command the agent ran and the last thing it said. Keeping only that shape avoids checking
// unrelated terminal history into the repository.
//
// Runs the block straight out of web/index.html so the single-file app keeps its no-build-step
// property, the same trick tests/test_attention.js uses.
//
//   node --test tests/test_summary_detect.js

const {test, beforeEach} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'summary_detect.js'), 'utf8');

// Everything the block reaches for and does not declare: the ruler's state, the pane it belongs
// to, and the store the trim is remembered in. The parse itself needs none of them.
const store = new Map();
const toasts = [];
let answer = true;                 // what the confirm dialog comes back with
const ctx = vm.createContext({
  console,
  activePane: null, paneOf: () => null, drawSel: () => {}, renderQuickActions: () => {},
  showToast: t => toasts.push(t), confirm: () => answer, scrollPaneToLine: () => {}, repaintHighlights: () => {},
  paneRows: [], selA: null, selB: null,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
});
vm.runInContext(SRC, ctx);
const find = (rows, agent) => ctx.findFinalMessage(rows, agent);
// The block's own state is declared with let, which is a lexical binding rather than a property
// of the context object, so it is read back the same way the browser specs read it: by evaluating
// the name in the context it lives in.
const val = expr => vm.runInContext(expr, ctx);

// What the user has learned so far is per test, not per pane — switching panes must not forget it.
beforeEach(() => {
  store.clear();
  vm.runInContext('gutterCache = null', ctx);   // the memo outlives localStorage otherwise
  toasts.length = 0;
  answer = true;
  vm.runInContext('selSuggested = false', ctx);
});

// A pane the user is looking at, with a range on it: what learnFromSelection reads.
function open(rows, agent, a = null, b = null) {
  ctx.paneRows = rows;
  ctx.activePane = 'p1';
  ctx.paneOf = () => ({agent, status: 'done'});
  ctx.selA = a;
  ctx.selB = b;
}

function fixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8').split('\n');
}

test('Claude: the closing block, with no tool results inside it', () => {
  const rows = fixture('pane_claude_done.txt');
  const at = find(rows, 'claude');
  assert.ok(at, 'expected a range');
  const [a, b] = at;
  assert.match(rows[a], /^⏺ Ready\. Name the change\./);
  assert.match(rows[b], /Hooks, permission rules, env vars/);
  const picked = rows.slice(a, b + 1);
  assert.ok(!picked.some(l => l.trimStart().startsWith('⎿')), 'tool result leaked into the range');
  assert.ok(!picked.some(l => l.startsWith('✻')), 'turn footer leaked into the range');
});

test('Codex: three paragraphs, blank lines kept, footer left out', () => {
  const rows = fixture('pane_codex_done.txt');
  const at = find(rows, 'codex');
  assert.ok(at, 'expected a range');
  const [a, b] = at;
  assert.match(rows[a], /^• S2b review clean\./);
  assert.match(rows[b], /^  Next: S3\./);
  const picked = rows.slice(a, b + 1);
  assert.ok(picked.some(l => l === ''), 'the blank lines between paragraphs were dropped');
  assert.ok(!picked.some(l => l.startsWith('─')), 'turn footer leaked into the range');
});

// Both fixtures end in a prompt line, which is what a live pane always looks like: the composer
// is the last thing in it. The glyphs are the ones read off real panes on 2026-08-11 — `❯` for
// Claude, `›` for Codex — so a harness that changes either breaks a test rather than a user.
test('the composer at the foot of a real pane is a prompt line', () => {
  const claude = fixture('pane_claude_done.txt'), codex = fixture('pane_codex_done.txt');
  assert.equal(ctx.isUserInput(claude[11], 'claude'), true, claude[11]);
  assert.equal(ctx.isUserInput(codex[13], 'codex'), true, codex[13]);
  // And no line of tool output in either one is mistaken for one.
  assert.equal(claude.filter(r => ctx.isUserInput(r, 'claude')).length, 1);
  assert.equal(codex.filter(r => ctx.isUserInput(r, 'codex')).length, 1);
});

// OpenCode is the harness with one gutter for everything: the user's messages, every tool block
// and the composer box all sit behind `┃`. These three cases are the ones a line-at-a-time rule
// got wrong on a real pane, so each is checked against the whole run the line belongs to.
test('OpenCode: only the user’s own lines are read as input', () => {
  const rows = fixture('pane_opencode_done.txt');
  const inputs = rows.filter((row, i) => ctx.isUserInput(row, 'opencode', rows, i));
  assert.deepEqual(inputs, [
    '  ┃  List out the last 10 commits in this repo',
    '  ┃  Explain the goal of last commit',
    '  ┃  Let’s explore the details of last commit',
  ]);
  assert.deepEqual(Array.from(ctx.userInputLines(rows, 'opencode')).map(i => rows[i]), inputs);
});

test('OpenCode: the composer is a `┃` run too, and is not the user talking', () => {
  // The box at the foot is drawn with the prompt's own glyph and holds the model name. It is the
  // last `┃` run in every live pane, so reading it as input would make it the newest prompt —
  // and on the harnesses that do have a composer glyph, the newest prompt is what Summary works
  // back from. `╹` is the box's bottom-left corner and appears nowhere else.
  const rows = fixture('pane_opencode_done.txt');
  const composer = rows.findIndex(r => r.includes('Build · GPT-OSS-120B Nvidia'));
  assert.ok(composer > 0);
  assert.equal(ctx.isUserInput(rows[composer], 'opencode', rows, composer), false);
});

test('OpenCode: a read that starts inside a tool block claims nothing', () => {
  // 200 lines off the foot of a long pane routinely begins mid-block, with the `$` that opened it
  // above the window. Nothing above then says "not yours", and guessing "yours" painted a file
  // listing as though the user had typed it.
  const rows = fixture('pane_opencode_done.txt');
  const cut = rows.findIndex(r => r.startsWith('  ┃  f1762cb'));
  const window = rows.slice(cut);
  const claimed = window.filter((row, i) => ctx.isUserInput(row, 'opencode', window, i));
  // The severed block gives up nothing; the whole prompt further down is still found, because a
  // window that loses one opener has not lost the rest of the pane.
  assert.deepEqual(claimed, ['  ┃  Let’s explore the details of last commit']);
});

test('OpenCode: no message boundary is guessed, and nothing offers to step through one', () => {
  // Its reasoning and its answer are both plain prose at the same indent, and it prints nothing in
  // column 0 for a block to start on. Summary and the ↓↑ pill are off by declaration rather than
  // by finding nothing, which is what keeps ↑ from asking for more history on every press.
  const rows = fixture('pane_opencode_done.txt');
  assert.equal(find(rows, 'opencode'), null);
  assert.deepEqual(ctx.turnSummaries(rows, 'opencode'), []);
  assert.equal(ctx.profileFor('opencode').messages, false);
});

// pi is the one harness whose gutter is not its own: extensions/pi/herdr-gutter.ts puts the
// glyphs there, and pi indents its whole transcript by one space, so they land in column 1. Its
// wrapped lines are *not* hang-indented — a continuation sits in the same column as a glyph — so
// the block-end rule has to be the glyph set rather than the indent.
test('pi: the closing message, read through the extension gutter', () => {
  const rows = fixture('pane_pi_done.txt');
  const at = find(rows, 'pi');
  assert.ok(at, 'expected a range');
  const [a, b] = at;
  assert.match(rows[a], /^ ⏺ Here's a breakdown/);
  assert.match(rows[b], /^ Nothing else changed\./);
  const picked = rows.slice(a, b + 1);
  assert.ok(picked.some(l => l.startsWith(' ### ')), 'a heading in column 1 ended the block early');
  assert.ok(picked.some(l => l.startsWith(' │ File')), 'a table row in column 1 ended the block early');
  assert.ok(!picked.some(l => l.startsWith('~/')), 'the status line leaked into the range');
});

test('pi: the request is a prompt, the reasoning above the reply is not', () => {
  const rows = fixture('pane_pi_done.txt');
  assert.equal(ctx.isUserInput(rows[0], 'pi'), true, rows[0]);
  assert.equal(rows.filter(r => ctx.isUserInput(r, 'pi')).length, 1);
  // The blue rule covers the request alone. Without the reasoning glyph it would run on down
  // through pi's thinking, which is the whole reason the extension marks it.
  assert.deepEqual(Array.from(ctx.userInputLines(rows, 'pi')), [0]);
});

// pi's composer is a box the extension cannot reach, so unlike claude and codex there is no prompt
// glyph below the newest reply to bound it.
test('pi: the newest turn is the one below the last request', () => {
  const rows = fixture('pane_pi_done.txt');
  assert.deepEqual(ctx.turnSummaries(rows, 'pi'), [find(rows, 'pi')]);
});

test('pi: a reply followed by a command is not the closing message', () => {
  const rows = [
    ' ⏺ Checking the tree first.',
    '',
    ' $ git status --short',
    ' M web/index.html',
    '',
    ' Took 0.0s',
  ];
  assert.equal(find(rows, 'pi'), null);
});

// agy is the harness with no speaker glyph at all. It marks the user (`>`), its tool calls (`●`),
// its reasoning (`▸`) and its turn rules in column 0, and leaves the reply as plain prose two
// columns in — so a message is identified by position: the first indented line after one of those
// markers.
test('agy: the closing message, which carries no glyph', () => {
  const rows = fixture('pane_agy_done.txt');
  assert.deepEqual(find(rows, 'agy'), [37, 37]);
  assert.equal(rows[37], '  OK');
});

test('agy: a message opens under a marker, and the startup banner is not one', () => {
  const rows = fixture('pane_agy_done.txt');
  assert.deepEqual(ctx.turnSummaries(rows, 'agy'), [[12, 17], [26, 32], [37, 37]]);
  // The banner is five indented lines under the shell command that launched agy. Nothing agy
  // printed opens it, so it is not a message — without that rule it takes an orange mark.
  assert.equal(ctx.blockContaining(rows, 'agy', 4), null);
  // A reply under a tool call and a reply under a reasoning header are both messages.
  assert.match(rows[12], /^  Here is a summary/);
  assert.match(rows[26], /^  Formulating The Response/);
});

test('agy: the request is ruled, and the reply below it is not', () => {
  const rows = fixture('pane_agy_done.txt');
  assert.deepEqual(Array.from(ctx.userInputLines(rows, 'agy')), [8, 21, 35, 40]);
  // The blank line between `> say only the word OK` and `  OK` must not carry the rule into the
  // reply — nothing in column 0 separates them, so only the block start does.
  assert.equal(ctx.userInputLines(rows, 'agy').has(37), false);
});

test("agy: its own footer is not something it said", () => {
  // Read off a live pane on 2026-08-22. agy right-aligns a model and credit line under a rule at
  // the foot of the pane, and a positional harness reads any indented line under a column-0 line
  // as the start of a message. So a turn where agy had not answered yet was read as agy saying
  // `Gemini 3.7 Flash · medium · AI: Out of credits`. Ported from
  // tests/test_pane_summary.py::test_agys_own_footer_is_not_a_message.
  const rows = ['────────────────────', '> review the change', '', '  Looks good to me.', '',
                '────────────────────', '>', '', '',
                '                    Gemini 3.7 Flash · medium · AI: Out of credits'];
  assert.deepEqual(find(rows, 'agy'), [3, 3]);
  assert.deepEqual(ctx.messageBlocks(rows, 'agy'), [[3, 3]]);
  assert.equal(ctx.userInputLines(rows, 'agy').has(9), false, 'nor something the user typed');
});

// agy wraps its own lines, on both sides of the transcript, and each wrap breaks the positional
// rule in its own way. A tool call too long for the pane continues in column 0 with no glyph on
// it, so the marker above the closing message is two lines up rather than one; a prompt too long
// for the pane continues *indented*, which is the exact shape of a reply. Read off the live panes
// `AGY3.7- arch` and `Agy - Architect 5` on 2026-08-14, where the closing summary of a long run
// was the message being missed.
test('agy: a wrapped tool call still opens the message under it', () => {
  const rows = fixture('pane_agy_wrapped.txt');
  assert.equal(rows[5], 'expand)');            // the continuation, in column 0 and not a marker
  assert.deepEqual(find(rows, 'agy'), [7, 9]);
  assert.deepEqual(ctx.turnSummaries(rows, 'agy'), [[7, 9]]);
});

test('agy: the second line of a wrapped prompt is the user, not a reply', () => {
  const rows = fixture('pane_agy_wrapped.txt');
  assert.deepEqual(Array.from(ctx.userInputLines(rows, 'agy')), [1, 2, 12]);
  assert.equal(ctx.blockContaining(rows, 'agy', 2), null);
});

test('agy: a request answered with a command alone has no closing message', () => {
  const rows = [
    '────────────────────',
    '> check the tree',
    '',
    '● Bash(git status --short) (ctrl+o to expand)',
    '',
    '────────────────────',
    '>',
  ];
  assert.equal(find(rows, 'agy'), null);
});

test('a pane whose last block ran a tool has nothing to offer', () => {
  const rows = [
    '⏺ Committed as dd51cea.',
    '',
    '⏺ Bash(git status --short)',
    '  ⎿  M web/index.html',
    '',
  ];
  assert.equal(find(rows, 'claude'), null);
  // Same shape in the other harness's gutter.
  assert.equal(find(['• Done.', '', '• Ran npm test', '  └ 19 passed'], 'codex'), null);
});

test('an unknown harness is never guessed at', () => {
  const rows = ['◆ All finished.', '  and here is why'];
  assert.equal(find(rows, 'amp'), null);
  assert.equal(find(rows, undefined), null);
  assert.equal(find(rows, 'claude'), null);   // right harness named, wrong glyphs present
});

test('a block runs to the next line with anything in column 0', () => {
  const rows = [
    '⏺ First message.',
    '⏺ Second message.',
    '  with a continuation',
    '',
    '  and a second paragraph',
    '',
    '✻ Worked for 3s',
    '',
    '❯ next prompt',
  ];
  assert.deepEqual(find(rows, 'claude'), [1, 4]);
});

test('the glyph line alone is a valid range', () => {
  assert.deepEqual(find(['⏺ Bash(x)', '  ⎿  y', '', '⏺ Done.'], 'claude'), [3, 3]);
});

test('the latest user prompt bounds the completed turn above it', () => {
  const rows = [
    '⏺ Older summary.', '', '❯ first request',
    '⏺ Previous summary.', '  ready to transfer.', '',
    '❯ please start the next task',
    '⏺ New work is underway.',
  ];
  assert.deepEqual(find(rows, 'claude'), [3, 4]);
});

test('empty and malformed input do not throw', () => {
  assert.equal(find([], 'claude'), null);
  assert.equal(find([''], 'claude'), null);
  assert.equal(find(null, 'claude'), null);
});

// --- what the user trims off it ---
//
// The block runs from the speaker glyph to the last line with anything on it. The trim is what
// the user takes off either end of that, learned from the transfers they actually send.

const BLOCK = ['⏺ Bash(x)', '  ⎿  y', '', '⏺ Here is what I did.', '', '  A change.', '', ''];
const scan = () => { ctx.scanFinalMessage(); return val('finalAt'); };

test('the range as parsed: whole block, no trailing blanks', () => {
  open(BLOCK, 'claude');
  assert.deepEqual(scan(), [3, 5]);
});

test('a transfer teaches the trim, and the next read arrives already trimmed', () => {
  open(BLOCK, 'claude', 5, 5);       // user kept only the last line of the message
  ctx.scanFinalMessage();
  ctx.learnFromSelection();
  open(BLOCK, 'claude');
  assert.deepEqual(scan(), [5, 5]);
});

test('an untouched suggestion teaches no 0/0 trim', () => {
  open(BLOCK, 'claude', 3, 5);
  vm.runInContext('selSuggested = true', ctx);
  assert.equal(ctx.learnFromSelection(), null);
  open(BLOCK, 'claude');
  assert.deepEqual(scan(), [3, 5]);
});

test('a trim that lands on a blank line keeps walking', () => {
  open(BLOCK, 'claude');
  ctx.noteTrim('claude', 1, 0);      // index 4, which is blank
  assert.deepEqual(scan(), [5, 5]);
});

test('the trim is per harness', () => {
  open(BLOCK, 'claude', 5, 5);
  ctx.scanFinalMessage();
  ctx.learnFromSelection();
  open(['• Said a thing.', '  and another'], 'codex');
  assert.deepEqual(scan(), [0, 1], "claude's trim left codex alone");
});

test('a selection outside the block teaches nothing', () => {
  open(BLOCK, 'claude', 0, 1);       // the tool block above it, not the message
  ctx.scanFinalMessage();
  ctx.learnFromSelection();
  open(BLOCK, 'claude');
  assert.deepEqual(scan(), [3, 5]);
});

test('a trim that would leave nothing keeps the block whole', () => {
  open(BLOCK, 'claude');
  ctx.noteTrim('claude', 9, 9);
  assert.deepEqual(scan(), [3, 5]);
});

test('a corrupt or stale store is no trim, never a broken pane', () => {
  open(BLOCK, 'claude');
  store.set('herdr_summary_trim', '{not json');
  assert.deepEqual(scan(), [3, 5]);
  store.set('herdr_summary_trim', JSON.stringify({version: 0, byAgent: {claude: {'2,0': 9}}}));
  assert.deepEqual(scan(), [3, 5], 'a trim written by an older shape is ignored');
});

// --- stepping between messages ---
//
// A different question from "which is the closing one": here a tool block is passed over rather
// than stopped on, because the user is walking the conversation and a command is not part of it.

const CHAT = [
  '⏺ First thing I said.',
  '',
  '⏺ Bash(git status)',
  '  ⎿  clean',
  '',
  '⏺ Second thing I said.',
  '  over two lines',
  '',
  '✻ Worked for 3s',
];

test('previous walks up past tool blocks', () => {
  assert.deepEqual(ctx.blockBefore(CHAT, 'claude', CHAT.length), [5, 6]);
  assert.deepEqual(ctx.blockBefore(CHAT, 'claude', 5), [0, 0], 'the tool block in between is skipped');
  assert.equal(ctx.blockBefore(CHAT, 'claude', 0), null, 'nothing above the first');
});

test('next walks down the same way', () => {
  assert.deepEqual(ctx.blockAfter(CHAT, 'claude', 0), [0, 0]);
  assert.deepEqual(ctx.blockAfter(CHAT, 'claude', 1), [5, 6]);
  assert.equal(ctx.blockAfter(CHAT, 'claude', 6), null, 'nothing below the last');
});

// A conversation with prompts in it: two turns, each with a tool block and chatter before the
// message that actually answers. Stepping must land on the answers, not on the chatter.
const TURNS = [
  '⏺ Starting on it.',            // 0
  '',
  '⏺ Bash(git status)',
  '  ⎿  clean',
  '⏺ Nothing to commit, so here is the plan.',   // 4  <- turn 1's closing message
  '',
  '❯ go ahead',                   // 6
  '⏺ Working.',                   // 7
  '',
  '⏺ Done: two files changed.',   // 9  <- turn 2's closing message
  '  and the tests pass',         // 10
  '',
  '❯ ',                           // 12  the composer, always the last line of a live pane
];

test('a turn is one entry, taken from just above each prompt', () => {
  assert.deepEqual(ctx.turnSummaries(TURNS, 'claude'), [[4, 4], [9, 10]]);
  assert.deepEqual(ctx.turnSummaries(CHAT, 'claude'), [], 'no prompt gutter, no turns');
});

test('stepping walks turns, not every block the agent emitted', () => {
  open(TURNS, 'claude');
  ctx.scanFinalMessage();
  ctx.stepBlock(-1);
  assert.deepEqual([ctx.selA, ctx.selB], [9, 10], 'the newest turn, not `⏺ Working.` above it');
  ctx.stepBlock(-1);
  assert.deepEqual([ctx.selA, ctx.selB], [4, 4], 'past the whole of turn 1 in one press');
  ctx.stepBlock(1);
  assert.deepEqual([ctx.selA, ctx.selB], [9, 10]);
});

// What is on screen is the trimmed range; what stepping compares against is block starts. A trim
// of even one line puts the selection's start inside its own block, and comparing the two directly
// made `previous` land on the block it was already on and `next` find nothing past it — stepping
// wedged on the newest turn, which Summary could still select.
test('a learned trim does not wedge stepping', () => {
  open(TURNS, 'claude');
  ctx.noteTrim('claude', 1, 0);
  ctx.scanFinalMessage();
  ctx.selectFinalMessage();
  assert.deepEqual([ctx.selA, ctx.selB], [10, 10], 'the newest turn, trimmed');
  ctx.stepBlock(-1);
  assert.deepEqual([ctx.selA, ctx.selB], [4, 4], 'previous moved off it');
  ctx.stepBlock(1);
  assert.deepEqual([ctx.selA, ctx.selB], [10, 10], 'and next came back to it');
});

// The same mix-up in the branch taken by a harness with no prompt gutter, where stepping walks
// blocks rather than turns.
test('a learned trim does not wedge block stepping either', () => {
  open(CHAT, 'claude');
  ctx.noteTrim('claude', 1, 0);
  ctx.scanFinalMessage();
  ctx.selectFinalMessage();
  assert.deepEqual([ctx.selA, ctx.selB], [6, 6]);
  ctx.stepBlock(-1);
  assert.deepEqual([ctx.selA, ctx.selB], [0, 0]);
  ctx.stepBlock(1);
  assert.deepEqual([ctx.selA, ctx.selB], [6, 6]);
});

test('every turn is marked, not only the newest one', () => {
  open(TURNS, 'claude');
  ctx.scanFinalMessage();
  assert.deepEqual(Array.from(ctx.summaryRows(TURNS, 'claude')), [4, 9, 10]);
  // Trimmed the way the user trims: the mark and the range ↑ selects are the same lines.
  ctx.noteTrim('claude', 1, 0);
  assert.deepEqual(Array.from(ctx.summaryRows(TURNS, 'claude')), [4, 10]);
});

test('with no prompt gutter there is one mark: the final message', () => {
  open(CHAT, 'claude');
  ctx.scanFinalMessage();
  assert.deepEqual(Array.from(ctx.summaryRows(CHAT, 'claude')), [5, 6]);
});

test('the block a line sits in, and the lines that sit in none', () => {
  assert.deepEqual(ctx.blockContaining(CHAT, 'claude', 6), [5, 6], 'a continuation line');
  assert.deepEqual(ctx.blockContaining(CHAT, 'claude', 5), [5, 6], 'the glyph line itself');
  assert.equal(ctx.blockContaining(CHAT, 'claude', 3), null, 'inside a tool block');
  assert.equal(ctx.blockContaining(CHAT, 'claude', 8), null, 'the turn footer');
});

// --- an unknown harness, taught by one selection ---

const OTHER = ['◆ Ran the build', '  compiled', '', '◆ All finished.', '  and here is why'];

test('an unknown harness is inert until it is taught', () => {
  open(OTHER, 'amp');
  assert.equal(scan(), null);
  assert.equal(ctx.blockBefore(OTHER, 'amp', OTHER.length), null);
});

test('Learn takes the marker off the line the selection starts on', () => {
  open(OTHER, 'amp', 3, 4);
  assert.equal(ctx.learnGutter('amp'), true);
  assert.deepEqual(ctx.profileFor('amp'), { speaker: '◆', result: [] });
  assert.deepEqual(scan(), [3, 4]);
  assert.deepEqual(ctx.blockBefore(OTHER, 'amp', 3), [0, 1], 'and navigation works from then on');
});

test('a declined confirmation stores nothing', () => {
  open(OTHER, 'amp', 3, 4);
  answer = false;
  assert.equal(ctx.learnGutter('amp'), false);
  assert.equal(scan(), null);
});

test('a letter in column 0 is prose and is refused', () => {
  open(['Summary of the work', '  and the rest'], 'amp', 0, 1);
  assert.equal(ctx.learnGutter('amp'), false);
  assert.match(toasts[0], /marker/);
  open(['  indented, so no marker at all'], 'amp', 0, 0);
  assert.equal(ctx.learnGutter('amp'), false);
});

test('a learned harness never suggests on its own', () => {
  open(OTHER, 'amp', 3, 4);
  ctx.learnGutter('amp');
  ctx.selA = ctx.selB = null;
  vm.runInContext('suggestedKey = ""', ctx);
  ctx.scanFinalMessage();
  ctx.suggestFinalMessage();
  assert.equal(ctx.selA, null, 'no result glyph means no way to tell a command from a sentence');
  // Asking is different from being told: Summary still selects it.
  ctx.selectFinalMessage();
  assert.deepEqual([ctx.selA, ctx.selB], [3, 4]);
});

test('the most-confirmed trim wins, ties use the latest explicit trim', () => {
  open(BLOCK, 'claude');
  ctx.noteTrim('claude', 3, 0);
  ctx.noteTrim('claude', 3, 0);
  ctx.noteTrim('claude', 1, 0);
  assert.deepEqual(ctx.learnedTrim('claude'), [3, 0]);
  ctx.noteTrim('claude', 1, 0);
  assert.deepEqual(ctx.learnedTrim('claude'), [1, 0], 'tied at two each, so the later trim wins');
});

test('known prompt gutters identify user input at column zero', () => {
  assert.equal(ctx.isUserInput('❯ allow it', 'claude'), true);
  assert.equal(ctx.isUserInput('> allow it', 'claude'), true);
  assert.equal(ctx.isUserInput('› continue', 'codex'), true);
  assert.equal(ctx.isUserInput(' > indented', 'claude'), false);
});

test('a prompt rule covers its continuation and stops at the last line with text', () => {
  const rows = ['❯ inspect this', '  with both files', '', '⏺ I found it.', '  details'];
  assert.deepEqual(Array.from(ctx.userInputLines(rows, 'claude')), [0, 1]);
  // A blank inside the turn is kept: the rule must not break in the middle of one message.
  const gapped = ['❯ first line', '', '  second line', '', '⏺ Answer.'];
  assert.deepEqual(Array.from(ctx.userInputLines(gapped, 'claude')), [0, 1, 2]);
});
