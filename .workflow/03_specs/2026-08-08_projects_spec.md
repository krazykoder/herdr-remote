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

Each entry has a unique `id` matching `^[a-z0-9_-]{1,64}$`, non-empty `label` ≤64 characters, absolute `cwd`, and `host` equal to `local` or one configured in `HERDR_REMOTES`. The path itself must be absolute. Any malformed entry, duplicate ID/root, unreadable file, or unknown host exits non-zero at startup. Unset variable or `[]` means Projects are disabled.

For every live pane, relay matches same-host configured roots using `cwd == root` or `cwd.startswith(root.rstrip("/") + "/")`; longest root wins. Unmatched panes omit `project_id` entirely. Thus local agents started from a configured root or a subdirectory appear under that Project; unmatched panes stay visible as Other sessions. Matching is lexical: no git, worktree, or symlink resolution.

## 3. Layout and browser behaviour

Project is persistent outer grouping. Herdr workspace and tab remain native live layout beneath it:

```text
Project (configured cwd/host, may have zero sessions)
  Workspace (herdr-native, live)
    Tab (herdr-native, live)
      Agent pane (Claude/Codex session, standalone or paired later)
```

With Projects configured, browser renders Project cards in file order. Selecting a Project filters its live agents, then reuses current workspace and tab chips to navigate those agents. Blocked agents remain hoisted. A zero-session Project renders “No sessions”; P2 adds its Start session control.

With Projects disabled, preserve current workspace/tab UI and `create_tab` behaviour. Do not flatten or remove legacy navigation.

## 4. Protocol

### 4.1 `projects`

On each client connect, relay sends these two messages in order, inside `handle_client`’s existing `try` block:

```json
{"type":"projects","projects":[{"id":"charts","label":"Charts","host":"local"}]}
{"type":"agents","agents":[...]}
```

`projects` omits cwd. The second message is cached latest snapshot, or an empty snapshot before first poll. Projects remain fixed until relay restart.

### 4.2 Existing `create_tab`

`create_tab {workspace_id}` remains a native layout command. Relay resolves `workspace_id` from exactly one live agent snapshot, obtains that agent’s remote host, and calls `herdr tab create --workspace <id> --focus` with `remote=`. Unknown or ambiguous workspace IDs return an error. Reply remains `tab_created`.

`create_tab` creates no agent and cannot create a Pair.

## 5. Ambiguous pane IDs

On every poll, recompute pane IDs present on more than one host. For these IDs, refuse `respond`, `read_pane`, `send_keys`, and `send_text` with `ambiguous pane_id (same id on multiple hosts)`. This prevents current last-host-wins misrouting. It clears within one poll after collision ends.

## 6. Acceptance

| # | Given | Then |
|---|---|---|
| A1 | Pane cwd equals or is below configured root | Correct `project_id`; longest root wins |
| A2 | Pane cwd is sibling prefix or wrong host | No `project_id`; shown as Other sessions |
| A3 | Zero-session configured Project | Visible card with “No sessions” |
| A4 | Config disabled | Existing workspace/tab navigation and `create_tab` remain available |
| A5 | Fresh client connects | Receives `projects`, then cached `agents` |
| A6 | Invalid config or relative config-file path | Relay exits non-zero naming path/entry |
| A7 | Same pane ID on two hosts | All four pane commands refuse; neither host is touched |
| A8 | Collision ends | Commands recover within one poll interval |
| A9 | `create_tab` targets remote live workspace | Tab is created on that remote, never local host |
| A10 | `create_tab` workspace unknown/ambiguous | Error; no tab created |
