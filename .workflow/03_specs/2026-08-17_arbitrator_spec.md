# Arbitrator — specification

Status: draft, implementation-grade. Branch `feat/arbitrator`, off `main` at `1dd25e3`.
Concept and rationale: `.workflow/01_concepts/ideas/2026-08-17_arbitrator_proposal.md`.
Where the two disagree, **the concept doc owns the "why" and this document owns the "what"** — a
disagreement about behaviour is a bug in this file.

Prior art, deliberately not ported: `worktree-docs+agent-lifecycle-orchestrator-proposal`
(`relay/orchestrator.py`, `orchestrator_controller.py`, `orchestrator_io.py`). §17 maps what was
taken and what was left.

---

## 1. Purpose

The conversation harness lets one person drive several agents as a single chat: read a pane's closing
message, choose a recipient, send it on with an instruction. The person supplies exactly one thing at
each step — **who acts next, and what are they told**.

This specification defines:

1. **A backend conversation record** (§4–§7). Durable, per-participant, chronologically mergeable,
   queryable on demand. Useful on its own, with no automation attached.
2. **An arbitrator** (§8–§13). An ordinary agent in an ordinary pane that makes that one decision
   inside a scope the person set, and a relay that executes it under hard limits.

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **Pane** | A herdr pane. Identified by `pane_id`, which changes on every restart. |
| **Member** | A pane enrolled in a session, addressed by a stable `member_id` the session assigns. |
| **Participant** | Any pane whose entries are recorded: the members *and* the arbitrator. |
| **Conversation** | The front end's existing grouping of panes into one thread. Membership is the person's choice. |
| **Session** | One arbitration run over one conversation. Has a roster, a scope, gates, budgets, triggers. |
| **Entry** | One recorded thing said, by anyone, with an author, an origin and a time. |
| **Turn** | The span between a pane starting work and reaching an end state. A turn ends; entries are what it leaves. |
| **Trigger** | The event that wakes the arbitrator: a turn end, an idle clock, a runtime clock. |
| **Decision** | The arbitrator's structured answer: a gate, a target, an instruction. |
| **Gate** | A named kind of next step. Carries a fixed instruction template. |
| **Drop-box** | The JSON file an arbitrator writes to hand a decision to the relay. |
| **Send** | The relay delivering a rendered instruction to a member's pane. |

## 3. Normative invariants

These are the rules everything else serves. Each has a test named in §16.

- **N1 — The relay never derives control flow from terminal prose.** It may *locate* a line range
  mechanically. It may *transport* the text. It must never branch on what the text says.
  Interpretation is the arbitrator's job, and its conclusion arrives as fields.
- **N2 — Only `gate` and `to` move state, and both are enums over sets the session fixed.**
  `instruction` and `why` are free prose carried unmodified and never parsed.
- **N3 — An end state is a wake-up, not a result.** Reaching `idle`/`done`/`blocked` means "read the
  thing you were already expecting", never "the step passed".
- **N4 — Authorship is recorded, never inferred.** Every entry carries an explicit `origin`. Where
  the relay cannot know, it records `unknown` and does not guess.
- **N5 — A decision names a target and prose. Never argv, a path, a cwd, an agent kind, or a check.**
- **N6 — The roster changes only by a person's hand, and never under an outstanding decision.**
  *(Revised 2026-08-21. It read "the roster is fixed at session start"; see the decision log entry
  for why that was too strong.)* A client may replace the roster of a running session — attach,
  detach or swap — and when it does, the arbitrator is told on the same call, and the edit is
  refused while the session is `awaiting`. What the original wording protected is what still holds:
  the arbitrator is never handed a `to` it was not told about, and the set of addressable members
  never changes as a consequence of anything an agent said.
- **N7 — A working pane is never written to**, and a decision naming one is rejected, not held.
- **N8 — Every automated send is visible in the thread**, with its badge, its gate and the
  arbitrator's `why`. Nothing happens off-screen.
- **N9 — Budgets are hard stops.** Exhaustion pauses the session; it does not warn and continue.
- **N10 — Off means off.** With `HERDR_CONV_LOG` unset no rows are written; with `HERDR_ENABLE_ARBITER`
  unset no session can start and the wire is byte-for-byte unchanged.

---

# Part I — The conversation record

## 4. Storage

### 4.1 Location and permissions

| Thing | Path |
|---|---|
| Database | `$STATE_DIR/arbitration.sqlite3` |
| Drop-boxes | `$STATE_DIR/arbitration/<session_id>/NNNN-decision.json` |
| Prompt copies | `$STATE_DIR/arbitration/<session_id>/NNNN-prompt.txt` |

`$STATE_DIR` is `HERDR_STATE_DIR`, else `.herdr-remote/` beside the relay's own checkout
(`relay/herdr_relay.py:54`). The directory is created `0700`, files `0600`.

**This reverses D4**, which put state under `$HERDR_LOG_DIR` precisely so that nothing was written
into a checkout. The state directory is now *in* one, and `/.herdr-remote/` in `.gitignore` is what
keeps it out of history — a git-ignore precondition D4 was written to avoid. What was bought is a
relay whose whole runtime state is in one place a person can find, delete, and back up. What was
sold is that the secrets file now sits inside a git working tree.

### 4.2 Why a database, with files beside it

Two jobs, deliberately separated:

| | Job | Medium | Authoritative |
|---|---|---|---|
| **Drop-box** | How an agent — which can only write files — hands a decision to the relay | JSON file | No |
| **Record** | What the session is, what was said, what was decided, what was sent | SQLite | **Yes** |

The relay reads a drop-box **once**, validates it, and writes the outcome into the database along with
the prompt that produced it. From then on the row is the record; the file remains untouched as the
raw artifact — evidence of exactly what the agent wrote, including a version that was rejected.

Reasons the record is a database and not a directory of JSON:

- Ordering, budget arithmetic and "which session is active" are queries, not directory listings.
- A partially written file during a relay restart is a corrupt state; a transaction is not.
- The arbitrator's on-demand context (§7) is a bounded query, which a directory cannot answer.
- Entries and decisions in one store means a session's history is one join, not two formats.

### 4.3 Schema

SQLite, stdlib `sqlite3`, `journal_mode=WAL`, `foreign_keys=ON`. Times are integer epoch
milliseconds throughout — the front end's clock unit, so no conversion at the boundary.

#### 4.3.1 The record is global, not per session

**`turns` belongs to no session.** Capture is per pane, keyed by fingerprint, and happens once
whether or not any arbitration exists. This is what makes S0 shippable on its own, and it is also the
honest model: a pane can be in more than one conversation over its life, and its turns do not belong
to whichever session happened to be running.

An arbitration session reads the turns it cares about by **roster fingerprints and a time window** —
its members' `(host, agent, cwd)` and everything at or after `created_at`. No session-scoped copy of
the same text, no capture that only happens when a session is active, and nothing to reconcile when
one pane is in two conversations.

```sql
CREATE TABLE IF NOT EXISTS turns (
  id                INTEGER PRIMARY KEY,
  seq               INTEGER NOT NULL,          -- global monotonic, assigned at insert
  host              TEXT NOT NULL DEFAULT 'local',
  agent             TEXT NOT NULL,             -- harness kind: claude, codex, …
  cwd               TEXT NOT NULL DEFAULT '',
  pane_id           TEXT NOT NULL,             -- as observed; not an identity, see §5.1
  label             TEXT NOT NULL DEFAULT '',
  project           TEXT NOT NULL DEFAULT '',
  kind              TEXT NOT NULL,             -- §6.2
  origin            TEXT NOT NULL,             -- §6.3
  text              TEXT NOT NULL,             -- the detected message, or the sent instruction
  tail              TEXT NOT NULL DEFAULT '',  -- pane tail fallback when detection found nothing
  range_start       INTEGER,                   -- detected line range, null when there was none
  range_end         INTEGER,
  status_from       TEXT,
  status_to         TEXT,
  at                INTEGER NOT NULL,          -- when it was said, best available
  at_src            TEXT NOT NULL,             -- how good that answer is, §6.4
  decision_id       INTEGER                    -- set on arbitrated sends; no FK, turns outlive sessions
);
CREATE INDEX IF NOT EXISTS turns_time  ON turns(at, seq);
CREATE INDEX IF NOT EXISTS turns_fp    ON turns(host, agent, cwd, at, seq);
CREATE INDEX IF NOT EXISTS turns_pane  ON turns(pane_id, at, seq);
```

`decision_id` carries no foreign key on purpose: a turn outlives the session that caused it, and a
pruned session must not cascade away the record of what was said.

#### 4.3.2 Arbitration tables (S2 and later)

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,          -- relay-assigned, never client-supplied
  conversation      TEXT NOT NULL,             -- the FE conversation id this was started from
  scope             TEXT NOT NULL,             -- the person's brief, injected into every prompt
  gates_json        TEXT NOT NULL,             -- [{name, template}, …]
  budget_json       TEXT NOT NULL,             -- {max_steps, max_consecutive, max_wall_clock_ms}
  triggers_json     TEXT NOT NULL,             -- {on_turn_end, idle_ms, runtime_ms}
  arbitrator_fp     TEXT NOT NULL,             -- fingerprint, see §5.2
  arbitrator_pane   TEXT NOT NULL,             -- last known pane_id, re-resolved on each use
  state             TEXT NOT NULL,             -- §9.1
  pause_reason      TEXT,                      -- §9.3, null unless paused
  steps_used        INTEGER NOT NULL DEFAULT 0,
  consecutive       INTEGER NOT NULL DEFAULT 0,
  sequence          INTEGER NOT NULL DEFAULT 0,-- next decision sequence
  created_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  ended_reason      TEXT
);

CREATE TABLE IF NOT EXISTS members (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  member_id         TEXT NOT NULL,             -- 'member-1'…, stable for the session's life
  host              TEXT NOT NULL DEFAULT 'local',
  agent             TEXT NOT NULL,             -- harness kind: claude, codex, …
  cwd               TEXT NOT NULL DEFAULT '',
  label             TEXT NOT NULL,             -- pane label at enrolment
  role              TEXT NOT NULL DEFAULT '',  -- 'review, fix-code' — see §14.3, or ''
  pane_id           TEXT NOT NULL,             -- last resolved; re-resolved per §5.2
  enrolled_at       INTEGER NOT NULL,
  PRIMARY KEY (session_id, member_id)
);

CREATE TABLE IF NOT EXISTS prompts (
  id                INTEGER PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence          INTEGER NOT NULL,
  trigger           TEXT NOT NULL,             -- 'turn_end' | 'idle' | 'runtime' | 'reprompt'
  body              TEXT NOT NULL,             -- exactly what was sent to the arbitrator
  sent_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id                INTEGER PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence          INTEGER NOT NULL,
  prompt_id         INTEGER NOT NULL REFERENCES prompts(id),
  raw_path          TEXT NOT NULL,             -- the drop-box file this came from
  valid             INTEGER NOT NULL,          -- 0/1
  reject_code       TEXT,                      -- §12.3, null when valid
  reject_detail     TEXT,
  gate              TEXT,
  to_member         TEXT,
  instruction       TEXT,
  why               TEXT NOT NULL,
  ambiguity         TEXT,                      -- 'low' | 'medium' | 'high'
  complexity        TEXT,                      -- 'low' | 'medium' | 'high'
  raw_sha256        TEXT NOT NULL,             -- content hash of the drop-box, §12.1
  at                INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_seq ON decisions(session_id, sequence, id);

CREATE TABLE IF NOT EXISTS sends (
  id                INTEGER PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  decision_id       INTEGER NOT NULL REFERENCES decisions(id),
  to_member         TEXT NOT NULL,
  pane_id           TEXT NOT NULL,             -- resolved at send time
  text              TEXT NOT NULL,             -- rendered, exactly as delivered
  at                INTEGER NOT NULL
);
```

Only one session may be **running** at a time in v1 (§9.2). Running means `active` *or* `awaiting` —
a session whose arbitrator is mid-decision is very much still running, and an index over `active`
alone would let a second session start in exactly that window:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS one_running_session
  ON sessions(state IN ('active','awaiting')) WHERE state IN ('active','awaiting');
```

## 5. Identity

### 5.1 Why `pane_id` cannot be the identity

herdr's `pane_id` belongs to herdr. It changes on every restart, workspace reopen and relaunch. The
front end learned this the expensive way: pairs pinned to a `pane_id` silently stopped matching and
the pair strip vanished with nothing said, which is what `healPairs` (`web/src/pairs_ui.js:23`)
exists to repair.

### 5.2 Fingerprint and resolution

A member is pinned by **fingerprint** — `(host, agent, cwd)` — and carries its last known `pane_id`
as a cache. Before any read or send, the runner re-resolves:

1. If a live pane has the stored `pane_id` **and** matches the fingerprint → use it.
2. Else, if **exactly one** live pane matches the fingerprint and is not claimed by another member of
   this session → adopt it, update `members.pane_id`, record it as an event.
3. Else → **pause the session** with `member_ambiguous` or `member_gone`.

Rule 3 is deliberate and mirrors `healPairs`: two claude panes in one directory are two colleagues,
and guessing between them would put one agent's work in the other's terminal. A wrong repair is much
worse than no repair, and an unattended loop makes it worse still.

## 6. Capture

### 6.1 When a turn ends

**A turn ends on any transition into an end state**, not on `done`. The browser already settled the
set: `TURN_END_STATES = ['idle', 'done', 'blocked']` and `endsTurn(status)` at
`web/src/state.js:328`, which `convReadTurnEnd` gates on.

The relay's poll loop today branches on `done` and `blocked` separately (`_poll_once`,
`relay/herdr_relay.py:857`) and has no notion of the set. This specification adds:

```python
# relay/pane_summary.py
TURN_END_STATES = ("idle", "done", "blocked")

def ends_turn(status: str) -> bool:
    return status in TURN_END_STATES
```

held to parity with the JS by a test (§16, T2). **Capturing only `done` would silently lose every
turn that ends by going idle**, which for several harnesses is most of them.

A capture fires on `previous ∉ TURN_END_STATES` and `current ∈ TURN_END_STATES`. Repeated polls in
the same end state do not re-capture.

### 6.2 What is captured — `kind`

| `kind` | Meaning | Text is |
|---|---|---|
| `agent_final` | A participant's turn ended | The detected closing message |
| `agent_blocked` | A participant stopped to ask | The detected message plus the question at the pane's foot |
| `human_prompt` | Text sent to a pane | Exactly what was sent |
| `arbitrated` | A relay send from a decision | The rendered instruction |
| `decision` | The arbitrator's own decision, mirrored into the thread | `why` |
| `note` | A session lifecycle event worth reading in-line | Human-readable |

Detection reuses `summary_body` / `final_message` from `relay/pane_summary.py` — the port of the
browser's detector, held to line-range parity by `tests/test_summary_detect.js` and
`tests/test_pane_summary.py`. When detection finds nothing, `text` is empty, `range_*` are null and
`tail` carries the last lines of the pane. **A miss is visible in the row rather than silent.**

### 6.3 Who said it — `origin`

| `origin` | Meaning | How the relay knows |
|---|---|---|
| `agent` | A participant's own output | It read the pane after a transition it observed |
| `human_web` | A person, through this relay | It performed the send itself |
| `human_terminal` | A person, typing into the terminal | Detected as user input in the pane, author unknown |
| `arbitrator` | An automated send from a decision | It performed the send itself |
| `unknown` | Cannot be established | Everything else |

**N4 in practice: the relay must never claim to know which human typed into a terminal.** A prompt it
sent is `human_web` because it did it. An echo it finds in a pane is `human_terminal` at best. The
front end already carries the same honesty — `classifyVia` (`web/src/conversation_pure.js:415`) calls
an unmatched send `typed`, because provenance is only knowable where the send happened.

### 6.4 When it was said — `at` and `at_src`

A timestamp is only as good as its source. The browser grades this already:
`CONV_AT_RANK = {backfill: 0, read: 1, state: 2, sent: 3}` and `convAt` prefers `at` over `seen`,
because a backfilled scrollback entry stamped "now" sorts *after* the history it was prepended to.

The backend has better clocks and the same obligation:

| `at_src` | Accuracy | Source |
|---|---|---|
| `sent` | Exact | The relay performed the send |
| `poll` | Within one poll interval | An end-state transition the relay observed |
| `backfill` | Ordering only | Pane scrollback predating the session |

### 6.5 Ordering

**`ORDER BY at, seq`, always.** `at` is when it happened; `seq` is a monotonic per-session counter
assigned at insert, and it only ever breaks ties. Two members whose turns end inside one poll cycle
share an `at` and would otherwise order arbitrarily.

### 6.6 Per-agent logs in one table

The model is the front end's: each participant has its own timestamped messages, merged
chronologically for the joint view. One table does not flatten that — the fingerprint is on every
row, so the separation is a set of columns rather than a file:

```sql
-- one participant's own log, exactly what a separate file would hold
SELECT * FROM turns WHERE (host, agent, cwd) = (?, ?, ?)  ORDER BY at, seq;

-- the merged thread: a session's roster over its window
SELECT * FROM turns
 WHERE (host, agent, cwd) IN (…roster…) AND at >= ?       ORDER BY at, seq;
```

The browser splits into a record per member because IndexedDB cannot order across stores — the only
reason `mergeEntries` (`web/src/conversation_pure.js:536`) exists, walking each member's head and
taking the oldest. SQL orders for free, so per-agent tables would rewrite that merge in Python for
nothing, and would make "everything between decision 6 and 7, whoever said it" the awkward query
instead of the obvious one.

### 6.7 Caps

| Field | Cap | On overflow |
|---|---|---|
| `text` | 16 KB | Truncated, marked with a trailing `…` and `kind` unchanged |
| `tail` | 4 KB | Truncated from the front (the end of a pane is the interesting end) |
| rows in `turns` | 50 000 | Oldest `agent_final` rows pruned first; `decision` and `arbitrated` never pruned |

### 6.8 Relationship to the front end's store

They are **separate stores that are never synchronised**, joined only by fingerprint. The browser
keeps the rich thread (IndexedDB, `CONV_DB_STORE = 'transcripts'`); the relay keeps the ground truth.
No merge, no ownership question, no protocol between them. A person reading the app sees the FE
thread; a person or an arbitrator asking the relay sees the record.

### 6.9 Independent value

S0 is worth shipping with no automation attached:

- A conversation survives the browser being closed, which IndexedDB cannot promise.
- Telegram, the TUI and the mac app get summaries without each porting the detector.
- "What did these two agents do this afternoon" becomes a query.

## 7. Query surface

### 7.1 For the arbitrator — `relay/conv_query.py`

Read-only, opened as `sqlite3.connect("file:…?mode=ro", uri=True)`. No write path exists in the
module. Named in the arbitrator's starter prompt.

```
python3 relay/conv_query.py [selector …] [--format text|json]

selectors (combinable, AND-ed):
  --session <id>           a session's roster and window; resolves to fingerprints
  --member <member_id>     one member of that session
  --pane <pane_id>         one pane as currently observed
  --agent <kind>           one harness kind
  --cwd <path>             one working directory
  --last <n>               the most recent n (default 20, max 200)
  --grep <pattern>         case-insensitive substring over text
  --since <ms|sequence>    everything after a time, or after a decision sequence
  --kind <kind>            filter by kind
```

With no `--session`, it queries the global record — which is what makes it useful before any
arbitration exists.

Output, one turn per block:

```
[0041] 11:04:22  claude ~/code/herdr-remote  Architect 1  agent_final  (poll)
Implemented the mobile footer change. The composer now…
```

Caps: 200 entries or 64 KB per invocation, whichever comes first, with a truncation notice. The
arbitrator is told the caps in its starter prompt so a truncated answer is legible rather than
misleading.

### 7.2 For the app — `conv_log`

**Client → server**

```json
{"type": "conv_log", "pane": "%12", "last": 50, "grep": "footer"}
```

Accepts any of `session`, `member`, `pane`, `agent`, `cwd`, `last`, `grep`, `since`, `kind`, and
`fingerprints` — a list of `[host, agent, cwd]` triples, AND-ed against the rest as one OR group.

`fingerprints` is how the app asks for a **whole conversation roster in one query**, and it is the
selector the FE's live thread is built on: a member is pinned by fingerprint and not by a pane id,
which herdr changes on every restart (§5). Shape-checked and bounded at 16 triples by
`conv_query.fingerprints_from` — the *values* in a query are always parameterised, and that bound
is what keeps the *shape* of the `WHERE` clause off the wire too. An empty or malformed list is
`None`, meaning no fingerprint filter, rather than an empty `OR` group that would not parse.

**The app reads it as a second source for the same view.** `web/src/conv_live.js` turns the answer
into the entries the conversation thread already renders, and a toggle beside the hanging ⟳
decides which record is behind the bubbles: this browser's transcript, folded out of pane reads and
therefore only as complete as its connection was, or the relay's record, which is written for every
pane whether anyone was watching or not. Nothing on that path writes — the toggle changes what is
drawn, never what is stored — which is what makes it safe to flip while reading, and what makes it
the cheapest way to see the ground truth an arbitrator would be deciding on.

**Server → client**, answered to the asking client only and never broadcast, because it is the
message that carries agent prose:

```json
{"type": "conv_log", "truncated": false,
 "turns": [{"seq": 41, "pane_id": "%12", "host": "local", "agent": "claude",
            "cwd": "/Users/…/herdr-remote", "label": "Architect 1", "project": "herdr-remote",
            "kind": "agent_final", "origin": "agent", "text": "…", "tail": "",
            "at": 1755423862000, "at_src": "poll",
            "range": [412, 430], "decision_id": null}]}
```

Same caps as §7.1. Requires the relay's normal token; not gated on `HERDR_ENABLE_ARBITER`, because
reading the record is useful without arbitration.

---

# Part II — Arbitration

## 8. Actors

| Actor | Reads prose | Interprets it | Emits |
|---|---|---|---|
| `pane_summary.py` | Yes | **No** — counts gutter characters, returns a line range | Line numbers |
| Relay, building a prompt | Passes it through | **No** | The arbitrator's prompt |
| **Arbitrator agent** | **Yes** | **Yes — this is the job** | A decision record |
| Relay, executing | Never re-reads it | **No** | A send to `to` |

Banned:

```python
if "looks good" in summary_text:
    advance_gate()            # a sentence fragment moved the loop
```

Intended:

```python
prompt = render_prompt(scope, roster, entry, gates, budget)
send_text(arbitrator_pane, prompt, submit=True)
# …on the arbitrator's own turn end:
decision = validate(read_dropbox(path), session)     # gate ∈ gates, to ∈ roster, target not working
send_text(resolve(decision["to"]), render(gate, decision["instruction"]), submit=True)
```

## 9. Session lifecycle

### 9.1 States

| State | Meaning |
|---|---|
| `active` | Triggers armed, decisions executed |
| `awaiting` | A prompt has been sent; waiting for the arbitrator's turn to end |
| `paused` | Nothing fires. `pause_reason` says why. Resumable |
| `ended` | Terminal. `ended_reason` says why |

```
            start
              │
              ▼
          ┌ active ┐◄──────────── resume ──────────┐
          │        │                               │
     trigger       └── budget spent ──► paused ────┘
          │                              ▲
          ▼                              │
       awaiting ── invalid ×2 ───────────┤
          │                              │
          └── valid ──► execute ─────────┘
                          │
                    cancel / scope done
                          ▼
                        ended
```

### 9.2 Start preconditions

All must hold, checked in this order, each with its own error:

1. `HERDR_ENABLE_ARBITER=1` **and** `HERDR_ENABLE_WRITE_EXT=1` **and** `HERDR_CONV_LOG=1`.
2. No other session is running — `active` **or** `awaiting`.
3. Exactly **two** members are enrolled (v1, §14.1), plus one arbitrator, all distinct panes.
3b. Every participant resolves to the same `project_id`. A pane with a project and a pane without
   one are two different answers and refused as such. With no Projects configured nothing carries
   one and this cannot refuse anything — an arbitrator reading agents in an unrelated checkout is
   deciding about work it cannot see, and there is no such thing to detect when the relay has not
   been told what a project is.
4. Every member and the arbitrator resolve to exactly one live pane by fingerprint.
5. All participants are on `host = 'local'` (v1, D13).
6. `scope` is non-empty and ≤ 4 000 characters.
7. Every gate name in the session is in the configured gate set.
8. Budgets are within their maxima (§13.1).

### 9.3 Pause reasons

| `pause_reason` | Cause | Resumable by |
|---|---|---|
| `user` | Someone pressed Pause | Resume |
| `budget_steps` | `steps_used ≥ max_steps` | Resume, after the person raises the budget |
| `budget_consecutive` | `consecutive ≥ max_consecutive` | Any human message into the conversation clears `consecutive`; then Resume |
| `budget_time` | Wall clock exceeded | Resume with a new window |
| `member_blocked` | A member reached `blocked` | Resume once it is unblocked — the existing approval UI already owns answering it |
| `member_gone` | A member's fingerprint matches no live pane | Re-enrol, then Resume |
| `member_ambiguous` | A member's fingerprint matches more than one | Disambiguate by hand, then Resume |
| `arbitrator_gone` | The arbitrator pane vanished | Re-point, then Resume |
| `invalid_record` | Two consecutive invalid decisions | Resume; the sequence is retried |
| `send_unconfirmed` | A delivery `submit_paste` could not prove landed (§13.2 step 3) | Read the pane, then Resume |
| `call_human` | The arbitrator chose the `call_human` gate | Resume, or Cancel to end the session |
| `restart` | The relay restarted while the session was running (§9.4) | Resume, after reading the last send |

Every pause sends a Web Push through the relay's existing `send_web_push`, so an unattended loop that
stops is not discovered hours later.

### 9.4 Restart recovery

On boot with an `active` or `awaiting` session, the relay **does not resume automatically**. It moves
the session to `paused` with `pause_reason = 'restart'` and reports the last decision and last send.
Rationale, taken directly from the orchestrator branch: the relay cannot promise exactly-once
delivery to a terminal, and re-sending a phase's instructions twice is worse than stopping.

## 10. Triggers

| Trigger | Fires when | Default |
|---|---|---|
| `turn_end` | A **member** transitions into an end state | On |
| `idle` | A member has been in an end state for `idle_ms` with no send to it | Off (`0`) |
| `runtime` | A member has been `working` for `runtime_ms` | Off (`0`) |

Only members trigger. The arbitrator's own turn end is not a trigger — it is the signal to read the
drop-box (§12.1).

While a session is `awaiting`, further triggers are **coalesced, not queued**: the fact that another
member also finished is folded into the next prompt's roster, rather than producing a second prompt.
One prompt outstanding at a time.

Clocks are evaluated in the existing poll loop. No new timer thread.

## 11. The arbitrator's prompts

### 11.1 Two parts

The arbitrator is an ordinary agent pane configured by prose. It receives:

- **A fixed starter prompt, once**, when the session starts — what it is, the decision schema, where
  to write, how to query, and the rule that only the file is read.
- **Only the changing context, per trigger** — the roster with live statuses, what fired, the entry
  itself, human input since the last decision, allowed gates, remaining budget, and the path for this
  sequence.

Splitting them keeps the per-trigger prompt short enough to stay legible in a pane and cheap enough
to send on every turn.

### 11.2 Starter prompt (normative content)

```
You are the arbitrator for a conversation between two agents.

Scope, from the person who started this session:
<scope>

Your job, once per trigger: read what just happened, decide the next step, and
write one decision record. You choose the recipient and the words they receive.

Recipients are the members listed in each trigger message, addressed by member id.
The member that just finished is a valid recipient — sending work back to its
author is an ordinary outcome.

Every trigger message lists the roster, one line each:

  <member id>  <label> / <roles> / <agent> / <status>

The label is the name the turns quoted below it are headed with.

Roles are what the person running this session wants that member to do —
"review only", "no code writing", "minimal focused test", and whatever else
they wrote. Read them as instructions about that member, not as a job title. They are the
person's instruction about who does what, so choose the member whose roles cover
the step you decided on. Roles may overlap: when more than one member fits, prefer
the one that is not already working. A member shown as `-` has no role and is
available for anything. A role is never a permission — it does not stop you
addressing a member, it tells you who was meant to do this.

Gates: <gate names, with one line each>

Write exactly one JSON object to the path named in the trigger message. Fields:
  session_id           string, copy from the trigger
  sequence             integer, copy from the trigger
  gate                 one of the gates listed
  to                   a member id from the roster
  instruction          the words that member will receive (max 4000 characters)
  why                  one short paragraph, for the person reading the thread
  ambiguity            low | medium | high — does this turn leave the next step underdetermined
  decision_complexity  low | medium | high — is this beyond what should be auto-continued

For gate call_human, omit `to` and `instruction` entirely; `why` is still required,
and it is what the person will read. call_human pauses the session — the person
decides whether to resume it or end it.

Nothing else in your pane is read. Your reasoning, your tool calls and your prose
are ignored by the relay. Only the file counts.

To look further back than the trigger message shows:
  python3 <path>/conv_query.py --session <id> --grep "<text>"
  python3 <path>/conv_query.py --session <id> --member member-2 --last 20
  python3 <path>/conv_query.py --session <id> --since <sequence>
Read-only. Returns at most 200 entries or 64 KB, and says so when it truncates.
Your own past decisions are in there too.

Choose call_human when ambiguity or decision complexity is high, when the scope
does not cover what just happened, or when you would be guessing.
```

### 11.3 Trigger prompt (shape)

```
Roster:
  member-1  Architect 1 / plans the next phase, review only / claude / idle
  member-2  Reviewer 1  / writes the code                    / codex  / working

Trigger: turn_end — member-1 (working → idle)

[member-1 · Architect] 11:04:22
Implemented the mobile footer change. The composer now sits above the safe area…

[human · web] 11:05:01
Keep the footer compact.

Allowed gates: implement, review, phase_plan, call_human
Budget: 7 steps left, 3 consecutive left, 44 minutes left
Sequence: 7

Write your decision to:
  ~/Library/Logs/herdr-remote/arbitration/<session>/0007-decision.json
```

The digest shows the triggering entry in full plus the last `N` entries in brief (default 6). Every
prompt body is stored in `prompts` and copied to `NNNN-prompt.txt`, so a decision can always be read
against exactly what the arbitrator saw.

Note `member-2  … working` in the roster: the arbitrator is told the live status of every member so
it can avoid naming one that cannot be written to, rather than discovering it by rejection.

The label comes first because it is the name the entries below are headed with — `[member-1 ·
Architect 1]` — and the roster line is the only thing that links the two. The roles follow it, and
they are never used as a name: several members may carry the same role (§14.3), so heading a turn
with one would put two agents' words under a single speaker.

## 12. The decision record

### 12.1 Protocol

1. Relay writes nothing to the drop-box path; the file must not exist beforehand.
2. Relay sends the trigger prompt, records it, moves the session to `awaiting`.
3. Arbitrator writes `NNNN-decision.json` and finishes its turn.
4. On the arbitrator's transition into an end state, the relay reads that exact path — **the path it
   already knew.** The arbitrator never tells the relay where to look.
5. Missing file, unparseable JSON, or failed validation → **one** re-prompt naming the failure. The
   relay then waits for the file's **SHA-256 to change**, not for another end state, because an agent
   that answers instantly would otherwise be read before it wrote.
6. A second failure pauses the session with `invalid_record`.

The hash, not `(mtime, size)`: a corrected record is very often the same length as the one it
replaces — one enum swapped, one member id changed — and filesystem timestamp granularity is not
fine enough to rely on either. A content hash is the only comparison that cannot say "unchanged"
about a file whose contents changed. `decisions.raw_sha256` stores it.

### 12.2 Shape

```json
{
  "session_id": "s-20260817-1103",
  "sequence": 7,
  "gate": "review",
  "to": "member-2",
  "instruction": "Review the footer change for mobile layout regressions.",
  "why": "The implementation is ready for an independent check.",
  "ambiguity": "low",
  "decision_complexity": "low"
}
```

**There is no `stop` field.** An arbitrator that wants the loop to end chooses `call_human`, which
pauses; the person then resumes or cancels. Two ways to say "send nothing" would differ only in
whether a human could restart the loop afterwards — which is the person's call, not the arbitrator's.
One no-send outcome, and the human owns ending.

### 12.3 Validation

The required shape is **conditional on the gate**:

| Gate | `to` | `instruction` | `why` |
|---|---|---|---|
| An action gate (`implement`, `review`, `phase_plan`, …) | Required | Required, non-empty | Required |
| `call_human` | Must be absent | Must be absent | Required |

`why` is required everywhere: a decision the person cannot read the reason for is not reviewable, and
`call_human` without a reason is the least useful message the system can produce.

Checked in order; the first failure is the `reject_code`.

| Code | Rule |
|---|---|
| `unparseable` | Valid UTF-8 JSON object, ≤ 64 KB |
| `unknown_field` | No field outside the schema. Unknown fields are **rejected, not ignored** |
| `session_mismatch` | `session_id` equals the running session |
| `sequence_mismatch` | `sequence` equals the sequence that was asked for |
| `unknown_gate` | `gate` is in this session's gate list |
| `why_missing` | `why` is non-empty after stripping, ≤ 2 000 characters |
| `field_not_allowed` | `call_human` carries a `to` or an `instruction` |
| `field_required` | An action gate is missing `to` or `instruction` |
| `unknown_member` | `to` is a `member_id` on the roster |
| `target_not_live` | `to` resolves to exactly one live pane (§5.2) |
| `target_working` | The target's status is not `working` (N7) |
| `instruction_empty` | `instruction` is non-empty after stripping |
| `instruction_too_long` | ≤ 4 000 characters — the relay's existing `send_text` bound |
| `instruction_control_chars` | No control characters except `\n` and `\t` |
| `bad_enum` | `ambiguity` and `decision_complexity` ∈ {low, medium, high} |

**A decision naming a working member is rejected, never queued.** By the time that member finishes,
its state and the reason for the decision have both moved; delivering a stale instruction is worse
than delivering none. The re-prompt carries the current roster, and the arbitrator picks another
target or `call_human`.

## 13. Execution

### 13.1 Budgets

| Budget | Default | Max | Counts |
|---|---|---|---|
| `max_steps` | 8 | 50 | Every send |
| `max_consecutive` | 3 | 20 | Sends since a human last put text into the conversation |
| `max_wall_clock` | 45 min | 8 h | Since `created_at`, or since the last resume |

Conservative on purpose: raised only on evidence from real sessions. `consecutive` resets to zero on
any `human_web` or `human_terminal` entry — a person touching the conversation is what "not
consecutive" means.

### 13.2 Steps

On a valid decision that is not `call_human`:

1. Re-resolve `to` (§5.2). Changed since validation → treat as `target_not_live` and re-prompt.
2. Render the gate's template around `instruction` (§14.2).
3. `submit_paste(pane_id, text, …)` — delivers the bracketed paste and confirms against the
   destination pane's `agent_status` rather than bare `pane run`, preventing Enter from being
   swallowed while the destination TUI renders the payload (see 6d34544).
4. In one transaction: insert `sends`, insert a `turns` row with `kind='arbitrated'`,
   `origin='arbitrator'`, `at_src='sent'` and `decision_id`, increment `steps_used` and
   `consecutive`.

   An **unconfirmed** delivery splits that four ways rather than skipping it. `submit_paste`
   returning `False` means *not proven*, not *not delivered* — its commonest `False` is a pane
   already `working`, where the text almost certainly landed and queued. So the `turns` row is
   written (N8: an automated send is visible in the thread, and an unproven one is the one a person
   most needs to go and look at), `sends` is **not** (that table is the deliveries the relay stands
   behind, and a row there turns a maybe into a yes), no budget moves (a budget counts what
   certainly happened), and the session pauses with `send_unconfirmed`.
5. `audit("arbitrated_send", …)` through the relay's existing JSONL audit log.
6. Broadcast `arb_session` (§15.2).
7. Session returns to `active`.

The send happens **before** the transaction commits only in the sense that herdr is not
transactional: if the relay dies between step 3 and step 4, the send happened and the row is missing.
Recovery (§9.4) therefore pauses rather than replays, and the person is shown the last send.

### 13.3 `call_human`

No send. The decision is recorded, a `turns` row with `kind='decision'` carries `why` into the
thread, the session pauses with `pause_reason = 'call_human'`, and a push goes out. The person
resumes it or cancels it; the arbitrator has no way to end a session itself.

## 14. Configuration

### 14.1 Session size

v1 arbitrates **exactly two members** — three panes including the arbitrator. Which two may change
while the session runs (`arb_edit`, §14.7); how many may not. The store, schema and
prompt are written for N because writing them for two costs the same and closes the door; the
*session* is what refuses more, until a two-member loop has been watched running for real.

Membership comes from the front end. Which panes are in a conversation is already the person's
choice; the session enrols that roster. **The relay never picks participants.**

### 14.2 Gates

A gate is a name and an instruction template. Configured as JSON at `HERDR_ARBITER_GATES`, defaulting
to the CRFN set:

```json
[
  {"name": "implement",
   "template": "{instruction}"},
  {"name": "review",
   "template": "Please review the work described above.\n\n{instruction}"},
  {"name": "phase_plan",
   "template": "Before continuing, write the plan for the next phase.\n\n{instruction}"},
  {"name": "call_human", "template": ""}
]
```

`{instruction}` is the only substitution. A template is a fixed host-owned string; the arbitrator
supplies prose, never a template. A gate set is data — a different use case ships a different file
with no code change, which is the extensibility line this design defends.

### 14.3 Roles

Each member carries **roles**: the person's own words for what that member is there to do, written
when the roster is chosen and editable with it. A comma-joined line of short phrases — `review
only`, `no code writing`, `minimal focused test` — at most 6 of them, each at most 48 characters.

Phrases and not slugs, because the arbitrator acts on them: `#no-code` is a tag a reader has to
decode before it means anything, and "no code writing" is already the instruction. The front end
offers them as badges whose label is the tag and whose value is the phrase, so the tapping is short
and what lands on the wire is the sentence.

The relay normalises what it is given and refuses the rest: whitespace collapsed, a leading `#`
dropped, non-printing characters stripped — this text is typed into a terminal — repeats removed
case-insensitively, and both caps enforced. Case is otherwise the person's and is kept. The roster
is the one part of a trigger message the arbitrator is told to read as fact, so a pasted paragraph
in it is a person's instruction forged by a stale client.

**The vocabulary is open.** There is no allowlist and no host-owned set: a documentation session
wants `writes the release notes`, and shipping a config file to say so is the extensibility this
design refuses everywhere else. Only the shape is checked.

**Roles may overlap.** Two members that both carry `review only` is the intended case — it is what
lets the arbitrator keep the loop moving when one of them is working, and it is why roles are not a
partition of the work.

A role is **not a name.** `to` is always a member id. The roster line is the only thing that maps
one to the other, which is why it carries label, roles, agent and status together and why it is
repeated in full in every trigger message rather than remembered.

A role is **not a permission**. It never stops the arbitrator addressing a member; it tells it who
the person meant to do this. §11.2 says so in those words, and §11.3's roster line carries it.

**Roles change with the roster** (§14.7 `arb_edit`), under the same preconditions and the same
announcement — a role-only edit is refused while a decision is outstanding, exactly as a swap is.
The announcement says *which* of the two changed: a pane that moved invalidates what the arbitrator
remembers about a member id, and a role that changed does not.

### 14.4 Sessions are independent

Several sessions run at once, one per conversation. Each has its own roster, arbitrator, scope,
gates, budget, triggers and drop directory, and nothing is shared between them — so a second one
running is not a reason the first cannot proceed. `start` and `resume` refuse neither.

**No pane is in two sessions.** This is the one exclusivity that matters and it is checked at
enrolment (`participant_in_session`): two arbitrators typing into one terminal, each deciding
against half of what it said, is unrecoverable once it has happened and a refusal before it is
cheap. It covers arbitrators as well as members — an arbitrator is not lent out.

What this replaced was a unique index allowing exactly one `active`/`awaiting` session. It is
dropped, not merely unused: it was guarding the wrong thing. Two sessions over different panes were
never a problem; two sessions over the *same* pane always were.

Consequences the loop has to honour, all of them in §12.1's path:

* a turn end is offered to the session that pane is in, found by lookup rather than search;
* the digest an arbitrator is shown is its own session's, never "the running one"'s;
* the clocks in §10 are evaluated per session, over one `_since` map keyed by pane — sound
  precisely because no pane is in two sessions;
* the roster lock is per session, so one arbitrator taking eight seconds to confirm a send does
  not hold up another session's roster edit.

### 14.5 Starting paused

A session may open `paused` with reason `not_started`. The starter prompt goes out either way —
being briefed is what makes an agent an arbitrator — and `paused` decides only whether the loop
behind it is armed. "Initialised" and "started" are two different things, and a person assembling a
room wants the first: appoint the arbitrator, put the members in, then say go.

### 14.6 Re-briefing

A long session pushes the starter prompt out of the arbitrator's context. What that looks like from
outside is prose written into its own pane where a decision record should be — `invalid_record`
twice and a pause whose reason is true and useless. Nothing about the session is wrong, so nothing
about it should have to be restarted.

`arb_reinit` (§15.1) clears the arbitrator's pane and sends the **same** starter prompt the session
opened with: same scope, same gates, same query path. Nothing else moves — not the roster, not the
budget, not the sequence — because nothing was decided.

Refused while a decision is outstanding, for the reason a roster edit is: the prompt naming that
sequence would be cleared out from under the answer, and no record would ever reach a drop box the
session is still waiting on. Refused at a busy arbitrator (N7), because the keystroke that empties
a context is the worst one to half-deliver. Pause first, in both cases.

The clear command is `/clear`, which Claude Code and Codex both take. A harness that does not gets
a line it does not understand and an unchanged context — the same place a person who never pressed
the button is in, so the failure is quiet by construction. The re-brief that follows is confirmed
like any other send, and an unconfirmed one pauses the session.

### 14.7 Environment

| Variable | Purpose |
|---|---|
| `HERDR_CONV_LOG` | `1` enables backend recording. Unset = no rows, wire unchanged |
| `HERDR_ENABLE_ARBITER` | `1` enables sessions. Also requires `HERDR_ENABLE_WRITE_EXT` and `HERDR_CONV_LOG` |
| `HERDR_ARBITER_GATES` | Absolute path to a gate-set JSON. Unset = the CRFN default above |
| `HERDR_ARBITER_DB` | Override the database path. Default `$LOG_DIR/arbitration.sqlite3` |
| `HERDR_CONV_LOG_MAX` | Entries kept per session before pruning. Default 20 000 |

### 14.7 Editing a running session

Everything a person answered when the session opened can be answered again: the scope, which two
panes are being arbitrated, what each of them is for, which pane decides, and the clocks. One
message (`arb_edit`, §15.1) carrying only the fields that moved — a field that is not named is not
touched, so a scope edit does not re-announce a roster nobody changed.

The preconditions are the roster edit's, because they are the same hazard: refused while a decision
is outstanding (N6 — a roster the arbitrator is currently deciding against is one it would be
answering about panes that no longer exist), refused when a named pane is enrolled in another
session (`participant_in_session`), refused at a busy arbitrator (N7), refused when the three do
not share a project (`project_mismatch`).

What the session tells its participants depends on what moved:

* **members or roles** — the roster announcement of §11.3, which says *which* of the two changed: a
  pane that moved invalidates what the arbitrator remembers about a member id, a role that changed
  does not. A scope changed in the same message is announced with it, in one send rather than two.
* **the arbitrator** — the *opening* brief, not an announcement: a pane that has never been briefed
  cannot be told the roster changed, because it does not know there was one. The new pane is
  cleared and given the same starter prompt the session opened with, carrying the current scope and
  the current roster. This is `arb_reinit` (§14.6) pointed at a different pane, and it is the same
  code path.
* **the clocks alone** — nothing is sent. A trigger is the loop's business and not the
  arbitrator's.

The front end asks all of it through the dialog that appointed the session (§15.3), so the
questions and their answers have one shape and one place to disagree.

### 14.8 Resuming

A paused session is armed by `arb_resume`. Armed is all that is: the loop waits for a trigger, and
with two idle members and both clocks off (§10, their default) there is no trigger coming — a
session that reads as running and never acts.

So there are two ways back, and the person picks:

* **Resume** — arm it and wait. Right after a pause a person took to type at a member themselves:
  that member's turn will end, and that is the trigger.
* **Resume and trigger** (`kick: true`) — arm it and ask for a decision now. The prompt is the
  ordinary trigger prompt of §11.3, over the turns since the session last looked, with one extra
  line under `Trigger:` saying what stopped it and that a person has started it again. Refused at a
  busy arbitrator (N7); plain Resume is not, because it writes nothing.

Both refuse an arbitrator whose pane is gone (`arbitrator_gone`) — a session armed over a dead
arbitrator is one that spends its next trigger discovering that.

The note matters because the reasons read differently to something that has forgotten the last few
minutes. `send_unconfirmed` says the send may or may not have landed and to look before repeating
it; `call_human` says a person was asked and has answered; `restart` says the relay went down and
nothing was decided while it was.

### 14.9 The path

`decisions` records what was decided. Nothing recorded what happened *between* two decisions — the
prompt going out, the drop box being read and found empty, the instruction typed at a member, the
trigger that arrived while the session was paused. A session that stopped halfway showed a state
and a reason and no way to see which step it stopped on, which is the question a stopped session
actually raises.

The `events` table is that path: `session_id`, `sequence`, `kind`, a sentence of `detail`, and
`at`. One row per step, written by every method that takes one.

| Kind | Written when |
|---|---|
| `started` / `ended` | The session opened, and the reason it closed |
| `briefed` | A pane was given the opening brief — a start, a `reinit`, or an arbitrator swapped in |
| `trigger` | A member ended a turn. Including when nothing was asked because of it: a decision was already outstanding, or the session is paused |
| `asked` | A prompt went to the arbitrator — which decision, which trigger, how long |
| `waiting` | The drop box was read and there was nothing in it |
| `record` | A decision file arrived, and its size |
| `decided` / `rejected` | It validated, or it did not and why |
| `reprompt` | The arbitrator was asked to correct the same file |
| `sent` | An instruction was typed at a member: which gate, which member, which pane, how long |
| `paused` / `resumed` | Every stop and every start again, with the reason and which kind of resume |
| `edited` | A running session changed: roster, roles, arbitrator, scope or clocks |
| `error` | A delivery that raised, a drop box that could not be read |

Two rules keep it readable:

* **Written, never read.** `detail` is a sentence for a person. Nothing in the loop parses it, and
  no control flow depends on any of it (N1).
* **Never fatal, and never per poll.** Recording is best-effort — a full disk must not turn a
  working send into a paused session — and the steps a poll loop reaches repeatedly (`waiting`, a
  trigger arriving at a stopped session) are written once per sequence. At four polls a minute the
  path would otherwise be nothing but the step that is not moving.

## 15. Wire protocol

Additive. With `HERDR_ENABLE_ARBITER` unset, none of these are sent or accepted.

### 15.1 Client → server

| Type | Payload | Gate |
|---|---|---|
| `conv_log` | `session`, optional `member`, `fingerprints`, `last`, `grep`, `since`, `kind` | `HERDR_CONV_LOG` |
| `arb_start` | `conversation`, `members[]` (2, each `pane_id` + `role?`), `arbitrator`, `scope`, `gates?`, `budget?`, `triggers?`, `paused?` | Arbiter |
| `arb_edit` | `session`, and any of `scope`, `members[]` (2, each `pane_id` + `role?`), `arbitrator`, `triggers` — what is not named does not move | Arbiter |
| `arb_members` | `session`, `members[]` (2, each `pane_id` + `role?`) — the roster half of `arb_edit`, kept for clients that only ever ask for that | Arbiter |
| `arb_reinit` | `session` | Arbiter |
| `arb_pause` | `session` | Arbiter |
| `arb_resume` | `session`, `kick?` — `true` asks for a decision now rather than waiting for the next trigger | Arbiter |
| `arb_cancel` | `session`, `reason?` | Arbiter |
| `arb_detail` | `session` | Arbiter |

The relay assigns `session_id`; a client never names one. Same rule the orchestrator branch used, for
the same reason: every path is derived from it.

### 15.2 Server → client

| Type | When | Delivery |
|---|---|---|
| `arb_sessions` | After the snapshot, unsolicited | Broadcast — its presence is the client's arbitration gate, the way `start_options` gates Start. Carries **every unfinished session**, newest first, not only the running one: paused sessions accumulate (§9.3) and a client that saw only the newest would lose the Resume control for the rest |
| `arb_session` | Any session state change | Broadcast |
| `arb_detail` | Answering `arb_detail` | To the asking client only — it carries prose. Two lists: `decisions` (what was decided) and `events` (§14.9, where the session got to). A relay too old to send `events` is not a session that did nothing, so its absence and an empty list are different things to the client |
| `conv_log` | Answering `conv_log` | To the asking client only |

`arb_session` payload:

```json
{"type": "arb_session", "session": {
  "id": "s-20260817-1103", "state": "active", "pause_reason": null,
  "conversation": "c-…", "scope": "…",
  "members": [{"id": "member-1", "label": "Architect 1", "agent": "claude",
               "role": "Architect", "pane_id": "…", "status": "idle"}],
  "arbitrator": {"pane_id": "…", "label": "Arbitrator", "status": "idle"},
  "budget": {"steps_left": 7, "consecutive_left": 3, "minutes_left": 44},
  "triggers": {"on_turn_end": true, "idle_ms": 0, "runtime_ms": 0},
  "last_decision": {"sequence": 7, "gate": "review", "to": "member-2",
                    "why": "…", "ambiguity": "low", "at": 1755423862000}
}}
```

### 15.3 Front end

No second product. The existing conversation thread, plus:

- A **session strip** above the thread — **only while this conversation has a session**, and
  **one line**: state, which of the three panes is active right now and what it is doing, the
  budget, and the controls — `Log`, `Edit`, the bubbles toggle, Pause or Resume, `↻ Brief`, `End`.
  A conversation nobody is arbitrating draws nothing above its messages; the way in is the ⚖ in
  the thread's controls, which costs no height.
  - **Which of the three is active** is a fact, not a guess: `awaiting` means the arbitrator is
    reading, and otherwise it is whichever member is `working` — or `blocked`, which is called out
    wherever it is, because from a strip a permission prompt nobody is looking at is
    indistinguishable from thinking. The button opens that pane.
  - The last decision's sentence used to live here. It wrapped to three lines on a phone and
    pushed the thread down by all of them, and it answers a question the log answers better.
- **The path in the thread** (§14.9), when the arbitrator is shown: each step drawn in the shape
  the commit strip and the decision rail already use — a small thing that happened at this point,
  read past unless it is the line being looked for. `error`, `rejected` and `paused` are drawn in
  the colour the thread already uses for the part that went wrong. `decided` is left out: the
  decision bubble beneath it says the same gate, the same member and the same why.
- Arbitrated messages rendered as ordinary entries with a badge. The thread already renders
  provenance per entry (`via`: `typed` / `transfer` / `mixed`), so `arbitrator` is a fourth value and
  a badge, not a new view.
- A decision detail sheet, opened by `Log`: the whole path at the top, then per decision the
  record, the prompt that produced it, and the send.
- A start dialog, opened by ⚖ and dismissed by a tap outside it: the scope, then one section each
  for the arbitrator and the two members it decides between — a pane for each, the roles for the
  two, and whether the loop is armed on start or only briefed. The clocks of §10 are folded away,
  because both are `Never` until somebody goes looking for them.
- Every list in that dialog leaves out what the relay would refuse: a pane already enrolled in
  another unfinished session, a paused one included — `participant_in_session` is checked against
  `open_sessions()`, and a pause is not a release. The roster picker of a *running* session
  excludes that session from the check, because its own members are the answer to the question it
  is asking. Which project the roster must share is read off the **two members picked**, never off
  the conversation around them: the relay refuses `project_mismatch` over participants and asks
  nothing about anyone else.
- The **same dialog edits a running session**, opened from the roster on the strip and prefilled
  with what that session already says: scope, both panes, both roles, the arbitrator and the
  clocks. Only what the person moved is sent (§14.7). The arming choice is not shown — a running
  session has been armed or not already, and Pause and Resume on the strip are where that changes.
- A paused session's strip offers **both ways back** (§14.8): `Resume`, and `Resume and trigger`
  for the case where nothing is going to end a turn on its own.
- ⚖ over a thread has two states and no third: lit, it opens the arbitrator's own pane; plain, it
  opens that dialog. It never reaches a session belonging to another conversation.
- Each of the three slots can **start its own agent**, through the New agent dialog. The new pane
  is chosen in the slot that asked for it and nothing is opened — the dialog behind is half filled
  in, and a terminal on screen is that work thrown away. A member joins the conversation; the
  arbitrator does not, and is started with no opening prompt of its own, because the session's
  brief is the only thing that tells it what it is. This is also the whole of "start from scratch":
  three slots, three taps, and `Brief only` so the loop waits for the room to be ready.

## 16. Test plan

| ID | Level | Asserts |
|---|---|---|
| **T1** | Python unit | Schema creation, insert, ordering by `(at, seq)`, per-fingerprint filter, caps, pruning |
| **T1b** | Python unit | **`turns` is global.** Rows are written and read with no session in existence, and a session's view is a fingerprint-and-window query over the same rows — no second copy |
| **T2** | Parity | `ends_turn()` and `TURN_END_STATES` agree with `web/src/state.js` — the same list, asserted from both sides, as `test_summary_detect.js` / `test_pane_summary.py` already do for the detector |
| **T3** | Python unit | Capture fires on every `→ end state` transition and not on repeats; `idle` is captured, not only `done` |
| **T4** | Python unit | `origin` is never inferred: a pane echo yields `human_terminal`/`unknown`, only a relay send yields `human_web` |
| **T5** | Python unit | **N1 guard.** Feed the executor entries containing `accepted`, `LGTM`, `approved`, `ship it` with no valid decision record. Assert: no send, no state change, no budget movement |
| **T6** | Python unit | Every `reject_code` in §12.3, one case each, including `unknown_field` and `target_working` |
| **T7** | Python unit | Re-prompt happens once; the second failure pauses with `invalid_record`; the wait is on the SHA-256 changing, not on a second end state — including a corrected record of identical length |
| **T7b** | Python unit | Two sessions cannot run at once, including while the first is `awaiting` |
| **T8** | Python unit | Budget arithmetic: steps, consecutive reset on human entry, wall clock; each exhaustion pauses with its own reason |
| **T9** | Python unit | Roster: fingerprint re-resolution adopts a single match, pauses on zero, pauses on two |
| **T10** | Python unit | Restart recovery pauses rather than resuming; no replayed send |
| **T11** | `conv_query` | Read-only handle refuses writes; caps and the truncation notice; `--grep`, `--since`, `--member` |
| **T12** | e2e (fake herdr) | A full two-member loop: turn end → prompt → drop-box → validated → send → recorded → budget spent → pause |
| **T13** | e2e | A decision naming a working member is rejected and re-prompted, and nothing is sent |
| **T14** | Playwright | Session strip renders, arbitrated badge appears on the right entry, Pause stops the loop |
| **T15** | Playwright | With `HERDR_ENABLE_ARBITER` unset the app shows no arbitration surface at all |
| **T17** | Python unit | The path: a whole turn reads back as `asked → record → decided → sent`; a rejection, a pause, a resume and an edit each leave their step; a send that raised names the step it raised on; `waiting` is written once per sequence and not once per poll |
| **T18** | Playwright | The steps land among the messages, the failed one is marked, and `Log` holds all of them |

## 17. What was taken from the orchestrator branch, and what was not

**Taken — four ideas, no code:**

| Idea | Where it lands here |
|---|---|
| No decision inferred from prose | N1, T5 |
| A record protocol earns trust with a validator | §12.3, bounded re-prompt |
| `done` is a wake-up, not a result | N3, §6.1 |
| Prompt text is data; argv, cwd and scopes are not | N5, §14.2 |

**Left behind:** phases and phase templates, creator/reviewer slots and slot swapping, fix-cycle
counters, required-check runners, working-tree drift detection, `run.md` rendering, per-project run
constraints, the observer. If a lifecycle engine is wanted later it can sit *above* this; the
arbitrator does not need it to be useful.

**Changed on purpose:** state lives under the relay's log directory rather than a project's
`.herdr/runs/`, which drops the git-ignore precondition entirely and unties a session from one
repository.

## 18. Open questions

- **D12 — Retention.** How long entries and decisions are kept, and whether the app's Activity
  storage view grows a backend row. Not a blocker for S0; §6.7 gives a cap, a time-based policy can
  follow.
- **D13 — Remote hosts.** The drop-box is a local file, so v1 is local-only (§9.2, rule 5). Whether
  remote members are worth an SSH read, or whether the arbitrator must be co-located with them,
  stays undecided.

## 19. Failure modes, named

| Failure | What happens | Why it is acceptable |
|---|---|---|
| The arbitrator judges badly | Budgets bound it, `why` is visible, Pause is one control | It is a judgement product; it cannot be validated into correctness |
| Summary detection misses | `text` empty, `tail` populated, visible in the row | A miss is legible rather than silent |
| A pane restarts mid-session | Fingerprint adopts a single match, pauses on ambiguity | A wrong repair is worse than no repair |
| Relay dies between send and commit | Recovery pauses and shows the last send | Terminals are not exactly-once; stopping beats double-sending |
| Two turns end in one poll | `seq` breaks the tie deterministically | Ordering is what the record claims |
| Gates accrete into phases | Nothing automatic — this is a review discipline | Named here so it is caught in review, not in six months |
