# Spec — P1: Projects and Native Layout

**Date:** 2026-08-08
**Architecture:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs.md` §§2–4
**Classification:** Class B — additive and backward compatible.
**Status:** Proposed

## 1. Scope

| In | Out |
|---|---|
| Configured Projects, cwd grouping, `projects` push | Remote agent spawning (P2) |
| Project > workspace > tab browser navigation | Local pairs and transfer (P3) |
| Cached agents push on connect | Raising `send_text` cap (P3) |
| Ambiguous-pane refusal | `(host, pane_id)` migration |
| Fix remote routing for existing `create_tab` | Standalone empty-workspace UI |

## 2. Projects

`HERDR_PROJECTS_FILE` is an absolute path to trusted JSON, read once at relay startup.

```json
[
  {"id":"charts","label":"Charts","cwd":"/Users/towshif/code/js/charts.TS","host":"local"}
]
```

Each entry has a unique `id` matching `^[a-z0-9_-]{1,64}$`, non-empty `label` ≤64 characters, absolute `cwd`, and `host` equal to `local` or one configured in `HERDR_REMOTES`. The path itself must be absolute.

`~` expands in the config path and in a **local** entry's `cwd`. A remote entry's `cwd` starting with `~` is refused: `expanduser` resolves against the relay's home, not the SSH target's, so it would silently name a path that may not exist on that machine. Remote roots are spelled out. Any malformed entry, duplicate id, unreadable file, or unknown host exits non-zero at startup. Duplicate roots are rejected per `(host, cwd)`, not per `cwd`: the same path on two different hosts is two distinct machines and resolves unambiguously, so refusing it would block the ordinary case of one repo checked out on a laptop and a build box. Unset variable or `[]` means Projects are disabled.

For every live pane, relay matches same-host configured roots using `cwd == root` or `cwd.startswith(root.rstrip("/") + "/")`; longest root wins. Thus local agents started from a configured root or a subdirectory appear under that Project; unmatched panes stay visible as Other sessions. Matching is lexical: no git, worktree, or symlink resolution. Plain `startswith` is wrong — it groups `/code/x-old` under `/code/x`.

**Only full `agents` snapshots carry grouping (D10).** An unmatched pane omits `project_id` entirely — not `null`, not `""`. A full snapshot replaces the client list, so either representation clears previous grouping; omission is the smaller additive wire shape.

Incremental `agent_update` messages never carry `project_id`: the field stays **out of** `AGENT_EVENT_FIELDS`, so an update cannot disturb grouping, and the browser keeps the last snapshot's value until the next snapshot replaces the list wholesale (`apply_agent_message:36`). Worst-case staleness is one `POLL_INTERVAL`.

Do **not** resolve Projects inside `event_push`. `agent_update_message:13-16` normalizes `host` against `socket.gethostname()`, so events identify a pane by hostname while Projects are keyed by `"local"` or the SSH target from `HERDR_REMOTES`; for remote panes those never match, and clearing on a failed resolve would replace 2s of staleness with a persistent wrong answer.

## 3. Layout and browser behaviour

Project is persistent outer grouping. Herdr workspace and tab remain native live layout beneath it:

```text
Project (configured cwd/host, may have zero sessions)
  Workspace (herdr-native, live)
    Tab (herdr-native, live)
      Agent pane (Claude/Codex session, standalone or paired later)
```

With Projects configured, browser renders Project cards in file order. Selecting a Project filters its live agents, then reuses current workspace and tab chips to navigate those agents. Blocked agents remain hoisted. A zero-session Project renders “No sessions”; P2 adds its Start session control.

Workspace and tab chips keep their existing visibility rule (`web/index.html:430` shows them only when more than one workspace is present), now evaluated over the selected Project's agents rather than all agents. Changing the selected Project resets both `activeWorkspace` and `activeTab` — a workspace ID selected under one Project is meaningless under another, and leaving it set silently filters the new Project down to nothing.

With Projects disabled, preserve current workspace/tab UI and `create_tab` behaviour. Do not flatten or remove legacy navigation.

## 4. Protocol

### 4.1 `projects`

**Only when Projects are configured.** With `HERDR_PROJECTS_FILE` unset the connect path is untouched — no `projects`, no cached snapshot — so a legacy deployment sees the exact wire it saw before P1. There is nothing to group without Projects, and an empty `projects: []` would be a new message on a wire that A4 requires to be unchanged.

When Projects exist, relay sends these two messages in order, inside `handle_client`’s existing `try` block:

```json
{"type":"projects","projects":[{"id":"charts","label":"Charts","host":"local"}]}
{"type":"agents","agents":[...]}
```

`projects` omits cwd. The second message is cached latest snapshot, or an empty snapshot before first poll. Projects remain fixed until relay restart.

### 4.2 Existing `create_tab`

`create_tab {workspace_id}` remains a native layout command. Relay resolves the workspace's host from the live snapshot and calls `herdr tab create --workspace <id> --focus` with `remote=` set to it. Reply remains `tab_created`.

**Resolution is by distinct host, not by agent count.** Workspace IDs are per-server counters exactly as pane IDs are (§5), so `w8` can exist on two hosts at once:

| Live agents with this `workspace_id` | Result |
|---|---|
| none | error `unknown workspace_id` |
| all on one host | create the tab on that host |
| spanning two or more hosts | error `ambiguous workspace_id` |

A workspace holding three agents is the normal case, not an ambiguous one — testing for "exactly one matching agent" would refuse it.

`create_tab` creates no agent and cannot create a Pair.

**The created tab is invisible in herdr-remote.** `get_agents_from_host:195` filters `if p.get("agent")`, so an empty tab appears in no snapshot until an agent runs in it, and P2's Start session → New tab creates its own tab rather than adopting one. `+ Tab` is therefore a control for the operator at the herdr terminal, and A9/A10 are verified with `herdr tab list`, not in the browser. This is a consequence of retaining the control (D8), and is recorded here so it is not filed as a bug.

## 5. Ambiguous pane IDs

On every poll, recompute pane IDs present on more than one host. For these IDs, refuse `respond`, `read_pane`, `send_keys`, and `send_text` with `ambiguous pane_id (same id on multiple hosts)`. This prevents current last-host-wins misrouting. It clears within one poll after collision ends.

`read_pane` is in the list deliberately — omitting it leaks another machine's terminal content.

**Two ID spaces, two guards.** The set above covers `pane_id` only. `workspace_id` collides the same way and is guarded separately at its point of use (§4.2). An implementer who wires only the pane set leaves `create_tab` — and, in P2, `placement: "new_tab"` — still able to reach the wrong host.

## 6. Acceptance

| # | Given | Then |
|---|---|---|
| A1 | Pane cwd equals or is below configured root | Correct `project_id`; longest root wins |
| A2 | Pane cwd is sibling prefix/wrong host, or an `agent_event` arrives | Snapshot omits `project_id`; update contains no `project_id`; pane stays/shows under Other sessions until next snapshot as applicable |
| A3 | Zero-session configured Project | Visible card with “No sessions” |
| A4 | Config disabled | Existing workspace/tab navigation and `create_tab` remain available; connect sends nothing, as before P1 |
| A5 | Fresh client connects, Projects configured | Receives `projects`, then cached `agents` |
| A6 | Invalid config or relative config-file path | Relay exits non-zero naming path/entry |
| A7 | Same pane ID on two hosts | All four pane commands refuse; neither host is touched |
| A8 | Collision ends | Commands recover within one poll interval |
| A9 | `create_tab` targets remote live workspace | Tab is created on that remote, never local host. Verify with `herdr tab list` on the remote — the empty tab is invisible in the browser (§4.2) |
| A10 | `create_tab` workspace ID is unknown, or is reported by two hosts | Error; no tab created on either host |
| A11 | `create_tab` targets a workspace holding three agents on one host | Succeeds — multiple agents is not ambiguity |
| A12 | Switching selected Project | `activeWorkspace` and `activeTab` reset; new Project's agents are all visible |
| A13 | Any P1 change | No edit to `herdr_tui.py`, `herdr_telegram.py`, `herdi-mac/`, `herdi-ios/`; they ignore `project_id` and keep working |
