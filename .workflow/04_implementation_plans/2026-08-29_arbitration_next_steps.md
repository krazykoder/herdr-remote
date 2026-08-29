# Arbitration branch — what to take from firstmate, and in what order

Date: 2026-08-29
Branch: `feat/arbitrator`
Source: [the comparison note](../07_dev_notes/2026-08-28_firstmate_vs_arbitrator_comparison.md)
Status: shortlist. Items 1 and 2 are ready to plan; items 3–5 are parked with the question that
gates each.

---

## Proof of discovery

Read before writing any of this down: `relay/arbitration.py` (`turn_ended`, `prompt`, `_send`,
`_deliver`), `relay/herdr_relay.py` (`arbitrate_turn_end`, `arbitration_entries_of`, the two poll
call sites), `relay/agent_configs.py` (`Provider`, `Alias`).

| Where | What it does today |
|---|---|
| `relay/arbitration.py:1580` `turn_ended(..., wrote=)` | A turn that recorded nothing writes an event and asks nothing |
| `relay/herdr_relay.py:1350, 2451` | Both poll call sites already pass the real `wrote` |
| `relay/herdr_relay.py:2479` `ARB_DIGEST = 6` | Every prompt carries the last 6 turns of the roster, in full |
| `relay/arbitration.py:1755` `prompt()` | Builds that digest into a fresh body and types the whole thing at the arbitrator pane |
| `relay/arbitration.py:594` `_send()` | Returns False only when the pane never confirmed |
| `relay/arbitration.py:1995` `_deliver()` | One unconfirmed send pauses the session. No retry |

Invariants to preserve: N1 (the relay never reads the prose it forwards), N7 (a busy pane is never
written to), N8 (an automated send is visible in the thread), the drop box is deleted before a
prompt returns, and the budget counts only what certainly happened.

---

## Corrections to the comparison note

**The note's headline token item is already built.** "Skip the arbitrator LLM call when the trigger
carries nothing new" is `turn_ended`'s `wrote` parameter, and both poll call sites pass it. There is
no work left there.

**The note's headline reliability item is half-wrong.** The send path does not infer delivery from
pane status — `submit_paste` proves it, and `_send` refuses to guess a False into a yes. The gap is
what happens *next*: one unproven send pauses the whole session and only a person can restart it.
firstmate's answer to the same event is to re-ring and escalate, not to stop.

---

## Item 1 — Re-ring an unconfirmed send before pausing the session

**Class A.** No contract change, no new wire message, no new state.

Today a transient False from `submit_paste` — most often a member that was momentarily busy — ends
the session's autonomy. The instruction is already in the thread and probably landed; the session
stops anyway and waits for a human who has nothing to decide.

What to build: `_deliver` retries the send a bounded number of times with a wait between, and pauses
with `send_unconfirmed` only after the last one. The retry must re-resolve the pane the way the
first attempt does (a pane that moved is `target_not_live`, not a retry), must not write a `sends`
row or spend a step for an attempt it still cannot prove, and must write one event per attempt so
the path shows what was tried.

Highest functional ROI on the list: smallest diff, and it removes the commonest reason a healthy
session needs a person.

**Open question that gates the plan:** how many attempts and how far apart? A member that is
`working` is refused by N7 rather than retried, so this only covers the case where the pane took the
text without confirming — which argues for few attempts (2–3) close together (seconds), not a long
escalation ladder.

---

## Item 2 — Send the digest as a delta, not as the whole window

**Class B.** Additive: the prompt files change shape, nothing on the wire does.

This is the real token bill and the note missed it. The arbitrator is a **live pane** whose context
already holds every prompt this session has sent it. `arbitration_entries_of` reads the last
`ARB_DIGEST = 6` turns from the record and `prompt()` types all six into that pane every time. Turn
N+1 overlaps turn N by five entries. Over a default budget of 8 steps the same prose is retyped
roughly five times.

What to build: the trigger prompt carries the turns recorded **since the last prompt for this
session**, and the full six-turn window only when the arbitrator cannot be assumed to hold the
history — the first prompt of a session, a re-brief after `arb_edit` swapped the arbitrator, and the
prompt that follows an `arb_resume`. The record already has the row ids to make "since" exact; the
session already knows its last sequence.

This is firstmate's "brief once, deltas only" applied where it actually costs us.

**Open question that gates the plan:** what a delta of zero rows means. It should not be reachable —
`wrote=False` already stops those triggers — but a clock trigger (`idle`, `runtime`) has no turn
behind it at all and would produce one. Either those keep the full window, or they carry a note and
no entries.

---

## Item 3 — Dispatch profiles / effort-aware arbitrator selection (parked)

**Class B, larger than the note assumes.** `arb_start` names an existing pane; it does not start
one. Choosing a model per session means the relay spawning the arbitrator, which is `start_agent`
plus an agent config id — real machinery, and a new failure mode (the session cannot begin because
the spawn did not). `relay/agent_configs.py` already carries the model per alias, so the *config*
half is free; the *lifecycle* half is not.

**Question for the user:** should `arb_start` be able to spawn its own arbitrator, or does the
client keep picking a pane it already has? Everything else here depends on that answer.

---

## Item 4 — Task typing: `scout` vs `ship` (parked)

**Class B.** A `kind` on `arb_start` that constrains the legal gates — a `scout` session may only
`hold` / `call_human` / `done`, never `implement`. The gate list is already per-session
(`gates_json`), so this is a narrower gate set at start and a validator that already refuses
anything outside it. Small. Parked only because nobody has asked for a read-only session yet.

---

## Item 5 — Commits as a liveness signal (parked)

**Class A.** `git_probe` already sees new commits at turn end. A member that is committing is
working even if its pane looks quiet. Worth having when the idle clock starts causing false
triggers; not before.

---

## Not taking

Worktree management, `fm-spawn.sh`, secondmate SSH remotes — herdr owns pane lifecycle and
`HERDR_REMOTES` already covers multi-host. Persistent standing arbitrator — interesting, but it
changes what a session *is*, and that is a Phase 1 question rather than a branch item.

---

## Order

1. Item 1 (re-ring) — functional ROI, Class A, one file.
2. Item 2 (delta digest) — token ROI, Class B, two files.

Both need their open question answered before a plan is written. Items 3–5 stay parked.

## Verification for both

```
.venv313/bin/python -m unittest discover -s tests -t tests
.venv313/bin/python tests/e2e/e2e_arbitration.py
node tests/e2e/e2e_arb_ui.js
```

Item 2 additionally needs a check that the second prompt of a session is materially shorter than the
first — the prompt bodies are written to disk next to the drop box, so the assertion is on files the
loop already produces.
