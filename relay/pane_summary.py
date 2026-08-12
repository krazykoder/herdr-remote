#!/usr/bin/env python3
"""Which lines of a pane are the agent's closing message.

A port of the detector in web/index.html — the block under `// --- Final message detection ---`.
The browser uses it to offer a Summary; the relay uses it so a Lock Screen says what the agent
concluded rather than whatever three lines happened to be at the bottom of the pane.

Both copies read one character per line and never a word of the content. Both are driven by the
same fixtures in tests/fixtures/pane_*_done.txt, which is what a second copy of a parser has to
have: tests/test_summary_detect.js and tests/test_pane_summary.py assert the same line ranges over
the same bytes, so a harness that changes its glyphs — or a change made to one copy and not the
other — breaks a test rather than a user.

Deliberately not ported: the learned speaker glyph and the learned trim. Both are one browser's
preferences, held in that browser's localStorage, and the relay has no user to have taught it
anything. A harness with no shipped profile gets no summary here, which is the same answer the
browser gives before anyone presses Learn.

Pure module — no I/O, no herdr calls, no relay state.
"""
import re

# The character a harness prints in its gutter column, per speaker.
#
#   speaker  opens a block. None means the harness has no glyph for its own replies and a block
#            start is positional instead — see starts_block.
#   result   hangs under a block that ran something. A block with one of these under it is a tool
#            execution and not something the agent said.
#   user     the prompt gutter.
#   ends     closes the block above it without making that block an execution.
#   indent   which column the gutter lives in. pi indents its whole transcript by one space.
#   composer False when the prompt gutter marks sent messages only, so the newest reply is *below*
#            the last one rather than above it.
#   messages False when the harness draws no boundary between its reasoning and its answer, so
#            there is no block to find. Those panes get no summary at all.
#   opens    which column-0 lines a positional block may follow.
#   end_line a line that closes a block on its content rather than on its gutter.
#   user_line a callable (row, rows, i) -> bool, for a harness whose prompt cannot be read off one
#            character. Takes precedence over `user`.
GUTTERS = {
    "claude": {"speaker": "⏺", "result": ["⎿"], "user": ["❯", ">"]},
    "codex": {"speaker": "•", "result": ["└", "│"], "user": ["›"]},
    "pi": {"speaker": "⏺", "result": ["$"], "user": ["›"], "ends": ["⋯"],
           "indent": 1, "composer": False},
    "agy": {"speaker": None, "result": [], "user": [">"], "opens": [">", "●", "▸", "─"]},
}

_OPENCODE_BAR = re.compile(r"^\s*┃")
_OPENCODE_TEXT = re.compile(r"^\s*┃\s+\S")
_OPENCODE_CMD = re.compile(r"^\s*┃\s+\$")
_OPENCODE_CLOSE = re.compile(r"^\s*╹")


def _opencode_user_line(row, rows, i):
    """Whether this `┃` line is the user's, on a harness that puts everything behind one bar.

    Which `┃` is yours is a question about the whole run, not the line. A run holding a `$` is a
    command and everything under it is that command's output; a run closed by `╹` is the composer
    box at the foot; and a run reaching the top of what was read was cut off mid-block, so its
    opener is not here to check.
    """
    row = row or ""
    if not _OPENCODE_TEXT.match(row) or _OPENCODE_CMD.match(row):
        return False
    if rows is None:
        return False
    j = i - 1
    while j >= 0 and _OPENCODE_BAR.match(rows[j] or ""):
        if _OPENCODE_CMD.match(rows[j] or ""):
            return False
        j -= 1
    if j < 0:
        return False        # run cut off by the top of the read
    k = i + 1
    while k < len(rows) and _OPENCODE_BAR.match(rows[k] or ""):
        k += 1
    return not _OPENCODE_CLOSE.match(rows[k] if k < len(rows) else "")


GUTTERS["opencode"] = {
    "speaker": None, "result": [], "messages": False,
    "end_line": re.compile(r"^\s*Thought:"), "user_line": _opencode_user_line,
}


def profile_for(agent):
    return GUTTERS.get(agent)


def _gutter_of(row, g):
    """The character in the harness's gutter column, or '' on a line too short to have one."""
    i = g.get("indent") or 0
    row = row or ""
    return row[i] if len(row) > i else ""


def ends_block(row, g):
    """Does this row close the block above it? Anything in column 0 does.

    An indented harness needs the second clause, and only an indented harness has it. claude and
    codex hang-indent a wrapped line past their gutter, so column 0 alone separates a continuation
    from a marker. pi does not: its continuation lines sit in the same column its glyphs do.
    """
    row = row or ""
    end_line = g.get("end_line")
    if end_line and end_line.match(row):
        return True
    if row[:1].strip():
        return True
    if not g.get("indent"):
        return False
    ch = _gutter_of(row, g)
    return (ch == g.get("speaker") or ch in (g.get("user") or [])
            or ch in g.get("result", []) or ch in (g.get("ends") or []))


def starts_block(rows, g, i):
    """Does a block start here?

    On every harness but agy that is one character in the gutter. agy has no speaker glyph, so its
    answer is positional: the first indented line under a column-0 line that agy itself printed.
    `opens` is that last clause and it is load-bearing — without it the shell command that launched
    agy opens a block and its startup banner is read as the pane's first message.
    """
    row = rows[i] or "" if i < len(rows) else ""
    if g.get("speaker"):
        return _gutter_of(row, g) == g["speaker"]
    if not row.strip() or row[:1].strip():
        return False
    for j in range(i - 1, -1, -1):
        above = rows[j] or ""
        if not above.strip():
            continue
        opens = g.get("opens")
        return bool(above[:1].strip()) and (not opens or above[0] in opens)
    return False        # nothing above it, so nothing opened it


def block_span(rows, g, start):
    """How far a block starting on `start` runs, or None when it turns out to be a tool execution.

    It ends at the next line with anything at all in column 0. Blank lines stay inside it: Codex
    closes with three paragraphs, and ending on the first blank would take only the last one.
    """
    end = start
    for j in range(start + 1, len(rows)):
        line = (rows[j] or "").lstrip()
        # Tested before the end check: on an indented harness a result glyph is itself an end.
        if line and line[0] in g.get("result", []):
            return None
        if ends_block(rows[j], g):
            break
        if line:
            end = j
    return (start, end)


def is_user_input(row, agent, rows=None, i=0):
    g = profile_for(agent)
    if not g:
        return False
    user_line = g.get("user_line")
    if user_line and user_line(row, rows, i):
        return True
    return _gutter_of(row, g) in (g.get("user") or [])


def last_user_input(rows, agent):
    for i in range(len(rows or []) - 1, -1, -1):
        if is_user_input(rows[i], agent, rows, i):
            return i
    return -1


def final_message(rows, agent):
    """The last block above the latest user prompt, as (start, end), or None.

    None when the harness has no profile, when that block ran a tool, or when the harness draws no
    boundary between its reasoning and its answer. Deliberately not "the last block that didn't
    run a tool": an agent that stopped after a command has no closing message, and walking further
    up would offer something it said before doing work it has not reported on.
    """
    g = profile_for(agent)
    if not g or not rows or g.get("messages") is False:
        return None
    last_input = -1 if g.get("composer") is False else last_user_input(rows, agent)
    before = len(rows) if last_input < 0 else last_input
    for i in range(before - 1, -1, -1):
        if starts_block(rows, g, i):
            return block_span(rows, g, i)
    return None


# The gutter glyph, the box side it may sit inside, and the leading whitespace — stripped so the
# text starts at the text. Shares its intent with notify_body's _LEAD in the relay, and not its
# characters: this runs over lines already known to be one message, so it has no prompts or box
# rules to recognise, only a margin to remove.
_MARGIN = re.compile(r"^[\s│┃⏺•❯>›⋯]+")


def summary_body(content, agent, limit=140):
    """The agent's closing message as one line of push text, or None if there is not one.

    None is the caller's signal to fall back — a harness with no profile, a pane that ended on a
    command, and a pane whose last block is empty all reach it, and on every one of them the
    bottom-of-the-pane reading is the better answer rather than a worse one.
    """
    rows = (content or "").splitlines()
    at = final_message(rows, agent)
    if not at:
        return None
    kept = [_MARGIN.sub("", rows[i].rstrip().rstrip("│┃")).strip() for i in range(at[0], at[1] + 1)]
    text = " ".join(line for line in kept if line)
    if not text:
        return None
    return text[:limit - 1] + "…" if len(text) > limit else text
