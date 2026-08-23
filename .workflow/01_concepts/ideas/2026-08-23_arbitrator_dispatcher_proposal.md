# Arbitrator as dispatcher and commander — work handed in, and a plan run to the end

Status: **parked, 2026-08-23.** Nothing here is scoped or being built. The dispatcher (§1–§5) is
the half that is ready to build when it is picked up; the commander (§6–§10) is designed but its
shape is decided and not started — see §9, which records a decision that reverses this document's
own earlier recommendation.

Extends
`.workflow/01_concepts/ideas/2026-08-17_arbitrator_proposal.md`, which stays the document of
record for the loop itself. Nothing here changes the decision record, the gates, the drop box or
the validator.

Two features, one document, because they need the same three things: a way for a person to hand
work in, a step budget that survives a long session, and a session that can end itself.

- **Dispatcher** (§1–§5): a person hands in a unit of work and the arbitrator assigns it.
- **Commander** (§6–§10): a plan owned end to end, and a document it maintains so a person can see
  the map and point at a step on it.

**The commander is its own entity, and it contains an arbitration session rather than replacing
one.** §9 records that decision and the analysis it overruled. Everything §6–§8 and §10 describe —
the gate set, the agenda, the brief, the four holes — holds either way; only who owns the session
moves.

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
| A private directory per session, mode 0700 | `arbitration/<session_id>/`, arbitration.py:989; its path is inside every trigger message | Built. |
| Prompt storage, so a decision reads against what was seen | `prompts` table | Built. |
| An agent reading the record from its own shell | `relay/conv_query.py`, named in the starter prompt | Built. |
| Sending prose to a pane the person picked | the whole existing send path | Built. |

The dispatcher is a new **entry point** into machinery that is finished, not new machinery.

## 4. The change

### 4.1 One new client message

```
arb_task { session, text, step }
```

Its own verb, deliberately. It must not be a flag on `arb_resume`: a loop-control button that
grows a content channel is how the two get confused, and the pause/resume semantics have nothing
to say about a task. Gated on `HERDR_ENABLE_ARBITER` like the rest of the lifecycle.

| Field | Required | Rule | Why |
|---|---|---|---|
| `session` | yes | An open session id, or `no_session`. | Several sessions run at once, one per conversation. |
| `text` | yes | Capped at the order of a `state_put` body; control characters stripped as `rename_pane` does; empty is a refusal. | A task is a paragraph, not a document. Text typed into a terminal is a trust boundary. |
| `step` | no | Opaque string, short, capped, never resolved. Copied into the note verbatim. | The commander's own step id (§7). The relay does not know a step exists, and must not start. |

`step` exists for the commander: a person taps a row on the map and that row's id rides along.
The commander knows what `s4` is because it wrote it.

**Refusals** reuse the existing codes — `no_session` for a session that is not open, `not_running`
for one that has ended. A paused session is not a refusal; see below.

### 4.2 The relay's half

```python
arbitration.human_entered(session_id)                 # a person joined in; consecutive resets
arbitration.event(session_id, "task", text)           # the record says where the work came from
arbitration.prompt(session_id, "task", entries, note=task_note(text, step))
```

`entries` is the ordinary digest — the arbitrator still needs to know what the members were last
doing before it assigns on top of it. `task_note` wraps the text in a header the arbitrator's
starter prompt teaches it to recognise:

```
Task from the user:
<text>
```

and, when a step rode along:

```
Task from the user (about step s4):
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
change, and §8 needs it outright.

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
- **One session, local host.** The v1 boundaries hold. The two-member limit is the one §8 asks to
  revisit, and it asks last.

# The commander

## 6. What a commander is

A commander is an arbitrator with a different brief and a different gate set, running a plan it
owns from first step to last: it gets or writes the plan, decides who does each step, watches what
comes back, records what is done and what is next, asks a person when it should, and ends the
session when the work is finished.

**It is its own entity, and it contains an arbitration session rather than being a setting on
one.** It drives the arbitration API — `start`, `edit`, `pause`, `resume`, `end` — and never
validates a record, resolves a pane, or types at a terminal. §9 records that decision, why the
level is different, and the line the commander still may not cross.

The relay's part does not grow. It still reads exactly one JSON schema — the decision record —
and still types exactly what a validated record tells it to. The plan is not the relay's; it is a
document the commander writes, in the commander's own directory, which the relay serves to the
front end without reading a field of it.

### 6.1 What a commander is made of

Four things, and not one of them is an engine:

| Piece | What it is | Where it goes |
|---|---|---|
| A gate set | `DEFAULT_GATES` (arbitration.py:68) is already a list of `{name, template}` shipped as data. A commander is a different list. | `gates_json` on the session, chosen by `mode` at `arb_start`. §6.2 |
| A brief | One block appended to the existing starter prompt. Teaches the agenda, the ids, and the `done` gate. | §10 |
| A document it owns | `agenda.json` in the directory the session already has. The relay carries it and parses none of it. | §7 |
| Two holes filled | A `done` gate so it can finish, and a step budget that survives a long session. | §8 |

Everything else — the trigger, the record schema, the validator, the send path, the pause, the
resume, the roster resolution, the events log, the sheet, the bubbles — is what it already is.

### 6.2 The gate set

Gates are `{name, template}` where `{instruction}` is the only substitution and the agent supplies
prose, never a template. That is the existing contract; a commander ships a different file.

| Gate | Template | What it is for |
|---|---|---|
| `plan` | `Write or revise the plan for this work.\n\n{instruction}` | Getting the step list out of an architect rather than inventing it alone. |
| `implement` | `{instruction}` | The default. Same as CRFN's. |
| `review` | `Please review the work described above.\n\n{instruction}` | Same as CRFN's. |
| `land` | `{instruction}` | Commit, push, open the PR — whatever the person's scope says landing means. Prose only: the relay supplies no argv, no cwd, no write scope. |
| `done` | — | Ends the session. No `to`, no `instruction`; `why` is what the person reads. §8. |
| `call_human` | — | Unchanged. Pauses and asks. |

`land` is deliberately an ordinary prose gate. A gate that ran a command would put the relay back
in the business of executing, which §9 is the argument against.

### 6.3 The prior art this reopens, and what stays shut

`worktree-docs+agent-lifecycle-orchestrator-proposal` carries a full lifecycle engine —
`relay/orchestrator.py`, run state, phase templates, drift detection, required-check runners. §2
of the original proposal froze it because *"the orchestrator's unit is a run through phases of a
feature; the arbitrator's unit is a conversation"*.

The commander is that ambition **without that engine**. The difference is one line: the
orchestrator made the relay own the plan, so the relay had to advance a cursor, judge a step
complete, and reconcile a plan that changed under it. Here the plan is a document owned by an
agent, and the relay's only job is to carry it. Nothing has to be resolved, so nothing has to be
reconciled.

## 7. The agenda

Named `agenda` because `plan` is already taken on the wire — `session.plan` is `resume_plan`'s
`{action, sequence, stale}` (herdr_relay.py:1842, read by `arbLeads`) — and `steps` would collide
with the budget's `steps_left` / `max_steps` / `steps_used`, which count decisions, not work.

### 7.1 Where it lives

`arbitration/<session_id>/agenda.json`, beside `0007-decision.json`. That directory already
exists per session at mode 0700, and every trigger message already names the drop path inside it,
so the commander finds its own file from the trigger message alone — across a compaction, a pane
restart, a relay restart, for ever. No new storage, no new configuration, no path to agree on.

This is also the answer to continuity. A commander lives for days; its context does not. The
brief is sent once. What survives is the directory, and the trigger message is what points at it
every single time.

### 7.2 How the relay notices it changed

The drop box is already read at the commander's turn end (§12.1 step 4). The same moment, `stat`
the agenda. Changed size or mtime → read it, check it, bump `agenda_rev`, broadcast.

One extra syscall per arbitrator turn. No watcher, no poll, and the right cadence for free: the
agenda changes when the commander decides something, which is minutes apart.

### 7.3 What the relay checks — shape, never meaning

Two checks, both at a trust boundary, neither semantic:

- **A size cap.** The same order as a `state_put` body, probably tighter.
- **That it parses.** `json.loads` to prove it is well-formed, then serve the **raw text** — never
  re-serialised, so the commander's own formatting survives and the relay is not quietly
  co-authoring the document.

Either check fails → do not serve it, keep serving the last good revision, and write an `error`
event. The commander reads its own mistake out of the events table and fixes it on the next turn,
exactly as it does with a rejected decision record.

Nothing is checked about `status`, `id`, ordering, or whether step 4 may follow step 2. **The
relay never knows a step exists.**

### 7.4 The wire

- `arb_session` gains `agenda_rev`, an integer. That message broadcasts on every state change —
  every trigger, every member status flip — so the body must not ride on it. This is not a
  hypothetical: the thread's `arb_detail` ask carried prose it never drew and cost 3.2 MB in a
  busy five minutes before `brief` was added.
- `arb_agenda { session, rev, body }`, broadcast **only when the file changed**, and answered on
  request so a client joining mid-session catches up.

One new message type and one new integer, in the same shape as `event_at` + `arb_detail`.

### 7.5 The format

The relay cannot enforce it, so it lives where the decision record's schema already lives: the
brief. The front end draws what it recognises and ignores what it does not, which is what lets
the shape move without a relay release.

```json
{
  "title": "Thread controls",
  "branch": "feat/thread-controls",
  "steps": [
    {"id": "s3", "title": "Digest leak fix", "status": "done",
     "to": "member-2", "why": "…", "commit": "1561468"},
    {"id": "s4", "title": "arb_task wire", "status": "doing", "to": "member-1"},
    {"id": "s5", "title": "done gate", "status": "todo"}
  ]
}
```

**Flat. No sub-steps, no dependency graph.** A tree needs a resolver and a resolver is the relay
owning the plan again, which is the exact door §6.1 closed.

| Field | Type | Required | Drawn as |
|---|---|---|---|
| `title` | string | yes | The map's heading. |
| `branch` | string | no | A chip beside the heading. Cross-checks against the `branch` the relay already carries per turn from `git_probe`. |
| `steps[].id` | string | yes | Not drawn. The handle `arb_task`'s `step` names. Never reused, never renumbered. |
| `steps[].title` | string | yes | The row. |
| `steps[].status` | `todo` \| `doing` \| `done` \| `blocked` | yes | The badge. Anything unrecognised draws as `todo` rather than breaking the row. |
| `steps[].to` | member id | no | The member chip. Resolved to a label by the front end against the roster it already holds. |
| `steps[].why` | string | no | The row's second line. One line — see §14. |
| `steps[].commit` | sha | no | A commit chip, linking to the range the record can already answer with `git_commits`. |

`commit` is worth carrying because `git_probe` already records branch and commit at every turn
end, so the front end can put a step next to what actually landed with nobody correlating
anything.

### 7.6 What this costs the relay

| Piece | Rough size |
|---|---|
| `stat`, read, cap, `json.loads`, bump `agenda_rev` at the arbitrator's turn end | ~20 lines |
| `agenda_rev` on `arb_session` | 1 line |
| `arb_agenda` broadcast, and answering a request for it | ~15 lines |
| `step` passthrough into `task_note` | 2 lines |
| The commander's gate set and brief | data and prose |
| **The map, and the per-step task button** | **the actual work, and all of it in the front end** |

The relay's whole share is under 40 lines, and after it the relay still parses exactly one schema:
the decision record.

### 7.7 The UI

The map: one row per step, status as a badge, the member it is assigned to, and the commit if it
has one. On each row, one button — the `arb_task` field with that row's `id` already attached.
That is the whole of "point at a step and say something about it", and it is the same verb §4.1
already needs.

## 8. What a commander needs that an arbitrator does not

Four holes. None of them is the loop.

| Hole | Where | Size | Blocks the commander? |
|---|---|---|---|
| A `done` gate | `end()` arbitration.py:1530; `_execute` already branches to `pause` for `call_human` at :1905 | One branch beside it | Yes |
| Per-window step budget | `DEFAULT_BUDGET` / `BUDGET_MAX` arbitration.py:81–82; `steps_used` never reset | Real — a schema decision, see §4.5 | Yes, outright |
| The human channel | `arb_task`, §4 | The dispatcher slice | Yes |
| More than two members | `MEMBERS_REQUIRED = 2` arbitration.py:103, enforced :951 and :1077 | Constant is trivial; the digest is not | No — do it last, or never |

**A `done` gate.** A session ends today on budget, on `call_human`, or on a person pressing End.
A commander that finishes its plan has no way to say so. `done` takes no `to` and no
`instruction`, exactly as `call_human` does, and its `why` is what the person reads in the thread.

**A step budget that is per-window, not per-session.** `DEFAULT_BUDGET` is 8 steps and 45
minutes; `BUDGET_MAX` caps at 50 steps and 8 hours. Those are the numbers for a conversation. A
branch lifecycle is days, and `steps_used` never resets, so today the cap is not a safety rail —
it is the feature's hard ceiling. §4.5 names this; the commander cannot ship without it.

The two candidate shapes, since this is the one real schema decision in the document:

| Shape | What it means | Cost |
|---|---|---|
| A task or a resume raises the ceiling | `max_steps` becomes `spent + N`, which is what `arbResumeNow` already computes in the client | Small, and already half-built — but the ceiling ratchets upward for ever and stops meaning anything |
| `steps_used` counts within a window | Reset alongside `window_at` and `consecutive`, which `resume` already clears | Honest. Changes what `budget_spent` measures, and every existing session's numbers |

The second is right. The first is what will get built if nobody decides.

**More than two members** — *last, and maybe never*. `_write_members` is already positional
(`member-{i}`), so the table and the prompts take N unchanged. The real cost is elsewhere:
`ARB_DIGEST` is six rows across the *whole* roster, so at four members one chatty agent starves
the rest, and the digest has to become per-member. Run a real branch with two members and a
commander first. If two is enough, that problem never has to be solved.

### 8.5 The wire, in one place

Everything this document adds or changes. Nothing else on the wire moves.

**Client → Server**

| Message | New? | Shape | Gate |
|---|---|---|---|
| `arb_task` | new | `{session, text, step?}` — §4.1 | `HERDR_ENABLE_ARBITER` |
| `arb_agenda` | new | `{session}` — a request, for a client that joined mid-session | `HERDR_ENABLE_ARBITER` |
| `cmd_start` etc. | new, deferred | The commander's own lifecycle verbs. Not designed here — §9 decided the shape, not the surface. | `HERDR_ENABLE_ARBITER` plus its own |
| `arb_start` | unchanged | The commander calls it; it does not learn a `mode`. | unchanged |
| `arb_edit` | unchanged | — | — |

**Server → Client**

| Message | New? | Shape | Broadcast? |
|---|---|---|---|
| `arb_agenda` | new | `{session, rev, body}` — `body` is the raw text, never re-serialised | Only when the file changed. Also answered to a client that asks. |
| `arb_session` | changed | gains `agenda_rev` (integer) and `mode` | As today, on every state change — which is exactly why the body is not on it |
| `arb_detail` | unchanged | — | — |

**The events table** gains kinds `task` (a person handed work in) and `agenda` (a revision was
accepted or refused). Both render in the resume sheet's table with the badge machinery that is
already there.

## 9. A separate entity that contains an arbitrator

**Decided 2026-08-23: the commander is its own object, and it encompasses the arbitrator rather
than being a setting on one.** This reverses the recommendation this section originally carried;
the analysis behind that recommendation is kept below, because it is still the argument that
bounds what the commander may do.

### 9.1 The decision, and the reason for it

The commander operates at a **higher level** than the arbitrator. An arbitrator answers one
question about one conversation: who acts next. A commander owns a piece of work — its plan, its
branch, its relationship with the person, its notion of done. Those are not the same job at
different settings; they are two jobs, and the second one uses the first.

The load-bearing reason is **cross-cutting, and it is about what comes next rather than what is
in this document**. Everything a commander will grow — a plan document, a notion of a step,
landing work, reporting to a person, deciding the whole thing is finished, and whatever of the
orchestrator's job it eventually takes on (§9.5) — cuts across the arbitrator's role rather than
extending it. Expressed as a mode, each of those arrives as another `if mode == "commander"` in a
class whose entire value is that it does one narrow thing correctly. The arbitrator is the
component that types text into somebody's terminal; it is the one place in this system that must
stay small enough to hold in your head.

The features in §6–§8 would each fit as a mode. It is the ones after them that would not, and by
the time that is obvious the mode branches are load-bearing and expensive to unpick. The layer is
being drawn now because it is cheap now.

So the commander is a layer **above**:

```
Commander                    owns the plan, the branch, the person, "done"
    │  starts, edits, pauses, resumes, ends
    ▼
Arbitration session          owns one conversation: who acts next
    │  validated decision record
    ▼
Relay executor               types it at a pane
```

**It contains an arbitration session; it does not reimplement one.** That distinction is the whole
of why this is not the frozen orchestrator. The commander never validates a record, never resolves
a pane, never types at a terminal, never owns a budget window. It drives the arbitration API —
`start`, `edit`, `pause`, `resume`, `end` — and everything below that line stays exactly as it is,
one implementation, one validator, one executor.

### 9.2 What this buys

- **The arbitrator stops growing.** No mode flag, no branch in `_execute`, no second meaning for
  `sequence`. It keeps being the small correct thing.
- **The commander can hold state the arbitrator must not.** A plan, a branch, a relationship with
  a person, a definition of done — none of which belong in an object whose scope is one
  conversation.
- **A commander can outlive a session.** Re-brief, swap the roster, end a session and start
  another over the same work — all of that is ordinary use of an API that already exists, and
  impossible for a session to do to itself.
- **The three falsifiers in §9.4 stop being falsifiers** and become ordinary future work, because
  the layer that would host them now exists.
- **Part of the frozen orchestrator gets a home.** §9.5. That branch was held off because its unit
  of work — a run through phases — had nowhere to live that was not a second engine. A commander
  is exactly that place, minus the engine.

### 9.3 What this costs, and what must not be paid

The costs are real and were the reason for the original recommendation. Recorded so they are
designed against rather than discovered:

| Cost | Guard |
|---|---|
| A second lifecycle: a commander can be running, paused, ended — on top of a session that can also be running, paused, ended | One direction only. The commander's state is derived from its session's wherever it can be, and the UI shows one strip, not two. |
| Two places for a stuck thing to be stuck | The commander's own events go in the same `events` table, on the session it is driving. One table, one sheet, one story. |
| Two UIs | There is one. The map (§7.7) is a panel on the existing sheet, not a second surface. |
| Two sets of pause reasons | The commander does not invent any. It reads the session's, and adds only reasons that are about the *plan* — never about a pane. |
| Two implementations of the dangerous part | **Never.** The commander does not send, does not validate, does not resolve a pane. If a line of commander code ever types at a terminal, this decision was implemented wrongly. |

### 9.4 The line the commander still may not cross

These were written as "build a separate kind if these come true". They came true by decision
rather than by evidence, so they are no longer falsifiers — but the third is still a hard boundary
and the second is still a different security object:

- **Something other than the commander judging a step complete.** Now allowed, because the
  commander is the thing that may hold a cursor. It still should not: a plan the *agent* owns
  needs no reconciliation, and a plan the commander owns does. Prefer the document.
- **A step that runs without a pane** — a required check, a test runner, a commit gate. §4 of the
  original proposal stands: *prompt text is data; argv, cwd and write scopes are not*. A commander
  that runs `make test` is a different security object and needs its own review, not an extension
  of this one.
- **Two sessions coordinating.** Sessions are independent by construction — one pane in at most
  one session, roster resolved per session. A commander driving two sessions at once is the first
  thing that will be asked for and the first thing that will break the pane-exclusivity rule.
  Out until that rule is re-argued from scratch.

### 9.5 What the layer opens up — including part of the orchestrator's job

Not scoped, not promised, and deliberately listed so the layer is drawn wide enough to hold them.
`worktree-docs+agent-lifecycle-orchestrator-proposal` was frozen because its unit of work had no
home; a commander is that home. What could land here later, in rough order of how safe it is:

| Idea from the frozen branch | Fits the commander? | Note |
|---|---|---|
| A run through phases of a feature | Yes — this is what the agenda already is | Phases are steps with a convention, not a new object |
| Creator / reviewer slots | Yes | Roles already exist per member; a commander can assign against them |
| Working-tree drift detection | Yes, read-only | `git_probe` already runs read-only git at turn end and records branch and commit. Drift is a comparison, not an execution |
| Owning a worktree or a branch for the run | Probably | Read-only to begin with: know which branch, do not create one |
| Required-check running (`make test`, a linter, CI) | **Only behind its own review** | This is the line. §4 of the original proposal: *prompt text is data; argv, cwd and write scopes are not.* A commander that runs a command is a different security object |
| Commits and pushes | **Only behind its own review** | Same line. Today `land` is a prose gate: the commander tells an agent to commit, and the agent does it in its own pane under its own permissions |
| Run gates and phase templates | Yes, as data | `DEFAULT_GATES` is already a data-shipped list; templates are the same idea one level up |

The pattern: **anything that reads, yes. Anything that executes, a separate decision.** The
commander layer existing does not move that line — it just gives the things on the safe side of it
somewhere to live.

### 9.6 The analysis this overruled

Kept intact, because it is the description of how little the *loop* differs — which is exactly why
the commander must sit above it rather than inside it:

**What is actually different about a commander** is what it is *shown* and what it is *asked
for* — not what the relay does with the answer:

| | Arbitrator | Commander |
|---|---|---|
| What wakes it | a turn end, a clock, a person | same |
| What it is shown | scope, roster, digest | same, plus its own file which it reads itself |
| What it is asked | who acts next | who acts next, *and keep the plan current* |
| What it writes | one decision record | same schema, same path, same validator |
| How it ends | budget, `call_human`, a person | plus `done` |
| How long it lives | a conversation | a branch |
| What the relay does | validate, apply the gate template, type it | identical |

Everything below that line is shared: the trigger, the record schema, the validator, the send
path, the pause, the resume, the budget, the pane resolution, the events log, the sheet and the
bubbles are all untouched, and none of them cares what the decision was about.

That is the extensibility line the original proposal drew, and it holds literally: *"new
behaviour arrives as new gate data or a new arbitrator prompt, never as new fields the executor
has to branch on."* `DEFAULT_GATES` (arbitration.py:68) is already a list of `{name, template}`
that ships as data.

The reading that lost: because the loop is identical, make the commander a mode. The reading that
won: because the loop is identical, the commander has no business being *inside* it — it should
drive it from outside, where the things that are genuinely different can live without touching
the part that types.

## 10. The commander's brief

The instruction itself. Written in the register the existing starter prompt uses, because it is
appended to the same message and the arbitrator must not be able to tell which paragraph came
from where. `{agenda_path}` is `os.path.dirname(drop_path) + "/agenda.json"`.

> You are running this work from beginning to end. Alongside deciding who acts next, you keep the
> plan: what the whole job is, which steps it breaks into, who each one belongs to, and which are
> done.
>
> Your plan lives at:
>
>     {agenda_path}
>
> It is yours. Nothing else writes it. Write it when the session starts and rewrite it whenever
> anything about it changes — a step finished, a step turned out to be two steps, the person
> asked for something new. Re-read it at the start of every turn before you decide: it is what
> you know, and this message is only what just happened.
>
> Write it as one JSON object:
>
>     title    a short name for the whole job
>     branch   the git branch the work is on, if there is one
>     steps    a list, in the order they should happen, each one:
>                id       a short string you choose and never reuse or renumber
>                title    one line, what this step is
>                status   todo | doing | done | blocked
>                to       the member id doing it, if one is assigned
>                why      one line, for the person reading it — optional
>                commit   the commit this step landed in, if you know it — optional
>
> Steps are a flat list. Do not nest them; if a step turns out to contain several, replace it with
> several steps. Never renumber or reuse an id — a person may be pointing at one.
>
> This file is shown to the person as a map of the work. They may send you a message about one
> step, and it will arrive as `Task from the user (about step s4):`. The id is one of yours.
>
> Nothing else in the file is read by anybody but you and the person. It is not checked, beyond
> being valid JSON of a sane size; if it is not, you will see an error in your next trigger
> message and nothing will be shown until you fix it.
>
> When every step is done, decide with gate `done`. That ends the session. When you are unsure
> what the person wants, or the plan no longer matches what they asked for, use `call_human`.

## 11. Decisions

| Question | Decision | Why |
|---|---|---|
| New verb or a flag on `arb_resume`? | New verb, `arb_task`. | Loop control and content are different things; the moment they share a button, one of them gets used by accident. |
| Does a task consume a step? | Yes. | It produces a send. A free lane is an accounting lie and the budget is the only thing bounding this. |
| Task to a paused session? | Accepted; resumes on it. | The idle/paused session is the case the feature exists for. |
| Queue or preempt when a member is mid-turn? | Queue — deliver at the next decision point. | Preempting means interrupting a working pane, which is a different feature with its own failures. |
| Does the arbitrator see the digest as well as the task? | Yes. | It is assigning on top of work in progress; a task read in isolation gets assigned to the member who just finished doing it. |
| Free-form note with no decision expected? | Out of scope. | That is context injection — a different verb (`arb_note`), no prompt, no step. |
| Commander: separate kind or a setting? | **A separate entity that contains an arbitration session.** Reversed 2026-08-23; the document originally recommended a setting. | The level is different: an arbitrator answers one question about one conversation, a commander owns a piece of work. Everything a commander grows — a plan, a step, landing, a notion of done — cuts across the arbitrator rather than extending it, and the arbitrator is the one component that must stay small. §9. |
| Does the commander reimplement the loop? | No. It drives `start` / `edit` / `pause` / `resume` / `end` and nothing below them. | One validator, one executor, one thing that types at a terminal. That is what separates this from the frozen orchestrator branch. §9.3. |
| Who owns the agenda? | The commander. The relay stores nothing about it and parses none of it. | A plan the relay owns needs a cursor, and a cursor needs an engine. |
| Where does the agenda live? | `arbitration/<session_id>/agenda.json`. | The directory already exists and its path is already in every trigger message, which is also how a commander survives losing its context. |
| Does the relay validate the agenda? | Size and `json.loads`, nothing else. Bad → keep the last good revision and write an `error` event. | A trust boundary is never simplified away; meaning is not the relay's to check. |
| Does the agenda ride on `arb_session`? | No. `agenda_rev` does; the body is its own broadcast, only when it changed. | `arb_session` fires on every status flip. This is the mistake `brief` was added to fix. |
| Nested steps? | Flat list only. | A tree needs a resolver; a resolver is the relay owning the plan. |

## 12. Open questions

- **Does a task raise the step ceiling?** See §4.5 and §8. Blocks nothing for the dispatcher;
  blocks the commander outright.
- **Should a task be able to name a preferred member?** A hint, not a target — the arbitrator
  still decides. Cheap to add later as a line in the note.
- **What happens to a task that arrives while the arbitrator is `awaiting`?** The question is
  already out and the sequence is taken. Simplest: hold it and attach it to the next prompt,
  which is what "any human instruction *since the last decision*" already implies. Needs one
  place to hold it.
- **Does a commander need to fan out?** "Architect plans while implementer preps" is two
  decisions, and the second needs a trigger that will not arrive if everyone is idle. The answer
  is not a decision that names two members — it is that `arb_task`'s kick already prompts with no
  trigger, so the commander sends to A, is kicked, sends to B. Confirm this on a real session
  before anyone proposes fan-out.
- **Telegram.** Handing a task in from a phone is the whole use case. Not v1, but the wire message
  should not assume a browser.

## 13. Slices

In order. Each one is usable on its own, which is the test of whether the split is honest.

| # | Slice | Touches | Done when |
|---|---|---|---|
| 1 | `arb_task` end to end | `herdr_relay.py` handler, `task_note`, one brief paragraph | A task typed at a test client makes the arbitrator assign work, and the `prompts` row shows it was shown |
| 2 | The task UI | `arbitration.js`, the resume sheet, a `task` badge | The nobody-working state offers the control instead of describing it |
| 3 | Per-window step budget | `budget_spent`, `resume`, `DEFAULT_BUDGET` | A session runs past 50 decisions without a person raising a ceiling |
| 4 | The `done` gate | `_execute`, the gate list | A session ends itself and says why, and the strip says so |
| 5 | The commander object | A new module driving the arbitration API; `gates_json`, the brief (§10) | One real branch, two members, no agenda — the commander keeps the plan in its own notes |
| 6 | The agenda | `stat` at turn end, validate, `agenda_rev`, `arb_agenda` | The relay serves a document it has never parsed, and refuses a malformed one without losing the last good copy |
| 7 | The map, and `step` | front end only, plus 2 lines of passthrough | A person taps a step and the commander answers about that step |
| 8 | More than two members | `MEMBERS_REQUIRED`, and the digest first | Only if 5–7 prove two is not enough |
| 9 | Telegram | `herdr_telegram.py` | Handing a task in from a phone |

**Slice 5 before slice 6 on purpose.** A commander with no agenda still runs a branch; it just
cannot show anybody the map. Building the document first would mean designing a format for a loop
nobody has watched run.

## 14. What would make this fail

- **The arbitrator treats a task as a turn to judge.** It replies "member-1 said nothing new" and
  burns a step. Guarded by the starter-prompt paragraph, and visible immediately in `arb_detail`
  because the prompt is stored beside the decision.
- **People put tasks in `scope` anyway**, because a re-brief is one dialog they already know. The
  fix is that `arb_task` has to be *closer to hand* than editing the scope — which is the argument
  for it living on the resume sheet rather than behind the edit dialog.
- **The step ceiling makes it useless.** A dispatcher that stops after eight assignments is a
  demo; a commander that stops after fifty never finishes a branch. §4.5 is the real dependency,
  not the wire message.
- **The commander stops rewriting the agenda.** It decides, the work moves, and the map silently
  goes stale — which is worse than no map, because a person is now steering by it. Watch for it
  in the first real session: an `agenda_rev` that has not moved in several decisions is the
  symptom, and it is cheap to show in the UI.
- **The agenda becomes the prompt.** A commander that writes its whole reasoning into the file
  turns a map into a transcript, and the front end into a second, worse thread. The size cap is
  the blunt guard; the brief saying "one line" per step is the real one.
