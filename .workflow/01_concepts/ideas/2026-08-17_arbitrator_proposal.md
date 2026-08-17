# Arbitrator — automated chat arbitration

Status: proposal, for discussion. Branch `feat/arbitrator`, off `main` at `1dd25e3`.

## 1. What this is

The conversation harness already lets a person run several agents as one chat: pick a message out of
a pane, address another member, send it with an `@instruction`. What the person supplies at every
step is one decision — *who acts next, and what are they told to do*.

The **arbitrator** is that decision, made by an agent instead of by the person, inside a scope the
person set. Everything else about the conversation stays exactly as it is.

```
Member finishes a turn
      │
      ▼
Relay captures the closing message            (backend recording)
      │
      ▼
Arbitrator pane is asked: what next?          (judgement, by an agent)
      │
      ▼
Decision record: gate, target, instruction    (validated, not parsed from prose)
      │
      ▼
Relay sends the instruction to that member    (execution, budgeted)
      │
      └── repeat until the scope's budget or a `call_human` gate ends it
```

## 2. Relationship to the orchestrator work

There is a frozen branch, `worktree-docs+agent-lifecycle-orchestrator-proposal`, carrying a full
lifecycle orchestrator: `relay/orchestrator.py`, `orchestrator_controller.py`, `orchestrator_io.py`,
SQLite run state, phase templates, drift detection, required-check runners. It was held off because
it is a much larger commitment than the problem in front of us.

**We are not porting it.** The arbitrator is a different object with a different centre of gravity:
the orchestrator's unit is a *run through phases of a feature*; the arbitrator's unit is a
*conversation*. Runs are a thing you configure and start; conversations already exist in the product
and people already use them.

Four ideas from that branch are worth keeping, and they are the only ones this proposal takes:

| Idea | Why it survives |
|---|---|
| **No lifecycle decision is ever inferred from terminal prose** | A closing message can be *located* mechanically; whether it means "accepted" cannot. The arbitrator states its decision as fields, not as sentences we regex. |
| **A record protocol has to earn its trust with a validator** | The decision record is schema-checked, path-fixed, size-capped. One bounded re-prompt on a malformed record, then it stops for a human. |
| **The agent's `done` is a wake-up, not a result** | `done` means "go read the thing you were already expecting", never "the step passed". |
| **Prompt text is data; argv, cwd and write scopes are not** | The arbitrator may compose the *words* a member receives. It may never supply a command, a path, or a process to start. |

Everything else — phases, templates, drift, check runners, creator/reviewer slots, run gates — stays
on that branch. If a lifecycle engine is ever wanted, it can sit *above* the arbitrator later; the
arbitrator does not need it to be useful.

## 3. Scope

**In scope**

- Chat arbitration: one conversation, its enrolled members, one arbitrator.
- Feature-level CRFN automation: create, review, fix, next-step.
- Four gates: `implement`, `review`, `phase_plan`, `call_human`.
- Four measured signals fed to the arbitrator: ambiguity, decision complexity, idle, long runtime.
- Backend recording of turn-end summaries and user input, so arbitration does not need a browser tab
  open.

**Out of scope (v1)**

- Starting or killing panes from a decision. The arbitrator addresses members that already exist.
- Worktrees, commits, pushes, required-check running, working-tree drift.
- More than one arbitrated conversation at a time, or arbitration across projects/hosts.
- Remote hosts: v1 is local-host only, because the decision record is a file on the relay's machine.
- Anything reading a full transcript for a decision. Summaries and enrolled entries only.

## 4. The extensibility line

The thing that must stay general is the **loop**, not the workflow. So:

- **Gates are data.** A gate is a name plus the instruction template used when the arbitrator picks
  it. CRFN's four are the first set; a different use case ships a different set with no code change.
- **The decision record schema is fixed and small.** New behaviour arrives as new gate data or a new
  arbitrator prompt, never as new fields the executor has to branch on.
- **The unit is a conversation, not a feature run.** A conversation is already a roster of panes with
  a shared thread. Anything you can express as "these members take turns and someone decides who is
  next" is expressible here — code review, doc drafting, triage — without a second engine.
- **The arbitrator is a pane like any other.** No special agent kind, no privileged transport. Which
  means it can be swapped, read, corrected mid-run, and paused by the same controls as everyone else.

## 5. Where judgement lives, and where it does not

The four metrics the concept names split cleanly in two, and it matters:

| Signal | Who produces it | How |
|---|---|---|
| **Idle** — no activity for N minutes | Relay | Status transitions already tracked in `_poll_once`; a clock. |
| **Long runtime** — working for N minutes | Relay | Same source. |
| **Ambiguity** — does the last turn leave the next step underdetermined | Arbitrator agent | Judgement. Asked as a question in its prompt, answered as a field. |
| **Decision complexity** — is this beyond what should be auto-continued | Arbitrator agent | Judgement, same. |

The relay measures what a clock can measure and **never** judges. The arbitrator judges and **never**
measures. Idle and long runtime are *triggers* that wake the arbitrator; ambiguity and complexity are
*self-reported by it* and are what make it choose `call_human`. Attempting to score ambiguity in
Python is the failure mode to avoid — it would be prose-parsing wearing a metric's clothes.

## 6. Architecture

```
web app  ── arbitration controls, thread badges, Pause
   │ WebSocket
   ▼
relay ──────────────────────────────────────────────
   │  turn capture      status transitions + pane_summary.py
   │  metrics           idle / runtime clocks
   │  arbitration       trigger → prompt → validate → execute
   │  SQLite            turns, sessions, decisions
   ▼
herdr CLI ── member panes + one arbitrator pane
```

Three new relay modules, no new dependency, no second server:

| File | What |
|---|---|
| `relay/conversation_log.py` | SQLite: `turns`, `sessions`, `decisions`. Turn capture is useful on its own. |
| `relay/arbitrator.py` | Pure: prompt building, decision schema validation, budget arithmetic, gate resolution. No I/O, so it is unit-testable the way `orchestrator.py`'s state machine was. |
| `relay/arbitrator_runner.py` | The impure half: wired to poll transitions, sends prompts, executes decisions, broadcasts. |

### 6.1 Backend turn capture (the piece with independent value)

The hook already exists. `_poll_once` in `relay/herdr_relay.py:857` reacts to `working|blocked → done`
by reading the pane and calling `finished_body`, which calls `summary_body` from
`relay/pane_summary.py` — the same final-message detector the browser uses, held to line-range parity
by `tests/test_summary_detect.js` and `tests/test_pane_summary.py`.

So the relay can already find a pane's closing message. What it does not do is *keep* it. Turn capture
writes one row per turn end: pane fingerprint, agent kind, project, status transition, the detected
summary range and text, the pane tail as fallback, and a timestamp.

This is worth shipping even if arbitration is never enabled:

- A conversation survives the browser being closed, which the IndexedDB store cannot promise.
- Telegram, the TUI and the mac app get summaries without each porting the detector.
- The FE store and the BE log stay **separate stores**, joined by pane fingerprint — no sync
  protocol, no merge, no ownership question. The browser keeps the rich thread; the relay keeps the
  arbitration-grade subset.

Gate: `HERDR_CONV_LOG=1`. Off means no rows are written and the wire is unchanged.

### 6.2 An arbitration session

Started from the conversation view. It carries:

```
session:
  conversation      the roster it arbitrates over
  members[]         enrolled panes; the only addresses a decision may name
  arbitrator        one pane, not a member
  scope             the user's brief, in prose, injected into every arbitrator prompt
  gates[]           gate names + instruction templates (CRFN default set)
  budget
    max_steps            total auto-sends
    max_consecutive      auto-sends without a human touching it
    max_wall_clock       minutes
  triggers
    on_turn_end          default on
    idle_minutes         0 = off
    runtime_minutes      0 = off
```

Exactly one session may be active at a time (v1). It is paused by the user, by budget exhaustion, by
any member becoming `blocked` — the existing approval UI already owns that — or by a malformed
decision surviving its one re-prompt.

### 6.3 The decision channel

On a trigger, the relay sends the arbitrator pane one prompt containing: the scope, the roster with
each member's role and current status, the triggering turn's summary, a digest of recent turns, the
gate list, the remaining budget, and the fixed path it must write its answer to.

The arbitrator writes JSON to that path and finishes. On the arbitrator's own `done`, the relay reads
the path it already knew:

```json
{
  "session_id": "…",
  "sequence": 7,
  "gate": "review",
  "to": "<member id>",
  "instruction": "…prose the member will receive…",
  "why": "…one paragraph, for the human reading the thread…",
  "ambiguity": "low",
  "decision_complexity": "low",
  "stop": false
}
```

Validation: session and sequence must match what was asked; `gate` must be in the session's gate
list; `to` must be an enrolled, live member; `instruction` is capped and stripped of control
characters; unknown fields are rejected rather than ignored. A record that fails gets **one** re-prompt
naming the failure, and the relay waits for the file to *change* rather than for a second `done`.
A second failure pauses the session and calls the human.

Why a file rather than an HTTP call from the pane: the file is durable across a relay restart, it is
reviewable after the fact, it needs no token inside an agent's shell, and it makes the "read the path
you already expect" rule enforceable. Cost: local host only. Named, not hidden — see D4.

### 6.4 Execution

`gate: call_human` or `stop: true` pauses the session and pushes a notification. Otherwise the relay:

1. renders the gate's instruction template around the arbitrator's `instruction`,
2. sends it to `to` with the existing `send_text` + `submit` path, so the text and its Enter arrive in
   one herdr call,
3. records the send as a turn with `via: "arbitrator"` and the decision id,
4. decrements the budget and broadcasts the new session state.

`via: "arbitrator"` is a fourth value alongside the thread's existing `typed`, `transfer` and `mixed`
— the FE already renders provenance per entry, so an arbitrated message is a badge, not a new view.

## 7. Safety

Deliberate, and none of it optional:

- The arbitrator may address **only** enrolled members. Not the arbitrator itself, not a pane that
  joined after the session started.
- A decision carries prose and a target. Never argv, never a path, never a cwd, never an agent kind.
- Budgets are hard stops, not warnings.
- Every auto-send appears in the thread with its badge and the arbitrator's `why`. Nothing happens
  off-screen.
- Pause is one control, and Esc already stops a pane.
- A blocked member pauses the session — a human question is not something to arbitrate around.
- Requires `HERDR_ENABLE_WRITE_EXT`, because it sends text to panes unattended, plus its own
  `HERDR_ENABLE_ARBITER=1`. Off by default, and off means the wire is unchanged.

## 8. Slices

| Slice | Contents | Independently useful |
|---|---|---|
| **S0** | Turn capture, `conversation_log.py`, `turn` broadcast, `HERDR_CONV_LOG` | Yes — durable summaries for every client |
| **S1** | `arbitrator.py` pure: schema, validation, budgets, prompt building, gate rendering + unit tests | Reviewable before anything can send |
| **S2** | `arbitrator_runner.py`, session start/pause/cancel, turn-end trigger, execution | The loop works, manual triggers only |
| **S3** | Idle and runtime triggers | The loop runs unattended |
| **S4** | FE: start dialog, session strip, `via: arbitrator` badge, decision detail | The loop is legible |

S0 and S1 are the two worth doing first regardless of how the open decisions land.

## 9. Open decisions

Recommendations given; say which you want changed.

- **D1 — Is the conversation really the unit, rather than a feature?**
  *Recommend yes.* It is what exists, what people use, and what makes the loop reusable outside CRFN.
- **D2 — Decision by file record, or by HTTP call from the arbitrator's shell?**
  *Recommend file.* Durable, reviewable, no token in a pane. Accepts local-host-only for v1.
- **D3 — May the arbitrator start a new agent?**
  *Recommend no for v1.* Enrolled members only. It is the single largest jump in blast radius and it
  is additive later.
- **D4 — Where do decision records live?**
  *Recommend `.herdr/arbitration/<session>/`, refusing to start unless that path is git-ignored* —
  the same precondition the orchestrator branch enforced, for the same reason: run state must not
  dirty the product's history.
- **D5 — Does the arbitrator see full turn summaries, or the whole thread?**
  *Recommend summaries plus user inputs, with a digest cap.* The whole thread is unbounded context
  and most of it is tool noise.
- **D6 — What does the human see while it runs?**
  *Recommend: the thread, unchanged, with arbitrated messages badged and the session strip on top.*
  No separate run view — a run view is what makes it feel like a second product.
- **D7 — Is the arbitrator allowed to send to a member that is still `working`?**
  *Recommend no.* Queue until that member's turn ends, or pick someone else. Interrupting a working
  agent is how instructions get swallowed.
- **D8 — Default budgets?**
  *Recommend 12 steps, 4 consecutive, 60 minutes.* Small enough that a wrong scope costs minutes.

## 10. What would make this fail

Named so we can watch for them:

- **The arbitrator is a bad judge.** Mitigated only by budgets, `why` being visible, and Pause. This
  is a judgement product; it cannot be validated into correctness.
- **Summary detection misses.** The detector is per-harness and learned; a miss feeds the arbitrator
  a pane tail instead of a conclusion. The turn row keeps both, so a miss is visible rather than
  silent.
- **Pane IDs move.** herdr's pane ID changes on every restart — the FE already learned this the hard
  way (`healPairs`). Sessions must pin members by fingerprint (host, agent, cwd) and pause rather than
  guess when a member's seat becomes ambiguous.
- **It gets built into an orchestrator by accretion.** Every gate that wants a check runner, every
  decision that wants a phase, is the frozen branch coming back one field at a time. The line in §4
  is the thing to defend.
