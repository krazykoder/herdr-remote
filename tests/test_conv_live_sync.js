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

// The two badge nodes, as the app's `document` would hand them over. Kept out here so a test can
// read what the sync wrote into them.
const nodes = {};
const fakeNode = () => ({
  dataset: {}, innerHTML: '', title: '', hidden: false,
  style: {setProperty(name, value) { this[name] = value; }},
});

// The roster the badge resolves a pane id against, and who the composer is pointed at.
const panes = {};
let addressed = '';
let recentIndex = [];
const noted = [];
let hangs = 0;

const ctx = vm.createContext({
  console,
  document: {getElementById: id => (nodes[id] || (nodes[id] = fakeNode()))},
  paneOf: id => panes[id] || null,
  dockAddressed: () => addressed,
  activePane: '',
  localStorage: {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }},
  ws: {readyState: 1, send: s => sent.push(JSON.parse(s))},
  renderConvView: () => {}, renderConvStandalone: () => {}, hangSync: () => { hangs++; }, showToast: () => {},
  // The pill's own lapse timer. Never fired here — a test that wants the lapse moves the clock
  // instead, which is the thing convLiveSyncing actually reads.
  setTimeout: () => 0,
  escapeHtml: s => String(s),
  agentColor: agent => `var(--${agent || 'muted'})`,
  // The roster key builder, in the one spelling the rest of the app uses.
  convMemberKey: a => JSON.stringify([a.host || '', a.pane_id || '', a.agent || '', a.cwd || '']),
  loadConvIndex: () => recentIndex,
  convNoteLiveCounts: keys => noted.push(keys),
  // The live roster. A row is scoped to a pane by who is on it, so the tests below set it.
  agents: [],
});

const NAMES = ['convLiveFetch', 'convLiveReceive', 'convLiveEntries', 'convLiveInvalidate', 'convLiveWarmRecent',
               'convLiveSyncing', 'convLiveNoteError', 'convLiveAskDone', 'CONV_LIVE_ASK_TIMEOUT',
               'convLiveOlder', 'convLiveCanLoadOlder', 'convOlderHtml', 'CONV_LIVE_DEEP_MAX',
               'convLiveEmptyHtml', 'convLiveCache', 'convFpKey', 'convGitRules', 'convLiveHydrate',
               'convCommitsReceive', 'convCommitsCache', 'toggleConvCommits', 'convCommitsOn',
               'syncBranchBadge', 'syncBranchBadges',
               'CONV_LIVE_ROWS', 'CONV_LIVE_EVERY'];
vm.runInContext(src('conv_live.js') + `\n;__out = {${NAMES.join(', ')}};`, ctx);
const {convLiveFetch, convLiveReceive, convLiveEntries, convLiveInvalidate, convLiveWarmRecent,
       convLiveSyncing, convLiveNoteError, convLiveAskDone, CONV_LIVE_ASK_TIMEOUT,
       convLiveOlder, convLiveCanLoadOlder, convOlderHtml, CONV_LIVE_DEEP_MAX,
       convLiveEmptyHtml, convLiveCache, convFpKey, convGitRules, convLiveHydrate,
       convCommitsReceive, convCommitsCache, toggleConvCommits, convCommitsOn,
       syncBranchBadge, syncBranchBadges,
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
  // The tests above ask the relay plenty and answer almost none of it, which is fine for what they
  // check and would leave the pill lit for whoever runs next.
  convLiveAskDone(true);
  noted.length = 0;
  convLiveCache.clear();
  // Ownership is read out of the index now, so an index left behind by the test before this one
  // would decide which rows this one's members may draw.
  recentIndex = [];
  ctx.agents.length = 0;
  for (const a of (roster || [])) ctx.agents.push(a);
}

test('startup warms only the five most-recent conversations even with live view off', async () => {
  await convLiveHydrate();
  reset();
  store.herdr_conv_live = 'off';
  recentIndex = Array.from({length: 6}, (_, i) => ({
    created: i, members: [{key: JSON.stringify(['local', `%${i}`, 'claude', `/work/${i}`]), seen: i}],
  }));
  convLiveWarmRecent();
  assert.equal(sent.length, 1);
  assert.equal(asked().fingerprints.length, 5);
  assert.deepEqual(asked().fingerprints.map(fp => fp[2]),
                   ['/work/5', '/work/4', '/work/3', '/work/2', '/work/1']);
  store.herdr_conv_live = 'on';
});

// The question the block last put on the wire.
const asked = () => sent[sent.length - 1];

test('the first question over a roster asks for the window, not a delta', async () => {
  // The first ask of a session waits for the kept record to be read off disk — there is no
  // IndexedDB in a vm, so this settles immediately, but it still has to be awaited.
  await convLiveHydrate();
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
  assert.deepEqual(noted.at(-1), [KEY_A, KEY_B], 'every relay answer refreshes the landing metadata');
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

test('a respawned member inherits the pane it recorded itself as continuing', () => {
  // The restart case the fingerprint exists for: %1 is gone and %9 is the same work respawned —
  // and says so, because convContinueTranscript wrote %1 onto the member when it moved its key.
  reset([{host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  recentIndex = [{id: 'c1', name: 'Arch', members: [{key: KEY_A2, was: ['%1']}]}];
  convLiveFetch([KEY_A2]);
  convLiveReceive({fingerprints: [FP_A], turns: [
    paneTurn(1, '%1', 1000, 'before the restart'), paneTurn(2, '%9', 1100, 'after it')]});
  assert.deepEqual(convLiveEntries([KEY_A2]).map(e => e.text),
                   ['before the restart', 'after it']);
});

test('a quit pane does not leak into a conversation that never held it', () => {
  // The bug this rule replaced a heuristic to fix. Three agy panes in one checkout share one
  // fingerprint; one of them is quit by hand. It was never in this conversation, and "no longer
  // live" is not a reason to hand its words to a member that happens to run the same harness.
  reset([{host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  recentIndex = [{id: 'c1', name: 'Arbitrator', members: [{key: KEY_A2}]},
                 {id: 'c2', name: 'the quit one', members: [{key: KEY_A}]}];
  convLiveFetch([KEY_A2]);
  convLiveReceive({fingerprints: [FP_A], turns: [
    paneTurn(1, '%1', 1000, 'said by the pane that was quit'),
    paneTurn(2, '%9', 1100, 'said in this conversation')]});
  assert.deepEqual(convLiveEntries([KEY_A2]).map(e => e.text), ['said in this conversation']);
});

test('a member that recorded no predecessor inherits nothing', () => {
  // A member respawned before the link was recorded, and a pane belonging to no conversation at
  // all — the case widening the old claimed set could never have reached. Its own rows still draw.
  // The local transcript is untouched either way: convContinueTranscript copied those entries.
  reset([{host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  recentIndex = [{id: 'c1', name: 'Arch', members: [{key: KEY_A2}]}];
  convLiveFetch([KEY_A2]);
  convLiveReceive({fingerprints: [FP_A], turns: [
    paneTurn(1, '%1', 1000, 'before the restart'), paneTurn(2, '%9', 1100, 'after it')]});
  assert.deepEqual(convLiveEntries([KEY_A2]).map(e => e.text), ['after it']);
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

// --- One fingerprint, several panes ---
//
// A fingerprint is `[host, agent, cwd]`, and that is deliberate: it is what survives herdr
// renumbering every pane on restart. It is also not a pane. Four claude sessions in one repository
// are one fingerprint, and the relay answers a fingerprint with the newest 200 rows across all of
// them — cut further by a byte bound. Whoever spoke most recently takes the window, and a pane with
// its own long history renders a handful of rows while the record holds hundreds.

// KEY_A2 and paneTurn above are the second pane sharing FP_A's agent and directory: same
// fingerprint, one pane apart, which is the whole subject of this section.

test('an answer that did not fit is asked again for each pane the roster names', () => {
  reset();
  convLiveFetch([KEY_A, KEY_A2]);
  const roster = asked();
  assert.deepEqual(new Set(roster.fingerprints.map(f => f.join('|'))),
                   new Set([FP_A.join('|')]), 'both members are one fingerprint');
  assert.equal(roster.pane, undefined, 'the roster question is not scoped to a pane');

  sent.length = 0;
  convLiveReceive({turns: [paneTurn(1, '%9', 100, 'the busy neighbour')],
                   fingerprints: [FP_A], truncated: true});
  assert.deepEqual(sent.map(m => m.pane), ['%1', '%9'],
                   'each pane gets a window of its own');
  for (const m of sent) assert.deepEqual(m.fingerprints, [FP_A]);
});

test('an answer that fitted is not asked again', () => {
  reset();
  convLiveFetch([KEY_A, KEY_A2]);
  sent.length = 0;
  convLiveReceive({turns: [paneTurn(1, '%1', 100, 'all of it')], fingerprints: [FP_A]});
  assert.deepEqual(sent, [], 'nothing was left out, so there is nothing narrower to ask');
});

test('a pane-scoped answer does not stand as the fingerprint’s watermark', () => {
  // The bug this guards: the narrow answer carries one pane's rows, and its highest id taken as
  // the watermark would tell the next delta that every other pane sharing the fingerprint is
  // current through an id it was never asked about. Their turns would never arrive again.
  reset();
  convLiveFetch([KEY_A]);
  sent.length = 0;
  convLiveReceive({turns: [paneTurn(9, '%1', 100, 'narrow')], fingerprints: [FP_A], pane: '%1'});
  convLiveInvalidate();
  convLiveFetch([KEY_A], true);
  assert.equal(asked().since_id, undefined);

  // And the roster answer that does settle it is the one with no pane on it.
  convLiveReceive({turns: [paneTurn(9, '%1', 100, 'narrow')], fingerprints: [FP_A]});
  convLiveInvalidate();
  convLiveFetch([KEY_A]);
  assert.equal(asked().since_id, 9);
});

test('the ceiling is counted per pane, not over the fingerprint', () => {
  // Over the fingerprint, the busiest pane evicts the quiet one down to nothing: the reader opens
  // a pane with a long history behind it and is shown whatever is left after its neighbours took
  // their share of one number.
  // Both panes live, so each row is claimed by the pane that made it — the inheritance rule that
  // hands an ended pane's rows to whoever holds the fingerprint is a different question.
  reset([{host: 'local', pane_id: '%1', agent: 'claude', cwd: '/work/a'},
         {host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  const turns = [];
  for (let i = 1; i <= CONV_LIVE_ROWS; i++) turns.push(paneTurn(i, '%1', i, 'mine ' + i));
  for (let i = 1; i <= CONV_LIVE_ROWS; i++) {
    turns.push(paneTurn(CONV_LIVE_ROWS + i, '%9', CONV_LIVE_ROWS + i, 'theirs ' + i));
  }
  convLiveReceive({turns, fingerprints: [FP_A]});
  assert.equal(convLiveEntries([KEY_A]).length, CONV_LIVE_ROWS,
               'the quiet pane keeps its own window');
  assert.equal(convLiveEntries([KEY_A2]).length, CONV_LIVE_ROWS);
});

// --- Branch changes and commits, as events in the thread ---
//
// A branch is the same for twenty messages in a row, so what the thread draws is the moment it
// changed. Commits are the same shape of fact and they are optional, because the relay stores them
// only when asked to — the ordinary case is the thread asking for a range it can see the two ends
// of.

const entry = (over) => Object.assign(
  {key: KEY_A, branch: '', commit: '', commits: [], host: 'local', cwd: '/work/a'}, over);

test('the first sighting of a branch names it, and only a change is an event', () => {
  const seen = new Map();
  const first = convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), seen);
  assert.match(first.before, /conv-rule git branch/);
  assert.match(first.before, /main/);
  assert.ok(!/changed/.test(first.before), 'arriving somewhere is not moving');

  const same = convGitRules(entry({branch: 'main', commit: 'b'.repeat(40)}), seen);
  assert.equal(same.before, '', 'the same branch twice is not an event');

  const moved = convGitRules(entry({branch: 'feat/x', commit: 'c'.repeat(40)}), seen);
  assert.match(moved.before, /Branch changed to/);
  assert.match(moved.before, /feat\/x/);
});

test('a branch is per member, not per thread', () => {
  // A joint thread is several panes in several directories. One of them moving says nothing about
  // the others, and a shared marker would claim it did.
  const seen = new Map();
  convGitRules(entry({key: KEY_A, branch: 'main', commit: 'a'.repeat(40)}), seen);
  const other = convGitRules(entry({key: KEY_B, branch: 'main', commit: 'b'.repeat(40)}), seen);
  assert.match(other.before, /main/, 'the second member has not been introduced yet');
  const back = convGitRules(entry({key: KEY_A, branch: 'main', commit: 'c'.repeat(40)}), seen);
  assert.equal(back.before, '');
});

test('a turn recorded outside the checkout does not undo the branch', () => {
  // Stepping out of a repository for one turn is not a branch change, and announcing the same
  // branch again on the way back in would be an event that did not happen.
  const seen = new Map();
  convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), seen);
  const nothing = convGitRules(entry({}), seen);
  assert.deepEqual(nothing, {before: '', after: ''});
  const back = convGitRules(entry({branch: 'main', commit: 'b'.repeat(40)}), seen);
  assert.equal(back.before, '');
});

test('commits are off until they are switched on', () => {
  store.herdr_conv_commits = 'off';
  const seen = new Map();
  convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), seen);
  const after = convGitRules(entry({
    branch: 'main', commit: 'b'.repeat(40),
    commits: [{sha: 'c'.repeat(40), subject: 'one'}],
  }), seen).after;
  assert.equal(after, '', 'the reader did not ask for these');
});

test('a stored list is drawn without asking the relay for it', () => {
  store.herdr_conv_commits = 'on';
  sent.length = 0;
  const seen = new Map();
  convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), seen);
  const after = convGitRules(entry({
    branch: 'main', commit: 'b'.repeat(40),
    commits: [{sha: 'c'.repeat(40), subject: 'split the tokenizer out'}],
  }), seen).after;
  // A strip attached to the bubble, not a rule across the thread: these belong to the turn above
  // them rather than dividing it from the next one.
  assert.match(after, /class="conv-commits/);
  assert.ok(!/conv-rule/.test(after), 'a divider would claim these sit between two messages');
  assert.match(after, /<code>cccccccc<\/code>/);
  assert.match(after, /split the tokenizer out/);
  assert.match(after, new RegExp(`title="${'c'.repeat(40)}"`));
  assert.deepEqual(sent.filter(m => m.type === 'git_commits'), []);
  store.herdr_conv_commits = 'off';
});

test('a range with no stored list is asked for once, and drawn when it answers', () => {
  store.herdr_conv_commits = 'on';
  sent.length = 0;
  convCommitsCache.clear();
  const seen = new Map();
  convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), seen);

  const second = entry({branch: 'main', commit: 'b'.repeat(40)});
  assert.equal(convGitRules(second, seen).after, '', 'nothing is drawn before the answer');
  assert.deepEqual(sent.filter(m => m.type === 'git_commits'), [{
    type: 'git_commits', host: 'local', cwd: '/work/a', from: 'a'.repeat(40), to: 'b'.repeat(40),
  }]);

  // Asked again before the answer: the question is in flight, not lost.
  const seenAgain = new Map();
  convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), seenAgain);
  convGitRules(second, seenAgain);
  assert.equal(sent.filter(m => m.type === 'git_commits').length, 1);

  convCommitsReceive({host: 'local', cwd: '/work/a', from: 'a'.repeat(40), to: 'b'.repeat(40),
                      commits: [{sha: 'd'.repeat(40), subject: 'delete the old lexer'}]});
  const seenFinal = new Map();
  convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), seenFinal);
  assert.match(convGitRules(second, seenFinal).after, /delete the old lexer/);
  store.herdr_conv_commits = 'off';
});

test('an empty answer is remembered, so a quiet range is not asked about forever', () => {
  store.herdr_conv_commits = 'on';
  sent.length = 0;
  convCommitsCache.clear();
  const seen = new Map();
  convGitRules(entry({branch: 'main', commit: 'e'.repeat(40)}), seen);
  convGitRules(entry({branch: 'main', commit: 'f'.repeat(40)}), seen);
  convCommitsReceive({host: 'local', cwd: '/work/a', from: 'e'.repeat(40), to: 'f'.repeat(40),
                      commits: []});
  const again = new Map();
  convGitRules(entry({branch: 'main', commit: 'e'.repeat(40)}), again);
  assert.equal(convGitRules(entry({branch: 'main', commit: 'f'.repeat(40)}), again).after, '');
  assert.equal(sent.filter(m => m.type === 'git_commits').length, 1, 'asked once, answered once');
  store.herdr_conv_commits = 'off';
});

test('the first turn of a thread has no range to ask about', () => {
  // There is no earlier commit, so there is no `from` — and asking for one would be a question
  // about the whole history of the repository.
  store.herdr_conv_commits = 'on';
  sent.length = 0;
  convCommitsCache.clear();
  convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), new Map());
  assert.deepEqual(sent.filter(m => m.type === 'git_commits'), []);
  store.herdr_conv_commits = 'off';
});

test('a turn with neither a branch nor a commit draws nothing at all', () => {
  assert.deepEqual(convGitRules(entry({}), new Map()), {before: '', after: ''});
  assert.deepEqual(convGitRules(null, new Map()), {before: '', after: ''});
});

test('the toggle is remembered', () => {
  store.herdr_conv_commits = 'off';
  assert.equal(convCommitsOn(), false);
  toggleConvCommits();
  assert.equal(store.herdr_conv_commits, 'on');
  assert.equal(convCommitsOn(), true);
  toggleConvCommits();
  assert.equal(store.herdr_conv_commits, 'off');
});


// --- The standing branch badge ---
//
// It answers "where is this agent working now", which is not the question the thread's branch
// rules answer, and it is per agent rather than per view: a conversation's members can be in two
// checkouts on two branches, so a badge that followed the conversation would be wrong for one of
// them half the time.

test('the badge shows the branch and disappears when there is none', () => {
  syncBranchBadge('paneBranch', {pane_id: '%1', branch: 'feat/state-sync'});
  assert.match(nodes.paneBranch.innerHTML, /feat\/state-sync/);
  assert.equal(nodes.paneBranch.hidden, false);

  // A pane outside a checkout, and a pane the relay has not probed since it started, are the same
  // thing to a reader: nothing to say, so nothing on screen.
  syncBranchBadge('paneBranch', {pane_id: '%1'});
  assert.equal(nodes.paneBranch.hidden, true);
  assert.equal(nodes.paneBranch.innerHTML, '');

  syncBranchBadge('paneBranch', null);
  assert.equal(nodes.paneBranch.hidden, true);
});

test('an unchanged branch does not rewrite the node', () => {
  syncBranchBadge('paneBranch', {pane_id: '%1', branch: 'main'});
  const written = nodes.paneBranch.innerHTML;
  nodes.paneBranch.innerHTML = 'TOUCHED';        // stands in for the DOM node being replaced
  syncBranchBadge('paneBranch', {pane_id: '%1', branch: 'main'});
  assert.equal(nodes.paneBranch.innerHTML, 'TOUCHED',
               'this runs on every snapshot; rewriting an unchanged badge is churn under a finger');
  nodes.paneBranch.innerHTML = written;
});

test('the conversation badge follows the addressed member, not the conversation', () => {
  panes['%1'] = {pane_id: '%1', branch: 'feat/one'};
  panes['%2'] = {pane_id: '%2', branch: 'feat/two'};
  ctx.activePane = '%1';

  addressed = '%2';
  syncBranchBadges();
  assert.match(nodes.convBranch.innerHTML, /feat\/two/);
  // The two views are answering about two different agents at the same time, which is the whole
  // reason this is per agent.
  assert.match(nodes.paneBranch.innerHTML, /feat\/one/);

  addressed = '%1';
  syncBranchBadges();
  assert.match(nodes.convBranch.innerHTML, /feat\/one/);

  // Nobody addressed — a conversation whose members have all ended.
  addressed = '';
  syncBranchBadges();
  assert.equal(nodes.convBranch.hidden, true);
});

test('the badge is painted in the addressed agent\'s own colour, and asks for nothing', () => {
  // The branch belongs to an agent, so it reads in that agent's colour rather than in one generic
  // git blue — in a joint thread the badge and the bubbles below it then say the same thing twice.
  sent.length = 0;
  ctx.activePane = '';
  panes['%2'] = {pane_id: '%2', agent: 'codex', branch: 'feat/current'};
  addressed = '%2';
  syncBranchBadges();
  assert.match(nodes.convBranch.innerHTML, /feat\/current/);
  assert.equal(nodes.convBranch.style['--branch-color'], 'var(--codex)');
  assert.equal(nodes.convBranch.hidden, false);
  // Drawing a badge is not a question. The relay has already put this on the snapshot, and a round
  // trip per selection would buy only the minutes between a branch switch and the next turn.
  assert.deepEqual(sent, []);
});

test('the commit strip says the commits landed in a checkout, not who made them', () => {
  // The range is per checkout, so the first turn to end after a commit is not the pane that made
  // it. Painted in the speaker's colour under its bubble, the strip said otherwise.
  store.herdr_conv_commits = 'on';
  const seen = new Map();
  convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), seen);
  const after = convGitRules(entry({
    branch: 'main', commit: 'b'.repeat(40), cwd: '/w/herdr-remote',
    commits: [{sha: 'c'.repeat(40), subject: 'one'}],
  }), seen).after;
  assert.match(after, /class="conv-commits"/);
  assert.doesNotMatch(after, /conv-right/, 'a fact about the repository takes no bubble\'s column');
  assert.doesNotMatch(after, /--conv-agent/, 'nor the speaking agent\'s colour');
  assert.match(after, /landed in herdr-remote/);
  assert.match(after, /Commits are per checkout/);
  store.herdr_conv_commits = 'off';
});

test('two agents in one checkout do not each claim the same commits', () => {
  // A pair working in one directory. Counted per member, each would carry the previous sha *it*
  // last ended on, so the same commit would be drawn under a bubble from each of them — twice, and
  // once under the agent that did not make it. A commit belongs to a repository's history.
  store.herdr_conv_commits = 'on';
  sent.length = 0;
  convCommitsCache.clear();
  const seen = new Map();
  const shared = {host: 'local', cwd: '/work/shared'};

  // Both end a turn at the same sha: nothing was committed between them.
  convGitRules({...shared, key: KEY_A, branch: 'main', commit: 'a'.repeat(40)}, seen);
  convGitRules({...shared, key: KEY_B, branch: 'main', commit: 'a'.repeat(40)}, seen);

  // Now one of them commits, and both end another turn at the new sha.
  const second = {...shared, key: KEY_B, branch: 'main', commit: 'b'.repeat(40)};
  convGitRules(second, seen);
  const asks = sent.filter(m => m.type === 'git_commits');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].from, 'a'.repeat(40), 'the range starts where the checkout was, not the member');

  convCommitsReceive({host: 'local', cwd: '/work/shared', from: 'a'.repeat(40), to: 'b'.repeat(40),
                      commits: [{sha: 'c'.repeat(40), subject: 'the one commit'}]});
  const third = convGitRules({...shared, key: KEY_A, branch: 'main', commit: 'b'.repeat(40)}, seen);
  assert.equal(third.after, '',
               'the other member must not claim a commit already drawn under this checkout');
  store.herdr_conv_commits = 'off';
});

test('each member is still introduced by its own branch', () => {
  // The other half of the same split: a branch is per member, so a joint thread says where each
  // pane is working rather than announcing the directory once and leaving the rest unexplained.
  const seen = new Map();
  const shared = {host: 'local', cwd: '/work/shared'};
  const first = convGitRules({...shared, key: KEY_A, branch: 'main', commit: 'a'.repeat(40)}, seen);
  const other = convGitRules({...shared, key: KEY_B, branch: 'main', commit: 'a'.repeat(40)}, seen);
  assert.match(first.before, /main/);
  assert.match(other.before, /main/, 'the second member has not been introduced yet');
});

// --- "Syncing…", said only while a question is in the air ---
//
// The pill is the only thing telling a reader that a short thread is short because the answer has
// not landed yet. Two ways to get it wrong, and both leave it lying: a counter that never comes
// back down keeps it lit over a thread that is finished, and one that comes down on the first
// answer of a refill puts it out while several panes are still outstanding.

test('a question in the air is syncing; its answer settles it', async () => {
  await convLiveHydrate();
  reset();
  assert.equal(convLiveSyncing(), false, 'nothing asked, nothing said');
  convLiveFetch([KEY_A, KEY_B]);
  assert.equal(convLiveSyncing(), true);
  convLiveReceive({fingerprints: [FP_A, FP_B], turns: []});
  assert.equal(convLiveSyncing(), false);
});

test('a refill is several questions, and each of them has to be answered', async () => {
  await convLiveHydrate();
  // Two panes of one agent in one directory: one fingerprint, so a truncated roster answer is
  // asked again once per pane.
  const paneA = JSON.stringify(['local', '%1', 'claude', '/work/a']);
  const paneB = JSON.stringify(['local', '%9', 'claude', '/work/a']);
  reset([{host: 'local', pane_id: '%1', agent: 'claude', cwd: '/work/a'},
         {host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  convLiveFetch([paneA, paneB]);
  convLiveReceive({fingerprints: [FP_A], turns: [], truncated: true});
  const refills = sent.filter(m => m.pane);
  assert.equal(refills.length, 2, 'one narrowed question per pane');
  assert.equal(convLiveSyncing(), true, 'the roster answer settled itself and opened two more');

  convLiveReceive({fingerprints: [FP_A], pane: '%1', turns: []});
  assert.equal(convLiveSyncing(), true, 'the second pane is still outstanding');
  convLiveReceive({fingerprints: [FP_A], pane: '%9', turns: []});
  assert.equal(convLiveSyncing(), false);
});

test('an answer that never comes lets it go out on its own', async () => {
  await convLiveHydrate();
  reset();
  convLiveFetch([KEY_A]);
  assert.equal(convLiveSyncing(), true);
  // The socket died with the question in it. Nothing will ever answer, and a pill lit forever is
  // worse than no pill at all.
  vm.runInContext('convLiveAskedAt = Date.now() - CONV_LIVE_ASK_TIMEOUT - 1;', ctx);
  assert.equal(convLiveSyncing(), false);
  assert.equal(convLiveSyncing(), false, 'and it stays out');
});

test('the record being off answers every outstanding question at once', async () => {
  await convLiveHydrate();
  reset();
  convLiveFetch([KEY_A, KEY_B]);
  assert.equal(convLiveSyncing(), true);
  convLiveNoteError('conversation log is off');
  assert.equal(convLiveSyncing(), false,
               'no answer is coming for any of them, and the thread says why instead');
});

// --- Walking one thread backwards, by hand ---
//
// Everything else here goes forwards. This is the only question that does not, and it is the one
// with the most ways to look like it worked while doing nothing:
//
//   - the trim keeps the newest window a pane, so rows fetched from *before* it are discarded on
//     the tick they arrive unless the ceiling was raised first;
//   - a backfill's highest id is older than the bucket's watermark, so taken as one it winds the
//     bucket backwards and the next delta re-fetches everything in between;
//   - a joint thread's members do not share an oldest row, so one question over the roster hands
//     most of them a window they already hold.

// A pane with more turns than one window, so there is something behind the window to walk into.
const deepTurns = (n, from) => Array.from({length: n}, (_, i) =>
  turn(from + i, FP_A, 1000 + (from + i), `turn ${from + i}`));

test('the oldest window is asked for by the oldest row on hand, and kept when it lands', async () => {
  await convLiveHydrate();
  reset([{host: 'local', pane_id: '%1', agent: 'claude', cwd: '/work/a'}]);
  convLiveFetch([KEY_A], true);
  // The newest window. seq 801..1000, so 800 and below are behind it.
  convLiveReceive({fingerprints: [FP_A], turns: deepTurns(CONV_LIVE_ROWS, 801), truncated: true});
  const bucket = convLiveCache.get(convFpKey(FP_A));
  assert.equal(bucket.turns.length, CONV_LIVE_ROWS);
  assert.equal(convLiveCanLoadOlder([KEY_A]), true);

  sent.length = 0;
  assert.equal(convLiveOlder([KEY_A]), 1);
  const back = asked();
  assert.equal(back.until_id, 801, 'the window before the oldest row this browser holds');
  assert.equal(back.pane, '%1', 'pane-scoped: an oldest row belongs to a pane, not to a roster');
  assert.equal(back.since_id, undefined, 'a walk back is not a delta');

  convLiveReceive({fingerprints: [FP_A], pane: '%1', until_id: 801,
                   turns: deepTurns(CONV_LIVE_ROWS, 601)});
  assert.equal(bucket.turns.length, CONV_LIVE_ROWS * 2,
               'the ceiling was raised before the answer, so the rows were not trimmed away');
  assert.equal(bucket.turns[0].seq, 601, 'and they went in at the old end');
});

test('a walk back never becomes the watermark', async () => {
  await convLiveHydrate();
  reset([{host: 'local', pane_id: '%1', agent: 'claude', cwd: '/work/a'}]);
  convLiveFetch([KEY_A], true);
  convLiveReceive({fingerprints: [FP_A], turns: deepTurns(CONV_LIVE_ROWS, 801)});
  const bucket = convLiveCache.get(convFpKey(FP_A));
  assert.equal(bucket.syncedTo, 1000);

  convLiveOlder([KEY_A]);
  convLiveReceive({fingerprints: [FP_A], pane: '%1', until_id: 801,
                   turns: deepTurns(CONV_LIVE_ROWS, 601)});
  assert.equal(bucket.syncedTo, 1000,
               'an older window says nothing about what is new, and winding this back would '
               + 'make the next delta re-fetch every turn in between');
});

test('the record having nothing older ends the walk rather than repeating it', async () => {
  await convLiveHydrate();
  reset([{host: 'local', pane_id: '%1', agent: 'claude', cwd: '/work/a'}]);
  convLiveFetch([KEY_A], true);
  convLiveReceive({fingerprints: [FP_A], turns: deepTurns(10, 1)});
  assert.equal(convLiveCanLoadOlder([KEY_A]), true);

  convLiveOlder([KEY_A]);
  convLiveReceive({fingerprints: [FP_A], pane: '%1', until_id: 1, turns: []});
  assert.equal(convLiveCanLoadOlder([KEY_A]), false, 'there is nothing behind the start');
  sent.length = 0;
  assert.equal(convLiveOlder([KEY_A]), 0, 'and the question is not asked again');
  assert.equal(sent.length, 0);
  assert.match(convOlderHtml([KEY_A]), /start of the relay/);
});

test('a respawn walks the old physical pane while keeping the new member as owner', async () => {
  await convLiveHydrate();
  const fresh = JSON.stringify(['local', '%9', 'claude', '/work/a']);
  reset([{host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  // The member says %9 continues %1 — the link convContinueTranscript writes when it moves a
  // member's key. Without it %1's rows are somebody else's, which is the whole point of the rule.
  recentIndex = [{id: 'c1', name: 'Arch', members: [{key: fresh, was: ['%1']}]}];
  convLiveFetch([fresh], true);
  // The roster query attaches %1's history to the %9 respawn that recorded it.
  convLiveReceive({fingerprints: [FP_A], turns: deepTurns(CONV_LIVE_ROWS, 801)});
  sent.length = 0;
  assert.equal(convLiveOlder([fresh]), 1);
  const back = asked();
  assert.equal(back.pane, '%1');
  assert.equal(back.owner_pane, '%9');
  convLiveReceive({fingerprints: [FP_A], pane: '%1', owner_pane: '%9', until_id: 801,
                   turns: deepTurns(CONV_LIVE_ROWS, 601)});
  const bucket = convLiveCache.get(convFpKey(FP_A));
  assert.equal(bucket.turns.length, CONV_LIVE_ROWS * 2);
  assert.equal(convLiveEntries([fresh])[0].text, 'turn 601');
  // The end result belongs to the current member, not the old, dead physical pane.
  convLiveReceive({fingerprints: [FP_A], pane: '%1', owner_pane: '%9', until_id: 601, turns: []});
  assert.equal(convLiveCanLoadOlder([fresh]), false);
});

test('a relay too old to echo the owner still ends the walk in the right place', async () => {
  // The page is deployed separately from the relay and can be any age relative to it, so an answer
  // carrying `pane` and no `owner_pane` is an ordinary case and not a broken one. Marking the dead
  // physical pane as ended would leave the member's button up over a record with nothing behind it.
  await convLiveHydrate();
  const fresh = JSON.stringify(['local', '%9', 'claude', '/work/a']);
  reset([{host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  recentIndex = [{id: 'c1', name: 'Arch', members: [{key: fresh, was: ['%1']}]}];
  convLiveFetch([fresh], true);
  convLiveReceive({fingerprints: [FP_A], turns: deepTurns(CONV_LIVE_ROWS, 801)});
  convLiveOlder([fresh]);
  convLiveReceive({fingerprints: [FP_A], pane: '%1', until_id: 801, turns: []});
  assert.equal(convLiveCanLoadOlder([fresh]), false);
  assert.match(convOlderHtml([fresh]), /start of the relay/);
});

test('the walk stops at the ceiling this device keeps', async () => {
  await convLiveHydrate();
  reset([{host: 'local', pane_id: '%1', agent: 'claude', cwd: '/work/a'}]);
  convLiveFetch([KEY_A], true);
  let top = 100000;
  convLiveReceive({fingerprints: [FP_A], turns: deepTurns(CONV_LIVE_ROWS, top)});
  // Walk until it refuses. Every answer is a full window, so nothing but the ceiling can stop it.
  let presses = 0;
  while (convLiveOlder([KEY_A])) {
    presses++;
    assert.ok(presses <= 50, 'the walk must terminate');
    const until = asked().until_id;
    convLiveReceive({fingerprints: [FP_A], pane: '%1', until_id: until,
                     turns: deepTurns(CONV_LIVE_ROWS, until - CONV_LIVE_ROWS)});
  }
  const bucket = convLiveCache.get(convFpKey(FP_A));
  assert.equal(bucket.turns.length, CONV_LIVE_DEEP_MAX);
  assert.equal(presses, CONV_LIVE_DEEP_MAX / CONV_LIVE_ROWS - 1);
  assert.equal(convLiveCanLoadOlder([KEY_A]), false);
  assert.match(convOlderHtml([KEY_A]), /As far back as this device keeps/);
});

test('a joint thread asks once per member, each from its own oldest row', async () => {
  await convLiveHydrate();
  reset([{host: 'local', pane_id: '%1', agent: 'claude', cwd: '/work/a'},
         {host: 'local', pane_id: '%2', agent: 'codex', cwd: '/work/b'}]);
  convLiveFetch([KEY_A, KEY_B], true);
  convLiveReceive({fingerprints: [FP_A, FP_B],
                   turns: [turn(400, FP_A, 4000, 'a'), turn(900, FP_B, 9000, 'b')]});
  sent.length = 0;
  assert.equal(convLiveOlder([KEY_A, KEY_B]), 2);
  const asks = sent.filter(m => m.until_id != null);
  assert.deepEqual(asks.map(m => [m.pane, m.until_id]).sort(),
                   [['%1', 400], ['%2', 900]],
                   'one bound over both would hand the newer member a window it already holds');
});

test('nothing is offered before the relay has answered at all', async () => {
  await convLiveHydrate();
  reset();
  assert.equal(convOlderHtml([KEY_A]), '', 'an unanswered thread is not one with older messages');
  assert.equal(convLiveCanLoadOlder([KEY_A]), false);
  convLiveFetch([KEY_A], true);
  convLiveReceive({fingerprints: [FP_A], turns: []});
  assert.equal(convOlderHtml([KEY_A]), '',
               'and an empty record has no window behind it either');
});

test('the walk is not offered over this browser’s own transcript', async () => {
  await convLiveHydrate();
  reset([{host: 'local', pane_id: '%1', agent: 'claude', cwd: '/work/a'}]);
  convLiveFetch([KEY_A], true);
  convLiveReceive({fingerprints: [FP_A], turns: deepTurns(CONV_LIVE_ROWS, 801)});
  store.herdr_conv_live = 'off';
  assert.equal(convOlderHtml([KEY_A]), '', 'the local transcript is not the relay’s record');
  assert.equal(convLiveCanLoadOlder([KEY_A]), false);
  store.herdr_conv_live = 'on';
});
