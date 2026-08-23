# Arbitrator as dispatcher — work handed in by a person

Status: proposal, not scoped. Extends
`.workflow/01_concepts/ideas/2026-08-17_arbitrator_proposal.md`, which stays the document of
record for the loop itself. Nothing here changes the decision record, the gates, the drop box or
the validator.

## 1. What this is

Today the arbitrator is a **referee**. Every trigger is an event that *arrives* — a member's turn
end, a clock — and carries no payload. It answers exactly one question, over and over: *who acts
next, and what are they told to do?* A person's four verbs are `arb_start`, `arb_edit`,
`arb_pause`, `arb_resume`. None of them carries work.

This proposal makes it a **dispatcher** as well: a person hands in a unit of work, and the
arbitrator decides who does it and how it is phrased.

```
Person writes a task
      │
      ▼
Relay records it and prompts the arbitrator      (a trigger that carries prose)
      │
      ▼
Decision record: gate, target, instruction       (unchanged — same schema, same validator)
      │
      ▼
Relay sends the instruction to that member       (unchanged)
      │
      ▼
Member works, ends its turn                      (unchanged — ordinary trigger)
      │
      └── the existing loop carries the task the rest of the way
```

The new part is the first two boxes. Everything below them already exists and already works.

## 2. Why now

**The scope field is being used as a task queue.** Every `scope` in the live database is a role
description with a task smuggled into it — "you will work with two agents who are working on the
task", "we are building telegram utilities". Scope is a *standing brief*, re-sent whole on every
re-brief; a task is one unit of work. Conflating them makes re-briefing expensive and makes the
brief drift.

**The idle state has no answer.** A session where nothing is pending and nobody is working is
armed and will never fire: arming waits for a turn end, and no turn is going to end. The resume
sheet currently says *"give an agent something to do"* — and then offers no way to do it. That
sentence is a feature request written as an error message.

**The loop already assumes it.** §6.5 of the original proposal lists what the per-trigger prompt
carries, and one of the items is *"any human instruction since the last decision"*. It was
designed in and never wired to a client.

## 3. What already exists

This is the reason the slice is small. None of the following needs building:

| Piece | Where | State |
|---|---|---|
| A free-text block in the trigger prompt, above the turns | `trigger_prompt(..., note=None)`, arbitration.py:526 | Built. One caller: `resume_note`. |
| A way to ask for a decision with no turn behind it | `Arbitration.prompt(session_id, trigger, entries, note=None)`, arbitration.py:1718 | Built. Used by resume. |
| "A person joined in, this is not the loop talking to itself" | `human_entered`, arbitration.py:1549 — zeroes `consecutive`, writes a `human` event | Built. |
| A durable, kinded, per-session event stream the UI already renders | `events` table, `arb_detail`, the resume sheet's table | Built. |
| Prompt storage, so a decision reads against what was seen | `prompts` table | Built. |
| Sending prose to a pane the person picked | the whole existing send path | Built. |

The dispatcher is a new **entry point** into machinery that is finished, not new machinery.

## 4. The change

### 4.1 One new client message

```
arb_task { session, text }
```

Its own verb, deliberately. It must not be a flag on `arb_resume`: a loop-control button that
grows a content channel is how the two get confused, and the pause/resume semantics have nothing
to say about a task. Gated on `HERDR_ENABLE_ARBITER` like the rest of the lifecycle.

Text is capped (the same order as a `state_put` body is capped — a task is a paragraph, not a
document) and stripped of control characters, like `rename_pane` already does.

### 4.2 The relay's half

```python
arbitration.human_entered(session_id)                 # a person joined in; consecutive resets
arbitration.event(session_id, "task", text)           # the record says where the work came from
arbitration.prompt(session_id, "task", entries, note=task_note(text))
```

`entries` is the ordinary digest — the arbitrator still needs to know what the members were last
doing before it assigns on top of it. `task_note` wraps the text in a header the arbitrator's
starter prompt teaches it to recognise:

```
Task from the user:
<text>
```

A paused session accepts a task and resumes on it. That is the case this exists for, so refusing
it would be refusing the feature.

### 4.3 The arbitrator's brief

One paragraph added to the starter prompt: a `Task from the user:` block is work to be assigned,
not a turn to be judged. Pick the member best suited, phrase the instruction, use the ordinary
gates. Everything else about the decision schema is unchanged, which is the point — the
arbitrator learns a new *input*, not a new *output*.

### 4.4 The UI

A text field and one button, in the resume sheet, under the plan line. Present whenever a session
is running or paused. In the state where the sheet currently says *"give an agent something to
do"*, this **is** the thing to do, and the copy becomes the control.

The `events` row renders in the sheet's table with its own badge, so a decision that came from a
person is visually distinct from one that came from a turn end — which is exactly the question
somebody scrolling that table is asking.

### 4.5 Budget

A task produces a send, and a send is a step. No special case, no free lane.

`human_entered` already zeroes `consecutive`, which is correct and sufficient: the consecutive
budget asks *"is this loop talking to itself?"*, and a person handing in work is the answer no.

`steps_used` is **not** reset, and that is a problem this feature will make loud. It is never
reset today — resume clears `window_at` and `consecutive` but not the step count, which is why
`arbResumeNow` has to compute `spent + N` and raise the ceiling to give a session more room. A
dispatcher session is long-lived by nature and will grind into that ceiling constantly. Settle it
before building: either a task raises the ceiling the way resume does, or `steps_used` becomes a
per-window count rather than a per-session one. The second is the honest shape and the larger
change.

## 5. What does not change

Naming these is most of the value of the proposal.

- **One member per decision.** The arbitrator names one target and one instruction, exactly as
  today. A task that needs both members is carried by the loop — assign A, A works, turn end,
  ordinary trigger, assign B. Letting one decision name two targets doubles the send path, breaks
  `consecutive` accounting and needs new validation, for a case the loop already covers.
- **The decision record schema.** §4 of the original proposal: new behaviour arrives as new gate
  data or a new prompt, never as new fields the executor has to branch on. A task is a new prompt.
- **The gates, the drop box, the validator, the re-prompt, the pane resolution.** Untouched.
- **The task text never reaches a member directly.** Only the arbitrator's prompt. Sending it to
  members as well would be a broadcast with an arbitrator-shaped decoration, and there is already
  a way to type at a pane.
- **Two members, one session, local host.** The v1 boundaries hold.

## 6. Decisions

| Question | Decision | Why |
|---|---|---|
| New verb or a flag on `arb_resume`? | New verb, `arb_task`. | Loop control and content are different things; the moment they share a button, one of them gets used by accident. |
| Does a task consume a step? | Yes. | It produces a send. A free lane is an accounting lie and the budget is the only thing bounding this. |
| Task to a paused session? | Accepted; resumes on it. | The idle/paused session is the case the feature exists for. |
| Queue or preempt when a member is mid-turn? | Queue — deliver at the next decision point. | Preempting means interrupting a working pane, which is a different feature with its own failures. |
| Does the arbitrator see the digest as well as the task? | Yes. | It is assigning on top of work in progress; a task read in isolation gets assigned to the member who just finished doing it. |
| Free-form note with no decision expected? | Out of scope. | That is context injection — a different verb (`arb_note`), no prompt, no step. Do not build it in the same slice; the one that assigns is the one that is wanted. |

## 7. Open questions

- **Does a task raise the step ceiling?** See §4.5. Blocks nothing until the first long session.
- **Should a task be able to name a preferred member?** A hint, not a target — the arbitrator
  still decides. Cheap to add later as a line in the note; leaving it out first is how we find
  out whether anyone wants it.
- **What happens to a task that arrives while the arbitrator is `awaiting`?** The question is
  already out and the sequence is taken. Simplest: hold it and attach it to the next prompt,
  which is what "any human instruction *since the last decision*" already implies. Needs one
  place to hold it.
- **Telegram.** The ops and agent bots are the natural second client for this — handing a task in
  from a phone is the whole use case. Not v1, but the wire message should not assume a browser.

## 8. Slices

1. `arb_task` end to end: wire message, `human_entered` + `task` event + `prompt(..., note=)`,
   starter-prompt paragraph. No UI — driven from a test client.
2. The sheet's field and button, and the `task` badge in the events table. The copy in the
   nobody-working state becomes the control.
3. Step-ceiling behaviour, once §4.5 is settled.
4. Telegram, if wanted.

## 9. What would make this fail

- **The arbitrator treats a task as a turn to judge.** It replies "member-1 said nothing new" and
  burns a step. Guarded by the starter-prompt paragraph, and visible immediately in `arb_detail`
  because the prompt is stored beside the decision.
- **People put tasks in `scope` anyway**, because a re-brief is one dialog they already know. The
  fix is that `arb_task` has to be *closer to hand* than editing the scope — which is the argument
  for it living on the resume sheet rather than behind the edit dialog.
- **The step ceiling makes it useless.** A dispatcher that stops after eight assignments is a
  demo. §4.5 is the real dependency, not the wire message.
