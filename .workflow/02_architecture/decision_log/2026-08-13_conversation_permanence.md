# Decision — Conversations are a permanent record, and recording is the default

**Date:** 2026-08-13
**Context:** [Conversation Mode spec](../../03_specs/2026-08-13_conversation_mode_spec.md), built and
merged 2026-08-13. This is the model the landing-page work is built against.
**Decided by:** the user, on five questions put by the architect.

---

## The premise

> "I would not want to delete a conversation — they are a valuable record of what happened in the
> repo."

Everything below follows from that one sentence. A conversation is not a view of live panes that
decays as they exit; it is a record that outlives them, and the panes are how it gets written.

---

## D1 — A member's state is derived, and a dead pane removes nothing

**Proposed:** a conversation whose panes have exited is finished, and its members are pruned or its
card is a dead end.

**Decided:** nothing prunes the roster. A member has a live pane (*recording*) or it does not
(*ended*), and that is answered by looking at `agents` — no stored field, no event to handle, no
lifecycle. An ended member keeps its place, its label, its harness badge and every word it said.

Most of this already held: nothing in the code prunes `members`, and `renderConvView` builds its
member list from `conv.members` rather than from `agents`, so ended members' entries were already
being merged into the thread. What did not hold is in D2 and D5.

---

## D2 — A referenced transcript is never evicted

**Proposed (existing behaviour):** `evictOrder` sorts unreferenced records first, then oldest
touched, and drops whatever exceeds `CONV_TRANSCRIPT_MAX`. A conversation's own record can be
deleted while the conversation still names it.

**Decided:** referenced is a floor, not a preference. If the cap is reached with everything
referenced, nothing is dropped and the user is told — a silent deletion of the thing the feature
exists to keep is the one failure this model cannot absorb.

This has a cost, and D4 is what pays it.

---

## D3 — Continuing is adding a member, from either of two sources

**Decided:** there is one operation, and the only difference is where the pane comes from.

| Source | What it does |
|---|---|
| **A new session** | `start_agent` from the stored `spawn`, then add the new pane as a member |
| **An existing pane** | add any live pane; it brings its own transcript with it |

A respawned agent is a **new** member, never the old one restored: a new pane means a new
`convMemberKey`, which means a new transcript. That is the property that stops a recycled pane id
inheriting a dead session's words, and it is not negotiable. The conversation ends up holding both
— the ended member with the history, the live one continuing it — and the joint view's time merge
makes it read as one thread across the seam with no change to the render.

Three constraints on the respawn:

- **`spawn.cwd` is a record, not an instruction.** The relay takes a new session's cwd from the
  Project, never from the client. A respawn sends `project_id` and lets the relay resolve the
  directory; if the Project has been repointed since, the UI shows the recorded cwd beside the
  current one rather than pretending they agree.
- **Placement cannot trust a stale `workspace_id`.** herdr recycles them. New tab in the recorded
  workspace if that workspace is live right now, otherwise a new workspace.
- **The gate is `canDuplicate`'s predicate** — the relay willing to start, a known Project, the
  harness inside `startOptions.agents`. An unstartable harness gets no button rather than a refusal.

**A joined pane brings all of its history, including what it said in another conversation.** Drawn
with a thin "joined here" rule at the join point. Honest, one line of render, no hidden state — the
alternative is hiding words that agent really did say.

---

## D4 — Two tiers, and protection follows intent

**The tension:** D2 says never evict, and D5 says record everything by default. Together they grow
without bound.

**Decided:** what the user named is permanent; what the app started on its own is not.

| Tier | Created by | Evictable |
|---|---|---|
| **Named** | the user typed a name | never |
| **Auto** | the default recorder (D5) | yes — oldest touched first, as today |

Naming an auto conversation promotes it. That is the whole ceremony: no "keep" checkbox, no
archive, no second concept. The card badges the tier rather than the name carrying a marker, so
promotion is not a rename.

The roster splits the same way. Ended members accumulate without limit in a named conversation; an
auto one prunes its oldest ended members past a generous cap, because nobody asserted they mattered.

**`CONV_MEMBER_MAX` (8) applies to recording members only.** It exists for the view — "past this the
joint view stops being a thread" — not for storage, and under D1 a conversation continued across
three respawns would otherwise hit the wall. `parseConvIndex` currently truncates `members` to that
cap **on every load**, silently dropping the ninth; that truncation moves to a much larger roster
cap.

**Where the two caps actually live**, since they are easy to conflate:

- The **index** (`herdr_conversations`) is `localStorage` — names and rosters only, no entries by
  construction, in a ~5 MB pool shared with fourteen other keys. This is what a growing roster
  costs: ~120 bytes a member, so 200 conversations of 30 members is ~720 KB.
- The **transcripts** are IndexedDB, whose budget is a share of free disk. This is where the words
  are, and it is not the 5 MB store.

Noted while checking: the spec's `BYTES_TARGET` (50 MB against `navigator.storage.estimate()`) was
never built. The only real ceilings are `CONV_TRANSCRIPT_MAX` (500 records) and `CONV_ENTRY_MAX`
(5000 entries per pane).

---

## D5 — Recording is on by default, into a per-pane auto conversation

**Proposed:** recording stays opt-in per pane, as built.

**Decided:** on by default. The book-keeping case — "what happened in this repo" — is not served by
a feature you have to remember to switch on before the thing worth keeping happens.

- **Scope: one auto conversation per pane**, not per project. A project runs several threads of work
  in parallel, and folding them into one record would produce a transcript nobody can read.
- **Name: the project and the pane's label** — `herdr-remote · Architect 1`. `project` is
  `basename(cwd)` and the relay sends it for every pane, so this works with no Projects config.
  Label falls back to role, then to pane id.
- **Auto-join runs once per pane, ever.** A pane already in any auto conversation is left alone, so
  renaming it later does not fork a second record.
- **A harness with no gutter profile still records nothing**, and says so, exactly as before.
- The switch is a global preference in the pane menu, beside the conversation settings already
  there.

The precedent against this is `HERDR_PUSH_SUMMARY`, which is opt-in because the detector was new.
The difference is cost: that one buys relay work on every finish, and this one is browser-local and
free. D4's auto tier is what keeps "on by default" from becoming a storage problem.

---

## What this changes in the code

1. **Eviction** — referenced is a floor; the auto tier is what remains evictable.
2. **`renderConvView`** starts from `activePane`, so a conversation with nothing live cannot be
   drawn at all. The stored half needs no pane. This is the blocker for everything else.
3. **`openConversation`** requires a live member and toasts otherwise — the record is on screen,
   named and counted, and unreachable.
4. **Membership conflates two facts** — "this pane's words are part of this conversation" and
   "record this pane now". Leaving pulls history out of the thread *and* unreferences the
   transcript. Removal becomes rare and explicit, worded as what it does; the ordinary end of a
   session removes nothing.
5. **`parseConvIndex`'s member truncation** moves to the roster cap (D4).
6. **Auto-join, the default switch, and the tier badge** (D5, D4).

## Order of work

All five shipped on 2026-08-13, in this order.

1. Eviction floor, and the tier field — `a2cefc5`. Nothing else is safe to build on a store that
   can drop the record underneath it.
2. A conversation opens as itself — pane-independent thread, read-only — `753749a`.
3. Conversation-level actions: rename (which promotes), add a live pane, remove a member —
   `ada16bc`.
4. Respawn from `spawn`, 5. auto-recording on by default and the card content — one commit, with
   whole-thread Markdown copy, which the roster made free.

Two things the build added that this document did not call for, both forced by D4 rather than
chosen:

- **`convFit`.** `saveConvIndex` trimmed the tail at `CONV_CONV_MAX`, and new conversations are
  prepended — so the tail is the oldest, and with the default recorder filing one per pane the tail
  is where the named ones end up. The cap now gives way at the auto tier, oldest first, the same
  rule `evictOrder` follows for transcripts.
- **A record of which panes have been filed**, kept apart from membership. "Already in an auto
  conversation" is not the question D5's once-per-pane rule asks: a member the user removed would
  be filed again on the next poll.
