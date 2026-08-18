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
import hashlib
import json
import os
import sqlite3
import time

from arbitrator import MAX_INSTRUCTION, validate

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


def trigger_prompt(roster, trigger, entries, gates, left, sequence, drop_path):
    """Sent on every trigger. Only the changing context — §11.3.

    The roster carries each member's live status so the arbitrator can avoid naming one that cannot
    be written to, rather than discovering it by rejection. Entries are carried verbatim: this
    function assembles prose, and reads none of it.
    """
    lines = ["Roster:"]
    for member_id, m in roster.items():
        lines.append(f"  {member_id}  {m.get('role') or '-'} / {m.get('agent') or '-'} / "
                     f"{m.get('status') or 'unknown'}")
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

    def __init__(self, path, *, send, panes, log=None, clock=now_ms):
        self.path = path
        self.dir = os.path.join(os.path.dirname(path) or ".", "arbitration")
        self.send = send
        self.panes = panes
        self.log = log                     # a ConversationLog, or None
        self.clock = clock
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, mode=0o700, exist_ok=True)
        os.makedirs(self.dir, mode=0o700, exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self):
        self.conn.close()

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

    def members(self, session_id):
        return [dict(r) for r in self.conn.execute(
            "SELECT * FROM members WHERE session_id = ? ORDER BY member_id", (session_id,))]

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
            }
        return out

    # --- lifecycle ---

    def start(self, *, conversation, members, arbitrator, scope, gates=None, budget=None,
              triggers=None):
        """Enrol a roster and arm the loop. Preconditions in §9.2's order, each with its own code.

        `members` and `arbitrator` are panes as herdr lists them; the front end chose them, because
        which panes are in a conversation is already the person's decision. **The relay never picks
        participants.**
        """
        if self.running():
            raise ArbiterError("session_running")
        if len(members) != MEMBERS_REQUIRED:
            raise ArbiterError("member_count", f"{len(members)}, expected {MEMBERS_REQUIRED}")
        panes = [*members, arbitrator]
        ids = [p.get("pane_id") for p in panes]
        if len(set(ids)) != len(ids) or not all(ids):
            raise ArbiterError("duplicate_participant")
        live = self.panes()
        live_ids = {p.get("pane_id") for p in live}
        for p in panes:
            if p.get("pane_id") not in live_ids:
                raise ArbiterError("participant_not_live", p.get("pane_id") or "")
            if (p.get("host") or "local") != "local":
                # v1 is local-only (D13). A remote send is one ssh hop away and the recovery story
                # for a half-delivered instruction over a dropped connection is not written yet.
                raise ArbiterError("remote_participant", p.get("host") or "")
        scope = (scope or "").strip()
        if not scope or len(scope) > MAX_SCOPE:
            raise ArbiterError("bad_scope")
        gates = gates or DEFAULT_GATES
        if not gates or any("name" not in g or "template" not in g for g in gates):
            raise ArbiterError("bad_gates")
        budget = check_budget(budget)

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
             json.dumps(triggers or {"on_turn_end": True}),
             json.dumps(fingerprint(arbitrator)), arbitrator["pane_id"], at, at))
        for i, p in enumerate(members, start=1):
            self.conn.execute(
                "INSERT INTO members (session_id, member_id, host, agent, cwd, label, role, "
                "pane_id, enrolled_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (session_id, f"member-{i}", p.get("host") or "local", p.get("agent") or "",
                 p.get("cwd") or "", p.get("label") or "", p.get("role") or "",
                 p["pane_id"], at))
        self.conn.commit()
        os.makedirs(os.path.join(self.dir, session_id), mode=0o700, exist_ok=True)
        self.send(arbitrator["pane_id"], starter_prompt(scope, gates, self._query_path()))
        return self.session(session_id)

    def pause(self, session_id, reason):
        self.conn.execute("UPDATE sessions SET state='paused', pause_reason=? WHERE id=?",
                          (reason, session_id))
        self.conn.commit()
        return self.session(session_id)

    def resume(self, session_id):
        """Back to `active`, with a fresh wall-clock window.

        Deliberately does not re-check the budget that paused it: a person resuming a session that
        stopped on `budget_steps` without raising the limit gets one more pause at the next trigger,
        which is honest, and the alternative is a Resume button that silently does nothing.
        """
        self.conn.execute(
            "UPDATE sessions SET state='active', pause_reason=NULL, window_at=? WHERE id=?",
            (self.clock(), session_id))
        self.conn.commit()
        return self.session(session_id)

    def end(self, session_id, reason):
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

    # --- the loop ---

    def drop_path(self, session_id, sequence):
        return os.path.join(self.dir, session_id, f"{sequence:04d}-decision.json")

    def _query_path(self):
        return os.path.join(os.path.dirname(os.path.abspath(__file__)), "conv_query.py")

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
        self.send(arb, body)
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

        if code:
            # One re-prompt, naming the failure. A second is a pause: an arbitrator that cannot
            # produce a valid record twice running is not going to on the third try, and the loop
            # asking forever is the unattended failure this whole design is built to avoid.
            failures = self.conn.execute(
                "SELECT COUNT(*) FROM decisions WHERE session_id=? AND sequence=? AND valid=0",
                (session_id, sequence)).fetchone()[0]
            if failures >= 2:
                self.pause(session_id, "invalid_record")
                return {"outcome": "paused", "reason": "invalid_record", "reject_code": code}
            return {"outcome": "reprompt", "reject_code": code, "decision_id": decision_id}

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
            return {"outcome": "reprompt", "reject_code": "target_not_live",
                    "decision_id": decision_id}
        text = render(json.loads(s["gates_json"]), doc["gate"], doc["instruction"])
        self.send(fresh["pane_id"], text)
        now = self.clock()
        self.conn.execute(
            "INSERT INTO sends (session_id, decision_id, to_member, pane_id, text, at) "
            "VALUES (?,?,?,?,?,?)",
            (s["id"], decision_id, doc["to"], fresh["pane_id"], text, now))
        self.conn.execute(
            "UPDATE sessions SET state='active', steps_used=steps_used+1, "
            "consecutive=consecutive+1 WHERE id=?", (s["id"],))
        self.conn.commit()
        self._record_turn(s, kind="arbitrated", text=text, decision_id=decision_id,
                          pane_id=fresh["pane_id"], agent=member.get("agent") or "")
        return {"outcome": "sent", "to": doc["to"], "pane_id": fresh["pane_id"],
                "text": text, "decision_id": decision_id}

    def _record_turn(self, s, *, kind, text, decision_id, pane_id="", agent=""):
        """N8: every automated send is visible in the thread. Nothing happens off-screen."""
        if self.log is None:
            return
        self.log.record(agent=agent, pane_id=pane_id or s["arbitrator_pane"], kind=kind,
                        origin="arbitrator", at_src="sent", text=text, at=self.clock(),
                        decision_id=decision_id)
