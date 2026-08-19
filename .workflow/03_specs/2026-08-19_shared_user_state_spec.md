# Spec — Shared user state across browsers

**Decision:** `.workflow/02_architecture/decision_log/2026-08-19_shared_user_state.md`.
Behaviour only; file-by-file changes are in
`.workflow/04_implementation_plans/2026-08-19_shared_user_state_plan.md`.

---

## 1. Documents

Exactly four names are storable. Anything else is refused.

| Name | Mirrors `localStorage` key | Owner module | Shape (relay never inspects it) |
|---|---|---|---|
| `pairs` | `herdr_pairs` | `web/src/pairs_ui.js` | `{version, pairs:[…]}` |
| `conversations` | `herdr_conversations` | `web/src/conversation_store.js` | `{version, items:[…]}` |
| `conv_view` | `herdr_conv_view` | `web/src/conversation_view.js` | `{paneKey: convId}` |
| `conv_hidden` | `herdr_conv_hidden` | `web/src/shortcuts.js` | `{convId: […]}` |

A document is a **string**. The relay stores it verbatim and returns it verbatim. It is never
parsed, never merged, never migrated relay-side.

### 1.1 Revisions

`rev` is a non-negative integer.

- A name that has never been written has `rev = 0` and body `null`.
- A successful write stores `rev + 1`.
- `rev` is assigned by the relay and is monotonic per name. It is never reused, never reset by a
  write, and resets only when the database file is deleted.

---

## 2. Protocol

Additive. No existing message changes shape.

### 2.1 `state_get` (client → server)

```json
{"type": "state_get", "names": ["pairs", "conversations", "conv_view", "conv_hidden"]}
```

- `names` optional. Absent or empty means all four.
- Unknown names in the list are ignored, not an error — a newer client asking an older relay for a
  name it does not have must degrade, not fail.

Answer, **to the asking client only**:

```json
{"type": "state", "docs": {"pairs": {"rev": 7, "body": "{\"version\":1,…}"},
                           "conv_view": {"rev": 0, "body": null}}}
```

Every requested known name appears, including ones at `rev 0`.

### 2.2 `state_put` (client → server)

```json
{"type": "state_put", "name": "pairs", "rev": 7, "body": "{\"version\":1,…}"}
```

`rev` is the revision the client believes the server holds — the last one it was told, or `0` if it
has never been told.

**Accepted** when `rev` equals the stored revision. The relay stores `body` at `rev + 1` and:

1. answers the writer `{"type":"state_ack","name":"pairs","rev":8}`
2. broadcasts `{"type":"state","docs":{"pairs":{"rev":8,"body":"…"}}}` to **every other**
   connected client. The writer is excluded: it already has this body, and an echo arriving after a
   second local edit would revert that edit.

**Refused** when `rev` differs from the stored revision:

```json
{"type": "state_conflict", "name": "pairs", "rev": 9, "body": "{…current…}"}
```

The current document rides along, so the loser needs no second round trip.

### 2.3 Validation

Checked in order; the first failure answers and stops.

| Condition | Answer |
|---|---|
| `name` not one of the four | `{"type":"error","message":"state_put: unknown document <name>"}` |
| `body` not a string | `{"type":"error","message":"state_put: body must be a string"}` |
| `len(body.encode())` > 262144 | `{"type":"error","message":"state_put: document too large"}` |
| `rev` not an int ≥ 0 | `{"type":"error","message":"state_put: bad rev"}` |
| `rev` ≠ stored rev | `state_conflict` (§2.2) — **not** an error |

The cap is per document, so the ceiling on this store is 4 × 256 KB.

`state_put` is **not** behind `HERDR_ENABLE_WRITE_EXT`. That gate governs process creation; this
writes a label, which is strictly weaker than `send_text`, already open. Same reasoning as
`rename_pane` (`relay/herdr_relay.py:1564`).

### 2.4 Old relay

A relay without this feature answers `state_get` with the existing unknown-type error
(`herdr_relay.py:1706`), whose message contains `unknown message type`. The client treats that as
"sync unavailable", stays purely local for the life of the socket, and never sends `state_put`. No
version handshake is added.

---

## 3. Client behaviour

### 3.1 States

One of `idle` (socket not open), `pulling` (`state_get` sent, no answer yet), `live` (answer
received), `off` (relay said unknown type, or 10 s elapsed with no answer).

- On socket open: reset to `pulling`, clear all remembered revisions, send `state_get`.
- Revisions are held in memory only. A reconnect re-learns them. Nothing about sync is persisted
  except the mirrored bodies themselves and the backup keys of §3.3.
- In `pulling`, local writes are recorded as dirty but **not** sent. They flush on entering `live`.
- In `off`, the app behaves exactly as it does today.
- **Sync is bound to one socket, not to "the connection".** The module remembers the socket it sent
  `state_get` on and sends every later frame on that same object. A revision is a fact about one
  socket's conversation, and `connect()` assigns the new socket to the global before it has opened —
  so a debounce timer firing in that gap would otherwise quote an old revision at a `CONNECTING`
  socket, which throws. For the same reason a close event for a socket that is no longer the current
  one is ignored: it must not take the replacement's sync offline.

### 3.2 Applying an incoming `state`

Per document in `docs`:

1. Remember `rev`.
2. **The document is dirty** → remember `rev` and stop. It was edited in this browser after
   `state_get` went out, so the answer was already in flight when the user acted; adopting it would
   revert an edit made a moment ago with nothing said about why. The flush in §3.4 then pushes the
   local body on top of the revision just learned. This rule outranks 3–5 and the whole of §3.3.
  Exception: if the incoming `body` is byte-identical to what the flush would send, the document is
  cleared of dirty instead. That is the ordinary shape of a retry after a dropped socket — the write
  did reach the relay and only the ack was lost — and re-sending it would advance the revision and
  broadcast an unchanged document to every other browser, once per reconnect.
3. `rev == 0` → §3.3 (seeding).
4. `rev > 0` and `body` equals the current local string → nothing.
5. `rev > 0` and `body` differs → §3.3 backup, write `body` to the mirrored `localStorage` key,
   reload the owning module's in-memory copy, re-render. Except while a `state_put` for that
   document is **in flight**: the ack settles it, and applying an older body underneath a write we
   are still waiting to hear about would undo it.

Re-render per document:

| Document | Reload | Re-render |
|---|---|---|
| `pairs` | `loadPairs()` | `renderPairs()` and the pane strip |
| `conversations` | index is read per call | conversation list + `renderConvBar()` |
| `conv_view` | read per call | `renderConvView()` if a pane is open |
| `conv_hidden` | read per call | conversation list |

An adopted document must not be immediately pushed back. Applying is not editing.

### 3.3 Seeding and backup

On the first `state` after connect, for each document — except a document already dirty, which
§3.2 rule 2 has taken out of this table:

| Server | Local | Action |
|---|---|---|
| `rev > 0` | any | adopt (§3.2). If local was non-empty and differs, first copy it to `<key>_local` |
| `rev == 0` | non-empty | `state_put` at `rev 0` |
| `rev == 0` | empty/absent | nothing |

`<key>_local` — e.g. `herdr_pairs_local` — holds the single most recent overwritten body. It is
written by the client, never read by it, and never synced. It exists so a first connect that
discards a browser's pairs is recoverable by hand.

### 3.4 Pushing a local edit

Every function that writes one of the four keys also marks that document dirty. A dirty document is
pushed after **500 ms** of quiet (one timer per document, restarted on each edit), reading the key's
value at flush time rather than at mark time — so a burst of edits sends one message carrying the
final state.

- Push only in `live`.
- One push per document in flight at a time. An edit while a push is in flight re-marks dirty and
  flushes on the ack.
- On `state_ack`: store the new `rev`.
- On `state_conflict`: store the incoming `rev`, apply the incoming `body` (§3.2 including backup),
  and **discard** the pending local write. Do not retry — retrying is what turns a guard back into
  unguarded last-write-wins.
- On `error` naming one of the four documents: log, drop the write, leave the local copy alone.

**A handed-off frame is not an ack.** `send()` returning only means the browser took the bytes; the
socket may close before the relay replies. So on close, every document still in flight goes back to
dirty, and the next `state_get` learns its revision and retries. A `send()` that throws — a socket
that closed between the timer firing and the frame leaving — is the same case reached by the other
door, and re-marks dirty too. Neither path may drop the edit silently; that is the loss this whole
section exists to prevent.

**Flush on the way out.** The debounce is a window in which an edit exists in one browser and
nowhere else. A page that goes away inside it loses the edit and then adopts the relay's older
document on the way back in — a deleted conversation returns, a rename undoes itself. Every dirty
document is therefore sent immediately on `pagehide` and on `visibilitychange` to `hidden`, timers
cancelled. The second matters more than the first: on a phone the page is not unloaded when the
user switches away, it is backgrounded, and it may be discarded later without another event.

### 3.5 What does not sync

`herdr_relay_url` and `herdr_relay_token` are never read by this module under any circumstance, and
neither is any other key. The allowlist is a literal array of four strings in the client, matching
the relay's.

---

## 4. Storage

SQLite, WAL, one table, at `HERDR_STATE_DB` or `.herdr-remote/state.sqlite3` — same directory as
`arbitration.sqlite3`, separate file so deleting one does not take the other.

```sql
CREATE TABLE IF NOT EXISTS docs (
  name TEXT PRIMARY KEY,
  rev  INTEGER NOT NULL,
  body TEXT    NOT NULL,
  at   INTEGER NOT NULL      -- ms since epoch, last write
);
```

No pruning: four rows, capped at 256 KB each.

A store that cannot be opened is logged and the relay starts anyway, answering `state_get` with an
empty `docs` map and `state_put` with `{"type":"error","message":"state store unavailable"}`. Same
posture as the conversation log (`herdr_relay.py:173`): a relay that will not start because a file
is unwritable is worse than one that says so and carries on.

---

## 5. Failure modes

| Situation | Behaviour |
|---|---|
| Relay older than client | §2.4 — client goes `off`, app unchanged |
| Client older than relay | Sends no `state_*`; its edits stay local and are overwritten on that browser's next upgrade |
| Socket drops mid-push | Revisions cleared on reconnect; `state_get` re-establishes; the unsent edit is lost, its local copy is not |
| Two browsers, same instant | One gets `state_conflict`, adopts, keeps a `_local` backup of what it lost |
| Body exceeds 256 KB | Error, write dropped, local copy kept. The app's own caps (`MAX_PAIRS = 32`, `convFit`) keep this out of reach in normal use |
| Store unwritable | §4 — relay runs, sync `off` in practice |
| Private-mode browser | `localStorage` writes already fail silently today; sync still works for the session and seeds nothing it should not |

---

## 6. Acceptance

1. Browser A renames a pair. Browser B, open at the same time, shows the new name without a reload.
2. Browser B opens fresh (empty `localStorage`) and shows A's pairs, conversation names, and hidden
   set.
3. Browser A creates a conversation named `X`; B opens the pane and reads its transcript from
   `conv_log` — no transcript was uploaded.
4. Relay stopped: A still renames pairs, still renders, no errors in console. Relay restarted: A's
   revisions re-learn and its state survives.
5. A client pointed at a relay built before this change logs one line and works exactly as today.
6. `herdr_relay_token` never appears in any `state_put` payload.
