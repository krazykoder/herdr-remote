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
#   chrome   the harness's empty composer line. Nothing below it is transcript — see `_in_chrome`.
GUTTERS = {
    "claude": {"speaker": "⏺", "result": ["⎿"], "user": ["❯", ">"]},
    "codex": {"speaker": "•", "result": ["└", "│"], "user": ["›"]},
    "pi": {"speaker": "⏺", "result": ["$"], "user": ["›"], "ends": ["⋯"],
           "indent": 1, "composer": False},
    "agy": {"speaker": None, "result": [], "user": [">"], "opens": [">", "●", "▸", "─"],
            "chrome": ">"},
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


# How far above the bottom of a read the live composer may be found. The footer is a rule, an empty
# input line, one or two blanks and a status bar; ten rows covers that and stops a genuinely empty
# prompt in the middle of a transcript from cutting the window in half.
CHROME_ROWS = 10


def transcript(rows, g):
    """The rows above the live composer — the pane's transcript, without its own footer.

    agy right-aligns a model and credit line under a rule at the foot of the pane, and a positional
    harness reads *any* indented line under a column-0 line as the start of a message. So the pane's
    chrome was read as agy's closing words: a turn where agy had not answered yet was recorded as
    agy saying `Gemini 3.7 Flash · medium · AI: Out of credits`, and that went into the record, into
    the thread, and into the prompt the arbitrator was asked to decide on. Worse than junk — it is
    junk that reads like an answer, and the arbitrator called a human over it three times.

    The *empty* composer only. A `>` with text after it is a prompt in the transcript and cannot be
    told from the live one by shape, so it is not a cut point.

    Trimmed from the end, so every index into the result is an index into the pane — the spans this
    module returns are read back against the caller's own rows.
    """
    mark = (g or {}).get("chrome")
    if not mark or not rows:
        return rows
    for j in range(len(rows) - 1, max(-1, len(rows) - 1 - CHROME_ROWS), -1):
        if (rows[j] or "").rstrip() == mark:
            # Inclusive: the composer line is the anchor `final_message` reads back from — the
            # newest prompt — and it carries no text of its own to be mistaken for one.
            return rows[:j + 1]
    return rows


def starts_block(rows, g, i):
    """Does a block start here?

    On every harness but agy that is one character in the gutter. agy has no speaker glyph, so its
    answer is positional: the first indented line under a column-0 line that agy itself printed.
    `opens` is that last clause and it is load-bearing — without it the shell command that launched
    agy opens a block and its startup banner is read as the pane's first message.

    The column-0 line above is not always the marker, though: agy wraps its own tool-call lines and
    the continuation lands back in column 0 with no glyph on it —

        ● Bash(git commit -m "Refactor frontend JS into functional...) (ctrl+o to
        expand)

    — so the run of column-0 lines is walked back to the marker that opened it.

    The prompt gutter wraps too, and its continuation is indented rather than column-0, which makes
    it indistinguishable from a reply by shape alone. A blank line is what tells them apart: agy
    answers a prompt through a tool call or a thought, never off the next row, so an indented line
    touching a `>` is the rest of what the user typed.
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
        if not opens:
            return bool(above[:1].strip())
        gap = j < i - 1
        for k in range(j, -1, -1):
            line = rows[k] or ""
            if not line.strip() or not line[:1].strip():
                return False
            if line[0] in opens:
                return gap or line[0] not in (g.get("user") or [])
        return False
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
    rows = transcript(rows, g)
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


def _stripped(rows, at):
    """The lines of a detected block, margins removed, empties dropped."""
    return [line for line in
            (_MARGIN.sub("", rows[i].rstrip().rstrip("│┃")).strip() for i in range(at[0], at[1] + 1))
            if line]


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
    text = " ".join(_stripped(rows, at))
    if not text:
        return None
    return text[:limit - 1] + "…" if len(text) > limit else text


# --- Everything said in a window ---
#
# `final_message` above answers "what is the closing message", which is what a Lock Screen asks.
# A *record* asks something wider, and the browser's recorder has always answered it: a turn is
# minutes of work and the agent narrates it — what it is about to do, what a test reported, what it
# found on the way — and a transcript holding only the closing line of each turn is a transcript of
# conclusions with the reasoning cut out. The user's own prompts are the other half, and a prompt
# typed straight into the terminal is one no send event will ever report.
#
# Ported from `messageBlocks` and `userInputLines` in web/src/summary_detect.js and `convText` and
# `paneMessages` in web/src/conversation_pure.js. Same rule and same fixtures as the detector above,
# for the same reason: a change made to one copy and not the other breaks a test rather than a user.


def message_blocks(rows, agent):
    """Every block that said something, in window order. Tool blocks are not messages — block_span
    returns None for a block with a result glyph under it, the same rule the summary uses."""
    g = profile_for(agent)
    out = []
    if not g or not rows:
        return out
    rows = transcript(rows, g)
    i = 0
    while i < len(rows):
        if starts_block(rows, g, i):
            at = block_span(rows, g, i)
            if at:
                out.append(at)
                # Past the end of the block, not past its first line, or an indented harness opens
                # a second block inside the first.
                i = at[1]
        i += 1
    return out


def user_input_lines(rows, agent):
    """The rows the user typed: each prompt gutter plus its continuation lines, as a set.

    A turn runs until the agent speaks. On agy that reply carries no glyph and is not in column 0,
    so `starts_block` is checked as well as `ends_block` — without it a prompt would swallow the
    answer to it.
    """
    g = profile_for(agent)
    lines = set()
    if not g or not rows:
        return lines
    rows = transcript(rows, g)
    in_turn = False
    pending = []
    for i, row in enumerate(rows):
        if is_user_input(row, agent, rows, i):
            in_turn = True
            pending = []
        elif ends_block(row, g) or starts_block(rows, g, i):
            in_turn = False
        if not in_turn:
            continue
        # A blank line inside the turn belongs to it only if more of the turn follows. Trailing
        # blanks are the gap before the agent answers.
        if (row or "").strip():
            lines.update(pending)
            pending = []
            lines.add(i)
        else:
            pending.append(i)
    return lines


# Codex's idle composer shares its prompt gutter, and its model/context status line immediately
# follows — unlike a sent prompt, which is followed by the agent's reply.
_CODEX_STATUS = re.compile(r"^\s*\S+(?:\s+\S+)*\s+· Context \d+% used(?:\s|$)")


def conv_text(rows, at):
    """A range of rows as one message, with its line breaks kept.

    Codex closes in three paragraphs and a record that ran them together would be lying about what
    it said. A *run* of blank lines is not structure though — it is the gap before the next glyph —
    so runs collapse to one blank. Deliberately different from `_stripped`, which drops every blank
    because a push body is one line either way.
    """
    out = []
    for i in range(at[0], at[1] + 1):
        row = rows[i] if i < len(rows) else ""
        out.append(_MARGIN.sub("", (row or "").rstrip().rstrip("│┃")))
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip()


def pane_messages(rows, agent):
    """Everything said in this window, in window order: every agent message, and each run of the
    user's own lines as one message rather than one per line.

    Untrimmed on purpose. The browser's learned trim is one browser's preference and belongs to its
    view; the relay has no user to have taught it anything.
    """
    if not profile_for(agent) or not rows:
        return []
    found = [("agent", at) for at in message_blocks(rows, agent)]
    user_lines = user_input_lines(rows, agent)
    # One forward scan: a pane read at the ceiling must not rescan its tail once per prompt.
    if agent == "codex":
        for i, row in enumerate(rows):
            if not _CODEX_STATUS.match(row or ""):
                continue
            start = i
            while start >= 0 and start in user_lines:
                start -= 1
            user_lines = {j for j in user_lines if j <= start}
            break
    lines = sorted(user_lines)
    i = 0
    while i < len(lines):
        j = i
        while j + 1 < len(lines) and lines[j + 1] == lines[j] + 1:
            j += 1
        found.append(("user", (lines[i], lines[j])))
        i = j + 1
    found.sort(key=lambda m: m[1][0])
    out = [(who, conv_text(rows, at), at) for who, at in found]
    # The empty composer at the foot of a live pane is a prompt line with nothing typed on it.
    return [m for m in out if m[1]]


def turn_messages(messages):
    """The turn that just ended: the agent's closing message, and the prompt run directly above it.

    Walks back from the end — an agent that ran twice on one prompt has no prompt of its own above
    the second reply, and correctly contributes only the reply.
    """
    ms = messages or []
    end = len(ms) - 1
    while end >= 0 and ms[end][0] != "agent":
        end -= 1
    if end < 0:
        return []
    start = end
    while start - 1 >= 0 and ms[start - 1][0] == "user":
        start -= 1
    return ms[start:end + 1]


# --- Turn ends ---

# The statuses that end a turn, and the same list the browser holds as TURN_END_STATES in
# web/src/state.js. A turn is over when the pane stops working, however it stopped: an agent that
# finishes and drops to idle has said its piece exactly as much as one that reports done, and
# watching `done` alone loses every turn that ends the other way — which for some harnesses is
# most of them.
#
# tests/test_conversation_log.py reads the list back out of the JS and asserts the two agree, the
# way test_pane_summary.py and test_summary_detect.js already hold the detector to one answer.
TURN_END_STATES = ("idle", "done", "blocked")


def ends_turn(status):
    return status in TURN_END_STATES
