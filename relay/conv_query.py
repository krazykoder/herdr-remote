#!/usr/bin/env python3
"""Reading the conversation record. No writes live in this module, on purpose.

Two callers, one query. The relay answers a client's `conv_log` with it, and an agent — an
arbitrator deciding what happens next — runs it from its own shell:

    python3 relay/conv_query.py --agent claude --last 20
    python3 relay/conv_query.py --grep "footer" --format json
    python3 relay/conv_query.py --pane %12 --since 1755423862000

The connection is opened `mode=ro`, so this cannot alter the record even by accident, and the
writer (conversation_log.ConversationLog) imports its reads *from here* rather than the other way
round — which is what keeps the process an agent runs free of any code that could write.

Every answer is bounded. An unbounded read is how a query meant to inform a decision becomes the
thing that fills a context window, and a truncated answer that says so is more useful than a
complete one nobody can read.
"""
import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

# Bounds, applied together: whichever runs out first ends the answer.
QUERY_ROWS_MAX = 200
QUERY_ROWS_DEFAULT = 20
QUERY_BYTES_MAX = 64 * 1024

COLUMNS = (
    "id", "pane_id", "host", "agent", "cwd", "label", "project",
    "kind", "origin", "text", "tail", "range_start", "range_end",
    "status_from", "status_to", "at", "at_src", "decision_id",
)


# How many members one question may name. A conversation's roster is what asks, and the app stops
# calling several panes one thread well before this — the bound is here so the size of the WHERE
# clause stays this module's decision rather than the caller's.
FINGERPRINTS_MAX = 16


def fingerprints_from(raw):
    """The (host, agent, cwd) triples a client asked for, or None for "no fingerprint filter".

    A member is pinned by fingerprint and not by a pane id — herdr changes those on every restart —
    so this is how a client asks the record for "these members" in one query. Shape-checked and
    bounded here, because what it feeds is a WHERE clause built from the list's own length: the
    values are always parameterised, and this is what keeps the *shape* off the wire too.
    """
    if not isinstance(raw, list):
        return None
    out = []
    for fp in raw[:FINGERPRINTS_MAX]:
        if (isinstance(fp, (list, tuple)) and len(fp) == 3
                and all(x is None or isinstance(x, str) for x in fp)):
            out.append((fp[0] or "local", fp[1] or "", fp[2] or ""))
    return out or None


def db_path():
    """Where the record lives, matching the relay's own resolution order."""
    explicit = os.environ.get("HERDR_ARBITER_DB")
    if explicit:
        return explicit
    root = Path(__file__).resolve().parents[1]
    state = os.environ.get("HERDR_STATE_DIR") or str(root / ".herdr-remote")
    return os.path.join(state, "arbitration.sqlite3")


def open_ro(path):
    """A read-only handle. Raises if the file is not there — an empty record and a missing one
    are different answers and the caller deserves to know which it got."""
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def query(conn, *, pane=None, host=None, agent=None, cwd=None, kind=None,
          grep=None, since=None, until=None, fingerprints=None, last=QUERY_ROWS_DEFAULT):
    """Turns matching the selectors, oldest first, bounded.

    Selectors are AND-ed. `fingerprints` is a list of (host, agent, cwd) triples — how a session
    asks for its roster, since a member is pinned by fingerprint and not by a pane id that herdr
    changes on every restart.

    Returns (rows, truncated). The rows are the *newest* `last` matches, handed back in reading
    order: a conversation is read forwards, and the interesting end of a long one is the recent
    end.
    """
    where, args = [], []
    if pane:
        where.append("pane_id = ?")
        args.append(pane)
    if host:
        where.append("host = ?")
        args.append(host)
    if agent:
        where.append("agent = ?")
        args.append(agent)
    if cwd:
        where.append("cwd = ?")
        args.append(cwd)
    if kind:
        where.append("kind = ?")
        args.append(kind)
    if grep:
        where.append("lower(text) LIKE ?")
        args.append("%" + str(grep).lower() + "%")
    if since is not None:
        where.append("at >= ?")
        args.append(int(since))
    if until is not None:
        where.append("at <= ?")
        args.append(int(until))
    if fingerprints:
        ors = " OR ".join("(host = ? AND agent = ? AND cwd = ?)" for _ in fingerprints)
        where.append("(" + ors + ")")
        for fp in fingerprints:
            args.extend([fp[0] or "local", fp[1] or "", fp[2] or ""])

    limit = max(1, min(int(last or QUERY_ROWS_DEFAULT), QUERY_ROWS_MAX))
    sql = "SELECT " + ", ".join(COLUMNS) + " FROM turns"
    if where:
        sql += " WHERE " + " AND ".join(where)
    # Newest first to apply the limit, then reversed: ORDER BY at DESC with the tie broken by id
    # DESC is the exact mirror of the (at, id) reading order, so the window is contiguous.
    sql += " ORDER BY at DESC, id DESC LIMIT ?"
    args.append(limit + 1)

    got = [dict(r) for r in conn.execute(sql, args).fetchall()]
    truncated = len(got) > limit
    rows = list(reversed(got[:limit]))

    # The byte bound drops from the front, because the recent end is the end that matters.
    total = 0
    kept = []
    for row in reversed(rows):
        total += len(row.get("text") or "") + len(row.get("tail") or "")
        if total > QUERY_BYTES_MAX and kept:
            truncated = True
            break
        kept.append(row)
    return list(reversed(kept)), truncated


def as_wire(row):
    """One turn in the shape the WebSocket answer uses."""
    out = {k: row[k] for k in
           ("pane_id", "host", "agent", "cwd", "label", "project",
            "kind", "origin", "text", "tail", "at", "at_src", "decision_id")}
    out["seq"] = row["id"]
    out["range"] = ([row["range_start"], row["range_end"]]
                    if row["range_start"] is not None else None)
    return out


def format_text(rows, truncated):
    """What an agent reads in its own terminal."""
    out = []
    for row in rows:
        when = time.strftime("%H:%M:%S", time.localtime((row["at"] or 0) / 1000))
        who = " ".join(x for x in (row["agent"], row["cwd"], row["label"]) if x)
        out.append(f"[{row['id']:04d}] {when}  {who}  {row['kind']}  ({row['at_src']})")
        out.append(row["text"] or (row["tail"] and "(no message detected; pane tail)\n" + row["tail"])
                   or "(nothing recorded)")
        out.append("")
    if truncated:
        out.append(f"— truncated at {QUERY_ROWS_MAX} turns or {QUERY_BYTES_MAX // 1024} KB. "
                   "Narrow it with --grep, --since or --agent.")
    return "\n".join(out) if out else "(no turns matched)"


def main(argv=None):
    p = argparse.ArgumentParser(description="Read the herdr-remote conversation record.")
    p.add_argument("--db", default=None, help="database path (default: the relay's)")
    p.add_argument("--pane", help="one pane id, as currently observed")
    p.add_argument("--host", help="one host")
    p.add_argument("--agent", help="one harness kind: claude, codex, …")
    p.add_argument("--cwd", help="one working directory")
    p.add_argument("--kind", help="agent_final, human_prompt, arbitrated, …")
    p.add_argument("--grep", help="case-insensitive substring over the message text")
    p.add_argument("--since", type=int, help="epoch ms; turns at or after this")
    p.add_argument("--until", type=int, help="epoch ms; turns at or before this")
    p.add_argument("--last", type=int, default=QUERY_ROWS_DEFAULT,
                   help=f"how many, newest kept (max {QUERY_ROWS_MAX})")
    p.add_argument("--format", choices=("text", "json"), default="text")
    args = p.parse_args(argv)

    try:
        conn = open_ro(args.db or db_path())
    except (FileNotFoundError, sqlite3.Error) as e:
        print(f"no conversation record to read: {e}", file=sys.stderr)
        return 2
    with conn:
        rows, truncated = query(
            conn, pane=args.pane, host=args.host, agent=args.agent, cwd=args.cwd,
            kind=args.kind, grep=args.grep, since=args.since, until=args.until, last=args.last)
    if args.format == "json":
        print(json.dumps({"turns": [as_wire(r) for r in rows], "truncated": truncated},
                         indent=2))
    else:
        print(format_text(rows, truncated))
    return 0


if __name__ == "__main__":
    sys.exit(main())
