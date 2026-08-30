#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=14.0", "zeroconf>=0.80.0", "pywebpush>=2.0.0", "py-vapid>=1.9.0"]
# ///
"""herdr-remote relay — polls herdr, accepts push events (HTTP POST + WebSocket + UDP), broadcasts to clients."""
import asyncio, functools, hmac, json, logging, os, re, shlex, shutil, signal, socket, sqlite3, subprocess, sys, tempfile, time

from agent_state import complete_agent_update_message
import git_probe
from arbitration import (Arbitration, ArbiterError, budget_left, now_ms as arb_now,
                         resolve as arb_resolve, RUNNING as ARB_RUNNING)
from conversation_log import ConversationLog
from conv_query import (QUERY_ROWS_DEFAULT as CONV_LOG_ROWS_DEFAULT, as_wire as conv_as_wire,
                        fingerprints_from as conv_fingerprints)
from pane_summary import ends_turn, summary_body
from agent_ids import AgentIds, RETIRED_MAX
from user_state import UserState, Conflict as StateConflict, DOC_NAMES as STATE_DOCS
from projects import (
    ProjectConfigError,
    ambiguous_pane_ids,
    annotate_agents,
    child_path_ok,
    child_projects,
    child_target,
    create_child,
    load_projects,
    make_child_dir,
    public_projects,
    resolve_workspace_remote,
)
from start_agent import (
    AGENT_START_TIMEOUT_MS,
    ROLES,
    SPACER_LABEL,
    StartAgentConfigError,
    agent_init_prompts,
    agent_wake_prompts,
    agent_name_from_label,
    agent_start_args,
    unattended_kinds,
    claimable_spacer,
    dig,
    is_spacer,
    unique_agent_name,
    load_start_agents,
    pane_rename_args,
    pane_split_args,
    plan_slot,
    slot_advice,
    validate_pane_label,
    validate_start_aid,
    validate_start_starter,
    validate_start_ref,
    tab_create_args,
    validate_open_terminal,
    validate_start_request,
    workspace_create_args,
)

from agent_configs import (
    ConfigError as AgentConfigError,
    export_line,
    load_providers,
    model_args,
    parse_aliases,
    public_configs,
    public_providers,
    resolve as resolve_config,
)

try:
    from websockets.asyncio.server import serve
except ImportError:
    from websockets.server import serve
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

from logging.handlers import RotatingFileHandler

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
# Overridable because every relay wrote here, including the ones the test suites spawn: a
# Playwright run interleaved its fake panes into the log of the relay actually being used,
# and — PUSH_SUBS_FILE lives here too — a test relay was holding the real devices'
# subscriptions and could push to a phone.
LOG_DIR = os.environ.get("HERDR_LOG_DIR") or os.path.expanduser("~/Library/Logs/herdr-remote")
os.makedirs(LOG_DIR, mode=0o700, exist_ok=True)
LOG_FILE = os.path.join(LOG_DIR, "relay.log")
AUDIT_FILE = os.path.join(LOG_DIR, "audit.log")

_formatter = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
_file_handler = RotatingFileHandler(LOG_FILE, maxBytes=5 * 1024 * 1024, backupCount=3)
_file_handler.setFormatter(_formatter)
_console_handler = logging.StreamHandler()
_console_handler.setFormatter(_formatter)

log = logging.getLogger("herdr-relay")
log.setLevel(logging.INFO)
log.addHandler(_file_handler)
log.addHandler(_console_handler)
logging.getLogger("websockets").setLevel(logging.WARNING)

HERDR = os.environ.get("HERDR_BIN") or shutil.which("herdr") or "/opt/homebrew/bin/herdr"


def is_test_relay():
    """Is this relay running the fake herdr out of `tests/`?

    Every suite that spawns a relay points HERDR_BIN there. It is the one reliable mark of a
    process whose writes must not land on the running install's data.
    """
    return os.path.abspath(HERDR).startswith(os.path.join(PROJECT_ROOT, "tests") + os.sep)


def own_db(var, default):
    """Where a database lives — and never the live one, for a relay running the fake herdr.

    Every suite that spawns a relay points HERDR_BIN inside `tests/`. Unset, these paths default
    into the checkout's own `.herdr-remote/`, which is the *running install's*, and a test's
    fixtures land on the user's documents. Not hypothetical: it cost a real conversation index —
    132 conversations, 27 named by hand, replaced by one called "footer" with members in
    /work/one — recoverable only because the store keeps 200 revisions of each document.

    PROJECT_ROOT above already carries this reasoning for the log directory and the push
    subscriptions. The two databases are the ones it never reached. Refused at boot rather than
    defaulted somewhere clever: a test that forgot to say where its data goes should say so on the
    first line of its output, not write somewhere the author has to think about.
    """
    got = os.environ.get(var)
    if got:
        return got
    if is_test_relay():
        sys.exit(f"herdr-remote: HERDR_BIN is {HERDR}, so this is a test relay — set {var} to a "
                 f"path of its own rather than writing to {default}")
    return default


def _plugin_version():
    """This project's version, read from the plugin manifest that already declares it.

    One place to bump rather than a copy here and another in the page. Parsed with a regex and not
    tomllib, which is 3.11 and this script says 3.10 — and a manifest whose version line has moved
    beyond a quoted literal is a manifest this needs to be looking at anyway. Missing or unreadable
    is not fatal: an unknown version is worth less than a relay, so it reports empty and runs.
    """
    manifest = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "herdr-plugin.toml")
    try:
        with open(manifest, encoding="utf-8") as f:
            found = re.search(r'^version\s*=\s*"([^"]+)"', f.read(), re.M)
    except OSError:
        return ""
    return found.group(1) if found else ""


RELAY_VERSION = _plugin_version()
WS_PORT = int(os.environ.get("HERDR_RELAY_PORT", "8375"))
POLL_INTERVAL = 2
AUTH_TOKEN = os.environ.get("HERDR_RELAY_TOKEN", "")  # Optional: shared secret for relay auth

# Two listeners, one process. cloudflared forwards tunnel requests from a local process, so at
# this relay a tunnel request is indistinguishable from a LAN one — a single listener cannot be
# token-free for the phone on the Wi-Fi without also being token-free for the internet. Separate
# sockets make the boundary structural instead of a guess about the request.
#   .workflow/02_architecture/2026-08-09_dual_listener_access.md
LAN_BIND = os.environ.get("HERDR_LAN_BIND", "0.0.0.0")
LAN_OPEN = os.environ.get("HERDR_LAN_OPEN", "") == "1"
EXTERNAL_PORT = int(os.environ.get("HERDR_EXTERNAL_PORT", "0") or 0)

# An agent TUI needs a beat after a bracketed paste before it treats Enter as submit; sent
# immediately, the Enter is swallowed and the text just sits in the composer. Measured against
# codex 0.145.0: 0 ms leaves it sitting, 100 ms submits, single-line and multi-line alike.
# ponytail: a fixed settle delay, not a readiness signal — herdr exposes none. If one agent ever
# needs longer, make this per-agent rather than raising it for everyone.
SEND_SETTLE = 0.15

# What a bigger paste needs. 0.15 was measured against a one-line approval, and a TUI given a
# transferred payload or an edited prompt is still laying it out when an Enter that close behind
# arrives — which is the "the text is sitting in the composer" report, intermittent because it
# depends on how much there was to lay out. Scaled by length rather than raised for everyone: a
# short send stays as quick as it was.
SEND_SETTLE_MAX = 0.9

# --- Submitting a paste, and knowing whether it took ---
#
# The history matters, because this is the third attempt at it and each of the first two fixed a
# real bug while introducing the next one.
#
#   1. The client sent `send_text` and then its own `send_keys ["Enter"]`, two WebSocket messages,
#      with SEND_SETTLE holding the first handler so the second landed late enough. That works for
#      a TUI that is *running*. It does not work for one that is *starting*: a claude or codex that
#      has been alive for 200 ms is not at a composer yet, and the Enter goes nowhere. Which is
#      exactly the New agent dialog's opening prompt, every time.
#   2. So `submit` was served by herdr's `pane run`, which sends text and Enter in one call and
#      cannot be interrupted. That fixed the interruption and removed the beat — and herdr pastes
#      with bracketed paste, so a TUI still laying out a transferred payload dropped the Enter.
#      Short generated commands went through; long or hand-edited ones sat in the composer.
#   3. Both of those are the same mistake in two sizes: guessing a duration for something that has
#      no fixed duration. A boot can take five seconds; a paste can take fifty milliseconds. No
#      constant is right for both.
#
# So: stop guessing, and ask. herdr already reports `agent_status` per pane, and it is the readiness
# signal this file's older comments say does not exist — a pane whose TUI has not started reports
# no agent at all, and one that has taken a prompt reports `working` or `blocked`. Paste, then press
# Enter and watch that field until it says the pane is acting on something.
#
# The one thing this must never do is press Enter into a pane that is `blocked`, because the box a
# blocked agent is showing is a permission prompt and Enter accepts its default. That is the whole
# reason this verifies rather than simply pressing twice and hoping.
SUBMIT_READY = ("idle", "done")     # a composer that is waiting for something to submit
# A pane herdr can say anything at all about: the agent is up, whatever it is doing. What a line
# typed at a starting TUI needs to wait for — see pane_ready.
SUBMIT_STARTED = ("idle", "done", "working", "blocked")
# herdr listed its panes and this one was not there — it has exited. Distinct from "" (the call
# failed) and from `unknown` (listed, no agent yet), because those two mean wait and this one means
# stop: whatever this pane was going to do with the text, it is not going to do it now.
PANE_GONE = "gone"
# The two lines whose whole purpose is to close the pane, so a pane that has gone is the proof they
# landed. Everything else that arrives at a vanished pane is a send that failed: an agent that
# crashed on the prompt looks identical from here, and reporting that as delivered would put a turn
# in the record that no agent ever read.
CLOSING_LINES = ("/quit", "exit")
INIT_READY_WAIT_S = 30              # how long a starting TUI is given to report a status
INIT_READY_POLL = 0.5
INIT_SETTLE_S = 2.0                 # ...and to finish painting once it has
SUBMIT_TOOK = ("working", "blocked")  # it is acting on what it was handed — never press Enter now
SUBMIT_TRIES = 4                    # Enter presses, at most, however long the wait runs
SUBMIT_POLL = 0.4                   # between a press and looking to see whether it took
# …for the first few seconds. After that the question has changed: the presses are spent, nothing
# more will be typed, and the loop is only waiting for a status to move. Every look is a `herdr
# pane list` subprocess — over SSH for a remote pane — and 45 seconds of them at the fast rate is
# a hundred process spawns to learn one bit. Slow down instead; the cost of arriving 2s late to
# the answer is a toast that lands 2s late.
SUBMIT_FAST = 4.0                   # how long the fast rate lasts — the presses fit inside it
SUBMIT_POLL_SLOW = 2.0              # and after it, when there is nothing left to do but watch
SUBMIT_TIMEOUT = 8.0                # total, and generous: an agent's first boot is seconds, not ms
# Harnesses that need longer than that, by herdr agent kind. Eight seconds is generous for a
# harness whose status field moves as soon as its composer takes the text, and far too short for
# one that repaints its whole frame first: agy routinely reports `idle` for tens of seconds after
# an Enter it did take. The cost of guessing low is not a slow send — it is an arbitration session
# paused with `send_unconfirmed` over a message the member went on to answer.
SUBMIT_SLOW = {"agy": 45.0}
# How long a send nobody could confirm is watched for afterwards. Minutes, not seconds: the common
# reason a send is unconfirmed is that the pane was already working, and what it is waiting for is
# the agent to finish — which is a turn, and a turn is as long as it is.
CONFIRM_MS = int(os.environ.get("HERDR_CONFIRM_MS", str(10 * 60 * 1000)))

# The longest text one send_text may carry. 4000, not 1000: a transferred selection is usually code
# or a diff (P3 spec §6). Mirrors SEND_TEXT_MAX in web/src/pairs_pure.js, which is what the browser
# chunks against — the two are one number and a client that splits by a different one would be
# refused mid-message.
SEND_TEXT_MAX = 4000


def submit_settle(text):
    """How long to leave a TUI between the paste and the *first* Enter.

    Still a guess, and deliberately only used for the first press — a long paste usually needs a
    beat and waiting one costs nothing, but nothing depends on this number being right. What makes
    the submit land is submit_paste watching the pane afterwards.
    """
    span = SEND_SETTLE_MAX - SEND_SETTLE
    return SEND_SETTLE + span * min(1.0, len(text or "") / SEND_TEXT_MAX)


# VAPID Web Push
VAPID_PUBLIC_KEY = os.environ.get("HERDR_VAPID_PUBLIC", "")
VAPID_PRIVATE_KEY = os.environ.get("HERDR_VAPID_PRIVATE", "")
VAPID_SUBJECT = os.environ.get("HERDR_VAPID_SUBJECT", "mailto:herdr@localhost")
# What a "finished" push says: `1` for the agent's closing message, otherwise the bottom of the
# pane. Off until the detector has been watched against real panes for a while — it reads gutter
# glyphs a harness can change in any release, and the failure is a notification that says the wrong
# thing, which is worse than one that says a vaguer right thing. Falls back on its own for any pane
# it cannot read a message off, so turning it on is not a promise it always has one.
PUSH_SUMMARY = os.environ.get("HERDR_PUSH_SUMMARY", "") == "1"
push_subscriptions = []  # list of PushSubscription dicts
PUSH_SUBS_FILE = os.path.join(LOG_DIR, "push_subs.json")

# The durable conversation record. Off by default: it keeps what agents said on disk, which is a
# decision about the user's data and not one to make for them. On, it is written once per turn end
# and read back by `conv_log` — and later by an arbitrator deciding what happens next.
CONV_LOG_DB = own_db("HERDR_ARBITER_DB",
                     os.path.join(PROJECT_ROOT, ".herdr-remote", "arbitration.sqlite3"))
conv_log = None
if os.environ.get("HERDR_CONV_LOG", "") == "1":
    try:
        conv_log = ConversationLog(
            CONV_LOG_DB, max_rows=int(os.environ.get("HERDR_CONV_LOG_MAX", "") or 50000))
    except (sqlite3.Error, OSError, ValueError) as e:
        # A record that cannot be opened is not a reason to refuse to relay. Everything else here
        # works without it, and a relay that will not start because a log file is unwritable is a
        # worse failure than one that says so and carries on.
        print(f"herdr-remote: conversation log disabled: {e}", file=sys.stderr)

# Where the work landed. On with the record and switched off with HERDR_GIT_TRACK=0: a turn that
# says what an agent did is worth much more next to the branch and the commits it did it in, and
# the cost is `git rev-parse` in the pane's cwd at the moments the record is already being written
# — never per poll. Read-only commands, and nothing at all for a pane outside a checkout.
GIT_TRACK = conv_log is not None and os.environ.get("HERDR_GIT_TRACK", "1") != "0"
# The commit *list* is the one part of this that can be recomputed — the sha on a turn and the sha
# on the turn before it are the two ends of `git log` — and it is also the largest part, several
# megabytes of a full record against one for the shas. So it is off unless asked for. On, it buys
# durability: subjects written down survive the rebase that makes the range unresolvable.
GIT_COMMITS = os.environ.get("HERDR_GIT_COMMITS", "") == "1"
git_cache = git_probe.Cache()


# A commit as a client may name one. Hex only, and never a ref: `main`, `HEAD~3` and `--output=x`
# all reach git's argument parser, and the last of those is an option rather than a revision. The
# app only ever has shas — they came out of the record — so nothing is lost by refusing the rest.
GIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,40}$")


def git_range_target(msg):
    """(cwd, remote, from, to) for a git_commits question, or a refusal.

    The directory has to be one this relay is already watching. A client may not name a path: the
    relay would read a repository the user never pointed it at, which is a different capability
    from reading the panes it was asked to poll.
    """
    cwd, remote = git_cwd_target(msg)
    first, last = str(msg.get("from") or ""), str(msg.get("to") or "")
    if not GIT_SHA_RE.match(first) or not GIT_SHA_RE.match(last):
        raise ValueError("from and to must be commit shas")
    return cwd, remote, first, last


def git_cwd_target(msg):
    """A watched checkout and its ssh target, or a refusal.

    Both range endpoints and commit-window selectors run git. Letting either accept a caller's cwd
    turns a read of this relay's record into a read of arbitrary local or remote repositories.

    Watched means "a pane is open there now, or this relay has recorded a turn there" — the second
    half matters as much as the first. A record outlives its panes, which is the whole reason turns
    are kept by fingerprint, and a conversation read a week later is one whose panes are all gone.
    Live panes only would refuse exactly the historical questions this feature exists to answer,
    while still letting a client name any path it liked in a fresh session.
    """
    cwd = msg.get("cwd") or ""
    host = msg.get("host") or "local"
    if not cwd:
        raise ValueError("a commit range needs a cwd to resolve it in")
    for pane in agent_cache.values():
        if (pane.get("cwd") or "") == cwd and (pane.get("host") or "local") == host:
            return cwd, pane.get("remote")
    if conv_log is not None and conv_log.knows_directory(host, cwd):
        if host == "local":
            return cwd, None
        # The host is named in the record but has no pane open right now, so the ssh target it was
        # reached through is not in this snapshot. Nothing can be run there, and saying so beats
        # running the question against this machine's own filesystem under a remote host's name.
        for pane in agent_cache.values():
            if (pane.get("host") or "local") == host:
                return cwd, pane.get("remote")
        raise ValueError(f"no pane is open on {host}, so its checkout cannot be read")
    raise ValueError("this relay is not watching that directory")


def conv_log_window(msg):
    """(since, until) in milliseconds, with a commit range resolved into one.

    "Every conversation between these two commits" needs nothing stored per turn: a turn already
    knows when it happened, and git knows when a commit did. So the range is resolved to a time
    window at question time and the ordinary query answers it — which is why the record does not
    have to keep a list of commits to be searchable by one.

    Raises ValueError with something a person can act on: a commit that cannot be resolved is
    usually a sha from another checkout, and a silent empty answer would read as "nothing happened".
    """
    since, until = msg.get("since"), msg.get("until")
    first, last = msg.get("since_commit"), msg.get("until_commit")
    if not first and not last:
        return since, until
    cwd, remote = git_cwd_target(msg)
    for sha, name in ((first, "since_commit"), (last, "until_commit")):
        if not sha:
            continue
        sha = str(sha)
        if not GIT_SHA_RE.match(sha):
            raise ValueError(f"{name} must be a commit sha")
        when = git_probe.commit_time(cwd, sha, remote)
        if when is None:
            raise ValueError(f"{name}: {sha} is not a commit in {cwd}")
        if name == "since_commit":
            since = when if since is None else max(int(since), when)
        else:
            until = when if until is None else min(int(until), when)
    return since, until


# The branch last seen in each checkout, keyed by (host, cwd) — a branch is a fact about a working
# directory and not about a pane. Two agents in one repository are on one branch by definition, so
# keying this by pane would answer the same question twice, run two subprocesses to do it, and
# leave whichever pane had not ended a turn yet showing nothing.
#
# Filled by the probe below and by nothing else: read at turn end, or once when a reader addresses
# a pane. Never per poll, which is the whole reason this feature costs nothing to leave on.
pane_branch = {}


def branch_key(pane):
    return (pane.get("host") or "local", pane.get("cwd") or "")


async def seed_branches(panes):
    """Fill in any directory this relay has not seen yet, so the app's badge is never blank.

    Two ways to arrive at one with nothing known about it, and they want different answers:

      - a **restart**. The map above is memory and the record is not, so every directory an agent
        has ever ended a turn in is already answered on disk. One indexed read, no subprocess.
      - a **new agent in a new checkout**. Nothing has been recorded there yet, and waiting for its
        first turn means the badge is blank for exactly as long as the reader is deciding what to
        ask it — which is when they most want to know they are on `main`. So git is asked, once,
        with the same single `rev-parse` the turn-end probe uses.

    Both are per directory and happen once. A miss is remembered as a miss, so a pane outside a
    checkout costs one question rather than one per poll for as long as it is open.
    """
    if not GIT_TRACK:
        return
    # Any pane in the directory will do for the remote: it is how the *host* is reached, and the
    # key already names the host.
    unseen = {}
    for p in panes:
        key = branch_key(p)
        if key not in pane_branch:
            unseen.setdefault(key, p.get("remote"))
    for (host, cwd), remote in unseen.items():
        if not cwd:
            pane_branch[(host, cwd)] = ""
            continue
        try:
            branch = await asyncio.to_thread(conv_log.last_branch, host, cwd)
            if not branch:
                branch = (await asyncio.to_thread(git_probe.head, cwd, remote))[0]
            pane_branch[(host, cwd)] = branch
        except (sqlite3.Error, OSError) as e:
            log.debug("branch seed failed for %s: %s", cwd, e)


async def probe_git(pane):
    """The branch, the commit, and what was committed since this directory's last turn.

    Off the event loop: this is a subprocess, and an ssh round trip for a remote pane. `None` for
    anything that is not a checkout, which `record` stores as no repository rather than as an
    empty one.
    """
    if not GIT_TRACK:
        return None
    cwd = pane.get("cwd") or ""
    if not cwd:
        return None
    try:
        since = await asyncio.to_thread(conv_log.last_commit, pane.get("host") or "local", cwd)
        got = await asyncio.to_thread(git_cache.probe, cwd, pane.get("remote"), since,
                                      GIT_COMMITS)
    except (sqlite3.Error, OSError) as e:
        log.debug("git probe failed for %s: %s", cwd, e)
        return None
    # Every caller reaches the probe, so remembering it here is the one place that catches a turn
    # ending, a prompt being delivered, and a reader addressing a pane alike.
    if got and got.get("branch"):
        pane_branch[branch_key(pane)] = got["branch"]
    return got


# Shared user state: the four documents that are facts about the work rather than about one
# browser. Unconditional, unlike the conversation log above — that one is off by default because a
# transcript puts what agents *said* on disk, which is the user's call to make. A pair's name is a
# label the user typed into this app and cannot be anything else, and a feature that is off by
# default is a feature that silently does not work.
STATE_DB = own_db("HERDR_STATE_DB",
                  os.path.join(PROJECT_ROOT, ".herdr-remote", "state.sqlite3"))
user_state = None

# How often the relay takes a copy of its own state, in hours; `0` switches it off. Run by this
# process and not by launchd or cron: a system-level job is a second thing to install, a second
# thing to remember to remove, and on macOS a permission dialog about a program the person did not
# start. The data being copied belongs to the relay, and so does the schedule.
#
# Never for a test relay. The script writes to the checkout's own `.herdr-remote/`, which is the
# running install's — the same trap `own_db` exists for, and one a backup would spring on every
# suite that spawns a relay.
BACKUP_EVERY_H = 0 if is_test_relay() else float(os.environ.get("HERDR_BACKUP_HOURS") or 24)
BACKUP_DIR = os.environ.get("HERDR_BACKUP_DIR") or os.path.join(
    PROJECT_ROOT, ".herdr-remote", "backups")
BACKUP_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "backup-state.sh")


def last_backup_at():
    """When the newest backup was taken, or 0 if there are none.

    Read off the directories rather than kept in memory, so the schedule survives a restart: a
    relay restarted six times a day still backs up once, and one that has been down for a week
    backs up as soon as it is running again.
    """
    try:
        return max((os.path.getmtime(os.path.join(BACKUP_DIR, n))
                    for n in os.listdir(BACKUP_DIR)
                    if re.fullmatch(r"\d{8}-\d{6}(?:-\d+)?", n)
                    and os.path.isdir(os.path.join(BACKUP_DIR, n))), default=0)
    except OSError:
        return 0


async def backup_loop():
    """A copy of the databases, taken by the relay itself. See `relay/backup-state.sh`.

    Checked every ten minutes rather than slept for a day: a laptop that was closed at 03:00 has
    no timer waiting for it when it opens, and "back up if the last one is old enough" is the same
    rule whether the machine has been awake for an hour or a month.
    """
    while True:
        try:
            if time.time() >= last_backup_at() + BACKUP_EVERY_H * 3600:
                # In a thread: it is a shell script that copies tens of megabytes, and the poll
                # loop and every open socket are on this one event loop.
                done = await asyncio.to_thread(
                    subprocess.run, [BACKUP_SCRIPT],
                    capture_output=True, text=True, timeout=600)
                if done.returncode:
                    log.warning("backup failed (%d): %s", done.returncode,
                                (done.stderr or done.stdout or "").strip()[:400])
                else:
                    log.info("%s", (done.stdout or "").strip())
        except Exception as e:                   # noqa: BLE001 — a backup is never worth a crash
            log.warning("backup: %s", e)
        await asyncio.sleep(600)
try:
    user_state = UserState(STATE_DB)
except (sqlite3.Error, OSError) as e:
    # Same posture as the record above: a relay that will not start because a file is unwritable is
    # a worse failure than one that says so and leaves every browser on its own state.
    print(f"herdr-remote: shared state disabled: {e}", file=sys.stderr)

# Who is in each pane, as opposed to which pane it is. The same file as the shared state above:
# both are facts about the work rather than about one browser, and an identity registry in a
# database of its own is a third thing to back up and a third thing to lose.
agent_ids = None
try:
    agent_ids = AgentIds(STATE_DB)
except (sqlite3.Error, OSError) as e:
    # A relay with no registry still lists panes, still reads them and still starts sessions. The
    # clients fall back to the pane fingerprint they used before this existed.
    print(f"herdr-remote: agent ids disabled: {e}", file=sys.stderr)

# The agents this relay knows that have no live pane, as the last poll left them. Held rather than
# queried per connect: it is answered into every snapshot, and a snapshot goes out every poll.
latest_retired = []


def start_options_message():
    """The client's Start gate, and now its agent configs too. Blocking — it reads the store.

    Sent once on connect, and again to everyone whenever the configs document changes: half of a
    config is this relay's answer about it — the harness, whether this machine's keystore holds the
    key id it names, the command line the spawn will run — and no browser can compute that.

    Names, never values. `key` is a keystore id and `key_set` says whether the keystore holds a key
    under it, which is the most that can be said about a credential in a message a client receives.
    """
    return {
        "type": "start_options", "agents": START_AGENTS, "roles": list(ROLES),
        "terminal": TERMINAL,
        "configs": public_configs(agent_aliases(), AGENT_PROVIDERS),
        "providers": public_providers(AGENT_PROVIDERS),
        # Which kinds can be started with their own approval prompts off. The flag is the vendor's
        # and differs per harness, so the client asks for the *state* and is told here which kinds
        # can be in it — a checkbox drawn against a kind that cannot is a start refused later.
        "unattended": unattended_kinds(),
    }


def agent_aliases():
    """The user's agent configs, as the shared store currently holds them.

    Read per request rather than cached: the document is edited from the app, and a spawn that
    used a provider binding the user changed a minute ago is the one failure this feature must
    not have. It is a single-row SQLite read.
    """
    if user_state is None:
        return []
    body = user_state.get(["agent_configs"])["agent_configs"]["body"]
    return parse_aliases(body, AGENT_PROVIDERS)

# The web app, served from disk on every request so an edit needs only a browser reload.
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
# Name -> (Content-Type, extra headers). The manifest and the icons are not decoration: iOS only
# offers Add to Home Screen for a page that has them, and only a home-screen web app can receive
# Web Push at all — so on iOS these files are the difference between push working and not existing.
STATIC_FILES = {
    "sw.js": ("application/javascript",
              (("Cache-Control", "no-cache"), ("Service-Worker-Allowed", "/"))),
    "manifest.webmanifest": ("application/manifest+json", (("Cache-Control", "no-cache"),)),
    "logo.svg": ("image/svg+xml", ()),
    "apple-touch-icon.png": ("image/png", ()),
    "icon-192.png": ("image/png", ()),
    "icon-512.png": ("image/png", ()),
}

# Remote hosts: comma-separated SSH targets
REMOTES = [r.strip() for r in os.environ.get("HERDR_REMOTES", "").split(",") if r.strip()]

# Configured Projects: read at startup, fail closed. Unset means Projects are disabled.
# FILE_PROJECTS is what the file said; PROJECTS is that plus the children found under any root it
# marked. Re-read on a change from the poll loop — see refresh_projects, which is where the two
# stop being the same thing and why a bad edit after boot does not stop a running relay.
PROJECTS_PATH = os.environ.get("HERDR_PROJECTS_FILE", "")
try:
    FILE_PROJECTS = load_projects(PROJECTS_PATH, valid_hosts=REMOTES)
except ProjectConfigError as e:
    print(f"herdr-remote: bad Projects config: {e}", file=sys.stderr)
    sys.exit(1)
PROJECTS = FILE_PROJECTS + child_projects(FILE_PROJECTS)
# How often a root is listed even when nothing about it has changed. The stamp below catches a
# child appearing or being removed, because that moves the root directory's own mtime; it does not
# catch a `marker` file being created *inside* a directory that was already there, which is
# exactly what `git init` does. One listing a minute closes that without watching a tree.
PROJECT_RESCAN_MS = 60_000
_projects_stamp = ()
_projects_listed = 0.0
# Directories under a root that exist and are not projects, as (root, name, reason). Kept so the
# reason is logged when it first appears and not once a minute for as long as it is true.
_projects_skipped = ()

# Write extensions (P2 start_agent) spawn processes on this machine and on any configured
# SSH target, so an unauthenticated listener that reaches them is process spawn granted to the
# network. Still fail-closed, but the rule is now per listener rather than global.
WRITE_EXT = os.environ.get("HERDR_ENABLE_WRITE_EXT", "") == "1"

# Not folded into HERDR_ENABLE_WRITE_EXT: that gate exists for starting agents, and someone who
# enabled it to spawn a session from a phone did not thereby consent to a shell. Off means the
# shells are never parsed, so known_panes does not grow and pane_guard behaves exactly as before.
TERMINAL = os.environ.get("HERDR_ENABLE_TERMINAL", "") == "1"

# Run in a terminal *this relay opened*, once, as soon as its shell reaches a prompt. herdr spawns
# the user's login shell, so a pane opened from a phone arrives wearing whatever prompt their rc
# files draw — which on a 40-column screen is usually most of the line, and on zsh is usually the
# right-hand half of it. This is the only place that can trim it: passing PROMPT/RPROMPT in the
# environment does nothing, because the rc files run *after* the environment is set and overwrite
# them. `clear` hides the init line itself, so the pane opens at a bare prompt with nothing above.
#
# On by default, unlike every other switch here, because those defend the user's data or grant a
# capability and this is cosmetic and scoped to a pane the app created a second ago. A shell the
# user opened in herdr themselves is never written to. Set it to "" to send nothing, or to
# whatever their shell wants — `RPROMPT=` is a harmless no-op assignment in bash, and fish would
# need `function fish_right_prompt; end`.
TERMINAL_INIT = os.environ.get("HERDR_TERMINAL_INIT", "RPROMPT=; clear")
TERMINAL_INIT_WAIT = 8      # seconds to wait for the new shell's prompt before sending anyway
TERMINAL_INIT_POLL = 0.4

# Arbitration. Off means off (N10): unset, nothing is constructed, no trigger fires, and the wire is
# byte-for-byte what it was. Both companions are hard requirements rather than conveniences — the
# whole output of a session is text typed into somebody's terminal, which is what WRITE_EXT gates,
# and every prompt is built out of the record, so a session without one is an arbitrator asked to
# decide with no evidence. Quiet when the flag is off; loud when it is on and cannot be honoured.
ENABLE_ARBITER = os.environ.get("HERDR_ENABLE_ARBITER", "") == "1"
if ENABLE_ARBITER and not (WRITE_EXT and conv_log is not None):
    print("herdr-remote: HERDR_ENABLE_ARBITER=1 requires HERDR_ENABLE_WRITE_EXT=1 and "
          "HERDR_CONV_LOG=1", file=sys.stderr)
    sys.exit(1)
# Built in main(), once the herdr helpers it calls exist. MAIN_LOOP is how the thread a session
# runs on reaches them — see on_loop.
arbitration = None
MAIN_LOOP = None

# An externally reachable listener is never token-free. This is the one rule with no opt-out:
# the external port exists to be published through a tunnel.
if EXTERNAL_PORT and not AUTH_TOKEN:
    print(
        "herdr-remote: HERDR_EXTERNAL_PORT requires HERDR_RELAY_TOKEN to be set",
        file=sys.stderr,
    )
    sys.exit(1)

# Same port for both listeners would bind the LAN socket first and then fail on the external one,
# leaving a half-configured relay whose surviving listener is the *open* one. Refuse instead.
if EXTERNAL_PORT and EXTERNAL_PORT == WS_PORT:
    print(
        f"herdr-remote: HERDR_EXTERNAL_PORT and HERDR_RELAY_PORT are both {WS_PORT}",
        file=sys.stderr,
    )
    sys.exit(1)

# P2 refused to boot on WRITE_EXT without a token, full stop. That rule is repealed only for a
# LAN operator who says so in as many words, because HERDR_LAN_OPEN=1 is the whole of local mode.
# Deriving it from anything else — the absence of a token, the presence of a tunnel — would let a
# configuration change silently drop authentication from the port the whole network can reach.
if WRITE_EXT and not AUTH_TOKEN and not LAN_OPEN:
    print(
        "herdr-remote: HERDR_ENABLE_WRITE_EXT=1 requires HERDR_RELAY_TOKEN, "
        "or HERDR_LAN_OPEN=1 to run the LAN listener without one",
        file=sys.stderr,
    )
    sys.exit(1)

# Per-listener authentication policy. The LAN listener keeps requiring a token whenever one is
# set: adding a tunnel must never be the thing that opens the LAN port.
LAN_REQUIRES_TOKEN = bool(AUTH_TOKEN) and not LAN_OPEN

try:
    START_AGENTS = load_start_agents(os.environ.get("HERDR_START_AGENTS", ""))
except StartAgentConfigError as e:
    print(f"herdr-remote: bad start agent allowlist: {e}", file=sys.stderr)
    sys.exit(1)

# Providers are file-only, and a malformed file is fatal for the same reason a malformed ops
# registry is: this names the endpoints credentials may be sent to, and a relay that started
# having half-understood it would be a relay nobody can reason about. Absent is not malformed —
# it means no custom providers exist, which is the default state.
try:
    AGENT_PROVIDERS = load_providers(os.environ.get("HERDR_AGENT_CONFIGS", ""))
except AgentConfigError as e:
    print(f"herdr-remote: bad agent config file: {e}", file=sys.stderr)
    sys.exit(1)

TOOL_OPTIONS = ["yes, single permission", "trust, always allow", "no (tab to edit)"]
# `› 1. Yes, continue` — the marker is whichever glyph the TUI puts against the *selected* row, and
# the line is the whole of the option. Captured rather than skipped: one row of a real menu always
# carries one, and it is the only thing that separates a menu from prose. See detect_choices.
#
# Only the pointing glyphs count. A bullet is not a selection: `•` is codex's own speaker gutter,
# so `• 1. 1d973b3 — mods` — the first line of an answer that happens to be a numbered list — read
# as a selected menu row, and the pane flickered between blocked and idle every poll. Still
# stepped over, so a menu drawn with bullets on its rows still parses; it just cannot prove itself
# with one.
CHOICE_RE = re.compile(r"^\s*(?:([\u203a>\u276f])|[*\u2022])?\s*([1-9])[.)]\s+(\S.*)$")
CHOICE_ANSWER_RE = re.compile(r"^([1-9])(?:[.)]\s.*)?$")
CHOICE_TAIL = 25       # lines from the bottom a menu can be in
CHOICE_MAX = 6         # options offered on; a longer list is prose that happens to be numbered
SUBAGENT_OPTIONS = ["approve all pending", "configure individually", "exit (cancel subagents)"]
CHROME_RE = re.compile(
    r"^[\s─━═_—│|◔◑◕●\s]+$"
    r"|Kiro\s[·•]"
    r"|esc to cancel"
    r"|type to queue"
    r"|^\s*[◔◑◕●]\s+(Shell|Bash)"
)

clients = set()
last_statuses = {}
event_queue = asyncio.Queue()
pane_remote_map = {}
known_panes = set()
agent_cache = {}
ambiguous_panes = set()  # bare pane IDs seen on >1 host this poll; every pane command refuses them
# The other way to name a pane: by the agent in it. Rebuilt each poll from the roster the
# identity pass has just stamped, so it holds live panes only — an aid whose agent has ended
# is absent, which is what makes "unknown aid" the honest answer rather than a stale route.
pane_by_aid = {}
latest_agents = []  # last full snapshot, replayed to each client on connect
latest_shells = []  # shell panes from the same snapshot; empty and unused when TERMINAL is off
shell_panes = set()  # pane IDs in latest_shells: the respond refusal, and submit_paste's shortcut

SAFE_RESPONSES = {"y", "n", "a", "yes", "no", "trust", "yes, single permission", "trust, always allow", "no (tab to edit)", "approve all pending", "configure individually", "exit (cancel subagents)"}
# "ctrl+<key>" and not "C-<key>": herdr accepts C-c as a legacy spelling but answers
# {"code":"invalid_key","message":"unsupported key C-l"} for the rest of that family.
#
# The rest of this set is what the shipped web keys pad actually sends, which until now it mostly
# could not: only ctrl+l of the six Ctrl presets was listed here, so Ctrl C, D, R, U and Z each
# came back "keys contain disallowed values" — as did Space, and Tab under an armed Shift. All of
# them were probed against herdr 0.8.0 and accepted. "BSpace" went the other way: herdr refuses it
# and no client ever sent it, so it leaves.
#
# Note the gap this does not close. `fireKey` composes an armed modifier with *any* pad key, so
# shift+Escape and ctrl+Up are reachable and are still refused. Enumerating that cross-product
# here is the wrong fix — it wants a modifier grammar in the guard — and it is out of T1's scope.
SAFE_KEYS = {"y", "n", "a", "Enter", "Tab", "Escape", "Space", "shift+Tab", "C-c",
             "ctrl+c", "ctrl+d", "ctrl+l", "ctrl+r", "ctrl+u", "ctrl+z",
             "Up", "Down", "Left", "Right"} | {
    str(number) for number in range(10)
}

# --- Audit logging ---
_audit_handler = RotatingFileHandler(AUDIT_FILE, maxBytes=5 * 1024 * 1024, backupCount=3)
_audit_handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", datefmt="%Y-%m-%dT%H:%M:%S"))
audit_log = logging.getLogger("herdr-audit")
audit_log.setLevel(logging.INFO)
audit_log.addHandler(_audit_handler)
audit_log.propagate = False


def audit(action: str, ip: str, device: str, pane_id: str, detail: str = ""):
    """Append a write action to the audit log as structured JSONL."""
    import datetime
    entry = {
        # Same "…Z" shape the log has always had; utcnow() is deprecated in 3.12+.
        "ts": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
        "action": action,
        "paneId": pane_id,
        "ip": ip,
        "device": device,
    }
    if detail:
        entry["detail"] = detail[:120]  # truncate like collie
    audit_log.info(json.dumps(entry, separators=(",", ":")))


# --- Web Push helpers ---
def _load_push_subs():
    global push_subscriptions
    if os.path.isfile(PUSH_SUBS_FILE):
        try:
            with open(PUSH_SUBS_FILE) as f:
                push_subscriptions = json.load(f)
        except Exception:
            push_subscriptions = []


def _save_push_subs():
    with open(PUSH_SUBS_FILE, "w") as f:
        json.dump(push_subscriptions, f)


# A notification is per pane, not per herd. Two panes blocked at once are two things you have to
# decide about, and a single collapse key made the second silently replace the first — on the
# Topic header at the push service, and again on the tag in the service worker. RFC 8030 restricts
# Topic to the URL-safe base64 alphabet and 32 characters, which a herdr pane ID ("w24:p12")
# is not, hence the substitution.
def push_tag(pane_id: str) -> str:
    return ("herdr-" + re.sub(r"[^A-Za-z0-9_-]", "-", pane_id or "herd"))[:32]


def push_topic(tag: str) -> str:
    """The same tag, as a value Apple will accept in the Topic header.

    RFC 8030 says Topic is up to 32 characters of the URL-safe base64 alphabet. Apple reads that
    literally and *decodes* it, so a length of 4n+1 — which no base64 string can have — is rejected
    with `BadWebPushTopic` and a 400, and the push is never delivered. "herdr-w24-p22" is 13
    characters, and every notification for a two-digit pane on a two-digit window has been failing
    on that alone. Verified against web.push.apple.com: 13 and 25 are refused, 11, 14, 24, 26 and
    32 are accepted, 33 is refused.

    One character of padding rather than a hash of the tag: the header stays the pane it is about,
    which is what makes a failing push readable in a log.
    """
    t = (tag or "herdr-herd")[:32]
    return t + "-" if len(t) % 4 == 1 else t


# Lines a pane draws to frame its own output rather than to say anything.
_BOXY = re.compile(r"^[\s─-╿▀-▟=~_+*#.\-]*$")
# The choices under a prompt. They are the least informative part of it on a Lock Screen: the
# question is what you need to read, and the answer needs the app open either way.
_CHOICE = re.compile(r"^\s*[❯>›•●]?\s*\d+[.)]\s")
# Leading gutter glyph and box side, stripped so the text starts at the text.
_LEAD = re.compile(r"^[\s│┃┊⏺•❯>›└├⎿⋯]+")
# The footer an agent animates while it thinks ("✻ Baked for 22s"). True of the pane, says
# nothing about what it wants.
_SPINNER = re.compile(r"^[✻✽✳✶✢∗*]\s")


def notify_body(content: str, limit: int = 140) -> str:
    """The part of a pane worth reading on a Lock Screen.

    Reads from the bottom, because what a pane wants is always at its bottom — the previous
    version took `content[:120]`, the top of the scrollback, which on a long-running agent is
    whatever it happened to be doing minutes ago.
    """
    kept = []
    for raw in reversed((content or "").splitlines()):
        # Strip the frame before testing, or every rule has to know about the box the line is in:
        # a choice inside a prompt box arrives as "│ ❯ 1. Yes  │", which matches nothing.
        line = _LEAD.sub("", raw.rstrip().rstrip("│┃")).strip()
        if not line or _BOXY.match(line) or _CHOICE.match(line) or _SPINNER.match(line):
            continue
        kept.append(line)
        if len(kept) == 3:
            break
    text = " ".join(reversed(kept))
    return text[:limit - 1] + "…" if len(text) > limit else text


def finished_body(content: str, agent: str) -> str:
    """What a "finished" push says: the agent's closing message, or the bottom of the pane.

    summary_body returns None for a harness it has no profile for and for a pane that stopped on a
    command rather than on words, so the fallback is reached on its own as often as it is by the
    setting.
    """
    return (PUSH_SUMMARY and summary_body(content, agent)) or notify_body(content)


async def send_web_push(title: str, body: str, url: str = "/", clear: bool = False,
                        tag: str = "herdr-herd"):
    """Send push notification to all registered subscriptions.

    Uses a per-pane collapse topic + TTL so an offline device gets the latest state of each pane
    rather than a burst of stale ones. If clear=True, sends a clear instruction instead of
    showing a notification.
    """
    if not VAPID_PUBLIC_KEY or not VAPID_PRIVATE_KEY:
        return
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        log.warning("pywebpush not installed, skipping push")
        return
    if clear:
        payload = json.dumps({"type": "clear", "tag": tag})
    else:
        payload = json.dumps({"title": title, "body": body, "url": url, "tag": tag})
    headers = {"Topic": push_topic(tag), "TTL": "21600"}  # 6h TTL, collapse key
    dead = []
    for i, sub in enumerate(push_subscriptions):
        try:
            webpush(
                subscription_info=sub,
                data=payload,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_SUBJECT},
                headers=headers,
            )
        except Exception as e:
            # The body, not only the status. Every push to Apple has been failing `400 Bad Request`
            # and `str(e)` says only that — which is the one part of a 400 that carries no
            # information, since the reason is always in the response Apple sends with it.
            detail = getattr(getattr(e, "response", None), "text", "") or ""
            log.warning("Push failed for sub %d: %s%s", i, e,
                        f" — {detail.strip()[:300]}" if detail.strip() else "")
            if "410" in str(e) or "404" in str(e):
                dead.append(i)
    if dead:
        for i in reversed(dead):
            push_subscriptions.pop(i)
        _save_push_subs()

_load_push_subs()


# agent start blocks until the agent is interactively ready (AGENT_START_TIMEOUT_MS), so its
# subprocess must outlive herdr's own wait — otherwise a slow cold start is killed here and
# reported as a failure while the agent is in fact coming up. Every other call keeps the
# 15s default so the poll loop still fails fast on a dead SSH host.
START_EXEC_TIMEOUT = AGENT_START_TIMEOUT_MS / 1000 + 15
# `agent start` wants a pane already sitting at its shell prompt, and a pane created a moment
# earlier is not there yet — a login shell that sources a real profile takes a second or several
# to arrive. herdr refuses with agent_pane_busy and has no "wait for the prompt" primitive to ask
# for instead, so the precondition is retried rather than raced. Measured against the failures
# this fixes: the refusal came back in about a second and the same start succeeded on a retry
# seven seconds later. A pane that never reaches a prompt still fails, just later.
# Two spellings because the refusal reaches here by two routes: _herdr_reason keeps only the
# message when herdr puts its error body on stdout, and the whole JSON blob when it lands on
# stderr. Matching either survives that, and neither is a substring of any other refusal.
PANE_NOT_READY = ("agent_pane_busy", "not an available shell")
PANE_READY_WAIT = 20     # seconds to keep offering the pane before giving up
PANE_READY_POLL = 0.25   # measured: herdr's refusal clears in well under half a second


# %r@%h:%p — one socket per user@host:port, in the user's own runtime dir. Not LOG_DIR: the path
# is bounded by the platform's socket name limit (~104 bytes on macOS) and a deep log path
# silently disables multiplexing rather than failing.
SSH_CONTROL_PATH = os.path.join(tempfile.gettempdir(), "herdr-relay-%r@%h:%p")


def run_herdr_result(*args, remote=None, timeout=15):
    if remote:
        # Quoted, because ssh does not take an argv. It concatenates everything after the target
        # and hands the result to the remote login *shell*, so an unquoted argument carrying a
        # semicolon, a backtick or $(...) is a command on that host — and several of these
        # arguments are client-supplied (the text of a send_text, a pane label, a line count).
        # One shell word per argument here is what keeps every caller's arguments data.
        # The local branch needs none of this: no shell is involved in an argv exec.
        remote_cmd = " ".join(shlex.quote(a) for a in (HERDR, *args))
        # One multiplexed connection per host instead of a TCP connect, a key exchange and an
        # auth round trip per call. Every open pane costs two of these calls every three seconds
        # on top of the poll loop, so the handshake was the dominant cost of a remote pane — and
        # it is paid on the relay's event loop. ControlPersist keeps the master alive between
        # them; a stale socket is reopened by ssh itself, so there is nothing to clean up.
        cmd = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
               "-o", "ControlMaster=auto", "-o", f"ControlPath={SSH_CONTROL_PATH}",
               "-o", "ControlPersist=60s", remote, remote_cmd]
    else:
        cmd = [HERDR, *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def run_herdr(*args, remote=None):
    try:
        return run_herdr_result(*args, remote=remote).stdout.strip()
    except Exception:
        return ""


@functools.lru_cache(maxsize=1)
def herdr_version():
    """The herdr on this host, as `herdr --version` prints it: "herdr 0.8.0".

    Asked once and remembered — the binary does not change under a running relay, and this is on
    the path every client connects through. Empty when herdr is missing or does not answer, which
    the page shows as unknown rather than as a version it invented.
    """
    out = run_herdr("--version")
    return out.split()[-1] if out else ""


def split_panes(panes, host_label, remote=None, include_shells=False):
    """(agents, shells) from one host's parsed `pane list`. Pure.

    Shells were always in this payload — the agent filter is the only reason a client has never
    seen one, and reading them costs no extra call. Returned as a second list rather than tagged
    into the first: a shell has no status, and a snapshot that *can* carry one into an agent group
    is a snapshot that eventually will.

    Spacers are dropped. A spacer is a usable shell, and it is also the only pane this application
    closes on its own (`plan_slot`), so listing one offers the reader a pane the product may delete
    out from under them.
    """
    agents, shells = [], []
    for p in panes:
        if p.get("agent"):
            # Copied verbatim, key order included: with terminal mode off the wire has to stay
            # byte-identical, and json.dumps preserves insertion order. Do not fold the two
            # literals below into a shared base — that reorders these keys.
            agents.append({
                "pane_id": p["pane_id"],
                "agent": p.get("agent", ""),
                "label": p.get("label", ""),
                "status": p.get("agent_status", "unknown"),
                "cwd": p.get("cwd", ""),
                "project": os.path.basename(p.get("cwd", "")),
                "host": host_label,
                "remote": remote,
                "workspace_id": p.get("workspace_id", ""),
                "tab_id": p.get("tab_id", ""),
            })
        elif include_shells and not is_spacer(p):
            shells.append({
                "pane_id": p["pane_id"],
                "label": p.get("label", ""),
                "cwd": p.get("cwd", ""),
                "project": os.path.basename(p.get("cwd", "")),
                "host": host_label,
                "remote": remote,
                "workspace_id": p.get("workspace_id", ""),
                "tab_id": p.get("tab_id", ""),
            })
    return agents, shells


def get_panes_from_host(remote=None):
    raw = run_herdr("pane", "list", remote=remote)
    try:
        panes = json.loads(raw).get("result", {}).get("panes", [])
    except (json.JSONDecodeError, KeyError, AttributeError):
        # AttributeError because json.loads("null") is None, which the .get chain would raise on.
        return [], []
    return split_panes(panes, remote or "local", remote, include_shells=TERMINAL)


def get_all_panes():
    agents, shells = get_panes_from_host(remote=None)
    for remote in REMOTES:
        more_agents, more_shells = get_panes_from_host(remote=remote)
        agents.extend(more_agents)
        shells.extend(more_shells)
    return annotate_agents(agents, PROJECTS), annotate_agents(shells, PROJECTS)


# pane_id -> the agent config it was started under. Memory only, and deliberately: a pane
# outlives this process, so a relay restart forgets which alias started one that is still
# running and the badge falls back to the harness. The alternative is a durable record of
# something herdr does not model, keyed on ids that mean nothing after a herdr restart.
# ponytail: in-memory, one entry per started pane. If it needs to survive a relay restart it
# belongs in the state store keyed by [host, cwd, label], not by pane id.
pane_config = {}
# pane_id -> the client's own id for the start that made it, when it named one. The answer to a
# start is a single message on the socket that asked, so a browser reloaded while herdr is bringing
# the agent up loses the only record of which pane it was waiting for — and then has nothing to
# match on but the pane's name and directory, which two colleagues in one checkout share. Carried
# on the snapshot so that match is an equality instead of a guess. Opaque here: never parsed, never
# logged, never passed to a shell. In memory, like pane_config beside it — a relay restart drops it,
# and by then no client is still waiting on that start.
pane_ref = {}
# What a start said about itself that herdr does not report back: the opening prompt's name and
# the role. Memory, like pane_config beside it — the durable copy is the identity registry, which
# picks these up off the snapshot on the next poll.
pane_spawn = {}


# Panes this relay started, watched briefly for a menu herdr does not call blocked. A codex opened
# in a directory it has not been trusted in shows its trust prompt while herdr still reports the
# pane `idle` — there is no transition, so nothing is broadcast, and the app shows a pane sitting
# quiet at a question nobody can answer from it. Watched only for a short window after the start and
# only while the pane is idle: one extra pane read per poll, on one pane, over the minute a first
# prompt can appear in.
# ponytail: spawn only. A mid-session menu arrives at a pane herdr does call blocked (verified
# against codex 0.145.0), so this does not become a read of every idle pane.
SPAWN_WATCH_S = 90
spawn_watch = {}  # pane_id -> monotonic deadline

# A kind's own opening lines wait this long for a first prompt to follow before they are sent on
# their own. Long enough for a client to start a pane and then type into it, short enough that a
# pane nobody prompts is still trusted while the person who started it is still looking at it.
INIT_AFTER_WAIT_S = 45
init_pending = {}  # pane_id -> (monotonic deadline, [line], remote)


def spawn_menu_pending(pane_id, now):
    """Is this pane still inside its post-start window? Expired entries are dropped as they are
    found, which is the whole of this map's cleanup."""
    deadline = spawn_watch.get(pane_id)
    if deadline is None:
        return False
    if deadline <= now:
        del spawn_watch[pane_id]
        return False
    return True


def snapshot_message():
    """The full-state broadcast. `shells` is present whenever terminal mode is on, including as an
    empty list — its presence is the client's feature gate, as start_options is for Start."""
    msg = {"type": "agents", "agents": latest_agents}
    if TERMINAL:
        msg["shells"] = latest_shells
    # The agents with no pane, so a client can offer to restart one from any browser rather than
    # only from the one that happened to watch it start. Present whenever the registry is, empty
    # list included — its presence is the client's gate, as `shells` is for terminal mode.
    if agent_ids is not None:
        msg["retired"] = latest_retired
    return msg


# The client asks for a depth and the relay decides what it is willing to read. Bounded because
# the read is synchronous, runs every few seconds per open pane, and crosses SSH for a remote
# one — an unbounded number here is a client asking the relay to spend a host's disk and a
# tunnel's bandwidth. Anything unparseable falls back rather than refusing: a read is not worth
# an error round trip, and 30 lines still shows the reader something.
READ_LINES_MAX = 50000
READ_LINES_DEFAULT = 30
# What pane_cols samples, however deep the read goes. The wrap column is a property of the pane
# now, so the newest lines are the ones that carry it — sampling 50k of scrollback to measure it
# costs a second full read and answers with the width the pane used to be.
COLS_SAMPLE_LINES = 200


def read_pane_lines(raw):
    try:
        return max(1, min(int(raw), READ_LINES_MAX))
    except (TypeError, ValueError, OverflowError):
        return READ_LINES_DEFAULT


def read_pane_content(pane_id, lines, source, remote=None):
    """(content, cols) for one read_pane. Blocking; call through asyncio.to_thread."""
    content = run_herdr("pane", "read", pane_id, "--lines", str(lines),
                        "--source", source, remote=remote)
    return content, pane_cols(pane_id, lines, remote=remote)


def pane_cols(pane_id, lines, remote=None):
    """The wrap column of the scrollback being sent, or None if it cannot be established.

    The browser lays unwrapped output out at this width, so a wrong number is worse than no
    number. It is measured from the pane's own hard-wrapped scrollback rather than taken from
    `pane layout`: that rect is herdr's *layout model* of an attached client's window, and it
    disagrees with the PTY whenever the pane was resized after it was created. A pane started
    under the pre-0.8.0 split-then-close flow reported 54 there while its recent output
    demonstrably wrapped at 138 — the client then scaled every glyph to a pane half the real
    width.

    `--source recent` is the same scrollback `recent-unwrapped` returns with the terminal's own
    breaks left in, so the longest line in it *is* the column those breaks were made at. Never
    sampled deeper than the lines being sent, and never deeper than COLS_SAMPLE_LINES either: a
    pane that has been made narrower still holds wider lines further back, and reporting one of
    those would lay the text out too wide. The shallower sample is therefore the more accurate
    one as well as the cheaper one — this is a second `pane read`, over SSH for a remote pane,
    on every request. Read per request, never cached — splitting or resizing a pane changes it.
    """
    raw = run_herdr("pane", "read", pane_id, "--lines", str(min(lines, COLS_SAMPLE_LINES)),
                    "--source", "recent", remote=remote)
    # ponytail: a sample that happens to hold no wrapped line reads narrower than the pane is.
    # Only ever an under-estimate, and a harmless one — nothing wrapped, so nothing is laid out
    # wrongly and the text is merely scaled larger than it had to be. Take the width off the PTY
    # instead if herdr ever exposes it.
    widest = max((len(line.rstrip()) for line in raw.splitlines()), default=0)
    return widest or None


def read_pane(pane_id, remote=None):
    raw = run_herdr("pane", "read", pane_id, "--lines", "50", "--source", "recent", remote=remote)
    lines = [l for l in raw.splitlines() if l.strip() and not CHROME_RE.search(l)]
    return "\n".join(lines[-20:])


# What the record reads, and deliberately not what `read_pane` above reads. That one squashes a
# pane into a push preview — blank lines dropped, chrome lines dropped, the last twenty kept — and
# every one of those three is destructive to the detector:
#
#   * the last twenty lines are usually not the whole closing block, so the block is clipped or
#     missed outright;
#   * blank lines are structure. `block_span` keeps them inside a block, and agy has no speaker
#     glyph at all — its blocks are found positionally off the blank line above them, so a pane
#     with its blanks removed detects nothing;
#   * CHROME_RE matches `❯`, `›` and `⏵`, which are the *prompt gutters* of claude, codex and pi.
#     Stripping them removes every line the user typed, which is the whole of input detection.
#
# Measured over the panes on this machine, the preview detected a closing message on 8 of 20 and
# this read on 14 of 20, with no pane going the other way. So capture asks for what the browser's
# recorder asks for — `convReadTurnEnd` in web/src/conversation_store.js — and hands the parser the
# rows exactly as herdr returned them.
# How long a pane that ended a turn saying nothing new is given to say it. A turn end is a *status*
# transition and some harnesses flip to idle before they paint what they are about to say — agy does
# it every time — so the one read taken at the transition finds the previous turn and nothing else.
# Nothing ever reads that pane again, because there is no second transition: the answer is on screen
# for a person to see and is missing from the record and from the arbitrator's prompt for ever.
#
# Rechecked on the ordinary poll rather than by sleeping here: the loop is one pass over every pane
# on every host, and a wait inside it is a wait for all of them. 0 disables the recheck entirely.
LATE_TURN_MS = int(os.environ.get("HERDR_LATE_TURN_MS", "45000"))
# pane_id -> {"was", "status", "until"} for panes whose turn end had nothing to record yet.
late_turns = {}
# pane_id -> the newest conversation-log row id written for it. Carried on the snapshot as `turn`,
# so a client can tell its cached thread is behind without asking. A turn ending used to be enough
# of a signal on its own — the row went in inside the poll that produced the status — but a turn
# held back by LATE_TURN_MS lands with no transition behind it, and the client that already asked
# heard nothing more until its own cadence came round. In memory, like everything else keyed by
# pane id: ids are only ever compared against what this relay answered.
pane_turn_ids = {}


async def note_turn_ids(pane_id, ids, agent=None):
    """Remember the newest row this pane's last turn wrote, and say so. Nothing written, nothing
    to say.

    The snapshot carries this as well, but it goes out *before* the turn is read and recorded —
    so a client that asked for the record on the transition asked a moment early, heard nothing,
    and then had to wait for some other pane to move before it looked again. This is the message
    that says the row exists, sent the moment it does.
    """
    if not ids:
        return
    pane_turn_ids[pane_id] = max(ids)
    if agent is not None:
        await broadcast({"type": "agent_update",
                         "agent": {**agent, "turn": pane_turn_ids[pane_id]}})

# pane_id -> {"ws", "until", "idled"} for a send the relay could not prove landed. A send is
# unconfirmed for one of two reasons and both resolve themselves in time: a pane that was already
# working takes the queued text when it finishes, and a pane that never moved moves when it takes
# it. Watching for that costs nothing — the poll already carries every pane's status — and it turns
# "check that it landed" into an answer instead of an errand.
#
# One per pane. A second send to the same pane replaces the first: it is the newer question, and
# whatever answers it answered both.
pending_sends = {}

CAPTURE_LINES = 200
CAPTURE_SOURCE = "recent-unwrapped"


def read_pane_for_record(pane_id, remote=None):
    return run_herdr("pane", "read", pane_id, "--lines", str(CAPTURE_LINES),
                     "--source", CAPTURE_SOURCE, remote=remote)


def decides(pane_id):
    """Is this pane the arbitrator of an open session?

    The one pane whose turn end must not wait. A member finishing is a wake-up and can be held back
    until it has said what it finished with; the arbitrator finishing is the signal to read the drop
    box (§12.1), and that answer is a *file* — it is already written, and nothing about it is on the
    pane at all.
    """
    if arbitration is None:
        return False
    try:
        return arbitration.decides(pane_id)
    except Exception as e:                       # noqa: BLE001 — a lookup, never a reason to stop
        log.warning("arbitration: could not tell whether %s decides: %s", pane_id, e)
        return False


async def confirm_pending_sends(agents):
    """Sends nobody could confirm, answered by the next thing the pane does.

    A pane takes what it was handed by going to work on it. The pane the send could not be proven
    against is therefore watched for exactly that: it has to *leave* the turn it was in — a queued
    message is queued behind a turn — and then go back to work, and the second transition is the
    proof. A pane that was idle and unresponsive has already left, so its next move is the proof on
    its own.

    Told to the client that sent it and to nobody else. The other browsers did not ask and cannot
    act on it, and a phone that lights up about a message someone else sent is a notification about
    another person's business.
    """
    if not pending_sends:
        return
    by_id = {a["pane_id"]: a for a in agents}
    now = int(time.time() * 1000)
    for pid, wait in list(pending_sends.items()):
        a = by_id.get(pid)
        # `status`, the key the relay's own normalised agents carry — see `collect_late_turns` for
        # the same correction. Under `agent_status` this read "" for every pane, so no send was
        # ever confirmed by a pane going back to work: each one waited out its deadline instead.
        status = (a or {}).get("status") or ""
        if a is None:
            pending_sends.pop(pid, None)
            # The pane is gone. For `/quit` and `exit` that is what was asked for, so it is the
            # confirmation — the handler hands off before the pane has finished going. For anything
            # else there is nothing left to confirm and nothing a person could do about it.
            if wait.get("closing"):
                await tell_sender(wait["ws"], {
                    "type": "command_result", "command": "send_text", "ok": True, "pending": False,
                    "pane_id": pid, "message": "the pane took it"})
            continue
        if not wait["idled"]:
            wait["idled"] = ends_turn(status)
        elif status in SUBMIT_TOOK:
            pending_sends.pop(pid, None)
            await tell_sender(wait["ws"], {
                "type": "command_result", "command": "send_text", "ok": True, "pending": False,
                "pane_id": pid, "message": "the pane took it"})
            continue
        if now >= wait["until"]:
            pending_sends.pop(pid, None)
            await tell_sender(wait["ws"], {
                "type": "command_result", "command": "send_text", "ok": False, "pending": False,
                "pane_id": pid, "message": "the pane never confirmed it — check that it landed"})


async def tell_sender(ws, payload):
    """One client, the one that asked. A closed socket is the ordinary end of a wait this long."""
    if ws is None:
        return
    try:
        await ws.send(json.dumps(payload))
    except Exception:                            # noqa: BLE001 — it hung up, which is not an error
        pass


async def collect_late_turns(agents):
    """Panes that ended a turn with nothing on screen yet, read again.

    A harness that flips to idle before it paints leaves no second transition to be caught by, so
    without this the answer is on screen for a person to read and absent from the record and from
    the arbitrator's prompt for ever. Held open for `LATE_TURN_MS` and then recorded anyway — the
    tail fallback is what a turn with nothing readable has always got, and it is still better than
    a turn that vanished.

    A pane that goes back to work has answered the question a different way: whatever it says now
    belongs to the turn it is in, and that turn will end and be read like any other.
    """
    if not late_turns:
        return
    by_id = {a["pane_id"]: a for a in agents}
    now = int(time.time() * 1000)
    for pid, late in list(late_turns.items()):
        a = by_id.get(pid)
        # `status`, not `agent_status`: these are the relay's own normalised agents (see the
        # snapshot builder), where herdr's `agent_status` has already been folded into `status`.
        # Read under the wrong key every held turn looked like a pane that had gone back to work,
        # was dropped here, and was never recorded or offered to arbitration — which is a session
        # that stops for good at the first member turn that painted nothing.
        if a is None or not ends_turn(a.get("status") or ""):
            late_turns.pop(pid, None)
            continue
        # A write that raised said nothing about whether the pane spoke, so the trigger is not
        # suppressed on it. Only an empty write is evidence of an empty turn.
        wrote = True
        try:
            captured = await asyncio.to_thread(read_pane_for_record, pid, remote=a.get("remote"))
            said = await asyncio.to_thread(conv_log.pending, a, captured)
            if not said and now < late["until"]:
                continue
            late_turns.pop(pid, None)
            git = await probe_git(a)
            ids = await asyncio.to_thread(
                conv_log.record_turn_end, a, captured, late["was"], late["status"], git=git)
            wrote = bool(ids)
            await note_turn_ids(pid, ids, a)
            log.info("late turn at %s: %s", pid,
                     f"{said} message(s) after the status changed" if said
                     else "nothing said before the deadline")
        except (sqlite3.Error, OSError) as e:
            late_turns.pop(pid, None)
            log.warning("conversation log write failed for %s: %s", pid, e)
        if arbitration is not None:
            await asyncio.to_thread(arbitrate_turn_end, a, pid, wrote)


def detect_options(text):
    lower = text.lower()
    if "yes, single permission" in lower:
        return TOOL_OPTIONS
    if "approve all pending" in lower:
        return SUBAGENT_OPTIONS
    return None


def detect_choices(text):
    """A numbered menu at the bottom of a pane, as its own lines.

    codex asks everything this way — the trust prompt it opens with, every approval after it — and
    none of it matches the two claude shapes above, so a codex pane arrived at the client wearing
    claude's three buttons and pressing one sent it a sentence it has no idea what to do with.

    The labels are read out of the pane rather than kept in a table here: they are somebody else's
    TUI and they change with its version, and the option a person is being asked to pick is the one
    thing this must not paraphrase.

    Only the tail is scanned, the numbers must run 1, 2, 3 from the last line up, and one of those
    rows must carry the TUI's selection marker. The marker is what makes this safe on a pane herdr
    has *not* called blocked — which is every pane now, since a start reads its own pane for a
    trust prompt and a send refuses to type at a menu. Without it, an agent that ends its answer
    with a numbered list of questions is read as a menu: kiro does exactly that, and the pane
    flickered between blocked and idle while the client drew buttons for prose.
    """
    found, marked = {}, False
    for line in text.splitlines()[-CHOICE_TAIL:]:
        m = CHOICE_RE.match(line)
        if m:
            marked = marked or bool(m.group(1))
            # First writing wins: a redrawn frame lists every option twice and the cursor marker
            # moves between the two copies.
            found.setdefault(int(m.group(2)), m.group(3).strip())
    if not marked:
        return None
    picked = [f"{n}. {found[n]}" for n in range(1, len(found) + 1) if n in found]
    return picked[:CHOICE_MAX] if len(picked) >= 2 else None


def blocked_options(content, agent):
    """What to offer for a pane herdr says is blocked.

    The claude shapes first, because they are matched on their own wording and are what the client
    has always been sent. Then whatever numbered menu the pane is actually showing. And nothing at
    all if neither is there and the pane is not a claude — claude's three strings were the fallback
    for every harness, so a blocked codex arrived offering `yes, single permission`, which is not
    one of its choices and does nothing when it is typed at it.
    """
    return (detect_options(content) or detect_choices(content)
            or (TOOL_OPTIONS if agent == "claude" else []))


def choice_digit(text):
    """The number an option carries, for a response that names one. `2. No, quit` -> `2`."""
    m = CHOICE_ANSWER_RE.match(text.strip())
    return m.group(1) if m else None


async def broadcast(msg, except_ws=None):
    # `except_ws` exists for the client that caused the message. A browser that has just written a
    # document must not receive its own body back: the echo lands after the next local edit and
    # reverts it. Every other caller broadcasts to everyone and leaves this unset.
    data = json.dumps(msg)
    dead = set()
    for ws in list(clients):
        if ws is except_ws:
            continue
        try:
            await ws.send(data)
        except (ConnectionClosedError, ConnectionClosedOK):
            dead.add(ws)
        except Exception:
            dead.add(ws)
    if dead:
        log.debug("Removed %d dead client(s)", len(dead))
    clients.difference_update(dead)


async def record_sent(pane_id, text, kind="human_prompt", origin="human_web"):
    """A prompt this relay delivered, into the record.

    `human_web` is claimed only here, because this is the one place the relay *knows* a person put
    those words in: it performed the send. Text typed straight into a terminal is seen later as an
    echo in the pane and can never be attributed to anyone, so it is never given this origin.

    Agent panes only. A shell has no conversation to be part of.

    Also where a session learns that a person joined in. `max_consecutive` counts automated sends
    with nobody in between — it is the budget that asks "is this loop talking to itself" — and
    this is the one place the relay knows the answer is no. Before this it was never told, so the
    counter only ever went up and every session stopped on `budget_consecutive` three sends in,
    whatever anybody typed.
    """
    if arbitration is not None:
        try:
            session_id = await asyncio.to_thread(arbitration.session_of_pane, pane_id)
            if session_id:
                await asyncio.to_thread(arbitration.human_entered, session_id, pane_id)
        except Exception as e:                   # noqa: BLE001 — never break a send over this
            log.warning("arbitration: human entry for %s not recorded: %s", pane_id, e)
    if conv_log is None:
        return
    pane = agent_cache.get(pane_id)
    if not pane:
        return
    try:
        await asyncio.to_thread(
            conv_log.record, agent=pane.get("agent") or "", pane_id=pane_id,
            host=pane.get("host") or "local", cwd=pane.get("cwd") or "",
            label=pane.get("label") or "", project=pane.get("project") or "",
            kind=kind, origin=origin, at_src="sent", text=text,
            git=await probe_git(pane))
    except (sqlite3.Error, OSError) as e:
        log.warning("conversation log write failed for %s: %s", pane_id, e)


async def poll_loop():
    while True:
        try:
            await _poll_once()
        except Exception:
            log.exception("poll cycle failed; retrying")
        await asyncio.sleep(POLL_INTERVAL)


def projects_stamp():
    """What would make the roster different: the config file, and each scanned root's directory.

    A directory's mtime moves when an entry is added to it or removed from it, so one stat per
    root answers "has a child appeared" without listing anything.
    """
    out = []
    for target in [os.path.expanduser(PROJECTS_PATH)] + [
            p["cwd"] for p in FILE_PROJECTS if p.get("children")]:
        try:
            st = os.stat(target)
            out.append((target, st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((target, 0, 0))
    return tuple(out)


def refresh_projects():
    """Re-read the file and re-scan its roots. Returns True when what clients hold has changed.

    Blocking, and called from the poll loop in a thread: a stat per root every cycle, a listing
    only when one moved or the slow rescan is due.

    A bad edit keeps the last good roster and logs. Boot fails closed because a relay that started
    against a config nobody has read is a relay nobody can reason about; a *running* one has a
    roster that already works, and taking it down over a typo would cost every connected client
    its session to punish a text editor.
    """
    global PROJECTS, FILE_PROJECTS, _projects_stamp, _projects_listed, _projects_skipped
    if not PROJECTS_PATH:
        return False
    now = time.monotonic() * 1000
    stamp = projects_stamp()
    if stamp == _projects_stamp and now - _projects_listed < PROJECT_RESCAN_MS:
        return False
    _projects_stamp = stamp
    _projects_listed = now
    try:
        FILE_PROJECTS = load_projects(PROJECTS_PATH, valid_hosts=REMOTES)
    except ProjectConfigError as e:
        # Deliberately not retried until the file changes again: it just did, and this is what it
        # says. The roster in hand is the last one that parsed.
        log.warning("Projects config not reloaded: %s", e)
    before = public_projects(PROJECTS)
    skipped = []
    PROJECTS = FILE_PROJECTS + child_projects(
        FILE_PROJECTS, note=lambda *row: skipped.append(row))
    # A directory somebody made that did not become a project is a surprise to them and to nobody
    # else, so it is said once, when it becomes true. Logged rather than fatal: one stray name
    # must not cost every other project its refresh.
    if tuple(skipped) != _projects_skipped:
        _projects_skipped = tuple(skipped)
        for root_id, name, reason in skipped:
            log.warning("Project directory %s/%s is not listed: %s", root_id, name, reason)
    return public_projects(PROJECTS) != before


def pane_guard(pane_id):
    """Return an error string if this pane may not be addressed, else None.

    Bare pane IDs are per-server counters, so the same ID on two hosts routes to
    whichever was polled last. Refuse rather than guess (D6); clears within one poll.

    The bare-ID path only. A message naming its pane by `aid` never reaches this — see
    pane_target, which is what every handler actually calls.
    """
    if pane_id not in known_panes:
        return "unknown pane_id"
    if pane_id in ambiguous_panes:
        return "ambiguous pane_id (same id on multiple hosts)"
    return None


def pane_target(msg):
    """Resolve a client's pane address to (pane_id, remote, error).

    Two ways to name a pane. `aid` is this relay's own agent id: unique by construction, so it
    names one pane on one host and the collision above cannot arise for it. A bare `pane_id` is
    herdr's per-server counter and is guarded as it always has been.

    `aid` wins when both are present. A client sends the pair out of one snapshot, so the
    `pane_id` in it is where that agent *was*; if they have since disagreed the agent moved, and
    the id that follows it is the fresher of the two.

    An `aid` whose agent has no live pane answers "unknown aid" rather than being looked up in the
    registry. This addresses panes that exist, not agents that once did.
    """
    aid = msg.get("aid")
    if aid:
        pane = pane_by_aid.get(aid)
        if pane is None:
            return None, None, "unknown aid"
        return pane["pane_id"], pane.get("remote"), None
    pane_id = msg.get("pane_id")
    err = pane_guard(pane_id)
    # Nothing on the failing path. Every caller returns on the error, and handing one a pane id it
    # was just told not to use is an invitation to use it anyway.
    return (None, None, err) if err else (pane_id, pane_remote_map.get(pane_id), None)


def _herdr_reason(result):
    """herdr reports a refusal as a JSON error body on stdout alongside a non-zero exit.

    Reporting only the exit code turned every distinct refusal — a taken agent name, a missing
    workspace, a bad cwd — into the same unactionable "exited 1" in the log and on the phone.
    """
    try:
        message = (json.loads(result.stdout) or {}).get("error", {}).get("message", "")
    except (json.JSONDecodeError, AttributeError, TypeError):
        message = ""
    if not message:
        message = (result.stderr or "").strip().splitlines()[-1] if (result.stderr or "").strip() else ""
    return message


def _herdr_json(*args, remote=None, timeout=15):
    """Run a herdr command that returns JSON. Returns (data, error)."""
    where = " ".join(args[:2])
    try:
        result = run_herdr_result(*args, remote=remote, timeout=timeout)
    except Exception as e:
        return None, f"herdr {where} failed: {e}"
    if result.returncode != 0:
        reason = _herdr_reason(result)
        return None, f"herdr {where}: {reason}" if reason else f"herdr {where} exited {result.returncode}"
    try:
        return json.loads(result.stdout), None
    except json.JSONDecodeError:
        return None, f"herdr {where} returned malformed JSON"


def live_agent_names(remote=None):
    """The herdr agent names in use on one host. Best effort — an empty set on failure.

    `pane list`, which the poll loop uses, does not report the agent name, and the name is what
    herdr enforces uniqueness on. A miss here is not fatal: the start still runs, and a real
    collision comes back as herdr's own agent_name_taken through _herdr_json.
    """
    data, err = _herdr_json("agent", "list", remote=remote)
    if err:
        log.warning("Could not list agent names on %s: %s", remote or "local", err)
        return set()
    agents = ((data or {}).get("result") or {}).get("agents") or []
    return {a["name"] for a in agents if isinstance(a, dict) and a.get("name")}


def _rollback_layout(rollback, remote):
    """Close a workspace or tab this relay created seconds ago for an agent that never started.

    Only ever called with an id the relay just minted, so nothing of the user's can be inside it.
    Without this a failed start left an empty shell workspace behind on every attempt.
    """
    if not rollback:
        return
    _, err = _herdr_json(*rollback, remote=remote)
    if err:
        log.warning("Could not roll back %s after a failed start: %s", " ".join(rollback), err)


def slot_exec(pane_id, slot, remote=None):
    """Put a pane into a slot. Returns an error string, or None.

    Blocking; call through asyncio.to_thread. The pane list is read here rather than taken from
    the poll snapshot because that snapshot always drops spacers, and drops every shell as well
    unless terminal mode is on (`split_panes`) — and the spacers are exactly what this has to be
    able to see and close.
    """
    data, err = _herdr_json("pane", "list", remote=remote)
    if err:
        return err
    steps, plan_err = plan_slot(dig_panes(data), pane_id, slot)
    if plan_err:
        return plan_err
    for step in steps:
        result, err = _herdr_json(*step, remote=remote)
        if err:
            # No rollback. Every step is a layout change that stands on its own, and undoing a
            # half-applied one means guessing which half — leaving it and saying so is honest.
            return err
        if step[:2] == ("pane", "split"):
            # Label it immediately. Until this lands the pane is an unmarked shell, and an
            # unmarked shell is one this code will refuse to clean up later — the failure mode is
            # a stranded spacer, which is the right way round.
            spacer = dig(result, "result", "pane", "pane_id")
            if not spacer:
                return "pane split returned no pane_id"
            _, err = _herdr_json(*pane_rename_args(spacer, SPACER_LABEL), remote=remote)
            if err:
                return err
    return None


def dig_panes(data):
    panes = ((data or {}).get("result") or {}).get("panes")
    return panes if isinstance(panes, list) else []


def pane_agent_status(pane_id, remote=None):
    """What herdr says this pane's agent is doing, right now.

    Straight from herdr rather than out of `agent_cache`, because the cache is only as fresh as the
    last poll and the caller is deciding, this instant, whether a keystroke landed.

    Two spellings mean "herdr does not know", and the caller must treat them alike: `unknown`,
    which is what a real `pane list` returns for a pane carrying no agent — including the case that
    matters, an agent that has not finished starting — and an empty string, for a call that failed.
    Neither is in SUBMIT_READY or SUBMIT_TOOK, so both wait.

    PANE_GONE is the third answer, and it is not a kind of "does not know": herdr listed its panes
    and this one was not among them. That is a pane that has exited, which is what `/quit` and
    `exit` are for — so a caller waiting for the pane to take them can stop rather than watch a
    closed pane for the rest of its window.
    """
    data, err = _herdr_json("pane", "list", remote=remote)
    if err:
        return ""
    for p in dig_panes(data):
        if p.get("pane_id") == pane_id:
            return p.get("agent_status") or ""
    return PANE_GONE


def live_panes():
    """Every pane herdr lists here, raw. What arbitration resolves fingerprints against.

    Local only, which is exactly v1's rule (D13): a remote send is one ssh hop away, and the
    recovery story for an instruction half-delivered over a dropped connection is not written yet.
    A remote participant is refused at session start rather than silently skipped here.
    """
    data, err = _herdr_json("pane", "list")
    # Annotated, because arbitration refuses a session whose participants are not all in one
    # project, and `project_id` is what says which. Raw panes carry a cwd and nothing that maps it
    # to the person's own grouping. With no Projects configured this adds no key and changes
    # nothing, which is exactly what "the check cannot apply" should look like.
    return [] if err else annotate_agents(dig_panes(data), PROJECTS)


def submit_delay(waited):
    """How long to wait before looking at the pane again, given how long this send has been open.

    Two rates, because there are two phases: while Enters are still going in, the loop wants to see
    the result of each one; once they are spent it is only watching. See SUBMIT_POLL.
    """
    return SUBMIT_POLL if waited < SUBMIT_FAST else SUBMIT_POLL_SLOW


def submit_window(pane_id):
    """How long this pane gets to say it took the paste, by which harness is in it.

    One number cannot cover them all — see SUBMIT_SLOW. Read from the poll's own snapshot, so a
    pane this relay has never listed falls back to the shared window, which is the right answer
    for a pane whose harness is unknown.
    """
    agent = (agent_cache.get(pane_id) or {}).get("agent", "")
    return SUBMIT_SLOW.get(agent, SUBMIT_TIMEOUT)


async def pane_menu_options(pane_id, remote=None):
    """The menu this pane is showing, if it is showing one — and every client told about it.

    A pane at a numbered menu takes no text. The characters go into a modal that ignores them and
    the Enter behind them accepts whatever row the cursor is on, so a prompt typed at a codex asking
    whether it may trust the directory was lost *and* answered the question for the user. That is
    how a start came up trusted, silent, and with its opening prompt nowhere: the block a person saw
    for a moment was dismissed by the very message that was supposed to follow it.

    Read rather than inferred from status, because herdr reports a pane at its trust prompt as
    `idle` — there is no status to consult. Broadcast on the way past: whoever is looking at this
    pane is one tap from answering it, and the poll would not say so for another interval.

    Shells are exempt. Every rule here is about a TUI, and a shell has no modal to protect.

    And only a pane that could plausibly be at one is read at all: one inside its post-start window,
    where herdr calls a trust prompt `idle`, or one herdr has already called blocked. An ordinary
    idle pane is never read here, so nothing it happens to have printed can flip it — reading every
    pane is what let a codex answer written as a numbered list be taken for a menu.
    """
    if pane_id in shell_panes:
        return None
    if not (spawn_menu_pending(pane_id, time.monotonic())
            or (agent_cache.get(pane_id) or {}).get("status") == "blocked"):
        return None
    text = await asyncio.to_thread(read_pane, pane_id, remote=remote)
    options = detect_choices(text)
    if options:
        # Watched from here on, so the poll reads it too. Without that the snapshot that follows
        # this message says `idle` — herdr does not call a pane at a menu blocked — and the client
        # is told the pane is waiting and then, a second later, that it is not.
        spawn_watch[pane_id] = time.monotonic() + SPAWN_WATCH_S
        a = agent_cache.get(pane_id) or {}
        await broadcast({
            "type": "blocked", "pane_id": pane_id,
            "agent": a.get("agent", ""), "project": a.get("project", ""),
            "host": a.get("host", "local"),
            "prompt": text[:500], "options": options,
        })
    return options


async def submit_init_line(pane_id, line, remote=None):
    """Type one of a kind's own init lines and press Enter once. Returns whether it went out.

    Not submit_paste, because these are slash commands the TUI runs itself: kiro prints nothing for
    `/tools trust-all` and never leaves `idle`, so the watch loop spends its whole window waiting
    for a status change that cannot come and then reports a line that landed as unsent — eight
    seconds of every kiro start, and a warning in the log saying the opposite of what happened.

    What it does keep from submit_paste is the wait in front: `agent start` returns when herdr says
    the agent is interactively ready, and a TUI that is ready is not necessarily listening —
    antigravity spends seconds after that painting its first frame, and everything typed into it
    goes nowhere. So the pane is watched until herdr gives it a status at all, and then left a beat
    longer. Without it agy's wake-up was typed into a screen that was still drawing itself.

    The one thing still worth checking is the one submit_paste checks first: a menu on screen eats
    the text and the Enter behind it answers the menu.
    """
    if not await pane_ready(pane_id, remote=remote):
        # Two ways to fail that wait, and only one of them is worth typing into. A pane that is
        # simply slow gets the line anyway — it is the one it was started for. A pane herdr no
        # longer lists has exited, and there is nothing there to read it.
        if await asyncio.to_thread(pane_agent_status, pane_id, remote=remote) == PANE_GONE:
            log.warning("Pane %s is gone; %r was not sent", pane_id, line)
            return False
        log.warning("Pane %s never reported a status; %r goes out anyway", pane_id, line)
    if await pane_menu_options(pane_id, remote=remote):
        return False
    await asyncio.to_thread(run_herdr, "pane", "send-text", pane_id, line, remote=remote)
    await asyncio.sleep(submit_settle(line))
    await asyncio.to_thread(run_herdr, "pane", "send-keys", pane_id, "Enter", remote=remote)
    # Only the client's own sends were logged, so a line this relay typed for itself left no trace
    # at all — "did the wake-up go in" was a question only a pane read could answer.
    log.info("Typed at %s: %r", pane_id, line)
    return True


async def pane_ready(pane_id, remote=None):
    """Wait for a just-started TUI to be listening. Returns whether it said so before the deadline.

    Two waits, because they answer different questions. herdr's status is the pane's own answer to
    "is there an agent here yet" — `unknown` and `` both mean not yet, exactly as submit_paste
    reads them. INIT_SETTLE_S is the part herdr cannot answer: a harness that has reported itself
    is still painting, and antigravity in particular drops whatever arrives while it does.
    """
    deadline = time.monotonic() + INIT_READY_WAIT_S
    while time.monotonic() < deadline:
        status = await asyncio.to_thread(pane_agent_status, pane_id, remote=remote)
        if status == PANE_GONE:
            return False
        if status in SUBMIT_STARTED:
            await asyncio.sleep(INIT_SETTLE_S)
            return True
        await asyncio.sleep(INIT_READY_POLL)
    return False


# How many of one client's messages the relay answers at once. Past it the read loop stops reading,
# which is the backpressure: every handler can spawn a herdr subprocess, and a client is not owed an
# unbounded number of them.
HANDLER_INFLIGHT = 8


async def run_in_lane(lanes, key, coro):
    """Run `coro` after everything already queued under `key`, and before anything queued after it.

    The unit is the pane, because that is the unit of dependence — a paste split into chunks, the
    Enter behind it, the read that checks what landed. `asyncio.Lock` hands itself to waiters in the
    order they asked, and acquiring it is each task's first await, so a lane preserves the order the
    messages arrived in. Two lanes have nothing to say to each other and run at the same time.
    """
    lock = lanes.get(key)
    if lock is None:
        lock = lanes[key] = asyncio.Lock()
    async with lock:
        return await coro


async def submit_paste(pane_id, text, remote=None, out=None, window=None):
    """Press Enter until the pane says it took what it was handed. Returns whether it did.

    The two ways this used to be done are described at SUBMIT_READY above; both picked a duration
    and hoped. This one watches `agent_status` instead, which turns three separate problems into
    one loop:

      * a TUI that has not started yet reports no status, so nothing is pressed until it does —
        that is the New agent dialog's opening prompt, which no fixed delay ever covered;
      * a TUI that is still laying out a big paste is still `idle`, so the next pass presses again;
      * a pane that has taken the prompt reports `working` or `blocked`, and the loop stops.

    Never presses Enter at a `blocked` pane. That box is a permission prompt and Enter accepts its
    default, which is the one outcome worse than a message that did not send.

    A pane already `working` when the paste arrives is a message queued behind what the agent is
    doing, and `working` is what it will keep saying whether the Enter landed or not — so there is
    nothing to watch. One press after the settle, exactly as before, and the return says so.

    `out`, when given, is filled in with `reason` — `queued` for a pane that was already working,
    `unconfirmed` for one that never moved. Both are False here and they are not the same news: the
    first almost certainly landed and is waiting its turn, the second may be sitting in a composer.
    Out of band because the return value is load-bearing elsewhere — arbitration reads `is not
    False` and a richer type would quietly read as success.

    And a pane with no agent skips all of it. Every rule here is about a TUI — booting, laying out a
    paste, showing a permission prompt — and a shell has none of them. It has no status to watch
    either: `pane list` reports `unknown` for a pane carrying no agent, which this loop reads as
    "still starting" and waits out to the timeout, leaving the command unentered at the prompt.
    """
    # A pane this relay started a moment ago gets the same wait its own opening lines get: `agent
    # start` returns on herdr's readiness, and a TUI that is ready is not always listening yet.
    # Only inside that window — an ordinary send must not pay a status call and two seconds.
    if spawn_menu_pending(pane_id, time.monotonic()):
        await pane_ready(pane_id, remote=remote)
    # Whether there was an agent here when this went out. `unknown` below means "no agent on this
    # pane", which is the proof a closing line landed only if one was there to leave: at a pane
    # whose TUI has not come up yet it is the ordinary starting state, and reading it as success
    # would confirm a `/quit` that nothing ever received.
    had_agent = bool((agent_cache.get(pane_id) or {}).get("agent"))
    # Nothing is typed at a pane showing a menu. See pane_menu_options: the text would be eaten by
    # the modal and the Enter would answer it.
    if await pane_menu_options(pane_id, remote=remote):
        if out is not None:
            out["reason"] = "menu"
        return False
    await asyncio.to_thread(run_herdr, "pane", "send-text", pane_id, text, remote=remote)
    await asyncio.sleep(submit_settle(text))
    # A shell is none of the cases below. It has no TUI to be mid-boot, no composer to be mid-paste
    # and no permission prompt for an Enter to accept, so there is nothing the loop could learn by
    # watching — and nothing to watch it *with*: a real `pane list` reports `unknown` for a pane
    # carrying no agent, which the loop reads as "still starting" and waits out to the timeout,
    # leaving the command sitting at the prompt. Press once and say so.
    if pane_id in shell_panes:
        await asyncio.to_thread(run_herdr, "pane", "send-keys", pane_id, "Enter", remote=remote)
        return True
    start = time.monotonic()
    # `window` is how long the caller is prepared to hold. Unset means the harness's own full
    # window, which is what a caller that needs the answer — arbitration — asks for. The websocket
    # handler asks for a short one instead: see SUBMIT_FAST.
    watch = window or submit_window(pane_id)
    deadline = start + watch
    presses, first = 0, True
    while time.monotonic() < deadline:
        status = await asyncio.to_thread(pane_agent_status, pane_id, remote=remote)
        # Already busy when the paste landed, which only the first look can tell apart from busy
        # *because* of it. Press once and say nothing was proven — `working` is what this pane will
        # keep reporting either way.
        if first and status == "working":
            await asyncio.to_thread(run_herdr, "pane", "send-keys", pane_id, "Enter", remote=remote)
            if out is not None:
                out["reason"] = "queued"
            return False
        first = False
        # The agent is gone. For the two lines that close one — `/quit` and `exit` — that is the
        # proof itself, and watching further is watching a pane that has already done what it was
        # asked: the loop read it as a TUI still starting, and every End cost the full window while
        # the client's next message waited behind it.
        #
        # Two spellings, because the two lines end differently. `exit` closes the pane, so herdr
        # stops listing it — PANE_GONE. `/quit` only ends the *agent*: herdr keeps the pane and
        # reports `unknown` for it, which is the same word it uses for a TUI that has not started
        # yet. Read against a closing line the ambiguity is gone — nothing else is being waited for.
        #
        # For any other text a vanished pane is the opposite news: a harness that died holding the
        # prompt, with nobody left to have read it. That is a failure with its own reason rather
        # than a send to keep watching or to record. `unknown` under ordinary text stays what it
        # always was — a pane still starting — and falls through to the wait below.
        closing = text.strip() in CLOSING_LINES
        if status == PANE_GONE or (status == "unknown" and closing and had_agent):
            if closing:
                return True
            if out is not None:
                out["reason"] = "pane_gone"
            return False
        if status in SUBMIT_TOOK:
            return True
        # Out of presses is not out of patience. The presses are spent in under two seconds, and
        # an agent that takes longer than that to report `working` — antigravity is one — was
        # being called unconfirmed while its Enter was still being processed. Stop pressing;
        # keep watching until the deadline, which is the number that was always meant to decide
        # this. A pane that really did not take it costs the full wait, which is what it is for.
        if status in SUBMIT_READY and presses < SUBMIT_TRIES:
            await asyncio.to_thread(run_herdr, "pane", "send-keys", pane_id, "Enter", remote=remote)
            presses += 1
        # Anything else is a pane herdr has no status for — `unknown` from a real pane list, or an
        # empty string from a pane it did not list — which is a TUI still starting. Wait for it
        # rather than pressing into a terminal that is not listening yet.
        await asyncio.sleep(submit_delay(time.monotonic() - start))
    # Out of presses or out of time, and the pane never moved. Said plainly in the log: the text is
    # in the composer and a person has to press Enter. Silence here is what made this bug take
    # three attempts to find.
    log.warning("submit: pane=%s never left %s after %d Enter press(es) in %.0fs — text may be "
                "unsent", pane_id, SUBMIT_READY, presses, watch)
    if out is not None:
        out["reason"] = "unconfirmed"
    return False


def log_tab_geometry():
    """Report at boot how wide the two slots land, and what to change if narrow is off target.

    The area's `x` is the sidebar width: herdr lays the tab area out to the right of it, and the
    two have summed to the terminal width in every reading (22+148, 26+139, 26+144). Inferred
    rather than read, because the API reports the area and not the chrome beside it — so this
    only ever produces advice, never an action.
    """
    data, err = _herdr_json("api", "snapshot")
    if err:
        log.debug("Could not read herdr geometry: %s", err)
        return
    layouts = (((data or {}).get("result") or {}).get("snapshot") or {}).get("layouts") or []
    area = (layouts[0].get("area") or {}) if layouts else {}
    width, sidebar = area.get("width"), area.get("x")
    if not width:
        return
    log.info("herdr tab area %d cols: slots are %d (wide) and %d (narrow)",
             width, width, width // 2)
    advice = slot_advice(width, sidebar)
    if advice:
        log.warning(advice)


def _child_dir(plan):
    """Make the directory a start named under its root. Returns (project, error).

    The other half of `child`: validation settled the name and the row it will become, and this is
    where the directory starts existing. Nothing is written anywhere else — the next poll stats the
    root, sees its mtime moved, lists it, and derives the same row this returns.
    """
    root = next((p for p in PROJECTS if p["id"] == plan["parent"]
                 and p["host"] == "local" and p.get("children")), None)
    # The root is named by the plan and its cwd comes from the config file, which can be edited
    # between the two moments. Checked before the mkdir so a stale plan does not leave a directory
    # behind under a path that is no longer a root.
    if root is None or root["cwd"] != os.path.dirname(plan["cwd"]):
        return None, "that root has changed since the start was planned"
    if not os.path.isdir(root["cwd"]):
        return None, "that root is no longer a directory"
    project, _, target_err = child_target(plan["create_child"], root, PROJECTS)
    if target_err:
        return None, target_err
    if (project["id"] != plan["project_id"] or project["cwd"] != plan["cwd"]
            or project.get("parent", "") != plan["parent"]):
        return None, "that child has changed since the start was planned"
    err = make_child_dir(plan["cwd"], root["cwd"])
    if err:
        return None, err
    return {"id": plan["project_id"], "label": plan["project_label"], "cwd": plan["cwd"],
            "host": "local", "children": False, "marker": "", "parent": plan["parent"]}, None


def _create_target_pane(plan, remote):
    """Create the pane a validated plan asks for. Returns (pane_id, rollback, error).

    herdr attaches an agent to a pane already sitting at its shell prompt, so the relay creates
    that pane itself — which is also, with nothing attached afterwards, the whole of opening a
    terminal. A new workspace or tab is born holding exactly one pane, so there is no idle shell
    left over to close. `rollback` is what to undo if the caller's next step fails.
    """
    # The last look before the pathname is handed to herdr. Validation happened before a config
    # line was built and before this call was queued, and a derived cwd is one an agent working in
    # that root can replace with a symlink in between.
    #
    # ponytail: check-then-exec. This narrows the window to the herdr calls below; it does not
    # close it, and nothing in this file can — herdr takes a pathname, so the relay cannot hand it
    # a descriptor it opened with O_NOFOLLOW. Closing it means enforcing containment at the spawn
    # boundary: a directory handle herdr creates from, or a no-follow guarantee inside herdr.
    if plan.get("parent"):
        if plan.get("create_child"):
            # The directory this start named does not exist yet, so there is no row to match it
            # against — the root is the thing that has to still be what it was.
            project, dir_err = _child_dir(plan)
            if dir_err:
                return None, None, dir_err
        else:
            project = next((p for p in PROJECTS if p["id"] == plan.get("project_id")), None)
            # The id is not the identity: a derived id folds a directory name, so a root that lost
            # `webapp` and gained `web.app` presents a *different* directory under the same id. The
            # row has to still be the row this plan was built from, or the check below would pass
            # on one path while the herdr calls that follow spawn at the other. A plan whose row
            # moved underneath it fails; retargeting it here would make this a second place that
            # decides where a pane goes.
            if (project is None
                    or project["cwd"] != plan["cwd"]
                    or project.get("parent", "") != plan["parent"]):
                return None, None, "that project has changed since the start was planned"
        if not child_path_ok(project, PROJECTS):
            return None, None, "that project's directory is no longer inside its root"

    placement = plan["placement"]
    rollback = None

    if placement == "new_workspace":
        data, err = _herdr_json(*workspace_create_args(plan["cwd"], plan["project_label"]), remote=remote)
        if err:
            return None, None, err
        workspace_id = dig(data, "result", "workspace", "workspace_id")
        target_pane = dig(data, "result", "root_pane", "pane_id")
        if not workspace_id or not target_pane:
            return None, None, "workspace create returned no workspace_id or root pane"
        rollback = ("workspace", "close", workspace_id)
    elif placement == "new_tab":
        # A spacer in this workspace is already a shell sitting at the Project's cwd, which is
        # exactly what `agent start --pane` wants. Claiming it fills a half-width slot that
        # exists rather than opening a tab beside it and leaving the shell idle. Only when the
        # client asked for narrow: a wide start landing in a spacer would come up half-width and
        # have to move straight back out. A `pane list` that fails just falls through to a tab.
        target_pane = None
        if plan.get("slot") == "narrow":
            listing, list_err = _herdr_json("pane", "list", remote=remote)
            if list_err:
                log.debug("Could not look for a spacer to reuse: %s", list_err)
            else:
                target_pane = claimable_spacer(
                    dig_panes(listing), plan["workspace_id"], plan["cwd"])
        if target_pane:
            # No rollback: the spacer stood here before this call, and a failure downstream
            # leaves it exactly as it was found — still labelled, still reusable.
            log.info("Reusing spacer %s for the new pane", target_pane)
        else:
            data, err = _herdr_json(
                *tab_create_args(plan["workspace_id"], plan["cwd"], plan["label"]), remote=remote)
            if err:
                return None, None, err
            tab_id = dig(data, "result", "tab", "tab_id")
            target_pane = dig(data, "result", "root_pane", "pane_id")
            if not tab_id or not target_pane:
                return None, None, "tab create returned no tab_id or root pane"
            rollback = ("tab", "close", tab_id)
    else:  # split — the source pane's sibling is the user's own, so only the new pane rolls back
        data, err = _herdr_json(*pane_split_args(plan["split_from"], plan["cwd"]), remote=remote)
        if err:
            return None, None, err
        target_pane = dig(data, "result", "pane", "pane_id")
        if not target_pane:
            return None, None, "pane split returned no pane_id"
        rollback = ("pane", "close", target_pane)

    return target_pane, rollback, None


def start_agent_exec(plan):
    """Run a validated start plan. Returns (pane_id, error).

    Blocking; call through asyncio.to_thread. Never claims success after a partial
    operation — a created workspace, tab, or pane may remain as empty native layout, but no
    session is reported unless the agent actually started (spec §3).
    """
    remote = plan["remote"]
    # Settle the herdr agent name before anything is created: a collision fails the start after
    # a container already exists. It is derived from the label rather than being the label —
    # herdr's agent names are lowercase and space-free, pane labels are not.
    plan["agent_name"] = unique_agent_name(
        agent_name_from_label(plan["label"], plan["name"]), live_agent_names(remote))

    target_pane, rollback, err = _create_target_pane(plan, remote)
    if err:
        return None, err

    # Before `agent start`, because this is the only moment there is a shell to type it at: after
    # it, the pane belongs to the agent's TUI. Fatal, unlike the init prompts below — a session
    # that failed to take its provider would come up on the stock endpoint wearing the alias's
    # name, which is worse than no session.
    if plan.get("env_line"):
        env_err = shell_line_exec(target_pane, plan["env_line"], remote)
        if env_err:
            _rollback_layout(rollback, remote)
            return None, env_err

    args = agent_start_args(plan["name"], plan["agent_name"], target_pane,
                            unattended=bool(plan.get("unattended")),
                            extra_args=plan.get("config_args") or ())
    deadline = time.monotonic() + PANE_READY_WAIT
    while True:
        data, err = _herdr_json(*args, remote=remote, timeout=START_EXEC_TIMEOUT)
        if not err or not any(s in err for s in PANE_NOT_READY) or time.monotonic() >= deadline:
            break
        log.info("Pane %s is not at a shell prompt yet; offering it again", target_pane)
        time.sleep(PANE_READY_POLL)
    if err:
        _rollback_layout(rollback, remote)
        return None, err
    pane_id = dig(data, "result", "agent", "pane_id")
    if not pane_id:
        _rollback_layout(rollback, remote)
        return None, "agent start returned no pane_id"

    try:
        rename = run_herdr_result(*pane_rename_args(pane_id, plan["label"]), remote=remote)
    except Exception as e:
        return None, f"agent started as {pane_id} but pane rename failed: {e}"
    if rename.returncode != 0:
        return None, f"agent started as {pane_id} but pane rename exited {rename.returncode}"

    # The wake-up, for a kind that needs one. Typed here, so it is in front of whatever the client
    # opens the pane with — that is the whole point of it: a first prompt into a cold agy is
    # answered with nothing, and this is the message that answer belongs to.
    agent_wake_exec(pane_id, plan["name"], remote)

    # Queued, not typed: these lines follow the pane's first prompt rather than leading it. See
    # agent_init_queue. Never fatal for the same reason the width below is not — an agent that is
    # up and asking for permission is worth more than no agent, and a person can type the line
    # themselves.
    agent_init_queue(pane_id, plan["name"], remote)

    # Width last, and never fatal. The session is up and usable at whatever width the placement
    # gave it; failing the start here would roll back a working agent over a layout preference.
    if plan.get("slot"):
        slot_err = slot_exec(pane_id, plan["slot"], remote)
        if slot_err:
            log.warning("Agent started as %s but slot %r was not applied: %s",
                        pane_id, plan["slot"], slot_err)
    return pane_id, None


def agent_wake_exec(pane_id, kind, remote):
    """Wake this kind's agent before anyone asks it for anything. Never fatal.

    agy is the only kind with one today, and it is the same line arbitration warms a member with —
    one wording, so an agent woken at start and an agent woken on resume are asked the same
    question. Sent through the same one-press path a kind's init lines use: what matters is that
    the pane has been spoken to before the prompt lands, not that it has answered.
    """
    for line in agent_wake_prompts(kind):
        try:
            if not on_loop(submit_init_line(pane_id, line, remote=remote), wait=True):
                log.warning("Agent started as %s but its wake-up was not sent: a menu was on "
                            "screen", pane_id)
        except Exception as e:
            log.warning("Agent started as %s but its wake-up was not delivered: %r", pane_id, e)
            return


def agent_init_queue(pane_id, kind, remote):
    """Queue this kind's own first lines behind the first prompt the pane is given.

    The lines come from AGENT_INIT, which is server-side and keyed by kind — never from the client
    and never from the label. Most kinds have none.

    Behind the prompt rather than in front of it, which is what kiro wants: a `/tools trust-all`
    typed into a freshly started kiro is answered by the pane and then the opening prompt lands on
    top of it, so what the reader sees first is a turn about a slash command. Sent as its own
    message after the prompt goes in, the pane answers the prompt and takes the grant on the way.

    Nobody has to send that prompt, though — a pane started from the app with nothing to say is a
    pane that would never be trusted at all. So the queue has a deadline, and the poll drains it
    when the deadline passes. See init_pending.
    """
    lines = agent_init_prompts(kind)
    if lines:
        init_pending[pane_id] = (time.monotonic() + INIT_AFTER_WAIT_S, lines, remote)


async def drain_init(pane_id, now=None):
    """Type whatever is queued for this pane. Never fatal, and never tried twice.

    Called from two places: the first prompt this relay delivers to the pane, which is what these
    lines are meant to follow, and the poll once the deadline has passed with no prompt in sight.
    """
    queued = init_pending.get(pane_id)
    if not queued:
        return
    deadline, lines, remote = queued
    if now is not None and now < deadline:
        return
    del init_pending[pane_id]
    for line in lines:
        try:
            if not await submit_init_line(pane_id, line, remote=remote):
                log.warning("Pane %s was not sent %r: a menu was on screen", pane_id, line)
        except Exception as e:
            # Said out loud rather than raised: this is the difference between an agent that
            # answers and one that sits on a permission prompt nobody can see.
            log.warning("Pane %s was not sent %r: %r", pane_id, line, e)
            return


def terminal_init_exec(pane_id, remote):
    """Send TERMINAL_INIT into a terminal this relay just opened. Never fatal.

    Only ever called from open_terminal_exec, so the pane is one the app created a moment ago and
    the shell in it has run nothing. An agent pane never comes through here: `agent start` gets a
    TUI that owns its own screen, and typing a shell command at it would be typing into a prompt.
    """
    if TERMINAL_INIT:
        shell_line_exec(pane_id, TERMINAL_INIT, remote)


def shell_line_exec(pane_id, line, remote):
    """Type one line at a pane that still holds a shell. Returns an error string, or None.

    A login shell that sources a real profile takes a second or several to reach its prompt, and
    characters sent before then are dropped. That is the same precondition `agent start` waits out
    at PANE_NOT_READY, asked the only way a shell answers it: `pane list` reports `unknown` for a
    pane carrying no agent, so there is no status to watch — the prompt appearing in the pane is
    the signal. A pane that never draws one is sent to anyway at the deadline, which is no worse
    than not having tried.

    ponytail: send-then-Enter with no confirmation, the same as it has always been here. The
    callers are a fresh shell the relay created a moment ago; if that ever stops being true, this
    wants submit_paste's watch instead.
    """
    deadline = time.monotonic() + TERMINAL_INIT_WAIT
    while time.monotonic() < deadline:
        if run_herdr("pane", "read", pane_id, "--lines", "5",
                     "--source", "visible", remote=remote).strip():
            break
        time.sleep(TERMINAL_INIT_POLL)
    try:
        run_herdr("pane", "send-text", pane_id, line, remote=remote)
        run_herdr("pane", "send-keys", pane_id, "Enter", remote=remote)
    except Exception as e:
        return f"could not prepare the pane's shell: {e}"
    return None


def open_terminal_exec(plan):
    """Run a validated open_terminal plan. Returns (pane_id, error). Blocking.

    start_agent_exec without the agent — the pane herdr would have handed to `agent start` is
    the deliverable, so the work stops once it has been created and named.
    """
    remote = plan["remote"]
    target_pane, rollback, err = _create_target_pane(plan, remote)
    if err:
        return None, err

    # Fatal here, unlike a start, and it takes the pane with it. There, a rename failure leaves a
    # working agent worth more than its label; here the pane *is* the result, and a claimed spacer
    # still carries the spacer label until this lands — which plan_slot may close on sight.
    try:
        rename = run_herdr_result(*pane_rename_args(target_pane, plan["label"]), remote=remote)
    except Exception as e:
        _rollback_layout(rollback, remote)
        return None, f"terminal opened as {target_pane} but pane rename failed: {e}"
    if rename.returncode != 0:
        _rollback_layout(rollback, remote)
        return None, f"terminal opened as {target_pane} but pane rename exited {rename.returncode}"

    # Never fatal, same as a start: the terminal is up and usable at whatever width it landed on.
    if plan.get("slot"):
        slot_err = slot_exec(target_pane, plan["slot"], remote)
        if slot_err:
            log.warning("Terminal opened as %s but slot %r was not applied: %s",
                        target_pane, plan["slot"], slot_err)
    # Last, so the shell is tidied at the width it will be read at rather than the one it was
    # created at — and never fatal either, for the same reason: a terminal wearing the user's own
    # prompt is still a terminal.
    terminal_init_exec(target_pane, remote)
    return target_pane, None


async def _poll_once():
        global latest_agents, latest_shells, latest_retired
        # Before the panes, so the snapshot they are annotated with is the roster this cycle knows
        # about: a child directory made a moment ago is a Project on the same poll that first sees
        # a pane in it, rather than one poll later.
        if await asyncio.to_thread(refresh_projects):
            await broadcast({"type": "projects", "projects": public_projects(PROJECTS)})
        # One `pane list` per configured host, each a subprocess and each an SSH round trip for a
        # remote one — the longest blocking stretch in the relay, and it runs every poll interval.
        agents, shells = await asyncio.to_thread(get_all_panes)
        latest_agents = agents
        latest_shells = shells
        ambiguous_panes.clear()
        # Over both lists: a shell pane ID is a per-server counter and collides across hosts
        # exactly as an agent's does (D6). A pane the relay will address but has not been
        # collision-checked is the bug this set exists to prevent.
        ambiguous_panes.update(ambiguous_pane_ids(agents + shells))
        shell_panes.clear()
        shell_panes.update(s["pane_id"] for s in shells)
        # Always broadcast (even empty list) so clients stay in sync
        for p in agents + shells:
            pane_remote_map[p["pane_id"]] = p.get("remote")
            known_panes.add(p["pane_id"])
        # Before the snapshot goes out, so a pane's first appearance after a restart carries the
        # branch the record already knows rather than nothing.
        await seed_branches(agents)
        # Before the identity pass, which reads it: a start that named itself is the one case where
        # the client has already said which agent this pane continues, and rule 2 needs it stamped.
        for a in agents:
            ref = pane_ref.get(a["pane_id"])
            if ref:
                a["ref"] = ref
            # And what the start said about itself that herdr does not report back. On the pane
            # rather than passed alongside, because the identity pass persists exactly what the
            # pane carries — after which these outlive this process, which the maps above do not.
            said = pane_spawn.get(a["pane_id"])
            if said:
                for k, v in said.items():
                    if v:
                        a[k] = v
        # Which *agent* is in each pane, as opposed to which slot the pane is. Against the whole
        # roster in one call, because "who no longer has a pane" is only answerable against all of
        # it — half a roster would retire every agent on the other host. See relay/agent_ids.py.
        if agent_ids is not None:
            try:
                # Stamps `aid` on each pane in place, which is what the snapshot goes out carrying.
                await asyncio.to_thread(agent_ids.resolve, agents)
                latest_retired = await asyncio.to_thread(agent_ids.retired, RETIRED_MAX)
            except sqlite3.Error as e:
                # A registry that will not answer is not worth a poll that does not happen.
                log.warning("agent ids: %s", e)
        # Rebuilt rather than updated: an agent that has ended must stop being addressable this
        # poll, and the roster is the only thing that says which ones are still here.
        pane_by_aid.clear()
        pane_by_aid.update({a["aid"]: a for a in agents if a.get("aid")})
        for a in agents:
            agent_cache[a["pane_id"]] = a
            # Where this pane's work is landing, carried on the snapshot so the app can say so
            # without a thread being open. herdr does not report it and this relay does not ask
            # git for it here — it is whatever the last probe of that directory saw.
            branch = pane_branch.get(branch_key(a))
            if branch:
                a["branch"] = branch
            # Which agent config this pane was started under, so the app can call it `oclaude1`
            # rather than `claude` — herdr knows nothing about aliases, and the kind stays the
            # kind, because everything else keys off it.
            config = pane_config.get(a["pane_id"])
            if config:
                a["config"] = config
            # The id the client that started this pane gave it is stamped above, before the
            # identity pass that reads it.
            #
            # And the agent in this pane — minted once, kept across every pane it goes on to
            # occupy — is stamped by that same pass. A pane id is herdr's slot and is recycled;
            # `aid` is the colleague.

            # The newest row this pane's record holds, so a thread on screen can tell it is behind.
            # Only ever set by this relay's own writes, which is all a client compares it against.
            turn = pane_turn_ids.get(a["pane_id"])
            if turn:
                a["turn"] = turn
            # A first prompt at a pane herdr still calls idle. Read before the snapshot goes out,
            # so the status the client is given is the one the pane is really in and the blocked
            # branch below announces it like any other.
            if a["status"] == "idle" and spawn_menu_pending(a["pane_id"], time.monotonic()):
                first = await asyncio.to_thread(read_pane, a["pane_id"], remote=a.get("remote"))
                if detect_choices(first):
                    a["status"] = "blocked"
            # A pane nobody ever prompted. Its kind's opening lines are still owed to it.
            await drain_init(a["pane_id"], now=time.monotonic())
        # A pane that closed inside its window is never coming back to be drained.
        for pid in set(init_pending) - {a["pane_id"] for a in agents}:
            del init_pending[pid]
        await broadcast(snapshot_message())
        for a in agents:
            pid, status = a["pane_id"], a["status"]
            was = last_statuses.get(pid)
            content = None
            if status == "blocked" and was != "blocked":
                content = await asyncio.to_thread(read_pane, pid, remote=a.get("remote"))
                await broadcast({
                    "type": "blocked", "pane_id": pid,
                    "agent": a["agent"], "project": a["project"],
                    "host": a.get("host", "local"),
                    "prompt": content[:500],
                    "options": blocked_options(content, a["agent"])
                })
                # Web Push notification
                await send_web_push(
                    title=f"🐑 {a['project']} needs you",
                    body=notify_body(content),
                    url=f"/?pane={pid}",
                    tag=push_tag(pid),
                )
            # Finishing is the other thing worth a Lock Screen, and the one the web app has always
            # treated as equal — ATTENTION there is ['blocked', 'done']. Only from working or
            # blocked, so a pane already sitting done at startup does not announce itself. Sharing
            # the pane's tag means this *replaces* its blocked notification rather than stacking
            # under it, which is why it is also the clear for the approve-then-finish path.
            elif status == "done" and was in ("working", "blocked"):
                content = await asyncio.to_thread(read_pane, pid, remote=a.get("remote"))
                # Only the finished push reads the closing message. A blocked pane's news is the
                # question in the box at its foot, which is what notify_body already reads; the
                # closing message above it is what the agent said before it stopped to ask.
                await send_web_push(
                    title=f"🐑 {a['project']} finished",
                    body=finished_body(content, a["agent"]),
                    url=f"/?pane={pid}",
                    tag=push_tag(pid),
                )
            # Unblocked into anything else — someone answered it elsewhere, so take the
            # notification off this device's Lock Screen too.
            elif status != "blocked" and was == "blocked":
                await send_web_push("", "", clear=True, tag=push_tag(pid))
            # The record, on any move into an ending state — the same rule the browser's recorder
            # uses (endsTurn in web/src/state.js), and deliberately not "on done". A pane that
            # finishes and drops to idle has said its piece exactly as much as one that reports
            # done, and several harnesses end that way every time.
            #
            # First sight seeds the state; it is not a transition. Reading it would fill a fresh
            # database, on the first poll, with the scrollback of every pane that happened to be
            # sitting idle — most of which will never say another word. A pane that does go on to
            # end a turn backfills its window then, when there is a reason to believe it is live.
            if conv_log is not None and was is not None and status != was and ends_turn(status):
                # Its own read. `content` above is the push preview, which is the wrong shape for a
                # parser — see read_pane_for_record. Two reads of a pane that just ended a turn is
                # the price of the record being right, and it is paid once per turn rather than
                # once per poll.
                #
                # A write that raised said nothing about whether the pane spoke, so the trigger is
                # not suppressed on it. Only an empty write is evidence of an empty turn.
                wrote = True
                try:
                    captured = await asyncio.to_thread(
                        read_pane_for_record, pid, remote=a.get("remote"))
                    # Has it actually said anything? The window is never empty — it holds the whole
                    # previous turn — so this is the only form of the question that can tell a pane
                    # that answered from one that flipped to idle before it painted. When it has
                    # not, the turn is left open and picked up by `collect_late_turns`: recording
                    # now would write the pane's own footer as the agent's closing words, and
                    # asking the arbitrator now would ask it to decide on that.
                    if LATE_TURN_MS and not await asyncio.to_thread(conv_log.pending, a, captured) \
                            and not decides(pid):
                        late_turns[pid] = {"was": was, "status": status,
                                           "until": int(time.time() * 1000) + LATE_TURN_MS}
                        last_statuses[pid] = status
                        continue
                    late_turns.pop(pid, None)
                    git = await probe_git(a)
                    ids = await asyncio.to_thread(
                        conv_log.record_turn_end, a, captured, was, status, git=git)
                    wrote = bool(ids)
                    await note_turn_ids(pid, ids, a)
                except (sqlite3.Error, OSError) as e:
                    log.warning("conversation log write failed for %s: %s", pid, e)
                # A pane ending a turn means one of two opposite things, and arbitration decides
                # which — a member finishing is a wake-up (N3), the arbitrator finishing is the
                # signal to read the drop-box. Both are no-ops when nothing is running, so this
                # asks on every transition rather than the poll loop knowing about sessions.
                #
                # Recorded first, deliberately: the prompt is built out of the record, so a turn
                # that has not landed yet is a turn the arbitrator would be asked to decide without.
                if arbitration is not None:
                    await asyncio.to_thread(arbitrate_turn_end, a, pid, wrote)
            last_statuses[pid] = status
        # Turns that ended with nothing on screen yet, given another look now that some time has
        # passed. Before the clocks, because a turn that lands here is a turn that just happened.
        await collect_late_turns(agents)
        # And sends that could not be proven when they went out, which this same snapshot answers.
        await confirm_pending_sends(agents)
        # §10's clocks, once per poll and after every transition above has been recorded: an idle
        # clock is "nothing has happened for a while", so it must be evaluated against a record
        # that already knows about anything that just did.
        if arbitration is not None:
            await asyncio.to_thread(arbitrate_clocks, agents)
        # Clean up panes that are no longer reported
        current_pane_ids = {p["pane_id"] for p in agents + shells}
        stale = known_panes - current_pane_ids
        if stale:
            known_panes.difference_update(stale)
            for pid in stale:
                pane_remote_map.pop(pid, None)
                last_statuses.pop(pid, None)
                agent_cache.pop(pid, None)
            # Keyed by directory, so it is dropped when the last pane in that directory goes rather
            # than with any one of them.
            live = {branch_key(p) for p in agents + shells}
            for key in [k for k in pane_branch if k not in live]:
                del pane_branch[key]


ARB_DIGEST = 6      # entries of context behind the one that fired, per §11.3
ARB_DIGEST_SCAN = 6  # digests' worth read before another pane's rows are dropped


def arbitration_entries(pane):
    """What the arbitrator is shown: the roster's recent turns, oldest first.

    Read back out of the record rather than passed down from the capture, because the record is
    what a session is *about* — it holds both members and every human prompt this relay delivered,
    and the pane that just finished is only one voice in that. Selected by fingerprint for the same
    reason everything else is: pane ids do not survive a restart.

    Scoped to the session **this pane** is in, not to "the running one": several sessions run at
    once, and handing one arbitrator another conversation's turns is the whole failure that
    independence is supposed to rule out.

    Assembles prose; reads none of it (N1).
    """
    session_id = arbitration.session_of_pane(pane.get("pane_id"))
    if session_id is None:
        return []
    return arbitration_entries_of(session_id)


def arbitration_entries_of(session_id):
    """The same digest, for a session rather than for the pane that woke it.

    A resume has no pane behind it — nobody finished a turn, a person pressed a button — and what
    it needs to show is exactly what a turn end shows: the roster's recent turns, which for a
    session coming back from a pause is the work done while it was stopped.
    """
    members = arbitration.members(session_id)
    fingerprints = [[m["host"], m["agent"], m["cwd"]] for m in members]
    # The pane's own label, and never the role: a role is what a member is *for* and several
    # members may carry the same one, so heading a turn with it would put two agents' words under
    # one name. The roster line in the trigger message carries both, which is where they belong.
    labels = {(m["host"], m["agent"], m["cwd"]): (m["label"] or m["member_id"])
              for m in members}
    # A fingerprint is (host, agent, cwd) and nothing more, because pane ids do not survive a
    # herdr restart. Which means two panes running the same agent in the same directory are one
    # fingerprint — and one of them may not be in this session at all. That is not theoretical: a
    # person's own Claude pane in this repo put their prompts into another conversation's
    # arbitrator digest, headed with a member's label, so the arbitrator was told a member had
    # said something nobody in that session ever said.
    #
    # An exited stranger is still a stranger; allowing every no-longer-live pane would recreate the
    # leak on the next digest. The member table holds the pane chosen at enrolment and the live
    # roster holds its current successor, so their union is the safe set across a restart.
    ours = {m["pane_id"] for m in members if m["pane_id"]}
    ours.update(m["pane_id"] for m in arbitration.roster(session_id).values() if m["pane_id"])
    # ponytail: over-fetch and keep, rather than teaching the query a pane selector. The digest is
    # six rows and the scan is bounded; add one only if this bounded filter becomes measurable.
    rows, _ = conv_log.query(fingerprints=fingerprints, last=ARB_DIGEST * ARB_DIGEST_SCAN)
    rows = [r for r in rows if r["pane_id"] in ours][-ARB_DIGEST:]
    return [{"label": labels.get((r["host"], r["agent"], r["cwd"]), r["origin"]),
             "text": r["text"]} for r in rows]


def arb_session_message(session):
    """One session as the wire describes it — §15.2. Never carries an instruction.

    `why` is here and `instruction` is not, deliberately. The reason for a decision is what a
    person reviews and belongs on a strip above the thread; the instruction itself is an entry in
    the thread, which is where the record already puts it. Broadcasting it twice would put agent
    prose on a channel every connected client receives.
    """
    roster = arbitration.roster(session["id"])
    left = budget_left(session, arb_now())
    limits = json.loads(session["budget_json"])
    last = arbitration.conn.execute(
        "SELECT sequence, gate, to_member, why, ambiguity, at FROM decisions "
        "WHERE session_id=? AND valid=1 ORDER BY id DESC LIMIT 1", (session["id"],)).fetchone()
    arb_fp = json.loads(session["arbitrator_fp"])
    # Re-resolved only while the session is one that could write to somebody. A fingerprint is
    # (host, agent, cwd) and nothing more, so it cannot tell "the arbitrator came back" from "a
    # different claude in the same directory" — and a session that has been paused for a week would
    # otherwise adopt whichever pane a person next opens in that checkout, badge it as arbitrating
    # and make them confirm every line they type at their own agent. A stopped session claims
    # nobody: it publishes the pane it last used, which no longer exists after a herdr restart, and
    # `resume` does the resolving where a person is watching and a refusal is visible.
    arb_pane = (arb_resolve(arb_fp, session["arbitrator_pane"], live_panes())[0]
                if session["state"] in ARB_RUNNING else session["arbitrator_pane"])
    return {
        "type": "arb_session",
        "session": {
            "id": session["id"], "state": session["state"],
            "pause_reason": session["pause_reason"],
            "conversation": session["conversation"], "scope": session["scope"],
            # The clocks, so the dialog that edits a session can show them as they are. Relay-side
            # policy, never anything the arbitrator sees — it cannot act on a clock.
            "triggers": json.loads(session["triggers_json"]),
            # Relay-side policy like the clocks, and on this message for the same reason: the
            # dialog that edits a session has to open on what it already says.
            "warmup": bool(session["warmup"]),
            # Which instruction style the arbitrator is writing under. Relay-side policy like the
            # two above, and on this message for the same reason — but unlike them the arbitrator
            # does see it, once per trigger, which is what lets a person change it mid-session.
            "mode": session["mode"],
            "members": [{"id": mid, "label": m["label"], "agent": m["agent"], "role": m["role"],
                         "pane_id": m["pane_id"], "status": m["status"]}
                        for mid, m in roster.items()],
            # The fingerprint too, not only the pane. The thread draws the arbitrator's decisions
            # as bubbles, and it asks the record for them the way it asks for everything else —
            # by (host, agent, cwd), because pane ids are renumbered on every restart. The
            # arbitrator is still not a member: this is what the client needs to *read* its
            # decisions, and enrolling it is what would put it in the conversation.
            "arbitrator": {"pane_id": arb_pane, "status": next(
                (p.get("agent_status") or "" for p in live_panes()
                 if p.get("pane_id") == arb_pane), ""),
                "host": arb_fp[0], "agent": arb_fp[1], "cwd": arb_fp[2],
                "label": next((p.get("label") or "" for p in live_panes()
                               if p.get("pane_id") == arb_pane), "")},
            # What is left, and what it is left *of*. A countdown alone cannot be edited back
            # into a limit, so the dialog that raises a spent budget needs the maxima as they
            # stand — the same reason the clocks are on this message.
            "budget": {"steps_left": left["steps"], "consecutive_left": left["consecutive"],
                       "minutes_left": left["ms"] // 60000,
                       "max_steps": limits["max_steps"],
                       "max_consecutive": limits["max_consecutive"],
                       "max_minutes": limits["max_wall_clock_ms"] // 60000},
            "last_decision": None if last is None else {
                "sequence": last["sequence"], "gate": last["gate"], "to": last["to_member"],
                "why": last["why"], "ambiguity": last["ambiguity"], "at": last["at"]},
            # What pressing Resume would do, worked out by the code that does it — see
            # `resume_plan`. On the session message rather than answered on request, because the
            # question is asked by a person looking at a stopped session and the strip is what
            # they are looking at. `prompt_id` is dropped: it is how the relay finds an unread
            # decision, and a client that had it could do nothing with it.
            "plan": {k: v for k, v in arbitration.resume_plan(session["id"]).items()
                     if k != "prompt_id"},
            # How far this session's path has got, as one number. Not the path itself — that is
            # prose and goes only to the client that asks for it — but a watermark, so a client
            # holding an older copy knows to ask again. Without it the thread's steps only
            # refreshed when a *decision* landed, which is exactly the case a stuck session never
            # reaches: waiting on a record, a trigger dropped at a paused session, a drop box that
            # cannot be read.
            "event_at": (arbitration.conn.execute(
                "SELECT MAX(id) FROM events WHERE session_id=?",
                (session["id"],)).fetchone()[0] or 0),
        },
    }


def arb_broadcast(session):
    """Announce a state change from the thread a session runs on. §15.2."""
    on_loop(broadcast(arb_session_message(session)))


def arbitrate_turn_end(pane, pane_id, wrote=True):
    """One pane's turn end, offered to the running session. Called from a worker thread.

    `wrote` is whether the conversation log wrote anything for this turn. It gates the *member*
    path only: the arbitrator's own turn end is expected to leave nothing new on its pane, since
    its answer is a file it has already written.

    Never raises into the poll loop. Arbitration is one feature among many and a session that
    cannot proceed is its own problem to report — it pauses and pushes — not a reason for the
    relay to stop telling everyone else what their agents are doing.
    """
    try:
        # Which session, if any, this pane belongs to. Several run at once now — one per
        # conversation — and a pane is in at most one of them, which is what makes this a lookup
        # rather than a search.
        session_id = arbitration.session_of_pane(pane_id)
        if session_id is None:
            return
        acted = arbitration.arbitrator_finished(pane_id)
        if acted is None:
            acted = arbitration.turn_ended(pane_id, arbitration_entries(pane), wrote=wrote)
        # Announced whether or not anything was asked. Read back rather than reused: whatever just
        # happened is very likely to have changed the state, the budget or the last decision, and
        # the strip above the thread is only worth having if it says what is true now. A turn that
        # was *not* acted on still moves the path — a member finishing while the session is paused
        # is the fact a person resuming most needs — and `event_at` is how the client learns to
        # come and read it.
        arb_broadcast(arbitration.session(session_id))
    except Exception as e:                       # noqa: BLE001 — see the docstring
        log.warning("arbitration: turn end for %s not handled: %s", pane_id, e)


def arbitrate_clocks(agents):
    """The idle and runtime triggers, offered to the running session. §10.

    Same path a real turn end takes — the clock decides *when* to ask, never what is asked or what
    happens next. Never raises into the poll loop, for the reason `arbitrate_turn_end` does not.
    """
    try:
        due = arbitration.due()
        if not due:
            return
        by_pane = {a["pane_id"]: a for a in agents}
        for item in due:
            pane = by_pane.get(item["pane_id"])
            if pane is None:
                continue
            acted = arbitration.turn_ended(item["pane_id"], arbitration_entries(pane),
                                           kind=item["trigger"])
            if acted is not None:
                session_id = arbitration.session_of_pane(item["pane_id"])
                if session_id is not None:
                    arb_broadcast(arbitration.session(session_id))
    except Exception as e:                       # noqa: BLE001 — see arbitrate_turn_end
        log.warning("arbitration: clocks not handled: %s", e)


def on_loop(coro, wait=False):
    """Run a relay coroutine from the worker thread arbitration lives on.

    Everything Arbitration calls out to — delivering an instruction, announcing a pause — is async
    here, and the session runs inside `asyncio.to_thread` so the poll loop is not blocked by an
    agent that takes eight seconds to accept a paste. This is the one bridge between the two, and
    keeping it in a single named place is what stops the class itself from growing an event loop.
    """
    future = asyncio.run_coroutine_threadsafe(coro, MAIN_LOOP)
    return future.result() if wait else None


def arbitration_send(pane_id, text):
    """Deliver an arbitrated instruction, and wait for it to land.

    Not `pane run`, which is what the spec was written against. That form sends the text and its
    Enter in one herdr call with no gap, and herdr pastes with bracketed paste — a TUI still laying
    out a payload drops the Enter and the instruction sits unsent in a composer nobody is watching.
    See the decision log for submitting a paste; `submit_paste` confirms against the pane instead.

    Waits, because the next thing this session does is record that the send happened.
    """
    return on_loop(submit_paste(pane_id, text, remote=pane_remote_map.get(pane_id)), wait=True)


# What empties an agent's context. Claude Code and Codex both take it; a harness that does not
# gets a line it does not understand and an unchanged context, which is the same place a person
# who never pressed the button is in. Not configurable until a harness asks for it.
ARB_CLEAR = "/clear"


async def clear_pane(pane_id):
    """Type the clear command and press Enter once. No watching, and none to do.

    `submit_paste` proves a send by waiting for the pane to say it is working, and clearing a
    context is the one thing an agent does *without* going to work — it answers instantly and
    stays `idle`, which that loop reads as "not taken yet" and spends its whole timeout on. One
    press is right here, and what has to land is the brief that follows, which is confirmed.
    """
    remote = pane_remote_map.get(pane_id)
    await asyncio.to_thread(run_herdr, "pane", "send-text", pane_id, ARB_CLEAR, remote=remote)
    await asyncio.sleep(submit_settle(ARB_CLEAR))
    await asyncio.to_thread(run_herdr, "pane", "send-keys", pane_id, "Enter", remote=remote)
    # A beat for the harness to actually empty itself, so the brief is not typed into a composer
    # that is about to be wiped.
    await asyncio.sleep(1.0)


def arbitration_clear(pane_id):
    return on_loop(clear_pane(pane_id), wait=True)


def arbitration_paused(session, reason):
    """Every pause reaches a Lock Screen. §9.3 — an unattended loop that stops must not be news
    six hours later. Fire and forget: the pause is already committed, and a push nobody receives
    is not a reason to hold up the thread that stopped the session."""
    # And every open client, which is the one that costs nothing and is seen soonest. A pause can
    # happen with nobody's phone locked at all — the person is looking at the app.
    arb_broadcast(session)
    on_loop(send_web_push(
        title="🐑 Arbitration paused",
        body=f"{reason.replace('_', ' ')} — {session['scope'][:120]}",
        url="/",
        tag=f"herdr-arb-{session['id']}",
    ))


def annotate_pane(pane):
    """One pane through the Project rules, in place.

    The poll path annotates a whole snapshot; a pushed event arrives one pane at a time and had
    been skipping this entirely. The hook can only name a project after the pane's own cwd, so an
    agent working in a subdirectory pushed itself as "web" and the update overwrote the label the
    last snapshot had just resolved — the name flipped back and forth as events arrived.
    """
    annotate_agents([pane], PROJECTS)
    return pane


async def event_push():
    while True:
        event = await event_queue.get()
        pane_id = event.get("pane_id", "")
        update = None
        if pane_id and event.get("type") == "agent_event":
            update = complete_agent_update_message(
                event,
                current=agent_cache.get(pane_id),
                local_hostname=socket.gethostname(),
            )
            if update is None:
                continue
        agent_data = annotate_pane(update["agent"] if update else event)
        status = agent_data.get("status", "")
        host = agent_data.get("host", "local")

        if status == "blocked" and pane_id:
            remote = pane_remote_map.get(pane_id)
            if remote or host == "local":
                content = read_pane(pane_id, remote=remote)
            else:
                content = event.get("prompt", "Agent is blocked")
            await broadcast({
                "type": "blocked", "pane_id": pane_id,
                "agent": agent_data.get("agent", ""),
                "project": agent_data.get("project", ""),
                "host": host,
                "prompt": content[:500],
                "options": blocked_options(content, agent_data.get("agent", ""))
            })

        if update:
            known_panes.add(pane_id)
            pane_remote_map.setdefault(pane_id, None)
            agent_cache[pane_id] = {**agent_cache.get(pane_id, {}), **update["agent"]}
            await broadcast(update)


async def process_request(connection, request, require_token=True, serve_app=False):
    """Handle HTTP POST on the same port as WebSocket.

    `require_token` comes from the listener that accepted this connection, not from a global.
    It gates the whole HTTP surface — the WebSocket upgrade, GET / serving the web app, and the
    event-push endpoint below — because they all arrive through here.

    `serve_app` comes from the same place, and is on for the LAN listener only. The app's files —
    index.html, src/*.js, the built bundle, the manifest and the icons — are a LAN convenience:
    on the same network you open the relay's own address and get the page. Off the LAN the page
    comes from where it is hosted (GitHub Pages) and the tunnel carries the socket and nothing
    else, so publishing the file surface through it widens what an ingress can reach for no gain.
    A token still gates the tunnel; this is the second wall, and the one that does not depend on a
    secret staying secret.
    """
    from websockets.http11 import Response
    from websockets.datastructures import Headers

    if require_token:
        token = None
        for key, value in request.headers.raw_items():
            if key.lower() == "authorization":
                token = value.replace("Bearer ", "")
        # Also check query param ?token=
        if not token and "token=" in (request.path or ""):
            import urllib.parse
            _, qs = request.path.split("?", 1) if "?" in request.path else (request.path, "")
            params = urllib.parse.parse_qs(qs)
            token = params.get("token", [None])[0]
        # compare_digest, not !=: the external listener is published to the internet through a
        # tunnel, and a short-circuiting compare leaks the token prefix through timing.
        if not (token and hmac.compare_digest(token, AUTH_TOKEN)):
            # CORS on the rejection too. The web app is served from a different origin than the
            # relay whenever it is hosted (GitHub Pages, Cloudflare Pages), and a 401 without this
            # header is unreadable to the caller — the browser reports an opaque network failure
            # and the app cannot tell "wrong token" from "relay is down". Allowing the *response*
            # to be read grants nothing: the request was already refused.
            headers = Headers([
                ("Content-Type", "text/plain"),
                ("Access-Control-Allow-Origin", "*"),
            ])
            return Response(401, "Unauthorized", headers, b"Invalid token\n")

    # Check if this is a WebSocket upgrade
    upgrade = None
    for key, value in request.headers.raw_items():
        if key.lower() == "upgrade":
            upgrade = value.lower()
    if upgrade == "websocket":
        return None  # proceed with WebSocket handshake

    # For CORS preflight
    if request.path and "OPTIONS" in str(request.headers):
        headers = Headers([
            ("Access-Control-Allow-Origin", "*"),
            ("Access-Control-Allow-Methods", "POST, OPTIONS"),
            ("Access-Control-Allow-Headers", "Content-Type"),
        ])
        return Response(204, "No Content", headers, b"")

    # ⚠ EVENT PUSH MUST BE HANDLED FIRST — ORDER IS LOAD-BEARING.
    # A pushed event arrives as `?d=<urlencoded json>` on ANY path.
    # The README shows POST to :8375 without naming a path, so `/` is common.
    # Every static route below `return`s, so if reached first the event is
    # dropped while caller still gets 200. Add new static routes BELOW, never above.
    import urllib.parse
    if "?" in (request.path or ""):
        _, qs = (request.path or "").split("?", 1)
        params = urllib.parse.parse_qs(qs)
        if "d" in params:
            try:
                event = json.loads(params["d"][0])  # parse_qs already decodes
                event_queue.put_nowait(event)
                log.debug("push: received event type=%s", event.get("type", "unknown"))
            except Exception as e:
                log.warning("push: unparseable event payload (%d bytes): %s", len(params["d"][0]), e)
            headers = Headers([("Access-Control-Allow-Origin", "*")])
            return Response(200, "OK", headers, b"ok\n")

    path = (request.path or "/").split("?")[0]

    # Everything below to the VAPID key is the app's own files, and none of it is served off the
    # LAN. The API surface — the WebSocket upgrade above, the push endpoint above, and the VAPID
    # key below — is unchanged on both listeners: a hosted app reaching this relay over the tunnel
    # needs all three and none of these.
    name = path.lstrip("/")
    if serve_app:
        served = _serve_web_file(path, name)
        if served is not None:
            return served

    # Serve VAPID public key
    if path == "/api/vapid-public-key":
        body = json.dumps({"publicKey": VAPID_PUBLIC_KEY}).encode()
        headers = Headers([
            ("Content-Type", "application/json"),
            ("Access-Control-Allow-Origin", "*"),
        ])
        return Response(200, "OK", headers, body)

    # Fallback for unmatched paths
    headers = Headers([("Access-Control-Allow-Origin", "*")])
    return Response(404, "Not Found", headers, b"not found\n")


def _serve_web_file(path, name):
    """The app's files by name, or None when the path names none of them.

    Split out of process_request so the LAN-only gate is one branch around one call rather than a
    condition repeated over four blocks — a file surface that is off for the tunnel in three
    places and on in the fourth is exactly the bug this shape prevents.
    """
    from websockets.http11 import Response
    from websockets.datastructures import Headers

    if path in ("/", "/index.html"):
        index_path = os.path.join(WEB_DIR, "index.html")
        if os.path.isfile(index_path):
            with open(index_path, "rb") as f:
                body = f.read()
            headers = Headers([
                ("Content-Type", "text/html; charset=utf-8"),
                ("Cache-Control", "no-cache"),
            ])
            return Response(200, "OK", headers, body)

    # The rest of web/, by name. An allowlist rather than a directory walk: LAN-only is not a
    # reason to relax it — any route that turns a request path into a filesystem path is one `..`
    # away from serving the repo, and every device on the network reaches this.
    if name in STATIC_FILES:
        ctype, extra = STATIC_FILES[name]
        file_path = os.path.join(WEB_DIR, name)
        if os.path.isfile(file_path):
            with open(file_path, "rb") as f:
                body = f.read()
            return Response(200, "OK", Headers([("Content-Type", ctype), *extra]), body)

    # Modular source scripts (dev mode): web/src/*.js. Safe single-level check prevents traversal.
    if name.startswith("src/") and name.endswith(".js") and name.count("/") == 1:
        base = name[4:]
        if all(c.isalnum() or c in "-_." for c in base):
            file_path = os.path.join(WEB_DIR, name)
            if os.path.isfile(file_path):
                with open(file_path, "rb") as f:
                    body = f.read()
                return Response(200, "OK", Headers([("Content-Type", "application/javascript; charset=utf-8"), ("Cache-Control", "no-cache")]), body)

    # Built distribution (production bundle preview): web/dist/*
    if name in ("dist", "dist/", "dist/index.html"):
        file_path = os.path.join(WEB_DIR, "dist", "index.html")
        if os.path.isfile(file_path):
            with open(file_path, "rb") as f:
                body = f.read()
            return Response(200, "OK", Headers([("Content-Type", "text/html; charset=utf-8"), ("Cache-Control", "no-cache")]), body)
    if name.startswith("dist/") and name.count("/") == 1:
        base = name[5:]
        if base in STATIC_FILES:
            ctype, extra = STATIC_FILES[base]
            file_path = os.path.join(WEB_DIR, "dist", base)
            if os.path.isfile(file_path):
                with open(file_path, "rb") as f:
                    body = f.read()
                return Response(200, "OK", Headers([("Content-Type", ctype), *extra]), body)

    return None


async def handle_client(ws, listener="lan"):
    remote_addr = ws.remote_address
    ip = remote_addr[0] if remote_addr else "unknown"
    ua = ws.request.headers.get("User-Agent", "unknown") if ws.request else "unknown"
    origin = ws.request.headers.get("Origin", "") if ws.request else ""

    device = "unknown"
    ua_lower = ua.lower()
    if "iphone" in ua_lower or "ipad" in ua_lower:
        device = "iOS"
    elif "android" in ua_lower:
        device = "Android"
    elif "macintosh" in ua_lower or "mac os" in ua_lower:
        device = "macOS"
    elif "windows" in ua_lower:
        device = "Windows"
    elif "linux" in ua_lower:
        device = "Linux"
    elif "telegram" in ua_lower or "bot" in ua_lower:
        device = "bot"
    elif "python" in ua_lower:
        device = "script"

    # The listener is part of the identity of a write: on an open LAN listener the ip is the only
    # other attribution there is, and "which door did this come through" is the first question
    # anyone reading the audit log will ask.
    device = f"{device}/{listener}"
    log.info("Client connected: ip=%s device=%s origin=%s", ip, device, origin or "-")
    # Read before this socket joins the broadcast set. It reads the providers file off-thread, and
    # a poll broadcast landing in that gap arrives *between* `projects` and `start_options` — the
    # one ordering the burst below promises.
    options = (await asyncio.to_thread(start_options_message)
               if PROJECTS and WRITE_EXT else None)
    clients.add(ws)
    connected_at = time.monotonic()
    # Declared out here because the `finally` waits on them, and a socket can close before the read
    # loop that fills this is ever reached.
    inflight = set()
    try:
        # What this client is talking to, before anything it might have to explain. The page is
        # deployed apart from the relay and can be months older than it, so "which versions"
        # cannot be answered by the page alone — and it is the first question asked when the two
        # disagree. Unconditional: a client that does not know the type ignores it.
        await ws.send(json.dumps({"type": "versions", "relay": RELAY_VERSION,
                                  "herdr": herdr_version()}))
        # Preserve the legacy wire behavior when Projects are disabled. When enabled,
        # Projects must arrive before the cached snapshot so the client can group it.
        if PROJECTS:
            await ws.send(json.dumps({"type": "projects", "projects": public_projects(PROJECTS)}))
            # Presence of start_options is the browser's feature gate. Without Projects a
            # start can never resolve a cwd, so the control would only ever error (spec §3).
            if options is not None:
                # `terminal` gates + New terminal the same way this message gates Start. It is
                # only ever sent under WRITE_EXT, so a true here means both of open_terminal's
                # gates are open — the client never has to reason about them separately.
                await ws.send(json.dumps(options))
        # The cached snapshot is what carries `shells`, and its presence is the client's terminal
        # feature gate — so a terminal-mode relay sends it even without Projects, or a client
        # connecting between polls would see no terminals and no gate. With both off this is the
        # legacy wire unchanged: nothing until the first poll broadcast.
        if PROJECTS or TERMINAL:
            await ws.send(json.dumps(snapshot_message()))
        # After the snapshot, because a session names panes and a client that has not been told
        # what panes exist cannot render it. Sent even when nothing is running — an empty list is
        # what tells the browser the feature is on, exactly as start_options gates Start (§15.2).
        if arbitration is not None:
            open_sessions = await asyncio.to_thread(arbitration.open_sessions)
            await ws.send(json.dumps({
                "type": "arb_sessions",
                "sessions": [(await asyncio.to_thread(arb_session_message, session))["session"]
                             for session in open_sessions],
            }))
        # One message, handled. Lifted out of the read loop so it can be dispatched rather than
        # awaited — see the decision log for one lane per pane. Everything it closes over, from the
        # socket to which listener the client came through, is what it closed over inline.
        async def handle_message(msg, msg_type):
            if msg_type == "respond":
                pane_id, remote, pane_err = pane_target(msg)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    return
                # Permanent, not a phase gate: SAFE_RESPONSES is a list of agent approval strings,
                # and sending "yes, single permission" to a shell is meaningless at best.
                if pane_id in shell_panes:
                    await ws.send(json.dumps({
                        "type": "error", "message": "respond is not available on a terminal pane"}))
                    return
                text = msg.get("text", "")
                # A numbered choice off a pane's own menu — see detect_choices. What goes to the
                # pane is the digit alone: the label came out of that pane and typing it back is
                # not how the menu is answered.
                digit = choice_digit(text)
                if digit is None and text.strip().lower() not in SAFE_RESPONSES:
                    await ws.send(json.dumps({"type": "error", "message": "response not in allowlist"}))
                    return
                # The allowlist name, not free text: a response is one of SAFE_RESPONSES by the
                # check above, so this says everything the console needs without echoing input.
                log.info("Response from %s (%s): pane=%s", ip, device, pane_id)
                audit("respond", ip, device, pane_id, f"text={text!r}")
                # Not text + "\n": herdr sends a bracketed paste, so a trailing newline is
                # inserted as literal text and the approval never submits. Paste, let the TUI
                # settle, then press Enter.
                #
                # A numbered menu takes the digit and acts on it there and then — no Enter, which
                # would land in whatever the pane shows next. Verified against codex 0.24 at its
                # trust prompt: the digit alone answered it.
                await asyncio.to_thread(run_herdr, "pane", "send-text", pane_id, digit or text,
                                        remote=remote)
                if digit is None:
                    await asyncio.sleep(SEND_SETTLE)
                    await asyncio.to_thread(run_herdr, "pane", "send-keys", pane_id, "Enter",
                                            remote=remote)
                await record_sent(pane_id, text)
            elif msg_type == "agent_event":
                event_queue.put_nowait(msg)
            elif msg_type == "git_commits":
                # What was committed between two turns, asked for rather than stored. The record
                # keeps the sha each turn was read at, which is both ends of this question, so the
                # list itself is worth a git call at the moment a reader wants to see it and not
                # several megabytes of every record on the chance that they will.
                if not GIT_TRACK:
                    await ws.send(json.dumps({
                        "type": "error", "message": "git_commits: git tracking is off"}))
                    return
                try:
                    cwd, remote, first, last = git_range_target(msg)
                except ValueError as e:
                    await ws.send(json.dumps({"type": "error", "message": f"git_commits: {e}"}))
                    return
                found = await asyncio.to_thread(git_probe.commits, cwd, first, last, remote)
                await ws.send(json.dumps({
                    "type": "git_commits", "cwd": cwd, "host": msg.get("host") or "local",
                    "from": first, "to": last, "commits": found}))
            elif msg_type == "conv_log":
                # Answered to the asking client and never broadcast: this is the one message that
                # carries what an agent actually said, and a client that did not ask for a
                # transcript should not be handed one.
                if conv_log is None:
                    await ws.send(json.dumps({
                        "type": "error", "message": "conversation log is off"}))
                    return
                try:
                    # Off the event loop: resolving a commit is a subprocess, and an ssh round trip
                    # for a directory on another host.
                    since, until = await asyncio.to_thread(conv_log_window, msg)
                    rows, truncated = await asyncio.to_thread(
                        conv_log.query,
                        pane=msg.get("pane"), host=msg.get("host"), agent=msg.get("agent"),
                        cwd=msg.get("cwd"), kind=msg.get("kind"), grep=msg.get("grep"),
                        since=since, until=until,
                        since_id=msg.get("since_id"), until_id=msg.get("until_id"),
                        fingerprints=conv_fingerprints(msg.get("fingerprints")),
                        last=msg.get("last") or CONV_LOG_ROWS_DEFAULT)
                except (sqlite3.Error, OSError, ValueError, TypeError) as e:
                    await ws.send(json.dumps({"type": "error", "message": f"conv_log: {e}"}))
                    return
                out_msg = {
                    "type": "conv_log", "truncated": truncated,
                    "turns": [conv_as_wire(r) for r in rows],
                }
                if "fingerprints" in msg:
                    out_msg["fingerprints"] = msg.get("fingerprints")
                # Echoed for the same reason: a fingerprint is an agent in a directory and several
                # panes can share one, so a client that narrowed to a pane has to be able to tell
                # that answer from the roster's. Without it the narrow answer's highest id reads as
                # a watermark for every pane sharing the fingerprint, and the rest go quiet.
                if msg.get("pane"):
                    out_msg["pane"] = msg.get("pane")
                # A current pane can inherit a prior pane id after a respawn. `pane` filters the
                # physical record; this echoes the current logical owner so the browser can apply
                # the result and its end marker to the right member.
                if msg.get("owner_pane"):
                    out_msg["owner_pane"] = msg.get("owner_pane")
                # Echoed for a third reason, and the sharpest one: a backfill answer is the window
                # *before* what the client holds, so its highest id is older than the client's
                # watermark. Taken as a watermark it would wind that client backwards and make the
                # next delta re-fetch everything between. The client checks for this before it
                # moves anything.
                if msg.get("until_id") is not None:
                    out_msg["until_id"] = msg.get("until_id")
                # And for a fourth: a delta carries only what came after an id, so a client cannot
                # tell it from a window ask that answered with the same rows. It has to, because
                # only the window ask names the whole record — a client dropping rows an answer
                # left out would, off a delta, drop everything it holds.
                if msg.get("since_id") is not None:
                    out_msg["since_id"] = msg.get("since_id")
                await ws.send(json.dumps(out_msg))
            elif msg_type.startswith("arb_"):
                # One gate for the whole family. With arbitration off these are not merely
                # rejected, they are unknown — the wire is what it was, and a client that never
                # saw `arb_sessions` in the snapshot has no reason to send one (N10).
                if arbitration is None:
                    await ws.send(json.dumps({
                        "type": "error", "message": "arbitration is off"}))
                    return
                if msg_type == "arb_detail":
                    # Answered to the asking client and never broadcast: this is the one
                    # arbitration message that carries prose — an arbitrator's prompt, its
                    # instruction and the text that was typed at a member — and prose goes only
                    # where it was asked for, exactly as `conv_log` does.
                    #
                    # `brief` drops that prose and keeps what a decision *is*. The thread's
                    # bubbles ask on every event a session records — which is the point, a stuck
                    # session moves its path and not its sequence — and they draw none of the
                    # prose. A sheet somebody has open asks for all of it.
                    try:
                        session_id = msg.get("session") or ""
                        brief = bool(msg.get("brief"))
                        decisions, events, plan = await asyncio.to_thread(
                            lambda: (arbitration.detail(session_id, brief=brief),
                                     arbitration.events(session_id),
                                     arbitration.resume_plan(session_id)))
                    except ArbiterError as e:
                        await ws.send(json.dumps({
                            "type": "error", "code": e.code, "message": str(e)}))
                        return
                    except (KeyError, sqlite3.Error, OSError) as e:
                        await ws.send(json.dumps({"type": "error",
                                                  "message": f"{msg_type}: {e}"}))
                        return
                    await ws.send(json.dumps({
                        "type": "arb_detail", "session": msg.get("session") or "",
                        # Echoed, so a client can tell a copy with no prose in it from a session
                        # that decided nothing — and knows to ask again when a sheet opens.
                        "brief": brief,
                        "decisions": decisions, "events": events,
                        # Freshly worked out, unlike the copy on the held session message: the
                        # sheet is somebody looking *now*, and what Resume would do is exactly
                        # the thing that changes while a session sits stopped.
                        "plan": {k: v for k, v in plan.items() if k != "prompt_id"}}))
                    return
                try:
                    if msg_type == "arb_start":
                        # The relay assigns the id; a client never names one, because every path
                        # this feature writes to is derived from it.
                        session = await asyncio.to_thread(
                            functools.partial(
                                arbitration.start,
                                conversation=msg.get("conversation") or "",
                                members=msg.get("members") or [],
                                arbitrator=msg.get("arbitrator") or {},
                                scope=msg.get("scope") or "",
                                gates=msg.get("gates"), budget=msg.get("budget"),
                                triggers=msg.get("triggers"),
                                # A cold agent answers its first prompt with nothing. Off unless
                                # the person asked, and on regardless for the harnesses that need
                                # it — see Arbitration.warm.
                                warmup=bool(msg.get("warmup")),
                                # How much the arbitrator writes into an instruction. A property
                                # of the members, not of the work — see Arbitration.MODES.
                                mode=msg.get("mode"),
                                # Briefed but not armed: "initialised" and "started" are two
                                # things, and a person assembling a room wants the first.
                                paused=bool(msg.get("paused"))))
                    elif msg_type == "arb_reinit":
                        # The same brief the session opened with, into a pane with nothing else in
                        # it. Nothing about the session moves — see Arbitration.reinit.
                        session = await asyncio.to_thread(arbitration.reinit, msg["session"])
                    elif msg_type == "arb_members":
                        # Attach, detach and swap are one edit: §14.1 fixes the size at two, so
                        # the roster is always replaced whole. The arbitrator is told on this same
                        # call — see `set_members` for what that replaces about N6.
                        session = await asyncio.to_thread(
                            arbitration.set_members, msg["session"], msg.get("members") or [])
                    elif msg_type == "arb_pause":
                        # `user`, always: this is the one pause a person asks for by hand, and
                        # letting a client name the reason would let it forge a budget stop.
                        session = await asyncio.to_thread(
                            arbitration.pause, msg["session"], "user")
                    elif msg_type == "arb_edit":
                        # Every field of a running session, one set of rules — see
                        # `Arbitration.edit`. Absent means unchanged, which is what lets a client
                        # send only what the person touched.
                        session = await asyncio.to_thread(functools.partial(
                            arbitration.edit, msg["session"],
                            scope=msg.get("scope"), members=msg.get("members"),
                            arbitrator=msg.get("arbitrator"), triggers=msg.get("triggers"),
                            budget=msg.get("budget"), warmup=msg.get("warmup"),
                            mode=msg.get("mode")))
                    elif msg_type == "arb_resume":
                        # `kick` is what happens first. Without it the loop is armed and waits for
                        # a trigger, which may be a very long time coming; with it the arbitrator is
                        # asked now, and told what stopped the session — see `Arbitration.resume`.
                        session = await asyncio.to_thread(functools.partial(
                            arbitration.resume, msg["session"], kick=bool(msg.get("kick"))))
                    elif msg_type == "arb_cancel":
                        session = await asyncio.to_thread(
                            arbitration.end, msg["session"], msg.get("reason") or "cancelled")
                    else:
                        await ws.send(json.dumps({
                            "type": "error", "message": f"unknown message type: {msg_type}"}))
                        return
                except ArbiterError as e:
                    log.info("Arbitration %s from %s refused: %s", msg_type, ip, e.code)
                    await ws.send(json.dumps({
                        "type": "error", "code": e.code, "message": str(e)}))
                    return
                except (KeyError, sqlite3.Error, OSError) as e:
                    await ws.send(json.dumps({"type": "error", "message": f"{msg_type}: {e}"}))
                    return
                audit(msg_type, ip, device, session["id"], f"state={session['state']}")
                await broadcast(await asyncio.to_thread(arb_session_message, session))
            elif msg_type == "read_pane":
                pane_id, remote, pane_err = pane_target(msg)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    return
                lines = read_pane_lines(msg.get("lines"))
                # recent-unwrapped, not recent: it drops the line breaks the terminal itself
                # inserted, leaving only the ones the agent wrote. cols lets the client lay the
                # result out at the pane's true width instead of guessing.
                #
                # "visible" is the only alternative offered, and it is what Clear screen asks for:
                # a full-screen TUI repaints over a ctrl+l, so the only way to show a phone the
                # live frame and nothing else is to read the frame rather than the backlog. An
                # allowlist and not a pass-through — this string is an argv element.
                source = "visible" if msg.get("source") == "visible" else "recent-unwrapped"
                # Off the event loop, both of them. This is two subprocesses — an SSH round trip
                # each for a remote pane — and every open pane on every client repeats it every
                # few seconds. Run inline it stops the relay: the poll broadcast, every other
                # client's approval, and the ping that keeps this socket alive all wait behind
                # one client's deep read.
                content, cols = await asyncio.to_thread(read_pane_content, pane_id, lines, source, remote)
                await ws.send(json.dumps({
                    "type": "pane_content", "pane_id": pane_id, "content": content,
                    "source": source, "cols": cols}))
            elif msg_type == "send_keys":
                pane_id, remote, pane_err = pane_target(msg)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    return
                keys = msg.get("keys", [])
                if not all(k in SAFE_KEYS for k in keys):
                    await ws.send(json.dumps({"type": "error", "message": "keys contain disallowed values"}))
                    return
                log.info("Keys from %s (%s): pane=%s keys=%s", ip, device, pane_id, keys)
                audit("send_keys", ip, device, pane_id, f"keys={keys}")
                try:
                    result = await asyncio.to_thread(
                        run_herdr_result, "pane", "send-keys", pane_id, *keys, remote=remote)
                except Exception as e:
                    log.warning("send_keys command failed for pane %s: %s", pane_id, e)
                    await ws.send(json.dumps({"type": "error", "message": "send_keys command failed"}))
                    return
                if result.returncode != 0:
                    log.warning("send_keys command failed for pane %s with exit %s", pane_id, result.returncode)
                    await ws.send(json.dumps({"type": "error", "message": "send_keys command failed"}))
                    return
                await ws.send(json.dumps({"type": "command_result", "command": "send_keys", "ok": True}))
            elif msg_type == "send_text":
                pane_id, remote, pane_err = pane_target(msg)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    return
                text = msg.get("text", "")
                # The bound stays — an unbounded write is a real abuse vector.
                if not text or len(text) > SEND_TEXT_MAX:
                    await ws.send(json.dumps({"type": "error", "message": "text empty or too long"}))
                    return
                # `submit` asks the relay to submit the text, rather than the client sending its own
                # `send_keys ["Enter"]` behind this message. Two separate reasons, and both of them
                # were bugs first:
                #
                #   * an Enter travelling as its own client message arrives whenever the network
                #     feels like it, and there is nothing at this end that can hold it to the text;
                #   * whoever presses it has to know *when*, and neither end can know that from a
                #     clock — see SUBMIT_READY. submit_paste watches the pane instead.
                #
                # Optional, because the other clients still send their own Enter and must keep
                # working; those get the old fixed settle below and nothing more.
                submit = bool(msg.get("submit"))
                refused = False  # a pane at a menu takes nothing, and records nothing
                # Length, not the text: this line goes to the console the relay was started from,
                # and a person watching their own terminal has not asked to be shown every message
                # they send from their phone. The audit log below keeps the text itself.
                log.info("Text from %s (%s): pane=%s submit=%s chars=%d",
                         ip, device, pane_id, submit, len(text))
                audit("send_text", ip, device, pane_id, f"submit={submit} text={text!r}")
                if submit:
                    # Said out loud when it could not be proven. submit_paste returns False for a
                    # pane that never reported taking the text — commonly a pane already working,
                    # where it very probably queued — and a client that hears nothing draws the
                    # same empty composer either way. The text is still recorded as sent, because
                    # it very likely was; what the client is told is that nobody confirmed it.
                    out = {}
                    # Held only while there is something left to do. The presses are spent inside
                    # SUBMIT_FAST and everything after it is watching — which `confirm_pending_sends`
                    # already does, on the poll, and tells this same client about. Waiting the full
                    # harness window here blocked every later message from this browser instead:
                    # one connection is handled a message at a time, so a 45s watch at an agy pane
                    # was 45s of an unresponsive app.
                    if await submit_paste(pane_id, text, remote=remote, out=out,
                                          window=SUBMIT_FAST):
                        # Said out loud when it *did* land, too. It used to be silence, and a client
                        # with nothing to show for a send drew its own tick the moment the socket
                        # took the text — which is a claim about this end of the wire, not about the
                        # pane. One message per send either way: only the last chunk carries
                        # `submit`, and this is that chunk's answer.
                        await ws.send(json.dumps({
                            "type": "command_result", "command": "send_text", "ok": True,
                            "pending": False, "pane_id": pane_id,
                            "message": "the pane took it"}))
                    elif out.get("reason") == "pane_gone":
                        # No pending watcher and no record: the pane closed under this text, so
                        # there is nothing left to confirm it and nobody who read it. Told plainly,
                        # because the client's own composer still holds the words.
                        refused = True
                        await ws.send(json.dumps({
                            "type": "command_result", "command": "send_text", "ok": False,
                            "pending": False, "pane_id": pane_id, "reason": "pane_gone",
                            "message": "the pane closed before it took this"}))
                    elif out.get("reason") == "menu":
                        # Never sent, so never recorded and never watched: the text is still in the
                        # client's hands and the pane is at a question that has to be answered
                        # first. The options went out with the broadcast above.
                        refused = True
                        await ws.send(json.dumps({
                            "type": "command_result", "command": "send_text", "ok": False,
                            "pending": False, "pane_id": pane_id, "reason": "menu",
                            "message": "the pane is waiting on a prompt — answer it, "
                                       "then send this again"}))
                    else:
                        queued = out.get("reason") == "queued"
                        # Not the end of the story any more: the pane is watched until it goes to
                        # work on this, and the client is told when it does. `pending` is what says
                        # so — a client too old to read it sees the same failure it always saw.
                        pending_sends[pane_id] = {
                            "ws": ws, "until": int(time.time() * 1000) + CONFIRM_MS,
                            # A pane that ends is the proof a closing line landed, and the poll is
                            # where that is noticed now — the handler no longer waits long enough
                            # to see it itself.
                            "closing": text.strip() in CLOSING_LINES,
                            # A queued message is behind a turn that has to end first; a pane that
                            # never moved has already ended one, so its next move is the answer.
                            "idled": not queued}
                        await ws.send(json.dumps({
                            "type": "command_result", "command": "send_text", "ok": False,
                            "pending": True, "pane_id": pane_id, "reason": out.get("reason"),
                            "message": "queued behind what the pane is doing"
                                       if queued else "the pane has not confirmed it yet"}))
                elif await pane_menu_options(pane_id, remote=remote):
                    # The same refusal for a client that presses Enter for itself. It keeps the text
                    # out of the modal; the `send_keys ["Enter"]` behind it is still that client's
                    # to send, and it still answers the menu.
                    # ponytail: send_keys is left open on purpose — it is also how a person answers
                    # a menu. If a client is ever seen dismissing prompts with a bare Enter, the
                    # guard belongs there and needs a way to say "this Enter is an answer".
                    refused = True
                    await ws.send(json.dumps({
                        "type": "command_result", "command": "send_text", "ok": False,
                        "pending": False, "pane_id": pane_id, "reason": "menu",
                        "message": "the pane is waiting on a prompt — answer it, "
                                   "then send this again"}))
                else:
                    await asyncio.to_thread(run_herdr, "pane", "send-text", pane_id, text,
                                            remote=remote)
                    # Hold the handler until the pane has settled, so a `send_keys ["Enter"]`
                    # arriving right behind this — which is what a client that submits for itself
                    # does — lands late enough. One choke point, rather than a delay in each client.
                    await asyncio.sleep(SEND_SETTLE)
                if not refused:
                    await record_sent(pane_id, text)
                    # What a kind's own opening lines were waiting for: the pane has been given
                    # something to work on, and the grant goes in behind it as its own message.
                    await drain_init(pane_id)
            elif msg_type == "rename_pane":
                # Not behind HERDR_ENABLE_WRITE_EXT: that gate exists for spawning processes.
                # Relabelling an existing pane is strictly weaker than send_text and send_keys,
                # which are already open, so gating it here and not those would be theatre.
                pane_id, remote, pane_err = pane_target(msg)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    return
                label, label_err = validate_pane_label(msg.get("label", ""))
                if label_err:
                    await ws.send(json.dumps({"type": "error", "message": label_err}))
                    return
                audit("rename_pane", ip, device, pane_id, f"label={label!r}")
                try:
                    result = await asyncio.to_thread(
                        run_herdr_result, *pane_rename_args(pane_id, label), remote=remote)
                except Exception as e:
                    log.warning("rename failed for pane %s: %s", pane_id, e)
                    await ws.send(json.dumps({"type": "error", "message": "rename failed"}))
                    return
                if result.returncode != 0:
                    log.warning("rename failed for pane %s with exit %s", pane_id, result.returncode)
                    await ws.send(json.dumps({"type": "error", "message": "rename failed"}))
                    return
                await ws.send(json.dumps({"type": "command_result", "command": "rename_pane",
                                          "ok": True, "pane_id": pane_id, "label": label}))
            elif msg_type == "set_slot":
                # Behind the same gate as start_agent, unlike rename_pane: a narrow slot is made
                # by splitting, and a split starts a shell. That is process creation on this
                # machine, which is precisely what HERDR_ENABLE_WRITE_EXT governs.
                if not WRITE_EXT:
                    await ws.send(json.dumps({"type": "command_result", "command": "set_slot",
                                              "ok": False, "error": "write extensions disabled"}))
                    return
                pane_id, remote, pane_err = pane_target(msg)
                if pane_err:
                    await ws.send(json.dumps({"type": "command_result", "command": "set_slot",
                                              "ok": False, "error": pane_err}))
                    return
                slot = msg.get("slot")
                log.info("Set slot from %s (%s): pane=%s slot=%s", ip, device, pane_id, slot)
                audit("set_slot", ip, device, pane_id, f"slot={slot}")
                slot_err = await asyncio.to_thread(slot_exec, pane_id, slot, remote)
                if slot_err:
                    log.warning("set_slot failed for pane %s: %s", pane_id, slot_err)
                await ws.send(json.dumps({"type": "command_result", "command": "set_slot",
                                          "ok": not slot_err, "pane_id": pane_id, "slot": slot,
                                          **({"error": slot_err} if slot_err else {})}))
            elif msg_type == "create_tab":
                workspace_id = msg.get("workspace_id", "")
                if not workspace_id:
                    await ws.send(json.dumps({"type": "error", "message": "workspace_id required"}))
                    return
                # workspace_id is its own ID space and collides like pane_id does, so it
                # gets its own guard — the pane ambiguity set says nothing about it (D6).
                remote, ws_err = resolve_workspace_remote(latest_agents, workspace_id)
                if ws_err:
                    await ws.send(json.dumps({"type": "error", "message": ws_err}))
                    return
                log.info("Create tab from %s (%s): workspace=%s host=%s", ip, device, workspace_id, remote or "local")
                audit("create_tab", ip, device, "", f"workspace={workspace_id} host={remote or 'local'}")
                await asyncio.to_thread(
                    run_herdr, "tab", "create", "--workspace", workspace_id, "--focus", remote=remote)
                await ws.send(json.dumps({"type": "tab_created", "ok": True}))
            elif msg_type == "start_agent":
                # Reaching here proves write extensions are on — nothing more. It used to prove
                # the connection was authenticated too, because the relay refused to boot with
                # WRITE_EXT and no token; HERDR_LAN_OPEN=1 repeals that on the LAN listener by
                # explicit choice. On an open listener the audit line below is the only record of
                # who spawned what, and `ip` is the only attribution available.
                # See .workflow/02_architecture/2026-08-09_dual_listener_access.md
                if not WRITE_EXT:
                    await ws.send(json.dumps({"type": "command_result", "command": "start_agent",
                                              "ok": False, "error": "write extensions disabled"}))
                    return
                # Refused rather than dropped, like the config beside it: a client that named its
                # start and was quietly given a pane carrying no name would wait out its whole
                # window and then decide the start had failed.
                ref, ref_err = validate_start_ref(msg.get("ref"))
                if ref_err:
                    await ws.send(json.dumps({"type": "command_result", "command": "start_agent",
                                              "ok": False, "error": ref_err}))
                    return
                # Which agent this start brings back, if the client knows. Refused rather than
                # dropped for the same reason as the two beside it: a start that silently lost the
                # agent it was continuing comes up as a stranger in a conversation of its own,
                # while the thread it was for sits there looking dead.
                aid, aid_err = validate_start_aid(msg.get("aid"))
                if aid and not aid_err:
                    if agent_ids is None:
                        aid_err = "this relay does not track agent ids"
                    elif not await asyncio.to_thread(agent_ids.get, aid):
                        aid_err = "unknown agent id"
                    elif not ref:
                        # The binding is made against the start's own name, so there is nothing to
                        # bind to without one. Every client that can send an `aid` sends a `ref`.
                        aid_err = "an aid needs a ref to bind it to"
                if aid_err:
                    await ws.send(json.dumps({"type": "command_result", "command": "start_agent",
                                              "ok": False, "error": aid_err}))
                    return
                # Bound before the pane exists, not after it is made: a poll landing in between
                # would resolve the new pane by inference and mint a stranger, and rule 1 would
                # then have to move the agent onto it a poll later. A binding whose start goes on
                # to fail is harmless — a ref is unique to one press, so no other pane wears it.
                if aid:
                    await asyncio.to_thread(agent_ids.bind_ref, aid, ref)
                # Which opening prompt this session is started with. A name and never the text —
                # the client types the prompt. Kept so a browser that never watched the start can
                # still ask for the same opening when it restarts the agent.
                starter, starter_err = validate_start_starter(msg.get("starter"))
                if starter_err:
                    await ws.send(json.dumps({"type": "command_result", "command": "start_agent",
                                              "ok": False, "error": starter_err}))
                    return
                plan, start_err = validate_start_request(msg, PROJECTS, latest_agents, START_AGENTS)
                if start_err:
                    await ws.send(json.dumps({"type": "command_result", "command": "start_agent",
                                              "ok": False, "error": start_err}))
                    return
                # The config's id has a shape by now; this is where it gets a meaning. Refused
                # rather than dropped: a start that quietly ignored the config the user picked
                # would come up on the stock provider under the alias's name.
                if plan.get("config"):
                    pair, config_err = resolve_config(
                        plan["config"], plan["name"],
                        await asyncio.to_thread(agent_aliases), AGENT_PROVIDERS)
                    if config_err:
                        await ws.send(json.dumps({
                            "type": "command_result", "command": "start_agent",
                            "ok": False, "error": config_err}))
                        return
                    # No secret value passes through here: the line names the key's id and the
                    # pane's own shell fetches it with `secret` as the line runs.
                    plan["env_line"] = export_line(*pair)
                    # The other half of a config: a stock provider has no environment to export
                    # and says which model it wants on the harness's own argv instead.
                    plan["config_args"] = model_args(*pair)
                detail = (f"name={plan['name']} role={plan['role']} project={plan['project_id']} "
                          f"placement={plan['placement']} host={plan['remote'] or 'local'} "
                          f"config={plan.get('config') or '-'} "
                          # A start that makes a directory says so: it is the one kind of start
                          # that leaves something behind even when the agent never comes up.
                          f"child={plan.get('create_child') or '-'} "
                          # Worth a line of its own in the audit log: this is the start that will
                          # run tools without asking anyone.
                          f"unattended={'yes' if plan.get('unattended') else 'no'}")
                log.info("Start agent from %s (%s): %s", ip, device, detail)
                audit("start_agent", ip, device, "", detail)
                # Several herdr calls, one of them waiting out the agent's startup — off the loop.
                pane_id, exec_err = await asyncio.to_thread(start_agent_exec, plan)
                if exec_err:
                    log.warning("Start agent failed (%s): %s", detail, exec_err)
                    await ws.send(json.dumps({"type": "command_result", "command": "start_agent",
                                              "ok": False, "error": exec_err}))
                    return
                if plan.get("config"):
                    pane_config[pane_id] = plan["config"]
                # The two spawn details herdr has never heard of. Held here the way pane_config is,
                # and persisted by the identity pass on the next poll — after which they outlive
                # this process, which pane_config alone never did.
                if starter or plan.get("role"):
                    pane_spawn[pane_id] = {"starter": starter, "role": plan.get("role") or ""}
                if ref:
                    pane_ref[pane_id] = ref
                spawn_watch[pane_id] = time.monotonic() + SPAWN_WATCH_S
                log.info("Start agent ok: pane=%s label=%r name=%r",
                         pane_id, plan["label"], plan["agent_name"])
                await ws.send(json.dumps({"type": "command_result", "command": "start_agent",
                                          "ok": True, "pane_id": pane_id, "label": plan["label"]}))
            elif msg_type == "open_terminal":
                # Both gates. Terminal mode alone lists and drives shells that already exist;
                # creating one spawns a process on this machine, which is the line
                # HERDR_ENABLE_WRITE_EXT draws and the one a start crosses too.
                if not TERMINAL:
                    await ws.send(json.dumps({"type": "command_result", "command": "open_terminal",
                                              "ok": False, "error": "terminal mode disabled"}))
                    return
                if not WRITE_EXT:
                    await ws.send(json.dumps({"type": "command_result", "command": "open_terminal",
                                              "ok": False, "error": "write extensions disabled"}))
                    return
                plan, open_err = validate_open_terminal(
                    msg, PROJECTS, latest_agents + latest_shells)
                if open_err:
                    await ws.send(json.dumps({"type": "command_result", "command": "open_terminal",
                                              "ok": False, "error": open_err}))
                    return
                detail = (f"project={plan['project_id']} placement={plan['placement']} "
                          f"host={plan['remote'] or 'local'} label={plan['label']!r}")
                log.info("Open terminal from %s (%s): %s", ip, device, detail)
                audit("open_terminal", ip, device, "", detail)
                pane_id, exec_err = await asyncio.to_thread(open_terminal_exec, plan)
                if exec_err:
                    log.warning("Open terminal failed (%s): %s", detail, exec_err)
                    await ws.send(json.dumps({"type": "command_result", "command": "open_terminal",
                                              "ok": False, "error": exec_err}))
                    return
                log.info("Open terminal ok: pane=%s label=%r", pane_id, plan["label"])
                await ws.send(json.dumps({"type": "command_result", "command": "open_terminal",
                                          "ok": True, "pane_id": pane_id, "label": plan["label"]}))
            elif msg_type == "create_project":
                # The same gate a start crosses. Nothing is spawned here, but a directory made on
                # this machine at a client's word is the same kind of write, and without this gate
                # there is no way to make a child at all.
                if not WRITE_EXT:
                    await ws.send(json.dumps({"type": "command_result", "command": "create_project",
                                              "ok": False, "error": "write extensions disabled"}))
                    return
                extra = set(msg) - {"type", "project_id", "name"}
                if extra:
                    await ws.send(json.dumps({"type": "command_result", "command": "create_project",
                                              "ok": False,
                                              "error": f"unexpected field(s): {', '.join(sorted(extra))}"}))
                    return
                project, create_err = await asyncio.to_thread(
                    create_child, msg.get("name"), msg.get("project_id"), PROJECTS)
                if create_err:
                    await ws.send(json.dumps({"type": "command_result", "command": "create_project",
                                              "ok": False, "error": create_err}))
                    return
                # Audited after the fact rather than before, unlike a start: there is no plan to
                # record — validation and the mkdir are one call — and a name that was refused is
                # not something that happened to the filesystem.
                # A name that is already a project answers with the row it already has, which
                # can be a file project sitting at that exact path and carrying no parent.
                detail = (f"root={project.get('parent') or msg.get('project_id')} "
                          f"id={project['id']} cwd={project['cwd']}")
                log.info("Create project from %s (%s): %s", ip, device, detail)
                audit("create_project", ip, device, "", detail)
                # The roster is derived from a listing, so the directory that now exists is all
                # there is to write. Refreshed here rather than left to the next poll so the
                # client that asked can press what it just made: the answer to this message and
                # the roster it changed arrive on the same socket in that order.
                #
                # A poll can win the refresh race and own the changed return value. Still send this
                # roster before this request's result: the client selects project_id on success, so
                # it must already know that row regardless of which refresh saw the directory first.
                await asyncio.to_thread(refresh_projects)
                await broadcast({"type": "projects", "projects": public_projects(PROJECTS)})
                await ws.send(json.dumps({"type": "command_result", "command": "create_project",
                                          "ok": True, "project_id": project["id"],
                                          "label": project["label"]}))
            elif msg_type == "push_subscribe":
                sub = msg.get("subscription")
                if sub and sub not in push_subscriptions:
                    push_subscriptions.append(sub)
                    _save_push_subs()
                    log.info("Push subscription added from %s (%s)", ip, device)
                await ws.send(json.dumps({"type": "push_subscribed", "ok": True}))
            elif msg_type == "push_unsubscribe":
                sub = msg.get("subscription")
                if sub and sub in push_subscriptions:
                    push_subscriptions.remove(sub)
                    _save_push_subs()
                await ws.send(json.dumps({"type": "push_unsubscribed", "ok": True}))
            elif msg_type == "state_get":
                # An empty map rather than an error when there is no store: a client whose state is
                # local-only behaves exactly as it did before this existed, which is the whole
                # reason localStorage is still the working copy.
                if user_state is None:
                    await ws.send(json.dumps({"type": "state", "docs": {}}))
                    return
                names = msg.get("names") or list(STATE_DOCS)
                docs = await asyncio.to_thread(user_state.get, names)
                await ws.send(json.dumps({"type": "state", "docs": docs}))
            elif msg_type == "state_put":
                # Not behind HERDR_ENABLE_WRITE_EXT, for the same reason rename_pane is not: that
                # gate exists for spawning processes, and this writes a label the user typed. It is
                # strictly weaker than send_text, which is already open.
                if user_state is None:
                    await ws.send(json.dumps({
                        "type": "error", "message": "state store unavailable"}))
                    return
                name, body = msg.get("name", ""), msg.get("body")
                try:
                    new_rev = await asyncio.to_thread(
                        user_state.put, name, msg.get("rev"), body)
                except StateConflict as c:
                    # The current document rides along, so the loser of the race needs no second
                    # round trip to find out what it lost to.
                    await ws.send(json.dumps({"type": "state_conflict", "name": name,
                                              "rev": c.rev, "body": c.body}))
                    return
                except ValueError as e:
                    await ws.send(json.dumps({"type": "error", "message": f"state_put: {e}"}))
                    return
                audit("state_put", ip, device, "", f"doc={name} rev={new_rev} bytes={len(body)}")
                await ws.send(json.dumps({"type": "state_ack", "name": name, "rev": new_rev}))
                await broadcast({"type": "state",
                                 "docs": {name: {"rev": new_rev, "body": body}}},
                                except_ws=ws)
                # Half of an agent config is the relay's answer about it — its harness, whether
                # this machine holds the key variable it named, and the command line the spawn
                # will run. None of that can be computed by a browser, so the document landing is
                # what makes it stale, and every client gets the new one. The writer included:
                # it is the client most likely to be looking at the row it just changed.
                if name == "agent_configs" and PROJECTS and WRITE_EXT:
                    await broadcast(await asyncio.to_thread(start_options_message))
            else:
                # Say so instead of dropping it. A client newer than the relay used to get
                # silence here, which reads as a bug in the feature rather than a stale relay.
                log.warning("Unknown message type %r from %s (%s)", msg_type, ip, device)
                await ws.send(json.dumps({
                    "type": "error",
                    "message": f"unknown message type {msg_type!r} — the relay may be older than this client",
                }))

        # The lanes. One per pane, so two messages about one pane keep their order and two about
        # different panes do not wait for each other; one shared lane for everything that names no
        # pane, which keeps a roster's starts sequential without depending on the client to send
        # them one at a time.
        lanes = {}

        async def dispatch(msg, msg_type):
            try:
                await run_in_lane(lanes, msg.get("pane_id") or "", handle_message(msg, msg_type))
            except (ConnectionClosedError, ConnectionClosedOK):
                pass    # the client hung up while its own message was still being answered
            except Exception:
                # Inline, this closed the connection. As a task it would be swallowed instead, so
                # it is logged with its traceback and the socket is left up — one bad message is
                # not a reason to drop a client mid-session.
                log.exception("Handling %r from %s (%s) failed", msg_type, ip, device)

        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            msg_type = msg.get("type")
            # At the ceiling this stops reading the socket, which is what pushes back on a client
            # that would otherwise have the relay spawning herdr subprocesses without limit.
            if len(inflight) >= HANDLER_INFLIGHT:
                await dispatch(msg, msg_type)
                continue
            task = asyncio.create_task(dispatch(msg, msg_type))
            inflight.add(task)
            task.add_done_callback(inflight.discard)
    except (ConnectionClosedError, ConnectionClosedOK):
        pass
    finally:
        # Not cancelled: a cancelled submit_paste is a pane that was handed text and never given
        # its Enter. They finish against a closed socket, which their own handler catches, and
        # awaiting them here is also what keeps the tasks referenced until they are done.
        if inflight:
            await asyncio.gather(*inflight, return_exceptions=True)
        duration = int(time.monotonic() - connected_at)
        log.info("Client disconnected: ip=%s device=%s duration=%ds", ip, device, duration)
        clients.discard(ws)


class UDPPlugin(asyncio.DatagramProtocol):
    def datagram_received(self, data, addr):
        try:
            event_queue.put_nowait(json.loads(data.decode()))
        except Exception:
            pass


def start_mdns():
    # Only the LAN listener is advertised — a loopback port is no use to anything on the network.
    # Note this actively broadcasts an open listener when HERDR_LAN_OPEN=1: obscurity is not part
    # of the threat model, HERDR_LAN_BIND is.
    #
    # A relay bound to loopback is not on the LAN at all, so there is nothing to advertise and
    # nobody who could reach it if there were. Skipping it there also keeps the browser suite's
    # per-worker relays from all registering the same service name at once.
    if LAN_BIND in ("127.0.0.1", "::1", "localhost"):
        return None, None
    try:
        from zeroconf import Zeroconf, ServiceInfo
        import socket as sock_mod
        import threading
        ip = sock_mod.gethostbyname(sock_mod.gethostname())
        info = ServiceInfo(
            "_herdr-remote._tcp.local.", "herdr-remote._herdr-remote._tcp.local.",
            addresses=[sock_mod.inet_aton(ip)], port=WS_PORT,
        )
        zc = Zeroconf()

        def register():
            # A second relay on the same LAN takes the same service name. Without
            # allow_name_change that raises inside this thread, and the traceback lands
            # on stderr looking like a crash while the relay is in fact serving fine.
            try:
                zc.register_service(info, allow_name_change=True)
            except Exception as e:
                log.warning("mDNS registration failed: %s", e)

        threading.Thread(target=register, daemon=True).start()
        log.info("mDNS registering at %s", ip)
        return zc, info
    except Exception as e:
        log.warning("mDNS skipped: %s", e)
        return None, None


async def main():
    global arbitration, MAIN_LOOP
    zc, info = start_mdns()
    loop = asyncio.get_running_loop()
    MAIN_LOOP = loop
    if ENABLE_ARBITER:
        # Built here rather than at import: it calls back into the relay's own herdr helpers, and
        # it needs the running loop to reach them from the thread a session runs on.
        arbitration = Arbitration(CONV_LOG_DB, send=arbitration_send, panes=live_panes,
                                  log=conv_log, notify=arbitration_paused,
                                  clear=arbitration_clear,
                                  entries=arbitration_entries_of)
        # A session that was running when the relay stopped is paused, never resumed (§9.4): the
        # relay cannot promise exactly-once delivery into a terminal, and re-sending a phase's
        # instructions is worse than stopping and showing the person the last one.
        recovered = arbitration.recover()
        for session in recovered:
            log.warning("arbitration: session %s paused after a relay restart — read its last "
                        "send before resuming", session["id"])
    try:
        await loop.create_datagram_endpoint(UDPPlugin, local_addr=("127.0.0.1", 8376))
    except OSError:
        log.warning("UDP 8376 in use, plugin push disabled")
    # One poll loop and one event pump, whatever the listener count: both servers hand work to
    # the same handle_client and read the same cached state.
    asyncio.create_task(poll_loop())
    asyncio.create_task(event_push())
    if BACKUP_EVERY_H > 0:
        asyncio.create_task(backup_loop())
        log.info("state is backed up every %g h into %s", BACKUP_EVERY_H, BACKUP_DIR)

    servers = [await serve(
        functools.partial(handle_client, listener="lan"), LAN_BIND, WS_PORT,
        process_request=functools.partial(
            process_request, require_token=LAN_REQUIRES_TOKEN, serve_app=True),
    )]
    log.info("herdr-remote relay on %s:%d (WebSocket + HTTP POST) auth=%s agent-starts=%s",
             LAN_BIND, WS_PORT, "token" if LAN_REQUIRES_TOKEN else "none",
             "on" if WRITE_EXT else "off (set HERDR_ENABLE_WRITE_EXT=1)")
    if LAN_OPEN:
        log.warning("HERDR_LAN_OPEN=1: %s:%d accepts writes%s from any peer that can reach it",
                    LAN_BIND, WS_PORT, " and agent starts" if WRITE_EXT else "")

    if TERMINAL:
        log.info("HERDR_ENABLE_TERMINAL=1: shell panes are listed and readable")
    if TERMINAL and LAN_OPEN:
        # Said out loud because the combination was chosen deliberately, and the next person to
        # read this log is the one who has to know it was.
        log.warning(
            "HERDR_ENABLE_TERMINAL=1 with HERDR_LAN_OPEN=1: any device that can reach the LAN "
            "listener can send keys to a shell on this machine, with no token")

    if EXTERNAL_PORT:
        # Loopback only, always token: this is the port a tunnel is pointed at, and it must not
        # be reachable from the network on its own.
        servers.append(await serve(
            functools.partial(handle_client, listener="external"), "127.0.0.1", EXTERNAL_PORT,
            process_request=functools.partial(process_request, require_token=True),
        ))
        # agent-starts is stated on both listeners. When it is off the browser is simply not sent
        # start_options and hides the control, so the only symptom is a button that is not there —
        # which looks like a client bug rather than a relay that was never asked to allow starts.
        log.info("herdr-remote external listener on 127.0.0.1:%d auth=token agent-starts=%s",
                 EXTERNAL_PORT, "on" if WRITE_EXT else "off (set HERDR_ENABLE_WRITE_EXT=1)")
        # The relay cannot see the cloudflared config, and pointing the tunnel at the LAN port
        # would publish an unauthenticated relay to the internet. Print the line it should hold,
        # so a wrong one is visible next to the right one at every boot.
        log.info("  tunnel ingress must read: service: http://127.0.0.1:%d", EXTERNAL_PORT)

    hosts = ["local"] + REMOTES
    log.info("Polling: %s", ", ".join(hosts))
    # After the listeners, so a herdr that is slow to answer delays only this line. Local herdr
    # only: a remote host's terminal is not one this operator is sitting at.
    await asyncio.to_thread(log_tab_geometry)
    stop = loop.create_future()

    # Idempotent, because the shutdown of a foreground run is more than one signal: Ctrl-C reaches
    # every process in the group as SIGINT, and start.sh's trap then sends its own SIGTERM to the
    # relay it started. The second one used to land on a future that was already resolved, which
    # asyncio reports as `InvalidStateError: invalid state` from a callback nobody can catch — a
    # traceback on every clean exit, over a stop that had already been asked for.
    def request_stop() -> None:
        if not stop.done():
            stop.set_result(None)

    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, request_stop)
    await stop
    for server in servers:
        server.close()
    if zc and info:
        # Best effort. zeroconf gives the unregister broadcast a deadline and raises
        # EventLoopBlocked when it misses it, which on the way out turns a clean Ctrl-C into a
        # traceback and a non-zero exit for a courtesy packet nobody is waiting for.
        try:
            zc.unregister_service(info)
        except Exception as e:
            # By type when there is no message: EventLoopBlocked carries none, so the line read
            # "mDNS unregister failed: " and named nothing at all.
            log.warning("mDNS unregister failed: %s", e or type(e).__name__)
        zc.close()


if __name__ == "__main__":
    asyncio.run(main())
