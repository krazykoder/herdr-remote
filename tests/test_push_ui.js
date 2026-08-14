// Why push is unavailable, which is the only part of the push flow with branches.
//
// Every case here is one the browser reports as a bare failure — an iOS Home Screen icon that was
// added from Chrome, or the app opened over http on the LAN, both surface as "subscribe failed"
// with nothing the user can act on. The text is the feature.
//
// Run straight out of web/index.html so the single-file app keeps its no-build-step property.
//
//   node --test tests/test_push_ui.js

const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'push.js'), 'utf8');

// `navigator.standalone` is the tell: iOS defines it, everything else leaves it undefined.
function blockerFor({secure = true, standalone, apis = true} = {}) {
  const navigator = {};
  if (standalone !== undefined) navigator.standalone = standalone;
  if (apis) navigator.serviceWorker = {};
  const window = {isSecureContext: secure, Notification: apis ? function () {} : undefined};
  if (apis) window.PushManager = function () {};
  const ctx = vm.createContext({window, navigator});
  vm.runInContext(SRC, ctx);
  return ctx.pushBlocker();
}

test('a desktop browser over https is not blocked', () => {
  assert.equal(blockerFor(), '');
});

test('an installed iOS web app is not blocked', () => {
  assert.equal(blockerFor({standalone: true}), '');
});

test('an iOS Safari tab is told to install, not that it failed', () => {
  // Push is delivered only to a home-screen web app on iOS. A tab is a step, not an error, and
  // saying "not supported" here would send someone off to change browsers instead.
  const msg = blockerFor({standalone: false});
  assert.match(msg, /Home Screen/);
});

test('http says so, before anything blames the browser', () => {
  // Service workers need a secure context, so a LAN relay at http://192.168.x.x can never
  // register one — this is checked first because every later check would also fail there.
  const msg = blockerFor({secure: false, standalone: false});
  assert.match(msg, /https/);
});

test('a browser with no push API says that plainly', () => {
  assert.match(blockerFor({apis: false}), /not supported/);
});
