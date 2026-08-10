#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["websockets>=14.0", "zeroconf>=0.80.0", "pywebpush>=2.0.0", "py-vapid>=1.9.0"]
# ///
"""herdr-remote relay — polls herdr, accepts push events (HTTP POST + WebSocket + UDP), broadcasts to clients."""
import asyncio, functools, hmac, json, logging, os, re, shutil, signal, socket, subprocess, time

from agent_state import complete_agent_update_message
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
import sys

def _get_log_dir():
    if sys.platform == "darwin":
        return os.path.expanduser("~/Library/Logs/herdr-remote")
    if os.path.isdir("/var/log") and os.access("/var/log", os.W_OK):
        return "/var/log/herdr-remote"
    return os.path.expanduser("~/.local/state/herdr-remote/log")

LOG_DIR = os.environ.get("HERDR_LOG_DIR", _get_log_dir())
os.makedirs(LOG_DIR, exist_ok=True)
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

# VAPID Web Push
VAPID_PUBLIC_KEY = os.environ.get("HERDR_VAPID_PUBLIC", "")
VAPID_PRIVATE_KEY = os.environ.get("HERDR_VAPID_PRIVATE", "")
VAPID_SUBJECT = os.environ.get("HERDR_VAPID_SUBJECT", "mailto:herdr@localhost")
push_subscriptions = []  # list of PushSubscription dicts
PUSH_SUBS_FILE = os.path.join(LOG_DIR, "push_subs.json")

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
        "ts": datetime.datetime.utcnow().isoformat() + "Z",
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


async def send_web_push(title: str, body: str, url: str = "/", clear: bool = False):
    """Send push notification to all registered subscriptions.
    
    Uses collapse topic + TTL so offline devices get only the latest.
    If clear=True, sends a clear instruction instead of showing a notification.
    """
    if not VAPID_PUBLIC_KEY or not VAPID_PRIVATE_KEY:
        return
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        log.warning("pywebpush not installed, skipping push")
        return
    if clear:
        payload = json.dumps({"type": "clear", "tag": "herdr-blocked"})
    else:
        payload = json.dumps({"title": title, "body": body, "url": url})
    headers = {"Topic": "herdr-herd", "TTL": "21600"}  # 6h TTL, collapse key
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


def run_herdr_result(*args, remote=None, timeout=15):
    if remote:
        cmd = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", remote, HERDR, *args]
    else:
        cmd = [HERDR, *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def run_herdr(*args, remote=None):
    try:
        return run_herdr_result(*args, remote=remote).stdout.strip()
    except Exception:
        return ""


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
    breaks left in, so the longest line in it *is* the column those breaks were made at. Sampled
    over exactly the lines being sent, not deeper: a pane that has been made narrower still holds
    wider lines further back, and reporting one of those would lay the text out too wide. Read
    per request, never cached — splitting or resizing a pane changes it.
    """
    raw = run_herdr("pane", "read", pane_id, "--lines", str(lines),
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


def detect_options(text):
    lower = text.lower()
    if "yes, single permission" in lower:
        return TOOL_OPTIONS
    if "approve all pending" in lower:
        return SUBAGENT_OPTIONS
    return None


async def broadcast(msg):
    data = json.dumps(msg)
    dead = set()
    for ws in list(clients):
        try:
            await ws.send(data)
        except (ConnectionClosedError, ConnectionClosedOK):
            dead.add(ws)
        except Exception:
            dead.add(ws)
    if dead:
        log.debug("Removed %d dead client(s)", len(dead))
    clients.difference_update(dead)


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

    data, err = _herdr_json(*agent_start_args(plan["name"], plan["agent_name"], target_pane),
                            remote=remote, timeout=START_EXEC_TIMEOUT)
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
        agents, shells = get_all_panes()
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
        for a in agents:
            agent_cache[a["pane_id"]] = a
        await broadcast(snapshot_message())
        for a in agents:
            pid, status = a["pane_id"], a["status"]
            if status == "blocked" and last_statuses.get(pid) != "blocked":
                content = read_pane(pid, remote=a.get("remote"))
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
                    title=f"🐑 {a['project']} blocked",
                    body=content[:120],
                    url=f"/?pane={pid}",
                )
            # Send clear push when agent unblocks
            if status != "blocked" and last_statuses.get(pid) == "blocked":
                await send_web_push("", "", clear=True)
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
        agent_data = update["agent"] if update else event
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


async def process_request(connection, request, require_token=True):
    """Handle HTTP POST on the same port as WebSocket.

    `require_token` comes from the listener that accepted this connection, not from a global.
    It gates the whole HTTP surface — the WebSocket upgrade, GET / serving the web app, and the
    event-push endpoint below — because they all arrive through here.
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

    # Serve web app for GET / or GET /index.html
    path = (request.path or "/").split("?")[0]
    if path in ("/", "/index.html"):
        web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
        index_path = os.path.join(web_dir, "index.html")
        if os.path.isfile(index_path):
            with open(index_path, "rb") as f:
                body = f.read()
            headers = Headers([
                ("Content-Type", "text/html; charset=utf-8"),
                ("Cache-Control", "no-cache"),
            ])
            return Response(200, "OK", headers, body)

    # Serve service worker
    if path == "/sw.js":
        web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
        sw_path = os.path.join(web_dir, "sw.js")
        if os.path.isfile(sw_path):
            with open(sw_path, "rb") as f:
                body = f.read()
            headers = Headers([
                ("Content-Type", "application/javascript"),
                ("Cache-Control", "no-cache"),
                ("Service-Worker-Allowed", "/"),
            ])
            return Response(200, "OK", headers, body)

    # Serve VAPID public key
    if path == "/api/vapid-public-key":
        body = json.dumps({"publicKey": VAPID_PUBLIC_KEY}).encode()
        headers = Headers([
            ("Content-Type", "application/json"),
            ("Access-Control-Allow-Origin", "*"),
        ])
        return Response(200, "OK", headers, body)

    # Serve logo.svg
    if path == "/logo.svg":
        web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
        svg_path = os.path.join(web_dir, "logo.svg")
        if os.path.isfile(svg_path):
            with open(svg_path, "rb") as f:
                body = f.read()
            headers = Headers([("Content-Type", "image/svg+xml")])
            return Response(200, "OK", headers, body)

    # Fallback for unmatched paths
    headers = Headers([("Access-Control-Allow-Origin", "*")])
    return Response(404, "Not Found", headers, b"not found\n")


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
                log.info("Response from %s (%s): pane=%s text=%r", ip, device, pane_id, text)
                audit("respond", ip, device, pane_id, f"text={text!r}")
                # Not text + "\n": herdr sends a bracketed paste, so a trailing newline is
                # inserted as literal text and the approval never submits. Paste, let the TUI
                # settle, then press Enter.
                run_herdr("pane", "send-text", pane_id, text, remote=remote)
                await asyncio.sleep(SEND_SETTLE)
                run_herdr("pane", "send-keys", pane_id, "Enter", remote=remote)
            elif msg_type == "agent_event":
                event_queue.put_nowait(msg)
            elif msg_type == "read_pane":
                pane_id = msg["pane_id"]
                pane_err = pane_guard(pane_id)
                if pane_err:
                    await ws.send(json.dumps({"type": "error", "message": pane_err}))
                    continue
                lines = msg.get("lines", "30")
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
                content = run_herdr("pane", "read", pane_id, "--lines", str(lines),
                                    "--source", source, remote=remote)
                await ws.send(json.dumps({
                    "type": "pane_content", "pane_id": pane_id, "content": content,
                    "source": source, "cols": pane_cols(pane_id, lines, remote=remote)}))
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
                    result = run_herdr_result("pane", "send-keys", pane_id, *keys, remote=remote)
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
                # 4000, not 1000: a transferred selection is usually code or a diff (P3 spec §6).
                # The bound stays — an unbounded write is a real abuse vector.
                if not text or len(text) > 4000:
                    await ws.send(json.dumps({"type": "error", "message": "text empty or too long"}))
                    continue
                remote = pane_remote_map.get(pane_id)
                log.info("Text from %s (%s): pane=%s text=%r", ip, device, pane_id, text)
                audit("send_text", ip, device, pane_id, f"text={text!r}")
                run_herdr("pane", "send-text", pane_id, text, remote=remote)
                # Hold the handler until the pane has settled, so a send_keys ["Enter"] arriving
                # right behind this — which is exactly what every composer does — lands late
                # enough to submit. One choke point, rather than a delay in each client.
                await asyncio.sleep(SEND_SETTLE)
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
                    result = run_herdr_result(*pane_rename_args(pane_id, label), remote=remote)
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
                run_herdr("tab", "create", "--workspace", workspace_id, "--focus", remote=remote)
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
        process_request=functools.partial(process_request, require_token=LAN_REQUIRES_TOKEN),
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
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set_result, None)
    await stop
    for server in servers:
        server.close()
    if zc and info:
        zc.unregister_service(info)
        zc.close()


if __name__ == "__main__":
    asyncio.run(main())
