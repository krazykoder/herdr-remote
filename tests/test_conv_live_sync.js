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
});

const NAMES = ['convLiveFetch', 'convLiveReceive', 'convLiveEntries', 'convLiveInvalidate',
               'convLiveEmptyHtml', 'convLiveCache', 'convFpKey', 'CONV_LIVE_ROWS', 'CONV_LIVE_EVERY'];
vm.runInContext(src('conv_live.js') + `\n;__out = {${NAMES.join(', ')}};`, ctx);
const {convLiveFetch, convLiveReceive, convLiveEntries, convLiveInvalidate,
       convLiveEmptyHtml, convLiveCache, convFpKey, CONV_LIVE_ROWS, CONV_LIVE_EVERY} = ctx.__out;

const KEY_A = JSON.stringify(['local', '%1', 'claude', '/work/a']);
const KEY_B = JSON.stringify(['local', '%2', 'codex', '/work/b']);
const FP_A = ['local', 'claude', '/work/a'];
const FP_B = ['local', 'codex', '/work/b'];

const turn = (seq, fp, at, text) => ({
  seq, host: fp[0], agent: fp[1], cwd: fp[2], at, text, kind: 'agent_turn', at_src: 'state',
  pane_id: fp === FP_A ? '%1' : '%2',
});

function reset() {
  sent.length = 0;
  convLiveCache.clear();
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
