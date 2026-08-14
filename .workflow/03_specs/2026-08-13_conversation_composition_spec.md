# Spec — Composing conversations out of recordings

**Date:** 2026-08-13
**Status:** **Implemented** — `web/index.html`, `tests/test_conversation.js`,
`tests/e2e/browser/conversation.spec.js`. Built 2026-08-14, in the order S1, S2, S3.
**Scope:** `web/index.html` only. No relay change, no new WebSocket message, no new env var, no
change to what is recorded or when.
**Builds on:** [Conversation Mode](2026-08-13_conversation_mode_spec.md) and the permanence model
[D1–D5](../02_architecture/decision_log/2026-08-13_conversation_permanence.md).

---

## 1. Goal

Conversation mode records **per pane** and groups **per view**. §1.3 of the conversation spec put it
plainly: "the record is per pane; grouping is a view … never a second copy". Everything below is a
consequence of that sentence that the build has not collected yet.

Two things the user cannot do today:

1. **Read one pane under two different groupings.** A pane may already be a member of any number of
   conversations — the store has never stopped it — but the pane's own thread shows
   `convsForPane(a)[0]` and there is no way to say which.
2. **Assemble a conversation out of sessions that have already ended.** "Add pane" offers live panes
   only. So a conversation of A and B cannot be copied to A, B and C in order to read the three in
   one chronology, which is the thing that makes a set of recordings worth more than the sum of
   them.

Both are reads. Neither changes a transcript, and neither can lose one.

## 2. Why this is cheap, and where the cost actually is

A conversation is a **roster and a name** — `{id, name, created, members:[{key, label, added}]}` in
`localStorage`, about 120 bytes a member. The words are per-pane records in IndexedDB, merged at
read time by `mergeEntries` inside `convCompose`. So:

- **Duplicating a conversation copies no words.** It is one more index row.
- **A pane in five conversations still has one transcript**, and eviction already knows that:
  `convReferenced` and `convKept` are built across *every* conversation, so removing a member from
  one grouping cannot delete words another grouping is showing (D2's floor).
- **Chronology across hosts is sound.** Every stamp is taken by this browser — `noteStatus` uses
  `Date.now()` for the transition, and the outbox stamps a send — so a pane on this laptop and a
  pane over SSH interleave against one clock. There is no skew to correct because there is only one
  clock.

The one real limit, stated here so it is not discovered later: **transcripts are per browser.** A
pane this browser never watched has no record here, so a conversation can only be composed out of
what this device recorded. Sharing recordings between devices is a relay-side feature and is out of
scope.

## 3. What the render already does

Checked rather than assumed. `convEntriesHtml` is already N-member:

- `convTint(e.member || 0)` cycles `PAIR_TINTS` per member index.
- Every bubble carries its member's **name and harness badge** as well as its colour — the code
  says why: "two washes of one family are not enough on a phone in sunlight, and past two members
  colour alone stops working".
- Left/right sides are the only pair-specific part, and they are already gated:
  `paired = joint && (conv.pair_id || pairFor(...)) && members.length === 2`. A third member turns
  sides off and the thread falls back to colour, name and badge.

So §5 needs **no render work**, only a test that pins it at three members. That is a property the
build already has and nothing currently protects.

---

## 4. S1 — A pane's thread picks which conversation it is showing

**Today:** `convViews()[key]` stores `1` — a boolean "thread on". `renderConvView` and
`convThreadShows` both resolve the conversation as `convsForPane(a)[0]`, which is index order, which
is creation order. A pane in two conversations shows the newer one and offers no way back.

**Change:** the same map stores the **conversation id** instead of `1`.

- `convViewOn(a)` stays a truthiness check, so a stored `1` from an older version still reads as on.
- New `convViewConv(a)`: the conversation whose id is stored, or `convsForPane(a)[0]` when the
  stored value is `1`, when the id names a conversation this pane has since left, or when the id is
  gone entirely. **Falling back rather than showing nothing** — a stale id must never make a
  recorded pane look empty.
- `toggleConvView` writes the id of the conversation it is turning on.
- Both resolution sites (`renderConvView`, `convThreadShows`) go through `convViewConv`.

**The control.** `convHeadHtml` already draws the conversation's name at the top of the thread. When
the pane is in more than one, the name becomes a `<select>` of them. A native select rather than a
tap-to-cycle button: cycling hides how many there are, and the count is the information.

Selecting writes the new id and re-renders. Nothing else changes — the composer, `doTransfer` and
every send target the **pane**, never the conversation, so there is no ambiguity about where a
message goes and no new failure mode.

## 5. S2 — Duplicate a conversation

**Why it is the primitive.** The user's case is "A and B, then A, B and C, and compare". Editing the
original destroys the comparison; a copy keeps both readings of the same words.

`duplicateConversation()` in the standalone view, beside Rename:

- New id, `created = now`, members copied by value.
- Name: `"<name> (copy)"`, then `" (copy 2)"` … if that is taken.
- **`auto` is cleared.** A duplicate is an assertion that this grouping matters, which is exactly
  what D4 defines the named tier to be. It also stops a copy being evicted out from under the
  comparison it was made for.
- The view switches to the copy, so the next action lands on the thing just made.

Nothing is written to IndexedDB. `convFit` runs through `saveConvIndex` as always, and a named copy
is a floor rather than a candidate.

## 6. S3 — Add a member from the recordings, not only from the live panes

**Today:** `convRosterHtml`'s "Add pane" chips are `agents.filter(...)` — live panes this
conversation does not already name. A session that ended yesterday cannot be added to anything,
which is precisely the session a retrospective grouping is made of.

**Change:** the chip list gains a second group, under a `Recorded` heading — every transcript in the
store whose key this conversation does not already hold and whose pane is not live. Read once when
the picker opens, not on the poll path:

- Source: `getAll()` on the object store, the same read `convEvict` does; the localStorage fallback
  store when there is no IndexedDB.
- Each chip: `rec.label`, the harness badge from `rec.spawn.agent`, and how long ago from
  `rec.touched`. A recording with no label falls back to `"Former pane"`, the same words the roster
  already uses.
- Newest `touched` first, and capped at `CONV_PICK_MAX = 60` chips — a picker longer than that is
  not a picker.

**`CONV_MEMBER_MAX` is not involved.** It caps *recording* members (8) because past that the joint
view stops being a thread. Ended members have never been capped and are not capped here — a
twelve-session retrospective is legal and is the point.

`convJoinRecord(key)` is `convJoinPane`'s sibling: it takes a key that has no live pane, so it
builds the member from the record's own `label` rather than from `paneLabel`.

## 7. What this does not do

- **No per-conversation message streams.** A pane has one transcript, and every conversation holding
  it shows the same words. This is deliberate: two conversations disagreeing about what a pane said
  is a bug, not a feature.
- **No merge, no split, no reordering.** Chronology is the merge, and it comes from the stamps.
- **No cross-device composition.** §2's limit.
- **No change to auto-recording.** D5 still files one auto conversation per pane, once ever, and a
  duplicate of an auto conversation is named rather than auto.

## 8. Test plan

Pure logic (`tests/test_conversation.js`, vm slice):

- The duplicate's name against an index that already holds `(copy)`.

Browser (`tests/e2e/browser/conversation.spec.js`):

- A pane in two conversations shows the selected one, and the select lists both.
- A stored id naming a conversation the pane has left falls back to the first rather than to empty.
- A legacy `1` still reads as on.
- Duplicate copies the roster, clears `auto`, and adds no transcript.
- The recorded-panes group offers an ended session, and joining it puts its words in the thread.
- Three members render with three tints, three names, and no left/right sides.

---

## 9. S4 — The standalone view's chrome (added 2026-08-14)

Three changes to the view a landing card opens, and to nothing else. The pane's own thread panel is
untouched.

**The roster and the conversation's actions are a disclosure.** They were a block above every
thread — reference and ownership sitting on top of the thing the view exists to read. They now live
in `#convViewRoster`, opened by a `Members` button in the header that also carries the count
(`3 panes`, or `2/3 panes` when something is folded out). Header and panel stick as one
`.conv-view-top`, so the panel needs no measurement of the header to sit under it. The panel is
diffed separately from the thread: a message arriving must not rewrite the roster under a reader
who has just opened it.

**A member can be folded out of the thread.** Per conversation, in `herdr_conv_hidden` — the same
pane can be worth reading in one grouping and noise in another, which is what S1 makes possible.
This changes no membership, deletes no words and stops no recording; it is a reading state and the
roster row says `hidden` rather than being struck through.

The thread is composed over **every** member and filtered after. Composing over the visible ones
would renumber them, and the member index is what picks a bubble's colour — hiding the first member
would repaint the second in its tint. A single-member thread's entries carry no key, because there
was never another member to tell them from; that member is `keys[0]`.

**Every live member opens its own pane.** `openConvMemberPane(key)` is the general form, and the
header's button is now `convVisibleLive(conv)` fed into it: the first member of the roster that is
live *and* not folded out. Roster order is when each member joined, so that is the conversation's
oldest running session — worth stating plainly, because it is easy to read the old code as picking
a "primary". There is no primary. A pair partner is something the pane's own thread adds once it is
open (`pairedConvMembers`), not something this picks. Either route sets the pane's per-pane
conversation preference to this conversation, so a pane in several opens on the one you came from.
