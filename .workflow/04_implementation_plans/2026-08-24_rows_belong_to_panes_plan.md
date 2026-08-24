# Plan: A recorded row belongs to the pane that produced it

Decision log: `../02_architecture/decision_log/2026-08-24_rows_belong_to_panes.md`.
Class A. **No file under `relay/` changes.**

## Goal

Stop a quit agent's turns being drawn inside a conversation it was never in. Replace the
"unclaimed dead pane goes to whoever holds the fingerprint" heuristic in `web/src/conv_live.js`
with a recorded predecessor link written at the one place a respawn moves a member's key.

## Step 0 — reproduce first

Do this before editing anything. The failing test **is** the reproduction, and it encodes the
user's real index rather than an invented shape.

Add to `tests/test_conv_live_sync.js`, beside the three attribution tests at line 258:

```js
test('a quit pane does not leak into a conversation that never held it', () => {
  // The reported bug, with the user's own shape: three agy panes in one checkout share one
  // fingerprint. %25 was quit; the arbitration conversation holds %22 and has never held %25.
  reset([{host: 'local', pane_id: '%22', agent: 'claude', cwd: '/work/a'}]);
  recentIndex = [{id: 'c1', name: 'Arbitrator', members: [{key: KEY_A2}]},
                 {id: 'c2', name: 'AGY3.7', members: [{key: KEY_A}]}];
  convLiveFetch([KEY_A2]);
  convLiveReceive({fingerprints: [FP_A], turns: [
    paneTurn(1, '%1', 1000, 'said by the pane that was quit'),
    paneTurn(2, '%9', 1100, 'said in this conversation')]});
  assert.deepEqual(convLiveEntries([KEY_A2]).map(e => e.text), ['said in this conversation']);
});
```

`KEY_A` is pane `%1` and `KEY_A2` is pane `%9`; both are claude in `/work/a`, so they share `FP_A` —
the same collision the user's three agy panes have. Run it and watch it fail with **both** texts
returned. That failure is the bug.

Browser check, after the fix: `tests/e2e/browser/conv_live.spec.js` already drives the live record
through a real page. Add one case there that opens a conversation whose fingerprint is shared with a
pane the fake herdr has dropped, and assert the thread holds only its own member's rows. The vm
slice is the precise reproduction — this is the guard that the wiring around it still agrees.

## File-by-file

### `[MODIFY] web/src/conv_live.js` — delete the heuristic

**Delete** `convLiveClaimed` (lines 400-407) entirely.

**Replace** `convLiveRowIsMine` (lines 413-416) with:

```js
    // A row belongs to the pane that produced it. The one exception is a respawn, and a respawn is
    // recorded rather than guessed: the member carries the pane ids it has succeeded, written by
    // the one call that moves a member's key from a dead pane to a live one.
    //
    // This used to adopt any dead pane sharing the fingerprint, on the reasoning that a pane with
    // no live claimant must be a predecessor. It is not: quitting an agent made every conversation
    // running that harness in that directory inherit its words. A fingerprint is `[host, agent,
    // cwd]`, so several panes share one by design, and "no longer live" says nothing about which.
    function convLiveRowIsMine(t, mine, was) {
      const pid = t.pane_id || '';
      return !pid || pid === mine || (was || []).includes(pid);
    }

    // The predecessors of each member being drawn, by key. Read from the index rather than passed
    // in: these functions are handed member keys, and the link is a fact about the member.
    function convWasMap(keys) {
      const want = new Set(keys || []);
      const out = new Map();
      if (typeof loadConvIndex !== 'function') return out;
      for (const c of loadConvIndex()) {
        for (const m of (c && c.members) || []) {
          // Array-checked because this document is written by other browsers and by older builds.
          if (m && want.has(m.key) && Array.isArray(m.was)) out.set(m.key, m.was);
        }
      }
      return out;
    }
```

**Rethread the four call sites.** Each currently reads `const claimed = convLiveClaimed(keys);`;
each becomes `const was = convWasMap(keys);`, and every `convLiveRowIsMine(t, mine, claimed)` /
`convLiveOldestSeq(key, claimed)` / `convLiveOldest(key, claimed)` takes the member's own list
instead of the shared set:

| Line | Function | Change |
|------|----------|--------|
| 444 | `convLiveCanLoadOlder` | `convLiveOldestSeq(key, was.get(key))` |
| 464 | `convLiveOlder` | same, per key in its loop |
| 556 | `convOlderHtml` | `const was = convWasMap(keys)` |
| 768 | `convLiveEntries` | `convLiveRowIsMine(t, mine, was.get(k))` inside the per-key loop |

`convLiveOldest(key, claimed)` (line 426) and `convLiveOldestSeq(key, claimed)` (line 421) change
their second parameter from the claimed set to that member's `was` array and pass it straight
through to `convLiveRowIsMine`.

### `[MODIFY] web/src/conversation_pure.js` — the cap

Beside `CONV_ROSTER_MAX` (line 535):

```js
    // How many predecessors one member keeps. A pane respawned daily for a month is the case this
    // bounds; the oldest links are also the ones whose rows the record has long since pruned.
    const CONV_WAS_MAX = 20;
```

### `[MODIFY] web/src/start_dialog.js` — record the link

The respawn branch, lines 141-145. The member's key moves from the dead pane to the new one; record
where it came from in the same statement:

```js
          conv.members = continued && prior
            ? conv.members.map(m => m.key === prior.key
              ? Object.assign({}, m, {
                  key: next, label: prior.label || paneLabel(a),
                  // The pane this member continues. This is the only place a member's key moves
                  // from one pane to another, so it is the only place succession is a fact rather
                  // than an inference — and an inferred one is what drew a quit agent's words into
                  // a conversation it had never been in.
                  was: (m.was || []).concat(convKeyPaneId(prior.key))
                    .filter(Boolean).slice(-CONV_WAS_MAX),
                })
              : m)
            : (conv.members || []).concat(convMemberOf(a));
```

`convKeyPaneId` (`conversation_pure.js:457`) already exists for exactly this — pulling the pane id
back out of a member key — and is already imported into this file's scope.

No change to `parseConvIndex`: it rebuilds each conversation with `Object.assign({}, c, …)` and
passes member objects through by reference, so `was` survives a parse. `convWasMap` does the
validation, because this document is written by other browsers.

### `[MODIFY] tests/test_conv_live_sync.js` — the contract that changes

The test at line 281, **`a pane that has exited leaves its history to whoever holds the
fingerprint`**, asserts the behaviour being removed. It must be rewritten, not deleted — the
respawn case it protects is real, and the point of this change is that the case is now recorded
rather than assumed:

```js
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

test('a respawned member that recorded nothing inherits nothing', () => {
  // A member respawned before the link was recorded. Its own rows still draw; the dead pane's do
  // not, because nothing says the two are the same session. The local transcript is unaffected —
  // convContinueTranscript copied those entries at the time.
  reset([{host: 'local', pane_id: '%9', agent: 'claude', cwd: '/work/a'}]);
  recentIndex = [{id: 'c1', name: 'Arch', members: [{key: KEY_A2}]}];
  convLiveFetch([KEY_A2]);
  convLiveReceive({fingerprints: [FP_A], turns: [
    paneTurn(1, '%1', 1000, 'before the restart'), paneTurn(2, '%9', 1100, 'after it')]});
  assert.deepEqual(convLiveEntries([KEY_A2]).map(e => e.text), ['after it']);
});
```

The two tests above it — `a solo thread is this pane…` (258) and `a joint thread gives each member
its own rows…` (268) — pass unchanged, because both panes in them are live and were never being
decided by the fallback. Confirm that rather than assume it.

`reset()` does not clear `recentIndex`; add `recentIndex = [];` to it so a stale index cannot leak
between tests.

### `[MODIFY] tests/e2e/browser/conv_live.spec.js`

The browser guard described in Step 0.

## Verification

```bash
node --test tests/test_conv_live_sync.js      # step 0 red, then green
node --test tests/*.js
npx playwright test tests/e2e/browser/conv_live.spec.js
npx playwright test
.venv313/bin/python -m unittest discover -s tests -t tests   # untouched; relay/ has no diff
```

## Acceptance criteria

1. Step 0's test fails before the change with both texts and passes after with one.
2. `convLiveClaimed` no longer exists anywhere in `web/src/`.
3. `git diff --stat relay/` is empty.
4. The two rewritten respawn tests pass, and the two live-pane attribution tests pass unmodified.
5. Full `node --test tests/*.js` and the whole Playwright suite are green.
6. Against the user's own index: opening "Arbitrator - ARCH" shows no turns from `w24:p25` or
   `w24:p31`, and its agy member shows only `w24:p22`'s.

## Not in scope

Ending a session (`.../2026-08-24_ending_a_session_plan.md`) touches none of these files. The two
can land in either order.
