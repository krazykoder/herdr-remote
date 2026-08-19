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

const ctx = vm.createContext({
  console,
  document: {getElementById: id => (nodes[id] || (nodes[id] = fakeNode()))},
  paneOf: id => panes[id] || null,
  dockAddressed: () => addressed,
  activePane: '',
  localStorage: {getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }},
  ws: {readyState: 1, send: s => sent.push(JSON.parse(s))},
  renderConvView: () => {}, renderConvStandalone: () => {}, hangSync: () => {}, showToast: () => {},
  escapeHtml: s => String(s),
  agentColor: agent => `var(--${agent || 'muted'})`,
  // The roster key builder, in the one spelling the rest of the app uses.
  convMemberKey: a => JSON.stringify([a.host || '', a.pane_id || '', a.agent || '', a.cwd || '']),
  // The live roster. A row is scoped to a pane by who is on it, so the tests below set it.
  agents: [],
});

const NAMES = ['convLiveFetch', 'convLiveReceive', 'convLiveEntries', 'convLiveInvalidate',
               'convLiveEmptyHtml', 'convLiveCache', 'convFpKey', 'convGitRules',
               'convCommitsReceive', 'convCommitsCache', 'toggleConvCommits', 'convCommitsOn',
               'syncBranchBadge', 'syncBranchBadges',
               'CONV_LIVE_ROWS', 'CONV_LIVE_EVERY'];
vm.runInContext(src('conv_live.js') + `\n;__out = {${NAMES.join(', ')}};`, ctx);
const {convLiveFetch, convLiveReceive, convLiveEntries, convLiveInvalidate,
       convLiveEmptyHtml, convLiveCache, convFpKey, convGitRules,
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

test('the commit strip takes the bubble\'s column', () => {
  // Hung under the bubble, so a two-column thread has to put it under the right one — a strip that
  // ignored the side would sit under the wrong agent's messages in every pair.
  store.herdr_conv_commits = 'on';
  const commits = [{sha: 'e'.repeat(40), subject: 'move the parser'}];
  const seen = new Map();
  convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), seen);
  const right = convGitRules(entry({branch: 'main', commit: 'b'.repeat(40), commits}),
                             seen, ' conv-right').after;
  assert.match(right, /class="conv-commits conv-right"/);

  const left = new Map();
  convGitRules(entry({branch: 'main', commit: 'a'.repeat(40)}), left);
  assert.match(convGitRules(entry({branch: 'main', commit: 'b'.repeat(40), commits}), left).after,
               /class="conv-commits"/, 'no side is the left column, as the bubble has it');
  store.herdr_conv_commits = 'off';
});
