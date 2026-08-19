// The live record's delta sync, in the shape the wire actually has it.
//
// The cache is per pane fingerprint and the query is per roster, and those two do not line up: one
// question covers several panes, and the answer to it says something about every one of them —
// including the ones it returned no rows for. Getting that wrong is not visible as a wrong bubble,
// which is why it needs a test rather than an eye. The failures below are the ones a plausible
// implementation ships with:
//
//   - a watermark taken from a pane's newest turn rather than from what it was answered through,
//     so a quiet pane is never warm and re-asks for its whole window every five seconds;
//   - a watermark taken as the max over the roster instead of the min, so a pane synced by an
//     older question has the rows between the two watermarks skipped forever;
//   - a bucket that grows without a ceiling across the deltas, so a tab left open all day keeps
//     every turn a pane ever produced.
//
//   node --test tests/test_conv_live_sync.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const src = f => fs.readFileSync(path.join(__dirname, '..', 'web', 'src', f), 'utf8');

// The socket this block writes to, kept so a test can read the question it asked.
const sent = [];
const store = {herdr_conv_live: 'on'};

const ctx = vm.createContext({
  console,
  localStorage: {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }},
  ws: {readyState: 1, send: s => sent.push(JSON.parse(s))},
  renderConvView: () => {}, renderConvStandalone: () => {}, hangSync: () => {}, showToast: () => {},
  escapeHtml: s => String(s),
  // The roster key builder, in the one spelling the rest of the app uses.
  convMemberKey: a => JSON.stringify([a.host || '', a.pane_id || '', a.agent || '', a.cwd || '']),
  // The live roster. A row is scoped to a pane by who is on it, so the tests below set it.
  agents: [],
});

const NAMES = ['convLiveFetch', 'convLiveReceive', 'convLiveEntries', 'convLiveInvalidate',
               'convLiveEmptyHtml', 'convLiveCache', 'convFpKey', 'convGitHtml',
               'CONV_LIVE_ROWS', 'CONV_LIVE_EVERY'];
vm.runInContext(src('conv_live.js') + `\n;__out = {${NAMES.join(', ')}};`, ctx);
const {convLiveFetch, convLiveReceive, convLiveEntries, convLiveInvalidate,
       convLiveEmptyHtml, convLiveCache, convFpKey, convGitHtml,
       CONV_LIVE_ROWS, CONV_LIVE_EVERY} = ctx.__out;

const KEY_A = JSON.stringify(['local', '%1', 'claude', '/work/a']);
const KEY_B = JSON.stringify(['local', '%2', 'codex', '/work/b']);
const FP_A = ['local', 'claude', '/work/a'];
const FP_B = ['local', 'codex', '/work/b'];

const turn = (seq, fp, at, text) => ({
  seq, host: fp[0], agent: fp[1], cwd: fp[2], at, text, kind: 'agent_turn', at_src: 'state',
  pane_id: fp === FP_A ? '%1' : '%2',
});

function reset(roster) {
  sent.length = 0;
  convLiveCache.clear();
  ctx.agents.length = 0;
  for (const a of (roster || [])) ctx.agents.push(a);
}

// The question the block last put on the wire.
const asked = () => sent[sent.length - 1];

test('the first question over a roster asks for the window, not a delta', () => {
  reset();
  convLiveFetch([KEY_A, KEY_B]);
  assert.equal(sent.length, 1);
  assert.equal(asked().since_id, undefined);
  assert.deepEqual(asked().fingerprints, [FP_A, FP_B]);
  assert.equal(asked().last, CONV_LIVE_ROWS);
});

test('a pane the answer said nothing about is still current through it', () => {
  reset();
  convLiveFetch([KEY_A, KEY_B]);
  // Only A has said anything. B is proven empty up to id 7 all the same — the query covered it.
  convLiveReceive({fingerprints: [FP_A, FP_B], turns: [turn(7, FP_A, 1000, 'hello')]});
  convLiveInvalidate();
  convLiveFetch([KEY_A, KEY_B]);
  assert.equal(asked().since_id, 7, 'a quiet pane must not drag the roster back to a full window');
});

test('a member joining a roster makes the question whole again', () => {
  reset();
  // A was answered on its own, and is ahead. B has never been asked about, so nothing is known
  // about what it has below A's watermark — asking for a delta from A's id would skip all of it.
  convLiveFetch([KEY_A]);
  convLiveReceive({fingerprints: [FP_A], turns: [turn(90, FP_A, 1000, 'a')]});
  convLiveInvalidate();
  convLiveFetch([KEY_A, KEY_B]);
  assert.equal(asked().since_id, undefined, 'a member with no bucket makes the question whole');

  // The window answers for both, so both are current through the highest id it carried.
  convLiveReceive({fingerprints: [FP_A, FP_B],
                   turns: [turn(40, FP_B, 900, 'b'), turn(90, FP_A, 1000, 'a')]});
  convLiveInvalidate();
  convLiveFetch([KEY_A, KEY_B]);
  assert.equal(asked().since_id, 90);
});

test('the watermark is the floor over the roster, never the ceiling', () => {
  reset();
  // Two questions, answered to different depths: A through 90, B only through 40. Resuming from
  // the ceiling would skip whatever B has between 41 and 90; the floor re-reads and dedupes.
  convLiveFetch([KEY_A]);
  convLiveReceive({fingerprints: [FP_A], turns: [turn(90, FP_A, 1000, 'a')]});
  convLiveFetch([KEY_B]);
  convLiveReceive({fingerprints: [FP_B], turns: [turn(40, FP_B, 900, 'b')]});
  convLiveInvalidate();
  convLiveFetch([KEY_A, KEY_B]);
  assert.equal(asked().since_id, 40);
});

test('the cadence holds the question back, and invalidating lets it through', () => {
  reset();
  convLiveFetch([KEY_A]);
  convLiveReceive({fingerprints: [FP_A], turns: [turn(1, FP_A, 1000, 'a')]});
  convLiveFetch([KEY_A]);
  assert.equal(sent.length, 1, 'a second render inside the cadence asks nothing');
  convLiveInvalidate();
  convLiveFetch([KEY_A]);
  assert.equal(sent.length, 2);
});

test('a forced ask is for the record, not the difference', () => {
  reset();
  convLiveFetch([KEY_A]);
  convLiveReceive({fingerprints: [FP_A], turns: [turn(5, FP_A, 1000, 'a')]});
  convLiveFetch([KEY_A], true);
  assert.equal(asked().since_id, undefined);
});

test('a delta lands in the bucket the row belongs to, and a repeat is not drawn twice', () => {
  reset();
  convLiveFetch([KEY_A, KEY_B]);
  convLiveReceive({fingerprints: [FP_A, FP_B], turns: [turn(1, FP_A, 1000, 'first')]});
  convLiveReceive({fingerprints: [FP_A, FP_B],
                   turns: [turn(1, FP_A, 1000, 'first'), turn(2, FP_B, 1100, 'second')]});
  const texts = convLiveEntries([KEY_A, KEY_B]).map(e => e.text);
  assert.deepEqual(texts, ['first', 'second']);
});

test('one pane in two conversations is fetched once and drawn in both', () => {
  reset();
  convLiveFetch([KEY_A, KEY_B]);
  convLiveReceive({fingerprints: [FP_A, FP_B],
                   turns: [turn(1, FP_A, 1000, 'from a'), turn(2, FP_B, 1100, 'from b')]});
  sent.length = 0;
  // A second conversation holding only A draws with no question at all.
  assert.deepEqual(convLiveEntries([KEY_A]).map(e => e.text), ['from a']);
  convLiveFetch([KEY_A]);
  assert.equal(sent.length, 0);
});

test('a bucket keeps the same ceiling one query carries', () => {
  reset();
  convLiveFetch([KEY_A]);
  for (let i = 1; i <= CONV_LIVE_ROWS + 50; i++) {
    convLiveReceive({fingerprints: [FP_A], turns: [turn(i, FP_A, 1000 + i, `m${i}`)]});
  }
  const bucket = convLiveCache.get(convFpKey(FP_A));
  assert.equal(bucket.turns.length, CONV_LIVE_ROWS);
  // The newest end is what survives, which is what the reader is looking at.
  assert.equal(bucket.turns[bucket.turns.length - 1].text, `m${CONV_LIVE_ROWS + 50}`);
});

test('the thread interleaves its members by time, not by which bucket they sat in', () => {
  reset();
  convLiveFetch([KEY_A, KEY_B]);
  convLiveReceive({fingerprints: [FP_A, FP_B], turns: [
    turn(1, FP_A, 3000, 'third'), turn(2, FP_B, 1000, 'first'), turn(3, FP_A, 2000, 'second')]});
  assert.deepEqual(convLiveEntries([KEY_A, KEY_B]).map(e => e.text), ['first', 'second', 'third']);
  // And each row is drawn as its own member, so the standalone view picks the right column.
  assert.deepEqual(convLiveEntries([KEY_A, KEY_B]).map(e => e.member), [1, 0, 0]);
});

test('a question in flight is not an empty record', () => {
  reset();
  convLiveFetch([KEY_A]);
  assert.match(convLiveEmptyHtml([KEY_A]), /Reading the relay/);
  convLiveReceive({fingerprints: [FP_A], turns: []});
  assert.match(convLiveEmptyHtml([KEY_A]), /recorded nothing/);
});

// --- "Show this pane only" is a pane, not an agent ---
//
// A bucket is keyed by fingerprint — [host, agent, cwd] with the pane id taken out, because that
// is what survives the restart herdr renumbers every pane on. Two panes running claude in one
// directory therefore share a bucket, and reading a solo thread straight off it filters the record
// by *agent*: the reader asks for one pane and gets every claude in that directory.

const KEY_A2 = JSON.stringify(['local', '%9', 'claude', '/work/a']);   // same fingerprint as KEY_A
const paneTurn = (seq, paneId, at, text) => Object.assign(
  turn(seq, FP_A, at, text), {pane_id: paneId});

test('a solo thread is this pane, not every pane running the same agent here', () => {
  reset([{host: 'local', pane_id: '%1', agent: 'claude', cwd: '/work/a'},
         {host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  convLiveFetch([KEY_A]);
  convLiveReceive({fingerprints: [FP_A], turns: [
    paneTurn(1, '%1', 1000, 'mine'), paneTurn(2, '%9', 1100, 'the other pane')]});
  assert.deepEqual(convLiveEntries([KEY_A]).map(e => e.text), ['mine']);
  assert.deepEqual(convLiveEntries([KEY_A2]).map(e => e.text), ['the other pane']);
});

test('a joint thread gives each member its own rows out of the one bucket', () => {
  reset([{host: 'local', pane_id: '%1', agent: 'claude', cwd: '/work/a'},
         {host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  convLiveFetch([KEY_A, KEY_A2]);
  convLiveReceive({fingerprints: [FP_A], turns: [
    paneTurn(1, '%1', 1000, 'mine'), paneTurn(2, '%9', 1100, 'theirs')]});
  const entries = convLiveEntries([KEY_A, KEY_A2]);
  assert.deepEqual(entries.map(e => e.text), ['mine', 'theirs']);
  // And on the right side of the thread: each row is its own member, not both the first.
  assert.deepEqual(entries.map(e => e.member), [0, 1]);
});

test('a pane that has exited leaves its history to whoever holds the fingerprint', () => {
  // The restart case the fingerprint exists for: %1 is gone and %9 is the same work respawned.
  reset([{host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  convLiveFetch([KEY_A2]);
  convLiveReceive({fingerprints: [FP_A], turns: [
    paneTurn(1, '%1', 1000, 'before the restart'), paneTurn(2, '%9', 1100, 'after it')]});
  assert.deepEqual(convLiveEntries([KEY_A2]).map(e => e.text),
                   ['before the restart', 'after it']);
});

// --- Where the work landed ---
//
// The record carries a branch, the commit a turn was read at, and the commits that appeared since
// the previous turn in that directory. None of it is worth anything if the thread drops it between
// the wire and the bubble, which is the whole of what these check.

test('a turn carries its branch and its commits into the thread', () => {
  reset([KEY_A]);
  const t = turn(1, FP_A, 100, 'refactored the parser');
  t.branch = 'feat/parser';
  t.commit = 'a'.repeat(40);
  t.commits = [{sha: 'b'.repeat(40), subject: 'split the tokenizer out'}];
  convLiveReceive({turns: [t], fingerprints: [FP_A]});
  const [entry] = convLiveEntries([KEY_A]);
  assert.equal(entry.branch, 'feat/parser');
  assert.equal(entry.commit, 'a'.repeat(40));
  assert.deepEqual(entry.commits, [{sha: 'b'.repeat(40), subject: 'split the tokenizer out'}]);
});

test('a turn recorded outside a checkout carries nothing rather than undefined', () => {
  // The thread reads these on every bubble. `undefined` here is a footer that says "undefined".
  reset([KEY_A]);
  convLiveReceive({turns: [turn(1, FP_A, 100, 'said something')], fingerprints: [FP_A]});
  const [entry] = convLiveEntries([KEY_A]);
  assert.equal(entry.branch, '');
  assert.equal(entry.commit, '');
  assert.deepEqual(entry.commits, []);
});

test('a commits field that is not a list is not trusted', () => {
  // It comes off a wire. A string here would be rendered one character per commit.
  reset([KEY_A]);
  const t = turn(1, FP_A, 100, 'said something');
  t.commits = 'not a list';
  convLiveReceive({turns: [t], fingerprints: [FP_A]});
  assert.deepEqual(convLiveEntries([KEY_A])[0].commits, []);
});

test('the footer names the branch and shortens the sha', () => {
  const html = convGitHtml({branch: 'feat/parser', commit: 'a'.repeat(40),
                            commits: [{sha: 'b'.repeat(40), subject: 'split the tokenizer out'}]});
  assert.match(html, /conv-branch/);
  assert.match(html, /feat\/parser/);
  assert.match(html, /<code>bbbbbbbb<\/code>/, 'eight characters is what a person looks one up by');
  // The whole sha is in the title and nowhere the eye lands: forty characters of hex in a bubble
  // is a wall, and a sha nobody can copy is a lookup nobody can do.
  assert.ok(!/>b{12}/.test(html), 'the long form must not be drawn as text');
  assert.match(html, /split the tokenizer out/);
});

test('the whole sha is still there to be copied', () => {
  const html = convGitHtml({branch: 'work', commits: [{sha: 'c'.repeat(40), subject: 'one'}]});
  assert.match(html, new RegExp(`title="${'c'.repeat(40)}"`));
});

test('a branch with nothing committed under it still draws', () => {
  // "Nothing was committed while this was said" is an answer. An empty footer under a turn that
  // moved three files is a question.
  const html = convGitHtml({branch: 'work', commit: 'a'.repeat(40), commits: []});
  assert.match(html, /conv-branch/);
  assert.match(html, /work/);
});

test('a turn with no repository behind it draws no footer at all', () => {
  assert.equal(convGitHtml({branch: '', commit: '', commits: []}), '');
  assert.equal(convGitHtml({}), '');
  assert.equal(convGitHtml(null), '');
});

test('a detached head has commits and no branch, and says so', () => {
  const html = convGitHtml({branch: '', commit: 'a'.repeat(40),
                            commits: [{sha: 'd'.repeat(40), subject: 'one'}]});
  assert.ok(!html.includes('conv-branch'), 'a detached HEAD is a commit, not a branch');
  assert.match(html, /conv-commit/);
});
