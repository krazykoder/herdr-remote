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

## 4. The conversation window's dock

**The surface:** `#convView` — the standalone conversation window, opened from a card on the landing
page. Not `#convThread`, the thread a *pane* shows inside `terminalView`. The pane's thread already
has a composer that knows where it is typing, and it is unchanged by this section.

**The rule it bypasses:** `doTransfer` prefills the partner's composer and stops (`transfer.js`). The
read before it lands is the checkpoint — the payload is about to be typed into *another agent's*
session, and nothing else in the app is as expensive to get wrong.

**The decision: the conversation window sends directly.** One tap on Send puts the picked messages,
plus whatever instructions are lit, into the chosen agent. The pane view keeps the checkpoint.

That is a deliberate bypass, and the reasoning is that the two are not the same act:

- In the **pane view** you are selecting rows out of a terminal. The selection is a guess at where a
  message starts and ends, the ruler exists because that guess is hard, and the composer is where
  you find out you grabbed the prompt as well as the answer.
- In the **conversation window** you are picking whole recorded messages. The bubble *is* the
  message. There is no boundary to get wrong, and the checkpoint is re-reading something you just
  read.

So the bypass is scoped to the surface where the payload has already been read, and the checkpoint
stays where the payload is still a guess. `conv_dock.js` is that scope: it holds every part of this
section, it never queries `#convThread`, and `transfer.js` never sends.

### 4.1 A dockless editor with a bottom bubble

The window is read top to bottom — header, thread, and the dock floating over the end of it:

```
┌──────────────────────────────────────────────────────────┐
│  ‹  new authentication feature   4 messages  3 panes ▾   │
│                                                          │
│    scratch  the other pane spoke first              ✓    │
│    amp      the third pane                          ✓    │  ← the thread, scrolling
│    Architect 1  Ready. Name the change.             ✓    │     behind the dock
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ● Architect 1   ○ amp                    🤖    ⇱   │  │  ← who it goes to, the list, the pane
│  │ @review₁  @implement  @test₂  @+  ⤵    Send (1) ›  │  │  ← what is added, and the send
│  │ ┌────────────────────────────────────────────┐     │  │
│  │ │ looks good, ship it                    ( ➤ )│    │  │  ← the composer bubble
│  │ └────────────────────────────────────────────┘     │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**It is one bubble.** The address row, the instruction chips and the text are a single rounded
control, not three panels that happen to be near each other: there is one message being written, and
who it is for is part of writing it. A hairline divides the row from the text; nothing else does.

**The bubble wears the agent it is addressed to.** Its border — and a 6% wash under it — take that
pane's harness colour, the same one that agent's messages carry in the thread and the same one the
lit pill takes. Which agent is about to receive another agent's output is the fact worth being sure
of, and it is answered on the thing being written, where the eye already is. A harness the app has
no colour for falls back to the ordinary border.

**The pills name a pane the way the app names one anywhere else**: live dot, label, harness badge —
"scratch" alone does not say whether that is a codex or a claude. They are drawn in the thread's own
face, case and size, and so are governed by the pane menu's conversation-text control rather than by
the root font: a pill naming a member in a different type from the bubbles naming that same member
reads as a different member. The text scales; the 32px tap target does not.

**The chips and the pills are the same height** (26px). Two rows of controls in one bubble that do
not line up read as two bars that happened to be stacked.

**A chip writes its instruction into the box.** That is the default, because it is the honest one:
what the agent will receive is on screen, editable, before anything is sent, and it is inserted at
the caret so a chip tapped mid-sentence adds to what was being written. The `⤵` toggle beside `@+`
turns it off, and a chip goes back to riding the send as a lit, ordinal-numbered instruction — for a
long prompt that a wall of boilerplate above it would bury. Switching modes clears whatever was
armed in the other one: an instruction that is invisible in the mode you are now in must not travel
on the next send. The setting is remembered.

**The composer is the pane's composer.** Monospace, sized by the same `--input-font` control in the
pane menu: writing to an agent from here is the same act as writing to it from its pane, and a
monospace box is also what makes the drawn block exactly one character wide. The ghost is bound to
the same rule — a ghost in a different face paints the block on the wrong character.

**The whole bubble is the field.** A tap anywhere in the composer puts the caret in the text, the
way tapping a message box on a phone does; buttons inside it keep their own taps. A field that has
to be hit exactly is a field that is missed on a phone.

**`@+` closes on a tap past it**, and on a second tap of `@+`. The listener is in the capture phase
and excludes the chips — a chip's own handler rebuilds the list it was tapped in, so by the time a
bubbled click arrived the target would be detached and the menu would close on its own taps.

**The conversation window carries the `WORKING` badge too**, on each member's newest bubble — and
several at once, because a panel for several agents is a panel where several of them are working.
`syncConvBadge` is the pane thread's, given the box to write into.

**The cursor is drawn, not borrowed.** A ghost copy of the text sits under a field whose own caret
is transparent, and a block is painted at the caret — always, dimmed when the field is not focused.
This is a box that types into terminals, and where the next character lands is worth knowing before
tapping in; the platform's hairline caret disappears exactly when a phone keyboard is not up.

**The block follows the selection, not the keystroke.** A held arrow repeats without ever firing
`keyup`, a drag selects while the mouse moves, and undo, autocorrect and dictation move the caret
with no key at all — so the ghost is redrawn on `selectionchange` (on the field and on the document,
because browsers disagree about which fires for a textarea), with a `keydown`-then-`rAF` fallback
for one that fires neither.

**One message means one send.** With bubbles picked, the composer's own ➤ does what `Send (n) ›`
does — the row's button is a labelled second view of it, showing the count. Two buttons in one
bubble that sent different things would be a way to lose the quote by tapping the nearer one.

**It floats.** `position: sticky; bottom: 0` with `margin-top: calc(-1 * var(--dock-h))`, so the
thread runs *behind* it rather than ending above it, under a gradient to the page background. The
composer is a rounded bubble, slightly raised — the same shape as a message, because that is what is
being written. `--dock-h` is measured by a `ResizeObserver`, never guessed: the row, the `@+` list
and a growing composer all change it, and a guessed number is either a gap under the last bubble or
a bubble that cannot be scrolled to. `#convViewThread` grows to fill the window so that a
conversation of three messages does not leave the composer floating halfway up an empty view.

**The dock is absent only when nothing in the conversation is live.** That is the ordinary end state
of a record, not a failure: the thread stays readable, and a composer that could only fail is worse
than none.

### 4.2 The address row

- **Every live member** of the conversation, in roster order (which is the order they joined). The
  chosen one is lit and the rest are dimmed rather than hidden: which agents are in this
  conversation is information, and a row that showed only the target would answer a different
  question.
- **A pick never takes a member out of the row.** With a bubble picked the pane that wrote it cannot
  *receive* it — a message cannot be transferred back into its own session — so it is marked as the
  source (dashed, dimmed, disabled) rather than removed. A row that shed its members every time one
  was quoted would answer "who is in this conversation" differently on every tap, and it would take
  the reader's other choices away over a state one tap undoes. The mark is suppressed when it is the
  only member there is: a pill drawn dead beside a composer that works would be lying.
- **A picked message defaults to its author's pair.** With a bubble picked and nobody having said
  where it is going, the target is the pane the author is paired with, when that pane is in this
  conversation. A conversation is still not a pair — membership alone is what makes an agent a
  target, no pair is required, and pair *health* is never consulted — but "the first pill" is a fact
  about the row and "the partner" is a fact about the message. One tap on any other pill overrides
  it, and a choice made before the pick is never overridden: a default fills a blank, it does not
  correct a reader.
- **`🤖` opens the row as a list**, for a row that has scrolled past the edge of a phone and for a
  name a pill cut off. Same members, same order, the lit one ticked, the source named but not
  choosable. It wears the agent icon rather than a caret, because a caret could open anything. One
  list at a time: opening it closes `@+`, and opening `@+` closes it.
- **`⇱` opens the addressed pane's terminal**, not its thread — the thread is what this window
  already is, and what a reader leaves it for is the rows, the keyboard and the approval buttons.
  Beside the list it is chosen from, because "who am I talking to" and "take me there" are the same
  question asked twice.
- **The last agent written to comes back to the left**, when the sort is on. Both rows scroll and a
  phone shows their left end, so what was used last is put where the thumb already is. Only *use*
  moves anything — the rest hold the order they had, and neither a poll nor an arriving message ever
  reorders the row. The order is remembered across reloads, and the sort applies to the row, the
  list behind `🤖` and the fallback target alike, so all three read the membership the same way.
- **A conversation is not a pair.** Membership is what makes an agent a target; no pair is consulted
  anywhere in this section. Three agents in one conversation is the case the row exists for.
- **Sticky.** The target is not a property of a selection — it is who you are talking to. Having
  chosen an agent you go on talking to it, message after message, until you choose another or leave
  the conversation.
- **Honest.** A target that exits, or that turns out to be the source of what is being transferred,
  falls back to the first member rather than silently sending somewhere else.
- **A conversation of one** still draws the row — it is who the composer is addressing — and a pick
  there simply offers no Send, because there is nobody to transfer to.

### 4.3 The chips

- **The chips are the shortcut list.** `SHORTCUTS` gained an `at` field — `@review` — beside the
  `label` the sheet already draws. Two fields rather than one derived from the other, so a label can
  be renamed without silently renaming a control someone has learned to tap. A shortcut added to
  that list is a chip, with nothing else edited.
- **Additive.** `@review @test` is *both*, written in the order they were tapped, which is why a
  second lit chip wears its position (`@test₂`). Tapping a lit chip takes it back out. The row is
  the sentence being built, not a menu of mutually exclusive ones. `transferInstruction` joins the
  picked texts with a newline, each already rewritten for the agent about to read them.
- **Optional.** No chip is a valid send: the payload, or the typed text, with no instruction. A
  separate chip for "nothing" is a control for the state the row is already in.
- **Spent by the send.** An instruction is attached to one message. The agent you chose is not — see
  4.2. That asymmetry is the whole of the state model: sticky target, spent picks.
- **`@+`** opens the same instructions as a list — the full label rather than the `@name`, and the
  way back to a chip that has scrolled off a phone. It writes the same picks the chips do, and it is
  redrawn on every tap so it can never show stale ticks.
- **Recency, the same as the pills.** The instruction last used moves to the left end, when the sort
  is on. Turned off, both rows hold still: a row you can reach for without looking is a better index
  than recency once you have learned where things sit. One setting governs both rows —
  *Sort the conversation dock by use*, on by default — and what was learned is kept while it is off,
  so turning it back on picks up where the reader left off rather than from nothing.
- **Only the chips scroll.** `@+` and Send are pinned: a conversation long on instructions must
  never push the one control that sends off the edge, and `@+` is the way back to what scrolled.
- **Send is the only filled control.** Picked chips are outlined in the accent; three chips in the
  same solid blue as the button that fires them would be four things that look equally like the
  action.

### 4.4 The two sends

**`convSend()` — typed text.** What is in the composer, with any lit instructions above it, to the
lit member. No checkpoint and no prefill: there is nothing to prefill *into*, and what is being sent
is what the composer already shows. Ctrl/Cmd+Enter sends; Enter writes a newline, because there is
no shell behind this composer to make a line end at one.

**`convDockSend()` — the picked bubbles.** The picked messages in thread order, composed by
`composeTransfer` and named for the member that wrote them, into the lit member. Whatever was typed
goes under the quote rather than being dropped — a payload with a note of your own on the end is
what `classifyVia` already calls `mixed`. `pendingTransfer` is set first, so the receiving pane's
transcript records where the text came from instead of claiming the reader typed another agent's
words.

**Neither opens a pane.** The reader stays in the conversation; `Open pane` is the only thing that
leaves it. Sending to an agent whose pane is not on screen is the point of a multi-agent window.

**Messages from two agents at once are refused**, the same way the sheet refuses them: two agents'
messages quoted as one is two conversations, and the dock stands down rather than guessing which of
them the payload belongs to.

### 4.5 Not armed

CLS, QUIT and Esc take two taps. Those fire from a button that sits under the thumb for as long as a
pane is open; Send needs a message picked and a target standing, and **the pick is the deliberate
act** the arm would be duplicating. The toast names where it went, because a mis-tap is otherwise
silent.

Resend is armed, because nothing precedes it.

### 4.6 Leaving

Closing the conversation clears the target, the picks and the draft. All three belong to that
conversation, and none of them means anything in the next one.

### 4.7 Resend

The last text sent to **this** pane, sent again, through `sendText` — so it is chunked, recorded and
classified like anything else typed. In memory only: a prompt worth repeating is one from the
session you are in, and a button that fires a week-old transfer into a live agent on the first tap
after a reload is a worse offer than no button.

Two taps (`armButton`), and offered only where there is something to repeat — the same rule Summary
follows, for the same reason.

### 4.8 Esc

Already built and already correct: `abortWorking` in the status bar, two taps, visible only while
the pane is working. A second Esc on the chip row would be a duplicate control for the same key, so
there is none.

### 4.9 Fixed along the way

`composeTransfer` was being handed `mine.role`, and a pair built by the Start dialog carries a bare
`recentFingerprint` with no role at all — so the receiving agent was told the text came from
**"undefined"**. It now falls back to the pane's live label.

`sendText` was split: `sendTextTo(paneId, text)` is the send, and `sendText()` is the pane
composer's caller. A composer that is not the pane's needs the first half and none of the second.

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
- **No auto-send outside the conversation window** (§4). The pane view's transfer still
  prefills and stops.

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
11. Send in the conversation window puts the picked message into the chosen agent and submits it,
    in one tap, without opening a pane.
12. The pane's own thread is unchanged: a pick there offers the sheet, and no dock.
13. The dock serves a conversation with no pair recorded at all; a conversation with no live member
    is offered no dock; a conversation of one can be typed to but offers no Send.
14. Two chips send both instructions, in the order they were tapped; tapping one again removes it.
15. The target is any other member, is remembered across sends, and is forgotten on leaving the
    conversation — as are the picks and the draft.
16. A direct transfer is recorded as `via: transfer`, not as something typed; typing under a quote
    is recorded as `mixed`.
17. The dock sits on the bottom of the window with the thread scrolling behind it, at a height the
    page measured rather than guessed.
18. Resend repeats the last text sent to that pane, on the second tap, and is absent on a pane that
    has been sent nothing.
19. A pick leaves every member in the row: the one that wrote it is marked and disabled, the others
    stay one tap away, and choosing one before the pick still holds after it.
20. `🤖` lists the same members in the same order and choosing there is the same choice; it and `@+`
    are never open together; `⇱` opens the addressed pane's rows, not its thread.
21. On a phone both rows are one line that scrolls sideways, with their right-hand buttons on
    screen.
22. The composer is monospace and follows the pane menu's text-size control, ghost included, and a
    tap anywhere in it focuses the field.
23. With the sort on, the agent and instruction last used are first in their rows, across a reload;
    off, both rows hold their original order, and what was learned survives being turned off.
24. A picked message with a pair recorded for its author lights that partner, not the row's first
    member; a pill tapped before or after the pick beats the default.
25. Holding an arrow key walks the drawn block across the text, and a selection made with the mouse
    moves it too.

---

## 9. Order of work

§5 (a bug), §2 (visual, self-contained), §1 (the send path), §3 (layout), then §4 in its own pass.
All done.
