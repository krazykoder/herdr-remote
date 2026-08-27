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

- `_aligns(fresh, i, keys)` gains a fourth parameter, the `said` set of echoed-send keys. Walking
  backwards from `i`, it skips any `fresh[j]` that is a `user` message whose `_key` is in `said`
  before comparing against the next anchor key. A prompt this relay typed is in the record either
  way and is not evidence about where the record ends inside a window, so it must not break a run.
- `_messages_after_record` computes `said = self._sent_after_read(pane)` **before** the alignment
  loop rather than inside it, and passes it to `_aligns`. The post-alignment filter that already
  uses `said` is unchanged.

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
- Consecutive-hold bound: count decisions at the tail of this session whose gate is `hold` and
  which have no send between them. At 3, `self.pause(session_id, "holding")` instead of returning
  to armed. Read off the `decisions` table rather than a new column — the same way the rejection
  bound reads `valid=0` rows at a sequence.
- `starter_prompt`: one paragraph on when to hold. "Choose `hold` when the trigger carried nothing
  the previous turn did not already say, when the member you would write to is already working, or
  when the right next step is to wait for a turn that is still running. A hold is a decision: say
  why. Three holds in a row stop the session."

### B3 — `[MODIFY] web/src/arbitration.js`

Verify only, then fix if needed: a decision with a gate and a `why` and no `to`/`instruction`
already renders — that is what `call_human` is — so `hold` should ride the same path. What needs
checking is that the strip's last-decision line does not read a `hold` as an instruction to a
member, and that the `holding` pause reason has a human string.

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

### `[MODIFY] CLAUDE.md`

`hold` in the gate list where the arbitration lifecycle messages are described; the `holding` pause
reason alongside the others.

## Verification

Only what these changes touch:

```bash
.venv313/bin/python -m unittest discover -s tests -t tests -p 'test_arbitration.py'
.venv313/bin/python -m unittest discover -s tests -t tests -p 'test_conversation_log.py'
.venv313/bin/python tests/e2e/e2e_arbitration.py        # ~40s, the loop end to end
```

The browser suite is untouched — no client change beyond the render check in B3, which
`e2e_arb_ui.js` covers if that check turns into an edit.

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
