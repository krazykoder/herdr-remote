// Which cues are allowed to make a noise.
//
// window.cue is the one door every sound in the app goes through — twenty-odd call sites, all of
// them already written as `if (window.cue) cue(...)` — so the setting is enforced there and there
// is nothing per-site to test. What is worth pinning is the door: that a group switched off is
// silent, that the other groups are not, that an untouched install still sounds, and that a
// browser refusing localStorage is audible rather than quietly muted for good.
//
// Runs the block straight out of web/index.html so the single-file app keeps its no-build-step
// property, the same trick tests/test_agent_order.js uses.
//
//   node --test tests/test_sound.js
const {test} = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'web', 'src', 'cue.js'), 'utf8');

// A fake WebAudio graph that records nothing but the fact that a note was scheduled. The envelope
// is not under test here — a cue that reaches the oscillator has passed the gate, which is the
// whole question.
function soundCtx(store = {}) {
  const played = [];
  const node = {connect() { return node; }};
  const audio = function () {
    return {
      state: 'running', currentTime: 0,
      createOscillator: () => ({
        connect: () => node, start: hz => played.push(hz), stop() {},
        frequency: {}, type: '',
      }),
      createGain: () => ({connect: () => node, gain: {setValueAtTime() {}, exponentialRampToValueAtTime() {}}}),
    };
  };
  const g = {localStorage: {getItem: k => (k in store ? store[k] : null), setItem() {}}};
  g.window = g;
  g.AudioContext = audio;
  vm.runInContext(SRC, vm.createContext(g));
  return {played, cue: g.cue, cueOn: g.cueOn};
}

// One name per group, and the group each belongs to. A cue is several notes, so what is counted
// is whether anything was scheduled at all rather than how many.
const SAMPLE = {alert: 'chime', result: 'success', ui: 'tick'};
const sounded = (store, name) => {
  const {played, cue} = soundCtx(store);
  cue(name);
  return played.length > 0;
};

test('an install that has never opened Settings hears everything', () => {
  for (const name of Object.values(SAMPLE)) {
    assert.ok(sounded({}, name), `${name} was born silent`);
  }
});

test('switching a group off silences that group and only that group', () => {
  for (const off of Object.keys(SAMPLE)) {
    const store = {['herdr_sound_' + off]: 'off'};
    for (const [group, name] of Object.entries(SAMPLE)) {
      assert.equal(sounded(store, name), group !== off,
        `with ${off} off, ${name} was wrong`);
    }
  }
});

test('the alert survives a silenced interface', () => {
  // The point of splitting them: someone who does not want a tick per tap in an office still
  // wants to be told their agent stopped and is waiting on them.
  const store = {herdr_sound_ui: 'off', herdr_sound_result: 'off'};
  assert.ok(sounded(store, 'chime'), 'the one sound that has to carry was lost with the rest');
});

test('a browser that refuses storage is audible, not muted', () => {
  // Private mode throws on read. Defaulting to silence there would be an app that makes no sound
  // and offers no way to find out why — the checkbox it came from was never stored either.
  const g = {localStorage: {getItem() { throw new Error('SecurityError'); }, setItem() {}}};
  g.window = g;
  vm.runInContext(SRC, vm.createContext(g));
  for (const group of Object.keys(SAMPLE)) assert.equal(g.cueOn(group), true, group);
});

test('an unknown cue name is dropped rather than reaching the gate', () => {
  const {played, cue} = soundCtx();
  cue('nope');
  assert.deepEqual(played, []);
});
