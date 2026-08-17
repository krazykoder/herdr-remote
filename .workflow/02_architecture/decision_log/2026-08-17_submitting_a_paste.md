# Decision — A submit is confirmed against the pane, not timed against a clock

**Date:** 2026-08-17
**Context:** three attempts at one line of behaviour — `relay/herdr_relay.py`, the `send_text`
handler and `submit_paste`. Proven by `tests/test_submit_paste.py`.
**Decided by:** the user, on the question "if the UI is booting then 0.9s will fail as well — how do
we resolve that?"

---

## The premise

> "If UI is booting - then 0.9s will fail as well - then ? how we resolve that"

That question ends the argument. There is no constant that is right for both a TUI that is starting
(seconds) and a TUI laying out a paste (milliseconds), and every version of this before it picked
one anyway.

---

## The history, because it is the reason

Each of the first two designs was shipped as a fix for a real bug, and each became the next bug.

### 1. The Enter as its own client message

The browser sent `send_text`, then `send_keys ["Enter"]`. The relay held the first handler open for
`SEND_SETTLE` (0.15 s) so the second landed late enough; the message loop is a sequential
`async for`, so this worked as a gap.

**Failed on:** an agent that had only just started. A claude or codex 200 ms into its own boot has
no composer, and the Enter went nowhere. The New agent dialog's opening prompt hit this every time.
It was reported as "the app said it sent something and nothing happened".

### 2. `pane run` — text and Enter in one herdr call

`7362c69` replaced the two messages with one flag. herdr's `pane run` sends both, so nothing can
arrive between them.

**Fixed:** the Enter could no longer be separated from the text by anything in flight.
**Failed on:** the gap went to zero. herdr pastes with bracketed paste — the same fact the `respond`
handler beside it has documented all along — and a TUI still laying out a transferred payload drops
an Enter that close behind. Short generated commands (`/review`) submitted; the same command with a
few words typed after it did not. Intermittent, because it depended on how much there was to lay
out, which is why it read as "sometimes it works".

### 3. Scaled settle

An interim step in `005fb7f`: keep the relay pressing Enter, scale the wait by the length of the
text (0.15 s → 0.9 s at the 4000-character cap).

**Failed on:** the same thing as (1). A boot is not proportional to the length of what you pasted.

---

## D1 — The readiness signal exists, and it is `agent_status`

**Proposed (repeatedly, in comments in this file):** herdr exposes no readiness signal, so a fixed
delay is the only option.

**Decided:** that was wrong. `herdr pane list` reports `agent_status` per pane, and it answers all
three states this needs to tell apart:

| What herdr reports | What it means here |
|---|---|
| no status / no agent on the pane | the TUI has not started — do not press anything yet |
| `idle`, `done` | a composer waiting for something to submit — press Enter |
| `working`, `blocked` | it is acting on what it was handed — stop |

`submit_paste` pastes, then presses Enter and watches that field until it moves. `submit_settle`
survives as the wait before the *first* press only, and nothing depends on its value any more.

## D2 — Never press Enter at a `blocked` pane

A blocked agent is showing a permission prompt, and Enter accepts whatever it has selected. This is
the reason the design verifies rather than simply pressing twice and hoping: a blind retry is one
badly-timed keystroke away from approving a tool call nobody approved.

`blocked` is therefore in the same set as `working` — proof the submit landed, and an absolute stop.

## D3 — Bounded, and loud when it gives up

Four presses at most, eight seconds at most. A pane that never moves gets a `WARNING` naming the
pane, because silence is what made this take three attempts to find: the failure looks exactly like
a message nobody wrote.

## D4 — A pane already `working` is a queued message, and is not verified

Text pasted at a busy agent queues behind what it is doing, and the pane reports `working` whether
the Enter landed or not. There is nothing to watch, so `submit_paste` presses once and returns
`False` — "not proven" rather than a claim it cannot support. Only the first look can tell this
apart from `working` *because* of our own Enter.

---

## What this does not solve

`False` is not surfaced to the client. The relay logs it; the browser still clears its composer on
send. Wiring the result back to a client that could re-offer the text is the obvious next step and
was deliberately not built here — it is a protocol change, and this was a bug fix.
