#!/usr/bin/env python3
"""Agent identity — the id that outlives the pane.

A herdr pane id is a *slot*. herdr assigns it, herdr reuses it, and it changes for reasons that
have nothing to do with the agent sitting in it: the session was respawned, it was killed and
another started in its place, herdr was restarted, the machine was rebooted.

What matters to this app is the *agent* — the thing that carries the spawn details and the history,
and that occupies a succession of slots over its life. This gives it an id, mints it in the one
place that can (the relay is the only participant that sees every pane, outlives every browser, and
can be a single writer), and remembers what each one was started as.

Four rules, first match wins, run once per poll against the whole pane list:

1. the pane carries a `ref` an agent is waiting on — the client said which agent this start
   continues, and a statement outranks every inference below it. Spent on use: a `ref` names one
   start, and a binding left lying about would move the agent again on the next poll
2. the slot already carries an id and the seat still agrees
3. exactly one retired agent has this seat and nothing else claims it — adoption
4. otherwise, a new id

Rule 3 is what carries an agent across a herdr restart or a reboot: the processes come back in new
slots, the seat is unchanged, and the agent keeps its id and therefore its conversation, its
transcript and its pair. It is `healPairs`' rule, promoted here so it is decided once for every
browser rather than re-derived by whichever one happened to be watching.

Ambiguity is refused, never guessed. Two claude panes in one directory are two colleagues, and
putting one agent's work in the other's terminal is the worst failure available here.

See `.workflow/03_specs/2026-08-29_agent_identity_spec.md`.
"""
import os
import random
import sqlite3
import string
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents (
  aid          TEXT PRIMARY KEY,
  host         TEXT NOT NULL DEFAULT '',
  agent        TEXT NOT NULL DEFAULT '',
  cwd          TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  pane_id      TEXT NOT NULL DEFAULT '',
  ref          TEXT NOT NULL DEFAULT '',
  config       TEXT NOT NULL DEFAULT '',
  project_id   TEXT NOT NULL DEFAULT '',
  project      TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL DEFAULT '',
  starter      TEXT NOT NULL DEFAULT '',
  label        TEXT NOT NULL DEFAULT '',
  first_seen   INTEGER NOT NULL DEFAULT 0,
  last_seen    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS agents_seat ON agents (host, agent, cwd);
CREATE INDEX IF NOT EXISTS agents_slot ON agents (host, workspace_id, pane_id);
CREATE INDEX IF NOT EXISTS agents_ref  ON agents (ref);
"""

# What a pane can tell us about the session in it. The seat is the first three; the rest are the
# spawn details — what the session *was*, so that starting it again starts it the same way.
SEAT = ("host", "agent", "cwd")
DETAILS = ("config", "project_id", "project", "role", "starter", "label")

# How many retired agents are offered to a client. A retired row is what "Restart" is built from,
# and a browser cannot use a list it will never draw. Rows are never deleted — this is the size of
# the answer, not the size of the memory.
RETIRED_MAX = 200

ALPHABET = string.ascii_lowercase + string.digits


def now_ms():
    return int(time.time() * 1000)


def new_aid(rand=None):
    """`a_` and twelve base36 characters.

    Minted here and never by a client: an id a client could choose is an id a client could claim,
    and this one is what says whose transcript a pane may continue.
    """
    r = rand or random
    return "a_" + "".join(r.choice(ALPHABET) for _ in range(12))


def seat_of(pane):
    return tuple((pane.get(k) or "") for k in SEAT)


def slot_of(pane):
    """Where a pane is, unambiguously. The host is not decoration — see `resolve`."""
    return (pane.get("host") or "", pane.get("workspace_id") or "", pane.get("pane_id") or "")


class AgentIds:
    """The registry. One row per agent, kept for ever; `pane_id` is where it is now, or ''."""

    def __init__(self, path):
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, mode=0o700, exist_ok=True)
        # Same posture as UserState next door: one connection, one lock. Written from the poll loop
        # and read from whichever handler took a client's message.
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self.lock = threading.Lock()
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass  # a filesystem that will not take a mode is not a reason to lose the registry

    def close(self):
        self.conn.close()

    # --- reading ---

    def all_rows(self):
        with self.lock:
            return [dict(r) for r in self.conn.execute("SELECT * FROM agents")]

    def get(self, aid):
        with self.lock:
            row = self.conn.execute("SELECT * FROM agents WHERE aid = ?", (aid,)).fetchone()
        return dict(row) if row else None

    def retired(self, limit=RETIRED_MAX):
        """Agents with no live pane, newest first — what a client draws a Restart from.

        `pane_id = ''` is the whole of the test. `resolve` retires a row in the same transaction it
        claims the others in, so this is never a guess about who is running.
        """
        with self.lock:
            rows = self.conn.execute(
                "SELECT * FROM agents WHERE pane_id = '' ORDER BY last_seen DESC LIMIT ?",
                (int(limit),)).fetchall()
        return [dict(r) for r in rows]

    # --- writing ---

    def bind_ref(self, aid, ref):
        """Say that the start named `ref` is this agent coming back.

        Written before the pane exists, which is the point: rule 1 then recognises it on the very
        first poll that sees it, and no adoption guess is involved. Spent when it is used.
        """
        if not aid or not ref:
            return False
        with self.lock:
            cur = self.conn.execute("UPDATE agents SET ref = ? WHERE aid = ?", (ref, aid))
            self.conn.commit()
        return cur.rowcount > 0

    def resolve(self, panes, now=None):
        """Give every pane an agent id, and retire the agents that no longer have a pane.

        `panes` are the snapshot's agent dicts. Each is stamped with `aid` in place; the return is
        `{(host, workspace_id, pane_id): aid}`.

        Not keyed by `pane_id` alone, however much shorter that would read: a herdr pane id is a
        per-server counter, so the same string names a different pane on each host — which is what
        the relay's own collision guards exist for, and identity is the last place to undo them.

        The whole pane list, every poll: "which agents are gone" is only answerable against the
        complete roster, and a partial one would retire every pane on another host.
        """
        now = now or now_ms()
        rows = {r["aid"]: r for r in self.all_rows()}
        by_slot, by_ref = {}, {}
        for r in rows.values():
            if r["pane_id"]:
                by_slot[(r["host"], r["workspace_id"], r["pane_id"])] = r
            if r["ref"]:
                by_ref.setdefault(r["ref"], r)

        out, taken, spent, unresolved = {}, set(), set(), []
        # Rule 1, in a pass of its own and before every inference below. The client said which
        # agent this start continues; a slot claim is a guess about a number herdr recycles, and a
        # guess must never win against a statement. Order is the whole of the difference: a restart
        # that ends the old pane and starts a new one can show the relay both in one poll.
        for p in panes:
            if not p.get("pane_id"):
                continue
            row = by_ref.get(p.get("ref") or "")
            if row and row["aid"] not in taken:
                out[slot_of(p)], _ = row["aid"], taken.add(row["aid"])
                spent.add(row["aid"])
        for p in panes:
            if not p.get("pane_id") or slot_of(p) in out:
                continue
            slot = slot_of(p)
            row = by_slot.get(slot)
            # Rule 2. The seat has to agree: a slot herdr recycled under a different harness or in
            # a different directory is a different session wearing the same number.
            if row and row["aid"] not in taken and (row["host"], row["agent"], row["cwd"]) == seat_of(p):
                out[slot], _ = row["aid"], taken.add(row["aid"])
                continue
            unresolved.append(p)

        # Rule 3. Adoption, and only where there is exactly one candidate on each side. A seat with
        # two new panes, or two retired agents, is left to rule 4 — one agent's history in another
        # agent's conversation is not a risk worth a heuristic.
        free = {}
        for r in rows.values():
            if r["aid"] in taken:
                continue
            free.setdefault((r["host"], r["agent"], r["cwd"]), []).append(r)
        want = {}
        for p in unresolved:
            want.setdefault(seat_of(p), []).append(p)
        for seat, waiting in want.items():
            candidates = free.get(seat) or []
            if len(waiting) != 1 or len(candidates) != 1:
                continue
            row = candidates[0]
            out[slot_of(waiting[0])] = row["aid"]
            taken.add(row["aid"])

        # Rule 4.
        fresh = []
        for p in unresolved:
            if slot_of(p) in out:
                continue
            aid = new_aid()
            while aid in rows:
                aid = new_aid()
            out[slot_of(p)] = aid
            fresh.append(aid)

        self._commit(panes, out, rows, spent, now)
        # Stamped on the pane itself, which is what the snapshot goes out carrying. The mapping is
        # returned as well, for a caller that has the slot but not the dict.
        for p in panes:
            aid = out.get(slot_of(p))
            if aid:
                p["aid"] = aid
        return out

    def _commit(self, panes, out, rows, spent, now):
        """Every claim and every retirement, in one transaction.

        One transaction because the two halves are one statement about the fleet: a row retired
        while another poll is mid-claim would be adopted by rule 3 as a free seat.
        """
        claimed = set(out.values())
        with self.lock:
            for p in panes:
                aid = out.get(slot_of(p))
                if not aid:
                    continue
                old = rows.get(aid) or {}
                # A detail the pane does not carry keeps what was recorded. `config` is the case
                # this exists for: it lives in the relay's memory, so a relay restart drops it off
                # the snapshot while the pane it describes runs on — and the alias would otherwise
                # be forgotten by the one place that is supposed to remember it.
                vals = {k: (p.get(k) or old.get(k) or "") for k in DETAILS}
                self.conn.execute(
                    "INSERT INTO agents (aid, host, agent, cwd, workspace_id, pane_id, ref, "
                    "  config, project_id, project, role, starter, label, first_seen, last_seen) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(aid) DO UPDATE SET host=excluded.host, agent=excluded.agent, "
                    "  cwd=excluded.cwd, workspace_id=excluded.workspace_id, "
                    "  pane_id=excluded.pane_id, ref=excluded.ref, config=excluded.config, "
                    "  project_id=excluded.project_id, project=excluded.project, "
                    "  role=excluded.role, starter=excluded.starter, label=excluded.label, "
                    "  last_seen=excluded.last_seen",
                    (aid, p.get("host") or "", p.get("agent") or "", p.get("cwd") or "",
                     p.get("workspace_id") or "", p["pane_id"],
                     # Spent. A ref names one start, and a binding left lying about would move the
                     # agent again on the next poll — onto whichever pane still wears that ref.
                     "" if aid in spent else (p.get("ref") or old.get("ref") or ""),
                     vals["config"], vals["project_id"], vals["project"], vals["role"],
                     vals["starter"], vals["label"],
                     old.get("first_seen") or now, now))
            gone = [aid for aid in rows if aid not in claimed and rows[aid]["pane_id"]]
            for aid in gone:
                # The row stays. Retiring is losing a pane, not being forgotten — the spawn details
                # are what a restart is built from, and they are the reason this table exists.
                self.conn.execute("UPDATE agents SET pane_id = '' WHERE aid = ?", (aid,))
            self.conn.commit()


def _demo():
    """Self-check. `python3 relay/agent_ids.py` — the four rules, and rule 3's refusal."""
    import tempfile

    def pane(pid, **kw):
        return dict({"pane_id": pid, "host": "local", "agent": "claude", "cwd": "/w",
                     "workspace_id": "w1"}, **kw)

    def run(ids, panes):
        ids.resolve(panes)
        return {p["pane_id"]: p.get("aid") for p in panes}

    with tempfile.TemporaryDirectory() as d:
        ids = AgentIds(os.path.join(d, "ids.sqlite3"))
        aid = run(ids, [pane("p1")])["p1"]
        assert aid.startswith("a_"), aid
        # Rule 1: the same slot, the same seat, the same id.
        assert run(ids, [pane("p1")])["p1"] == aid
        # Rule 3: herdr restarted, the slot moved, the seat did not.
        assert run(ids, [pane("p9")])["p9"] == aid, "adoption carries the agent across"
        assert len(ids.all_rows()) == 1, "one agent, not a corpse and a stranger"
        # Rule 4: a different harness in the same directory is a different colleague.
        two = run(ids, [pane("p9"), pane("p8", agent="codex")])
        assert two["p9"] == aid and two["p8"] != aid
        # Retirement, and rule 2 bringing it back by name.
        run(ids, [pane("p9")])
        assert [r["aid"] for r in ids.retired()] == [two["p8"]]
        ids.bind_ref(two["p8"], "rABC")
        back = run(ids, [pane("p9"), pane("p7", agent="codex", cwd="/e", ref="rABC")])
        assert back["p7"] == two["p8"], "a named start is the agent it says it is"

        # Rule 3 refuses ambiguity: two panes for one retired seat, and neither adopts.
        two_panes = AgentIds(os.path.join(d, "b.sqlite3"))
        one = run(two_panes, [pane("p1")])["p1"]
        both = run(two_panes, [pane("p4"), pane("p5")])
        assert len({one, *both.values()}) == 3, "three agents, none of them guessed"

        # And two retired agents for one returning pane.
        two_rows = AgentIds(os.path.join(d, "c.sqlite3"))
        made = run(two_rows, [pane("p1"), pane("p2")])
        two_rows.resolve([])
        assert run(two_rows, [pane("p3")])["p3"] not in made.values()

        # A pane id is a per-server counter, so the same one on two hosts is two panes.
        hosts = AgentIds(os.path.join(d, "e.sqlite3"))
        panes = [pane("p1"), pane("p1", host="box")]
        hosts.resolve(panes)
        assert panes[0]["aid"] != panes[1]["aid"]

        # The spawn details survive a snapshot that stopped carrying them.
        kept = AgentIds(os.path.join(d, "f.sqlite3"))
        aid = run(kept, [pane("p1", config="oclaude1", label="ARCH")])["p1"]
        run(kept, [pane("p1")])
        assert kept.get(aid)["config"] == "oclaude1"
        assert kept.get(aid)["label"] == "ARCH"
    print("agent_ids: ok")


if __name__ == "__main__":
    _demo()
