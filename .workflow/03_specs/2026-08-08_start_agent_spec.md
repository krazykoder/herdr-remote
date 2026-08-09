# Spec — P2: Remote Start Session

**Date:** 2026-08-08
**Architecture:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs.md` §§2–5
**Decisions:** D1, D4, D6, D8
**Classification:** Class B — additive protocol extension.
**Status:** Proposed

## 1. Goal

Start raw allowlisted agents remotely inside configured Projects. A session may remain standalone or be locally paired later; starting a session never creates, changes, or requires a Pair.

## 2. Browser flow

Project card exposes **Start session**. Dialog has two dropdowns: Role and Agent. Role choices are Architect, Reviewer, and Agent; they are user-convenience names only and never change agent context. Agent choices come from relay `start_options.agents` (default `codex`, `claude`, `pi`).

| Placement | Required choice | Relay operation |
|---|---|---|
| **New workspace** (default) | Agent | Create Project workspace, then start agent in it |
| **New tab** | Agent + live Project workspace | Create tab in workspace, then start agent in it |
| **Split** | Agent + live Project agent pane | Start agent beside selected pane in its tab |

New workspace is available on every Project card, including zero-session Projects. New tab lists only live workspaces containing an agent whose `project_id` matches selected Project. Split lists only live, same-host panes with that `project_id`. Empty native tabs created through `+ Tab` are layout-only and are not choices in P2 because they are absent from agent snapshots.

Relay names new pane `Role N`, where `N` is the lowest unused positive number among live same-Project labels matching that Role. New-tab placement uses same label for created tab. Naming is cosmetic: no pair is created, no routing changes, and no prompt is sent. If pane renaming fails after agent start, return `ok:false` and state that agent may already be running.

On success, close dialog and wait for normal poll snapshot. Browser does not invent a session locally. On error, keep dialog open and show relay error. No initial prompt is sent.

## 3. Protocol and relay contract

After P2 is enabled, relay sends this read-only options message immediately after the `projects` message on connect:

```json
{"type":"start_options","agents":["codex","claude","pi"],"roles":["architect","reviewer","agent"]}
```

`agents` is the ordered `HERDR_START_AGENTS` allowlist; the browser must not maintain a separate list. `roles` is fixed display metadata, not instruction metadata.

```json
{
  "type": "start_agent",
  "name": "claude",
  "role": "architect",
  "project_id": "charts",
  "placement": "new_workspace"
}
```

For `new_tab`, add `workspace_id`. For `split`, add `split_from`. Exactly one placement-specific field is present; no other fields are accepted.

Relay validates, in order:

1. `HERDR_ENABLE_WRITE_EXT=1` and authenticated token are required.
2. `name` appears in `HERDR_START_AGENTS`; `role` is exactly `architect`, `reviewer`, or `agent`.
3. `project_id` exists in `PROJECTS`; relay obtains cwd and remote host only from that entry.
4. Placement is one of three values and has exactly its required field.
5. For New tab, `workspace_id` resolves to at least one live unambiguous pane on Project host with matching `project_id`.
6. For Split, `split_from` passes existing pane ambiguity guard and resolves to matching Project host and `project_id`.

The client never supplies cwd, host, env, argv, tab ID, or prompt text.

| Placement | Relay calls |
|---|---|
| New workspace | `workspace create --cwd <configured cwd> --label <Project label> --focus`; parse `result.workspace_id`; `agent start <name> --cwd <cwd> --workspace <id> --focus` |
| New tab | `tab create --workspace <id> --focus`; parse `result.tab_id`; `agent start <name> --cwd <cwd> --tab <id> --focus` |
| Split | Resolve source `tab_id`; `agent start <name> --cwd <cwd> --tab <id> --split right --focus` |

Every call passes `remote=None` for `local`, otherwise configured SSH target. Commands use `run_herdr_result`; non-zero exits, malformed JSON, or missing returned IDs return `command_result {command:"start_agent", ok:false}`. Do not report success after a partial operation: created workspace/tab may remain as native empty layout, but no session is claimed.

Successful calls audit `name`, `project_id`, role, and placement, then reply `command_result {command:"start_agent", ok:true}`. Session appears on next normal poll.

## 4. Boundaries

- `create_tab` remains a separate layout command. It returns `tab_created` and starts no agent.
- Pair creation, transfer, prompt seeding, and browser preference sync are out of scope.
- Prompt shortcuts and multiline-composer behavior belong to P3. They do not participate in starting a session.
- Cross-host split, New tab, and Pair creation are refused. New workspace is safe for configured remote Project because it has no pane lookup.

## 5. Acceptance

| # | Given | Then |
|---|---|---|
| A1 | Zero-session local or remote Project, New workspace | Workspace and raw agent start on configured host/cwd |
| A2 | Live matching Project workspace, New tab | New tab and raw agent start on same host |
| A3 | Live matching Project pane, Split | New agent starts beside it in same tab |
| A4 | Unknown agent/project, wrong placement fields, cross-host or foreign source | Refused; no start command |
| A5 | Missing token or write extension disabled | Refused before herdr call |
| A6 | Workspace/tab creation fails or returns no ID | `ok:false`; no agent start attempted |
| A7 | Agent start fails after layout creation | `ok:false`; no session claimed |
| A8 | Successful start | Audit entry; next poll shows agent under selected Project |
| A9 | Architect/Reviewer/Agent choice | Correct cosmetic `Role N` pane label; no prompt or Pair created |
