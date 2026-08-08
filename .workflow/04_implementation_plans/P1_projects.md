# Implementation Plan — P1: Projects

**Date:** 2026-08-08
**Phase:** 4 (Plans)
**Spec:** `.workflow/03_specs/projects_spec.md`
**Architecture:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs.md`
**Classification:** Class B — additive, backward compatible.
**Handoff:** Implementer.

Line numbers refer to the tree at `e7edb5f`. Re-anchor by symbol if they have drifted.

---

## Goal

Group live agent panes under operator-configured **Projects**, render zero-session Projects, push `projects` and the cached `agents` snapshot on connect, refuse ambiguous pane IDs, and delete `create_tab` and the workspace/tab chip strips.

No new capability is exposed. `start_agent` is P2.

---

## Task list

| T | File | Marker |
|---|---|---|
| T1 | `relay/projects.py` | `[NEW]` |
| T2 | `relay/herdr_relay.py` | `[MODIFY]` |
| T3 | `relay/agent_state.py` | `[MODIFY]` |
| T4 | `web/index.html` | `[MODIFY]` |
| T5 | `tests/test_projects.py` | `[NEW]` |

Do them in order. T1 has no dependencies and is fully testable on its own.

---

## T1 — `[NEW] relay/projects.py`

A separate module, not a section of `herdr_relay.py`: importing `herdr_relay` has side effects (it creates log directories at `:28` and loads push subscriptions at `:158`), which makes it a poor test target. These functions are pure.

```python
"""Configured Projects: trusted launch targets and cwd grouping roots."""
import json
import os
import re

PROJECT_ID_RE = re.compile(r"^[a-z0-9_-]{1,64}$")


class ProjectConfigError(ValueError):
    """HERDR_PROJECTS_FILE is unusable. Fatal at startup."""


def load_projects(path: str, remotes) -> list[dict]:
    """Parse and validate the trusted Projects file. Empty path means no Projects.

    Fail-closed: any bad entry raises. A silently dropped Project becomes a
    mis-grouped session now, and in P2 a launch target the operator believes
    is configured but is not.
    """
    if not path:
        return []
    try:
        with open(path) as f:
            raw = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        raise ProjectConfigError(f"{path}: unreadable or not JSON ({e})") from e
    if not isinstance(raw, list):
        raise ProjectConfigError(f"{path}: top level must be a JSON array")

    hosts = {"local", *remotes}
    projects, seen_ids, seen_roots = [], set(), set()
    for i, entry in enumerate(raw):
        where = f"{path}[{i}]"
        if not isinstance(entry, dict):
            raise ProjectConfigError(f"{where}: must be an object")
        pid = entry.get("id")
        if not isinstance(pid, str) or not PROJECT_ID_RE.match(pid):
            raise ProjectConfigError(f"{where}: id must match {PROJECT_ID_RE.pattern}")
        if pid in seen_ids:
            raise ProjectConfigError(f"{where}: duplicate id {pid!r}")
        label = entry.get("label")
        if not isinstance(label, str) or not label or len(label) > 64:
            raise ProjectConfigError(f"{where}: label must be a non-empty string of at most 64 chars")
        cwd = entry.get("cwd")
        if not isinstance(cwd, str) or not os.path.isabs(cwd):
            raise ProjectConfigError(f"{where}: cwd must be an absolute path")
        cwd = os.path.normpath(cwd)
        host = entry.get("host", "local")
        if host not in hosts:
            raise ProjectConfigError(f"{where}: host {host!r} is not 'local' or in HERDR_REMOTES")
        if (host, cwd) in seen_roots:
            raise ProjectConfigError(f"{where}: duplicate root {cwd!r} on host {host!r}")
        seen_ids.add(pid)
        seen_roots.add((host, cwd))
        projects.append({"id": pid, "label": label, "cwd": cwd, "host": host})
    return projects


def resolve_project_id(projects, cwd: str, host: str):
    """Longest configured root on the same host that contains cwd; None if unmatched.

    Lexical only — no symlink, git or worktree resolution (spec §3.3).
    """
    if not cwd:
        return None
    cwd = os.path.normpath(cwd)
    best = None
    for p in projects:
        if p["host"] != host:
            continue
        root = p["cwd"]
        # Exact-or-descendant. Plain startswith groups /code/x-old under /code/x.
        if cwd == root or cwd.startswith(root.rstrip("/") + "/"):
            if best is None or len(root) > len(best["cwd"]):
                best = p
    return best["id"] if best else None
```

---

## T2 — `[MODIFY] relay/herdr_relay.py`

### T2.1 Import (after `:9`)

```python
from agent_state import complete_agent_update_message
from projects import ProjectConfigError, load_projects, resolve_project_id
```

### T2.2 Load config (after `REMOTES`, `:57`)

```python
PROJECTS_FILE = os.environ.get("HERDR_PROJECTS_FILE", "")
try:
    PROJECTS = load_projects(PROJECTS_FILE, REMOTES)
except ProjectConfigError as e:
    print(f"herdr-relay: bad HERDR_PROJECTS_FILE: {e}", file=sys.stderr)
    raise SystemExit(1)
```

`sys` is already imported at `:18`. Use `print` + `SystemExit`, not `log.error` — this runs before anyone is watching the log, and the operator needs it on stderr.

### T2.3 Globals (after `:74`)

```python
ambiguous_panes = set()
last_agents_msg = {"type": "agents", "agents": []}
```

### T2.4 Resolve `project_id` in `get_agents_from_host` (`:176`)

Bind the existing comprehension to a name, then annotate. Do **not** put a conditional key inside the comprehension — the key must be absent when unmatched (spec §3.2), which a comprehension cannot express cleanly.

```python
        agents = [
            {
                "pane_id": p["pane_id"],
                # ... unchanged ...
            }
            for p in panes if p.get("agent")
        ]
        for a in agents:
            project_id = resolve_project_id(PROJECTS, a["cwd"], host_label)
            if project_id:
                a["project_id"] = project_id      # absent, never null (spec §3.2)
        return agents
```

### T2.5 Ambiguity set + cached snapshot in `_poll_once` (`:247`)

```python
async def _poll_once():
        agents = get_all_agents()
        # Bare pane_id is not unique across hosts (G7). Refuse rather than guess.
        counts = {}
        for a in agents:
            counts[a["pane_id"]] = counts.get(a["pane_id"], 0) + 1
        ambiguous_panes.clear()
        ambiguous_panes.update(pid for pid, n in counts.items() if n > 1)
        # Always broadcast (even empty list) so clients stay in sync
        for a in agents:
            pane_remote_map[a["pane_id"]] = a.get("remote")
            known_panes.add(a["pane_id"])
            agent_cache[a["pane_id"]] = a
        last_agents_msg["agents"] = agents
        await broadcast(last_agents_msg)
        # ... rest unchanged ...
```

Recomputed every cycle, so it self-heals within one `POLL_INTERVAL`.

### T2.6 Guard helper (module level, near `audit`)

```python
def pane_error(pane_id):
    """Reason this pane cannot be safely addressed, or None."""
    if pane_id not in known_panes:
        return "unknown pane_id"
    if pane_id in ambiguous_panes:
        return "ambiguous pane_id (same id on multiple hosts)"
    return None
```

### T2.7 Apply the guard at all four sites

`respond` (`:472`), `read_pane` (`:487`), `send_keys` (`:496`), `send_text` (`:519`). Replace each:

```python
                if pane_id not in known_panes:
                    await ws.send(json.dumps({"type": "error", "message": "unknown pane_id"}))
                    continue
```

with:

```python
                err = pane_error(pane_id)
                if err:
                    await ws.send(json.dumps({"type": "error", "message": err}))
                    continue
```

All four. `read_pane` is included deliberately — omitting it leaks another machine's terminal content.

### T2.8 Push on connect (`handle_client`, after `:462`)

Both sends go **inside** the existing `try`, before `async for`. Outside it, a send to an already-closed socket escapes the `finally` at `:554` and leaks the entry in `clients`.

```python
    connected_at = time.monotonic()
    try:
        await ws.send(json.dumps({"type": "projects", "projects": [
            {"id": p["id"], "label": p["label"], "host": p["host"]} for p in PROJECTS
        ]}))
        await ws.send(json.dumps(last_agents_msg))
        async for raw in ws:
```

`cwd` is omitted from the payload on purpose (spec §4.1).

### T2.9 Delete `create_tab` (`:530-538`)

Remove the whole `elif msg_type == "create_tab":` block. An old client's `create_tab` then falls through and is ignored, matching existing behaviour for unrecognized types. This disposes of G2.

---

## T3 — `[MODIFY] relay/agent_state.py`

One entry, `:4`:

```python
AGENT_EVENT_FIELDS = ("pane_id", "agent", "status", "cwd", "project", "host", "project_id")
```

**Do not** add it to `REQUIRED_AGENT_FIELDS` — an unmatched pane legitimately has no `project_id`, and requiring it would drop those updates entirely.

Effect: an `agent_update` built from a cached pane carries its `project_id`, so an event does not bounce a known pane into "Other sessions" between polls. A pane whose `cwd` changed keeps its previous grouping for up to one poll interval; the next snapshot corrects it. Acceptable — the alternative is resolving Projects inside `event_push`, where the `host` field has already been normalized to a hostname rather than the SSH remote label and would not match configured hosts.

---

## T4 — `[MODIFY] web/index.html`

### T4.1 State (`:272-273`)

```js
let projects = [];
```

replaces `let activeWorkspace = null;` and `let activeTab = null;`.

### T4.2 Handle `projects` (in `handleMessage`, alongside `:378`)

```js
  else if (msg.type === 'projects') { projects = msg.projects || []; render(); }
```

### T4.3 Rewrite `render()` (`:427-437`)

```js
function render() {
  document.getElementById('agentCount').textContent = agents.length ? `${agents.length}` : '';
  if (!projects.length) { renderAgentList(agents); return; }
  renderProjects();
}
```

Zero configured Projects keeps the existing flat list — the default path must stay untouched (spec §2.2).

### T4.4 Replace `renderWorkspaces` (`:439-486`) with `renderProjects`

```js
function renderProjects() {
  let html = '';
  const blocked = agents.filter(a => a.status === 'blocked');
  if (blocked.length) {
    html += `<div class="section-header" style="color:var(--red)"><span class="dot" style="background:var(--red)"></span>Needs you <span style="opacity:0.6">(${blocked.length})</span></div>`;
    html += blocked.map(a => agentCard(a)).join('');
  }
  for (const p of projects) {
    const mine = agents.filter(a => a.project_id === p.id);
    const rest = mine.filter(a => a.status !== 'blocked');   // blocked already hoisted
    const host = p.host && p.host !== 'local' ? ` <span style="color:var(--orange);font-size:0.6rem">@${p.host}</span>` : '';
    if (rest.length) {
      html += section(p.label + host, 'var(--muted)', rest);
    } else {
      html += `<div class="section-header"><span class="dot" style="background:var(--muted)"></span>${p.label}${host}</div>`;
      if (!mine.length) html += `<div class="empty">No sessions</div>`;
    }
  }
  const other = agents.filter(a => !a.project_id);
  if (other.length) html += section('Other sessions', 'var(--muted)', other);
  document.getElementById('agents').innerHTML = html;
}
```

Reuses the existing `section()` helper (`:526`). Project order is the configured file order and never reorders by activity — the list must not move under the user's thumb on mobile (D7). Blocked agents are surfaced by the hoist, which is what urgency needs.

`p.label` is interpolated raw, matching how `agentCard` already handles `a.label` and `a.cwd` (`:517-518`). Labels come from the operator's own trusted config file, so this adds no vector — but it is also why `label` is capped at 64 chars in T1.

### T4.5 Delete

- `selectWorkspace`, `backToWorkspaces`, `selectTab` (`:502-504`)
- `createTab` (`:506-511`)
- any remaining `activeWorkspace` / `activeTab` reference

Verify with `grep -n 'activeWorkspace\|activeTab\|create_tab\|createTab' web/index.html` — must return nothing.

Check the CSS: if `.chip`, `.chip-strip`, `.chip-label` and `.chip-add` have no other user after this, delete those rules too.

---

## T5 — `[NEW] tests/test_projects.py`

Follow the layout of `tests/test_agent_state.py`: `sys.path.insert` on `relay/`, plain `unittest`.

Required cases, one per spec §7 row it covers:

| Test | Covers |
|---|---|
| `test_exact_root_matches` | A1 |
| `test_subdirectory_matches` | A2 |
| `test_longest_root_wins` | A3 |
| `test_sibling_prefix_does_not_match` — `/code/x-old` vs root `/code/x` | A4 |
| `test_other_host_does_not_match` | A5 |
| `test_unmatched_returns_none` | A6 |
| `test_empty_path_returns_no_projects` | A9 |
| `test_duplicate_id_raises` | A10 |
| `test_relative_cwd_raises` | A10 |
| `test_unknown_host_raises` | A10 |
| `test_duplicate_root_raises` | A10 |
| `test_non_array_raises` | A10 |
| `test_trailing_slash_root_normalized` | §2.1 |

Write config fixtures with `tempfile.NamedTemporaryFile`. `resolve_project_id` needs no fixture — pass a literal list.

A4 and A5 are the two that catch a wrong implementation; do not skip them.

---

## Verification

```bash
source .venv313/bin/activate
python -m unittest discover -s tests -t tests
```

Manual, against a live herdr:

```bash
cat > /tmp/projects.json <<'JSON'
[{"id":"herdr-remote","label":"herdr-remote","cwd":"/Users/towshif/code/python/herdr-remote","host":"local"},
 {"id":"empty","label":"Empty Project","cwd":"/tmp/no-such-project","host":"local"}]
JSON
HERDR_PROJECTS_FILE=/tmp/projects.json uv run relay/herdr_relay.py
```

| Check | Expected |
|---|---|
| Open the web app | An agent running in the repo appears under **herdr-remote**; **Empty Project** shows "No sessions" |
| Start an agent in a subdirectory of the repo | Groups under **herdr-remote**, not Other sessions |
| Start an agent in `/tmp` | Appears under **Other sessions** |
| Reload the page | Populated list on first paint — no "Waiting for agents…" flash |
| `HERDR_PROJECTS_FILE` unset | Flat status-grouped list, exactly as before |
| Add a second entry with the same `id` | Relay exits non-zero, message names the index |
| Relative `cwd` in the file | Relay exits non-zero |

Confirm no `project_id: null` reaches a client:

```bash
grep -c '"project_id": *null' <(websocat ws://127.0.0.1:8375)   # must be 0
```

---

## Acceptance criteria

1. `python -m unittest discover -s tests -t tests` passes; `tests/test_projects.py` covers every row in T5.
2. Every acceptance row in spec §7 (A1–A13) holds.
3. `grep -n 'activeWorkspace\|activeTab\|create_tab\|createTab'` returns nothing across `relay/` and `web/`.
4. With `HERDR_PROJECTS_FILE` unset, the app is byte-for-byte behaviourally identical to `e7edb5f`.
5. An unmatched pane's JSON has **no** `project_id` key — not `null`, not `""`.
6. `git diff --check` clean; no changes to `herdr_tui.py`, `herdr_telegram.py`, `herdi-mac/`, `herdi-ios/`.

---

## Out of scope — do not implement

- `start_agent` in any form (P2).
- Session Pairs, transfer, the shortcut dropdown, raising the `send_text` cap (P3).
- `SIGHUP` re-read of the Projects file.
- Changing pane identity to `(host, pane_id)` — Class C, needs its own proposal. T2.5/T2.7 only make the relay refuse the ambiguous case; they do not fix routing.
