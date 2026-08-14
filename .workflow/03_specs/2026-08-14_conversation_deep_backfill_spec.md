# Spec — Deep conversation backfill, from history the browser already pays for

**Date:** 2026-08-14
**Status:** Proposed. Branch `feat/deep-backfill`.
**Classification:** Class B — additive, backward compatible. **No relay change, no wire change, no
new message type.**
**Supersedes:** [Deep conversation recovery — deferred](2026-08-13_conversation_deep_recovery_deferred.md).
That document's §5 gate ("real use showing multi-turn gaps that matter") has been met, and its §2
trigger is replaced: the read it wanted to issue speculatively is a read the app already performs.
**Builds on:** [Conversation Mode](2026-08-13_conversation_mode_spec.md) §5.2 and the permanence
model [D1–D5](../02_architecture/decision_log/2026-08-13_conversation_permanence.md).

---

## 1. The hole, and where it actually is

A transcript is written by **events**, never by diffing a window against the store (§5.2).
`recordPaneNow` (`web/src/conversation_store.js:279`) has exactly two write paths:

| Path | Fires | Writes |
|---|---|---|
| `!held.backfilled` | the pane's first read, once per transcript, ever | everything `paneMessages` found |
| `end > held.lastTurn` | a turn ended | `turnMessages(fresh)` — **one** turn |

`turnMessages` (`conversation_pure.js:154`) is the last agent message plus the run of user messages
directly above it. One turn, by construction.

So: the tab is closed, or the socket drops. The agent finishes three turns. You come back.
`held.backfilled` is already true, so the backfill path is shut. `end` has moved, so one turn is
appended. **Turns one and two are gone from the record** — while remaining perfectly visible in the
pane, marked correctly by `turnSummaries` and `userInputLines`, which is how the gap gets noticed in
the first place.

### 1.1 The read that already holds them

The deferred design proposed issuing a fresh deep `read_pane` to recover those turns. It does not
need to. Follow the existing path:

```js
// web/src/controls.js:122
function loadMore() {
  paneSource = 'recent-unwrapped';
  paneLines = Math.min(paneLines + historyStep(), paneHistoryMax());
  refreshPane();
}
```

```js
// web/src/status_bar.js:446 — the tail of the pane_content branch for the open pane
if (convRecordable(msg)) recordPane(activePane, paneRows);
```

`loadMore` forces `recent-unwrapped` precisely so `convRecordable` passes. **Every Load more already
delivers its full window to the recorder**, which parses it into `fresh` — every turn in it,
correctly — and then declines to write any of it, because `held.backfilled` is true and `end` has
not moved.

The words are fetched, transmitted, parsed, and dropped. That is the bug this spec fixes.

### 1.2 What history the browser can reach at all

Asked directly, because it bounds everything below. The browser has exactly one source of past pane
text: `read_pane`, `source: 'recent-unwrapped'`, `lines` up to `READ_LINES_MAX` = 50000
(`relay/herdr_relay.py:498`), served out of herdr's own scrollback. That is the ceiling.

- `source: 'visible'` is the live frame with the terminal's own breaks left in. Unusable for
  recording and already refused by `convRecordable` — the same sentence read the two ways normalizes
  to two different strings, so the overlap match sees a message it has never seen.
- There is no relay-side transcript store, no pane log endpoint, and nothing else on the wire.
- Deeper than herdr's scrollback lie the agents' own session files — the pane list already carries
  `agent_session` (`{"kind":"id","source":"herdr:antigravity_cli","value":"8623386c-…"}`), which is
  the hook a server-side reader would use. **Out of scope**, and named here only so the ceiling is
  on record rather than rediscovered.

So: FE-only backfill is bounded by herdr's scrollback depth. Within that bound, nothing is missing
that this spec cannot reach.

---

## 2. The mechanism — one function, two triggers

One new pure step, `deepEntries(fresh, stored)`, and one guard on when it runs. Both triggers feed
the same function; they differ only in who caused the read.

### 2.1 `deepEntries` — anchor, then append what follows

1. Extract with the existing `paneMessages`. **No new parser.**
2. Anchor: the transcript's newest **agent** entry, matched by `convKey(text)`, searched from the
   **end** of the deep window backwards. Same comparison `recoveredTurn` already uses
   (`conversation_pure.js:198`), so a message that matches there matches here.
3. **Anchor found** → append only the messages after it, in pane order, stamped `at_src: 'read'`,
   `at` stepped one per message the way `backfillEntries` steps its own. Completion times are
   unknown, and the read is not one of them; stepping is what keeps a member's internal order
   through the joint merge instead of stacking the recovered run on a single timestamp.
4. **Anchor missed** → append **nothing**, and mark the next entry `gap: true`; the view already
   draws a rule for it. A miss means `/clear`, a scrollback deeper than the window, or an anchor
   whose text changed. None of the three is a reason to guess.
5. Prepend, independently of 3 and 4: messages **older than the transcript's oldest entry**, anchored
   on that oldest entry the same way. This is the pane-first-read-late case, and it is the `before`
   slot `recordPaneNow` already builds for `backfillEntries`.

### 2.2 The watermark — what makes this not the fold

The fold that was removed in `ac28992` matched the stored tail against **every 3s read** and appended
the unmatched remainder. High frequency, one ambiguity roll per tick, and duplicates when it lost.

`deepEntries` runs only on a read that is **deeper than any read this transcript has ever recorded
from**. Store `held.depth` — the row count of the deepest recorded window — and decline before any
matching happens when `rows.length <= held.depth`.

Consequences worth stating:

- The 3s poll at 200 lines never fires it. Neither does the 1000-line ceiling
  (`POLL_MAX_LINES`), once passed.
- Load more to 5000 fires it once. Load more again to 10000 fires it once more.
- Total invocations per transcript per session ≈ how many times Load more was pressed. Bounded by
  hand, not by clock.
- Coming back to the tail resets `paneLines` to 200 (`dictation.js:207`) but **must not** reset
  `held.depth`. The watermark is about what has been *recorded*, not about what is on screen.

### 2.3 Trigger T1 — the user pulled history (free)

Nothing is issued. `loadMore` already runs, its reply already reaches `recordPane`, and the only
change is that `recordPaneNow` now consults `held.depth` and calls `deepEntries` when the window is
new. **Zero added reads, zero added wire traffic, zero added relay load.**

This alone closes every gap the user can see by scrolling, which is every gap in the pane they are
looking at.

### 2.4 Trigger T2 — a real disconnection, and only a real one

T1 covers the pane in front of you. It does not cover the eight members of a conversation whose panes
were never opened this session. For those, one read has to be issued.

**Gated on an actual outage.** A healthy connected session pulls nothing: if the socket never
dropped and no time was lost, there is no gap to close and a speculative 10000-line read is pure
cost. Two conditions, both required:

1. **A gap in coverage.** Either
   - a fresh page — the first `agents` snapshot where `!prevStatuses[pane_id]`
     (`status_bar.js:318`), which is exactly where `convReadTurnEnd` already fires its 200-line
     read; or
   - a socket recovery — `ws.onclose` stamps `wsDownSince`, and the first `agents` snapshot after
     the following `onopen` sees `Date.now() - wsDownSince` exceed the threshold. `prevStatuses`
     survives a dropped socket, so without this clause a 40-minute outage with no reload recovers
     nothing — which is the reported symptom.
2. **The gap is worth a read.** `Date.now() - held.touched > DEEP_AWAY_MS` for that member. A
   transcript written 90 seconds ago has nothing to recover; a three-second socket flap must never
   cost a deep read on every member.

Then, per member that passes — conversation member, transcript exists, agent profile known:

```
lines = min(gap > DEEP_LONG_MS ? DEEP_LINES_LONG : DEEP_LINES, paneHistoryMax())
send { type: 'read_pane', pane_id, lines, source: 'recent-unwrapped' }
```

Same message `convReadTurnEnd` sends today, deeper. The reply lands on the **non-active** branch
(`status_bar.js:409`), which records and never draws — so this is invisible by construction. That is
what "seamless" means here: not a fast redraw, but no redraw at all.

**Once per member per recovery.** `held.depth` makes a repeat a no-op even if the guard is wrong,
which is the property to test first.

### 2.5 The active pane under T2

The open pane cannot take the T2 path: its `pane_content` lands on the draw branch, and
`pane_content` echoes `pane_id`, `content`, `source` and `cols` but **not** `lines`, so the reply of
a deep recovery read is indistinguishable from the reply of the 3s poll. Rendering it would replace
the rows and move the scroll.

Rather than add a wire field, T2 gives the active pane the one thing that is already correct for it:

```js
paneLines = Math.min(recoveryLines, paneHistoryMax());
refreshPane();
```

— i.e. `loadMore` to the recovery depth. Identical consequences to the user pressing Load more,
which they were about to do anyway: the history appears above, `userScrolledUp` governs the scroll
exactly as it does today, the poll stops above `POLL_MAX_LINES` as documented, and returning to the
tail turns it live again. No new state, no new branch, and T1 does the recording.

**The wire change that would remove this special case** — echoing `lines` back in `pane_content`, so
a deep reply can be routed to the recorder alone — is deliberately not taken. It is one field and it
would work; it is out of scope because this spec's whole claim is that no relay change is needed, and
the special case costs nothing.

---

## 3. What this does not do

- **No per-conversation streams.** A pane has one transcript; every conversation holding it shows the
  same words. Unchanged.
- **No speculative deep reads.** Nothing fires on a healthy connection, on a short flap, or on a
  member whose transcript was written moments ago. The deferred design's worst cost — one 50000-line
  SSH-backed read per stale member per page load, on a machine with several remotes — does not exist
  in this one.
- **No fold.** Nothing is matched on the poll path. Normal durable writes stay event-identified.
- **No text repair.** A missed anchor writes nothing and says so with `gap: true`.
- **Nothing server-side.** §1.2.

---

## 4. Costs and failure modes

- **Anchor ambiguity is unchanged, and is the risk the design turns on.** Two identical closing
  messages inside the window and search-from-end picks the newer. That is the right guess and is
  still a guess. Mitigation is unchanged from the deferred doc: miss → append nothing, mark the gap.
  Worth noting the exposure is *lower* here than in the fold, because the anchor is consulted once
  per new depth rather than once per tick.
- **T2's read cost**, per recovery: one read per stale conversation member, at 5000–10000 lines,
  SSH-backed for remote panes. Bounded by conversation membership and by the outage gate. Strictly
  once per member per recovery — `held.depth` enforces it even if the gate leaks.
- **`CONV_ENTRY_MAX` is not a problem, checked rather than assumed.** The cap is 5000 *entries*, and
  entries are messages: a 10000-line window yields tens of them. `capEntries` trims from the front,
  so a pathological transcript could still shed its oldest — but nothing a deep read adds approaches
  the cap. (The deferred doc's successor draft flagged this as a hazard; it is not one.)
- **A pane recycled onto a stale transcript.** Already handled — `convMemberKey` includes host,
  pane_id, agent and cwd for exactly this reason, and a recycled id does not match.
- **`visible` panes.** A pane on the live frame after `/clear` is refused by `convRecordable` before
  any of this. A deep read forces `recent-unwrapped`, which is also what takes the pane back off the
  live frame — so T2 on a cleared pane recovers it as a side effect.

---

## 5. Constants

| Name | Value | Why |
|---|---|---|
| `DEEP_AWAY_MS` | 10 min | Below this nothing meaningful was missed. Kills flap-triggered reads. |
| `DEEP_LONG_MS` | 2 h | Above this, reach deeper. |
| `DEEP_LINES` | 5000 | The default `paneHistoryMax()`, and about a working day of one pane. |
| `DEEP_LINES_LONG` | 10000 | For an overnight gap. Ceiling is still `paneHistoryMax()`. |
| `held.depth` | — | Deepest recorded window, per transcript. New persisted field; absent reads as 0. |

`paneHistoryMax()` is the ceiling on both depths. It is the user's own setting and a recovery has no
business exceeding what they asked the app to fetch.

---

## 6. Acceptance criteria

**T1, pure logic (`tests/test_conversation.js`):**

- A window deeper than `held.depth`, anchored on the newest stored agent entry, appends only what
  follows it, in order, each with its own `at`, stamped `read`.
- The same window replayed appends nothing — `held.depth` has moved.
- A shallower window appends nothing, whatever it contains.
- Anchor missed → nothing appended, next entry carries `gap: true`.
- Messages older than the oldest stored entry are prepended, and do not duplicate the anchor.
- A duplicated anchor inside the window selects the newest occurrence. Pinned as a *known* choice,
  not asserted as correct.

**T2, browser (`tests/e2e/browser/conversation.spec.js`):**

- Socket down 40 min, back up, no reload → exactly one deep read per stale member, and none for a
  member whose transcript is fresh.
- Socket down 3 s → no deep read at all.
- Healthy connected session across many snapshots → no deep read at all.
- A fresh page load with stale members → one deep read each, and the recovered turns land in the
  thread.
- Throughout: the pane on screen keeps its rows, its depth and its scroll position, except where T2
  deliberately deepens it, where it behaves exactly as Load more does.
- A member that is not in any conversation, or has no transcript, or whose agent has no profile, is
  never deep-read.

**Regression:** the existing single-turn recovery (`turnSeeded` → `recoveredTurn`) still writes
exactly one turn and does not double-write alongside a deep backfill of the same window.

---

## 7. Order of work

1. `held.depth` + the watermark guard in `recordPaneNow`. Inert on its own — it only ever declines.
2. `deepEntries`, pure, with the T1 unit tests. At this point Load more closes gaps and nothing else
   has changed.
3. `wsDownSince` + the T2 gate and the per-member read. Browser tests.
4. The active-pane variant of T2.

Steps 1–2 are the whole user-visible win for the pane in front of you, cost nothing on the wire, and
are worth shipping before 3–4 are written.
