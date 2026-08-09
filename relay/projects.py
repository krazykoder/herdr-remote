#!/usr/bin/env python3
"""Configured Projects: load/validate HERDR_PROJECTS_FILE, group live panes by cwd root.

Pure module — no I/O beyond reading the config file, no herdr calls, no relay state.
See .workflow/03_specs/2026-08-08_projects_spec.md
"""
import json
import os
import re
from collections import defaultdict

PROJECT_ID_RE = re.compile(r"^[a-z0-9_-]{1,64}$")
MAX_LABEL = 64


class ProjectConfigError(Exception):
    """Raised for any malformed Projects config. The relay exits non-zero on this."""


def load_projects(path, valid_hosts=()):
    """Read and validate the Projects config. Returns a list of {id, label, cwd, host}.

    An unset path means Projects are disabled and yields an empty list. Anything else
    that is wrong raises ProjectConfigError naming the path and the offending entry.
    """
    if not path:
        return []
    path = os.path.expanduser(path)  # the config path and its roots are hand-written
    if not os.path.isabs(path):
        raise ProjectConfigError(f"HERDR_PROJECTS_FILE must be an absolute path: {path!r}")
    try:
        with open(path) as f:
            data = json.load(f)
    except OSError as e:
        raise ProjectConfigError(f"{path}: cannot read ({e.strerror})") from e
    except json.JSONDecodeError as e:
        raise ProjectConfigError(f"{path}: invalid JSON at line {e.lineno} ({e.msg})") from e

    if not isinstance(data, list):
        raise ProjectConfigError(f"{path}: top level must be a JSON array")

    allowed_hosts = {"local", *valid_hosts}
    projects, seen_ids, seen_roots = [], set(), set()
    for i, entry in enumerate(data):
        where = f"{path}: entry {i}"
        if not isinstance(entry, dict):
            raise ProjectConfigError(f"{where}: must be an object")

        pid = entry.get("id")
        if not isinstance(pid, str) or not PROJECT_ID_RE.match(pid):
            raise ProjectConfigError(f"{where}: id must match ^[a-z0-9_-]{{1,64}}$, got {pid!r}")
        if pid in seen_ids:
            raise ProjectConfigError(f"{where}: duplicate id {pid!r}")

        label = entry.get("label")
        if not isinstance(label, str) or not label.strip() or len(label) > MAX_LABEL:
            raise ProjectConfigError(f"{where} ({pid}): label must be 1..{MAX_LABEL} characters")

        host = entry.get("host", "local")
        if host not in allowed_hosts:
            raise ProjectConfigError(
                f"{where} ({pid}): host {host!r} is not 'local' nor in HERDR_REMOTES "
                f"({', '.join(sorted(valid_hosts)) or 'empty'})"
            )

        cwd = entry.get("cwd")
        if not isinstance(cwd, str):
            raise ProjectConfigError(f"{where} ({pid}): cwd must be an absolute path, got {cwd!r}")
        # ~ expands against the relay's home, which is only the right home for local.
        # A remote entry must spell its path out, or it would silently point at the
        # relay operator's home path on a machine where it may not exist.
        if host == "local":
            cwd = os.path.expanduser(cwd)
        elif cwd.startswith("~"):
            raise ProjectConfigError(
                f"{where} ({pid}): cwd on remote host {host!r} cannot start with '~' — "
                f"it would expand against the relay's home, not {host}'s"
            )
        if not os.path.isabs(cwd):
            raise ProjectConfigError(f"{where} ({pid}): cwd must be an absolute path, got {cwd!r}")
        cwd = os.path.normpath(cwd)

        # Same root on two different hosts is unambiguous; same root on one host is not.
        if (host, cwd) in seen_roots:
            raise ProjectConfigError(f"{where} ({pid}): duplicate root {cwd!r} on host {host!r}")

        seen_ids.add(pid)
        seen_roots.add((host, cwd))
        projects.append({"id": pid, "label": label, "cwd": cwd, "host": host})
    return projects


def _under(cwd, root):
    """Path-boundary containment. Plain startswith would group /code/x-old under /code/x."""
    if cwd == root:
        return True
    return cwd.startswith(root if root.endswith("/") else root + "/")


def resolve_project_id(cwd, host, projects):
    """Return the id of the longest same-host configured root containing cwd, else None.

    Matching is lexical: no git, worktree, or symlink resolution (D1).
    """
    if not cwd:
        return None
    cwd = os.path.normpath(cwd)
    best = None
    for p in projects:
        if p["host"] != host or not _under(cwd, p["cwd"]):
            continue
        if best is None or len(p["cwd"]) > len(best["cwd"]):
            best = p
    return best["id"] if best else None


def annotate_agents(agents, projects):
    """Add project_id to each matching agent, in place. Unmatched panes get no key at all.

    Never writes null or "" — grouping travels on full snapshots only (D10), and a full
    snapshot replaces the client's list, so an absent key already clears stale grouping.
    """
    if not projects:
        return agents
    for a in agents:
        pid = resolve_project_id(a.get("cwd", ""), a.get("host", "local"), projects)
        if pid:
            a["project_id"] = pid
    return agents


def public_projects(projects):
    """Projects as sent to clients. cwd never leaves the relay."""
    return [{"id": p["id"], "label": p["label"], "host": p["host"]} for p in projects]


def ambiguous_pane_ids(agents):
    """Bare pane IDs reported by more than one host.

    herdr pane IDs are per-server counters, so two hosts can both report w8:p1 and the
    relay's bare-pane_id routing map silently keeps whichever was polled last (G7/D6).
    """
    hosts_by_pane = defaultdict(set)
    for a in agents:
        hosts_by_pane[a["pane_id"]].add(a.get("host", "local"))
    return {pane_id for pane_id, hosts in hosts_by_pane.items() if len(hosts) > 1}


def resolve_workspace_remote(agents, workspace_id):
    """Resolve the host owning a workspace. Returns (remote, error); remote None means local.

    workspace_id is a separate ID space from pane_id and collides independently, so this
    is a one-distinct-*host* test, not a one-matching-agent test — a workspace holding
    three agents is the normal case (D6).
    """
    matches = [a for a in agents if a.get("workspace_id") == workspace_id]
    if not matches:
        return None, "unknown workspace_id"
    remotes = {a.get("remote") for a in matches}
    if len(remotes) > 1:
        return None, "ambiguous workspace_id (same id on multiple hosts)"
    return remotes.pop(), None
