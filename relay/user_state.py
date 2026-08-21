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
CREATE TABLE IF NOT EXISTS history (
  name TEXT    NOT NULL,
  rev  INTEGER NOT NULL,
  body TEXT    NOT NULL,
  at   INTEGER NOT NULL,
  PRIMARY KEY (name, rev)
);
"""

# Every committed revision, not only the one being replaced: `docs` is one row per name and a put
# overwrites it, so a client that writes a wrong document destroys the right one with no trace.
# That is not hypothetical — a browser that filed its own conversation index over the shared one
# took every conversation name the user had typed, and the only copies left were half-overwritten
# pages inside the WAL.
#
# Opaque bodies mean this cannot keep "the interesting ones", so it keeps the recent ones. At the
# sizes these documents actually reach — single-digit KB — the whole retention is about a megabyte
# per name, which buys enough revisions to cover a bad browser being noticed and shut.
HISTORY_KEEP = 200

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
                at = now_ms()
                self.conn.execute(
                    "INSERT INTO docs (name, rev, body, at) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT(name) DO UPDATE SET rev = excluded.rev, "
                    "body = excluded.body, at = excluded.at",
                    (name, new_rev, body, at))
                # In the same transaction as the document itself. A history that can be a revision
                # behind is one that does not hold the version you are trying to get back to.
                self.conn.execute(
                    "INSERT OR REPLACE INTO history (name, rev, body, at) VALUES (?, ?, ?, ?)",
                    (name, new_rev, body, at))
                self.conn.execute(
                    "DELETE FROM history WHERE name = ? AND rev <= ?",
                    (name, new_rev - HISTORY_KEEP))
                self.conn.commit()
            except Conflict:
                raise
            except sqlite3.Error:
                self.conn.rollback()
                raise
        return new_rev


    def history(self, name, limit=50):
        """Recent revisions of one document, newest first: [{"rev", "at", "bytes"}].

        Without the bodies — a listing is for finding the revision you want, and four documents'
        worth of bodies is the thing that makes this table big.
        """
        if name not in DOC_NAMES:
            raise ValueError(f"unknown document {name!r}")
        with self.lock:
            rows = self.conn.execute(
                "SELECT rev, at, length(body) AS bytes FROM history WHERE name = ? "
                "ORDER BY rev DESC LIMIT ?", (name, int(limit))).fetchall()
        return [dict(r) for r in rows]

    def body_at(self, name, rev):
        """One historical body, or None if that revision has been pruned or never existed."""
        if name not in DOC_NAMES:
            raise ValueError(f"unknown document {name!r}")
        with self.lock:
            row = self.conn.execute(
                "SELECT body FROM history WHERE name = ? AND rev = ?", (name, rev)).fetchone()
        return row["body"] if row else None

    def restore(self, name, rev):
        """Put an old body back as a new revision. Returns the new revision.

        Deliberately a normal `put` and not a rewind: the revision only ever goes up, so a browser
        holding rev 214 sees 216 and adopts it exactly as it would any other write. Rewinding the
        counter instead would make every open browser's next write land at a revision the relay had
        already handed to someone else.
        """
        body = self.body_at(name, rev)
        if body is None:
            raise ValueError(f"{name} has no revision {rev}")
        return self.put(name, self.get([name])[name]["rev"], body)


def _cli(argv):
    """Read the history and put a version back, from a shell.

    A recovery path that needs the app to be working is not a recovery path — the case this exists
    for is a browser that has just overwritten the document, which is exactly when you do not want
    to open another browser.
    """
    import json
    import sys
    usage = ("usage: user_state.py [--db PATH] list\n"
             "       user_state.py [--db PATH] history <name> [limit]\n"
             "       user_state.py [--db PATH] show <name> [rev]\n"
             "       user_state.py [--db PATH] restore <name> <rev>")
    db = os.environ.get("HERDR_STATE_DB", ".herdr-remote/state.sqlite3")
    if argv[:1] == ["--db"]:
        db, argv = argv[1], argv[2:]
    if not argv:
        print(usage, file=sys.stderr)
        return 2
    cmd, args = argv[0], argv[1:]
    s = UserState(db)
    try:
        if cmd == "list":
            for name, doc in s.get().items():
                n = len(s.history(name, HISTORY_KEEP))
                print(f"{name:14} rev={doc['rev']:<6} "
                      f"{len(doc['body'] or ''):>8} bytes  {n} kept")
        elif cmd == "history" and args:
            for h in s.history(args[0], int(args[1]) if len(args) > 1 else 50):
                when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(h["at"] / 1000))
                print(f"rev={h['rev']:<6} {when}  {h['bytes']:>8} bytes")
        elif cmd == "show" and args:
            name = args[0]
            body = (s.body_at(name, int(args[1])) if len(args) > 1
                    else s.get([name])[name]["body"])
            if body is None:
                print("no such revision", file=sys.stderr)
                return 1
            print(body)
        elif cmd == "restore" and len(args) == 2:
            new_rev = s.restore(args[0], int(args[1]))
            print(f"{args[0]}: revision {args[1]} restored as {new_rev}")
            print("Open browsers pick it up on their next connect — the relay broadcasts a write "
                  "it made itself, not one made under it.")
        else:
            print(usage, file=sys.stderr)
            return 2
    except (ValueError, Conflict) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    finally:
        s.close()
    return 0


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

        # The history is what makes an overwrite recoverable, so the overwrite is what tests it.
        s.put("conversations", 0, '{"items":["named"]}')
        s.put("conversations", 1, '{"items":["fabricated"]}')
        hist = s.history("conversations")
        assert [h["rev"] for h in hist] == [2, 1], hist
        assert s.body_at("conversations", 1) == '{"items":["named"]}'
        assert s.restore("conversations", 1) == 3
        assert s.get(["conversations"])["conversations"]["body"] == '{"items":["named"]}'
        assert s.body_at("conversations", 99) is None
        s.close()
    print("ok")


if __name__ == "__main__":
    import sys
    sys.exit(_cli(sys.argv[1:]) if sys.argv[1:] else (_demo() or 0))
