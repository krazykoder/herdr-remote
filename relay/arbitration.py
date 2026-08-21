#!/usr/bin/env python3
"""The loop that runs a session: who is addressable, what may still be spent, and what gets sent.

S2 of the spec. `arbitrator.py` decides whether a record is acceptable; this decides what happens
around it — enrolling a roster, re-resolving panes that moved, spending budget, reading the
drop-box, and delivering exactly one rendered instruction to exactly one pane.

  .workflow/03_specs/2026-08-17_arbitrator_spec.md §9, §12.1, §13

Two rules shape the whole file.

**Nothing here reads prose.** The only text this module inspects is JSON it wrote the schema for.
Agent output is assembled into a prompt and carried to a pane; it is never matched against, and a
decision arrives as fields or not at all (N1).

**Every uncertainty pauses.** A member that vanished, a fingerprint matching two panes, a budget
spent, a second invalid record, a relay that restarted mid-session — all of them stop the loop and
name a reason, and a person restarts it. An unattended loop that guesses is the failure mode this
design exists to avoid, and pausing is never the expensive mistake.

The herdr-facing calls are injected rather than imported, which is what lets the whole lifecycle be
tested without a pane, a relay or a subprocess: `send(pane_id, text)` delivers an instruction and
`panes()` returns what herdr currently lists.
"""
import functools
import hashlib
import json
import logging
import os
import sqlite3
import threading
import time

from arbitrator import MAX_INSTRUCTION, validate
from pane_summary import ends_turn

log = logging.getLogger("herdr-relay")


def session_change(method):
    """Serialise the two things that move a session's roster and its state together.

    `prompt` runs on the poll thread and `set_members` on whichever thread took the client's
    message, and between the edit's precondition check and the announcement reaching the
    arbitrator there is a window several seconds wide — `_send` waits for a pane to confirm. A
    trigger landing in it would move the session to `awaiting` after the edit had already read the
    state as `active`, which is precisely the case the refusal exists to prevent.

    Held across that send on purpose: what has to be indivisible is the edit *and* the arbitrator
    being told about it, not the row write alone. Safe to hold it that long because every caller
    reaches this class through `asyncio.to_thread` — the event loop is never the thread that
    blocks, so the `on_loop(..., wait=True)` inside the send is always serviced.

    Re-entrant, because a locked method may call another.
    """
    @functools.wraps(method)
    def locked(self, *args, **kwargs):
        with self._session_lock:
            return method(self, *args, **kwargs)
    return locked

# The CRFN default. A gate is a name and a host-owned template; `{instruction}` is the only
# substitution, and the arbitrator supplies prose, never a template. Shipping a different set is a
# JSON file, not a code change — which is the extensibility line this design defends.
DEFAULT_GATES = [
    {"name": "implement", "template": "{instruction}"},
    {"name": "review", "template": "Please review the work described above.\n\n{instruction}"},
    {"name": "phase_plan",
     "template": "Before continuing, write the plan for the next phase.\n\n{instruction}"},
    {"name": "call_human", "template": ""},
]

# Conservative on purpose, and raised only on evidence from real sessions. The maxima are the point:
# a person who wants a longer loop can have one, and cannot have an unbounded one by typo.
DEFAULT_BUDGET = {"max_steps": 8, "max_consecutive": 3, "max_wall_clock_ms": 45 * 60 * 1000}
BUDGET_MAX = {"max_steps": 50, "max_consecutive": 20, "max_wall_clock_ms": 8 * 60 * 60 * 1000}

MAX_SCOPE = 4_000
# §10's two clocks. Off by default and off is `0`; the floor exists because a clock shorter than a
# few poll intervals is a loop that fires on the pane's own settling, and the ceiling because these
# run unattended. `on_turn_end` has no clock — a member finishing is an event.
TRIGGERS_DEFAULT = {"on_turn_end": True, "idle_ms": 0, "runtime_ms": 0}
TRIGGER_MIN_MS = 60_000
TRIGGER_MAX_MS = 6 * 60 * 60 * 1000
# What one `arb_detail` answers with. A session is bounded by its own budget, so the cap is a
# ceiling on a payload rather than a policy — and the text fields are the prompt an arbitrator was
# given and the instruction it produced, both of which are whole agent turns.
DETAIL_DECISIONS = 20
DETAIL_TEXT = 8_000
# A role is a short phrase, not a brief. Several members may carry the same one — overlapping roles
# are the point: two agents that can both review is what lets the arbitrator keep the loop moving
# when one of them is busy. The caps are what keeps a phrase from becoming the prompt.
ROLES_MAX = 6
ROLE_MAX = 48
MEMBERS_REQUIRED = 2      # v1, until a two-member loop has been watched running for real (§14.1)
RUNNING = ("active", "awaiting")
# A pane acting on something is never written to (N7). Matches SUBMIT_TOOK in herdr_relay.py, and
# `blocked` is here for a second reason: that pane is showing a permission prompt a person owns.
BUSY = ("working", "blocked")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id                TEXT PRIMARY KEY,
  conversation      TEXT NOT NULL,
  scope             TEXT NOT NULL,
  gates_json        TEXT NOT NULL,
  budget_json       TEXT NOT NULL,
  triggers_json     TEXT NOT NULL,
  arbitrator_fp     TEXT NOT NULL,
  arbitrator_pane   TEXT NOT NULL,
  state             TEXT NOT NULL,
  pause_reason      TEXT,
  steps_used        INTEGER NOT NULL DEFAULT 0,
  consecutive       INTEGER NOT NULL DEFAULT 0,
  sequence          INTEGER NOT NULL DEFAULT 0,
  window_at         INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  ended_reason      TEXT
);

CREATE TABLE IF NOT EXISTS members (
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  member_id         TEXT NOT NULL,
  host              TEXT NOT NULL DEFAULT 'local',
  agent             TEXT NOT NULL,
  cwd               TEXT NOT NULL DEFAULT '',
  label             TEXT NOT NULL,
  role              TEXT NOT NULL DEFAULT '',
  pane_id           TEXT NOT NULL,
  enrolled_at       INTEGER NOT NULL,
  PRIMARY KEY (session_id, member_id)
);

CREATE TABLE IF NOT EXISTS prompts (
  id                INTEGER PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence          INTEGER NOT NULL,
  trigger           TEXT NOT NULL,
  body              TEXT NOT NULL,
  sent_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id                INTEGER PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  sequence          INTEGER NOT NULL,
  prompt_id         INTEGER NOT NULL REFERENCES prompts(id),
  raw_path          TEXT NOT NULL,
  valid             INTEGER NOT NULL,
  reject_code       TEXT,
  reject_detail     TEXT,
  gate              TEXT,
  to_member         TEXT,
  instruction       TEXT,
  why               TEXT NOT NULL,
  ambiguity         TEXT,
  complexity        TEXT,
  raw_sha256        TEXT NOT NULL,
  at                INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_seq ON decisions(session_id, sequence, id);

CREATE TABLE IF NOT EXISTS sends (
  id                INTEGER PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  decision_id       INTEGER NOT NULL REFERENCES decisions(id),
  to_member         TEXT NOT NULL,
  pane_id           TEXT NOT NULL,
  text              TEXT NOT NULL,
  at                INTEGER NOT NULL
);

-- Running means `active` *or* `awaiting`. A session whose arbitrator is mid-decision is very much
-- still running, and an index over `active` alone would let a second one start in exactly that
-- window — which is the window a trigger is most likely to land in.
CREATE UNIQUE INDEX IF NOT EXISTS one_running_session
  ON sessions(state IN ('active','awaiting')) WHERE state IN ('active','awaiting');
"""


class ArbiterError(Exception):
    """A refusal with a machine-readable code. The code is what the client is shown."""

    def __init__(self, code, detail=""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


def now_ms():
    return int(time.time() * 1000)


def fingerprint(pane):
    return (pane.get("host") or "local", pane.get("agent") or "", pane.get("cwd") or "")


# --- pure policy ---------------------------------------------------------------------------
#
# Everything below this line and above the class is a function of its arguments. The lifecycle is
# where the interesting mistakes live, so the rules that govern it are kept somewhere they can be
# read and tested without a database.


def budget_spent(session, now):
    """Which budget, if any, this session has run out of. None means it may take another step.

    Wall clock runs from `window_at`, which is `created_at` at start and moves on every resume: a
    person who resumes a session is granting it a fresh window, and the alternative is a session
    that pauses on time and then cannot be resumed at all.
    """
    budget = json.loads(session["budget_json"])
    if session["steps_used"] >= budget["max_steps"]:
        return "budget_steps"
    if session["consecutive"] >= budget["max_consecutive"]:
        return "budget_consecutive"
    if now - session["window_at"] >= budget["max_wall_clock_ms"]:
        return "budget_time"
    return None


def budget_left(session, now):
    budget = json.loads(session["budget_json"])
    return {
        "steps": max(0, budget["max_steps"] - session["steps_used"]),
        "consecutive": max(0, budget["max_consecutive"] - session["consecutive"]),
        "ms": max(0, budget["max_wall_clock_ms"] - (now - session["window_at"])),
    }


def check_budget(budget):
    """A budget the person asked for, or a refusal. Defaults fill anything not given."""
    out = dict(DEFAULT_BUDGET)
    out.update({k: v for k, v in (budget or {}).items() if k in DEFAULT_BUDGET})
    for key, cap in BUDGET_MAX.items():
        value = out[key]
        if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > cap:
            raise ArbiterError("budget_out_of_range", f"{key}={value!r}, max {cap}")
    return out


def check_triggers(triggers):
    """The triggers a person asked for, or a refusal. §10.

    `on_turn_end` is not optional in v1: a session with every clock off and no turn-end trigger is
    an arbitrator that will never be woken by anything, which is a session that looks armed and is
    not. The clocks are bounded rather than free — see TRIGGER_MIN_MS.
    """
    out = dict(TRIGGERS_DEFAULT)
    out.update({k: v for k, v in (triggers or {}).items() if k in TRIGGERS_DEFAULT})
    out["on_turn_end"] = True
    for key in ("idle_ms", "runtime_ms"):
        value = out[key]
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            raise ArbiterError("triggers_out_of_range", f"{key}={value!r}")
        if value and not TRIGGER_MIN_MS <= value <= TRIGGER_MAX_MS:
            raise ArbiterError("triggers_out_of_range",
                               f"{key}={value}, {TRIGGER_MIN_MS}..{TRIGGER_MAX_MS} or 0")
    return out


def check_roles(value):
    """One member's roles, normalised to a comma-joined line — or a refusal.

    Roles are the person's own words for what a member is there to do, and they are carried into
    every roster line the arbitrator reads. `review only`, `no code writing`, `minimal focused
    test` — short phrases, because the arbitrator acts on them and `no-code` is a slug a person
    has to decode before an agent can.

    The **shape** is checked here and the wording is not: the vocabulary is open on purpose,
    because a docs session wants `writes the release notes` and an allowlist for a phrase is a
    config file nobody asked for.

    What is enforced is that a role stays one short line. Whitespace is collapsed, non-printing
    characters are dropped — a terminal escape belongs in nobody's prompt — and both the length of
    a phrase and the number of them are capped. The roster is the one part of a trigger message the
    arbitrator is told to read as fact, and a pasted paragraph in it is a person's instruction
    forged by a stale client.

    Case is kept. It is what the person wrote; only the comparison that spots a repeat ignores it.
    """
    if not value:
        return ""
    if isinstance(value, str):
        parts = value.split(",")
    elif isinstance(value, (list, tuple)):
        parts = [x for x in value if isinstance(x, str)]
    else:
        raise ArbiterError("bad_role", repr(value)[:40])
    out = []
    for part in parts:
        # `#review only` is how a person writes it down and `review only` is the role.
        clean = "".join(c for c in part if c.isprintable() or c.isspace())
        phrase = " ".join(clean.strip().lstrip("#").split())
        if not phrase:
            continue
        if len(phrase) > ROLE_MAX:
            raise ArbiterError("bad_role", f"{phrase[:ROLE_MAX]}…, max {ROLE_MAX} characters")
        if phrase.lower() not in [x.lower() for x in out]:
            out.append(phrase)
    if len(out) > ROLES_MAX:
        raise ArbiterError("bad_role", f"{len(out)} roles, max {ROLES_MAX}")
    return ", ".join(out)


def resolve(fp, pane_id, panes, claimed=()):
    """Which live pane is this participant now, per §5.2. Returns (pane_id, None) or (None, code).

    The stored `pane_id` is a cache and the fingerprint is the identity, because herdr mints a new
    pane id on every restart. So: trust the cached id only while it still matches the fingerprint,
    otherwise adopt the single unclaimed pane that does.

    Zero matches and two matches are both refusals, and that is the whole point. Two claude panes in
    one directory are two colleagues; guessing between them puts one agent's work in the other's
    terminal. A wrong repair is much worse than no repair, and an unattended loop makes it worse
    still — the same reason `healPairs` in the front end refuses an ambiguous heal.
    """
    matches = [p for p in panes if fingerprint(p) == tuple(fp)]
    for p in matches:
        if p.get("pane_id") == pane_id:
            return pane_id, None
    free = [p for p in matches if p.get("pane_id") not in claimed]
    if len(free) == 1:
        return free[0]["pane_id"], None
    return None, "member_gone" if not free else "member_ambiguous"


def render(gates, gate, instruction):
    """The words a member receives: a host-owned template wrapped around the arbitrator's prose.

    `{instruction}` is the only substitution, and it is done with a replace rather than `.format`,
    which would treat every brace in an agent's prose as a field to fill and raise on the first
    stray one. Instructions carry code.
    """
    for g in gates:
        if g["name"] == gate:
            return g["template"].replace("{instruction}", instruction)
    raise ArbiterError("unknown_gate", gate)


def starter_prompt(scope, gates, query_path):
    """Sent once, when the session starts. §11.2 — the normative content lives in the spec."""
    names = ", ".join(g["name"] for g in gates)
    return f"""You are the arbitrator for a conversation between two agents.

Scope, from the person who started this session:
{scope}

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

Gates: {names}

Write exactly one JSON object to the path named in the trigger message. Fields:
  session_id           string, copy from the trigger
  sequence             integer, copy from the trigger
  gate                 one of the gates listed
  to                   a member id from the roster
  instruction          the words that member will receive (max {MAX_INSTRUCTION} characters)
  why                  one short paragraph, for the person reading the thread
  ambiguity            low | medium | high — does this turn leave the next step underdetermined
  decision_complexity  low | medium | high — is this beyond what should be auto-continued

For gate call_human, omit `to` and `instruction` entirely; `why` is still required,
and it is what the person will read. call_human pauses the session — the person
decides whether to resume it or end it.

Nothing else in your pane is read. Your reasoning, your tool calls and your prose
are ignored by the relay. Only the file counts.

To look further back than the trigger message shows:
  python3 {query_path} --last 20
  python3 {query_path} --grep "<text>"
Read-only, and capped — it says so when it truncates.

Choose call_human when ambiguity or decision complexity is high, when the scope
does not cover what just happened, or when you would be guessing."""


def roster_prompt(roster, scope, moved=True, reroled=True):
    """Sent when the person changes the session's roster. Announcement, not a trigger.

    The arbitrator was told the roster once, in the starter prompt, and every trigger message
    repeats it — so a roster edited underneath it would be discovered as a surprise in the next
    trigger, with no way to tell a swap from a mistake. This says a person did it, on purpose.

    Which of the two things changed is said out loud, because they mean different things to the
    agent reading it. A pane that moved invalidates what it remembers about a member id; a role
    that changed does not — the same colleague is still there and has been given a different job,
    and telling it otherwise would have it distrust a member it has been working with all session.

    No decision is asked for and no drop path is named: nothing has happened yet that needs one.
    """
    what = ("changed who is in it, and what each of them is for" if moved and reroled
            else "changed who is in it" if moved
            else "changed what each member is for")
    lines = [f"The person running this session has {what}.",
             "", "The roster is now:"]
    for member_id, m in roster.items():
        lines.append(f"  {member_id}  {m.get('label') or '-'} / {m.get('role') or '-'} / "
                     f"{m.get('agent') or '-'}")
    lines.append("")
    lines.append("The second column is the role: what the person wants that member to do. Address "
                 "members by the id in the first column — the roles are how you choose between "
                 "them, never how you name one.")
    if moved:
        lines.append("")
        lines.append("Anyone not listed above has left and can no longer be addressed. Member ids "
                     "are positional, so one you have used before may now be a different agent — "
                     "read the roster in each trigger message rather than remembering it.")
    else:
        lines.append("")
        lines.append("The same agents are still here. Only their roles changed, so a member id "
                     "still means the agent it meant before.")
    lines += ["", "The scope is unchanged:", scope,
              "", "Do not write a decision record for this message. Wait for the next trigger."]
    return "\n".join(lines)


def trigger_prompt(roster, trigger, entries, gates, left, sequence, drop_path):
    """Sent on every trigger. Only the changing context — §11.3.

    The roster carries each member's live status so the arbitrator can avoid naming one that cannot
    be written to, rather than discovering it by rejection. Entries are carried verbatim: this
    function assembles prose, and reads none of it.
    """
    lines = ["Roster:"]
    for member_id, m in roster.items():
        # Label first, because it is the name the turns below are headed with — the roster line is
        # what links `[Architect 1]` to `member-1`, and there is nothing else that does.
        lines.append(f"  {member_id}  {m.get('label') or '-'} / {m.get('role') or '-'} / "
                     f"{m.get('agent') or '-'} / {m.get('status') or 'unknown'}")
    lines.append("")
    lines.append(f"Trigger: {trigger}")
    lines.append("")
    for e in entries:
        who = e.get("label") or e.get("member_id") or e.get("origin") or "?"
        lines.append(f"[{who}]")
        lines.append(e.get("text") or "")
        lines.append("")
    lines.append("Allowed gates: " + ", ".join(g["name"] for g in gates))
    lines.append(f"Budget: {left['steps']} steps left, {left['consecutive']} consecutive left, "
                 f"{left['ms'] // 60000} minutes left")
    lines.append(f"Sequence: {sequence}")
    lines.append("")
    lines.append("Write your decision to:")
    lines.append(f"  {drop_path}")
    return "\n".join(lines)


# --- the runner ----------------------------------------------------------------------------


class Arbitration:
    """One session at a time, over one database. Owns the lifecycle; owns no policy.

    `send` and `panes` are injected because everything interesting about this class is what it does
    between them, and neither a pane nor a subprocess is needed to test that.
    """

    def __init__(self, path, *, send, panes, log=None, notify=None, clock=now_ms):
        self.path = path
        self.dir = os.path.join(os.path.dirname(path) or ".", "arbitration")
        self.send = send
        self.panes = panes
        self.log = log                     # a ConversationLog, or None
        # Called on every pause. §9.3: an unattended loop that stops must not be discovered hours
        # later, and the relay's answer to that is a Web Push — injected rather than imported for
        # the same reason `send` is, and because a push that fails is not a reason to fail a pause.
        self.notify = notify
        self.clock = clock
        self._session_lock = threading.RLock()
        # How long each member has been in the status it is in, for §10's clocks. Held in memory on
        # purpose: it is a fact about this relay's uptime, and a restart pauses the session anyway.
        self._since = {}
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, mode=0o700, exist_ok=True)
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        self._local = threading.local()
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    @property
    def conn(self):
        """This thread's connection. One per thread, never one shared between them.

        Every method here is reached through asyncio.to_thread — the poll loop firing a trigger,
        a client asking for a session's decisions, another ending it — so the connection is
        touched from several threads at once. Two threads on one sqlite3 connection share one
        cached prepared statement per SQL text, and one resetting it under the other returns rows
        belonging to neither query. It surfaces far from the race, as a short row or a SELECT
        built from no columns.

        A lock would do it too, and is what the conversation log next door uses. Not here: `start`
        and `prompt` type into a pane and wait for it to confirm, which is seconds of herdr calls,
        and a lock wide enough to cover their writes would hold every reader off for all of it.
        WAL lets these connections read while one writes; busy_timeout covers the moment two want
        to write at once.
        """
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=5000")
            self._local.conn = conn
        return conn

    def close(self):
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    def _send(self, pane_id, text):
        """Deliver, and say whether it was *proven* delivered. False is never guessed into a yes.

        `is not False` rather than a truth test: a sender that returns nothing is one that does not
        report, and treating its None as a failure would pause every session running against it.
        Only an explicit False — which is what submit_paste says when the pane never confirmed —
        counts as unproven.
        """
        try:
            return self.send(pane_id, text) is not False
        except Exception as e:
            # Logged rather than swallowed: this pauses a session, and "send_unconfirmed" with no
            # cause anywhere is the kind of stop a person cannot act on.
            log.warning("arbitration: delivery to %s raised: %r", pane_id, e)
            return False

    # --- reading ---

    def session(self, session_id):
        row = self.conn.execute("SELECT * FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if row is None:
            raise ArbiterError("no_session", session_id)
        return dict(row)

    def running(self):
        row = self.conn.execute(
            "SELECT * FROM sessions WHERE state IN ('active','awaiting')").fetchone()
        return dict(row) if row else None

    def open(self):
        """Most recent session a person can still resume or end.

        Paused sessions do not execute, so `running()` deliberately excludes them. They are still
        open, though: reconnecting must show their Resume control.
        """
        row = self.conn.execute(
            "SELECT * FROM sessions WHERE state != 'ended' ORDER BY created_at DESC, rowid DESC LIMIT 1").fetchone()
        return dict(row) if row else None

    def members(self, session_id):
        return [dict(r) for r in self.conn.execute(
            "SELECT * FROM members WHERE session_id = ? ORDER BY member_id", (session_id,))]

    def detail(self, session_id, last=DETAIL_DECISIONS):
        """Every decision this session made, with the prompt it answered and the send it caused.

        §15.3's detail sheet. The three things a person checks an automated send against, and the
        only arbitration message carrying prose — which is why the relay answers it to the client
        that asked and never broadcasts it. Rejections are included: a decision that was refused is
        the one somebody most wants to read, and leaving it out would make a re-prompt look like
        nothing happened.

        Text is capped per field rather than dropped. A truncated prompt still says what was asked;
        an absent one leaves a sheet that cannot answer the question it exists for.
        """
        self.session(session_id)        # raises no_session, which is the client's answer
        rows = self.conn.execute(
            "SELECT * FROM decisions WHERE session_id = ? ORDER BY id DESC LIMIT ?",
            (session_id, max(1, min(int(last or DETAIL_DECISIONS), DETAIL_DECISIONS)))).fetchall()
        prompts = {r["id"]: dict(r) for r in self.conn.execute(
            "SELECT * FROM prompts WHERE session_id = ?", (session_id,))}
        sends = {r["decision_id"]: dict(r) for r in self.conn.execute(
            "SELECT * FROM sends WHERE session_id = ?", (session_id,))}
        out = []
        for r in reversed(rows):
            prompt = prompts.get(r["prompt_id"])
            send = sends.get(r["id"])
            out.append({
                "sequence": r["sequence"], "at": r["at"], "valid": bool(r["valid"]),
                "reject_code": r["reject_code"], "gate": r["gate"], "to": r["to_member"],
                "why": r["why"], "instruction": (r["instruction"] or "")[:DETAIL_TEXT],
                "ambiguity": r["ambiguity"], "complexity": r["complexity"],
                "prompt": None if prompt is None else {
                    "trigger": prompt["trigger"], "at": prompt["sent_at"],
                    "body": prompt["body"][:DETAIL_TEXT]},
                # Present only where the relay stands behind the delivery. An unconfirmed send has
                # no row here on purpose (§13.2), and a sheet that invented one would be saying the
                # opposite of what the session paused for.
                "send": None if send is None else {
                    "pane_id": send["pane_id"], "to": send["to_member"], "at": send["at"],
                    "text": send["text"][:DETAIL_TEXT]},
            })
        return out

    def roster(self, session_id):
        """The roster as `validate` and `trigger_prompt` want it: resolution and status per member.

        `panes` is a count and not a pane id on purpose — the validator is pure and must not be
        handed something it would have to resolve. One is addressable; zero and two are the two
        halves of §5.2's refusal, and it is the caller that turns them into a pause reason.
        """
        live = self.panes()
        claimed = set()
        out = {}
        for m in self.members(session_id):
            fp = (m["host"], m["agent"], m["cwd"])
            matches = [p for p in live if fingerprint(p) == fp]
            pane_id, _ = resolve(fp, m["pane_id"], live, claimed)
            if pane_id:
                claimed.add(pane_id)
            status = next((p.get("agent_status") or "" for p in live
                           if p.get("pane_id") == pane_id), "")
            out[m["member_id"]] = {
                "panes": 1 if pane_id else (0 if not matches else len(matches)),
                "pane_id": pane_id, "status": status,
                "agent": m["agent"], "role": m["role"], "label": m["label"],
                # The rest of the fingerprint, which is what a row written about this member has to
                # be filed under — see `_record_turn`.
                "host": m["host"], "cwd": m["cwd"],
            }
        return out

    def _enrol(self, participants):
        """Panes as the caller named them, re-read as the relay's own snapshot says they are.

        Only `pane_id` and `role` are taken from the caller — the pane id is the selection and the
        role is the person's own label for it. Everything a participant is *identified* by is read
        back off the live snapshot, because a fingerprint the client supplies is a fingerprint the
        client can get wrong: a stale payload naming a pane that has since been replaced would
        enrol the new pane under the old pane's identity, and every later re-resolution would
        follow the wrong one.

        Raises the §9.2 participant codes, so starting a session and editing its roster refuse the
        same things for the same reasons.
        """
        if not all(isinstance(p, dict) for p in participants):
            raise ArbiterError("bad_participant")
        ids = [p.get("pane_id") for p in participants]
        if len(set(ids)) != len(ids) or not all(ids):
            raise ArbiterError("duplicate_participant")
        live_by_id = {p.get("pane_id"): p for p in self.panes()}
        out = []
        for p in participants:
            actual = live_by_id.get(p.get("pane_id"))
            if actual is None:
                raise ArbiterError("participant_not_live", p.get("pane_id") or "")
            # v1 is local-only (D13). A remote send is one ssh hop away and the recovery story for
            # a half-delivered instruction over a dropped connection is not written yet.
            #
            # The *claimed* host is checked even though it is not trusted for anything else, and
            # this is the one place it has to be. `panes()` is this machine's herdr, so everything
            # it lists is local by construction and a check against the snapshot alone can never
            # fail. But pane ids are per-host counters and collide across hosts — a client that
            # meant `box`'s w1:p1 would otherwise silently enrol *this* machine's w1:p1 and start
            # typing into the wrong agent's terminal. A claim is never identity; it is only ever a
            # reason to refuse.
            host = p.get("host") or actual.get("host") or "local"
            if host != "local":
                raise ArbiterError("remote_participant", host)
            out.append({**actual, "role": check_roles(p.get("role"))})
        # One project for everyone. An arbitrator reading two agents in an unrelated checkout is
        # deciding about work it cannot see, and every instruction it writes then lands in the
        # wrong repository — which is the one failure here that costs somebody a morning rather
        # than a re-prompt.
        #
        # `project_id` is set only where the relay has Projects configured and the pane's cwd is
        # under one, so a pane that has one and a pane that has none are two different answers and
        # refused as such. With no Projects configured at all nothing has one, there is nothing to
        # be the same of, and this cannot refuse anything — off means off (N10).
        projects = {p.get("project_id") or "" for p in out}
        if len(projects) > 1:
            raise ArbiterError("project_mismatch",
                               ", ".join(sorted(x or "no project" for x in projects)))
        return out

    # --- lifecycle ---

    def start(self, *, conversation, members, arbitrator, scope, gates=None, budget=None,
              triggers=None):
        """Enrol a roster and arm the loop. Preconditions in §9.2's order, each with its own code.

        `members` and `arbitrator` are panes as herdr lists them; the front end chose them, because
        which panes are in a conversation is already the person's decision. **The relay never picks
        participants.**

        What it does pick is who they *are*. Only `pane_id` and `role` are taken from the caller —
        the pane id is the selection and the role is the person's own label for it. Everything the
        session identifies a participant by is re-read from the live snapshot, because a fingerprint
        the client supplies is a fingerprint the client can get wrong: a stale payload naming a pane
        that has since been replaced would enrol the new pane under the old pane's identity, and
        every later re-resolution would follow the wrong one.
        """
        if self.running():
            raise ArbiterError("session_running")
        if len(members) != MEMBERS_REQUIRED:
            raise ArbiterError("member_count", f"{len(members)}, expected {MEMBERS_REQUIRED}")
        *members, arbitrator = self._enrol([*members, arbitrator])
        # N7 in the one place it is not about a member: the starter prompt is the only thing that
        # tells the arbitrator what it is, and a pane mid-turn is where that goes missing. Checked
        # here as well as in the browser, because a direct client is not obliged to have a form.
        if (arbitrator.get("agent_status") or arbitrator.get("status")) in BUSY:
            raise ArbiterError("arbitrator_busy", arbitrator["pane_id"])
        scope = (scope or "").strip()
        if not scope or len(scope) > MAX_SCOPE:
            raise ArbiterError("bad_scope")
        gates = gates or DEFAULT_GATES
        if not gates or any("name" not in g or "template" not in g for g in gates):
            raise ArbiterError("bad_gates")
        budget = check_budget(budget)
        triggers = check_triggers(triggers)

        at = self.clock()
        # Readable enough to recognise in a directory listing, and suffixed because the minute is
        # not unique — a session paused and a fresh one started right after is an ordinary
        # sequence, and two of them in one minute would otherwise collide on the primary key.
        stamp = time.strftime("%Y%m%d-%H%M", time.localtime(at / 1000))
        session_id = f"s-{stamp}-{os.urandom(2).hex()}"
        self.conn.execute(
            "INSERT INTO sessions (id, conversation, scope, gates_json, budget_json, "
            "triggers_json, arbitrator_fp, arbitrator_pane, state, window_at, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,'active',?,?)",
            (session_id, conversation, scope, json.dumps(gates), json.dumps(budget),
             json.dumps(triggers),
             json.dumps(fingerprint(arbitrator)), arbitrator["pane_id"], at, at))
        self._write_members(session_id, members, at)
        self.conn.commit()
        os.makedirs(os.path.join(self.dir, session_id), mode=0o700, exist_ok=True)
        if not self._send(arbitrator["pane_id"], starter_prompt(scope, gates, self._query_path())):
            # Ended, not paused, and raised like every other start precondition. The starter prompt
            # is the only thing that tells the arbitrator what it is and where to write; a session
            # resumed without it has an agent that will never produce a decision file, so it would
            # re-prompt once and pause again on `invalid_record` — a dead end wearing a Resume
            # button. Failing the start leaves nothing behind and the person simply starts again.
            self.end(session_id, "send_unconfirmed")
            raise ArbiterError("send_unconfirmed", arbitrator["pane_id"])
        return self.session(session_id)

    def _write_members(self, session_id, members, at):
        """The roster, replacing whatever was there. Ids are positional: member-1 is the first.

        Positional and not sticky, so a roster edit cannot leave `member-2` meaning one agent in
        the arbitrator's memory and another in the table. Which is exactly why the edit announces
        itself — see `roster_prompt`.
        """
        self.conn.execute("DELETE FROM members WHERE session_id = ?", (session_id,))
        for i, p in enumerate(members, start=1):
            self.conn.execute(
                "INSERT INTO members (session_id, member_id, host, agent, cwd, label, role, "
                "pane_id, enrolled_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (session_id, f"member-{i}", p.get("host") or "local", p.get("agent") or "",
                 p.get("cwd") or "", p.get("label") or "", p.get("role") or "",
                 p["pane_id"], at))

    @session_change
    def set_members(self, session_id, members):
        """Change who a running session is arbitrating between. Attach, detach and swap, one verb.

        §14.1 still fixes the size at two, so every edit is a replacement of the whole roster
        rather than an add and a remove: "swap the reviewer", "put these two in" and "take that one
        out and this one in" are one operation with one set of preconditions to get right.

        **This is the change to N6.** The roster used to be fixed at session start, and it is not
        any more. What N6 was protecting — that the arbitrator can never be handed a `to` it was
        never told about — is now protected by two things instead: the edit is announced to the
        arbitrator on this same call, and it is refused while a decision is outstanding.

        Refused while `awaiting` for that second reason. A prompt is already with the arbitrator
        naming the roster as it was; a decision answering it that names a member who left in the
        meantime would be rejected as an unknown member, which reads in the record as the
        arbitrator's mistake and is the person's edit. Pause it or let the decision land.

        The reused arbitrator is the point: its pane, its brief and the session's budget and
        history all stay, and only the two it is watching change.
        """
        s = self.session(session_id)
        if s is None:
            raise ArbiterError("no_session")
        if s["state"] not in ("active", "paused"):
            raise ArbiterError("not_editable", s["state"])
        if len(members) != MEMBERS_REQUIRED:
            raise ArbiterError("member_count", f"{len(members)}, expected {MEMBERS_REQUIRED}")
        arb, _ = resolve(json.loads(s["arbitrator_fp"]), s["arbitrator_pane"], self.panes())
        if arb is None:
            raise ArbiterError("arbitrator_gone")
        # The arbitrator rides along so the roster is checked *against* it — same project, and not
        # one of the two — and is dropped again: `_enrol` validates participants, and which of them
        # are members is this method's business.
        enrolled = self._enrol([*members, {"pane_id": arb}])[:MEMBERS_REQUIRED]
        # N7, and the same refusal `start` makes: the announcement is a keystroke, and a pane
        # mid-turn is where a keystroke goes missing. Refused rather than paused — nothing has
        # changed yet, and the person can do it a moment later.
        arb_status = next((p.get("agent_status") or "" for p in self.panes()
                           if p.get("pane_id") == arb), "")
        if arb_status in BUSY:
            raise ArbiterError("arbitrator_busy", arb)

        at = self.clock()
        # Read before the write, so the announcement can say which half of the roster moved. A
        # role-only edit is an ordinary thing to do — "you review, you fix" is a decision a person
        # makes a few turns in — and it is not a swap, so it must not be announced as one.
        before = self.roster(session_id)
        self._write_members(session_id, enrolled, at)
        self.conn.execute("UPDATE sessions SET arbitrator_pane=? WHERE id=?", (arb, session_id))
        self.conn.commit()
        roster = self.roster(session_id)
        moved = ([m["pane_id"] for m in before.values()]
                 != [m["pane_id"] for m in roster.values()])
        reroled = [m["role"] for m in before.values()] != [m["role"] for m in roster.values()]
        log.info("arbitration %s roster set to %s", session_id,
                 ", ".join(f"{mid}={m.get('label') or m.get('pane_id')}"
                           f"{' [' + m['role'] + ']' if m.get('role') else ''}"
                           for mid, m in roster.items()))
        body = roster_prompt(roster, s["scope"], moved, reroled)
        self.conn.execute(
            "INSERT INTO prompts (session_id, sequence, trigger, body, sent_at) VALUES (?,?,?,?,?)",
            (session_id, s["sequence"], "roster", body, at))
        self.conn.commit()
        if not self._send(arb, body):
            # The roster is already changed — it is a row, and the row is written. What could not
            # be proven is that the arbitrator was *told*, and an arbitrator deciding against a
            # roster it does not know about is the one thing this whole call exists to prevent.
            return self.pause(session_id, "send_unconfirmed")
        return self.session(session_id)

    def pause(self, session_id, reason):
        """Stop the loop and say why. The one choke point, so every pause is announced.

        Announcing is best-effort by design: a push that fails must not turn a clean pause into an
        exception halfway through the poll loop that called it. The pause is already committed by
        the time anyone is told, so the worst case is a stopped session nobody was pinged about —
        which is the state the notification exists to improve on, not one it can make worse.
        """
        self.conn.execute("UPDATE sessions SET state='paused', pause_reason=? WHERE id=?",
                          (reason, session_id))
        self.conn.commit()
        s = self.session(session_id)
        log.info("arbitration %s paused: %s", session_id, reason)
        if self.notify:
            try:
                self.notify(s, reason)
            except Exception:
                pass
        return s

    def resume(self, session_id):
        """Back to `active`, with a fresh wall-clock window.

        Deliberately does not re-check the budget that paused it: a person resuming a session that
        stopped on `budget_steps` without raising the limit gets one more pause at the next trigger,
        which is honest, and the alternative is a Resume button that silently does nothing.
        """
        session = self.session(session_id)
        if session["state"] not in ("active", "paused"):
            raise ArbiterError("not_paused", session["state"])
        running = self.running()
        if running and running["id"] != session_id:
            raise ArbiterError("session_running", running["id"])
        self.conn.execute(
            "UPDATE sessions SET state='active', pause_reason=NULL, window_at=? WHERE id=?",
            (self.clock(), session_id))
        self.conn.commit()
        return self.session(session_id)

    def end(self, session_id, reason):
        session = self.session(session_id)
        if session["state"] == "ended":
            raise ArbiterError("not_open", session["state"])
        self.conn.execute(
            "UPDATE sessions SET state='ended', ended_at=?, ended_reason=? WHERE id=?",
            (self.clock(), reason, session_id))
        self.conn.commit()
        return self.session(session_id)

    def recover(self):
        """At boot: a session that was running is paused, never resumed. §9.4.

        The relay cannot promise exactly-once delivery into a terminal. If it died between the
        `pane run` and the row that records it, the send happened and the database does not know —
        so resuming could deliver a phase's instructions twice. Stopping and showing the person the
        last send is the only honest option.
        """
        row = self.running()
        if row is None:
            return None
        return self.pause(row["id"], "restart")

    def human_entered(self, session_id):
        """A person put text into the conversation, which is what "not consecutive" means."""
        self.conn.execute("UPDATE sessions SET consecutive=0 WHERE id=?", (session_id,))
        self.conn.commit()

    # --- what a pane ending its turn means ------------------------------------------------
    #
    # Two panes can end a turn, and it means opposite things. A **member** finishing is a
    # wake-up (N3) — read the thing you were already expecting, never "the step passed". The
    # **arbitrator** finishing is not a trigger at all: it is the signal to read the drop-box
    # (§12.1). Both entry points are no-ops unless a session is running, so the poll loop can
    # call them on every pane transition without knowing anything about arbitration.

    def turn_ended(self, pane_id, entries, kind="turn_end"):
        """A pane ended a turn. Prompts the arbitrator if that pane is a member. §10.

        Returns the prompt handle, or None if nothing was asked — which covers no session, a
        session that is paused, a pane that is not on the roster, and the coalescing case.

        **Coalesced, not queued.** While a session is `awaiting` there is already one prompt
        outstanding, and a second member finishing in that window folds into the next prompt's
        roster rather than producing a prompt of its own. Queueing them would have the arbitrator
        answering a question about a conversation that had already moved on.

        Never raises. A trigger that cannot proceed pauses the session and says why, and the poll
        loop that called this has fifty other panes to get through.
        """
        s = self.running()
        if s is None or s["state"] != "active":
            return None
        try:
            member_id = next((mid for mid, m in self.roster(s["id"]).items()
                              if m["pane_id"] == pane_id), None)
            if member_id is None:
                return None
            return self.prompt(s["id"], f"{kind} — {member_id}", entries)
        except (ArbiterError, sqlite3.Error, OSError):
            return None

    def due(self, now=None):
        """Which members' clocks have come round. §10 — evaluated by the caller's poll loop.

        Returns a list of `{"member", "pane_id", "trigger"}`, which the relay turns into the same
        `turn_ended` call a real turn end makes: the digest, the coalescing and the budget are one
        path, and a clock is only another way of reaching it.

        Fires once per stay. A member sitting idle for an hour with a five-minute clock is one
        prompt, not twelve — the arbitrator has already been told, and repeating it is how an
        unattended loop spends a budget on nothing. The clock restarts when the pane moves.
        """
        s = self.running()
        if s is None or s["state"] != "active":
            self._since = {}      # a paused session's clocks do not accumulate while it is stopped
            return []
        trig = json.loads(s["triggers_json"])
        idle_ms, runtime_ms = int(trig.get("idle_ms") or 0), int(trig.get("runtime_ms") or 0)
        now = self.clock() if now is None else now
        try:
            roster = self.roster(s["id"])
        except (ArbiterError, sqlite3.Error):
            return []
        # A send resets the idle clock, because a member that was just written to is not idle in the
        # sense that matters — it is about to work, and prompting the arbitrator about it would ask
        # for a decision on a turn that has not started.
        last_send = {r["pane_id"]: r["at"] for r in self.conn.execute(
            "SELECT pane_id, MAX(at) AS at FROM sends WHERE session_id=? GROUP BY pane_id",
            (s["id"],))}
        out = []
        live = set()
        for member_id, m in roster.items():
            pane_id, status = m["pane_id"], m["status"]
            if not pane_id:
                continue
            live.add(pane_id)
            seen = self._since.get(pane_id)
            if seen is None or seen[0] != status:
                self._since[pane_id] = [status, now, False]
                continue
            _, since, fired = seen
            if fired or (not idle_ms and not runtime_ms):
                continue
            if idle_ms and ends_turn(status) and now - since >= idle_ms \
                    and since > last_send.get(pane_id, 0):
                trigger = "idle"
            elif runtime_ms and status == "working" and now - since >= runtime_ms:
                trigger = "runtime"
            else:
                continue
            seen[2] = True
            out.append({"member": member_id, "pane_id": pane_id, "trigger": trigger})
        for pane_id in set(self._since) - live:
            del self._since[pane_id]        # a member that moved pane starts its clock again
        return out

    def arbitrator_finished(self, pane_id):
        """The arbitrator ended a turn, so its answer should be on disk. Reads it. §12.1 step 4.

        Reads *the path the relay already knew* — the arbitrator never tells the relay where to
        look, which is what stops a compromised or confused agent from pointing it at a file
        somebody else wrote.
        """
        s = self.running()
        if s is None or s["state"] != "awaiting":
            return None
        try:
            arb, _ = resolve(json.loads(s["arbitrator_fp"]), s["arbitrator_pane"], self.panes())
            if arb is None or arb != pane_id:
                return None
            row = self.conn.execute(
                "SELECT id FROM prompts WHERE session_id=? AND sequence=? ORDER BY id DESC LIMIT 1",
                (s["id"], s["sequence"])).fetchone()
            if row is None:
                return None
            return self.collect(s["id"], row["id"])
        except (ArbiterError, sqlite3.Error, OSError):
            return None

    # --- the loop ---

    def drop_path(self, session_id, sequence):
        return os.path.join(self.dir, session_id, f"{sequence:04d}-decision.json")

    def _query_path(self):
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "conv_query.py")

    @session_change
    def prompt(self, session_id, trigger, entries):
        """Ask the arbitrator for the next decision. Moves the session to `awaiting`.

        The drop-box must not exist when this returns: step 4 of §12.1 reads *the path the relay
        already knew*, and a file left over from a previous sequence would be read as this
        sequence's answer.
        """
        s = self.session(session_id)
        if s["state"] not in RUNNING:
            raise ArbiterError("not_running", s["state"])
        now = self.clock()
        spent = budget_spent(s, now)
        if spent:
            self.pause(session_id, spent)
            raise ArbiterError(spent)
        roster = self.roster(session_id)
        for member_id, m in roster.items():
            if m["panes"] != 1:
                reason = "member_gone" if m["panes"] == 0 else "member_ambiguous"
                self.pause(session_id, reason)
                raise ArbiterError(reason, member_id)
        arb, code = resolve(json.loads(s["arbitrator_fp"]), s["arbitrator_pane"], self.panes())
        if arb is None:
            self.pause(session_id, "arbitrator_gone")
            raise ArbiterError("arbitrator_gone")

        sequence = s["sequence"] + 1
        path = self.drop_path(session_id, sequence)
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        if os.path.exists(path):
            os.unlink(path)
        body = trigger_prompt(roster, trigger, entries, json.loads(s["gates_json"]),
                              budget_left(s, now), sequence, path)
        cur = self.conn.execute(
            "INSERT INTO prompts (session_id, sequence, trigger, body, sent_at) VALUES (?,?,?,?,?)",
            (session_id, sequence, trigger, body, now))
        self.conn.execute(
            "UPDATE sessions SET state='awaiting', sequence=?, arbitrator_pane=? WHERE id=?",
            (sequence, arb, session_id))
        self.conn.commit()
        with open(path.replace("-decision.json", "-prompt.txt"), "w") as fh:
            fh.write(body)          # so a decision can be read against exactly what was seen
        if not self._send(arb, body):
            self.pause(session_id, "send_unconfirmed")
            return None
        log.info("arbitration %s seq %d: asked %s (%s, %d bytes)",
                 session_id, sequence, arb, trigger, len(body))
        return {"sequence": sequence, "prompt_id": cur.lastrowid, "path": path}

    def read_dropbox(self, session_id, sequence):
        """The record and its content hash, or (None, None) if the arbitrator has not written yet.

        The hash, not `(mtime, size)`: a corrected record is very often the same length as the one
        it replaces — one enum swapped, one member id changed — and filesystem timestamps are not
        fine-grained enough to rely on either. A content hash is the only comparison that cannot say
        "unchanged" about a file whose contents changed.
        """
        path = self.drop_path(session_id, sequence)
        try:
            with open(path, "rb") as fh:
                raw = fh.read()
        except OSError:
            return None, None
        return raw, hashlib.sha256(raw).hexdigest()

    def _reject(self, s, decision_id, code):
        """One rejection: written down, counted, and answered with a re-prompt or a pause.

        Every way a decision can fail comes through here, so the bound is over all of them together
        rather than per cause. Two failures at one sequence pause the session: an arbitrator that
        cannot produce a deliverable record twice running is not going to on the third try, and a
        loop that keeps asking is the unattended failure this whole design exists to avoid.

        The row is marked invalid *here* rather than at insert, because a decision can fail after
        validating — a target that moved between the check and the send is a rejection that only
        exists at delivery time, and one that is not recorded is one the bound cannot see.
        """
        self.conn.execute("UPDATE decisions SET valid=0, reject_code=? WHERE id=?",
                          (code, decision_id))
        self.conn.commit()
        failures = self.conn.execute(
            "SELECT COUNT(*) FROM decisions WHERE session_id=? AND sequence=? AND valid=0",
            (s["id"], s["sequence"])).fetchone()[0]
        if failures >= 2:
            self.pause(s["id"], "invalid_record")
            return {"outcome": "paused", "reason": "invalid_record", "reject_code": code}
        reprompt_id = self._reprompt(s, code)
        if reprompt_id is None:
            return {"outcome": "paused", "reason": self.session(s["id"])["pause_reason"],
                    "reject_code": code}
        return {"outcome": "reprompt", "reject_code": code, "decision_id": decision_id,
                "prompt_id": reprompt_id}

    def _reprompt(self, s, code):
        """Ask the still-live arbitrator to correct the same decision file once."""
        arb, _ = resolve(json.loads(s["arbitrator_fp"]), s["arbitrator_pane"], self.panes())
        if arb is None:
            self.pause(s["id"], "arbitrator_gone")
            return None
        roster = self.roster(s["id"])
        body = trigger_prompt(roster, f"reprompt — {code}", [], json.loads(s["gates_json"]),
                              budget_left(s, self.clock()), s["sequence"],
                              self.drop_path(s["id"], s["sequence"]))
        body = f"Your decision was rejected: {code}. Correct the same file.\n\n{body}"
        cur = self.conn.execute(
            "INSERT INTO prompts (session_id, sequence, trigger, body, sent_at) VALUES (?,?,?,?,?)",
            (s["id"], s["sequence"], "reprompt", body, self.clock()))
        self.conn.commit()
        if not self._send(arb, body):
            self.pause(s["id"], "send_unconfirmed")
            return None
        return cur.lastrowid

    def collect(self, session_id, prompt_id):
        """Read the drop-box, validate it, and act. The one place a decision becomes a keystroke.

        Returns a dict saying what happened: `sent`, `call_human`, `waiting`, `reprompt` or
        `paused`. Never raises on a bad record — an arbitrator writing nonsense is an expected
        outcome with a defined response, not an error condition.
        """
        s = self.session(session_id)
        if s["state"] != "awaiting":
            return {"outcome": "waiting", "state": s["state"]}
        sequence = s["sequence"]
        raw, sha = self.read_dropbox(session_id, sequence)
        if raw is None:
            return {"outcome": "waiting"}
        prior = self.conn.execute(
            "SELECT raw_sha256, valid FROM decisions WHERE session_id=? AND sequence=? "
            "ORDER BY id DESC LIMIT 1", (session_id, sequence)).fetchone()
        if prior and prior["raw_sha256"] == sha:
            # The same bytes we already judged. An agent that answers instantly would otherwise be
            # read before it wrote, and re-rejecting its old file would burn the one re-prompt.
            return {"outcome": "waiting", "unchanged": True}

        roster = self.roster(session_id)
        session_view = {
            "session_id": session_id, "sequence": sequence,
            "gates": [g["name"] for g in json.loads(s["gates_json"])], "roster": roster,
        }
        decision, code = validate(raw, session_view)
        now = self.clock()
        doc = decision or {}
        cur = self.conn.execute(
            "INSERT INTO decisions (session_id, sequence, prompt_id, raw_path, valid, reject_code, "
            "gate, to_member, instruction, why, ambiguity, complexity, raw_sha256, at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (session_id, sequence, prompt_id, self.drop_path(session_id, sequence),
             0 if code else 1, code, doc.get("gate"), doc.get("to"), doc.get("instruction"),
             doc.get("why") or "", doc.get("ambiguity"), doc.get("decision_complexity"), sha, now))
        decision_id = cur.lastrowid
        self.conn.commit()
        # A whole successful session used to leave nothing in the relay log — only refusals were
        # written down, so the one run that worked was indistinguishable from one that never
        # started. These three lines (asked, decided, paused) are the session's trace on disk.
        log.info("arbitration %s seq %d: %s", session_id, sequence,
                 f"rejected {code}" if code else
                 "{} {} — {}".format(doc["gate"], doc.get("to") or "you",
                                     (doc.get("why") or "")[:120]))

        if code:
            return self._reject(s, decision_id, code)

        if doc["gate"] == "call_human":
            self.pause(session_id, "call_human")
            self._record_turn(s, kind="decision", text=doc["why"], decision_id=decision_id)
            return {"outcome": "call_human", "why": doc["why"], "decision_id": decision_id}
        return self._execute(s, doc, decision_id, roster)

    def _execute(self, s, doc, decision_id, roster):
        """§13.2. Re-resolve, render, send, record, spend."""
        member = roster[doc["to"]]
        # Re-resolved between validation and delivery, because a pane that moved in that window is
        # a pane this would otherwise type into by its old id.
        fresh = self.roster(s["id"])[doc["to"]]
        if fresh["panes"] != 1 or fresh["pane_id"] != member["pane_id"] \
                or fresh["status"] in BUSY:
            # §13.2 step 1: "treat as target_not_live and re-prompt" — and *treat as* is the whole
            # instruction. This record validated a moment ago, so it is on the row as valid; a race
            # that left it undeliverable makes it a rejection like any other, and it has to be
            # written down as one or it escapes the bound below. A member that keeps moving would
            # otherwise re-prompt forever, spending no step and tripping no budget.
            return self._reject(s, decision_id, "target_not_live")
        text = render(json.loads(s["gates_json"]), doc["gate"], doc["instruction"])
        if not self._send(fresh["pane_id"], text):
            # Unconfirmed is not "not delivered". submit_paste says False when it could not *prove*
            # the pane took it, and its commonest False — a pane already working — is one where the
            # text very probably landed and queued. So the thread gets the row (N8: an automated
            # send is visible, and an unproven one is the one a person most needs to go and look
            # at), while `sends` does not: that table is the relay's record of deliveries it stands
            # behind, and a row there would make a maybe into a yes. No step is spent for the same
            # reason — a budget counts things that certainly happened.
            self._record_turn(s, kind="arbitrated", text=text, decision_id=decision_id, who=fresh)
            self.pause(s["id"], "send_unconfirmed")
            return {"outcome": "paused", "reason": "send_unconfirmed", "decision_id": decision_id,
                    "to": doc["to"], "pane_id": fresh["pane_id"], "text": text}
        now = self.clock()
        self.conn.execute(
            "INSERT INTO sends (session_id, decision_id, to_member, pane_id, text, at) "
            "VALUES (?,?,?,?,?,?)",
            (s["id"], decision_id, doc["to"], fresh["pane_id"], text, now))
        self.conn.execute(
            "UPDATE sessions SET state='active', steps_used=steps_used+1, "
            "consecutive=consecutive+1 WHERE id=?", (s["id"],))
        self.conn.commit()
        self._record_turn(s, kind="arbitrated", text=text, decision_id=decision_id, who=fresh)
        return {"outcome": "sent", "to": doc["to"], "pane_id": fresh["pane_id"],
                "text": text, "decision_id": decision_id}

    def _record_turn(self, s, *, kind, text, decision_id, who=None):
        """N8: every automated send is visible in the thread. Nothing happens off-screen.

        Filed under the participant's whole fingerprint — host, agent and cwd — and not its pane id
        alone. A thread asks the record for (host, agent, cwd) precisely because pane ids change on
        every restart, so a row written with no cwd is a row no view will ever ask for: visible in
        the table, invisible where N8 means it to be seen. `who` is a roster entry; without one the
        row is the arbitrator's own, and its fingerprint is the one the session was started with.
        """
        if self.log is None:
            return
        if who is None:
            host, agent, cwd = json.loads(s["arbitrator_fp"])
            pane_id, label = s["arbitrator_pane"], ""
        else:
            host, agent, cwd = who.get("host") or "local", who.get("agent") or "", who.get("cwd") or ""
            pane_id, label = who["pane_id"] or s["arbitrator_pane"], who.get("label") or ""
        self.log.record(host=host, agent=agent, cwd=cwd, pane_id=pane_id, label=label, kind=kind,
                        origin="arbitrator", at_src="sent", text=text, at=self.clock(),
                        decision_id=decision_id)
