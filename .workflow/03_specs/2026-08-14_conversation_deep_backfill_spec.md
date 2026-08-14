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
text: `read_pane`, `source: 'recent-unwrapped'`, with a depth the relay clamps to its configured
`READ_LINES_MAX` (`relay/herdr_relay.py:498`) and herdr's available scrollback. Those, not the app,
are the ceiling.

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

## 2. The mechanism — one function, three triggers

One new pure step, `deepEntries(fresh, stored)`, and one guard on when it runs. All three triggers
feed the same function; they differ only in who caused the read — the user scrolling (T1), an outage
the app noticed (T2), or the user asking outright (T3).

### 2.1 `deepEntries` — anchor, then append what follows

1. Extract with the existing `paneMessages`. **No new parser.**
2. Anchor: the transcript's newest **agent** entry, matched by `convKey(text)`, searched from the
   **end** of the deep window backwards. Same comparison `recoveredTurn` already uses
   (`conversation_pure.js:198`), so a message that matches there matches here.
3. **Anchor found** → append only the messages after it, in pane order, stamped `at_src: 'backfill'`,
   `at` stepped one per message the way `backfillEntries` steps its own. Completion times are
   unknown, and the read is not one of them; stepping is what keeps a member's internal order
   through the joint merge instead of stacking the recovered run on a single timestamp. `backfill`
   rather than `read` because that is exactly what `at_src` means by it — "unknown, but older than
   everything live" — and it is what puts the tilde on the bubble instead of a clock nobody read.
4. **Anchor missed** → append **nothing**, and mark the next entry `gap: true`; the view already
   draws a rule for it. A miss means `/clear`, a scrollback deeper than the window, or an anchor
   whose text changed. None of the three is a reason to guess.
5. Prepend, independently of 3 and 4: messages **older than the transcript's oldest entry**, anchored
   on that oldest entry — of either speaker, since a transcript can begin on either — and searched
   from the **start** forwards, which is the same "recover less" rule the append side follows from
   the other end. This is the pane-first-read-late case, and it is the `before` slot `recordPaneNow`
   already builds for `backfillEntries`. Its stamps step down from the oldest stored entry rather
   than from `now`, or a joint thread would sort the prepend after the history it was prepended to.

### 2.2 The watermark — what makes this not the fold

The fold that was removed in `ac28992` matched the stored tail against **every 3s read** and appended
the unmatched remainder. High frequency, one ambiguity roll per tick, and duplicates when it lost.

`deepEntries` runs only on a read that is **deeper than any read this transcript has ever recorded
from**. Store `held.depth` — the row count of the deepest recorded window — and decline before any
matching happens when `rows.length <= held.depth`.

Consequences worth stating:

- The 3s poll at 200 lines never fires it. Neither does the 1000-line ceiling
  (`POLL_MAX_LINES`), once passed.
- Load more to 700 fires it once; again to 1200 fires it once more. Each new depth, once.
- Total invocations per transcript per session ≈ how many times Load more was pressed. Bounded by
  hand, not by clock.
- Coming back to the tail resets `paneLines` to 200 (`dictation.js:207`) but **must not** reset
  `held.depth`. The watermark is about what has been *recorded*, not about what is on screen.

**The watermark is a cost guard, not a correctness guard.** `deepEntries` is idempotent on the same
window: the anchor is found, nothing follows it, nothing is appended; the oldest entry is found,
nothing precedes it, nothing is prepended. Run it twice on identical rows and the second run writes
zero. That is what makes §2.6's manual button safe to bypass the watermark — an explicit request is
never declined for being a repeat, exactly as `refreshPane(auto)` never skips a read someone asked
for.

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
dropped and no time was lost, there is no gap to close and a speculative deep read is pure cost. Two
conditions, both required:

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
send { type: 'read_pane', pane_id, lines: DEEP_LINES, source: 'recent-unwrapped' }
```

`DEEP_LINES` flat, **not** `min(DEEP_LINES, paneHistoryMax())`. The two were coupled in an earlier
draft and should not be: `paneHistoryMax()` is how much scrollback the user wants *drawn in the
pane*, and a T2 read is never drawn. Someone who sets 2000 to keep a phone light has said nothing
about how far back a recovery may look. The relay clamps anyway (§2.7), so this number is a request
and not an assertion.

Same message `convReadTurnEnd` sends today, deeper. The reply lands on the **non-active** branch
(`status_bar.js:409`), which records and never draws — so this is invisible by construction. That is
what "seamless" means here: not a fast redraw, but no redraw at all.

**Once per member per recovery.** `held.depth` makes a repeat a no-op even if the guard is wrong,
which is the property to test first.

**One threshold and one depth, deliberately.** An earlier draft had a two-tier ladder — 10 minutes
to trigger, and a deeper read past a 2-hour gap. Both numbers are gone:

- **15 minutes is the single trigger.** Two hours is not a disconnection, it is a different working
  session, and by then the gap is the thing you came back to read. Fifteen minutes is roughly the
  shortest gap in which an agent finishes more turns than the one the existing recovery already
  handles, which is the exact condition this spec exists for. Below it, nothing is missed that is
  worth a read.
- **The second depth tier bought nothing.** `paneHistoryMax()` is the ceiling and defaults to 5000,
  so `min(10000, paneHistoryMax())` and `min(5000, paneHistoryMax())` are the same read for every
  user who has not changed the setting. A tier that is invisible at the default is a constant
  pretending to be a policy. One depth, ceilinged by the user's own setting, and §2.6 is how someone
  who wants more asks for it.

### 2.6 Trigger T3 — the manual button

Automatic recovery is bounded by gates that can be wrong: a gap under 15 minutes that still lost
turns, an outage the browser never registered as one, a member whose `touched` was refreshed by a
draft. The answer to a heuristic that can miss is not a looser heuristic — it is a button.

**`Recover history` in the pane's `⋯` menu**, beside `Remove duplicates`, which is the precedent it
copies in every respect: a transcript repair, hidden unless it applies, that reports what it did.

- **Shown when** the pane is a conversation member, has a transcript, and its agent has a profile.
  Hidden otherwise — the same test `menuConvDedupe` uses (`terminal.js:409`).
- **Does** what §2.5 already specifies for the active pane, which is why this is nearly free:

  ```js
  paneLines = READ_LINES_ASK;      // "as deep as the relay allows" — see §2.7
  refreshPane();
  ```

  The reply arrives on the normal draw path, T1 records it, and the history appears above the pane
  exactly as Load more puts it there.
- **Bypasses both gates.** No outage test, no `held.touched` test, and no watermark — an explicit
  request is never declined for being a repeat (§2.2). Idempotence, not the guard, is what keeps a
  second press harmless. The watermark bypass is not politeness: a pane sitting at herdr's own
  scrollback ceiling returns the same row count every time, so the watermark alone would refuse
  every recovery after the first, on exactly the panes with the most history to lose.
- **Reaches the ceiling in one press**, rather than `historyStep()` at a time. That is the difference
  between this and Load more, and it is the reason to have it as well as a scroll: recovering from a
  50000-line scrollback is ten taps of Load more. The ceiling it reaches is the relay's, not the
  picker's (§2.7) — pressing this is an explicit "everything you have", which is a different
  statement from the standing display preference.
- **Says what happened**, like dedupe does: `Recovered 4 messages.` / `Nothing new to recover.` /
  `Could not find where the record left off — the gap is marked in the thread.` The third is the
  missed anchor, and saying so is what stops a silent no-op reading as a broken button.

**Not armed.** The two-tap drain is for destructive and irreversible actions. This one only ever
adds, and its worst outcome is that it adds nothing.

### 2.5 The active pane under T2

The open pane cannot take the T2 path: its `pane_content` lands on the draw branch, and
`pane_content` echoes `pane_id`, `content`, `source` and `cols` but **not** `lines`, so the reply of
a deep recovery read is indistinguishable from the reply of the 3s poll. Rendering it would replace
the rows and move the scroll.

Rather than add a wire field, T2 gives the active pane the one thing that is already correct for it:

```js
paneLines = DEEP_LINES;
refreshPane();
```

— i.e. `loadMore` to the automatic depth, and the relay clamps it (§2.7). `DEEP_LINES` rather than
`READ_LINES_ASK`, because this fires without anyone asking: the button is where "everything you
have" belongs. Identical consequences to the user pressing Load more,
which they were about to do anyway: the history appears above, `userScrolledUp` governs the scroll
exactly as it does today, the poll stops above `POLL_MAX_LINES` as documented, and returning to the
tail turns it live again. No new state, no new branch, and T1 does the recording.

**The wire change that would remove this special case** — echoing `lines` back in `pane_content`, so
a deep reply can be routed to the recorder alone — is deliberately not taken. It is one field and it
would work; it is out of scope because this spec's whole claim is that no relay change is needed, and
the special case costs nothing.

### 2.7 The ceiling is the relay's, and the app must never restate it

`READ_LINES_MAX` (`relay/herdr_relay.py:490`) is 50000 today and is a server-side number the operator
can change — as can herdr's own scrollback depth behind it. The app must track that without being
edited, so **no constant here may name a maximum**.

It does not have to. `read_pane_lines` already clamps every request:

```python
READ_LINES_MAX = 50000
def read_pane_lines(raw):
    try:
        return max(1, min(int(raw), READ_LINES_MAX))
    except (TypeError, ValueError, OverflowError):
        return READ_LINES_DEFAULT
```

So "as deep as you allow" is expressible today, with no wire change and no negotiation: **ask for
more than the ceiling and the clamp answers with the ceiling.** `READ_LINES_ASK = 1e9` is that ask.
Raise `READ_LINES_MAX` to 200000 and the next `Recover history` returns 200000 lines, with nothing in
`web/` touched. Lower it to 10000 and recovery quietly stops at 10000, which is correct rather than
broken.

The alternative — the relay advertising its ceiling in the snapshot, the app storing it — is one
field and it works, and it is worse: it adds a wire field, a stale-value question, and a
backward-compatibility branch for relays that do not send it, all to compute a number the clamp
already applies. Not taken.

**Two consequences to carry into the build:**

- **`HISTORY_MAX` is a display list, not a ceiling.** `[2000, 5000, 20000, 50000]`
  (`history.js:189`) is a picker of how much to draw, and its top entry coincidentally equals today's
  `READ_LINES_MAX`. That coincidence is not load-bearing and must not become so. If the picker should
  also follow the relay, it grows a `Max` option carrying `READ_LINES_ASK` rather than a bigger
  number — a small, separate change, and out of scope here.
- **The clamp is the only guard on a huge ask.** An operator who raises `READ_LINES_MAX` to 500000
  has asked for 500000-line reads and will get them, over SSH, on a phone. That is their decision
  and the correct place for it. T2 does not participate: it asks for `DEEP_LINES`, a real number,
  precisely because it fires without anyone pressing anything.

### 2.8 Capacity — a prepend never evicts

`CONV_ENTRY_MAX` is 5000 **entries**, and `capEntries` keeps the newest by dropping from the front
(`conversation_pure.js:313`). `recordPaneNow` caps one concatenation:

```js
held.entries = capEntries(old.entries.concat(held.entries, tagged.entries));
```

`old.entries` is the prepend. The front of that array is exactly the recovered history, so the trim
lands on it first. That is the hazard, and it is specific to one of the two paths:

- **Append** — messages after the anchor go at the end, and the cap slides the window forward. That
  is what every ordinary turn already does: a transcript at the cap sheds its oldest on the next turn
  the agent finishes, and has since recording shipped. A recovered turn must not behave differently
  from a live one because the words arrived late.
- **Prepend** — messages older than the oldest stored entry go where the trim is. Left alone,
  `Recover history` on a full transcript would fetch old history, write it, and have `capEntries`
  delete it in the same statement, taking part of the existing record with it. The button would
  destroy history in the name of recovering it.

So: **a prepend never evicts.** It takes only the room left under the cap by the record it must not
displace, keeping its **newest** end so no hole opens between what is recovered and what was already
stored:

```js
// Room the prepend may use, after everything it must not displace.
function fitPrepend(before, kept, add, max) {
  const room = (max || CONV_ENTRY_MAX) - kept - add;
  return room <= 0 ? [] : before.slice(Math.max(0, before.length - room));
}
```

`capEntries` still runs over the union, unchanged — with nothing of the prepend left for it to reach.

This is not a deep-backfill rule. The first read's `before` slot has always been a prepend, so the
guard belongs at the one point both paths pass through, not on the new one.

**Said out loud, never silently.** A T3 recovery that could not fit all of what it found reports it:
`Recovered 12 messages; 40 older ones did not fit.` No room at all is
`This transcript is full — older messages could not be added.` Both are the same class of report as
`Nothing new to recover.` — a button that adds nothing must say why.

---

## 3. What this does not do

- **No per-conversation streams.** A pane has one transcript; every conversation holding it shows the
  same words. Unchanged.
- **No speculative deep reads.** Nothing fires on a healthy connection, on a flap, on a gap under 15
  minutes, or on a member whose transcript was written moments ago. The deferred design's worst cost — one 50000-line
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
- **T2's read cost**, per recovery: one read per stale conversation member, at `DEEP_LINES` or the
  relay's ceiling if that is lower, SSH-backed for remote panes. Bounded by conversation membership and by the
  15-minute gate. Strictly once per member per recovery — `held.depth` enforces it even if the gate
  leaks. T1 adds no read beyond Load more; T3 adds one read the user explicitly requested.
- **`CONV_ENTRY_MAX`, settled in §2.8.** The cap is 5000 *entries*, not lines, and `Recover history`
  may ask for a relay-configured depth far beyond 10000 of them. `capEntries` trims from the front,
  which is where the prepend lands — so a prepend is fitted to the room left over and reported when
  it does not fit, while an append keeps the ordinary sliding window every turn already has.
- **A pane recycled onto a stale transcript.** Already handled — `convMemberKey` includes host,
  pane_id, agent and cwd for exactly this reason, and a recycled id does not match.
- **`visible` panes.** A pane on the live frame after `/clear` is refused by `convRecordable` before
  any of this. A deep read forces `recent-unwrapped`, which is also what takes the pane back off the
  live frame — so T2 on a cleared pane recovers it as a side effect.

---

## 5. Constants

| Name | Value | Why |
|---|---|---|
| `DEEP_AWAY_MS` | **15 min** | The only threshold. Below it nothing worth a read was missed; a flap costs nothing. §2.4. |
| `DEEP_LINES` | 5000 | The automatic depth, T2 only. Roughly a working day of one pane. A request, not a bound — the relay clamps it. |
| `READ_LINES_ASK` | `1e9` | Sentinel: "as deep as you allow". T3 only. Never a literal depth. §2.7. |
| `held.depth` | — | Deepest recorded window, per transcript. New persisted field; absent reads as 0. |

No recovery constant in the app names the relay's maximum. §2.7 is why.

---

## 6. Acceptance criteria

**T1, pure logic (`tests/test_conversation.js`):**

- A window deeper than `held.depth`, anchored on the newest stored agent entry, appends only what
  follows it, in order, each with its own `at`, stamped `read`.
- The same window replayed appends nothing — `held.depth` has moved.
- A shallower window appends nothing, whatever it contains.
- Anchor missed → nothing appended, next entry carries `gap: true`.
- Messages older than the oldest stored entry are prepended, and do not duplicate the anchor.
- A duplicated anchor selects the occurrence that recovers *less*: the newest on the append side,
  the oldest on the prepend side. Both are the same rule — a short recovery is a smaller wrong than
  a duplicate, because the record is permanent.
- A prepend that would exceed `CONV_ENTRY_MAX` keeps its newest end and drops no stored entry; a
  prepend with no room at all writes nothing. Neither reaches `capEntries` (§2.8).
- An append at the cap still slides the window, exactly as an ordinary turn does.

**T2, browser (`tests/e2e/browser/conversation.spec.js`):**

- Socket down 40 min, back up, no reload → exactly one deep read per stale member, and none for a
  member whose transcript is fresh.
- Socket down 3 s → no deep read at all.
- Socket down 14 min → no deep read. Socket down 16 min → one per stale member. The threshold is
  pinned, not approximated.
- Healthy connected session across many snapshots → no deep read at all.
- A fresh page load with stale members → one deep read each, and the recovered turns land in the
  thread.
- Throughout: the pane on screen keeps its rows, its depth and its scroll position, except where T2
  deliberately deepens it, where it behaves exactly as Load more does.
- A member that is not in any conversation, or has no transcript, or whose agent has no profile, is
  never deep-read.

**T3, browser (same suite):**

- `Recover history` is hidden on a pane with no transcript, on a pane no conversation names, and on
  a pane whose agent has no profile; shown on one that has all three.
- It sends `READ_LINES_ASK` in one press, regardless of the current `paneLines`, and takes back
  whatever the relay's clamp allows.
- Pressed twice in a row it appends nothing the second time, and says so — idempotence proved
  through the UI and not only in the unit slice.
- Pressed on a member the automatic gates declined (gap under `DEEP_AWAY_MS`) it still recovers.
- A missed anchor reports the gap rather than reporting success or nothing at all.

**The ceiling, relay (`tests/test_read_lines.py` or the existing relay suite):**

- `read_pane_lines(READ_LINES_ASK)` returns `READ_LINES_MAX`, and returns the *changed* value when
  `READ_LINES_MAX` is monkeypatched. This is the whole contract the app leans on, and it is one
  assertion.
- Browser: `Recover history` sends a `lines` the relay clamps, and the app asserts nothing about what
  comes back beyond "deeper than what it had". No test may hard-code 50000.

**Regression:** the existing single-turn recovery (`turnSeeded` → `recoveredTurn`) still writes
exactly one turn and does not double-write alongside a deep backfill of the same window.

---

## 7. Order of work

1. `fitPrepend` (§2.8), with pure tests, applied to the prepend `recordPaneNow` already builds. It
   protects the existing record before any deep union can reach `capEntries`, and it is a fix to the
   first-read path whether or not the rest of this spec is built.
2. `held.depth` + the watermark guard in `recordPaneNow`. Inert on its own — it only ever declines.
3. `deepEntries`, pure, with the T1 unit tests. At this point Load more closes gaps and nothing else
   has changed.
4. **`Recover history` in the `⋯` menu (T3).** Three lines of handler over step 3, and it is what
   makes the feature usable before either gate is written — a gap you can see becomes a gap you can
   close, deliberately, on the pane you are looking at.
5. `wsDownSince` + the T2 gate and the per-member read. Browser tests.
6. The active-pane variant of T2, which is step 4's handler under a different caller.

Steps 1–4 are the whole user-visible win for the pane in front of you, cost nothing on the wire beyond
the user-requested read, and are worth shipping before 5–6 are written. Step 5 is the only part that
issues reads nobody asked for, and it is the only part whose gates can be wrong — which is why the button precedes it rather
than backstopping it.
