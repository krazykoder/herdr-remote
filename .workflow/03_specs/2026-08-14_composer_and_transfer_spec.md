# Spec — The composer, the transfer, and what a working pane looks like

**Date:** 2026-08-14
**Status:** Implemented. Branch `feat/composer-and-transfer`.
**Classification:** Class B — additive, backward compatible. **No relay change, no wire change, no
new message type.** §4 is the exception in intent but not in code: it changes what a tap means, not
what goes on the wire.
**Builds on:** [Conversation Mode](2026-08-13_conversation_mode_spec.md), the permanence model
[D1–D5](../02_architecture/decision_log/2026-08-13_conversation_permanence.md), and the P3 transfer
design that put a checkpoint between choosing a payload and sending it.

Five changes, in the order they are built. They share a subject — everything between reading a pane
and writing to it — and one constraint, which is that the relay on the other end of the socket is
not the one this app shipped with.

---

## 0. The constraint that shapes three of the five

The app is served from GitHub Pages. The relay runs on the user's own machine and is upgraded when
they feel like it. **Their versions drift by design**, and that is the deployment, not a defect in
it.

So a fix that lives in the relay is a fix the user does not have. Worse than absent: a client that
sends what an old relay refuses turns a working feature into an error toast. This decided the
recovery-id question in the deep-backfill spec (§2.4), and it decides §1 here.

**Rule: the app is written against the oldest relay it might meet. Where an old relay exposes no
ceiling, the client uses its documented compatible cap rather than requiring a new relay field.**

---

## 1. Text longer than 4000 characters

### 1.1 Where the limit is

Three caps, commonly mistaken for one. As found:

| Cap | Where | What it bounds |
|---|---|---|
| 4000 | `relay/herdr_relay.py:1292` | one `send_text` message on the wire |
| `SEND_TEXT_MAX` = 4000 | `web/src/pairs_pure.js` | one outbound `send_text` chunk |
| `CONV_TEXT_MAX` = 4000 | `web/src/conversation_pure.js` | one entry in a **transcript**, truncated with `…` |

Only the third moves (§1.3). The first two are the same number for the same reason and stay.

A transferred selection is code or a diff. Both are routinely past 4000, and today the app refuses
the send before it happens (`controls.js:130`) and `composeTransfer` refuses to build the payload at
all (`pairs_pure.js:116`, "select less").

### 1.2 The fix is on the client, and the relay is not touched

Raising the relay cap fixes this for nobody who has not upgraded the relay, and §0 says most people
have not. It is also unnecessary: **the wire already carries arbitrary text, one message at a time.**

The composer splits at `SEND_TEXT_MAX` into N `send_text` messages, then sends the single
`send_keys ['Enter']` that submits. This works against every relay ever shipped.

Three properties make it safe, all of them already true:

- **Order.** The relay's handler loop awaits each message before reading the next, so N sends land
  in the order they were written.
- **Settling.** `SEND_SETTLE` (0.15s) is already awaited after every `send_text`, for exactly this
  reason — so a following `send_keys` lands late enough to submit.
- **No submit between chunks.** Only `send_keys ['Enter']` submits. A chunk is typed into the
  agent's composer and waits there.

**Split on line boundaries** where the text has them, hard-cut where a single line is longer than
the cap. A chunk boundary mid-line is invisible to the agent — it is one composer either way — but a
boundary mid-line is visible in the *audit log*, which logs per message, and a log that splits a
diff mid-hunk is harder to read than one that does not.

### 1.3 What the transcript keeps

`CONV_TEXT_MAX` is raised to `CONV_TEXT_MAX = 16000`. It is not the wire cap and never was: it is
how much of one message a transcript stores, and D1 says the record is what was said. A record that
truncates the payload at 4000 and writes `…` is a record that cannot answer "what did I send it".

It stays bounded. `CONV_ENTRY_MAX` is 5000 entries and an unbounded entry makes the ceiling
meaningless.

### 1.4 What is not changed

The relay's 4000 stays. Telegram, mac and iOS still meet it, and it is a real bound on an
unauthenticated-by-default write path. Raising it is a separate change with its own argument, and
this one does not depend on it.

---

## 2. What a working pane says on its own bubble

`syncConvBadge` (`conversation_view.js:352`) writes the pane's status onto the newest bubble as
literal text: `working`, `done`, `blocked`. It is written **in place**, never by re-rendering the
thread — the status arrives on every poll and rebuilding the thread three times a minute would take
the reader's text selection with it mid-copy. That property is load-bearing and is kept.

### 2.1 The label

`working` becomes `WORKING`, with animated dots.

The dots are a CSS `@keyframes` on a pseudo-element, not a JS timer. A timer would be a second clock
on the poll path, and a badge that animates by rewriting `textContent` is the re-render this
function exists to avoid.

Under `prefers-reduced-motion: reduce` the animation is dropped and the dots are static. A pane that
is working must still read as working without motion.

`done` and `blocked` keep their words. They are states, not activities, and there is nothing to
animate.

### 2.2 One badge per member, not one per thread

Today the badge lands on the last bubble in the thread, whoever wrote it. In a joint conversation
that is wrong: a partner that is working but not newest shows nothing at all, which is the exact
case a joint thread exists to surface.

**The badge goes on each member's newest bubble.** In a single-member thread that is the same bubble
it is on today.

---

## 3. The composer, and the row that switches panes

### 3.1 The composer is not hidden by conversation mode

It is hidden by the fold. `.terminal-view.dock-folded .term-input` (`index.html:2847`) takes the
whole composer stack away, and `dock-folded` is set by `syncBottomDock` from `bottomDockOpen()`.

The fold's purpose is to give a long pane its height back while leaving the quick actions bar —
approvals, `‹ ›` — reachable. In a **conversation** the equivalent of the pane is the thread, and
the equivalent of reading it is replying to it. Folding away the one control that writes is the
wrong trade there.

**The composer is exempt from the fold while a conversation thread is on screen.** The key docks
still fold; the text area and Send do not. Outside conversation mode nothing changes.

### 3.2 The switch row

`renderAgentTabs` (`agent_order.js:183`) replaces the pane tabs with **conversation** tabs when
`tabScope() === 'convs'` — one row, by design, because a header with two rows saying the same kind
of thing is how a bar stops being read.

The cost is that in conversation mode there is no quick pane switch, which is the thing a
conversation makes you want most: read what the architect said, switch to the implementer, reply.

**The conversation's own members become the switch row while a thread is on screen.** Not every
pane — the members, in roster order, as chips in the format `#agentTabs` already draws, with the
open one active. This is not a second row: it is the same row, scoped to the conversation, the same
way `tabScope() === 'project'` already scopes it to a Project.

---

## 4. Direct transfer from the thread

**The rule:** `doTransfer` prefills the partner's composer and stops (`transfer.js`). The read before
it lands is the checkpoint — the payload is about to be typed into *another agent's* session, and
nothing else in the app is as expensive to get wrong.

**The decision: the thread's own row sends directly, and only from the conversation view.** One
tap on Send puts the picked messages, plus whatever instructions are lit, into the chosen agent. The
pane view keeps the checkpoint.

That is a deliberate bypass, and the reasoning is that the two views are not the same act:

- In the **pane view** you are selecting rows out of a terminal. The selection is a guess at where a
  message starts and ends, the ruler exists because that guess is hard, and the composer is where
  you find out you grabbed the prompt as well as the answer.
- In the **conversation view** you are picking whole recorded messages. The bubble *is* the message.
  There is no boundary to get wrong, and the checkpoint is re-reading something you just read.

So the bypass is scoped to the view where the payload has already been read, and the checkpoint
stays where the payload is still a guess.

### 4.1 The row

Two lines inside the selection bar, above its other controls — Copy and ✕ prepare, these send, and
on a phone the two would wrap into each other.

```
┌──────────────────────────────────────────────────────────┐
│  ● scratch   ○ amp   ○ pi-3                              │   ← who it goes to
│  @review₁  @implement  @test₂  @architect   @+  Send (2) ›│   ← what is added, and the send
│  2 messages                                     Copy    ✕ │   ← prepares
└──────────────────────────────────────────────────────────┘
```

**The conversation view is a multi-agent window, and the row is where that shows.** A pair is only
where the default target is read from; three agents in one conversation is an ordinary thread and
the row serves it without one.

- **The who row** lists every *other* live member of the conversation — the source pane is excluded,
  because a message cannot be transferred to the pane that said it. The chosen one is lit and the
  rest are dimmed rather than hidden: which agents are in this conversation is information, and a
  row that showed only the target would answer a different question.
- **The chips are the shortcut list.** `SHORTCUTS` gained an `at` field — `@review` — beside the
  `label` the sheet already draws. Two fields rather than one derived from the other, so a label can
  be renamed without silently renaming a control someone has learned to tap. A shortcut added to
  that list is a chip, with nothing else edited.
- **Chips are additive.** `@review @test` is *both*, written in the order they were tapped, which is
  why a second lit chip wears its position (`@test₂`). Tapping a lit chip takes it back out. The row
  is the sentence being built, not a menu of mutually exclusive ones. `transferInstruction` joins the
  picked texts with a newline, each already rewritten for the agent about to read them.
- **No chip is a valid send**: the payload with no instruction, which is what `@as-is` used to be.
  A separate chip for "nothing" is a control for the state the row is already in.
- **`@+`** opens the same instructions as a list — the full label rather than the `@name`, and the
  way back to a chip that has scrolled off a phone. It writes the same picks the chips do.
- **Only the chips scroll.** `@+` and Send are pinned: a conversation long on instructions must
  never push the one control that sends off the edge, and `@+` is the way back to what scrolled.
- **Send is the only filled control on the row.** Picked chips are outlined in the accent; three
  chips in the same solid blue as the button that fires them would be four things that look equally
  like the action.

### 4.2 The target

**Default:** the pair partner when the pane has a healthy pair, and otherwise the first other member
— a conversation with exactly one other member has an obvious answer with no pair recorded at all.
**Overridable:** tap another agent. A target that leaves while it is chosen falls back to the
default rather than silently sending somewhere else.

Which pane is the *source* is the picked bubble's, not the open pane's — so picking the partner's
message sends it back the other way. That is `claimTransfer`, shared with the sheet so the two can
never disagree about who is being quoted. It takes the pair gate as an argument: the sheet transfers
to *the partner* and cannot open without one; the row picks its own target out of the conversation
and must not require one.

**The target and the picks live only as long as the selection does.** The next pick may be another
agent's message, and an instruction left armed across that would be attached to something nobody
chose it for.

**Two buttons that disagree are worse than one.** Where the row is drawn, the sheet's own entry
points step aside — `#selTransfer` on the bar below it, and `Transfer ›` on the pair strip. Both
always target the partner, and beside a row with a chosen target they would be a second answer to
"where did that go". The pane view keeps them both, unchanged.

### 4.3 Not armed

CLS, QUIT and Esc take two taps. Those fire from a button that sits under the thumb for as long as a
pane is open; Send needs a message picked and a target standing, and **the pick is the deliberate
act** the arm would be duplicating. The toast names where it went, because a mis-tap is otherwise
silent.

Resend is armed, because nothing precedes it.

### 4.4 The toast that would have covered it

`prefillTransfer` opens the target, and opening a stale pane starts a **loud** catch-up (§2.4 of the
deep-backfill spec) whose toast lands on top of the send's. That trigger is loud because someone
tapped a pane to read it — nobody tapped this one. `convQuietPane` marks exactly one activation as
the app's own, and the confirmation of an irreversible send outranks a report on a read nobody asked
for.

### 4.5 Resend

The last text sent to **this** pane, sent again, through `sendText` — so it is chunked, recorded and
classified like anything else typed. In memory only: a prompt worth repeating is one from the
session you are in, and a button that fires a week-old transfer into a live agent on the first tap
after a reload is a worse offer than no button.

Two taps (`armButton`), and offered only where there is something to repeat — the same rule Summary
follows, for the same reason.

### 4.6 Esc

Already built and already correct: `abortWorking` in the status bar, two taps, visible only while
the pane is working. A second Esc on the chip row would be a duplicate control for the same key, so
there is none.

### 4.7 Fixed along the way

`composeTransfer` was being handed `mine.role`, and a pair built by the Start dialog carries a bare
`recentFingerprint` with no role at all — so the receiving agent was told the text came from
**"undefined"**. It now falls back to the pane's live label.

## 5. Landing at the end of what you switched to

`renderConvView` decides whether to follow the newest message with:

```js
const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
```

On a pane **switch** that reads the outgoing thread's scroll position, because the box has not been
redrawn yet. Switch away from a thread you had scrolled up in and you arrive in the middle of the
new pane's history, at whatever offset the old one happened to be at.

The rows have the same shape of bug from the other direction: `openTerminal` resets
`userScrolledUp = false`, so the rows will follow — but not until the first read lands.

**`openTerminal` puts both the thread and the rows at the end, before anything is drawn into them.**
`stick` then governs everything after, which is what it is for: a reader who scrolls up keeps their
place, and a reader who switches panes gets the end of the new one.

---

## 6. What none of this does

- **No relay change.** §1 is a client-side split against the cap that is already there; §4 adds no
  key the relay did not already allow.
- **No wire change, no new message type.**
- **No change to what is recorded, or when.** §1.3 changes how much of one message the record keeps;
  the events that write it are untouched.
- **No auto-send outside the conversation view** (§4).

---

## 7. Constants

| Constant | Value | Where |
|---|---|---|
| `SEND_TEXT_MAX` | 4000 | `pairs_pure.js` — now the **chunk size**, not the payload limit |
| `CONV_TEXT_MAX` | 4000 → **16000** | `conversation_pure.js` — one stored message |
| `SEND_SETTLE` | 0.15s | `herdr_relay.py` — unchanged, and what makes the chunked send safe |

---

## 8. Acceptance criteria

1. A 12000-character selection transfers whole: three `send_text` messages, one `send_keys`, and the
   agent's composer holds all 12000 before Enter.
2. The same send against a relay that has never been upgraded behaves identically.
3. A message longer than 4000 characters is stored whole in the transcript, up to 16000.
4. A working pane's newest bubble reads `WORKING` with moving dots, and static dots under
   `prefers-reduced-motion`.
5. In a joint thread, two members working at once both show a badge.
6. Rebuilding the badge does not clear a text selection made in the thread.
7. The composer is on screen with a conversation thread open and the docks folded.
8. With a thread open, the header row switches between the conversation's members.
9. Switching to a pane lands at the newest bubble; switching to one with rows lands at the last row.
10. Scrolling up in a thread and staying there is not undone by the next poll.
11. Send in the thread puts the picked message into the chosen agent and submits it, in one tap.
12. The same selection made on pane rows offers no row — only the sheet.
13. A conversation with another live member offers the row with no pair recorded at all; a pane
    alone in its conversation offers none.
14. Two chips send both instructions, in the order they were tapped; tapping one again removes it.
15. The target defaults to the pair partner, can be set to another member, and is forgotten with the
    selection.
16. A direct transfer is recorded as `via: transfer`, not as something typed.
17. Resend repeats the last text sent to that pane, on the second tap, and is absent on a pane that
    has been sent nothing.

---

## 9. Order of work

§5 (a bug), §2 (visual, self-contained), §1 (the send path), §3 (layout), then §4 in its own pass.
All done.
