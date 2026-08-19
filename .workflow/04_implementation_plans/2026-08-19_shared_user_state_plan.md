# Implementation Plan — Shared user state across browsers

**Spec:** `.workflow/03_specs/2026-08-19_shared_user_state_spec.md` (behaviour is defined there;
this plan does not restate it).
**Decision:** `.workflow/02_architecture/decision_log/2026-08-19_shared_user_state.md`.
**Branch:** `feat/state-sync`, worktree `.claude/worktrees/feat+state-sync`.

## Goal

Four documents — pairs, conversation index, per-pane conversation choice, hidden set — stop being
per-browser. The relay stores them, hands them out on connect, and tells every other open client
when one changes.

---

## File-by-file

| Marker | Path | Size |
|---|---|---|
| `[NEW]` | `relay/user_state.py` | ~70 L — SQLite store. No websockets, no relay imports. |
| `[MODIFY]` | `relay/herdr_relay.py` | import, store init, `broadcast(except_ws=)`, two dispatch branches. ~55 L. |
| `[NEW]` | `web/src/state_sync.js` | ~150 L — the client half. |
| `[MODIFY]` | `web/index.html` | one `<script src>` tag. |
| `[MODIFY]` | `web/src/status_bar.js` | `state_get` on open, 3 router branches, error interception. ~15 L. |
| `[MODIFY]` | `web/src/pairs_ui.js` | one line in `savePairs`. |
| `[MODIFY]` | `web/src/conversation_store.js` | one line in `saveConvIndex`. |
| `[MODIFY]` | `web/src/conversation_view.js` | one line in `convSetView`. |
| `[MODIFY]` | `web/src/shortcuts.js` | one line at each of 3 `CONV_HIDDEN_KEY` writes. |
| `[NEW]` | `tests/test_user_state.py` | store + protocol rules. |
| `[NEW]` | `tests/test_state_sync.js` | the pure planning function. |
| `[MODIFY]` | `tests/e2e/browser/app_smoke.spec.js` | assert the new module booted. |
| `[MODIFY]` | `CLAUDE.md` | component row, `HERDR_STATE_DB`, protocol message list. |

---

## 1. `relay/user_state.py` [NEW]

Mirrors `conversation_log.py`'s shape: PEP 723 header, module-level DDL, one class, WAL.

```python
SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
  name TEXT PRIMARY KEY,
  rev  INTEGER NOT NULL,
  body TEXT    NOT NULL,
  at   INTEGER NOT NULL
);
"""

# Fixed, because an open key space makes this a blob store for anything a client names.
DOC_NAMES = ("pairs", "conversations", "conv_view", "conv_hidden")
MAX_BODY = 256 * 1024


class Conflict(Exception):
    """A put whose rev is not the stored one. Carries what the store actually holds."""
    def __init__(self, rev, body):
        super().__init__("stale rev")
        self.rev, self.body = rev, body


class UserState:
    def __init__(self, path): ...          # makedirs, connect(check_same_thread=False),
                                           # PRAGMA journal_mode=WAL, executescript(SCHEMA)
    def close(self): ...

    def get(self, names=None) -> dict:
        """{name: {"rev": int, "body": str|None}} for every known name asked for.
        Unknown names are dropped, not raised — see spec §2.1."""

    def put(self, name, rev, body) -> int:
        """Store and return the new rev. Raises ValueError on a bad name/body/rev,
        Conflict when `rev` is not the stored one."""
```

`put` runs the compare and the write in one `BEGIN IMMEDIATE` transaction. Two clients racing must
not both read rev 7 and both write rev 8.

Validation order is the spec's §2.3 table exactly: name, body-is-str, size, rev-is-int, then the
compare.

`get` on a name with no row returns `{"rev": 0, "body": None}` — never omits it.

## 2. `relay/herdr_relay.py` [MODIFY]

### 2a. Import — beside line 10

```python
from user_state import UserState, Conflict as StateConflict, DOC_NAMES as STATE_DOCS
```

### 2b. Store init — after the `conv_log` block (currently ends ~line 178)

```python
# Shared user state: the four documents that are facts about the work rather than about this
# browser. Unconditional, unlike the conversation log — a pair's name is a label the user typed
# into this app, not a record of what an agent said, so there is no data decision to defer to them.
STATE_DB = os.environ.get("HERDR_STATE_DB") or os.path.join(
    PROJECT_ROOT, ".herdr-remote", "state.sqlite3")
user_state = None
try:
    user_state = UserState(STATE_DB)
except (sqlite3.Error, OSError) as e:
    log.warning("Shared state store unavailable (%s): clients stay per-browser", e)
```

Same posture as the conversation log below it: unopenable is a warning, not a refusal to start.

### 2c. `broadcast` — line 648

```python
async def broadcast(msg, except_ws=None):
    data = json.dumps(msg)
    dead = set()
    for ws in list(clients):
        if ws is except_ws:
            continue
        ...
```

Existing callers pass one argument and are unchanged. The parameter exists because the writer of a
document must not receive its own body back: an echo landing after a second local edit reverts that
edit.

### 2d. Dispatch — a new `elif` pair, placed after the `push_unsubscribe` branch (ends line 1706),
before the unknown-type `else`.

```python
            elif msg_type == "state_get":
                if user_state is None:
                    await ws.send(json.dumps({"type": "state", "docs": {}}))
                    continue
                names = msg.get("names") or list(STATE_DOCS)
                docs = await asyncio.to_thread(user_state.get, names)
                await ws.send(json.dumps({"type": "state", "docs": docs}))
            elif msg_type == "state_put":
                if user_state is None:
                    await ws.send(json.dumps({
                        "type": "error", "message": "state store unavailable"}))
                    continue
                # Not behind HERDR_ENABLE_WRITE_EXT, for the same reason rename_pane is not:
                # that gate governs process creation, and this writes a label.
                name, body = msg.get("name", ""), msg.get("body")
                try:
                    new_rev = await asyncio.to_thread(
                        user_state.put, name, msg.get("rev"), body)
                except StateConflict as c:
                    await ws.send(json.dumps({"type": "state_conflict", "name": name,
                                              "rev": c.rev, "body": c.body}))
                    continue
                except ValueError as e:
                    await ws.send(json.dumps({"type": "error",
                                              "message": f"state_put: {e}"}))
                    continue
                audit("state_put", ip, device, name, f"rev={new_rev} bytes={len(body)}")
                await ws.send(json.dumps({"type": "state_ack", "name": name, "rev": new_rev}))
                await broadcast({"type": "state",
                                 "docs": {name: {"rev": new_rev, "body": body}}},
                                except_ws=ws)
```

`audit(...)` matches the existing call shape at line 1578 — check its signature and match it; do
not invent a fourth positional.

---

## 3. `web/src/state_sync.js` [NEW]

Loaded whole into a `vm` context by `tests/test_state_sync.js`, so **nothing at load time may touch
`document`, `ws`, or `localStorage`** — the same rule `pairs_pure.js:2` states. Definitions only.

```js
    // --- Shared user state ---
    // localStorage stays the working copy every render reads. This mirrors four of its keys to the
    // relay so a second browser sees the same fleet, and applies what other browsers write.

    const STATE_DOCS = {
      pairs:         { key: 'herdr_pairs' },
      conversations: { key: 'herdr_conversations' },
      conv_view:     { key: 'herdr_conv_view' },
      conv_hidden:   { key: 'herdr_conv_hidden' },
    };
    const STATE_DEBOUNCE = 500;

    let stateMode = 'idle';                 // idle | pulling | live | off
    const stateRev = {};                    // name -> last rev the relay told us. Memory only:
                                            // a reconnect re-learns them from state_get.
    const stateDirty = new Set();
    const stateTimers = {};
    const stateInFlight = new Set();

    // Pure. What to do with one document on the first answer after connect.
    //   'adopt'  — the relay holds it; take it, whatever we had
    //   'upload' — the relay holds nothing and we do; seed it
    //   'idle'   — neither of us has anything, or we already agree
    function stateSyncPlan(serverRev, serverBody, localBody) {
      if (serverRev > 0) return serverBody === localBody ? 'idle' : 'adopt';
      return localBody ? 'upload' : 'idle';
    }
```

Then the impure half:

| Function | Does |
|---|---|
| `stateSyncOpen()` | `stateMode='pulling'`; clear `stateRev`, `stateInFlight`; `ws.send({type:'state_get'})` |
| `stateSyncClose()` | `stateMode='idle'`; clear the debounce timers |
| `stateSyncMark(name)` | record dirty; restart that name's 500 ms timer; the timer calls `stateSyncFlush(name)` |
| `stateSyncFlush(name)` | in `live` only, and only when not already in flight: read the key **now**, send `state_put` with `stateRev[name] \|\| 0`, add to `stateInFlight`, clear dirty |
| `stateSyncReceive(msg)` | `state` → per doc: record rev; on the first answer run `stateSyncPlan` and adopt/upload; later answers adopt when the body differs. Then flush anything dirty and leave `stateMode='live'` |
| `stateSyncAck(msg)` | record rev, drop from in-flight, re-flush if dirty |
| `stateSyncConflict(msg)` | record rev, **apply** the body (with backup), drop from in-flight, **clear** dirty for that name — do not retry |
| `stateSyncNoteError(text)` | `/unknown message type/.test(text)` while `pulling` → `stateMode='off'`, return `true` so the caller swallows the toast; otherwise `false` |

`stateSyncApply(name, body)`:

```js
    function stateSyncApply(name, body) {
      const key = STATE_DOCS[name].key;
      let had = null;
      try { had = localStorage.getItem(key); } catch (e) { /* private mode */ }
      if (had === body) return false;
      try {
        // Overwriting what the user typed is allowed; losing it without a copy is not. One slot,
        // last overwrite only, never read back by this app and never synced.
        if (had) localStorage.setItem(key + '_local', had);
        if (body === null) localStorage.removeItem(key); else localStorage.setItem(key, body);
      } catch (e) { return false; }
      stateSyncRerender(name);
      return true;
    }
```

`stateSyncRerender(name)` is a switch over the four names calling exactly the spec §3.2 table's
functions, each guarded by `typeof f === 'function'` — this module loads before they are defined,
and the vm test defines none of them.

**A document that was just applied must not be marked dirty.** `stateSyncApply` never calls
`stateSyncMark`, and the owner modules' save functions are the only callers of `stateSyncMark` —
so the reload step in `stateSyncRerender` must not route through a save.
`loadPairs()` (`pairs_ui.js:3`) only reads, which is why it is the one named for `pairs`.

Expose on `window`: `stateSyncOpen`, `stateSyncClose`, `stateSyncMark`, `stateSyncReceive`,
`stateSyncAck`, `stateSyncConflict`, `stateSyncNoteError` — matching how the other modules publish
(`window.cueOn` in `cue.js:24`).

## 4. `web/index.html` [MODIFY]

One tag, after `src/utils.js` (line 5836) and before `src/pairs_pure.js`:

```html
  <script src="src/state_sync.js"></script>
```

`pairs_pure.js` must stay the first of the pure blocks; `state_sync.js` needs nothing from any
module at load time, so this slot is the earliest one that is safe.

## 5. `web/src/status_bar.js` [MODIFY]

`ws.onopen` (line 496) — after `announceSubscription();`:

```js
        stateSyncOpen();
```

`ws.onclose` (line 501) — first line of the body:

```js
        stateSyncClose();
```

`handleMessage` (line 542) — the `error` branch becomes:

```js
      if (msg.type === 'error') {
        // A relay older than this client answers state_get with "unknown message type". That is a
        // fact about the relay, not something to put in front of the user as a failure.
        if (stateSyncNoteError(msg.message)) return;
        convLiveNoteError(msg.message);
        showToast(msg.message || 'The relay refused that.');
      }
```

Three new branches beside the others:

```js
      else if (msg.type === 'state') { stateSyncReceive(msg); }
      else if (msg.type === 'state_ack') { stateSyncAck(msg); }
      else if (msg.type === 'state_conflict') { stateSyncConflict(msg); }
```

## 6. Owner modules [MODIFY] — one line each

| File | Function | Line to add, last in the function |
|---|---|---|
| `web/src/pairs_ui.js:4` | `savePairs()` | `stateSyncMark('pairs');` |
| `web/src/conversation_store.js:875` | `saveConvIndex()` | `stateSyncMark('conversations');` |
| `web/src/conversation_view.js:71` | `convSetView()` | `stateSyncMark('conv_view');` |
| `web/src/shortcuts.js:399` | hidden-set write | `stateSyncMark('conv_hidden');` |
| `web/src/shortcuts.js:427` | hidden-set write | `stateSyncMark('conv_hidden');` |
| `web/src/shortcuts.js:805` | hidden-set write | `stateSyncMark('conv_hidden');` |

Read the three `shortcuts.js` sites before editing — if they already funnel through one helper,
mark there once instead of three times. Do not add a wrapper to create that funnel; if they are
three separate `setItem` calls, three marks is the smaller diff.

Each mark goes **after** the `try/catch` around `setItem`, outside it: a `localStorage` failure in
private mode must not stop the relay from getting the document, and `stateSyncMark` throwing must
not be swallowed by a catch written for a quota error.

---

## 7. Tests

### `tests/test_user_state.py` [NEW]

`unittest`, `tempfile.TemporaryDirectory`, picked up by discover. Cases:

1. `get(['pairs'])` on an empty store → `{'pairs': {'rev': 0, 'body': None}}`.
2. `put('pairs', 0, '{}')` → `1`; `get` → rev 1, body `'{}'`.
3. `put('pairs', 0, '{}')` again → `Conflict`, `c.rev == 1`, `c.body == '{}'`.
4. `put('nope', 0, '{}')` → `ValueError`.
5. `put('pairs', 0, 123)` → `ValueError` (body not a string).
6. `put('pairs', 1, 'x' * (256*1024 + 1))` → `ValueError`, and the stored rev is still 1.
7. `get()` with no argument returns all four names.
8. Two `UserState` handles on one file: A puts at rev 1, B's put at rev 1 raises `Conflict`.

### `tests/test_state_sync.js` [NEW]

Same harness as `tests/test_pairs.js` — read `web/src/state_sync.js`, run it in a `vm` context with
no `document`/`localStorage`/`ws` defined, extract `stateSyncPlan` and `STATE_DOCS`.

1. `stateSyncPlan(0, null, null)` → `'idle'`
2. `stateSyncPlan(0, null, '{"pairs":[]}')` → `'upload'`
3. `stateSyncPlan(3, '{"a":1}', null)` → `'adopt'`
4. `stateSyncPlan(3, '{"a":1}', '{"a":1}')` → `'idle'`
5. `stateSyncPlan(3, '{"a":1}', '{"b":2}')` → `'adopt'`
6. `Object.keys(STATE_DOCS)` is exactly the four names, and none of their `key`s contains `token`
   or `relay_url` — the allowlist is the security boundary, so assert on it.

Evaluating the file at all is the load-time-purity check: a stray `localStorage` at top level
throws in the vm.

### `tests/e2e/browser/app_smoke.spec.js` [MODIFY]

Add `stateSyncMark` to whatever list of globals that suite already asserts on. If it asserts by
another mechanism, follow it — the point is that a reordered `<script>` tag fails a test rather
than the app.

---

## 8. Verification

```bash
cd .claude/worktrees/feat+state-sync

.venv313/bin/python -m unittest discover -s tests -t tests
node --test tests/*.js
npx playwright test

# Round trip by hand, two browsers on one relay:
uv run relay/herdr_relay.py
#   1. open the app twice, rename a pair in one, watch the other
#   2. clear one browser's localStorage entirely, reload, confirm the pairs come back
#   3. stop the relay, rename a pair, confirm no console error; restart, confirm it survives
sqlite3 .herdr-remote/state.sqlite3 'select name, rev, length(body) from docs;'

# Old-relay path: run the relay from main against this branch's web/
git -C . stash && uv run relay/herdr_relay.py   # or point the app at a relay built from main
#   expect one console line, no toast, app behaves as today
```

## 9. Acceptance

The spec's §6 list, plus:

- `grep -n "localStorage" web/src/state_sync.js` shows reads and writes of only the four mirrored
  keys and their `_local` backups. No `herdr_relay_token`, no `herdr_relay_url`.
- `python -m unittest discover` and `node --test tests/*.js` both green, including the suites this
  change does not touch.
- `python3 scripts/build.py` produces a `web/dist/index.html` containing `stateSyncMark`.
- `CLAUDE.md` lists `HERDR_STATE_DB`, `relay/user_state.py`, and the four new message types in the
  protocol section.

## 10. Deferred, not in this plan

- Syncing organization state (sections order, agent order, pinned tabs, dock MRU). Same mechanism,
  four more names, no new design. Ship the rosters first.
- Per-entity merge instead of whole-document last-write-wins. Only worth it if the conflict toast
  turns out to be a thing users actually hit.
- A `_local` backup the UI can offer to restore. Today it is a key you recover by hand, which is
  the right amount of machinery for a case that should be rare.


---

## 11. As built

Shipped on `feat/state-sync`. Where it differs from the plan above, and why.

| Change | Why |
|---|---|
| Seven `stateSyncMark` sites, not six | `shortcuts.js:814` writes `herdr_conv_view` directly in `deleteConversation`, so `conv_view` has two write paths and not one. |
| Each mark guarded `if (typeof stateSyncMark === 'function')` | The house pattern from `saveConvIndex`'s `forgetConvComposers` guard. Without it every vm slice that loads `pairs_ui.js` or `conversation_store.js` throws — `tests/test_pairs.js` caught it. |
| **Dirty wins over adopt** on the first answer (spec §3.2 rule 2) | Found by `tests/test_state_sync.js`: an edit made between `state_get` and its answer was reverted by the seeding rule, because the answer was already in flight when the user acted. |
| **`stateSyncFlushAll` on `pagehide` / `visibilitychange`** (spec §3.4) | Found by `conversation.spec.js:493`: a delete followed by a reload inside the 500 ms debounce was lost, and the deleted conversation came back. On a phone every switch away from the browser is this case. |
| `tests/e2e/browser/state_sync.spec.js` [NEW], 7 tests | The plan only added a line to `app_smoke`. A vm slice fakes every message that matters here, so the round trip needs a real relay. Note the trap the file documents: `context.newPage()` is a second *tab* sharing one `localStorage`, so the second browser has to be its own `BrowserContext` or every assertion passes against a relay that stored nothing. |
| `fixtures.js`: clear the `docs` rows before every test | The relay is per worker and this store is durable, so without it one spec's pairs and conversations leak into every spec that runs after it — which is what broke `tab_pairs`, `sections`, `summary_detect` and `hang_controls` on the first full run. |
| `fixtures.js`: `HERDR_ARBITER_DB` and `HERDR_STATE_DB` named per worker | Pre-existing bug, fixed in passing. `HERDR_STATE_DIR` stood there and is read by nothing in the relay, so the browser suite's conversation log was writing to `<repo>/.herdr-remote/arbitration.sqlite3` — one file shared by every worker, and on a developer's machine the record their own relay is keeping. |

| **Sync is bound to one socket** (spec §3.1) | Two races found in review after the first green run. `connect()` assigns the new socket to the global before it opens, so a debounce timer firing in that gap handed a `CONNECTING` socket a frame — a throw, and a dropped edit. The module now sends on the socket it learned its revisions from, and `status_bar.js` captures `const socket = ws` and guards every handler with `if (ws !== socket) return`, so a stale socket's close cannot take the replacement's sync offline. |
| **In-flight and thrown writes go back to dirty** (spec §3.4) | `send()` returning is not an ack. On close, everything in flight is re-marked so the reconnect's `state_get` learns the revision and retries; the `catch` around `send` does the same. Without it both paths lost the edit silently. |
| **Opening a socket recovers in-flight writes too** (spec §3.4) | The close path alone was not enough. A socket replaced while still open — `connect()` by hand, which is what a manual reconnect is — produces a close event that the §3.1 stale guard drops on purpose, so nothing ran to re-mark what that socket had accepted and never acknowledged. `stateSyncOpen` now re-marks before it clears. |
| **A retry the relay already has is dropped** (spec §3.2) | The retry above, uncorrected, re-sent a body the relay already held whenever the write landed and only the ack was lost — advancing the revision and broadcasting an unchanged document to every browser, once per reconnect. On a phone that is often. |

Test counts after: 402 Python (`unittest discover`), 422 Node (`node --test tests/*.js`),
369 Playwright. All green.
