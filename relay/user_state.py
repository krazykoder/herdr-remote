#!/usr/bin/env python3
"""Shared user state — the documents that are facts about the work, not about one browser.

The app has kept all of its state in `localStorage`, which means a pair named on a phone does not
exist on a desktop. Four of those keys are not preferences about a device at all — a pair, a
conversation's name and roster, which conversation a pane is read under, and which conversations
are hidden are assertions the user made about the *agents*. This is where they live now.

A document is an opaque string with a revision number. Nothing here parses one. Every question
about what a pair *is* stays in the front end, where the tests for it already are, and a schema
change in the app ships without a relay change — which is what keeps a phone on an old build from
being broken by a desktop on a new one.

The name space is a fixed tuple and not whatever a client asks for. An open key space makes this a
blob store for anything a client cares to name, and there is no version of that whose security
story is short.
"""
import os
import sqlite3
import threading
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
  name TEXT PRIMARY KEY,
  rev  INTEGER NOT NULL,
  body TEXT    NOT NULL,
  at   INTEGER NOT NULL
);
"""

# Mirrors of `herdr_pairs`, `herdr_conversations`, `herdr_conv_view` and `herdr_conv_hidden`.
# Deliberately not the other thirty-nine: a theme and a font size are answers to "how should this
# device behave", and syncing them makes a desktop adopt a phone's font size.
DOC_NAMES = ("pairs", "conversations", "conv_view", "conv_hidden")

# Per document, so the ceiling on this store is four of these. The app's own caps — MAX_PAIRS is
# 32, and convFit trims the conversation index — keep real documents orders of magnitude under it,
# so this is a bound on a client that has gone wrong rather than a limit anyone will meet.
MAX_BODY = 256 * 1024


class Conflict(Exception):
    """A put whose rev is not the stored one, carrying what the store actually holds.

    The current document rides along so the loser of a race needs no second round trip to find out
    what it lost to.
    """

    def __init__(self, rev, body):
        super().__init__("stale rev")
        self.rev, self.body = rev, body


def now_ms():
    return int(time.time() * 1000)


class UserState:
    """Four rows. Read on connect, written on edit, broadcast to everyone else."""

    def __init__(self, path):
        self.path = path
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, mode=0o700, exist_ok=True)
        # check_same_thread=False plus a lock, unlike the conversation log next door: that one is
        # written only from the poll loop, and this one is written from whichever client handler
        # took the message. Two browsers saving at the same moment is the ordinary case here, not
        # the exotic one.
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self.conn.commit()
        self.lock = threading.Lock()
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass  # a filesystem that will not take a mode is not a reason to lose the state

    def close(self):
        self.conn.close()

    def get(self, names=None):
        """{name: {"rev": int, "body": str|None}} for every known name asked for.

        A name that has never been written comes back at rev 0 with a null body rather than being
        left out: "the relay has nothing" and "you never asked" are different answers, and a client
        deciding whether to seed the store needs to tell them apart.

        Unknown names are dropped rather than raised. A client newer than this relay asking for a
        document it has not heard of must degrade, not fail.
        """
        want = [n for n in (names or DOC_NAMES) if n in DOC_NAMES]
        out = {n: {"rev": 0, "body": None} for n in want}
        if not want:
            return out
        with self.lock:
            rows = self.conn.execute(
                "SELECT name, rev, body FROM docs WHERE name IN (%s)"
                % ",".join("?" * len(want)), want).fetchall()
        for r in rows:
            out[r["name"]] = {"rev": r["rev"], "body": r["body"]}
        return out

    def put(self, name, rev, body):
        """Store `body` and return its new revision.

        Raises ValueError on a name outside the allowlist, a body that is not a string or is over
        the cap, or a rev that is not a non-negative integer. Raises Conflict when `rev` is not the
        revision the store currently holds.

        The compare and the write are one transaction. Two clients that both read rev 7 must not
        both write rev 8.
        """
        if name not in DOC_NAMES:
            raise ValueError(f"unknown document {name!r}")
        if not isinstance(body, str):
            raise ValueError("body must be a string")
        if len(body.encode("utf-8")) > MAX_BODY:
            raise ValueError("document too large")
        # bool is an int as far as isinstance is concerned, and True as a revision is a client bug
        # worth naming rather than silently reading as 1.
        if isinstance(rev, bool) or not isinstance(rev, int) or rev < 0:
            raise ValueError("bad rev")
        with self.lock:
            try:
                self.conn.execute("BEGIN IMMEDIATE")
                row = self.conn.execute(
                    "SELECT rev, body FROM docs WHERE name = ?", (name,)).fetchone()
                have = row["rev"] if row else 0
                if have != rev:
                    self.conn.rollback()
                    raise Conflict(have, row["body"] if row else None)
                new_rev = have + 1
                self.conn.execute(
                    "INSERT INTO docs (name, rev, body, at) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(name) DO UPDATE SET rev = excluded.rev, "
                    "body = excluded.body, at = excluded.at",
                    (name, new_rev, body, now_ms()))
                self.conn.commit()
            except Conflict:
                raise
            except sqlite3.Error:
                self.conn.rollback()
                raise
        return new_rev


def _demo():
    """Self-check: python3 relay/user_state.py"""
    import tempfile
    with tempfile.TemporaryDirectory() as d:
        s = UserState(os.path.join(d, "state.sqlite3"))
        assert s.get(["pairs"]) == {"pairs": {"rev": 0, "body": None}}
        assert s.put("pairs", 0, "{}") == 1
        assert s.get(["pairs"])["pairs"] == {"rev": 1, "body": "{}"}
        try:
            s.put("pairs", 0, "{}")
            raise AssertionError("stale put should conflict")
        except Conflict as c:
            assert (c.rev, c.body) == (1, "{}")
        for bad in [("nope", 0, "{}"), ("pairs", 1, 123), ("pairs", 1, "x" * (MAX_BODY + 1)),
                    ("pairs", -1, "{}"), ("pairs", True, "{}")]:
            try:
                s.put(*bad)
                raise AssertionError(f"{bad} should be refused")
            except ValueError:
                pass
        assert s.get(["pairs"])["pairs"]["rev"] == 1, "a refused put must not advance the rev"
        assert set(s.get()) == set(DOC_NAMES)
        s.close()
    print("ok")


if __name__ == "__main__":
    _demo()
