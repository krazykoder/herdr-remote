// The Relay URL box takes whatever was copied, not a bare address.
//
// Run straight out of web/index.html so the single-file app keeps its no-build-step property,
// the same trick tests/test_pairs.js and tests/test_ctrl_keys.js use.
//
//   node --test tests/test_relay_url.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
const from = HTML.indexOf('    function cleanRelayUrl(raw) {');
const to = HTML.indexOf('    function saveAndConnect()', from);
assert.ok(from !== -1 && to > from, 'cleanRelayUrl not found in web/index.html');

const ctx = vm.createContext({});
vm.runInContext(HTML.slice(from, to), ctx);
const clean = ctx.cleanRelayUrl;

const OK = 'wss://sturdy-shade-hunt.trycloudflare.com';

test('a bare address is left alone', () => {
  assert.strictEqual(clean(OK), OK);
});

test('the code fence a chat client wraps it in comes off', () => {
  assert.strictEqual(clean('```\n' + OK + '\n```'), OK);
  assert.strictEqual(clean('`' + OK + '`'), OK);
});

test('the label start.sh prints beside it comes off', () => {
  assert.strictEqual(clean('  Tunnel:  ' + OK), OK);
  assert.strictEqual(clean('Relay is at ' + OK + ' now'), OK);
});

test('a sentence full stop is not part of the host', () => {
  assert.strictEqual(clean('Connect to ' + OK + '.'), OK);
  assert.strictEqual(clean('(' + OK + ')'), OK);
});

test('a trailing slash is dropped', () => {
  assert.strictEqual(clean(OK + '/'), OK);
  assert.strictEqual(clean(OK + '///'), OK);
});

test('https and http become the socket schemes they have to be', () => {
  assert.strictEqual(clean('https://sturdy-shade-hunt.trycloudflare.com'), OK);
  assert.strictEqual(clean('http://192.168.1.9:8375'), 'ws://192.168.1.9:8375');
});

test('the app link start.sh prints yields the relay, not the page hosting it', () => {
  const link = 'https://eagerkoder.github.io/mini/?relay=' +
    encodeURIComponent(OK) + '&token=deadbeef';
  assert.strictEqual(clean(link), OK);
  // And the same link with the label and fence a chat client would add.
  assert.strictEqual(clean('  Open:    ' + link + '\n'), OK);
});

test('a relay param that was never encoded still resolves', () => {
  assert.strictEqual(clean('https://eagerkoder.github.io/mini/?relay=' + OK), OK);
});

test('a path and a query on the relay itself survive', () => {
  assert.strictEqual(clean('`wss://host.example/relay?token=abc`'), 'wss://host.example/relay?token=abc');
});

test('nothing usable in, nothing out', () => {
  for (const v of ['', '   ', null, undefined]) assert.strictEqual(clean(v), '');
});

test('text with no scheme is handed back trimmed rather than mangled', () => {
  // Not a URL this can repair — the box says so on connect rather than storing a guess.
  assert.strictEqual(clean('  192.168.1.9:8375  '), '192.168.1.9:8375');
});
