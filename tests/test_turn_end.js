// When a turn ended, as this browser saw it.
//
// The recorder appends a turn when this clock moves past what it last wrote (§5.2), so a status
// that never arrives is a transcript that never grows. herdr 0.8.0's agent lifecycle vocabulary is
// `idle, working, blocked, unknown` — `herdr pane report-agent --state` enumerates exactly those
// four — and the clock used to watch `done`, which is not one of them. Every one of these asserts
// against that vocabulary rather than against the app's older idea of it.
//
//   node --test tests/test_turn_end.js

const {test, beforeEach} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'state.js'), 'utf8');

const store = new Map();
const ctx = vm.createContext({
  console,
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
});
vm.runInContext(SRC, ctx);

// `statusAt` is declared with const, which is a lexical binding rather than a property of the
// context object, so it is reached the way the browser specs reach one: by evaluating the name.
const statusAt = () => vm.runInContext('statusAt', ctx);
const clear = () => { for (const k of Object.keys(statusAt())) delete statusAt()[k]; };

beforeEach(clear);

// noteStatus stamps Date.now(), and every assertion here is about the *order* of two stamps — a
// test that runs both inside one millisecond compares equal and turnEnd reports nothing. So the
// transition is recorded the way the app records it and then dated by hand.
const at = (pane, status, t) => {
  ctx.noteStatus(pane, status);
  if (t !== undefined) statusAt()[pane][status] = t;
};
const T = 1_700_000_000_000;

test('the statuses herdr actually reports are the ones that end a turn', () => {
  // idle is the one that was missing, and it is the one an agent finishing lands on.
  assert.equal(ctx.endsTurn('idle'), true);
  assert.equal(ctx.endsTurn('blocked'), true);
  // Kept ahead of idle rather than replaced: if herdr ever distinguishes "finished and unread"
  // from "idle", this reads the better signal without changing again.
  assert.equal(ctx.endsTurn('done'), true);
  assert.equal(ctx.endsTurn('working'), false);
  // Not a claim that the agent stopped — it is a claim that nothing is known.
  assert.equal(ctx.endsTurn('unknown'), false);
  assert.equal(ctx.endsTurn(''), false);
  assert.equal(ctx.endsTurn(undefined), false);
});

test('an agent that finishes moves the clock, on the transition herdr really sends', () => {
  // The whole bug in four lines: this is `working -> idle`, which is every finished turn on
  // herdr 0.8.0, and the clock used to stay at zero through it.
  at('w1:p1', 'working', T);
  assert.equal(ctx.turnEnd('w1:p1'), 0, 'a pane mid-turn has no end yet');
  at('w1:p1', 'idle', T + 10);
  assert.equal(ctx.turnEnd('w1:p1'), T + 10, 'working -> idle is the end of a turn');
});

test('the next turn reopens the clock and the one after it closes it again', () => {
  at('w1:p1', 'working', T);
  at('w1:p1', 'idle', T + 10);
  at('w1:p1', 'working', T + 20);
  assert.equal(ctx.turnEnd('w1:p1'), 0, 'a new turn has no end while it is being written');
  at('w1:p1', 'idle', T + 30);
  assert.equal(ctx.turnEnd('w1:p1'), T + 30, 'and the newest end is the one reported');
});

test('a pane stopped by a question ends its turn too', () => {
  at('w1:p1', 'working', T);
  at('w1:p1', 'blocked', T + 10);
  assert.equal(ctx.turnEnd('w1:p1'), T + 10);
});

test('the newest ending wins when a pane has sat in more than one', () => {
  // blocked, answered, worked, finished. The idle stamp is the end of the turn that matters, and
  // the older blocked stamp must not shadow it.
  at('w1:p1', 'working', T);
  at('w1:p1', 'blocked', T + 10);
  at('w1:p1', 'working', T + 20);
  at('w1:p1', 'idle', T + 30);
  assert.equal(ctx.turnEnd('w1:p1'), T + 30);
});

test('unknown is not an ending, and neither is a pane nobody has seen', () => {
  at('w2:p1', 'working', T);
  at('w2:p1', 'unknown', T + 10);
  assert.equal(ctx.turnEnd('w2:p1'), 0, 'unknown says nothing about whether the agent stopped');
  assert.equal(ctx.turnEnd('w9:p9'), 0);
});

test('the same status twice is one transition', () => {
  // The snapshot and the push announce the same change, and a second stamp would let the recorder
  // append the same turn twice.
  at('w1:p1', 'working', T);
  at('w1:p1', 'idle', T + 10);
  ctx.noteStatus('w1:p1', 'idle');          // announced again, not re-dated
  assert.equal(ctx.turnEnd('w1:p1'), T + 10);
});
