# Implementation Plan — P2: Remote Start Session

**Spec:** `.workflow/03_specs/2026-08-08_start_agent_spec.md`
**Architecture:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs.md` §§2–5
**Depends on:** P1 (`relay/projects.py`, `pane_guard`, `resolve_workspace_remote`, `latest_agents`)
**Classification:** Class B — additive protocol extension
**Status:** Implemented. 116 unit tests green; 39/39 end-to-end checks pass across four relay
boots (boot refusal, gate off, gate on, herdr-failure injection).

## Goal

Start an allowlisted agent inside a configured Project from the browser, with no client-supplied
cwd, host, env, argv, tab ID, or prompt text. Off by default; refuses to run without a token.

## Changes

### New pure module `relay/start_agent.py`

Same shape as `projects.py`: stdlib only, no subprocess, no I/O. Everything that decides
*whether* a start is allowed lives here so it is testable without herdr.

- `ROLES = ("architect", "reviewer", "agent")` — fixed display metadata.
- `load_start_agents(raw)` — parse `HERDR_START_AGENTS`, ordered, deduplicated, each matching
  `^[a-z0-9_-]{1,32}$`. Empty/unset returns the default `["codex", "claude", "pi"]`. A malformed
  name raises `StartAgentConfigError`, which the relay turns into `exit(1)` like a bad Projects file.
- `next_role_label(role, project_id, agents)` — `"Architect 1"`, lowest unused positive `N` among
  live same-Project labels for that role. Cosmetic only (spec §2); parsing labels is deliberate.
- `validate_start_request(msg, projects, agents, allowed)` → `(plan, error)`. Enforces the spec §3
  order: name in allowlist, role in `ROLES`, `project_id` in `PROJECTS`, placement is one of the
  three with **exactly** its required field and no other, then the placement resolution:
  - `new_workspace` — no lookup. Safe for a remote Project (spec §4).
  - `new_tab` — `workspace_id` resolves through P1's `resolve_workspace_remote` (one distinct
    host), that host equals the Project's host, and at least one agent in it carries the
    Project's `project_id`. Both tests, not either.
  - `split` — `split_from` passes the P1 pane ambiguity guard, and the pane's host and
    `project_id` both equal the Project's.
  `plan` carries the resolved `cwd`, `remote`, `label`, and the herdr argument list — the caller
  supplies nothing from the wire.

Steps 5 and 6 call **different** guards on purpose: `workspace_id` and `pane_id` are separate ID
spaces that collide independently (D6). Reusing the pane set for a workspace check passes a
genuine two-host collision.

### Relay

- Startup: `START_AGENTS` via `load_start_agents`, `WRITE_EXT = os.environ.get("HERDR_ENABLE_WRITE_EXT") == "1"`.
  **`WRITE_EXT` without `HERDR_RELAY_TOKEN` exits non-zero** with a message naming both variables.
  This is the P2 boot invariant; nothing downstream re-checks it.
- Connect: send `start_options` after `projects`, only when `WRITE_EXT and PROJECTS`. Without
  Projects a start can never resolve a cwd, so advertising the feature would render a control
  that always errors.
- Handler `start_agent`: refuse immediately unless `WRITE_EXT`. Per-message token checks are
  **not** added — `process_request:368` already rejects the WebSocket handshake itself when
  `AUTH_TOKEN` is set, so an authenticated connection is the precondition, and the boot invariant
  guarantees the token exists whenever the handler is reachable.
- Execution helper (impure, in the relay): run the plan's herdr calls with `run_herdr_result`,
  parse the nested IDs recorded in spec §3 (`result.workspace.workspace_id`, `result.tab.tab_id`,
  `result.agent.pane_id`), rename the pane, audit, reply `command_result`.
- Any non-zero exit, malformed JSON, or missing ID ⇒ `ok:false` with no success claimed. A
  created-but-empty workspace or tab may remain; that is native layout, not a session (spec §3).

### Browser

- Store `startOptions` from the message; **absence is the feature gate** — no message, no control
  anywhere, so a default deployment stays pixel-identical to P1.
- Project card gets **Start session**, including zero-session Projects.
- Dialog: Role, Agent, placement. New tab lists only live workspaces of that Project; Split lists
  only live same-host panes of that Project. On success close and wait for the poll snapshot — the
  browser never invents a session. On error keep the dialog open and show the relay's message.

### Tests

- `tests/test_start_agent.py` — allowlist parsing, label allocation (gaps, renamed panes,
  per-Project scoping), and every refusal in spec §3: unknown agent, bad role, unknown Project,
  wrong/extra placement field, cross-host new tab, two-host `workspace_id` (A11), foreign or
  ambiguous `split_from`.
- Extend the two-host fake-herdr harness: start with the write gate **off** (refused, no herdr
  call) and **on** (correct argv on the correct host, proven from the fake-ssh log).

## Verification

```bash
source .venv313/bin/activate
python -m unittest discover -s tests -t tests
git diff --check
```

Manual: with `HERDR_ENABLE_WRITE_EXT=1` and a token, start into a zero-session Project, into a
live workspace, and beside a live pane; confirm the pane appears under the right Project on the
next poll with the expected `Role N` label. Without the flag, confirm no Start session control
renders at all.

## Acceptance

- Every P2 spec row A1–A11 passes.
- Relay refuses to boot with `HERDR_ENABLE_WRITE_EXT=1` and no token.
- No client-supplied cwd, host, env, argv, tab ID, or prompt text reaches herdr (D4).
- No edit to `relay/agent_state.py`, `relay/herdr_tui.py`, `relay/herdr_telegram.py`,
  `herdi-mac/`, or `herdi-ios/`.
- No P3 pair, transfer, prompt-seeding, or `send_text` cap change lands in this phase.
