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
"""
import argparse
import re
import sqlite3
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from conversation_log import SENT_LOOKBACK, _key, _split_echo   # noqa: E402

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


def show(actions):
    for kind, row, new in actions:
        one = " ".join((row["text"] or "").split())
        print(f"  [{kind}] id={row['id']} {row['agent']} {row['pane_id']} "
              f"{row['label'] or '-'}  {one[:80]}")
        if new:
            print(f"          keeps: {' '.join(new.split())[:80]}")


def apply(conn, actions):
    with conn:
        for kind, row, new in actions:
            if kind == "split":
                conn.execute("UPDATE turns SET text = ? WHERE id = ?", (new, row["id"]))
            else:
                conn.execute("DELETE FROM turns WHERE id = ?", (row["id"],))


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
    assert is_echo(prompt, [prompt])
    assert not is_echo("### It passes.", [prompt])
    print("self-check ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--apply", action="store_true", help="write the changes (a copy is kept)")
    ap.add_argument("--drop-echoes", action="store_true",
                    help="also delete rows that are only a prompt echo, with nothing said under it")
    ap.add_argument("--self-check", action="store_true", help="prove the rules and exit")
    args = ap.parse_args()

    if args.self_check:
        return self_check()
    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    actions = plan(conn, args.drop_echoes)
    counts = {k: sum(1 for a in actions if a[0] == k) for k in ("chrome", "split", "echo")}
    print(f"{args.db}: {counts['split']} merged, {counts['chrome']} chrome, "
          f"{counts['echo']} echo-only")
    show(actions)
    if not actions or not args.apply:
        print("\nDry run. Pass --apply to write." if actions else "\nNothing to repair.")
        return
    # sqlite's own backup, not a file copy: this database runs in WAL mode under a live relay, and
    # the pages a copy of the main file would miss are exactly the newest turns in it.
    backup = f"{args.db}.bak-{int(time.time())}"
    with sqlite3.connect(backup) as dst:
        conn.backup(dst)
    apply(conn, actions)
    print(f"\nWritten. Copy of the record as it was: {backup}")


if __name__ == "__main__":
    main()
