# Spec — P2: Remote Start Session

**Date:** 2026-08-08
**Architecture:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs.md` §§2–5
**Decisions:** D1, D4, D6, D8
**Classification:** Class B — additive protocol extension.
**Status:** Implemented — `relay/start_agent.py`, `tests/test_start_agent.py`, `relay/herdr_relay.py`, `web/index.html`.
A1–A11 pass under the two-host fake-herdr harness with the write gate off and on.

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

> **Amended 2026-08-09 — the session name.** The dialog now carries an optional **Name** field,
> and `start_agent` an optional `label`. Present, it is the session name; absent, the relay derives
> `Role N` exactly as below. It is validated by `validate_pane_label` — 1–32 characters, no control
> characters, and no leading `-`, which would reach herdr as a flag.
>
> That name is also the **herdr agent name**, not just the pane label. P2 passed the allowlisted
> binary name there, and herdr enforces agent names unique per host, so the first start of an agent
> succeeded and every later one failed `agent_name_taken`. Before creating anything the relay reads
> the live names with `herdr agent list` — `pane list`, which the poll loop uses, does not report
> them — and appends a five-character suffix (`Backend-3F5YA`) when the chosen name is taken. The
> suffix is random rather than a counter because the read set is a snapshot: two starts inside one
> poll interval both see it before either lands. `command_result` returns the final `label`.

`N` is derived by parsing live pane labels, which has two accepted consequences: two starts issued inside one poll interval can both choose the same `N`, and a pane renamed by the user in herdr leaves the sequence. Neither is worth a reservation table — the label is a convenience, never an identifier, and nothing in the protocol resolves a session by it.

On success, close dialog and wait for normal poll snapshot. Browser does not invent a session locally. On error, keep dialog open and show relay error. No initial prompt is sent.

## 3. Protocol and relay contract

Relay sends this read-only options message immediately after the `projects` message on connect, and **only when `start_agent` will actually be accepted** — that is, `HERDR_ENABLE_WRITE_EXT=1` and `HERDR_RELAY_TOKEN` set (§7.3 of the architecture; the relay refuses to boot on the first without the second).

> **Amended 2026-08-09.** The token half of that rule is repealed for one configuration:
> `HERDR_LAN_OPEN=1` runs the LAN listener without a token by explicit choice, and `start_options`
> then reaches an unauthenticated LAN client. The external listener is never exempt, and without
> `HERDR_LAN_OPEN` the original refusal stands unchanged. See
> `.workflow/02_architecture/2026-08-09_dual_listener_access.md`.

```json
{"type":"start_options","agents":["codex","claude","pi"],"roles":["architect","reviewer","agent"]}
```

`agents` is the ordered `HERDR_START_AGENTS` allowlist; the browser must not maintain a separate list. `roles` is fixed display metadata, not instruction metadata.

**Presence of `start_options` is the browser's feature gate.** No message ⇒ no Start session control anywhere in the UI. Rendering the control unconditionally produces a button that always errors, which reads as a broken app rather than a disabled feature. This also keeps the default deployment — write extension off — visually identical to P1.

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
5. For New tab, `workspace_id` resolves under the P1 workspace rule (P1 spec §4.2): every live agent carrying that `workspace_id` is on **one** host, that host is the Project's host, and at least one of those agents has the matching `project_id`.
6. For Split, `split_from` passes the P1 pane ambiguity guard (P1 spec §5) and resolves to matching Project host and `project_id`.

Step 5 is a **one-distinct-host** test, not an at-least-one-match test. "At least one live pane on the Project's host" passes while a second host also reports `w8`, which is precisely the collision the guard exists to catch, and the tab would then be created on whichever host `pane_remote_map` happened to keep. Steps 5 and 6 use different guards because `workspace_id` and `pane_id` are separate ID spaces that collide independently.

The client never supplies cwd, host, env, argv, tab ID, or prompt text.

| Placement | Relay calls |
|---|---|
| New workspace | `workspace create --cwd <configured cwd> --label <Project label> --focus`; parse `result.workspace.workspace_id`; `agent start <name> --cwd <cwd> --workspace <id> --focus -- <name>` |
| New tab | `tab create --workspace <id> --focus`; parse `result.tab.tab_id`; `agent start <name> --cwd <cwd> --tab <id> --focus -- <name>` |
| Split | Resolve source `tab_id`; `agent start <name> --cwd <cwd> --tab <id> --split right --focus -- <name>` |

The `<name>` positional in those `agent start` rows is the session name per the 2026-08-09
amendment, not the agent binary; the binary remains the fixed argv element after `--`.

> **Amended 2026-08-09 — the shell pane.** `workspace create` and `tab create` each return a
> `root_pane`, and `agent start` anchored to that container *splits* it rather than reusing it. The
> table's two-call sequences therefore produced a half-width agent beside an idle shell on every
> New workspace and New tab start. The relay now closes `result.root_pane.pane_id` immediately
> after the agent's own pane exists — never before, since the shell is the container's only other
> pane and closing it first takes the container down. Split closes nothing: its sibling is a pane
> the user chose. A shell that will not close is logged and the start still reports `ok:true`; the
> session is up, only sharing the tab.
>
> §3's "created workspace/tab may remain as native empty layout" is repealed. A `agent start` that
> fails after the relay created a container now closes that container, because the relay minted the
> id seconds earlier and nothing of the user's can be inside it. Without the rollback every failed
> start left an empty workspace behind.

> **Amended 2026-08-09 — herdr 0.8.0 moves pane creation out of `agent start`.** Minimum herdr
> version is now 0.8.0. `agent start` no longer creates a pane: its grammar is
> `agent start <name> --kind <kind> --pane <id> [--timeout <ms>]`, and it *attaches* an agent to a
> pane already sitting at its interactive shell prompt. `--cwd`, `--workspace`, `--tab`, `--split`,
> and `--focus` no longer exist on it. The table above is superseded by:
>
> | Placement | Relay calls |
> |---|---|
> | New workspace | `workspace create --cwd <cwd> --label <Project label> --focus`; parse `result.workspace.workspace_id` and `result.root_pane.pane_id`; `agent start <agent name> --kind <name> --pane <root pane> --timeout 30000` |
> | New tab | `tab create --workspace <id> --cwd <cwd> --label <label> --focus`; parse `result.tab.tab_id` and `result.root_pane.pane_id`; `agent start` on that root pane |
> | Split | `pane split <split_from> --direction right --cwd <cwd> --focus`; parse `result.pane.pane_id`; `agent start` on that pane |
>
> Consequences, all of which *delete* prior behaviour:
>
> 1. **The shell pane amendment above is repealed.** The container's `root_pane` is now the pane the
>    agent takes over, so there is no idle shell to close. The relay issues no `pane close` on a
>    successful start, for any placement.
> 2. **Split no longer resolves the source pane's `tab_id`.** It splits by pane id, so the
>    `pane has no tab_id` refusal is withdrawn and the plan carries `split_from` instead.
> 3. **Split gains a rollback.** A failed split closes the pane the relay just created —
>    `pane close <new pane>` — and touches no tab or workspace.
> 4. `HERDR_START_AGENTS` is now an allowlist of herdr **agent kinds** (`--kind`), not of binaries on
>    the target host's PATH. herdr owns the kind enum and refuses an unknown one with its own
>    message; the relay does not mirror that enum.
>
> **The session name and the pane label are no longer the same string.** herdr 0.8.0 validates the
> agent name against `^[a-z][a-z0-9_-]{0,31}$` *before* it looks at the pane, so every label this
> spec derives — `Architect 1` — is refused outright as `invalid_agent_name`. The relay now slugs the
> label into the agent name (`Architect 1` → `architect-1`, falling back to the kind when a label
> slugs away to nothing) and keeps the label itself for `pane rename` and for the `label` in the
> reply. §2's "that name is also the herdr agent name" is therefore narrowed: the label is what the
> user sees and what the reply reports; the slug is what herdr is asked for. The uniqueness suffix
> from the 2026-08-09 naming amendment moves onto the slug and its alphabet is lowercase.

`agent start` blocks until the agent reaches interactive readiness. The relay passes `--timeout 30000`
explicitly and gives that one subprocess a longer timeout than the 15s every other herdr call uses —
otherwise a slow cold start is killed locally and reported as a failure while the agent is coming up.
The poll loop keeps 15s so a dead SSH host still fails fast.

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
| A10 | Write extension disabled | No `start_options` on connect; no Start session control rendered |
| A11 | New tab where the chosen `workspace_id` is also reported by a second host | Refused as ambiguous; no tab created on either host |

## 6. CLI verification record

Verified locally on 2026-08-08 using an unfocused `/tmp` scratch workspace: `workspace create --cwd --label`, `tab create --workspace`, `agent start --workspace`, and `pane rename "Architect 1"` all work. Returned IDs are nested as recorded in §3; `agent start` requires `-- <argv...>`, supplied as fixed `-- <name>`. P2 is no longer blocked on CLI signatures.
