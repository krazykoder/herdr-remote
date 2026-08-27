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
import json
import os
import functools
import sqlite3
import threading
import time

from conv_query import QUERY_ROWS_DEFAULT, as_wire, query  # noqa: F401  (re-exported for the relay)
from pane_summary import pane_messages, turn_messages

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

# The kinds a person is behind. Which side of a conversation a row is on is a fact about its kind,
# and one place answers it so the anchor and the record agree.
USER_KINDS = ("human_prompt", "arbitrated")

# How many of the record's own messages have to line up for a position in a window to be its end.
# One is not enough: agents close turns with the same words constantly, and a bare match on "Done."
# lands on whichever copy is newest — which is the *last* one on screen when the agent has just
# said it twice, and the turn between them is then invisible. Mirrors CONV_ANCHOR_CONTEXT.
ANCHOR_CONTEXT = 3

# How far back the fallback looks for the prompts the record ends on. A bound rather than a rule:
# the run being looked for is the last one or two rows, and this only stops the scan on a pane
# whose record is nothing but prompts.
TRAILING_USER_MAX = 20


def _who(kind):
    return "user" if kind in USER_KINDS else "agent"


def _key(text):
    """The comparison key, and only ever that.

    Whitespace is dropped entirely rather than collapsed, because that is exactly the difference a
    terminal's own wrap makes: the same sentence read at a phone width and at a desktop width
    breaks in different places, and one of those breaks lands mid-word — "our loca l database"
    against "our local database". Stored text stays exactly as it was extracted; only what is
    compared is normalized. Mirrors convKey in web/src/conversation_pure.js.
    """
    return "".join((text or "").split())


# A prompt this relay typed can come back merged into the block under it — see `_split_echo`. How
# many of the pane's own sent prompts a window is checked against, and how much of one has to match
# at each end for the cut to be made.
SENT_LOOKBACK = 4
ECHO_EDGE = 40


def _is_echo(key, sent):
    """Whether a window message is one of these prompts, with or without screen caught under it.

    Equality alone is not enough. A prompt is echoed at the foot of the pane, so whatever the
    terminal draws *under* it — a tool's output, a status line, the harness's own footer — can end
    up inside the same block, and the echo is then the prompt plus a tail. Measured against the
    live record: every such pair was an exact prefix, never a fuzzy match, with 34 to 573 extra
    characters. So this is still an exact test, taken at one end instead of both.

    Floored at ECHO_EDGE, because a short prompt is a prefix of half of what an agent ever says:
    without it "continue" would swallow every message that happens to begin with the word.
    """
    return key in sent or any(len(s) >= ECHO_EDGE and key.startswith(s) for s in sent)


def _cut_at(text, count):
    """The offset in `text` just past its `count`th non-whitespace character.

    The comparison runs over `_key`s, which hold no whitespace at all, so an offset found there
    means nothing to the text it came from until it is walked back like this.
    """
    seen = 0
    for i, ch in enumerate(text):
        if not ch.isspace():
            seen += 1
            if seen == count:
                return i + 1
    return len(text)


def _split_echo(text, sent):
    """A block cut into the prompt echoed at the top of it and what the agent said underneath.

    None when it does not begin with that prompt, which is the ordinary case.

    A harness with no glyph of its own — agy — draws a pasted prompt exactly the way it draws its
    own reply: the first line after the `>` gutter, the rest indented two columns. The parser tells
    them apart by the blank line agy leaves before it answers, and a *pasted* prompt with a blank
    line in it defeats that: the prompt's own second paragraph opens the block, and when the agent
    then answers without running a tool there is no column-0 line anywhere between them. One block,
    holding the arbitrator's instruction and the member's answer, recorded as the member's words.

    Shape cannot separate them, so this does not try to. The relay knows what it typed, because it
    typed it — every send is a row in this table — so the echo is matched against that and cut off
    where it ends. Both ends are checked and the middle is not: a terminal re-wraps what it echoes
    (`_key` covers that) but it also drops what will not fit and replaces characters it cannot draw,
    and a prompt found at both ends is the prompt whatever happened between them.
    """
    key, skey = _key(text), _key(sent)
    if len(key) < ECHO_EDGE or len(skey) < 2 * ECHO_EDGE:
        return None
    # Where in the prompt the block picks it up, rather than assuming the top of it: the first line
    # of a send is echoed on the `>` gutter itself and is read as the prompt it is, so the block
    # under it starts partway down what was typed.
    begin = skey.find(key[:ECHO_EDGE])
    if begin < 0 or len(skey) - begin < 2 * ECHO_EDGE:
        return None
    at = key.find(skey[-ECHO_EDGE:], ECHO_EDGE)
    if at < 0:
        return None
    cut = _cut_at(text, at + ECHO_EDGE)
    head, rest = text[:cut].strip(), text[cut:].strip()
    if not head or not rest:
        return None        # nothing under it: the block is the echo, and is not the agent speaking
    return head, rest


def _aligns(fresh, i, keys, said=()):
    """Does the record's trailing run end at `fresh[i]`?

    A context message that falls off the top of the window is not a mismatch — it is absent, and a
    window is allowed to begin in the middle of the record. Who said it is half of what a message
    is: matching on text alone would count the user's "ok" as the agent's, and the two speak in
    turn, so aligning on the wrong one is aligning half a turn out.

    `said` is the set of prompts this relay typed since the record's newest read row. They are in
    the window because the pane echoed them, and they are in the record because the relay wrote
    them at the send — so they say nothing about where the record ends inside the window and are
    walked past rather than compared. Without that, an ordinary turn with a prompt sent into it
    fails to align at every offset, falls through to the last-resort rule, and re-records a turn
    the record already holds. Every `done -> idle` transition in the session diagnosed in
    `.workflow/02_architecture/decision_log/2026-08-27_a_trigger_that_carries_nothing.md` was
    recorded twice for this reason.
    """
    j = i
    for who, key in reversed(keys):
        while j >= 0 and fresh[j][0] == "user" and _is_echo(_key(fresh[j][1]), said):
            j -= 1
        if j < 0:
            return True
        if fresh[j][0] != who or _key(fresh[j][1]) != key:
            return False
        j -= 1
    return True

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
  decision_id  INTEGER,
  branch       TEXT    NOT NULL DEFAULT '',
  commit_sha   TEXT    NOT NULL DEFAULT '',
  commits      TEXT    NOT NULL DEFAULT '',
  dupe_of      INTEGER
);
CREATE INDEX IF NOT EXISTS turns_time ON turns(at, id);
CREATE INDEX IF NOT EXISTS turns_fp   ON turns(host, agent, cwd, at, id);
CREATE INDEX IF NOT EXISTS turns_pane ON turns(pane_id, at, id);
CREATE INDEX IF NOT EXISTS turns_host_cwd_time ON turns(host, cwd, at, id);
"""

# Columns added after the first release. SQLite has no ADD COLUMN IF NOT EXISTS, and a record
# written by an older relay is the ordinary case rather than the exception — this is a durable
# file the user has been accumulating for as long as they have had the feature on.
ADDED_COLUMNS = (
    ("branch", "TEXT NOT NULL DEFAULT ''"),
    ("commit_sha", "TEXT NOT NULL DEFAULT ''"),
    ("commits", "TEXT NOT NULL DEFAULT ''"),
    ("dupe_of", "INTEGER"),
)


def now_ms():
    return int(time.time() * 1000)


def _locked(method):
    """Serialise one operation over the connection — the fetches, not only the execute.

    On the methods a thread can reach, which is all the public ones: the relay calls every one of
    them through asyncio.to_thread. Re-entrant because they call each other — record_turn_end ends
    in record, which ends in _prune.
    """
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self._lock:
            return method(self, *args, **kwargs)
    return wrapper


class ConversationLog:
    """The writer. One per relay process; SQLite handles the rest."""

    def __init__(self, path, max_rows=DEFAULT_MAX_ROWS):
        self.path = path
        self.max_rows = max_rows
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, mode=0o700, exist_ok=True)
        # check_same_thread=False: every caller reaches this through asyncio.to_thread, so the
        # connection is touched from a different thread each time — and, since the app learned to
        # walk a thread backwards, from several at once: one poll loop writing turns while two
        # clients page through the record.
        #
        # That caller used to not exist, and the lock below used to not be here. Two threads on one
        # connection share one cached prepared statement per SQL text, and one resetting it under
        # the other returns rows shaped like nobody's query — `PRAGMA table_info` answering with a
        # one-column row, a SELECT built from no columns at all. It surfaces as an IndexError or a
        # syntax error somewhere innocent, never as the race it is.
        #
        # Held across the whole operation, not just the execute: a cursor is iterated lazily, so
        # releasing after execute() would leave the fetches racing exactly as before.
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass  # a filesystem that will not take a mode is not a reason to lose the record

    def _migrate(self):
        have = {r["name"] for r in self.conn.execute("PRAGMA table_info(turns)")}
        for name, decl in ADDED_COLUMNS:
            if name not in have:
                self.conn.execute(f"ALTER TABLE turns ADD COLUMN {name} {decl}")

    @_locked
    def close(self):
        self.conn.close()

    @_locked
    def knows_directory(self, host, cwd):
        """Has this relay ever recorded a turn in this directory on this host?

        The set of directories the relay has watched, which outlives the panes that were open in
        them — a conversation read a week later is a record whose panes are all gone. It is the
        only claim git should be run on: it is this relay's own history and never a path a client
        named.
        """
        return self.conn.execute(
            "SELECT 1 FROM turns WHERE host=? AND cwd=? LIMIT 1",
            (host or "local", cwd or "")).fetchone() is not None

    @_locked
    def last_commit(self, host, cwd):
        """The commit the last recorded turn for this directory was at, or ''.

        The other end of a turn's commit range. Kept here rather than in the relay's memory because
        a relay restart is not a break in the record: the agent that committed something over lunch
        did so between two turns, and losing the range because the relay was restarted between them
        would lose exactly the history this feature exists to keep.
        """
        row = self.conn.execute(
            "SELECT commit_sha FROM turns WHERE host=? AND cwd=? AND commit_sha<>''"
            " ORDER BY at DESC, id DESC LIMIT 1", (host or "local", cwd or "")).fetchone()
        return row["commit_sha"] if row else ""

    @_locked
    def last_branch(self, host, cwd):
        """The branch the last recorded turn for this directory was on, or ''.

        Same reasoning as last_commit above, for the other half of the same fact: a relay restart
        is not a break in the record. The app shows the addressed agent's branch beside its
        composer, and reading it back from here is what fills that in on the first snapshot after a
        restart rather than leaving it blank until every pane has ended another turn.
        """
        row = self.conn.execute(
            "SELECT branch FROM turns WHERE host=? AND cwd=? AND branch<>''"
            " ORDER BY at DESC, id DESC LIMIT 1", (host or "local", cwd or "")).fetchone()
        return row["branch"] if row else ""

    # --- writing ---

    @_locked
    def record(self, *, agent, pane_id, kind, origin, at_src, host="local", cwd="", label="",
               project="", text="", tail="", span=None, status_from=None, status_to=None,
               at=None, decision_id=None, git=None, dupe_of=None):
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
        # `git` is whatever relay/git_probe produced, or nothing at all — an agent working outside
        # a checkout, a host without git, the feature switched off. The record stores it as it was
        # given: this module runs no commands and knows nothing about repositories.
        git = git or {}
        commits = git.get("commits") or []
        row = self.conn.execute(
            "INSERT INTO turns (host, agent, cwd, pane_id, label, project, kind, origin,"
            " text, tail, range_start, range_end, status_from, status_to, at, at_src, decision_id,"
            " branch, commit_sha, commits, dupe_of)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (host or "local", agent or "", cwd or "", pane_id, label or "", project or "",
             kind, origin, text, tail,
             span[0] if span else None, span[1] if span else None,
             status_from, status_to, at if at is not None else now_ms(), at_src, decision_id,
             git.get("branch") or "", git.get("commit") or "",
             json.dumps(commits) if commits else "", dupe_of))
        self.conn.commit()
        self._prune()
        return row.lastrowid

    @_locked
    def pending(self, pane, content):
        """How many messages this window holds that the record does not. Reads nothing but sqlite.

        The question behind it is "has this pane said anything yet". A turn end is a *status*
        transition, and a harness that flips to idle before it paints its answer — agy does it every
        time — is read at the one moment there is nothing to read. What made that invisible is that
        the window is never empty: it holds the whole previous turn, so "is there anything on
        screen" is always yes and "is there anything the record has not got" is the only form of the
        question that can tell the difference.

        Same parse and same anchor as `record_turn_end`, deliberately: a caller that waits on this
        and then records must not find a different answer a moment later.
        """
        fresh = pane_messages((content or "").splitlines(), pane.get("agent"))
        if not fresh:
            return 0
        if not self._has_record(pane):
            return len(fresh)
        return len(self._messages_after_record(pane, fresh)[0])

    @_locked
    def record_turn_end(self, pane, content, status_from, status_to, at=None, git=None):
        """A pane that just stopped working, from the content of its pane.

        Returns the ids written, oldest first — usually one or two, and empty when this turn is
        already recorded. The duplicate is real and ordinary: a pane goes blocked, a person answers,
        it finishes — and unless it wrote something new in between, both transitions read back the
        same messages.

        What is written is the same thing the browser's recorder writes, out of the same parser:
        every message the window holds past the record's own end. That is the agent's narration as
        well as its closing line, and any prompt typed straight into the terminal — the one input no
        send event will ever report. `pane_summary.pane_messages` is the port; the anchor below is
        the port of `messagesAfterRecord`.
        """
        agent = pane.get("agent")
        pane_id = pane["pane_id"]
        rows = (content or "").splitlines()
        fresh = self._unmerge_sent(pane, pane_messages(rows, agent))
        # First sight of this pane: everything on screen was said before the relay was watching, so
        # the whole window is history rather than one turn. Its order is all that can honestly be
        # claimed about it, which is what `backfill` means — the same answer the browser gives a
        # pane's first read. Anything after this is anchored against what this wrote.
        backfilled = bool(fresh) and not self._has_record(pane)
        dupes = []
        if not fresh:
            new = []
        elif backfilled:
            new = fresh
        else:
            new, dupes = self._messages_after_record(pane, fresh)
        common = dict(
            agent=agent or "", pane_id=pane_id,
            host=pane.get("host") or "local", cwd=pane.get("cwd") or "",
            label=pane.get("label") or "", project=pane.get("project") or "",
            at_src="backfill" if backfilled else "poll",
            status_from=status_from, status_to=status_to)
        # Every row of one turn end is at the same commit on the same branch — they are one moment,
        # read out of one screen. The list of commits is not repeated across them: it is the work
        # that happened *before* this moment, and writing it onto four rows would show a person the
        # same three commits four times. It goes on the last row, which is the one the turn ends on.
        git = git or {}
        git_head = {"branch": git.get("branch"), "commit": git.get("commit")}
        git_last = dict(git_head, commits=git.get("commits") or [])
        if not fresh:
            # Nothing readable at all: a harness with no profile, a pane showing its own banner, a
            # window that begins mid-block. The tail is the honest fallback and saying "a turn ended
            # here and this is what was on screen" beats saying nothing — but only once, or every
            # poll of a quiet pane would write the same screen again.
            tail = "\n".join(rows[-12:])
            if self._last_tail(pane) == tail:
                return []
            return [self.record(kind="agent_blocked" if status_to == "blocked" else "agent_final",
                                origin="agent", text="", tail=tail, at=at, git=git_last, **common)]
        base = at if at is not None else now_ms()
        last_agent = max((i for i, m in enumerate(new) if m[0] == "agent"), default=-1)
        out = []
        for i, (who, text, span) in enumerate(new):
            # Backfill claims an order and not a time: every one of these was said before the relay
            # looked, so they are dated in the milliseconds *under* the read that found them. A run
            # dated `now` would sort after history recorded later by another pane in the same
            # conversation, which is the one thing the order is asked.
            when = base - (len(new) - i) if backfilled else base
            if who == "user":
                # `human_terminal`, never `human_web`: this was read off a pane. The relay knows a
                # person put those words there and does not know which person, and only a send it
                # performed itself may claim more than that (N4).
                out.append(self.record(kind="human_prompt", origin="human_terminal",
                                       text=text, span=span, at=when,
                                       git=git_last if i == len(new) - 1 else git_head, **common))
            else:
                # Only the agent's closing block is the one the end state is about. The blocks above
                # it are what it said on the way there — and a prompt typed after it does not move
                # the state, so the last message of the window is not always the agent's.
                out.append(self.record(
                    kind="agent_blocked" if i == last_agent and status_to == "blocked" else "agent_final",
                    origin="agent", text=text, span=span, at=when,
                    git=git_last if i == len(new) - 1 else git_head, **common))
        # The copies, after the turn they were read alongside. Written with the same origin rule as
        # anything else read off a pane, and dated at the read that found them — the row they
        # repeat carries the time the thing was actually said.
        for who, text, span, of in dupes:
            self.record(kind="human_prompt" if who == "user" else "agent_final",
                        origin="human_terminal" if who == "user" else "agent",
                        text=text, span=span, at=base, dupe_of=of, git=git_head, **common)
        return out

    def _sent_texts(self, pane, limit=SENT_LOOKBACK):
        """The last few prompts this relay typed at this pane, newest first."""
        where, params = self._scope(pane)
        rows = self.conn.execute(
            f"SELECT text FROM turns WHERE {where} AND at_src = 'sent' AND text != ''"
            " AND dupe_of IS NULL"
            " ORDER BY at DESC, id DESC LIMIT ?", (*params, limit)).fetchall()
        return [r["text"] for r in rows]

    def _unmerge_sent(self, pane, fresh):
        """Give back what the agent said, where a prompt the relay sent was merged into it.

        The pieces keep the whole block's span: the two halves are one run of rows on screen, and
        the span exists to point a reader at them rather than to be arithmetic. The prompt half is
        already in the record as the send that wrote it, so the anchor recognises it and only the
        agent's half is new — which is the point. See `_split_echo` for why shape cannot do this.
        """
        sent = self._sent_texts(pane)
        if not sent:
            return fresh
        out = []
        for who, text, span in fresh:
            split = next((s for s in (_split_echo(text, t) for t in sent) if s), None) \
                if who == "agent" else None
            if split:
                out.append(("user", split[0], span))
                out.append(("agent", split[1], span))
            else:
                out.append((who, text, span))
        return out

    def _has_record(self, pane):
        where, params = self._scope(pane)
        return self.conn.execute(
            f"SELECT 1 FROM turns WHERE {where} LIMIT 1", params).fetchone() is not None

    def _messages_after_record(self, pane, fresh):
        """What this window holds past the record's own end.

        The record is anchored by its newest messages *that were read off a pane* — a prompt the
        relay sent is in the record whether the pane has echoed it or not, so it cannot say where
        the record ends inside a window. Three of them, because agents close turns with the same
        words constantly and a bare match on "Done." lands on whichever copy is newest.

        Where more than one position lines up, the newest wins: it is the one that recovers *less*,
        and a run short by a message is a smaller wrong than a run that duplicates what is already
        recorded, because the record is permanent and the duplicate is in it forever.

        Returns `(new, dupes)` — see `_sift`. Nothing found in the window is thrown away; what is
        already in the record is separated from what is not.
        """
        keys = self._anchor_keys(pane, ANCHOR_CONTEXT)
        if keys:
            # A prompt committed at the send sits after that anchor already, and its echo is in the
            # window: the record holds the send, the pane holds what the send typed, and both are
            # the same words. Without this every prompt sent from a client was recorded twice — once
            # when it went out, once when the turn it started ended.
            said = self._sent_after_read(pane)
            echoes = self._sent_keys(pane)
            for i in range(len(fresh) - 1, -1, -1):
                if _aligns(fresh, i, keys, echoes):
                    return self._sift(pane, fresh[i + 1:], (), said)
        # The window cannot be placed against the record: a `/clear`, a record holding nothing read
        # off this pane, or a message whose text changed. The last-block rule cannot see an input
        # made mid-turn, but it does see the turn — and a turn recorded without its interruptions
        # beats a turn not recorded.
        said = self._trailing_user_keys(pane)
        # The anchor could not be placed, but it is still the newest few things this pane is known
        # to have said — so a block reproducing one of them is not new, whatever the window did to
        # the boundaries around it. This is the case a moved block boundary lands in: the record
        # holds messages the re-blocked window can no longer produce separately, so no offset
        # aligns, and without this the turn above is written a second time. Bounded to
        # ANCHOR_CONTEXT rows, which is what keeps an agent that genuinely repeats itself an hour
        # later recorded rather than swallowed.
        return self._sift(pane, turn_messages(fresh), keys, said)

    def _sift(self, pane, msgs, keys, said):
        """The window's messages, split into what is new and what the record already holds.

        Both halves are kept. A duplicate is a fact about what the pane showed — the record is what
        was detected and received — so the copy is written, marked with the row it repeats, and
        left out of every read that does not ask for it. What it must never be is *new*: a second
        copy counted as a turn is a second trigger for the arbitrator, which is the fault this
        pair was written for.

        Two exact tests and no threshold. `keys` is the anchor — the last few messages read off
        this pane — and a block reproducing one of them is that message again, whatever the window
        did to the boundaries around it. `said` is the prompts the record ends on, matched by
        prefix rather than equality because a pane echoes a prompt with whatever it drew underneath
        it caught in the same block. Both are bounded by position in the record rather than by
        elapsed time, so an agent that genuinely repeats itself forty turns later is new.
        """
        new, dupes = [], []
        for who, text, span in msgs:
            key = _key(text)
            if (who, key) in keys or (who == "user" and _is_echo(key, said)):
                dupes.append((who, text, span, self._dupe_of(pane, who, key)))
            else:
                new.append((who, text, span))
        return new, dupes

    def _dupe_of(self, pane, who, key):
        """The row this message repeats, or None when it has already been pruned away.

        Same bound as the sets that classified it, so this is a lookup rather than a search: the
        row is one of the last few this pane wrote, and a copy that cannot name its original is
        still a copy — it is marked either way.
        """
        where, params = self._scope(pane)
        rows = self.conn.execute(
            f"SELECT id, kind, text FROM turns WHERE {where} AND text != '' AND dupe_of IS NULL"
            " ORDER BY at DESC, id DESC LIMIT ?", (*params, TRAILING_USER_MAX)).fetchall()
        for r in rows:
            if _who(r["kind"]) != who:
                continue
            other = _key(r["text"])
            if other == key or (len(other) >= ECHO_EDGE and key.startswith(other)):
                return r["id"]
        return None

    @staticmethod
    def _fingerprint(pane):
        return (pane.get("host") or "local", pane.get("agent") or "", pane.get("cwd") or "")

    def _scope(self, pane):
        """Which rows in the record are this pane's own, as a (SQL, params) pair.

        The pane's own id is the sharpest identity there is, and it is what keeps two panes sharing
        one fingerprint — a pair of claudes in the same project, which is an ordinary thing to run —
        from anchoring against each other and each deciding the other's turn was already recorded.

        It is also the one thing herdr changes on every restart, so a pane with no rows under its
        current id falls back to its stable label within the fingerprint. A bare fingerprint is not
        enough: two Claudes in one project share it. An unlabelled restarted pane backfills rather
        than borrowing another pane's record; that may repeat history, but never loses a turn.
        """
        pane_id = pane.get("pane_id") or ""
        if self.conn.execute("SELECT 1 FROM turns WHERE pane_id = ? LIMIT 1",
                             (pane_id,)).fetchone():
            return "pane_id = ?", (pane_id,)
        label = pane.get("label") or ""
        if label:
            return "host = ? AND agent = ? AND cwd = ? AND label = ?", (*self._fingerprint(pane), label)
        return "pane_id = ?", (pane_id,)

    def _anchor_keys(self, pane, limit):
        """The record's newest messages that were read off this pane, oldest first."""
        where, params = self._scope(pane)
        rows = self.conn.execute(
            f"SELECT kind, text FROM turns WHERE {where}"
            " AND at_src != 'sent' AND text != '' AND dupe_of IS NULL"
            " ORDER BY at DESC, id DESC LIMIT ?",
            (*params, limit)).fetchall()
        return [(_who(r["kind"]), _key(r["text"])) for r in reversed(rows)]

    def _sent_keys(self, pane):
        """Every prompt this relay typed at this pane recently, echoed or not.

        Wider than `_sent_after_read`, and for a different job. That set answers "what has the
        pane not echoed back yet", and it stops at the newest row read off the pane — so once a
        turn has been recorded on top of a prompt, the prompt leaves it. This one never stops:
        the pane's echo of a prompt stays on screen for the rest of the window's life, so it is
        still sitting between two of the record's messages long after the turn above it was
        written. That is what `_aligns` has to walk past, and asking `_sent_after_read` for it
        got an empty set exactly when it mattered.

        Only the alignment uses this. The messages returned past the record's end are still
        filtered by the narrow set, because a prompt this relay sent and has already seen
        recorded is not evidence that a *new* one is an echo.
        """
        where, params = self._scope(pane)
        rows = self.conn.execute(
            f"SELECT kind, text FROM turns WHERE {where} AND text != '' AND at_src = 'sent'"
            " AND dupe_of IS NULL ORDER BY at DESC, id DESC LIMIT ?",
            (*params, TRAILING_USER_MAX)).fetchall()
        return {_key(r["text"]) for r in rows if _who(r["kind"]) == "user"}

    def _sent_after_read(self, pane):
        """The prompts written since the record's newest row that was *read off the pane*.

        Everything above that row is already in the window's past; everything after it is a send
        this relay performed and has not yet seen echoed. The port of the `said` set in
        `messagesAfterRecord` — the browser has always dropped these and the record never did.
        """
        where, params = self._scope(pane)
        rows = self.conn.execute(
            f"SELECT kind, text, at_src FROM turns WHERE {where} AND text != ''"
            " AND dupe_of IS NULL ORDER BY at DESC, id DESC LIMIT ?",
            (*params, TRAILING_USER_MAX)).fetchall()
        out = set()
        for r in rows:
            if r["at_src"] != "sent":
                break
            if _who(r["kind"]) == "user":
                out.add(_key(r["text"]))
        return out

    def _trailing_user_keys(self, pane):
        """The prompts the record already ends on: the trailing run of user rows, past any agent
        rows above them. Their echoes are in the window and are not new; anything else the user
        said is — an input made while the agent worked is exactly the one nothing else records."""
        where, params = self._scope(pane)
        rows = self.conn.execute(
            f"SELECT kind, text FROM turns WHERE {where}"
            " AND text != '' AND dupe_of IS NULL ORDER BY at DESC, id DESC LIMIT ?",
            (*params, TRAILING_USER_MAX)).fetchall()
        out, seen_user = set(), False
        for r in rows:
            if _who(r["kind"]) == "user":
                seen_user = True
                out.add(_key(r["text"]))
            elif seen_user:
                break
        return out

    def _last_tail(self, pane):
        where, params = self._scope(pane)
        row = self.conn.execute(
            f"SELECT tail FROM turns WHERE {where} AND text = '' AND dupe_of IS NULL"
            " ORDER BY at DESC, id DESC LIMIT 1", params).fetchone()
        return row["tail"] if row else None

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
            # A copy goes before the oldest turn does: it is the one row in the table whose
            # contents are already somewhere else in it.
            f"  ORDER BY (dupe_of IS NULL) ASC, at ASC, id ASC LIMIT ?)",
            (*KEEP_ALWAYS, count - self.max_rows))
        self.conn.commit()

    # --- reading ---

    @_locked
    def query(self, **selectors):
        """The same bounded read conv_query gives an agent, for the relay's own answers."""
        return query(self.conn, **selectors)
