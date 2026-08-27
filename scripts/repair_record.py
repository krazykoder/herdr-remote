#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# ///
"""One-shot repair of rows the record wrote before the parser knew better.

Two faults, both fixed in the code that writes new rows and neither of them retroactive:

  * **A harness footer recorded as the agent's words.** agy has no speaker glyph, so a block is
    positional — and its right-aligned model and credit line under a rule at the foot of the pane
    matched that shape. Turns where agy had not answered yet were recorded as agy saying
    `Gemini 3.7 Flash · medium · AI: Out of credits`, which went into the thread and into the
    prompt an arbitrator was asked to decide on. `pane_summary.transcript` stops it happening
    again; these rows are already written.
  * **A prompt merged into the answer under it.** Same missing glyph: a pasted prompt is drawn the
    way a reply is drawn, so an agent that answered without running a tool first produced one block
    holding the instruction and the answer, filed as the agent's own words.
    `conversation_log._split_echo` cuts that at write time now, against the send the relay knows it
    made — and that is exactly what this uses to cut the rows already in the table.

Dry run unless `--apply`, which copies the database beside itself first. Safe to run against a live
relay: every write is one short transaction, and nothing here touches a row another writer could be
mid-way through — these rows are minutes to weeks old.

    uv run scripts/repair_record.py                     # what would change
    uv run scripts/repair_record.py --apply             # change it
    uv run scripts/repair_record.py --drop-echoes       # also drop rows that are *only* an echo
    uv run scripts/repair_record.py --dupes             # a third fault: the same message recorded
                                                        # twice on one pane, when a block boundary
                                                        # moved between two reads. Marks rather
                                                        # than deletes. See `dupes`.
"""
import argparse
import collections
import json
import os
import re
import subprocess
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from conversation_log import (ANCHOR_CONTEXT, SENT_LOOKBACK,     # noqa: E402
                              _is_echo, _key, _split_echo, _who)
from conv_query import _col                                     # noqa: E402
from pane_summary import pane_messages                          # noqa: E402

DEFAULT_DB = ROOT / ".herdr-remote" / "arbitration.sqlite3"

# A pane's own chrome, recorded as something it said. Exact shapes rather than a heuristic: this
# deletes rows, and a rule that guesses would delete an agent that happens to write in the same
# shape. Each one is a status bar, a key hint or a picker footer — none of them is ever a message.
CHROME = (
    re.compile(r"^[\w.\- ]+ · (?:low|medium|high|max)(?: · .+)?$"),   # agy's model and credit bar
    re.compile(r"^↑/↓ Navigate · enter Select · tab Complete$"),
    re.compile(r"^esc Interrupt · ctrl\+\w+ .+$"),
)

# Lines that are chrome only in a row that is chrome anyway. A picker drawn over the transcript
# reads back as its own empty state plus the key hints under it, and deleting "No matches" on its
# own would delete an agent that answered a question with those two words.
CHROME_WITH = (re.compile(r"^No matches$"),)

# How much of a row has to be the prompt for the row to be nothing but its echo. Not a full match:
# a terminal drops what will not fit and re-wraps what it keeps, so the tail of a long paste is
# often missing from the pane it was read back out of.
ECHO_RATIO = 0.9


def is_chrome(text):
    """Every line of this row is the pane's own furniture, and one of them proves it.

    Whole rows only. A footer that ran into a real message is a *different* fault — the block
    boundary was wrong, not the row — and cutting text out of a row here would be guessing at where
    the agent started talking with none of the evidence `_split_echo` has.
    """
    lines = [ln.strip() for ln in (text or "").splitlines() if ln.strip()]
    if not lines:
        return False
    return (all(any(p.match(ln) for p in CHROME + CHROME_WITH) for ln in lines)
            and any(any(p.match(ln) for p in CHROME) for ln in lines))


def sent_before(conn, row):
    """The prompts this pane was sent before this row was written, newest first.

    Same shape as `ConversationLog._sent_texts`, over history rather than over a live pane: by
    `pane_id` where the row has one, which is the sharpest identity there is, and never across
    panes — cutting a row against another pane's prompt is how a repair invents damage.
    """
    return [r[0] for r in conn.execute(
        "SELECT text FROM turns WHERE pane_id = ? AND at_src = 'sent' AND text != ''"
        " AND id < ? ORDER BY id DESC LIMIT ?", (row["pane_id"], row["id"], SENT_LOOKBACK))]


def unmerge_sent(fresh, sent):
    """The repair's port of ConversationLog._unmerge_sent for a live pane read."""
    out = []
    for who, text, span in fresh:
        split = next((s for s in (_split_echo(text, prompt) for prompt in sent) if s), None) \
            if who == "agent" else None
        if split:
            out.extend((("user", split[0], span), ("agent", split[1], span)))
        else:
            out.append((who, text, span))
    return out


def is_echo(text, sent):
    """Is this row nothing but the echo of one of those prompts?

    `_split_echo` answers "prompt, then the agent" and returns nothing when there is no agent half.
    That case is this one: a row that is the instruction and nothing else, in the agent's voice.
    """
    key = _key(text)
    if len(key) < 80:
        return False
    return any(key in _key(s) or (_key(s) and len(key) >= ECHO_RATIO * len(_key(s))
                                  and _key(s)[:len(key)] == key) for s in sent)


def plan(conn, drop_echoes):
    """What would change, as (kind, row, new_text) — nothing is written here."""
    rows = conn.execute(
        "SELECT * FROM turns WHERE origin = 'agent' AND text != '' ORDER BY id").fetchall()
    out = []
    for row in rows:
        if is_chrome(row["text"]):
            out.append(("chrome", row, None))
            continue
        sent = sent_before(conn, row)
        if not sent:
            continue
        split = next((s for s in (_split_echo(row["text"], t) for t in sent) if s), None)
        if split:
            out.append(("split", row, split[1]))
        elif drop_echoes and is_echo(row["text"], sent):
            out.append(("echo", row, None))
    return out


def dupes(conn):
    """Rows the writer would not write today: the same message recorded twice on one pane.

    Two faults, both of them a block boundary that moved between two reads of the same pane:

      * the window re-blocked what the record holds as separate messages, so no offset aligned and
        the last-resort rule wrote the closing block a second time — 938 identical bytes, three
        minutes apart, in the session this was measured on;
      * a prompt was echoed back with screen caught under it in the same block, so its key was the
        send's key plus a tail and the equality test for an echo missed it.

    Both are fixed in `conversation_log` for rows written from now on. This is the same predicate,
    replayed over the rows already in the table, so what it leaves behind is what the fixed writer
    would have produced.

    Bounded exactly as the writer is bounded: a row is compared against the last ANCHOR_CONTEXT
    messages read off *that pane* and the last SENT_LOOKBACK prompts sent to it, and against
    nothing else. That bound is the whole safety argument — an agent that genuinely says the same
    thing again an hour and forty turns later is not inside it, and is kept. Measured over the live
    record: of 218 exact-key pairs within five rows of each other, 35 were more than an hour apart.

    Exact tests only, no similarity score. Every real duplicate measured was either an exact key
    match or an exact prefix; 661 pairs scored above 0.80 similarity and were different messages,
    two of them sharing no common prefix at all. A threshold would delete those.

    A row this relay *sent* is never a candidate: it is the relay's own record of what it typed,
    and it is the copy that should survive. The lowest id always wins.

    Nothing is deleted. The copy is marked with the row it repeats, which takes it out of every
    read that does not ask for it and leaves the record still holding everything that was ever
    detected — the same thing the writer does with a copy today.
    """
    out = []
    kept = collections.defaultdict(
        lambda: (collections.deque(maxlen=ANCHOR_CONTEXT), collections.deque(maxlen=SENT_LOOKBACK)))
    for row in conn.execute("SELECT * FROM turns WHERE text != '' ORDER BY id"):
        anchor, sent = kept[row["pane_id"]]
        who, key = _who(row["kind"]), _key(row["text"])
        if _col(row, "dupe_of"):
            continue        # already marked. A copy anchors nothing, and a second run is a no-op
        if row["at_src"] == "sent":
            if who == "user":
                sent.append((key, row["id"], row["at"]))
            continue
        hit = next((a for a in reversed(anchor) if a[0] == (who, key)), None) \
            or (next((s for s in reversed(sent) if _is_echo(key, {s[0]})), None)
                if who == "user" else None)
        if hit:
            # What it matched and how long ago, because that is the one thing the reviewer cannot
            # work out from the row itself — and the gap is what separates a window read twice in
            # one turn from an agent that really did say the same words again the next morning.
            out.append(("dupe", row, hit[1], round((row["at"] - hit[2]) / 1000)))
            continue
        anchor.append(((who, key), row["id"], row["at"]))
    return out


def snapshot(conn, db):
    """sqlite's own backup, not a file copy: this database runs in WAL mode under a live relay, and
    the pages a copy of the main file would miss are exactly the newest turns in it."""
    path = f"{db}.bak-{int(time.time())}"
    with sqlite3.connect(path) as dst:
        conn.backup(dst)
    return path


def show(actions):
    for kind, row, new, *rest in actions:
        one = " ".join((row["text"] or "").split())
        print(f"  [{kind}] id={row['id']} {row['agent']} {row['pane_id']} "
              f"{row['label'] or '-'}  {one[:80]}")
        if kind == "dupe":
            print(f"          copy of id={new}, {rest[0]}s earlier")
        elif new:
            print(f"          keeps: {' '.join(new.split())[:80]}")


def apply(conn, actions):
    have = {r[1] for r in conn.execute("PRAGMA table_info(turns)")}
    if "dupe_of" not in have and any(a[0] == "dupe" for a in actions):
        conn.execute("ALTER TABLE turns ADD COLUMN dupe_of INTEGER")
    with conn:
        for kind, row, new, *_ in actions:
            if kind == "split":
                conn.execute("UPDATE turns SET text = ? WHERE id = ?", (new, row["id"]))
            elif kind == "dupe":
                # Marked, never deleted: the record is what was detected, and a copy that is out of
                # the way is out of the way.
                conn.execute("UPDATE turns SET dupe_of = ? WHERE id = ?", (new, row["id"]))
            else:
                conn.execute("DELETE FROM turns WHERE id = ?", (row["id"],))


# --- Messages the record never saw ---


def herdr(*args):
    out = subprocess.run([os.environ.get("HERDR_BIN", "/opt/homebrew/bin/herdr"), *args],
                         capture_output=True, text=True, check=True)
    return out.stdout


def pane_now(pane_id, lines):
    """The pane, and what the record calls it. Read from herdr rather than taken on trust: a repair
    that guesses a pane's agent parses its transcript with the wrong glyphs."""
    info = json.loads(herdr("pane", "get", pane_id))["result"]["pane"]
    rows = herdr("pane", "read", pane_id, "--source", "recent-unwrapped",
                 "--lines", str(lines)).splitlines()
    return info, rows


# How much of a message identifies it. See `missed`.
HEAD_KEY = 80


def head(text):
    return _key(text)[:HEAD_KEY]


def missed(conn, pane_id, rows, agent):
    """Messages the pane still shows that the record has no row for, dated between its neighbours.

    Only the gaps *between* recorded messages. A message newer than everything recorded is the turn
    in progress, and the relay writes that one itself when the turn ends — filling it here would
    race a live writer to say the same thing.
    """
    # Matched on the opening of a message rather than the whole of it. The rows already in the
    # table were parsed by the code that had the bug, and a block whose end was read differently is
    # the *same* message with a different tail — matching on all of it would call that missing and
    # write a second copy of something the record already holds, which is the one outcome a repair
    # must not have. Eighty characters in, two different messages have parted company.
    # Two questions, two sets. *Recorded* is every row: a prompt is in the record from the moment it
    # was sent, and its echo in the pane is not a message the record is missing. *Anchor* is only
    # the rows that were read off the pane, because those are the ones a window position can be
    # trusted against — a send is written before the reply it triggers, so anchoring on one turns
    # the turn in progress into a gap and fills the record with half a message the relay is about
    # to write properly.
    rows_out = conn.execute(
        "SELECT text, at, at_src FROM turns WHERE pane_id = ? AND text != '' ORDER BY id",
        (pane_id,)).fetchall()
    recorded = {head(r[0]) for r in rows_out}
    anchor = {head(r[0]): r[1] for r in rows_out if r[2] != "sent"}
    sent = [r[0] for r in conn.execute(
        "SELECT text FROM turns WHERE pane_id = ? AND at_src = 'sent' AND text != ''"
        " ORDER BY at DESC, id DESC LIMIT ?", (pane_id, SENT_LOOKBACK))]
    fresh = unmerge_sent(pane_messages(rows, agent), sent)
    # Anchored at both ends: a run of unrecorded messages is dated between the recorded message
    # before it and the recorded message after it, which is all that can honestly be claimed.
    marks = [i for i, m in enumerate(fresh) if head(m[1]) in anchor]
    if len(marks) < 2:
        return []
    out = []
    for a, b in zip(marks, marks[1:]):
        run = [i for i in range(a + 1, b) if head(fresh[i][1]) not in recorded]
        if not run:
            continue
        lo, hi = anchor[head(fresh[a][1])], anchor[head(fresh[b][1])]
        step = max(1, (hi - lo) // (len(run) + 1))
        for n, i in enumerate(run, 1):
            who, text, span = fresh[i]
            out.append((who, text, span, min(lo + n * step, hi - 1)))
    return out


def backfill(conn, pane_id, lines, apply_it):
    info, rows = pane_now(pane_id, lines)
    agent = info.get("agent") or ""
    found = missed(conn, pane_id, rows, agent)
    print(f"{pane_id} ({agent}, {info.get('label') or '-'}): {len(found)} message(s) the record "
          f"never saw")
    for who, text, span, at in found:
        when = time.strftime("%H:%M:%S", time.localtime(at / 1000))
        print(f"  [{who}] {when} rows {span[0]}-{span[1]}  {' '.join(text.split())[:70]}")
    if not found or not apply_it:
        return bool(found)
    for who, text, span, at in found:
        # `backfill` is the honest stamp: the order is what this recovers, and the time is an
        # interpolation between two rows that do carry one. `human_terminal` for the same reason
        # the writer uses it — the relay knows a person typed this and not which person (N4).
        conn.execute(
            "INSERT INTO turns (host, agent, cwd, pane_id, label, project, kind, origin, text,"
            " range_start, range_end, at, at_src) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'backfill')",
            (info.get("host") or "local", agent, info.get("cwd") or "", pane_id,
             info.get("label") or "", "",
             "agent_final" if who == "agent" else "human_prompt",
             "agent" if who == "agent" else "human_terminal",
             text, span[0], span[1], at))
    conn.commit()
    return True


def self_check():
    """The rules, against the shapes they were written for. Run it before trusting a delete."""
    assert is_chrome("Gemini 3.7 Flash · medium · AI: Out of credits")
    assert is_chrome("Gemini 3.7 Flash · medium")
    assert is_chrome("No matches\n\n↑/↓ Navigate · enter Select · tab Complete")
    # A message is never chrome, however it is punctuated, and neither is a picker's empty state
    # on its own — an agent may answer a question with those two words.
    assert not is_chrome("### Review passes.\n\nGemini 3.7 Flash · medium")
    assert not is_chrome("No matches")
    assert not is_chrome("Done · shipped")
    # Long enough to be a candidate, and not repetitive: the cut is made at the first place the
    # prompt's own tail turns up, so a prompt that says the same forty characters twice is cut at
    # the first of them. Which is the harmless way to be wrong — it leaves prompt on the agent's
    # row rather than taking the agent's words off it.
    prompt = ("Review the footer change: web/index.html and web/src/summary_detect.js, and the two "
              "fixtures under tests. Say plainly whether it passes, and name a file and a line if "
              "it does not.")
    assert _split_echo(prompt + "\n\n### It passes.", prompt) == (prompt.strip(), "### It passes.")
    assert _split_echo("### It passes.", prompt) is None
    assert unmerge_sent([("agent", prompt + "\n\n### It passes.", (1, 4))], [prompt]) == [
        ("user", prompt, (1, 4)), ("agent", "### It passes.", (1, 4))]
    assert is_echo(prompt, [prompt])
    assert not is_echo("### It passes.", [prompt])
    # The two duplicate shapes, and the two things that must survive them.
    assert _is_echo(_key(prompt + "\nb1759cb fix(backup): publish only complete copies"),
                    {_key(prompt)})
    assert not _is_echo(_key("continue with the footer"), {_key("continue")})
    print("self-check ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--apply", action="store_true", help="write the changes (a copy is kept)")
    ap.add_argument("--drop-echoes", action="store_true",
                    help="also delete rows that are only a prompt echo, with nothing said under it")
    ap.add_argument("--dupes", action="store_true",
                    help="mark rows the same pane already had, instead of the repairs above")
    ap.add_argument("--self-check", action="store_true", help="prove the rules and exit")
    ap.add_argument("--backfill", metavar="PANE_ID",
                    help="read this pane and add the messages the record has no row for")
    ap.add_argument("--lines", type=int, default=400, help="how much pane to read for --backfill")
    args = ap.parse_args()

    if args.self_check:
        return self_check()
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    if args.backfill:
        if args.apply:
            print(f"backup: {snapshot(conn, args.db)}")
        backfill(conn, args.backfill, args.lines, args.apply)
        if not args.apply:
            print("\nDry run. Pass --apply to write.")
        return
    if args.dupes:
        actions = dupes(conn)
        print(f"{args.db}: {len(actions)} duplicate row(s) to mark")
    else:
        actions = [(k, r, n, None) for k, r, n in plan(conn, args.drop_echoes)]
        counts = {k: sum(1 for a in actions if a[0] == k) for k in ("chrome", "split", "echo")}
        print(f"{args.db}: {counts['split']} merged, {counts['chrome']} chrome, "
              f"{counts['echo']} echo-only")
    show(actions)
    if not actions or not args.apply:
        print("\nDry run. Pass --apply to write." if actions else "\nNothing to repair.")
        return
    backup = snapshot(conn, args.db)
    apply(conn, actions)
    print(f"\nWritten. Copy of the record as it was: {backup}")


if __name__ == "__main__":
    main()
