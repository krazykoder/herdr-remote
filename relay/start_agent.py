#!/usr/bin/env python3
"""Start session: validate a start_agent request and build its herdr command arguments.

Pure module — no I/O, no subprocess, no relay state. Everything that decides *whether* a
start is allowed lives here so it is testable without herdr.
See .workflow/03_specs/2026-08-08_start_agent_spec.md
"""
import re

from projects import ambiguous_pane_ids, resolve_workspace_remote

ROLES = ("architect", "reviewer", "agent")
DEFAULT_START_AGENTS = ["codex", "claude", "pi"]
AGENT_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")

PLACEMENTS = {
    "new_workspace": None,
    "new_tab": "workspace_id",
    "split": "split_from",
}
BASE_FIELDS = {"type", "name", "role", "project_id", "placement"}


class StartAgentConfigError(Exception):
    """Raised for a malformed HERDR_START_AGENTS. The relay exits non-zero on this."""


def load_start_agents(raw):
    """Parse HERDR_START_AGENTS into an ordered allowlist. Unset yields the default set.

    This allowlist is the boundary on *what* can be executed: the relay runs whatever
    binary matches an allowlisted name on the target host's PATH.
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

    remote = _project_remote(project)
    plan = {
        "name": name,
        "role": role,
        "project_id": project["id"],
        "project_label": project["label"],
        "cwd": project["cwd"],
        "remote": remote,
        "placement": placement,
        "label": next_role_label(role, project["id"], agents),
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
        tab_id = source.get("tab_id")
        if not tab_id:
            return None, "pane has no tab_id"
        plan["tab_id"] = tab_id

    return plan, None


def workspace_create_args(cwd, label):
    return ("workspace", "create", "--cwd", cwd, "--label", label, "--focus")


def tab_create_args(workspace_id, label):
    return ("tab", "create", "--workspace", workspace_id, "--label", label, "--focus")


def agent_start_args(name, cwd, anchor_kind, anchor_id, split=False):
    """herdr agent start requires argv after `--`; the relay supplies the allowlisted name.

    anchor_kind is "workspace" or "tab" — never a client-supplied value.
    """
    args = ["agent", "start", name, "--cwd", cwd, f"--{anchor_kind}", anchor_id]
    if split:
        args += ["--split", "right"]
    args += ["--focus", "--", name]
    return tuple(args)


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
