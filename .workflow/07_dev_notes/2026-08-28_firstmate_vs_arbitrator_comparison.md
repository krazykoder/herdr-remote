# firstmate vs. herdr-remote arbitrator/conductor — comparison

Date: 2026-08-28  
Status: working notes, not a decision

Source repo: https://github.com/kunchenguid/firstmate  
Local clone: `/Users/towshif/code/python/firstmate`

---

## What each system solves

**firstmate** — parallel crew under a human captain.  
N crewmates work simultaneously in isolated worktrees. No inter-agent coordination. Captain is the only decision point: merge approvals, blocked tasks, routing. Supervision cost: zero tokens (bash watcher, no LLM in the loop). Secondmates are persistent named agents with their own home directory, survive restarts.

**herdr-remote arbitrator** — serialized two-member collaboration under an AI referee.  
Exactly 2 members + 1 arbitrator. Only one member works at a time (relay enforces). Arbitrator reads the conversation log, writes a JSON drop-box decision. Six gates: `implement` / `call_human` / `hold` / `resume` / `pause` / `done`. Pure validator layer separates decision from execution. Session is ephemeral; conversation log is the durable record.

---

## How firstmate runs crewmate agent sessions

### Not one-shot `-p` invocations

Crewmates run as **interactive terminal sessions** — in tmux panes, herdr panes, zellij, orca, or cmux. The agent is launched into a live pane, not killed after each response. Evidence:

- `fm-spawn.sh` creates a worktree and launches the harness into a terminal pane.
- `fm-send.sh` writes instructions to a **durable steering inbox** (`state/<id>.inbox/`) and sends a "doorbell" line to the pane — the agent reads the inbox, not the raw text.
- The watcher polls for turn-end events and re-rings unacknowledged messages.
- `fm-control.sh interrupt|exit|relaunch` manages the live session lifecycle (interrupt key sequences, exit commands, recovery).
- Harness adapters document per-harness "resume behavior", "interrupt", and "exit command" — none of those concepts apply to one-shot runs.

**No token waste per turn:** the agent's own context window accumulates across the whole task. Firstmate sends a brief at spawn (written into `data/<id>/brief.md`), then steers by appending to the inbox. The agent reads these sequentially in the same session — no context restart per instruction.

### Session reuse across tasks

Within **one task**: same pane, same session, full context retained throughout. Firstmate steers it repeatedly.

Across **tasks**: no reuse. Each task gets a fresh worktree and a fresh pane. The brief is task-specific and the agent starts cold.

**Exception — secondmates**: these are persistent. A secondmate has its own `FM_HOME`, its own pane, and survives between sessions. Firstmate routes work to a secondmate by name. The secondmate agent session stays live and accumulates context across many tasks. This is the one case that looks like session reuse for improvement.

### Brief is read-once at spawn

`data/<id>/brief.md` is written before spawn and handed to the crewmate at start. Not re-sent on steer. Steering happens through the inbox. The brief does not change after spawn (though the captain can edit it before spawn).

Contrast: herdr-remote prompts are re-read from disk on every send (`relay/prompts/*.md`) — hot-editable mid-session with no restart.

### No multi-agent handoff inside a single worktree

One agent, one session, one worktree — from brief to PR.

From AGENTS.md (lines 344–346):
> For a no-mistakes ship, trigger validation on the **same worker** after its implementation commit.  
> The task worker that starts a no-mistakes run **drives the pipeline and owns every `no-mistakes axi run` and `no-mistakes axi respond` call**.  
> Firstmate never invokes `no-mistakes axi respond` for a crew-owned run.

The `no-mistakes` pipeline is a **deterministic external CLI** — not a second AI reviewer. The crewmate agent drives it by invoking commands and reading its output. No second agent reads the first's work. No handoff. No review agent inside the tree.

VISION.md confirms: *"validation belongs to no-mistakes, CI belongs to the forge"* — external tools the agent uses, not sibling agents.

**Implication for herdr-remote conductor:** the arbitrator pattern — one agent reading the other's conversation log before deciding what to say — is something firstmate has no equivalent for inside a task. That mutual awareness is herdr-remote's unique contribution.

---

## Comparison matrix

| | firstmate | herdr-remote arb |
|---|---|---|
| Crew size | N (unlimited) | 2 members fixed |
| Concurrency | Parallel (all crewmates run at once) | Serial (relay blocks writes to idle member) |
| Coordinator | Human captain | AI arbitrator |
| Turn-taking | None — captain is bottleneck at merge/block | Strict — relay enforces one active member |
| Decision format | Natural language task + captain-hold | Structured JSON drop-box |
| Decision validator | None | Pure `arbitrator.py` (§12.3 spec) |
| Agent session model | Interactive pane, long-lived per task | Interactive pane, relay-driven sends |
| Session reuse | No (per task); yes for secondmates | No (session-bound); conv log is the record |
| Persistence | Tasks, backlog, secondmates survive | Session dissolves; conv log durable |
| Remote agents | SSH secondmates | Same herdr instance only |
| Supervision cost | 0 tokens (bash watcher) | LLM tokens per decision turn |
| Merge authority | Captain approves explicitly | Arbitrator decides; human reviews log |
| Prompt editing | Static after spawn | Hot-reloadable mid-session |
| Dispatch profiles | Yes (`crew-dispatch.json`, natural language) | No (arbitrator reasons from conv log) |
| Escalation | Captain-hold on any blocker | `call_human` gate (pause, wait for human) |
| Multi-agent within task | No — one agent owns the task end to end | N/A — members are separate panes |

---

## Should herdr-remote replace arbitrator with firstmate?

No. Orthogonal tools. Different problems.

- **firstmate** is captain-centric. Human in the loop on every merge and blocker. Right when you want parallel autonomous work with human gates at the seams.
- **herdr-remote arbitrator** is AI-referee-centric. Human steps out, arbitrator drives turns. Right when two agents need to negotiate, take turns on shared state, and the human observes rather than decides.

---

## What firstmate has that herdr-remote conductor should consider borrowing

**1. Durable steering inbox**  
`fm-send.sh` writes a sequenced record before touching the pane. The agent acknowledges by moving it to `handled/`. The watcher re-rings unacknowledged messages and escalates stuck ones. This is stricter than herdr-remote's current "send and watch for confirmation" model — acknowledgement is explicit and durable, not inferred from pane status.

**2. Dispatch profiles (`crew-dispatch.json`)**  
Natural-language rules that choose harness/model/effort per task: "heavy design → claude, light scripting → codex". Firstmate resolves the best-fit rule at intake. herdr-remote's `arb_start` currently picks a fixed arbitrator; a dispatch layer would let the relay or the client pick the best-fit model for the task profile.

**3. Persistent secondmates**  
A secondmate survives sessions and accumulates context across many tasks. herdr-remote has bots (`c_bot_<slug>`) that carry a fixed conversation, but the arbitrator itself is always fresh-briefed. A persistent arbitrator that remembers prior sessions' outcomes would be the analogue — closer to a "standing referee" than a "per-match referee".

**4. Zero-token bash supervision**  
The watcher polls for turn-end events without LLM involvement. herdr-remote's arbitration loop does involve the LLM on every turn. For high-frequency sessions, a bash-level pre-filter (skip the arbitrator when the trigger carries nothing new) would reduce token burn.

**5. --relaunch without identity loss**  
`fm-control.sh relaunch` swaps the harness on a live task without creating a new task or losing the worktree, endpoint, or delivery contract. herdr-remote has no equivalent — a broken arbitrator pane means `arb_cancel` and a fresh `arb_start`.

---

## What herdr-remote has that firstmate lacks

- Drop-box + pure validator (`arbitrator.py`) — structured, auditable, rejectable decisions.
- 6-gate decision space (firstmate has 1: captain-hold).
- Hot-editable prompts mid-session.
- Instruction modes (`minimal`/`detailed`) changeable mid-session.
- Conversation log as ground truth — arbitrator reads what the members actually said, not what it was told they said.
- `arb_edit` — change roster, budget, mode, scope on a running session.
- `three holds in a row → auto-pause` — automatic circuit-breaker.
- Mutual agent awareness within a session.

---

## Verdict for conductor design

Build conductor as the dispatcher/commander extension of the existing arbitrator (`2026-08-23_arbitrator_dispatcher_proposal.md`). Do not replace.

The parked proposal's dispatcher (§1–§5) is already mostly wired: `human_entered`, `prompt(note=...)`, and the private session directory all exist. The gap is one new client message (`arb_task`) and the relay's three-line handler.

The three things firstmate solves that conductor should eventually cover:
1. **Idle armed session with no trigger** — `arb_task` is the answer (hand work in explicitly).
2. **Parallel crewmates** — not in scope for conductor; different problem.
3. **Persistent arbitrator** — study secondmate model; not blocked on conductor v1.

---

## Feature shortlist — concepts from firstmate worth importing into herdr-remote

### Tier 1 — High value, directly applicable

**1. Explicit message acknowledgment**  
firstmate's steering inbox: message written durably, agent moves it to `handled/` when read. herdr-remote sends text and watches pane status — no explicit ack. A send could silently fail if the agent was already working.  
Worth: add an ack signal to the send path, not just pane-status inference.

**2. Message re-ring on no-ack**  
Watcher re-rings unacknowledged inbox records and escalates stuck ones. herdr-remote has `HERDR_CONFIRM_MS` but it's a timeout, not a ring-retry loop with escalation.  
Worth: structured retry with escalating urgency before giving up.

**3. Dispatch profiles for arbitrator/model selection**  
Natural-language rules that pick harness/model/effort per task: "heavy design → opus, light routing → haiku". For herdr-remote: a rule set that picks which model acts as arbitrator based on task profile. Currently `arb_start` picks a fixed pane; no capability-routing exists.  
Worth: a config or rule set at `arb_start` that selects the best-fit arbitrator model per session profile.

**4. Zero-token pre-filter before LLM invoke**  
firstmate's watcher classifies wakes in bash before spending any tokens. herdr-remote invokes the arbitrator LLM on every trigger, including turns that carry nothing new. The "trigger that carries nothing" decision log is a start, but could go further.  
Worth: a cheap pre-check that skips the arbitrator call when the trigger provably carries no new information.

**5. Per-session delivery contract (posture)**  
Mode + autonomy posture set at start, enforced throughout, refuses mismatch mid-session. herdr-remote's `arb_start` takes `mode` (minimal/detailed) but no autonomy posture.  
Worth: a `posture` field — how much the arbitrator may decide without human input before auto-escalating to `call_human`.

### Tier 2 — Medium value, worth designing

**6. Persistent standing arbitrator (secondmate analogue)**  
Secondmates survive restarts and accumulate context across many tasks. herdr-remote's arbitrator is always fresh-briefed. A standing arbiter session that accumulates decisions across arb sessions doesn't need a full brief each time — it remembers prior outcomes for this pair.  
Worth: a "standing arbitrator" model alongside the current per-session model. Maps to bots (`c_bot_<slug>`) concept extended to the arbiter role.

**7. Task typing (ship vs scout)**  
firstmate separates "ship" (changes code, opens PR) from "scout" (read-only, leaves report). herdr-remote has no equivalent — every arb session can send arbitrary instructions.  
Worth: a `kind` on `arb_start` that constrains legal gates — a `scout` session can only `hold`/`call_human`/`done`, never `implement`.

**8. Captain-hold with dependency routing**  
When a blocker is resolved, it can explicitly unblock named dependents. herdr-remote's `call_human` just pauses; resuming is unconditional.  
Worth: `arb_resume` that names which gates are now unblocked and why — structured escalation resolution, not plain unpause.

**9. Fleet snapshot as structured export**  
`fm-fleet-snapshot --json` emits complete structured state of all tasks. herdr-remote broadcasts `agents` state but no structured snapshot of all arb sessions + members + decisions in one queryable object.  
Worth: an `arb_snapshot` message that returns sessions, rosters, budgets, last decisions, event counts — useful for a dashboard view.

### Tier 3 — Good ideas, lower priority

**10. Away mode / reduced supervision posture**  
Different watcher behavior when captain is away vs present. For herdr-remote: an `arb_edit` flag or relay env var that changes how aggressively the arbitrator surfaces `call_human` when no human is watching.

**11. Worktree-write deferral as liveness signal**  
firstmate defers staleness escalation when it sees recent file writes in the worktree — agent is writing even if pane is quiet. herdr-remote has no equivalent.  
Worth: if git probe detects new commits since last turn, treat member as genuinely active rather than stale.

**12. Evidence capture to a separate branch**  
No-mistakes publishes validation evidence to an orphan git branch. herdr-remote's decisions go into SQLite.  
Worth: optional export of arb decisions + prompts to a git-tracked evidence file — auditable outside the app, shareable in PRs.

### Not worth importing

- Worktree management — not herdr-remote's concern; herdr owns pane lifecycle.
- `fm-spawn.sh` machinery — herdr already does agent launch.
- Secondmate SSH remotes — herdr-remote already has `HERDR_REMOTES` for multi-host.

**Highest-ROI starting point:** items 1+2 (durable ack + re-ring) and item 3 (dispatch profiles). The ack gap is a real reliability hole. Dispatch profiles directly extend `arb_start` with no protocol changes.

---

## Token cost optimization — firstmate techniques and herdr-remote applicability

### What firstmate does

| Technique | Mechanism |
|---|---|
| Zero-token bash watcher | Classifies all wakes before any LLM call. LLM only invoked when something is actionable. |
| Brief read-once at spawn | `data/<id>/brief.md` passed as positional arg at launch. Inbox carries deltas only — no re-send of the full brief on each steer. |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` | Suppresses Claude ghost text in the composer so pane-capture classifier doesn't misread an empty pane as having pending input. |
| Context budget tracking (`quota-axi`) | Blocks dispatch when quota for the selected model/provider is low. Prevents launching work that will be cut off mid-task. |
| Durable state on disk, not in conversation memory | Agent facts (projects, tasks, learnings) live in files. Conversation context stays lean — only what the current turn needs. |
| Session-start emits ONE supervision block | Not repeated per turn. The watcher protocol is established once; the model is not re-briefed about how to supervise on every wake. |
| Turn-end guard | Prevents silent continuation turns. Without it, an agent can complete work, "think" silently, and burn tokens before the turn is recorded. |
| Effort axis per task | `low` for well-understood bounded work, `xhigh` for ambiguous investigation. Never `max` by default. Matched to task complexity at intake. |

### Applicable to herdr-remote

| firstmate technique | herdr-remote status | Gap / action |
|---|---|---|
| Zero-token pre-filter before arbitrator call | Partially done — "trigger that carries nothing" decision log exists | Still invokes arbitrator for turns where member went idle with no new conv log rows. A cheap Python check — "did this turn produce any new rows?" — would skip the LLM call entirely for those |
| Brief / prompt sent once, deltas only | herdr re-reads prompts from disk on every use (hot-edit). Sends full prompt each time | Could narrow starter brief to only changed sections on re-brief; already partial via `resume.md` and `roster.md` separation |
| Context budget tracking | `budget` field exists in `arb_start` and decrements per decision | No per-model quota awareness; no dispatch-time check that the chosen arbitrator model has headroom before starting |
| Durable state not in conversation memory | Already done — conv log + SQLite | On track |
| One supervision block per session | Brief sent once; `resume.md` on `arb_resume` | On track |
| Effort axis for arbitrator model selection | Not present | Dispatch profiles (feature item 3 above) would cover this: pick model by task complexity, not just task profile |
| Turn-end guard equivalent | Relay watches pane status after send, `HERDR_CONFIRM_MS` timeout | No equivalent to the "turn ends blind" guard — a member can complete a turn silently and the relay may not catch it if the status transition is missed |

### Highest-ROI token optimization not yet done

**Skip arbitrator LLM call when trigger carries nothing new.**  
A turn-end trigger fires even when the member went idle without writing anything (e.g. agy status flip: `working → idle` with no new pane content). The arbitrator is invoked, reads the same conv log as last time, and writes `gate=hold` — correct but wasteful.  
Fix: before prompting the arbitrator, check `conv_log` for new rows since the last decision. Zero new rows → skip the LLM call, record a `no_new_content` event, stay armed. Already partially addressed in the "trigger that carries nothing" decision log but not fully wired as a pre-filter.

**Effort-aware arbitrator model selection.**  
Short sessions with clear task scope don't need opus. A `posture` or `effort` field at `arb_start` that maps to a model tier (haiku / sonnet / opus) would cut cost on routine sessions while reserving full capability for complex ones. Pairs with dispatch profiles (feature item 3).
