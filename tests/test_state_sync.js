// Shared user state, client half.
//
//   node --test tests/test_state_sync.js
//
// web/src/state_sync.js is a plain script, so there is nothing to import — the file is evaluated
// in a vm context and its top-level names are exported explicitly. The first test evaluates it
// with `window` and nothing else defined, which is what keeps the module honest about touching
// `localStorage`, `ws` or the DOM at load time.
//
// The later tests install a recording localStorage, a recording socket, and a setTimeout the test
// fires by hand — so the 500 ms debounce is exercised without a suite that sleeps.

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'state_sync.js'), 'utf8');

const NAMES = ['stateSyncPlan', 'stateMerge', 'STATE_DOCS', 'STATE_DEBOUNCE', 'stateSyncOpen',
               'stateSyncClose', 'stateSyncMark', 'stateSyncReceive', 'stateSyncAck',
               'stateSyncConflict', 'stateSyncNoteError', 'stateSyncFlushAll'];

const EXPORT = `\n;__out = {${NAMES.join(', ')}};`;

// A page's worth of the browser, and no more of it than this module is allowed to use.
function boot(stored = {}, opts = {}) {
  const store = Object.assign({}, stored);
  const read = [];          // every key this module looked at
  const wrote = [];         // every key it wrote
  const sent = [];          // every message it put on the wire
  const timers = [];

  const socket = opts.deadSocket ? null : {
    send: d => {
      // A real WebSocket throws InvalidStateError when it is CONNECTING or already closed.
      if (socket.refuse) throw new Error('InvalidStateError');
      sent.push(JSON.parse(d));
    },
  };
  const ctx = vm.createContext({
    window: {},
    setTimeout: (fn, ms) => { timers.push({fn, ms, live: true}); return timers.length - 1; },
    clearTimeout: id => { if (timers[id]) timers[id].live = false; },
    localStorage: {
      getItem: k => { read.push(k); return k in store ? store[k] : null; },
      setItem: (k, v) => { wrote.push(k); store[k] = String(v); },
      removeItem: k => { wrote.push(k); delete store[k]; },
    },
    ws: socket,
  });
  vm.runInContext(SRC + EXPORT, ctx);

  // Fire every live timer once, the way the browser's clock eventually would.
  const tick = () => {
    const due = timers.filter(t => t.live);
    due.forEach(t => { t.live = false; t.fn(); });
  };
  return Object.assign({}, ctx.__out, {
    store, read, wrote, sent, socket, tick,
    // What connect() does to the global before the replacement has opened.
    replaceGlobalSocket: next => { ctx.ws = next; },
  });
}

// The relay's answer to state_get, as the relay builds it.
const answer = docs => ({type: 'state', docs});
const doc = (rev, body) => ({rev, body});

// --- load-time purity -------------------------------------------------------

test('the module evaluates with no localStorage, no socket and no DOM', () => {
  const ctx = vm.createContext({window: {}});
  assert.doesNotThrow(() => vm.runInContext(SRC + EXPORT, ctx));
  assert.equal(typeof ctx.__out.stateSyncPlan, 'function');
});

// --- the allowlist is the boundary ------------------------------------------

test('exactly four documents sync, and none of them is a secret', () => {
  const {STATE_DOCS} = boot();
  assert.deepEqual(Object.keys(STATE_DOCS).sort(),
                   ['conv_hidden', 'conv_view', 'conversations', 'pairs']);
  for (const [name, d] of Object.entries(STATE_DOCS)) {
    assert.match(d.key, /^herdr_/, `${name} should mirror a herdr_ key`);
    assert.doesNotMatch(d.key, /token|relay_url|theme|font/,
                        `${name} must not carry a device secret or preference`);
  }
});

test('nothing outside the allowlist is ever read or written', () => {
  const s = boot({herdr_pairs: '{"pairs":[]}', herdr_relay_token: 'sekrit'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(0, null), conversations: doc(2, '{"items":[]}')}));
  s.tick();
  const allowed = new Set(Object.values(s.STATE_DOCS)
    .flatMap(d => [d.key, d.pendingKey].filter(Boolean)));
  for (const k of s.read) assert.ok(allowed.has(k), `read a key it may not read: ${k}`);
  for (const k of s.wrote) {
    assert.ok(allowed.has(k) || allowed.has(k.replace(/_local$/, '')),
              `wrote a key it may not write: ${k}`);
  }
  assert.ok(!JSON.stringify(s.sent).includes('sekrit'), 'a secret reached the wire');
});

// --- the seeding decision ---------------------------------------------------

test('stateSyncPlan: the backend wins whenever it has a document', () => {
  const {stateSyncPlan} = boot();
  assert.equal(stateSyncPlan(3, '{"a":1}', null), 'adopt', 'nothing to extend from');
  assert.equal(stateSyncPlan(3, '{"a":1}', '{"b":2}'), 'adopt');
  assert.equal(stateSyncPlan(3, '{"a":1}', '{"a":1}'), 'idle', 'agreement is not a change');
});

// The relay's document with this browser's unacknowledged creations appended, and nothing else.
// Every case here is a way a local row could wrongly win, or wrongly be thrown away.
const convDoc = (...ids) =>
  JSON.stringify({version: 1, items: ids.map(id => ({id: id, name: id, members: []}))});
const convIdsOf = body => JSON.parse(body).items.map(c => c.id);
const pend = (...ids) => new Set(ids);

test('stateMerge: a pending id is appended and a shared id keeps the relay copy', () => {
  const {stateMerge} = boot();
  const server = JSON.stringify({version: 1, items: [
    {id: 'shared', name: 'theirs'}, {id: 'both', name: 'theirs'}]});
  const local = JSON.stringify({version: 1, items: [
    {id: 'both', name: 'mine'}, {id: 'mine', name: 'mine'}]});
  const merged = stateMerge('conversations', server, local, pend('mine', 'both'));
  assert.deepEqual(convIdsOf(merged), ['shared', 'both', 'mine']);
  // `both` is in the outbox and in the relay's document. The relay's copy is what every other
  // browser is reading, so an id it already holds is never replaced — outbox or not.
  assert.equal(JSON.parse(merged).items.find(c => c.id === 'both').name, 'theirs');
});

test('stateMerge: a local row that is not in the outbox is dropped', () => {
  const {stateMerge} = boot();
  const server = convDoc('a');
  // The whole point of the outbox: this is a stale cache, or a conversation deleted on another
  // browser, and appending it would resurrect what someone deleted.
  assert.equal(stateMerge('conversations', server, convDoc('a', 'ghost'), pend()), server);
  assert.equal(stateMerge('conversations', server, convDoc('a', 'ghost'), pend('other')), server,
               'an outbox that names something else is still no reason to carry this one');
});

test('stateMerge: a pending create keeps its full pane membership', () => {
  const {stateMerge} = boot();
  const server = JSON.stringify({version: 1, items: [{id: 'c1', members: [{key: 'w:p1'}]}]});
  const local = JSON.stringify({version: 1, items: [
    {id: 'c1', members: [{key: 'stale'}]},
    {id: 'c2', members: [{key: 'w:p2'}, {key: 'w:p3'}]},
  ]});
  const merged = JSON.parse(stateMerge('conversations', server, local, pend('c2')));
  assert.deepEqual(merged.items.map(c => [c.id, c.members.map(m => m.key)]),
                   [['c1', ['w:p1']], ['c2', ['w:p2', 'w:p3']]]);
});

test('stateMerge: a document with nothing to append comes back as the relay body itself', () => {
  const {stateMerge} = boot();
  const server = convDoc('a', 'b');
  assert.equal(stateMerge('conversations', server, convDoc('a'), pend('a')), server,
               'the caller reads identity as "no write to make"');
});

test('stateMerge: a map document has no outbox and always comes back as the relay body', () => {
  const {stateMerge} = boot();
  // conv_view and conv_hidden are keyed by pane and by conversation id — keys nobody creates, so
  // there is nothing to carry across and no reason to let a stale local key win.
  assert.equal(stateMerge('conv_view', '{"a":"c1"}', '{"a":"mine","b":"c2"}', pend()),
               '{"a":"c1"}');
});

test('stateMerge: anything it cannot read safely comes back null, so the relay wins whole', () => {
  const {stateMerge} = boot();
  assert.equal(stateMerge('conversations', 'not json', convDoc('a'), pend()), null);
  assert.equal(stateMerge('conversations', convDoc('a'), '[1,2]', pend()), null, 'wrong shape');
  assert.equal(stateMerge('pairs', null, '{}', pend()), null);
  assert.equal(stateMerge('nope', '{}', '{}', pend()), null, 'a name with no declared shape');
});

test('stateMerge: an entry with no id is not carried over', () => {
  const {stateMerge} = boot();
  const local = JSON.stringify({version: 1, items: [{name: 'no id here'}]});
  assert.equal(stateMerge('conversations', convDoc('a'), local, pend('a')), convDoc('a'),
               'an id-less row is in no outbox, and could not be deduplicated if it were');
});

test('stateSyncPlan: an empty relay is seeded by whoever has something', () => {
  const {stateSyncPlan} = boot();
  assert.equal(stateSyncPlan(0, null, '{"pairs":[]}'), 'upload');
  assert.equal(stateSyncPlan(0, null, null), 'idle');
});

// --- connect ----------------------------------------------------------------

test('opening the socket asks for every document', () => {
  const s = boot();
  s.stateSyncOpen();
  assert.deepEqual(s.sent, [{type: 'state_get'}]);
});

test('a browser with local state seeds an empty relay', () => {
  const s = boot({herdr_pairs: '{"version":1,"pairs":[1]}'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(0, null), conv_view: doc(0, null)}));
  const put = s.sent.find(m => m.type === 'state_put');
  assert.deepEqual(put, {type: 'state_put', name: 'pairs', rev: 0,
                         body: '{"version":1,"pairs":[1]}'});
  assert.ok(!s.sent.some(m => m.type === 'state_put' && m.name === 'conv_view'),
            'a document nobody has is not worth a message');
});

test('a browser adopts what the relay holds, and keeps a copy of what it lost', () => {
  const s = boot({herdr_pairs: '{"mine":1}'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(4, '{"theirs":1}')}));
  assert.equal(s.store.herdr_pairs, '{"theirs":1}');
  assert.equal(s.store.herdr_pairs_local, '{"mine":1}',
               'overwriting is allowed; losing it without a copy is not');
  assert.ok(!s.sent.some(m => m.type === 'state_put'),
            'adopting is not editing — it must not push back');
});

test('a browser with nothing local adopts without leaving an empty backup', () => {
  const s = boot();
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(4, '{"theirs":1}')}));
  assert.equal(s.store.herdr_pairs, '{"theirs":1}');
  assert.ok(!('herdr_pairs_local' in s.store));
});

test('a browser that already agrees with the relay writes nothing at all', () => {
  const s = boot({herdr_pairs: '{"same":1}'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(4, '{"same":1}')}));
  assert.deepEqual(s.wrote, []);
  assert.ok(!s.sent.some(m => m.type === 'state_put'));
});

// --- writing ----------------------------------------------------------------

test('a burst of edits becomes one message carrying the last of them', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.store.herdr_pairs = 'v2';
  s.stateSyncMark('pairs');
  s.store.herdr_pairs = 'v3';
  s.stateSyncMark('pairs');
  s.tick();
  const puts = s.sent.filter(m => m.type === 'state_put');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].body, 'v3', 'the key is read at flush time, not at mark time');
  assert.equal(puts[0].rev, 1);
});

test('an ack advances the revision the next write claims', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.tick();
  s.stateSyncAck({type: 'state_ack', name: 'pairs', rev: 2});
  s.store.herdr_pairs = 'v2';
  s.stateSyncMark('pairs');
  s.tick();
  const puts = s.sent.filter(m => m.type === 'state_put');
  assert.deepEqual(puts.map(p => p.rev), [1, 2]);
});

test('the backend wins an edit made while the first answer is in the air', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen();
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');     // still pulling — nothing may go out yet
  s.tick();
  assert.ok(!s.sent.some(m => m.type === 'state_put'));
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  assert.equal(s.store.herdr_pairs, 'v0');
  assert.equal(s.store.herdr_pairs_local, 'v1');
  assert.ok(!s.sent.some(m => m.type === 'state_put'));
});

test('an unknown document name is not marked', () => {
  const s = boot();
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.stateSyncMark('herdr_relay_token');
  s.stateSyncMark('widgets');
  s.tick();
  assert.ok(!s.sent.some(m => m.type === 'state_put'));
});

// --- the other browser ------------------------------------------------------

test('a push from another browser lands and does not bounce back', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.stateSyncReceive(answer({pairs: doc(2, 'theirs')}));
  assert.equal(s.store.herdr_pairs, 'theirs');
  assert.equal(s.store.herdr_pairs_local, 'v0');
  s.tick();
  assert.ok(!s.sent.some(m => m.type === 'state_put'));
});

test('a push is ignored while this browser has a write in flight', () => {
  // The ack settles that document. Applying an older body underneath it would undo the edit we
  // are waiting to hear about.
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.store.herdr_pairs = 'mine';
  s.stateSyncMark('pairs');
  s.tick();
  s.stateSyncReceive(answer({pairs: doc(2, 'stale-from-elsewhere')}));
  assert.equal(s.store.herdr_pairs, 'mine');
});

test('a conflict adopts the winner and does not retry the loser', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.store.herdr_pairs = 'mine';
  s.stateSyncMark('pairs');
  s.tick();
  const before = s.sent.filter(m => m.type === 'state_put').length;
  s.stateSyncConflict({type: 'state_conflict', name: 'pairs', rev: 2, body: 'theirs'});
  s.tick();
  assert.equal(s.store.herdr_pairs, 'theirs');
  assert.equal(s.store.herdr_pairs_local, 'mine', 'the losing edit must be recoverable');
  assert.equal(s.sent.filter(m => m.type === 'state_put').length, before,
               'retrying is what turns a guarded last-write-wins back into an unguarded one');
});

test('a conversation conflict rebases only pending creates at the returned revision', () => {
  const s = boot({herdr_conversations: convDoc('base'),
                  herdr_conversations_pending: '["mine"]'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({conversations: doc(1, convDoc('base'))}));
  s.store.herdr_conversations = convDoc('mine');
  s.stateSyncMark('conversations');
  s.tick();
  s.stateSyncConflict({type: 'state_conflict', name: 'conversations', rev: 2,
                       body: convDoc('theirs')});
  const puts = s.sent.filter(m => m.type === 'state_put');
  assert.deepEqual(puts.map(p => [p.rev, convIdsOf(p.body).sort()]),
                   [[1, ['mine']], [2, ['mine', 'theirs']]]);
  assert.deepEqual(convIdsOf(s.store.herdr_conversations).sort(), ['mine', 'theirs']);
});

// --- a relay older than this client -----------------------------------------

test('an old relay silences sync instead of showing the user an error', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen();
  const swallow = s.stateSyncNoteError(
    "unknown message type 'state_get' — the relay may be older than this client");
  assert.equal(swallow, true);
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.tick();
  assert.ok(!s.sent.some(m => m.type === 'state_put'), 'never send what it cannot answer');
});

test('an ordinary relay error still reaches the user', () => {
  const s = boot();
  s.stateSyncOpen();
  assert.equal(s.stateSyncNoteError('rename failed'), false);
  assert.equal(s.stateSyncNoteError("unknown message type 'read_pane'"), false,
               'a different unknown message is not this feature swallowing it');
});

test('a socket that has already gone does not throw on open', () => {
  const s = boot({herdr_pairs: 'v0'}, {deadSocket: true});
  assert.doesNotThrow(() => s.stateSyncOpen());
  s.stateSyncMark('pairs');
  assert.doesNotThrow(() => s.tick());
});

test('closing drops the pending timers rather than firing them at a dead socket', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.stateSyncClose();
  s.tick();
  assert.ok(!s.sent.some(m => m.type === 'state_put'));
});

test('a stale socket close cannot stop a replacement socket syncing', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen(s.socket);
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.stateSyncClose({});              // old socket closes after this one opened
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.tick();
  assert.deepEqual(s.sent.filter(m => m.type === 'state_put'),
                   [{type: 'state_put', name: 'pairs', rev: 1, body: 'v1'}]);
});

test('a reconnect adopts the backend instead of retrying an unacknowledged edit', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.tick();
  s.stateSyncClose();                 // send may have reached relay; ack did not reach browser
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(2, 'v0')}));
  const puts = s.sent.filter(m => m.type === 'state_put');
  assert.deepEqual(puts.map(p => [p.rev, p.body]), [[1, 'v1']]);
  assert.equal(s.store.herdr_pairs, 'v0');
});

test('replacing a socket adopts the backend over its unacknowledged write', () => {
  const s = boot({herdr_pairs: 'v0'});
  const replacementSent = [];
  const replacement = {send: d => replacementSent.push(JSON.parse(d))};
  s.stateSyncOpen(s.socket);
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.tick();                           // old socket accepted put; its ack was lost
  s.stateSyncOpen(replacement);       // old close is stale and intentionally ignored
  s.stateSyncReceive(answer({pairs: doc(2, 'v0')}));
  assert.deepEqual(replacementSent.filter(m => m.type === 'state_put'), []);
  assert.equal(s.store.herdr_pairs, 'v0');
});

test('a write goes to the socket it learned its revision from, not the global one', () => {
  // connect() assigns the new socket before it opens, so between those two moments the global is
  // a CONNECTING socket that cannot take a frame — and the revision being quoted belongs to the
  // old socket's conversation regardless.
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen(s.socket);
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.replaceGlobalSocket({send: () => { throw new Error('InvalidStateError'); }});
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.tick();
  assert.deepEqual(s.sent.filter(m => m.type === 'state_put'),
                   [{type: 'state_put', name: 'pairs', rev: 1, body: 'v1'}]);
});

test('a refused send is replaced by backend state on reconnect', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen(s.socket);
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.socket.refuse = true;
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.tick();
  assert.deepEqual(s.sent.filter(m => m.type === 'state_put'), [], 'the frame never left');

  // The next connect names the backend authority, so this uncommitted edit is discarded.
  s.socket.refuse = false;
  s.stateSyncClose();
  s.stateSyncOpen(s.socket);
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  assert.deepEqual(s.sent.filter(m => m.type === 'state_put'), []);
  assert.equal(s.store.herdr_pairs, 'v0');
});

test('a retry the relay already has is dropped instead of re-sent', () => {
  // The ordinary shape of a lost ack: the write reached the relay, only the reply did not. Sending
  // it again would bump the revision and broadcast an identical document to every other browser,
  // once per reconnect.
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen(s.socket);
  s.stateSyncReceive(answer({pairs: doc(1, 'v0')}));
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.tick();
  s.stateSyncClose();
  s.stateSyncOpen(s.socket);
  s.stateSyncReceive(answer({pairs: doc(2, 'v1')}));   // it landed after all
  assert.equal(s.sent.filter(m => m.type === 'state_put').length, 1,
               'the relay already agrees; a second identical write is noise');
  assert.equal(s.store.herdr_pairs, 'v1');
});

test('a page going away sends what is still sitting on its timer', () => {
  // The debounce is a window in which an edit exists here and nowhere else. A reload inside it
  // used to lose the edit and then adopt the relay's older document on the way back in — which is
  // a delete that undoes itself.
  const s = boot({herdr_conversations: 'v0'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({conversations: doc(3, 'v0')}));
  s.store.herdr_conversations = 'deleted';
  s.stateSyncMark('conversations');
  s.stateSyncFlushAll();        // no tick: the timer never got to fire
  const put = s.sent.find(m => m.type === 'state_put');
  assert.equal(put.body, 'deleted');
  assert.equal(put.rev, 3);
});

test('flushing on the way out sends each document once', () => {
  const s = boot({herdr_pairs: 'p', herdr_conversations: 'c'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(1, 'p'), conversations: doc(1, 'c')}));
  s.store.herdr_pairs = 'p2';
  s.store.herdr_conversations = 'c2';
  s.stateSyncMark('pairs');
  s.stateSyncMark('conversations');
  s.stateSyncFlushAll();
  s.tick();                     // the cancelled timers must not fire a second message
  const puts = s.sent.filter(m => m.type === 'state_put');
  assert.deepEqual(puts.map(p => p.name).sort(), ['conversations', 'pairs']);
});

test('a reconnect adopts backend state before any new write', () => {
  const s = boot({herdr_pairs: 'v0'});
  s.stateSyncOpen();
  s.stateSyncReceive(answer({pairs: doc(9, 'v0')}));
  s.stateSyncClose();
  s.stateSyncOpen();
  s.store.herdr_pairs = 'v1';
  s.stateSyncMark('pairs');
  s.tick();
  assert.ok(!s.sent.some(m => m.type === 'state_put'),
            'no write may go out before the relay has said where it is');
  s.stateSyncReceive(answer({pairs: doc(11, 'v0')}));
  assert.ok(!s.sent.some(m => m.type === 'state_put'));
  assert.equal(s.store.herdr_pairs, 'v0');
});
