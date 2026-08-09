#!/usr/bin/env python3
"""Start session: validate a start_agent request and build its herdr command arguments.

Pure module — no I/O, no subprocess, no relay state. Everything that decides *whether* a
start is allowed lives here so it is testable without herdr.
See .workflow/03_specs/2026-08-08_start_agent_spec.md
"""
import random
import re

from projects import ambiguous_pane_ids, resolve_workspace_remote

ROLES = ("architect", "reviewer", "agent")
# Collision suffix: "-XBEOE". Random rather than a counter because the taken set is a snapshot —
# two starts inside one poll interval both read it before either lands. I and O are out so a
# name read off a phone screen is not retyped as 1 or 0.
SUFFIX_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
SUFFIX_LEN = 5
# herdr's own rule for an agent name, enforced before it even looks at the pane:
# "must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_'".
# Pane labels are not bound by this — "Architect 1" is a fine label and an illegal agent name.
HERDR_AGENT_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
DEFAULT_START_AGENTS = ["codex", "claude", "pi"]
AGENT_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
# herdr waits this long for the agent to reach interactive readiness. Explicit rather than
# left to herdr's 30s default because the relay's own subprocess timeout must exceed it —
# see START_EXEC_TIMEOUT in herdr_relay.py.
AGENT_START_TIMEOUT_MS = 30_000

PLACEMENTS = {
    "new_workspace": None,
    "new_tab": "workspace_id",
    "split": "split_from",
}
BASE_FIELDS = {"type", "name", "role", "project_id", "placement", "label"}


class StartAgentConfigError(Exception):
    """Raised for a malformed HERDR_START_AGENTS. The relay exits non-zero on this."""


def load_start_agents(raw):
    """Parse HERDR_START_AGENTS into an ordered allowlist. Unset yields the default set.

    This allowlist is the boundary on *what* can be executed: the names are herdr agent
    kinds, passed to `agent start --kind`. herdr owns the kind enum and refuses an unknown
    one with its own message, so mirroring that enum here would only rot on each release.
    """
    if not raw or not raw.strip():
        return list(DEFAULT_START_AGENTS)
    names = []
    for part in raw.split(","):
        name = part.strip()
        if not name:
            continue
        if not AGENT_NAME_RE.match(name):
            raise StartAgentConfigError(
                f"HERDR_START_AGENTS: {name!r} must match ^[a-z0-9_-]{{1,32}}$"
            )
        if name not in names:
            names.append(name)
    if not names:
        raise StartAgentConfigError("HERDR_START_AGENTS is set but lists no agents")
    return names


def next_role_label(role, project_id, agents):
    """Return "Architect 1" — lowest unused N among live same-Project labels for this role.

    Cosmetic only. Parsing labels means two starts inside one poll interval can pick the
    same N, and a pane the user renames leaves the sequence; neither matters because no
    part of the protocol resolves a session by its label (spec §2).
    """
    prefix = role.capitalize()
    pattern = re.compile(rf"^{re.escape(prefix)} (\d+)$")
    used = set()
    for a in agents:
        if a.get("project_id") != project_id:
            continue
        m = pattern.match(a.get("label", "") or "")
        if m:
            used.add(int(m.group(1)))
    n = 1
    while n in used:
        n += 1
    return f"{prefix} {n}"


def agent_name_from_label(label, fallback):
    """Slug a pane label into a name herdr will accept as an agent name.

    The label is what a human reads off the pane — "Architect 1", "Backend". herdr's agent
    names are a separate, stricter namespace (HERDR_AGENT_NAME_RE), so the two cannot be the
    same string any more; every label carrying a space or a capital would be refused outright.
    `fallback` is the agent kind, used when a label slugs away to nothing (e.g. "___").
    """
    slug = re.sub(r"[^a-z0-9_-]+", "-", label.lower()).strip("-_")
    slug = re.sub(r"-{2,}", "-", slug).lstrip("0123456789-_")
    return (slug or fallback)[:32].rstrip("-_") or fallback


def unique_agent_name(desired, taken):
    """Return `desired`, or a suffixed variant, so a start never hits agent_name_taken.

    A herdr agent name is unique per host and `pane list` does not report it, so a name the
    relay derives from live *pane labels* can collide with an agent name that no longer matches
    its label — a user rename moves the label and leaves the name behind. The result is bounded
    to 32 characters and stays inside HERDR_AGENT_NAME_RE.
    """
    if desired not in taken:
        return desired
    base = desired[:32 - SUFFIX_LEN - 1].rstrip("-_")
    while True:
        candidate = f"{base}-{''.join(random.choices(SUFFIX_ALPHABET, k=SUFFIX_LEN))}"
        if candidate not in taken:
            return candidate


def _project_remote(project):
    """herdr's remote= convention: None for local, otherwise the SSH target."""
    return None if project["host"] == "local" else project["host"]


def validate_start_request(msg, projects, agents, allowed):
    """Validate a start_agent message. Returns (plan, error); exactly one is not None.

    The client supplies only name, role, project_id, placement, and one placement field.
    cwd and host come from the configured Project — never from the wire (D4).
    """
    name = msg.get("name")
    if name not in allowed:
        return None, "agent not in allowlist"

    role = msg.get("role")
    if role not in ROLES:
        return None, "unknown role"

    project_id = msg.get("project_id")
    project = next((p for p in projects if p["id"] == project_id), None)
    if project is None:
        return None, "unknown project_id"

    placement = msg.get("placement")
    if placement not in PLACEMENTS:
        return None, "unknown placement"

    required = PLACEMENTS[placement]
    extra = set(msg) - BASE_FIELDS - ({required} if required else set())
    if extra:
        return None, f"unexpected field(s) for {placement}: {', '.join(sorted(extra))}"
    if required and not msg.get(required):
        return None, f"{required} required for {placement}"

    # The one free-text field a start may carry. Absent means "name it for me"; present it
    # becomes both the pane label and the herdr agent name, so it is bounded like any other
    # client-supplied argv element rather than trusted.
    if "label" in msg:
        label, label_err = validate_pane_label(msg["label"])
        if label_err:
            return None, label_err
    else:
        label = next_role_label(role, project["id"], agents)

    remote = _project_remote(project)
    plan = {
        "name": name,
        "role": role,
        "project_id": project["id"],
        "project_label": project["label"],
        "cwd": project["cwd"],
        "remote": remote,
        "placement": placement,
        "label": label,
    }

    if placement == "new_tab":
        workspace_id = msg["workspace_id"]
        # workspace_id is its own ID space: one distinct *host*, not one matching agent (D6).
        ws_remote, err = resolve_workspace_remote(agents, workspace_id)
        if err:
            return None, err
        if ws_remote != remote:
            return None, "workspace is not on this project's host"
        in_project = [
            a for a in agents
            if a.get("workspace_id") == workspace_id and a.get("project_id") == project["id"]
        ]
        if not in_project:
            return None, "workspace does not belong to this project"
        plan["workspace_id"] = workspace_id

    elif placement == "split":
        split_from = msg["split_from"]
        # pane_id collides independently of workspace_id, so this is the *pane* guard.
        matches = [a for a in agents if a.get("pane_id") == split_from]
        if not matches:
            return None, "unknown pane_id"
        if split_from in ambiguous_pane_ids(agents):
            return None, "ambiguous pane_id (same id on multiple hosts)"
        source = matches[0]
        if source.get("remote") != remote:
            return None, "pane is not on this project's host"
        if source.get("project_id") != project["id"]:
            return None, "pane does not belong to this project"
        plan["split_from"] = split_from

    return plan, None


def workspace_create_args(cwd, label):
    return ("workspace", "create", "--cwd", cwd, "--label", label, "--focus")


def tab_create_args(workspace_id, cwd, label):
    return ("tab", "create", "--workspace", workspace_id, "--cwd", cwd,
            "--label", label, "--focus")


def pane_split_args(pane_id, cwd):
    """Split an existing pane to the right, landing a shell at the Project's cwd.

    herdr attaches an agent to a pane that already exists, so the relay creates the pane
    itself instead of asking `agent start` to split one.
    """
    return ("pane", "split", pane_id, "--direction", "right", "--cwd", cwd, "--focus")


def agent_start_args(kind, label, pane_id, timeout_ms=AGENT_START_TIMEOUT_MS):
    """herdr attaches an agent to an existing pane sitting at its shell prompt.

    The positional is herdr's *agent name*, which is unique per host — passing the agent kind
    there let the first start of an agent succeed and every later one fail agent_name_taken.
    The session label goes there instead; `kind` is the allowlisted herdr agent kind.

    pane_id is always a pane the relay just created or one that passed
    validate_start_request — never a raw client value.
    """
    return ("agent", "start", label, "--kind", kind, "--pane", pane_id,
            "--timeout", str(timeout_ms))


def pane_rename_args(pane_id, label):
    return ("pane", "rename", pane_id, label)


def validate_pane_label(raw):
    """Return (label, error) for a client-supplied pane label.

    The label is the one piece of free text a client may put on a pane, so it is bounded here
    rather than trusted: control characters would corrupt the herdr status line and the pane
    list, and an unbounded string is an unbounded argv entry.
    """
    if not isinstance(raw, str):
        return "", "label must be a string"
    label = raw.strip()
    if not label:
        return "", "label is empty"
    if len(label) > 32:
        return "", "label is longer than 32 characters"
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in label):
        return "", "label contains control characters"
    # A start passes the label to herdr as a positional, so a leading dash would be read as a flag.
    if label.startswith("-"):
        return "", "label cannot start with '-'"
    return label, ""


def dig(data, *path):
    """Read a nested JSON path, returning "" if any hop is missing or not a dict.

    The IDs herdr returns are nested (result.workspace.workspace_id); a missing one must
    read as absent rather than raise, so the caller can report ok:false (spec §3).
    """
    cur = data
    for key in path:
        if not isinstance(cur, dict):
            return ""
        cur = cur.get(key)
    return cur if isinstance(cur, str) else ""
