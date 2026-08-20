#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=14.0", "zeroconf>=0.80.0", "pywebpush>=2.0.0", "py-vapid>=1.9.0"]
# ///
"""herdr-remote relay — polls herdr, accepts push events (HTTP POST + WebSocket + UDP), broadcasts to clients."""
import asyncio, functools, hmac, json, logging, os, re, shlex, shutil, signal, socket, sqlite3, subprocess, sys, tempfile, time

from agent_state import complete_agent_update_message
import git_probe
from conversation_log import ConversationLog
from conv_query import (QUERY_ROWS_DEFAULT as CONV_LOG_ROWS_DEFAULT, as_wire as conv_as_wire,
                        fingerprints_from as conv_fingerprints)
from pane_summary import ends_turn, summary_body
from user_state import UserState, Conflict as StateConflict, DOC_NAMES as STATE_DOCS
from projects import (
    ProjectConfigError,
    ambiguous_pane_ids,
    annotate_agents,
    load_projects,
    public_projects,
    resolve_workspace_remote,
)
from start_agent import (
    AGENT_START_TIMEOUT_MS,
    ROLES,
    SPACER_LABEL,
    StartAgentConfigError,
    agent_name_from_label,
    agent_start_args,
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
    tab_create_args,
    validate_open_terminal,
    validate_start_request,
    workspace_create_args,
)

try:
    from websockets.asyncio.server import serve
except ImportError:
    from websockets.server import serve
from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK

from logging.handlers import RotatingFileHandler

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
LOG_DIR = os.path.expanduser("~/Library/Logs/herdr-remote")
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
SUBMIT_TOOK = ("working", "blocked")  # it is acting on what it was handed — never press Enter now
SUBMIT_TRIES = 4                    # Enter presses, at most, however long the wait runs
SUBMIT_POLL = 0.4                   # between a press and looking to see whether it took
SUBMIT_TIMEOUT = 8.0                # total, and generous: an agent's first boot is seconds, not ms

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
CONV_LOG_DB = os.environ.get("HERDR_ARBITER_DB") or os.path.join(
    PROJECT_ROOT, ".herdr-remote", "arbitration.sqlite3")
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
STATE_DB = os.environ.get("HERDR_STATE_DB") or os.path.join(
    PROJECT_ROOT, ".herdr-remote", "state.sqlite3")
user_state = None
try:
    user_state = UserState(STATE_DB)
except (sqlite3.Error, OSError) as e:
    # Same posture as the record above: a relay that will not start because a file is unwritable is
    # a worse failure than one that says so and leaves every browser on its own state.
    print(f"herdr-remote: shared state disabled: {e}", file=sys.stderr)

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

# Configured Projects: read once at startup, fail closed. Unset means Projects are disabled.
try:
    PROJECTS = load_projects(os.environ.get("HERDR_PROJECTS_FILE", ""), valid_hosts=REMOTES)
except ProjectConfigError as e:
    print(f"herdr-remote: bad Projects config: {e}", file=sys.stderr)
    sys.exit(1)

# Write extensions (P2 start_agent) spawn processes on this machine and on any configured
# SSH target, so an unauthenticated listener that reaches them is process spawn granted to the
# network. Still fail-closed, but the rule is now per listener rather than global.
WRITE_EXT = os.environ.get("HERDR_ENABLE_WRITE_EXT", "") == "1"

# Not folded into HERDR_ENABLE_WRITE_EXT: that gate exists for starting agents, and someone who
# enabled it to spawn a session from a phone did not thereby consent to a shell. Off means the
# shells are never parsed, so known_panes does not grow and pane_guard behaves exactly as before.
TERMINAL = os.environ.get("HERDR_ENABLE_TERMINAL", "") == "1"

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

TOOL_OPTIONS = ["yes, single permission", "trust, always allow", "no (tab to edit)"]
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
latest_agents = []  # last full snapshot, replayed to each client on connect
latest_shells = []  # shell panes from the same snapshot; empty and unused when TERMINAL is off
shell_panes = set()  # pane IDs in latest_shells, for the respond refusal in handle_client

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
    headers = {"Topic": tag, "TTL": "21600"}  # 6h TTL, collapse key
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
            log.warning("Push failed for sub %d: %s", i, e)
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
PANE_READY_POLL = 1.0


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


def snapshot_message():
    """The full-state broadcast. `shells` is present whenever terminal mode is on, including as an
    empty list — its presence is the client's feature gate, as start_options is for Start."""
    msg = {"type": "agents", "agents": latest_agents}
    if TERMINAL:
        msg["shells"] = latest_shells
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
CAPTURE_LINES = 200
CAPTURE_SOURCE = "recent-unwrapped"


def read_pane_for_record(pane_id, remote=None):
    return run_herdr("pane", "read", pane_id, "--lines", str(CAPTURE_LINES),
                     "--source", CAPTURE_SOURCE, remote=remote)


def detect_options(text):
    lower = text.lower()
    if "yes, single permission" in lower:
        return TOOL_OPTIONS
    if "approve all pending" in lower:
        return SUBAGENT_OPTIONS
    return None


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
    """
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


def pane_guard(pane_id):
    """Return an error string if this pane may not be addressed, else None.

    Bare pane IDs are per-server counters, so the same ID on two hosts routes to
    whichever was polled last. Refuse rather than guess (D6); clears within one poll.
    """
    if pane_id not in known_panes:
        return "unknown pane_id"
    if pane_id in ambiguous_panes:
        return "ambiguous pane_id (same id on multiple hosts)"
    return None


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
    matters, an agent that has not finished starting — and an empty string, for a pane herdr did not
    list at all or a call that failed. Neither is in SUBMIT_READY or SUBMIT_TOOK, so both wait.
    """
    data, err = _herdr_json("pane", "list", remote=remote)
    if err:
        return ""
    for p in dig_panes(data):
        if p.get("pane_id") == pane_id:
            return p.get("agent_status") or ""
    return ""


async def submit_paste(pane_id, text, remote=None):
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
    """
    await asyncio.to_thread(run_herdr, "pane", "send-text", pane_id, text, remote=remote)
    await asyncio.sleep(submit_settle(text))
    deadline = time.monotonic() + SUBMIT_TIMEOUT
    presses, first = 0, True
    while time.monotonic() < deadline:
        status = await asyncio.to_thread(pane_agent_status, pane_id, remote=remote)
        # Already busy when the paste landed, which only the first look can tell apart from busy
        # *because* of it. Press once and say nothing was proven — `working` is what this pane will
        # keep reporting either way.
        if first and status == "working":
            await asyncio.to_thread(run_herdr, "pane", "send-keys", pane_id, "Enter", remote=remote)
            return False
        first = False
        if status in SUBMIT_TOOK:
            return True
        if status in SUBMIT_READY:
            if presses >= SUBMIT_TRIES:
                break
            await asyncio.to_thread(run_herdr, "pane", "send-keys", pane_id, "Enter", remote=remote)
            presses += 1
        # Anything else is a pane herdr has no status for — `unknown` from a real pane list, or an
        # empty string from a pane it did not list — which is a TUI still starting. Wait for it
        # rather than pressing into a terminal that is not listening yet.
        await asyncio.sleep(SUBMIT_POLL)
    # Out of presses or out of time, and the pane never moved. Said plainly in the log: the text is
    # in the composer and a person has to press Enter. Silence here is what made this bug take
    # three attempts to find.
    log.warning("submit: pane=%s never left %s after %d Enter press(es) — text may be unsent",
                pane_id, SUBMIT_READY, presses)
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


def _create_target_pane(plan, remote):
    """Create the pane a validated plan asks for. Returns (pane_id, rollback, error).

    herdr attaches an agent to a pane already sitting at its shell prompt, so the relay creates
    that pane itself — which is also, with nothing attached afterwards, the whole of opening a
    terminal. A new workspace or tab is born holding exactly one pane, so there is no idle shell
    left over to close. `rollback` is what to undo if the caller's next step fails.
    """
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

    args = agent_start_args(plan["name"], plan["agent_name"], target_pane)
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

    # Width last, and never fatal. The session is up and usable at whatever width the placement
    # gave it; failing the start here would roll back a working agent over a layout preference.
    if plan.get("slot"):
        slot_err = slot_exec(pane_id, plan["slot"], remote)
        if slot_err:
            log.warning("Agent started as %s but slot %r was not applied: %s",
                        pane_id, plan["slot"], slot_err)
    return pane_id, None


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
    return target_pane, None


async def _poll_once():
        global latest_agents, latest_shells
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
        for a in agents:
            agent_cache[a["pane_id"]] = a
            # Where this pane's work is landing, carried on the snapshot so the app can say so
            # without a thread being open. herdr does not report it and this relay does not ask
            # git for it here — it is whatever the last probe of that directory saw.
            branch = pane_branch.get(branch_key(a))
            if branch:
                a["branch"] = branch
        await broadcast(snapshot_message())
        for a in agents:
            pid, status = a["pane_id"], a["status"]
            was = last_statuses.get(pid)
            content = None
            if status == "blocked" and was != "blocked":
                content = await asyncio.to_thread(read_pane, pid, remote=a.get("remote"))
                options = detect_options(content)
                await broadcast({
                    "type": "blocked", "pane_id": pid,
                    "agent": a["agent"], "project": a["project"],
                    "host": a.get("host", "local"),
                    "prompt": content[:500],
                    "options": options or TOOL_OPTIONS
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
                try:
                    captured = await asyncio.to_thread(
                        read_pane_for_record, pid, remote=a.get("remote"))
                    git = await probe_git(a)
                    await asyncio.to_thread(
                        conv_log.record_turn_end, a, captured, was, status, git=git)
                except (sqlite3.Error, OSError) as e:
                    log.warning("conversation log write failed for %s: %s", pid, e)
            last_statuses[pid] = status
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
            options = detect_options(content)
            await broadcast({
                "type": "blocked", "pane_id": pane_id,
                "agent": agent_data.get("agent", ""),
                "project": agent_data.get("project", ""),
                "host": host,
                "prompt": content[:500],
                "options": options or TOOL_OPTIONS
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
    clients.add(ws)
    connected_at = time.monotonic()
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
            if WRITE_EXT:
                # `terminal` gates + New terminal the same way this message gates Start. It is
                # only ever sent under WRITE_EXT, so a true here means both of open_terminal's
                # gates are open — the client never has to reason about them separately.
                await ws.send(json.dumps({
                    "type": "start_options", "agents": START_AGENTS, "roles": list(ROLES),
                    "terminal": TERMINAL,
                }))
        # The cached snapshot is what carries `shells`, and its presence is the client's terminal
        # feature gate — so a terminal-mode relay sends it even without Projects, or a client
        # connecting between polls would see no terminals and no gate. With both off this is the
        # legacy wire unchanged: nothing until the first poll broadcast.
        if PROJECTS or TERMINAL:
            await ws.send(json.dumps(snapshot_message()))
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            msg_type = msg.get("type")
            if msg_type == "respond":
                pane_id = msg["pane_id"]
                pane_err = pane_guard(pane_id)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    continue
                # Permanent, not a phase gate: SAFE_RESPONSES is a list of agent approval strings,
                # and sending "yes, single permission" to a shell is meaningless at best.
                if pane_id in shell_panes:
                    await ws.send(json.dumps({
                        "type": "error", "message": "respond is not available on a terminal pane"}))
                    continue
                text = msg.get("text", "")
                if text.strip().lower() not in SAFE_RESPONSES:
                    await ws.send(json.dumps({"type": "error", "message": "response not in allowlist"}))
                    continue
                remote = pane_remote_map.get(pane_id)
                # The allowlist name, not free text: a response is one of SAFE_RESPONSES by the
                # check above, so this says everything the console needs without echoing input.
                log.info("Response from %s (%s): pane=%s", ip, device, pane_id)
                audit("respond", ip, device, pane_id, f"text={text!r}")
                # Not text + "\n": herdr sends a bracketed paste, so a trailing newline is
                # inserted as literal text and the approval never submits. Paste, let the TUI
                # settle, then press Enter.
                await asyncio.to_thread(run_herdr, "pane", "send-text", pane_id, text, remote=remote)
                await asyncio.sleep(SEND_SETTLE)
                await asyncio.to_thread(run_herdr, "pane", "send-keys", pane_id, "Enter", remote=remote)
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
                    continue
                try:
                    cwd, remote, first, last = git_range_target(msg)
                except ValueError as e:
                    await ws.send(json.dumps({"type": "error", "message": f"git_commits: {e}"}))
                    continue
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
                    continue
                try:
                    # Off the event loop: resolving a commit is a subprocess, and an ssh round trip
                    # for a directory on another host.
                    since, until = await asyncio.to_thread(conv_log_window, msg)
                    rows, truncated = await asyncio.to_thread(
                        conv_log.query,
                        pane=msg.get("pane"), host=msg.get("host"), agent=msg.get("agent"),
                        cwd=msg.get("cwd"), kind=msg.get("kind"), grep=msg.get("grep"),
                        since=since, until=until,
                        since_id=msg.get("since_id"),
                        fingerprints=conv_fingerprints(msg.get("fingerprints")),
                        last=msg.get("last") or CONV_LOG_ROWS_DEFAULT)
                except (sqlite3.Error, OSError, ValueError, TypeError) as e:
                    await ws.send(json.dumps({"type": "error", "message": f"conv_log: {e}"}))
                    continue
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
                await ws.send(json.dumps(out_msg))
            elif msg_type == "read_pane":
                pane_id = msg["pane_id"]
                pane_err = pane_guard(pane_id)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    continue
                lines = read_pane_lines(msg.get("lines"))
                remote = pane_remote_map.get(pane_id)
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
                pane_id = msg["pane_id"]
                pane_err = pane_guard(pane_id)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    continue
                keys = msg.get("keys", [])
                if not all(k in SAFE_KEYS for k in keys):
                    await ws.send(json.dumps({"type": "error", "message": "keys contain disallowed values"}))
                    continue
                remote = pane_remote_map.get(pane_id)
                log.info("Keys from %s (%s): pane=%s keys=%s", ip, device, pane_id, keys)
                audit("send_keys", ip, device, pane_id, f"keys={keys}")
                try:
                    result = await asyncio.to_thread(
                        run_herdr_result, "pane", "send-keys", pane_id, *keys, remote=remote)
                except Exception as e:
                    log.warning("send_keys command failed for pane %s: %s", pane_id, e)
                    await ws.send(json.dumps({"type": "error", "message": "send_keys command failed"}))
                    continue
                if result.returncode != 0:
                    log.warning("send_keys command failed for pane %s with exit %s", pane_id, result.returncode)
                    await ws.send(json.dumps({"type": "error", "message": "send_keys command failed"}))
                    continue
                await ws.send(json.dumps({"type": "command_result", "command": "send_keys", "ok": True}))
            elif msg_type == "send_text":
                pane_id = msg["pane_id"]
                pane_err = pane_guard(pane_id)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    continue
                text = msg.get("text", "")
                # The bound stays — an unbounded write is a real abuse vector.
                if not text or len(text) > SEND_TEXT_MAX:
                    await ws.send(json.dumps({"type": "error", "message": "text empty or too long"}))
                    continue
                remote = pane_remote_map.get(pane_id)
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
                # Length, not the text: this line goes to the console the relay was started from,
                # and a person watching their own terminal has not asked to be shown every message
                # they send from their phone. The audit log below keeps the text itself.
                log.info("Text from %s (%s): pane=%s submit=%s chars=%d",
                         ip, device, pane_id, submit, len(text))
                audit("send_text", ip, device, pane_id, f"submit={submit} text={text!r}")
                if submit:
                    await submit_paste(pane_id, text, remote=remote)
                else:
                    await asyncio.to_thread(run_herdr, "pane", "send-text", pane_id, text,
                                            remote=remote)
                    # Hold the handler until the pane has settled, so a `send_keys ["Enter"]`
                    # arriving right behind this — which is what a client that submits for itself
                    # does — lands late enough. One choke point, rather than a delay in each client.
                    await asyncio.sleep(SEND_SETTLE)
                await record_sent(pane_id, text)
            elif msg_type == "rename_pane":
                # Not behind HERDR_ENABLE_WRITE_EXT: that gate exists for spawning processes.
                # Relabelling an existing pane is strictly weaker than send_text and send_keys,
                # which are already open, so gating it here and not those would be theatre.
                pane_id = msg["pane_id"]
                pane_err = pane_guard(pane_id)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    continue
                label, label_err = validate_pane_label(msg.get("label", ""))
                if label_err:
                    await ws.send(json.dumps({"type": "error", "message": label_err}))
                    continue
                remote = pane_remote_map.get(pane_id)
                audit("rename_pane", ip, device, pane_id, f"label={label!r}")
                try:
                    result = await asyncio.to_thread(
                        run_herdr_result, *pane_rename_args(pane_id, label), remote=remote)
                except Exception as e:
                    log.warning("rename failed for pane %s: %s", pane_id, e)
                    await ws.send(json.dumps({"type": "error", "message": "rename failed"}))
                    continue
                if result.returncode != 0:
                    log.warning("rename failed for pane %s with exit %s", pane_id, result.returncode)
                    await ws.send(json.dumps({"type": "error", "message": "rename failed"}))
                    continue
                await ws.send(json.dumps({"type": "command_result", "command": "rename_pane",
                                          "ok": True, "pane_id": pane_id, "label": label}))
            elif msg_type == "set_slot":
                # Behind the same gate as start_agent, unlike rename_pane: a narrow slot is made
                # by splitting, and a split starts a shell. That is process creation on this
                # machine, which is precisely what HERDR_ENABLE_WRITE_EXT governs.
                if not WRITE_EXT:
                    await ws.send(json.dumps({"type": "command_result", "command": "set_slot",
                                              "ok": False, "error": "write extensions disabled"}))
                    continue
                pane_id = msg.get("pane_id", "")
                pane_err = pane_guard(pane_id)
                if pane_err:
                    await ws.send(json.dumps({"type": "command_result", "command": "set_slot",
                                              "ok": False, "error": pane_err}))
                    continue
                slot = msg.get("slot")
                remote = pane_remote_map.get(pane_id)
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
                    continue
                # workspace_id is its own ID space and collides like pane_id does, so it
                # gets its own guard — the pane ambiguity set says nothing about it (D6).
                remote, ws_err = resolve_workspace_remote(latest_agents, workspace_id)
                if ws_err:
                    await ws.send(json.dumps({"type": "error", "message": ws_err}))
                    continue
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
                    continue
                plan, start_err = validate_start_request(msg, PROJECTS, latest_agents, START_AGENTS)
                if start_err:
                    await ws.send(json.dumps({"type": "command_result", "command": "start_agent",
                                              "ok": False, "error": start_err}))
                    continue
                detail = (f"name={plan['name']} role={plan['role']} project={plan['project_id']} "
                          f"placement={plan['placement']} host={plan['remote'] or 'local'}")
                log.info("Start agent from %s (%s): %s", ip, device, detail)
                audit("start_agent", ip, device, "", detail)
                # Several herdr calls, one of them waiting out the agent's startup — off the loop.
                pane_id, exec_err = await asyncio.to_thread(start_agent_exec, plan)
                if exec_err:
                    log.warning("Start agent failed (%s): %s", detail, exec_err)
                    await ws.send(json.dumps({"type": "command_result", "command": "start_agent",
                                              "ok": False, "error": exec_err}))
                    continue
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
                    continue
                if not WRITE_EXT:
                    await ws.send(json.dumps({"type": "command_result", "command": "open_terminal",
                                              "ok": False, "error": "write extensions disabled"}))
                    continue
                plan, open_err = validate_open_terminal(
                    msg, PROJECTS, latest_agents + latest_shells)
                if open_err:
                    await ws.send(json.dumps({"type": "command_result", "command": "open_terminal",
                                              "ok": False, "error": open_err}))
                    continue
                detail = (f"project={plan['project_id']} placement={plan['placement']} "
                          f"host={plan['remote'] or 'local'} label={plan['label']!r}")
                log.info("Open terminal from %s (%s): %s", ip, device, detail)
                audit("open_terminal", ip, device, "", detail)
                pane_id, exec_err = await asyncio.to_thread(open_terminal_exec, plan)
                if exec_err:
                    log.warning("Open terminal failed (%s): %s", detail, exec_err)
                    await ws.send(json.dumps({"type": "command_result", "command": "open_terminal",
                                              "ok": False, "error": exec_err}))
                    continue
                log.info("Open terminal ok: pane=%s label=%r", pane_id, plan["label"])
                await ws.send(json.dumps({"type": "command_result", "command": "open_terminal",
                                          "ok": True, "pane_id": pane_id, "label": plan["label"]}))
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
                    continue
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
                    continue
                name, body = msg.get("name", ""), msg.get("body")
                try:
                    new_rev = await asyncio.to_thread(
                        user_state.put, name, msg.get("rev"), body)
                except StateConflict as c:
                    # The current document rides along, so the loser of the race needs no second
                    # round trip to find out what it lost to.
                    await ws.send(json.dumps({"type": "state_conflict", "name": name,
                                              "rev": c.rev, "body": c.body}))
                    continue
                except ValueError as e:
                    await ws.send(json.dumps({"type": "error", "message": f"state_put: {e}"}))
                    continue
                audit("state_put", ip, device, "", f"doc={name} rev={new_rev} bytes={len(body)}")
                await ws.send(json.dumps({"type": "state_ack", "name": name, "rev": new_rev}))
                await broadcast({"type": "state",
                                 "docs": {name: {"rev": new_rev, "body": body}}},
                                except_ws=ws)
            else:
                # Say so instead of dropping it. A client newer than the relay used to get
                # silence here, which reads as a bug in the feature rather than a stale relay.
                log.warning("Unknown message type %r from %s (%s)", msg_type, ip, device)
                await ws.send(json.dumps({
                    "type": "error",
                    "message": f"unknown message type {msg_type!r} — the relay may be older than this client",
                }))
    except (ConnectionClosedError, ConnectionClosedOK):
        pass
    finally:
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
    zc, info = start_mdns()
    loop = asyncio.get_running_loop()
    try:
        await loop.create_datagram_endpoint(UDPPlugin, local_addr=("127.0.0.1", 8376))
    except OSError:
        log.warning("UDP 8376 in use, plugin push disabled")
    # One poll loop and one event pump, whatever the listener count: both servers hand work to
    # the same handle_client and read the same cached state.
    asyncio.create_task(poll_loop())
    asyncio.create_task(event_push())

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
