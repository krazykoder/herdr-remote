# An emptiness is not an assertion

**Date:** 2026-08-29
**Status:** accepted
**Area:** shared user state (`web/src/state_sync.js`, `web/src/conversation_view.js`)

## What happened

The user cleared site data in one browser to force a full reload. Every conversation disappeared
from every browser. The relay's own revision history says it plainly:

```
rev=6816   2026-08-29 18:34:20     52940 bytes    152 conversations
rev=6817   2026-08-29 18:35:12      1939 bytes      7 conversations, every one auto
rev=6818   2026-08-29 18:35:13      2541 bytes      the same 7
```

The seven survivors correspond one-to-one with the seven panes that were live at the time — which
is exactly what `convAutoJoin` mints when it runs against an index it reads as empty. One write, at
18:35:12, replaced the shared document with a fabricated copy of it.

Recovered with `relay/user_state.py restore conversations 6816`, which is the recovery path the
`history` table exists for. The 152 conversations came back as revision 6823.

## Why the existing guard did not hold

`stateSyncPending()` already stops this at boot, and its comment describes this exact failure:

> A browser that has never connected reads an empty one, and filing every live pane against that
> emptiness mints a duplicate of a conversation the relay is about to hand over — which then wins.

But it is a guard about *time*: it covers the window between `state_get` and its answer. The wipe
did not happen in that window. The page was already connected, already seeded, already holding
revision 6816 — and then storage went out from under it while it kept running. Clear-site-data does
not reload the page or close the socket. The next snapshot read an empty index, found seven
unfiled panes, filed them, and pushed the result at the revision it legitimately held. The relay
had no reason to refuse it: the write quoted the current revision, which is the whole of what
optimistic concurrency checks.

The same absence is reachable by a second door with no user action at all. `stateSyncApply` catches
a failed `localStorage.setItem` and returns `false` — a 52 KB document adopted into a store near
quota simply does not land — and `stateSyncReceive` then calls `convAutoJoin()` against the
emptiness it thought it had just filled.

## The decision

**An emptiness this browser reads is not, on its own, a fact about the fleet.** Two changes, both
resting on the relay's document being the thing that is true:

1. `state_sync.js` remembers the body the relay last told it it holds, per document — learned on
   the answer to `state_get`, on a broadcast, on an ack of our own write, and on a conflict. Reset
   with the revisions on every new socket, because the revision is the only thing that makes it
   meaningful. `stateSyncHeal()` writes a document back when the key is *gone* and we hold what the
   relay has. It marks nothing dirty and sends nothing — the relay already holds this body, so
   restoring it is invisible to everyone but this browser. It runs first in the snapshot handler,
   before anything decides anything from a document.

2. `convAutoJoin` refuses to mint when it reads no index and `stateSyncHeld('conversations')` parses
   to a non-empty one. That covers the quota door, which the heal does not: the mint there happens
   inside `stateSyncReceive`, before any snapshot.

A key that is *present* is never healed, however small. A document written since the last thing the
relay said is this browser's own state, and overwriting it would be the mirror image of the bug.

## What was considered and rejected

- **Refuse a `state_put` that shrinks a document.** The relay would have to parse the body, which
  is the one thing `user_state.py` deliberately does not do — bodies are opaque, and the day a
  seventh document has a different shape is the day this becomes a second bug. Deleting a
  conversation is also a legitimate shrink, and by far the common one.
- **Persist the revision, so a cleared browser knows it is missing something.** The clear takes the
  persisted copy with it.
- **Re-issue `state_get` on every snapshot.** A round trip per poll to answer a question the client
  already has the material for.

## What this does not fix

Transcripts live in this browser's IndexedDB, not on the relay. Clearing site data still takes the
conversation *contents* with it; what is restored is the index — the names, the rosters, and which
conversation each pane is read under. Recording those centrally is a separate decision, and the
durable conversation record (`HERDR_CONV_LOG`) is already the honest answer to it.

## Checks

- `tests/test_state_sync.js` — six cases on the held body and the heal: it is learned from every
  path the relay speaks through, forgotten on a new socket, written back when the key is gone, sends
  nothing when it does, and leaves a document written since alone.
- `tests/test_conv_autojoin.js` — new. The mint, and the three absences: still in the air, lost
  under a live page, and honestly empty.
