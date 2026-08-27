# Plan: A trigger that carries nothing, and a decision that sends nothing

Decision log: `../02_architecture/decision_log/2026-08-27_a_trigger_that_carries_nothing.md`.
**Class B** — one gate added to `DEFAULT_GATES`, one pause reason, one condition on an existing
trigger call, one anchor fix in the conversation log. No message shape changes.

## Goal

Two independent fixes, shipped together because the second is what makes the first survivable when
a duplicate slips through anyway.

**A. A turn end that recorded nothing does not wake the arbitrator** — and the duplicate that
produced those empty writes stops being recorded at all.

**B. `hold`** — a gate that records a decision, sends nothing, and leaves the session armed.

Measured against `s-20260826-1746-ab40`: A removes 4 of 24 decisions outright, B collapses the
19:19:41–19:21:50 escape from four decisions and five wake-ups into one decision and none.

## File-by-file

### A1 — `[MODIFY] relay/conversation_log.py`

- `_aligns(fresh, i, keys, said=())` gains a fourth parameter, the set of echoed-send keys.
  Walking backwards from `i`, it skips any `fresh[j]` that is a `user` message whose `_key` is in
  it before comparing against the next anchor key. A prompt this relay typed is in the record
  either way and is not evidence about where the record ends inside a window, so it must not break
  a run.
- The set is **not** `_sent_after_read`. That one stops at the record's newest row read off the
  pane, so a prompt with a recorded turn on top of it has already left it — which is precisely the
  case, since the turn being re-read is that turn. A new `_sent_keys(pane)` answers the question
  actually being asked: every prompt this relay typed at the pane within `TRAILING_USER_MAX` rows,
  echoed since or not.
- `_messages_after_record` computes it once, above the alignment loop, and passes it to `_aligns`.
  The post-alignment filter keeps using the narrow `_sent_after_read` set: a prompt this relay sent
  and has already seen recorded is not evidence that a *new* one is an echo.

Nothing else moves. The last-resort path, `_last_tail` dedupe and `turn_messages` fallback all stay
as they are.

### A2 — `[MODIFY] relay/arbitration.py`

- `turn_ended(self, pane_id, entries, kind="turn_end", wrote=True)`. In the branch where the pane
  resolves to a member of an armed session, `wrote=False` writes
  `_event(s["id"], "trigger", f"{member_id} ended a turn — nothing new was recorded", once=True)`
  and returns `None`.
- Placed after the `_warming` check and after the `s["state"] != "active"` check, so an unarmed
  session still reports the turn the way it does today. The rule is about members only —
  `arbitrator_finished` is resolved by the caller before this is reached and is never gated.

### A3 — `[MODIFY] relay/herdr_relay.py`

- `arbitrate_turn_end(pane, pane_id, wrote=True)` passes `wrote` through to `turn_ended` and not to
  `arbitrator_finished`.
- Poll loop (~line 2343): `note_turn_ids` already receives the ids `record_turn_end` returned.
  Keep them in a local and call `arbitrate_turn_end(a, pid, wrote=bool(ids))`.
- `collect_late_turns` (~line 1251): same, from the same call.
- Both sites still call `arbitrate_turn_end` unconditionally — the broadcast and the event line are
  wanted either way. Only the prompt is suppressed.

### B1 — `[MODIFY] relay/arbitrator.py`

- `HOLD = "hold"` beside `CALL_HUMAN`.
- `validate`: the `gate == CALL_HUMAN` branch becomes `gate in (CALL_HUMAN, HOLD)` — both forbid
  `to` and `instruction`, both still require `why`. `ambiguity`/`decision_complexity` stay
  unrequired for these two, as today.

### B2 — `[MODIFY] relay/arbitration.py`

- `DEFAULT_GATES` gains `{"name": "hold", "template": ""}`, after `phase_plan` and before
  `call_human`. A session that supplied its own gates does not get it — same rule as every other
  gate, and `arb_edit` is how an existing session takes it up.
- In the collector, beside the existing `doc["gate"] == "call_human"` branch:
  - record the decision row and the `decided` event as usual;
  - `_record_turn(s, kind="decision", text=doc["why"], decision_id=decision_id)` so the thread
    carries it, exactly as `call_human` does;
  - `UPDATE sessions SET state='active', steps_used=steps_used+1 WHERE id=?` — a step, but not
    `consecutive`, and back to armed rather than paused;
  - return `{"outcome": "hold", "why": ..., "decision_id": ...}`.
- Consecutive-hold bound: read this session's *valid* decisions newest-first and count the trailing
  `hold` run, stopping at the first other valid gate. Do not query only `gate='hold'`, which would
  skip an intervening action and turn non-consecutive holds into a pause. At 3,
  `self.pause(session_id, "holding")` instead of returning to armed. Read off the `decisions` table
  rather than a new column — the same way the rejection bound reads `valid=0` rows at a sequence.
- `starter_prompt`: one paragraph on when to hold. "Choose `hold` when the trigger carried nothing
  the previous turn did not already say, when the member you would write to is already working, or
  when the right next step is to wait for a turn that is still running. A hold is a decision: say
  why. Three holds in a row stop the session."

### B3 — `[MODIFY] web/src/arbitration.js`, `web/src/conversation_view.js`

**This is a bug fix before it is a new render path.** `delivered: !!d.send` is false for any
decision that sends nothing, and `call_human` sends nothing — so every `call_human` in the thread
already carries a red `not confirmed` badge today, and its detail sheet already says "the pane
never confirmed it". Five of them in `s-20260826-1746-ab40`. `hold` would join an existing wrong,
not create one.

- One shared set, `NO_SEND_GATES = new Set(['call_human', 'hold'])`, in `arbitration.js` where the
  entry is built. A gate that delivers nothing is a property of the gate; deriving it from an empty
  template would need the templates on the wire, which they are not.
- Carry `noSend` on the decision entry beside `delivered`. `delivered` keeps its meaning — a member
  send the relay stands behind — and the two questions stay separate rather than one field
  answering both.
- `conversation_view.js:890`: the `not confirmed` rail is drawn only when `!e.noSend && !e.delivered`.
- `arbitration.js:1422`: the detail sheet's "Nothing recorded as delivered" paragraph is suppressed
  for a no-send gate, and says what the decision *was* instead — a hold that is waiting, a
  `call_human` that stopped the session.
- Add `holding` to the short and explanatory pause-reason maps beside `send_unconfirmed`. The
  generic fallback would say “holding”, but the pause needs to say that three no-send decisions
  stopped the loop.

### `[MODIFY] tests/test_conversation_log.py`

- A turn re-read after a relay-sent prompt sits between the last two pane-read messages is recorded
  once, not twice. This is the 2775/2780 case, minimised: record a turn, send a prompt, send a
  second prompt, re-read the same window, assert no new rows.
- The existing anchor tests still pass — the skip must not let a run align through a message a
  *member* typed, only through one the relay sent.

### `[MODIFY] tests/test_arbitration.py`

- A turn end with `wrote=False` writes a `trigger` event and asks nothing; the session stays armed.
- `wrote=False` at the arbitrator's own pane still collects the drop box.
- A `hold` decision: no send, no `consecutive` spent, one step spent, session armed, a `decision`
  row in the thread.
- Three consecutive holds pause with `holding`; a hold, a send, then two holds does not.
- `hold` is refused when the session's gates do not include it (`unknown_gate`), and refused with
  `to`/`instruction` present (`field_not_allowed`).
- A valid non-hold decision between holds resets the three-hold run; a rejected record does not.

### `[MODIFY] tests/e2e/e2e_arb_ui.js`

- A `hold` bubble has its gate and `why`, no recipient and no `not confirmed` warning; a paused
  `holding` session has the human pause label and explanation.
- A `call_human` bubble carries no `not confirmed` warning either — the regression test for the
  existing bug, which must fail against today's client.

### `[MODIFY] CLAUDE.md`

`hold` in the gate list where the arbitration lifecycle messages are described; the `holding` pause
reason alongside the others.

## Verification

Only what these changes touch:

```bash
.venv313/bin/python -m unittest discover -s tests -t tests -p 'test_arbitration.py'
.venv313/bin/python -m unittest discover -s tests -t tests -p 'test_conversation_log.py'
.venv313/bin/python tests/e2e/e2e_arbitration.py        # ~40s, the loop end to end
node tests/e2e/e2e_arb_ui.js                             # hold/no-send presentation
```

The browser suite is untouched. `e2e_arb_ui.js` is the focused client check for B3.

## Acceptance

1. A pane going `working → done → idle` with nothing new on screen produces **one** row in `turns`,
   not two.
2. A turn end that records no rows produces a `trigger` event naming that, and no prompt.
3. The arbitrator's own turn end is still collected when its pane has nothing new on it.
4. A `hold` decision appears in the thread with its `why`, sends nothing, spends one step, spends
   no `consecutive`, and leaves the session armed for the next trigger.
5. Three consecutive holds pause the session with reason `holding`, visible in the events path.
6. Replaying the shape of 19:19:41–19:21:50 — a duplicate trigger against a member whose partner is
   working — costs one decision and no send.
7. Neither a `hold` nor a `call_human` is presented as an unconfirmed delivery, in the thread rail
   or in the detail sheet. A member send the relay could not prove still is.
