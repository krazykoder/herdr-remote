# Plan — A spawn that outlives the view it was asked from

**2026-08-29 · Phase 4 · Implementer**

Obeys `.workflow/03_specs/2026-08-29_durable_spawn_binding_spec.md` and
`.workflow/02_architecture/decision_log/2026-08-29_a_spawn_that_outlives_the_view.md`.

## Goal

Three changes to the conversation window, in one coherent task because the first one moves the
machinery the other two touch.

1. **S1** — the binding between a start and the member it continues moves out of four JavaScript
   globals and a single `sessionStorage` slot, into the conversation index, where it is synced and
   readable by every tab. Net deletion: the whole `CONV_RESPAWN_KEY` apparatus goes.
2. **S2** — `Restart all` restarts paused members, the way each row's own `Restart` already does.
3. **S3** — a start that lands while the conversation window is open does not navigate to the pane.

**No relay change. No wire change.** The relay already carries `ref` on every snapshot
(`relay/herdr_relay.py:1053, 2341, 3524-3573`) and that is the whole backend half of this.

---

## File-by-file

| Marker | Path | What |
|---|---|---|
| `[MODIFY]` | `web/src/conversation_store.js` | the pending-note store, `convLandMember`, `convLandPending` |
| `[MODIFY]` | `web/src/start_dialog.js` | conv branch calls `convLandMember`; S3 navigation guard |
| `[MODIFY]` | `web/src/shortcuts.js` | delete the sessionStorage respawn apparatus; rewire `convRespawn`, `convStartClaimed`, `convRestartAll`, `convRestartStep` |
| `[MODIFY]` | `web/src/conv_dock.js` | `New agent` names its start and notes it |
| `[MODIFY]` | `web/src/status_bar.js` | snapshot calls `convLandPending` |
| `[NEW]` | `tests/test_conv_pending.js` | the note store and the landing driver |
| `[MODIFY]` | `tests/test_start_dupe.js` | the conv branch no longer opens a terminal from the conversation window |
| `[MODIFY]` | `tests/e2e/browser/conversation.spec.js` | S2 and S3 in a real browser |

---

## 1. `[MODIFY] web/src/conversation_store.js`

Insert immediately **after** `saveConvIndex` (currently ends at line 1013), before the
`// --- Conversation membership ---` block.

```javascript
    // --- A start in flight ---
    // Which pane a start will land on is the relay's answer to one socket, and which *member* it
    // was for is this browser's own memory of the press. Neither survives what readers actually do
    // between the two — change view, open another agent, open the Start dialog, reload, or press
    // Restart on a second member. So the memory is written where conversations already live: in
    // the index, on the member it will continue, synced with it. Any tab that then sees a pane
    // carrying the noted `ref` finishes the job.
    //
    // A note is about membership and nothing else. The opening words stay on the fast path, where
    // the tab that asked still holds them — two tabs holding one note must not both speak.
    const CONV_PENDING_MS = 120000;

    function convPendingLive(p) {
      return !!(p && p.ref && Date.now() - (Number(p.at) || 0) <= CONV_PENDING_MS);
    }

    // Every expired note gone, in one pass. Called by the writers below, so a note whose start
    // never produced a pane leaves on the next press rather than sitting in a synced document for
    // ever. Mutates in place: the caller is about to save the same array.
    function convPrunePending(items) {
      for (const c of items || []) {
        if (!c) continue;
        for (const m of c.members || []) {
          if (m && m.pending && !convPendingLive(m.pending)) delete m.pending;
        }
        if (Array.isArray(c.pending)) {
          c.pending = c.pending.filter(convPendingLive);
          if (!c.pending.length) delete c.pending;
        }
      }
      return items;
    }

    // Written before the send, never after: the answer is the thing a reload loses, so the note has
    // to be stored by the time there is anything to lose. `key` names the member this start
    // continues; without one the start joins as a new member and the note goes on the conversation.
    function convNotePending(convId, ref, key, label) {
      if (!convId || !ref) return false;
      const items = convPrunePending(loadConvIndex());
      const conv = items.find(c => c.id === convId);
      if (!conv) return false;
      if (key) {
        const m = (conv.members || []).find(x => x.key === key);
        if (!m) return false;
        m.pending = {ref: ref, at: Date.now()};
      } else {
        conv.pending = (conv.pending || [])
          .concat([{ref: ref, at: Date.now(), label: label || ''}]);
      }
      saveConvIndex(items);
      return true;
    }

    // The note for a ref, wherever it is. `key` is empty for one that joins rather than continues.
    function convFindPending(ref) {
      if (!ref) return null;
      for (const c of loadConvIndex()) {
        for (const m of (c && c.members) || []) {
          if (m && convPendingLive(m.pending) && m.pending.ref === ref) {
            return {conv: c, key: m.key};
          }
        }
        for (const p of (c && c.pending) || []) {
          if (convPendingLive(p) && p.ref === ref) return {conv: c, key: ''};
        }
      }
      return null;
    }

    // This member's own note, so a second press can tell the first one is still in flight.
    function convMemberPending(convId, key) {
      const conv = loadConvIndex().find(c => c.id === convId);
      const m = conv && (conv.members || []).find(x => x.key === key);
      return m && convPendingLive(m.pending) ? m.pending : null;
    }

    // Every ref anything is waiting on. Read by convStartClaimed — a pane a start is about to
    // continue a thread onto is not a fresh pane — and by the restart queue's gate.
    function convPendingRefs() {
      const out = new Set();
      for (const c of loadConvIndex()) {
        for (const m of (c && c.members) || []) {
          if (m && convPendingLive(m.pending)) out.add(m.pending.ref);
        }
        for (const p of (c && c.pending) || []) if (convPendingLive(p)) out.add(p.ref);
      }
      return out;
    }

    // Drop one note by ref, wherever it is, expiring the rest on the way past. Called by whoever
    // landed it — including the fast path, which is why a recovery finds nothing left to do.
    function convDropPending(ref) {
      if (!ref) return false;
      const items = loadConvIndex();
      let hit = false;
      for (const c of items) {
        for (const m of (c && c.members) || []) {
          if (m && m.pending && m.pending.ref === ref) { delete m.pending; hit = true; }
        }
        if (Array.isArray(c.pending) && c.pending.some(p => p && p.ref === ref)) {
          c.pending = c.pending.filter(p => p && p.ref !== ref);
          if (!c.pending.length) delete c.pending;
          hit = true;
        }
      }
      if (hit) saveConvIndex(convPrunePending(items));
      return hit;
    }

    // A pane joins a conversation as the member a start was made for: the transcript carried over
    // the seam, the pair repointed, the roster's row moved from the old key to this pane's.
    //
    // The whole of the succession and nothing about what happens on screen. Its two callers
    // disagree about that — one is a press the reader just made, the other a recovery that must
    // never move anybody — so neither the opening prompt, the toast, nor opening the terminal
    // belongs here.
    async function convLandMember(a, convId, replaceKey, ref) {
      const next = a && convMemberKey(a);
      if (!next || !convId) return null;
      // The pair goes with it. A restart is the same colleague in a new pane, and the pair record
      // names panes by id — so without this the strip in the surviving partner reports the pair
      // stale and drops the switch, the name and the badge.
      if (replaceKey) repointPair(convKeyPaneId(replaceKey), a);
      // The copy happens before the index is read, and the index is read again after it. The
      // recorder writes members' previews on every poll, so an index loaded before an await and
      // saved after it puts back a snapshot taken seconds ago — and the copy is the one step here
      // that waits on a database. A refusal (quota, a blocked store) falls back to joining as a
      // new member rather than dropping the pane out of the conversation altogether.
      const replacing = ((loadConvIndex().find(c => c.id === convId) || {}).members || [])
        .find(m => m.key === replaceKey);
      const continued = replacing &&
        await convContinueTranscript(replacing.key, next, replacing.label).catch(() => false);
      const items = loadConvIndex();
      const conv = items.find(c => c.id === convId);
      if (!conv) return null;
      const prior = (conv.members || []).find(m => m.key === (replacing || {}).key);
      // Whether this pane is already one of this conversation's members. The fallback below joins
      // as a new member, which is right for a pane the conversation has never held and wrong for
      // one it already names: herdr recycles pane ids, and a replace intent that no longer matches
      // — a second landing, a member moved by the restart before it — would otherwise append a
      // second row for a key that is already in the list.
      const already = (conv.members || []).some(m => m.key === next);
      conv.members = continued && prior
        ? conv.members.map(m => m.key === prior.key
          ? Object.assign({}, m, convWasFpPatch(m, prior.key, next), {
              key: next, label: prior.label || paneLabel(a),
              // The pane this member continues. This is the only place a member's key moves from
              // one pane to another, so it is the only place succession is a fact rather than a
              // guess — and the guess it replaces handed a quit agent's words to every
              // conversation running the same harness in the same directory.
              was: (m.was || []).concat(convKeyPaneId(prior.key))
                .filter(Boolean).slice(-CONV_WAS_MAX),
            })
          : m)
        : (already ? conv.members : (conv.members || []).concat(convMemberOf(a)));
      // The note is spent. Cleared in the same write as the succession it described, so no tab can
      // read an index where the member has moved and the note still says it is coming.
      if (ref) {
        for (const m of conv.members) if (m && m.pending && m.pending.ref === ref) delete m.pending;
        if (Array.isArray(conv.pending)) {
          conv.pending = conv.pending.filter(p => p && p.ref !== ref);
          if (!conv.pending.length) delete conv.pending;
        }
      }
      saveConvIndex(convPrunePending(items));
      // This conversation and not merely "on": the new pane is a member of exactly one so far, but
      // a respawn into a grouping the user chose must open on that grouping.
      convSetView(a, conv.id);
      return conv;
    }

    // Every note against every live pane, on every snapshot. Does nothing on almost all of them:
    // there is a note only in the couple of minutes after a start was made for a conversation.
    //
    // Never opens anything and never says anything to the pane. This is the path taken when the
    // press that made the note is no longer on screen — a different view, a different agent, a
    // different tab, or a reload — and in every one of those the reader is somewhere else and did
    // not ask to be moved. The opening words belong to the fast path, which still has them.
    async function convLandPending() {
      if (!agents.length) return;
      // The relay's document may not have arrived. Landing a note against an empty index would
      // find nothing and drop nothing, but reading it is pointless work on every poll.
      if (typeof stateSyncPending === 'function' && stateSyncPending()) return;
      for (const a of agents) {
        if (!a || !a.ref || convLanding.has(a.ref)) continue;
        const found = convFindPending(a.ref);
        if (!found) continue;
        convLanding.add(a.ref);
        try {
          const conv = await convLandMember(a, found.conv.id, found.key, a.ref);
          if (conv) {
            showSpawnStatus(`${paneLabel(a)} continued "${conv.name}".`, 'success');
            renderConversations();
            if (typeof renderConvStandalone === 'function') renderConvStandalone(false);
          }
        } finally { convLanding.delete(a.ref); }
      }
    }

    // One landing per ref at a time. convLandMember awaits a database, and the poll is 3s.
    const convLanding = new Set();
```

> `convLanding` is declared after its use inside the `async function` above on purpose — the
> function body runs long after the `const` is initialised. Keep the declaration where the snippet
> puts it or hoist it above `convLandPending`; either is correct, do not move it into a `var`.

---

## 2. `[MODIFY] web/src/start_dialog.js`

### 2a. The conv branch delegates

Replace the whole block from `      // A respawn asked from a conversation replaces the ended member` (line 159) through the `return;` at line 222 with:

```javascript
      // A respawn asked from a conversation replaces the ended member in that conversation. The
      // old terminal is gone, but its local thread is continued under this new pane's key. The
      // succession itself is convLandMember's — this is the fast path into it, and it is the only
      // one that still holds the opening words.
      if (intent && intent.conv) {
        const conv = await convLandMember(a, intent.conv, intent.replace || '', intent.ref || '');
        // Started with something to say to it. The send goes through the same path a typed message
        // does, so the conversation records it as the user's — it is, and a first instruction that
        // was missing from the thread would be a turn nobody could see the start of. After the
        // membership above, so the thread it is recorded into is the one it was started for.
        if (prompt) sendTextTo(a.pane_id, prompt);
        // Not while the conversation window is up. A start made from a conversation is a request
        // for another colleague in it, not a request to stop reading it — and the member has just
        // appeared in the roster behind this.
        if (!convWindowOpen()) openTerminal(a.pane_id);
        else if (typeof renderConvStandalone === 'function') renderConvStandalone(false);
        showSpawnStatus(conv ? `${a.label || a.agent || 'Session'} continued "${conv.name}".`
          : `${a.label || a.agent || 'Session'} started.`, 'success');
        return;
      }
```

### 2b. The generic branch honours the same rule

Replace line 226:

```javascript
      if (intent === 'open' || !activePane) openTerminal(a.pane_id);
```

with:

```javascript
      // Never over a pane the user has since opened themselves — the start was a while ago in
      // phone terms, and yanking them out of what they are reading is worse than not landing.
      // Nor out of the conversation window, which is the same rule about the same reader: a panel
      // is not `activePane`, so without naming it here every start made from one navigated away.
      // Unless the start was a Duplicate, which is a request made from that very pane.
      if (intent === 'open' || (!activePane && !convWindowOpen())) openTerminal(a.pane_id);
```

### 2c. The predicate

Add above `openPendingStart` (before line 103):

```javascript
    // Whether the reader is in the conversation window. Read off the screen by openPanelId, which
    // is what that function is for — and guarded, because this module loads before the one that
    // defines it.
    function convWindowOpen() {
      return typeof openPanelId === 'function' && openPanelId() === 'convView';
    }
```

---

## 3. `[MODIFY] web/src/shortcuts.js`

### 3a. Delete the sessionStorage apparatus

Delete lines **1148–1240** entirely — from the comment `// A restart names itself, so the pane it makes can be found again by equality` through the end of `convResumeRespawn`. That removes:

`CONV_RESPAWN_KEY`, `CONV_RESPAWN_MS`, `convRespawnResuming`, `rememberConvRespawn`,
`heldConvRespawn`, `forgetConvRespawn`, `convRespawnPane`, `convAdoptRespawn`, `convResumeRespawn`.

Keep **only** `convRespawnRef`, moved to the top of that region with a shortened comment:

```javascript
    // A start names itself, so the pane it makes can be found again by equality rather than by
    // resemblance. The relay stamps this on the pane and carries it on every snapshot; what it
    // *means* is written into the conversation index, which is what survives a reload, a second
    // tab, and the reader walking away from this window — see convNotePending.
    function convRespawnRef() {
      return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
```

### 3b. `convStartClaimed` (was line 1186)

```javascript
    // The pane a start in flight will land on, so nothing else claims it first. The recorder files
    // every unreferenced pane into an auto conversation on the next snapshot, and a pane filed
    // there is a pane some conversation already names — which is exactly what stops the succession
    // continuing the thread onto it.
    function convStartClaimed(a) {
      if (!a) return false;
      if (typeof pendingStart !== 'undefined' && pendingStart && a.pane_id === pendingStart) return true;
      return !!(a.ref && typeof convPendingRefs === 'function' && convPendingRefs().has(a.ref));
    }
```

### 3c. `convRespawn` — the held-note branch and the note write

Replace the block at the top of `convRespawn` (currently lines 1247–1258, `const held = heldConvRespawn(); … }`) with:

```javascript
      // This member's own restart, already in flight — the press before this one, whose answer
      // went down with the tab or was spent somewhere else. Continued onto the pane it made rather
      // than starting a second agent beside it; and if that pane is not up yet, left alone, because
      // the note is what will land it.
      const held = convMemberPending(conv.id, key);
      if (held) {
        const back = agents.find(x => x.ref === held.ref);
        if (back) {
          showSpawnStatus(`"${paneLabel(back)}" is already running — continuing "${conv.name}".`,
                          'busy');
          convLandMember(back, conv.id, key, held.ref).then(() => {
            if (typeof renderConvStandalone === 'function') renderConvStandalone(false);
          });
        } else {
          showSpawnStatus(`A restart of this member is already on its way.`, 'busy');
        }
        return;
      }
```

Replace the last three lines of `convRespawn`:

```javascript
      msg.ref = convRespawnRef();
      rememberConvRespawn(conv.id, key, msg.ref);
      ws.send(JSON.stringify(msg));
```

with:

```javascript
      // Named and written down before the send, not after: the answer is what a reload, a view
      // change or a second start loses, so the note has to be in the index by the time there is
      // anything to lose. The intent carries the same ref, so whichever of the two paths lands it
      // clears the same note.
      msg.ref = convRespawnRef();
      startIntent.ref = msg.ref;
      convNotePending(conv.id, msg.ref, key, '');
      ws.send(JSON.stringify(msg));
```

### 3d. `convRestartAll` — S2

```javascript
    function convRestartAll() {
      const conv = loadConvIndex().find(c => c.id === convViewId);
      if (!conv) return;
      // Every member the record can restart, live or paused. A row's own Restart already restarts
      // a paused member — it is the same control for both halves of a row's life — and the batch
      // asking the same question of everyone at once must give the same answer. The old `live`
      // filter meant a conversation whose sessions had all been paused, which is precisely the
      // conversation somebody presses this on, reported that there was nothing here to restart.
      convRestartQueue = (conv.members || []).map(m => m.key)
        .filter(k => canRespawn(((convViewRecs || []).find(r => r.key === k) || {}).spawn));
      if (!convRestartQueue.length) { showToast('Nothing here can be restarted.', 'info'); return; }
      showSpawnStatus(`Restarting ${convRestartQueue.length} pane` +
                      `${convRestartQueue.length === 1 ? '' : 's'}…`, 'busy');
      convRestartStep();
    }
```

### 3e. `convRestartStep` — the gate

```javascript
    function convRestartStep() {
      if (!convRestartQueue.length) return;
      // A start of any kind in flight, this queue's or somebody else's. Both clear themselves —
      // the note by its own deadline — so a member whose start never produced a pane costs the
      // queue a pause rather than the rest of the list.
      if (typeof pendingStart !== 'undefined' && pendingStart) return;
      if (typeof convPendingRefs === 'function' && convPendingRefs().size) return;
      convRestart(convRestartQueue.shift());
    }
```

---

## 4. `[MODIFY] web/src/conv_dock.js`

In the `New agent` submit (around line 1010), after the `startIntent` assignment:

```javascript
      startIntent = newAgentFor
        ? {arb: {slot: newAgentFor, conv: convViewId}} : {conv: convViewId};
      // A member started into a conversation is bound to it the same way a restart is: the start
      // names itself and the conversation writes down what that name means. Without it this was the
      // one start with no durable binding at all — leave the window before it lands and the pane
      // was filed into an auto conversation of its own.
      // Not for the arbitration slot: that start is adopted by the dialog, not by the roster.
      if (!newAgentFor && convViewId) {
        msg.ref = convRespawnRef();
        startIntent.ref = msg.ref;
        convNotePending(convViewId, msg.ref, '', msg.label || newAgentKind);
      }
```

---

## 5. `[MODIFY] web/src/status_bar.js`

Replace lines 868–870:

```javascript
        // A restart whose answer was lost with the tab that asked for it, picked up by the id that
        // start named itself with. After openPendingStart, so a start this tab is still holding
        // the answer for lands the ordinary way.
        if (typeof convResumeRespawn === 'function') convResumeRespawn();
```

with:

```javascript
        // Any start made for a conversation whose answer this tab is not holding — because the
        // reader changed view, opened another agent, reloaded, or is in a second tab — picked up
        // by the id the start named itself with. After openPendingStart, so a start this tab does
        // still hold the answer for lands the ordinary way, with its opening words.
        if (typeof convLandPending === 'function') convLandPending();
```

---

## 6. `[NEW] tests/test_conv_pending.js`

`node --test tests/test_conv_pending.js`. Boot `conversation_store.js` in a vm context the way
`tests/test_conv_spawn.js` does, with a stub `localStorage` backed by a plain object.

Cases, one assert each:

| Test | Asserts |
|---|---|
| `a note is written on the member it will continue` | after `convNotePending(c, 'r1', 'k1')`, `loadConvIndex()[0].members[0].pending.ref === 'r1'` |
| `a note with no member key goes on the conversation` | `conv.pending[0].ref === 'r1'` |
| `an expired note is not live and is pruned on the next write` | set `at` to `Date.now() - 200000`, then `convPendingRefs().size === 0` and a later `convNotePending` leaves the stale one gone |
| `two members hold their own notes` | both refs in `convPendingRefs()` |
| `landing moves the member key and clears the note` | `convLandMember(pane, c, 'k1', 'r1')` → members\[0].key is the pane's key, `members[0].pending` undefined |
| `landing with no replace key joins as a new member` | roster grows by one, conversation-level note gone |
| `landing twice on the same pane does not add a second row` | roster length unchanged on the second call |
| `convFindPending finds a conversation-level note` | returns `{conv, key: ''}` |

## 7. `[MODIFY] tests/test_start_dupe.js`

Add one case to the existing conv-intent coverage: with `openPanelId` stubbed to return
`'convView'`, `openPendingStart` under a `{conv, replace}` intent **does not** call `openTerminal`;
with it returning `''`, it does. Same for the generic branch with `activePane` null.

## 8. `[MODIFY] tests/e2e/browser/conversation.spec.js`

Two cases, beside the existing respawn tests (which seed `canRespawn`'s gates around line 1133):

- **S2** — a conversation whose members are all paused: `Restart all` arms, fires, and the spawn
  status reads `Restarting 2 panes…` rather than the `Nothing here can be restarted.` toast.
- **S3** — with the conversation window open, a restart that lands leaves `#convView` displayed and
  does not open the terminal.

---

## Verification

```bash
source .venv313/bin/activate

# The new slice and everything that touches the index or the start path
node --test tests/test_conv_pending.js
node --test tests/test_conv_spawn.js tests/test_conv_swap.js tests/test_conversation.js \
            tests/test_conv_live_sync.js tests/test_start_dupe.js tests/test_state_sync.js \
            tests/test_launcher_exec.js tests/test_pairs.js

# The whole frontend slice suite, because the index is read by most of it
node --test tests/*.js

# Nothing here is Python, but the boot guard is
.venv313/bin/python -m unittest discover -s tests -t tests

# The page actually boots with the script order unchanged, and the two behaviours in a browser
npx playwright test tests/e2e/browser/app_smoke.spec.js
npx playwright test tests/e2e/browser/conversation.spec.js
npx playwright test tests/e2e/browser/conv_live.spec.js tests/e2e/browser/state_sync.spec.js

# The single-file build still produces a page
python3 scripts/build.py
```

Manual check for S1, which no automated suite reaches (it needs two browsers):

1. Open the conversation window on a conversation with two live members.
2. Press `Restart` on one member and confirm.
3. **Immediately** press the chevron out of the window and open another agent's pane.
4. When the new pane appears in the snapshot, go back to the conversation.
   The member must be on the new pane — same name, same row, thread continuing across the seam —
   and there must be no extra auto conversation holding it.
5. Repeat step 2, then reload the tab before the pane appears. Same result.
6. Repeat step 2 with a second browser open on the same relay. The second browser lands it.

---

## Acceptance criteria

- [ ] S1.1–S1.9 hold. In particular: pressing Restart and then leaving the conversation window, opening the Start dialog, switching agents, or reloading all end with the member on the new pane.
- [ ] `CONV_RESPAWN_KEY`, `heldConvRespawn`, `convAdoptRespawn` and `convResumeRespawn` no longer exist anywhere in `web/src/`. `grep -rn "CONV_RESPAWN\|heldConvRespawn\|convResumeRespawn" web/src/` returns nothing.
- [ ] `Restart all` on a conversation with no live members restarts every restartable member, and only says `Nothing here can be restarted.` when no member's record satisfies `canRespawn`.
- [ ] A start that lands while `#convView` is displayed never calls `openTerminal`; the roster redraws with the new member in it. Every other start's navigation is byte-for-byte the behaviour it had.
- [ ] `convLandPending` never opens a pane and never sends text.
- [ ] No change to `relay/`. `git diff --stat relay/` is empty.
- [ ] `node --test tests/*.js` and `npx playwright test` pass, including the suites that were already passing.
