# Deferred proposal — Deep conversation recovery

**Date:** 2026-08-13
**Status:** **Deferred — do not implement yet.** Resume only on the evidence named in §5.
**Classification:** Class B — additive, backward compatible. No relay change, no wire change.
**Builds on:** [Conversation Mode spec](2026-08-13_conversation_mode_spec.md) §5.2, the event
recorder in `web/index.html`.

---

## 1. The hole this closes

A transcript is written by events (§5.2): the pane's first read, the end of a turn, a prompt this
app sent, and — since `72330f9` — the newest finished turn found at the first snapshot after a
reload. That last one recovers **one** turn. An agent that finished three turns while the tab was
closed leaves two of them in herdr's scrollback and out of the record forever.

The observation that makes this worth writing down: **herdr's scrollback is the backup store this
feature never had.** `loadMore()` is not a browser cache — it raises `paneLines` and re-sends
`read_pane`, and the relay reads the pane again each time. The depth is already a user setting,
`paneHistoryMax()`, defaulting to 5000 lines and offering up to 50000, and the relay clamps
whatever arrives at `READ_LINES_MAX` (50000, `relay/herdr_relay.py:490`). Everything needed to see
those two missing turns is already on the wire; nothing stores them, which is the only reason they
are lost.

---

## 2. Design

On the first sight of a **stale finished member** — a conversation member whose status is `done` or
`blocked` at the first snapshot after a reload, and whose transcript already exists — issue one
`read_pane` at `paneHistoryMax()` with `source: 'recent-unwrapped'`.

1. Extract with the existing `paneMessages`. No new parser.
2. Anchor on the transcript's newest **agent** entry, searching the deep window from its end.
3. **Anchor found:** append only what follows it, in pane order, stamped `at_src: 'read'` —
   completion times are unknown and the reconnect is not one of them. Their `at` is stepped, one
   per message, the way `backfillEntries` steps its own, so a member's own order survives and the
   joint merge does not stack the recovered run on one timestamp.
4. **Anchor missed:** append nothing, and mark the next entry `gap: true` — the view already draws
   a rule for it. A miss means `/clear`, a scrollback deeper than the ceiling, or an anchor whose
   text changed; none of the three is a reason to guess.
5. Then set `held.lastTurn` to the reconnect stamp, so the existing latest-turn recovery does not
   also write the newest turn. It would decline anyway — after step 3 the newest stored agent entry
   *is* that turn — but the state should say so rather than rely on it.

**This is not the fold coming back.** The fold matched every 3s read against the stored transcript
and appended the unmatched tail. This is one anchor, consulted once per member per page load, on a
path that writes nothing when it fails. Normal durable writes stay event-identified.

**What it does not touch.** Not the open pane's `paneLines`, not `paneSource`, not the rendered
rows: a member being recovered may be the pane on screen, and a deep read must not swap its text
or move its scroll. Not the 3s poll — above `POLL_MAX_LINES` (1000) the poll already refuses to
re-read, and this read never becomes a standing one.

---

## 3. Costs and failure modes

- **One deep read per stale member per page load.** Bounded by live panes that are conversation
  members and currently finished, not by `CONV_MEMBER_MAX`; on a machine with several remote hosts
  each of those is an SSH-backed read of up to 50000 lines. Strictly once-only is the property that
  makes it affordable, and the one to test first.
- **An anchor that appears twice in the window selects the wrong occurrence.** Searching from the
  end picks the newest, which is the right guess and is still a guess. This is the trade the whole
  document turns on and the reason it is deferred.
- **A socket reconnect is not a page load.** `prevStatuses` survives a dropped socket, so first
  sight — and therefore recovery — fires on a fresh page only. That is deliberate: a flapping
  connection must not fire a deep read per flap.
- **A member with no transcript is not this path's business.** It has never been read, so cold
  backfill already writes everything on screen and does it without an anchor.

---

## 4. Acceptance criteria, if resumed

- One stale member gets exactly one deep read, across repeated snapshots and repeated reconnects.
- Anchor found: only post-anchor messages are appended, in pane order, stamped `read`, each with
  its own `at`.
- Anchor missed: nothing is appended and the gap is visible in the thread.
- No deep read for a working member, a member with no transcript, or a pane no conversation names.
- The pane on screen keeps its rows, its depth, and its scroll position throughout.
- Browser tests cover a local and a remote stale member; a relay test asserts the requested depth
  arrives as asked and is clamped as documented.

---

## 5. What would justify resuming

Real use showing **multi-turn** gaps that matter — a member that finished three turns unwatched and
whose middle turn was worth keeping. One missed turn is what the current recovery already handles,
and a gap nobody notices is not a reason to add an anchor search to a recorder that no longer has
one.

---

## 6. Order of work while this is deferred

1. **Validate the event model in real use.** A long paired conversation, including a reload, a
   disconnect, a partner finishing while the other is on screen, and a long draft. Watch for
   duplicates, a missed newest turn, and whether the draft reads well while it is being written.
2. **Copy/export.** Whole-thread Markdown copy, and Copy start details from the recorded `spawn`.
   Orthogonal to the recorder, and the transcript is stable enough to be worth copying.
3. **Decide this document from that evidence.**
4. **Known edge, low priority.** Two prompts sent from this app before the pane's first read: only
   the newest is consulted by `splitFirstRead`, so the older one's echo is kept as history and
   duplicates. Rare, and `Remove duplicates` repairs it.
