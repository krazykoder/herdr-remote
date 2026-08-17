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
| **The relay never infers a decision from terminal prose** | A closing message can be *located* mechanically; whether it means "accepted" cannot. Interpreting prose is the arbitrator's entire job — the rule is about who does it, and in what shape the answer comes back. See §5.1. |
| **A record protocol has to earn its trust with a validator** | The decision record is schema-checked, path-fixed, size-capped. One bounded re-prompt on a malformed record, then it stops for a human. |
| **The agent's `done` is a wake-up, not a result** | `done` means "go read the thing you were already expecting", never "the step passed". |
| **Prompt text is data; argv, cwd and write scopes are not** | The arbitrator may compose the *words* a member receives. It may never supply a command, a path, or a process to start. |

Everything else — phases, templates, drift, check runners, creator/reviewer slots, run gates — stays
on that branch. If a lifecycle engine is ever wanted, it can sit *above* the arbitrator later; the
arbitrator does not need it to be useful.

## 3. Scope

**In scope**

- Chat arbitration: one conversation, **two** enrolled members, one arbitrator — three panes.
- Backend history for every participant, the arbitrator included, queryable on demand.
- Feature-level CRFN automation: create, review, fix, next-step.
- Four gates: `implement`, `review`, `phase_plan`, `call_human`.
- Four measured signals fed to the arbitrator: ambiguity, decision complexity, idle, long runtime.
- Backend recording of turn-end summaries and user input, so arbitration does not need a browser tab
  open.

**Out of scope (v1)**

- Starting or killing panes from a decision. The arbitrator addresses members that already exist.
- Worktrees, commits, pushes, required-check running, working-tree drift.
- More than two members in a session, more than one session at a time, or arbitration across
  projects and hosts.
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

### 5.1 Who reads the prose

Reading the summary, working out what should happen next, writing the instruction and choosing who
receives it — that is the arbitrator's job and the whole point of the feature. It is doing what the
person does today when they pick a message out of one pane and send it to another with an
`@instruction` on top.

The rule the orchestrator branch left us is narrower than it first sounds. It does not say prose goes
uninterpreted; it says **the relay** does not interpret it, and the arbitrator's conclusion leaves as
fields rather than as a paragraph something downstream has to grep.

| Actor | Reads the prose | Interprets it | What it emits |
|---|---|---|---|
| `relay/pane_summary.py` | yes | no — counts gutter characters, returns a line range | line numbers |
| relay, building the prompt | passes it through | no | the arbitrator's prompt |
| **arbitrator agent** | **yes** | **yes — this is the job** | a decision record |
| relay, executing | never re-reads it | no | `send_text` to `to` |

Banned:

```python
if "looks good" in summary_text:
    advance_gate()          # a sentence fragment moved the loop
```

Intended:

```python
prompt = render_prompt(scope, roster, summary_text, gates, budget)
send_text(arbitrator_pane, prompt, submit=True)
# …on the arbitrator's own `done`:
decision = validate(read_record(path))            # gate ∈ gates, to ∈ live members
send_text(decision["to"], render(decision["gate"], decision["instruction"]), submit=True)
```

`instruction` and `why` are free prose written by the arbitrator; the relay only delivers and
displays them, never parses them. Only `gate` and `to` are checked, because those two are what move
state — and both are enums over sets the session already fixed.

`to` may be any enrolled member, **including the one whose turn just ended** — sending an agent back
to its own work with a correction is a normal outcome, not a special case. It is not restricted to a
pair partner; a pair is a two-pane view, while a session roster can be larger.

This invariant is worth a test rather than a paragraph: a suite that feeds the executor a summary
containing every phrase a prose parser would trip on (`accepted`, `LGTM`, `approved`) with no valid
decision record present, and asserts that nothing was sent and no state moved. Reviewed against
`main` on 2026-08-17 and it complies today by construction — `pane_summary.py` only locates ranges,
and `finished_body` reaches nothing but a push body — so the test exists to keep it that way.

### 5.2 Which signals are measured, and which are judged

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
web app  ── arbitration controls, thread badges, Pause, on-demand log query
   │ WebSocket
   ▼
relay ──────────────────────────────────────────────
   │  turn capture      end-state transitions + pane_summary.py
   │  metrics           idle / runtime clocks
   │  arbitration       trigger → prompt → validate → execute
   │  SQLite            entries, sessions, prompts, decisions   ← the record of truth
   │  drop-box          one JSON file per decision, read once   ← inbound channel only
   ▼
herdr CLI ── member panes + one arbitrator pane
                         │
                         └── read-only log query, over the DB, from its own shell
```

Four new relay modules, no new dependency, no second server:

| File | What |
|---|---|
| `relay/conversation_log.py` | SQLite store and its schema. Turn capture is useful on its own. |
| `relay/conv_query.py` | Read-only query surface over that store: one function the relay calls, and a `__main__` the arbitrator's shell can call. |
| `relay/arbitrator.py` | Pure: prompt building, decision schema validation, budget arithmetic, gate resolution. No I/O, so it is unit-testable the way `orchestrator.py`'s state machine was. |
| `relay/arbitrator_runner.py` | The impure half: wired to poll transitions, sends prompts, reads the drop-box, executes decisions, broadcasts. |

### 6.1 Backend recording (the piece with independent value)

The hook already exists. `_poll_once` in `relay/herdr_relay.py:857` reacts to status transitions and,
on a finish, reads the pane and calls `finished_body`, which calls `summary_body` from
`relay/pane_summary.py` — the same final-message detector the browser uses, held to line-range parity
by `tests/test_summary_detect.js` and `tests/test_pane_summary.py`.

So the relay can already find a pane's closing message. What it does not do is *keep* it.

**A turn ends on a transition to an end state, not on `done`.** The browser already settled this:
`TURN_END_STATES = ['idle', 'done', 'blocked']` and `endsTurn(status)` in `web/src/state.js:328`,
which `convReadTurnEnd` gates on. The relay's poll loop currently branches on `done` and `blocked`
separately and has no notion of the set. S0 adds `ends_turn()` to `pane_summary.py` mirroring that
list, and holds the two to parity in tests the way the detector already is. Capturing only `done`
would silently lose every turn that ends by going idle.

**Every entry carries an explicit origin.** The store is a record of who said what, so authorship is a
field and never an inference:

```json
{
  "session_id": "…", "seq": 41,
  "from": "member-2",
  "kind": "agent_final",
  "origin": "agent",
  "text": "…", "tail": "…", "range": [412, 430],
  "status_from": "working", "status_to": "idle",
  "at": "2026-08-17T11:04:22Z"
}
```

`origin` is one of `agent`, `human_web`, `human_terminal`, `arbitrator`, `unknown`. The distinction
that matters: a prompt sent through the relay is known to be `human_web`; text typed directly into a
terminal is seen only as an echo in the pane and is therefore `human_terminal` at best and `unknown`
when even that cannot be established. **The relay never claims to know which human typed into a
terminal.** The FE's thread already models this — `classifyVia` calls an unmatched send `typed`
because provenance is only knowable where the send happened — and the backend inherits the same
honesty.

This slice is worth shipping even if arbitration is never enabled:

- A conversation survives the browser being closed, which the IndexedDB store cannot promise.
- Telegram, the TUI and the mac app get summaries without each porting the detector.
- The FE store and the BE log stay **separate stores**, joined by pane fingerprint — no sync
  protocol, no merge, no ownership question. The browser keeps the rich thread; the relay keeps the
  ground truth.

Gate: `HERDR_CONV_LOG=1`. Off means no rows are written and the wire is unchanged.

### 6.2 The record of truth is the database; the file is the channel

Two different jobs, and conflating them is what makes file-based state unpleasant:

| | Job | Lives in |
|---|---|---|
| **Drop-box** | How an agent, which can only write files, hands a decision to the relay | `$HERDR_LOG_DIR/arbitration/<session>/NNNN-decision.json`, mode 0700 |
| **Record** | What the session is, what was decided, what was sent, what was said | SQLite, `$HERDR_LOG_DIR/arbitration.sqlite3` |

The relay reads the drop-box file **once**, validates it, and writes the accepted decision into the
database along with the prompt that produced it. From that moment the row is authoritative: the FE,
the arbitrator's own queries, and any later audit read the database. The file stays on disk
unmodified as the raw artifact — a backup of the row and evidence of exactly what the agent wrote,
including a rejected version.

Why the database is worth having rather than a directory of JSON:

- Ordering, budgets and "what is the current session" are queries, not directory listings.
- A partially written file during a relay restart is a corrupt state; a transaction is not.
- The arbitrator's on-demand context (§6.3) is a query with a bound, which a directory cannot answer.
- One store already holds the entries, so decisions living beside them means a session's history is
  one join rather than two formats.

Schema, small on purpose:

```
sessions   id, conversation, scope, gates_json, budget_json, triggers_json,
           arbitrator_fingerprint, state, created_at, ended_at, ended_reason
members    session_id, member_id, fingerprint(host, agent, cwd), label, role, enrolled_at
entries    id, session_id, seq, from_member, kind, origin, text, tail,
           range_start, range_end, status_from, status_to, at
prompts    id, session_id, sequence, body, sent_at, trigger
decisions  id, session_id, sequence, prompt_id, raw_path, valid, reject_reason,
           gate, to_member, instruction, why, ambiguity, complexity, stop, at
sends      id, session_id, decision_id, to_member, text, at
```

Storage location is relay-owned (`$HERDR_LOG_DIR`), not the project's checkout. That drops the
git-ignore precondition the orchestrator branch needed, keeps arbitration state out of product
history by construction rather than by check, and means a session is not tied to one repository.

### 6.3 Ground truth, on demand

The default is push: each prompt carries a bounded digest (§6.5). But "the arbitrator can see both
agents' logs *if needed*" is a pull, and a digest cap is exactly the thing that makes a pull
necessary sometimes.

Two readers, one store:

- **The human**, from the web app: a `conv_log` request over the existing WebSocket, answered to the
  asking client only — the same shape `run_detail` used on the orchestrator branch, and for the same
  reason: it is the message that carries agent prose.
- **The arbitrator**, from its own shell:

```bash
python3 relay/conv_query.py --session <id> --member member-2 --last 20
python3 relay/conv_query.py --session <id> --grep "footer"        # back through the whole thread
python3 relay/conv_query.py --session <id> --since 0007           # everything after a decision
```

It opens the SQLite file **read-only** (`file:…?mode=ro`) and prints matching entries with their
author, origin and time. No endpoint, no token in a pane, no write path, and nothing exposed that is
not already in the log. The command is named in the starter prompt.

**Every participant is logged, the arbitrator included.** Its own turns are entries like anyone
else's, so going back through the three-way conversation means reading one table — the two members'
work and its own past decisions and reasoning in one ordered thread. An arbitrator that cannot see
what it decided four steps ago repeats itself.

That the arbitrator can grep back is what lets the pushed digest stay small without making it blind.

### 6.4 An arbitration session

Started from the conversation view. It carries:

```
session:
  conversation      the roster it arbitrates over
  members[]         enrolled panes, snapshotted at start; the only addresses a decision may name
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

**Membership comes from the front end.** Which panes are in a conversation is already a thing the
person decides in the app; the session enrols that roster rather than inventing its own. The relay
never picks participants.

**v1 arbitrates exactly two members.** Three panes in total: two working agents and the arbitrator
that decides between them. The store, the schema and the prompt are written for N because writing
them for two would cost the same and close the door; the *session* refuses to start with more until
a two-member loop has been watched running for real.

The roster is **snapshotted when the session starts**. A pane that joins the conversation afterwards
is not addressable until the human enrols it, so the set of things a decision can name never grows
underneath a running loop.

Exactly one session may be active at a time (v1). It is paused by the user, by budget exhaustion, by
any member becoming `blocked` — the existing approval UI already owns that — or by a malformed
decision surviving its one re-prompt.

### 6.5 The arbitrator's prompts

The arbitrator is an ordinary agent pane configured by prose, not a privileged relay component. It
gets its instructions in two parts, because most of them never change:

- **A fixed starter prompt, once**, when the session starts: what it is, the decision schema, the
  path to write to, the read-only query command, and the rule that only the file is read.
- **Only the changing context, per trigger**: the roster with live statuses, what fired, the turn
  itself, any human instruction since the last decision, the allowed gates, and the remaining budget.

```
Roster:
  member-1  Architect / claude / idle
  member-2  Reviewer  / codex  / idle

Trigger: member-1 finished (working → idle)

[Architect] Implemented the mobile footer change…

[Human, web] Keep the footer compact.

Allowed gates: implement, review, phase_plan, call_human
Budget: 7 steps / 3 consecutive / 44 minutes
Need more? python3 relay/conv_query.py --session … --member member-2 --last 20

Write one decision record to:
  ~/.local/state/herdr-remote/arbitration/<session>/0007-decision.json
```

Every prompt sent is stored (`prompts` table) beside the decision it produced, so a decision can
always be read against exactly what the arbitrator was looking at.

Its pane will also show ordinary prose — reasoning, tool calls, whatever the harness renders. None of
it is read by the relay. Only the file is authoritative.

### 6.6 The decision channel

The arbitrator writes JSON to the path it was given and finishes. On the arbitrator's own turn end,
the relay reads the path it already knew:

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
list; `to` must be an enrolled member whose pane is live and **not working**; `instruction` is capped
and stripped of control characters; unknown fields are rejected rather than ignored. A record that
fails gets **one** re-prompt naming the failure, and the relay waits for the file to *change* rather
than for a second turn end. A second failure pauses the session and calls the human.

A decision naming a member that has since started working is **not queued.** By the time that member
finishes, its state and the reason for the decision have both moved, and delivering a stale
instruction is worse than delivering none. It counts as a failed record: the arbitrator is re-prompted
with the current roster and picks another target or `call_human`.

Why a file rather than an HTTP call from the pane: it needs no relay token inside an agent's shell,
it survives a relay restart, and it leaves the raw artifact on disk beside the row it became. Cost:
local host only in v1.

### 6.7 Execution

`gate: call_human` or `stop: true` pauses the session and pushes a notification. Otherwise the relay:

1. renders the gate's instruction template around the arbitrator's `instruction`,
2. sends it to `to` with the existing `send_text` + `submit` path, so the text and its Enter arrive in
   one herdr call,
3. writes a `sends` row and an entry with `origin: "arbitrator"` and the decision id,
4. decrements the budget and broadcasts the new session state.

`via: "arbitrator"` is a fourth value alongside the thread's existing `typed`, `transfer` and `mixed`
— the FE already renders provenance per entry, so an arbitrated message is a badge, not a new view.

## 7. Safety

Deliberate, and none of it optional:

- The arbitrator may address **only** members on the roster snapshotted at start. Not itself, not a
  pane that joined afterwards.
- A decision carries prose and a target. Never argv, never a path, never a cwd, never an agent kind.
- A working member is never written to, and a decision that names one is rejected rather than held.
- The arbitrator's query path is read-only, over a `mode=ro` handle, and reaches nothing but the log.
- Arbitration state lives under `$HERDR_LOG_DIR` at mode 0700, never in a project checkout.
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
| **S0** | `conversation_log.py` + `conv_query.py`: the SQLite store, `ends_turn()` with FE parity, capture for every participant with explicit `origin`, the `conv_log` WebSocket query, the read-only CLI, `HERDR_CONV_LOG` | Yes — durable ground truth for every client, greppable |
| **S1** | `arbitrator.py` pure: schema, validation, budgets, prompt building, gate rendering + unit tests, including the §5.1 guard that prose alone moves nothing | Reviewable before anything can send |
| **S2** | `arbitrator_runner.py`, session start/pause/cancel, turn-end trigger, drop-box read, execution | The loop works, turn-end trigger only |
| **S3** | Idle and runtime triggers | The loop runs unattended |
| **S4** | FE: start dialog, session strip, arbitrated badge, decision detail | The loop is legible |

Build order is S0, then S1 reviewed in full before any unattended send path exists, then S2. S0 gets
live-tested on real sessions before S2 is wired at all.

## 9. Decisions

Settled with ARCH-Codex, 2026-08-17:

| | Decision | Settled as |
|---|---|---|
| **D1** | The unit | The conversation, roster snapshotted at start |
| **D2** | Decision channel | File drop-box — durable, inspectable, no relay token in a pane |
| **D3** | May the arbitrator spawn agents | No in v1. Enrolled members only |
| **D4** | Where state lives | Relay-owned `$HERDR_LOG_DIR`, mode 0700 — no project `.herdr/`, no git-ignore precondition |
| **D5** | Context | Turn summaries + user inputs + a bounded digest, plus on-demand pull. Never a full transcript |
| **D6** | UI | The existing thread with badges and a session strip. No second product |
| **D7** | A working target | Never written to, and never queued — the decision is rejected and the arbitrator re-prompted |
| **D8** | Budgets | 8 steps, 3 consecutive, 45 minutes. Raised only on real-session evidence |
| **D9** | Record of truth | SQLite. The drop-box file is the inbound channel and the raw artifact, not the state |
| **D10** | Who is logged | Every participant, the arbitrator included, so it can grep its own past decisions |
| **D11** | Session size | Two members plus the arbitrator in v1. Schema written for N, session refuses more |

Corrections folded in from the same review: a turn ends on any transition to an end state
(`idle`, `done`, `blocked`) through a shared `ends_turn()`, not on `done` alone; and every entry
carries an explicit `origin`, because the relay cannot know which human typed into a terminal.

Still open:

- **D12 — Retention.** How long entries and decisions are kept, and whether the FE's Activity storage
  view grows a backend row. Not a blocker for S0; a `vacuum` policy is cheaper to add than to undo.
- **D13 — Remote hosts.** The drop-box is a local file, so v1 is local-only. Whether remote members
  are worth an SSH read or whether the arbitrator must be co-located stays undecided.

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
