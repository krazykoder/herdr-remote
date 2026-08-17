#!/usr/bin/env python3
"""The relay's durable record of what agents said.

The browser already keeps a rich conversation in IndexedDB. This is the other half of the same
idea and answers what that one cannot: a conversation that outlives the tab, that Telegram and the
TUI can read without each porting a detector, and that something other than a person can query.

One table, `turns`, and it belongs to **no session**. Capture is per pane, keyed by fingerprint —
(host, agent, cwd) — and happens once, whether or not anything is arbitrating. A pane is in more
than one conversation over its life and its turns do not belong to whichever run happened to be
going at the time; a session reads the turns it cares about by roster fingerprints and a time
window, over the same rows.

Per-agent logs are a column rather than a file, exactly as the front end's per-member records are
merged for the joint view: filter by fingerprint for one participant, drop the filter for the
thread. `ORDER BY at, id` throughout — `at` is when it happened, and `id` only ever breaks ties
between turns that ended inside one poll.

Writes live here. Reads live in conv_query, which this module imports rather than the reverse, so
the process an agent runs to read the record holds no code that could write it.
"""
import os
import sqlite3
import time

from conv_query import QUERY_ROWS_DEFAULT, as_wire, query  # noqa: F401  (re-exported for the relay)

# A message is kept whole up to here. Past it the record is still the message, minus the middle of
# a wall of text nobody was going to read out of a log.
TEXT_MAX = 16 * 1024
# The pane tail is a fallback for a turn whose message could not be found, so what matters is its
# end — the last thing on screen — which is why it is trimmed from the front.
TAIL_MAX = 4 * 1024

DEFAULT_MAX_ROWS = 50000

KINDS = frozenset({"agent_final", "agent_blocked", "human_prompt", "arbitrated", "decision", "note"})
ORIGINS = frozenset({"agent", "human_web", "human_terminal", "arbitrator", "unknown"})
AT_SRCS = frozenset({"sent", "poll", "backfill"})

# Turns that are evidence of an automated decision are never pruned: they are the record of what
# the machine did on its own, which is the part a person most needs to be able to go back to.
KEEP_ALWAYS = ("arbitrated", "decision")

SCHEMA = """
CREATE TABLE IF NOT EXISTS turns (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  host         TEXT    NOT NULL DEFAULT 'local',
  agent        TEXT    NOT NULL,
  cwd          TEXT    NOT NULL DEFAULT '',
  pane_id      TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  project      TEXT    NOT NULL DEFAULT '',
  kind         TEXT    NOT NULL,
  origin       TEXT    NOT NULL,
  text         TEXT    NOT NULL DEFAULT '',
  tail         TEXT    NOT NULL DEFAULT '',
  range_start  INTEGER,
  range_end    INTEGER,
  status_from  TEXT,
  status_to    TEXT,
  at           INTEGER NOT NULL,
  at_src       TEXT    NOT NULL,
  decision_id  INTEGER
);
CREATE INDEX IF NOT EXISTS turns_time ON turns(at, id);
CREATE INDEX IF NOT EXISTS turns_fp   ON turns(host, agent, cwd, at, id);
CREATE INDEX IF NOT EXISTS turns_pane ON turns(pane_id, at, id);
"""


def now_ms():
    return int(time.time() * 1000)


class ConversationLog:
    """The writer. One per relay process; SQLite handles the rest."""

    def __init__(self, path, max_rows=DEFAULT_MAX_ROWS):
        self.path = path
        self.max_rows = max_rows
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, mode=0o700, exist_ok=True)
        # check_same_thread=False: the relay writes from asyncio.to_thread, so the connection is
        # touched from more than one thread but never from two at once — every write goes through
        # the poll loop. A lock here would be guarding against a caller that does not exist.
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass  # a filesystem that will not take a mode is not a reason to lose the record

    def close(self):
        self.conn.close()

    # --- writing ---

    def record(self, *, agent, pane_id, kind, origin, at_src, host="local", cwd="", label="",
               project="", text="", tail="", span=None, status_from=None, status_to=None,
               at=None, decision_id=None):
        """One turn. Returns its id, which is also its sequence.

        Enums are checked rather than trusted: this record is what an automated loop will later
        read to decide something, and a mistyped origin is exactly the kind of quiet wrongness
        that becomes a wrong decision months later.
        """
        if kind not in KINDS:
            raise ValueError(f"unknown kind: {kind!r}")
        if origin not in ORIGINS:
            raise ValueError(f"unknown origin: {origin!r}")
        if at_src not in AT_SRCS:
            raise ValueError(f"unknown at_src: {at_src!r}")
        text = (text or "")[:TEXT_MAX]
        tail = (tail or "")[-TAIL_MAX:]
        row = self.conn.execute(
            "INSERT INTO turns (host, agent, cwd, pane_id, label, project, kind, origin,"
            " text, tail, range_start, range_end, status_from, status_to, at, at_src, decision_id)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (host or "local", agent or "", cwd or "", pane_id, label or "", project or "",
             kind, origin, text, tail,
             span[0] if span else None, span[1] if span else None,
             status_from, status_to, at if at is not None else now_ms(), at_src, decision_id))
        self.conn.commit()
        self._prune()
        return row.lastrowid

    def record_turn_end(self, pane, content, status_from, status_to, at=None):
        """A pane that just stopped working, from the content of its pane.

        Returns the new row's id, or None when this turn is already recorded. The duplicate is
        real and ordinary: a pane goes blocked, a person answers, it finishes — and unless it
        wrote something new in between, both transitions read back the same closing message. The
        front end's store dedupes the same way, by what was said rather than by how it ended.
        """
        from pane_summary import message_block

        text, span = message_block(content, pane.get("agent"))
        rows = (content or "").splitlines()
        tail = "\n".join(rows[-12:])
        if text and self._last_text(pane["pane_id"]) == text:
            return None
        return self.record(
            agent=pane.get("agent") or "", pane_id=pane["pane_id"],
            host=pane.get("host") or "local", cwd=pane.get("cwd") or "",
            label=pane.get("label") or "", project=pane.get("project") or "",
            kind="agent_blocked" if status_to == "blocked" else "agent_final",
            origin="agent", at_src="poll", text=text, tail=tail, span=span,
            status_from=status_from, status_to=status_to, at=at)

    def _last_text(self, pane_id):
        row = self.conn.execute(
            "SELECT text FROM turns WHERE pane_id = ? AND kind IN ('agent_final','agent_blocked')"
            " ORDER BY at DESC, id DESC LIMIT 1", (pane_id,)).fetchone()
        return row["text"] if row else None

    def _prune(self):
        """Oldest first, and never the record of something automated (KEEP_ALWAYS).

        Checked on every write and almost always a no-op — one COUNT against an index. Doing it
        here rather than on a timer means the ceiling holds without a second moving part.
        """
        count = self.conn.execute("SELECT COUNT(*) FROM turns").fetchone()[0]
        if count <= self.max_rows:
            return
        keep = ",".join("?" * len(KEEP_ALWAYS))
        self.conn.execute(
            f"DELETE FROM turns WHERE id IN ("
            f"  SELECT id FROM turns WHERE kind NOT IN ({keep})"
            f"  ORDER BY at ASC, id ASC LIMIT ?)",
            (*KEEP_ALWAYS, count - self.max_rows))
        self.conn.commit()

    # --- reading ---

    def query(self, **selectors):
        """The same bounded read conv_query gives an agent, for the relay's own answers."""
        return query(self.conn, **selectors)
