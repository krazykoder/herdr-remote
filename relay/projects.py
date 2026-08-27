#!/usr/bin/env python3
"""Configured Projects: load/validate HERDR_PROJECTS_FILE, group live panes by cwd root.

Two kinds of project, and the difference is who wrote them down. A **file** project is authorised
by HERDR_PROJECTS_FILE and nothing else can add one. A **child** is a directory one level under a
file project marked `children`, found by scanning: it becomes a project because somebody made a
directory, which is how an agent gets a place of its own without anything editing the file.

The security property survives that because a child's cwd is still the file's path plus one name
off this machine's own filesystem — no path a client sent, at any point, in either kind.

I/O is reading the config file and listing a root's directories, both of which are injectable in
the functions that do them. No herdr calls, no relay state.
See .workflow/03_specs/2026-08-08_projects_spec.md
"""
import json
import os
import re
from collections import defaultdict

PROJECT_ID_RE = re.compile(r"^[a-z0-9_-]{1,64}$")
MAX_LABEL = 64

# A marker is a file *name* a child must contain to count as one, never a path: it is joined onto a
# directory this module scanned, so a `/` in it would be a way to reach one level further down.
MARKER_RE = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# Per root. A root with more directories than this is not a place where projects live, and a
# roster that grows without bound is broadcast to every client on every change.
MAX_CHILDREN = 64
# Everything outside the id charset folds to a dash, so a directory called `charts.TS` can still
# have an id. The label keeps the real name and the cwd keeps the real directory.
NOT_IN_ID = re.compile(r"[^a-z0-9_-]+")


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

        # A root: its direct subdirectories are projects in their own right, found by scanning
        # rather than written down. The file still owns the only path anyone names — a child's cwd
        # is this root's plus one directory name that came off this machine's own filesystem.
        children = entry.get("children", False)
        if not isinstance(children, bool):
            raise ProjectConfigError(f"{where} ({pid}): children must be true or false")

        marker = entry.get("marker", "")
        if marker and (not isinstance(marker, str) or not MARKER_RE.match(marker)):
            raise ProjectConfigError(
                f"{where} ({pid}): marker must be a file name, got {marker!r}")
        if marker and not children:
            raise ProjectConfigError(f"{where} ({pid}): marker means nothing without children")

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

        # Scanning a remote root is an ssh round trip per poll, which is a different feature with
        # a different cost. Refused rather than accepted-and-ignored: a root that silently never
        # grows a child is the harder thing to debug.
        if children and host != "local":
            raise ProjectConfigError(
                f"{where} ({pid}): children are local-only — host {host!r} cannot be a root")

        seen_ids.add(pid)
        seen_roots.add((host, cwd))
        projects.append({"id": pid, "label": label, "cwd": cwd, "host": host,
                         "children": children, "marker": marker})
    return projects


def scan_root(cwd, marker=""):
    """The names of the directories directly under a root that may be projects. Sorted, capped.

    Depth one, which is what makes "is `src` a project?" a question nobody has to answer: `src`
    lives under a child, not under the root, so it is never a candidate.

    Symlinks are skipped rather than resolved. Everything else here is authorised by the file, and
    a symlink is the one way the *filesystem* could authorise a path outside the root — which is
    a thing an agent working in one of these directories can create.
    """
    out = []
    try:
        with os.scandir(cwd) as entries:
            for e in entries:
                # A dotdir is somebody's cache, not somebody's project.
                if e.name.startswith(".") or e.is_symlink() or not e.is_dir():
                    continue
                if marker and not os.path.exists(os.path.join(cwd, e.name, marker)):
                    continue
                out.append(e.name)
    except OSError:
        # A root that has gone away has no children; it is not an error worth stopping a poll for.
        return []
    return sorted(out)[:MAX_CHILDREN]


def child_id(parent_id, name):
    """A child's project id: its root's, then the directory name folded into the id charset."""
    slug = NOT_IN_ID.sub("-", name.lower()).strip("-")
    return f"{parent_id}-{slug}"[:64] if slug else ""


def child_projects(projects, scan=scan_root):
    """The projects that exist because a directory does, one level under each root.

    Ordinary project rows, deliberately: everything downstream — grouping, starting, tiles, the
    record — already works on those, and a second kind of thing would need every one of them to
    learn about it. `parent` is the whole difference, and it says the row was derived rather than
    written down, so a client can tell what only a human can change.
    """
    known_ids = {p["id"] for p in projects}
    known_roots = {(p["host"], p["cwd"]) for p in projects}
    out = []
    for root in projects:
        if not root.get("children"):
            continue
        for name in scan(root["cwd"], root.get("marker", "")):
            cwd = os.path.normpath(os.path.join(root["cwd"], name))
            # The name came from a listing of this root, so it is already one segment. Checked
            # anyway: this is the only place in the module where a path is built out of something
            # the config file did not write.
            if not _under(cwd, root["cwd"]) or cwd == root["cwd"]:
                continue
            # A root that also names one of its own children explicitly keeps the written entry:
            # it has a label somebody chose and an id other documents already point at.
            if (root["host"], cwd) in known_roots:
                continue
            pid = child_id(root["id"], name)
            if not pid or pid in known_ids:
                continue
            known_ids.add(pid)
            known_roots.add((root["host"], cwd))
            out.append({"id": pid, "label": name, "cwd": cwd, "host": root["host"],
                        "children": False, "marker": "", "parent": root["id"]})
    return out


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

    A matched pane also inherits the Project's label as its `project`. split_panes can only
    guess that name from the pane's own cwd, so an agent or terminal started in a subdirectory
    called itself "relay" or "web" — two projects, one repo, as far as every client could tell.
    The configured root is the better answer for everything beneath it. Only overwritten, never
    added: the key is already in both pane shapes, so the wire's key order is untouched.
    """
    if not projects:
        return agents
    labels = {p["id"]: p["label"] for p in projects}
    for a in agents:
        pid = resolve_project_id(a.get("cwd", ""), a.get("host", "local"), projects)
        if pid:
            a["project_id"] = pid
            if "project" in a:
                a["project"] = labels[pid]
    return agents


def public_projects(projects):
    """Projects as sent to clients. cwd never leaves the relay.

    `parent` rides along on a child and is absent everywhere else, so its presence is the answer
    to "can this row be edited by hand" without a second field saying so.
    """
    return [dict({"id": p["id"], "label": p["label"], "host": p["host"]},
                 **({"parent": p["parent"]} if p.get("parent") else {}))
            for p in projects]


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
