# Implementation Report — P1: Projects and Native Layout

**Date:** 2026-08-08
**Branch:** `feat/projects` (3 code commits: `51aa010`, `5b7daef`, `558a34d`)
**Spec:** `.workflow/03_specs/2026-08-08_projects_spec.md`
**Plan:** `.workflow/04_implementation_plans/2026-08-08_p1_projects.md`
**Architecture:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs.md`
**Classification:** Class B — additive, backward compatible
**Status:** Complete. All acceptance rows A1–A13 pass.

---

## 1. What shipped

An outer **Project** layer above herdr's native workspace/tab navigation. Projects are
trusted `{id, label, cwd, host}` entries from `HERDR_PROJECTS_FILE`; they exist with zero
live sessions, and every polled pane is matched to the longest same-host configured root.
Native workspace and tab controls are retained beneath, not replaced (D8).

| File | Diff | Role |
|---|---|---|
| `relay/projects.py` | **new, 162** | Pure: load/validate config, resolve roots, ambiguity sets |
| `tests/test_projects.py` | **new, 245** | Config validation, resolution, annotation, both ambiguity guards |
| `relay/herdr_relay.py` | **+64 / −15** | Seven localized edits |
| `web/index.html` | **+91 / −36** | Project layer + one refactor |
| `relay/projects.example.json` | **new, 5** | Documented config shape |
| `relay/agent_state.py` | **unchanged** | Required by D10 |

### Relay edits

1. Import `projects`, load `PROJECTS` at startup, fail closed with `exit(1)` on any config error.
2. `get_all_agents` returns `annotate_agents(agents, PROJECTS)` — one annotation point.
3. Globals `ambiguous_panes` and `latest_agents`.
4. `pane_guard(pane_id)` — one helper replacing four copies of the `known_panes` check.
5. `_poll_once` caches the snapshot and recomputes the ambiguity set each cycle.
6. `create_tab` resolves its workspace's host and passes `remote=`.
7. `handle_client` pushes `projects` then the cached snapshot — gated on Projects existing.

### Browser change

`renderWorkspaces` was split into `hoistHtml(list)` and `layoutHtml(list)`. The Project view
and the legacy view now call the same layout code over different lists instead of duplicating
it. `renderProjects` and `projectCard` are the only genuinely new rendering functions.

---

## 2. Verification

### End to end, not only unit tests

A harness with a fake `herdr` and a fake `ssh` simulated two hosts carrying **a deliberate
`w8:p1` pane collision and a `w8` workspace collision** — the exact conditions G7 and G2
describe, which a single-host machine cannot produce. 21/21 checks passed:

| Area | Result |
|---|---|
| A1 | Descendant cwd and remote pane both grouped to the right Project |
| A2 | Unmatched pane omits the key; no `project_id: null` anywhere on the wire |
| A3 | Zero-session Project card present |
| A5 | `projects` first, then cached `agents`; cwd never sent |
| A7 | All four pane commands refuse the colliding ID; unambiguous panes unaffected |
| A9 | Remote `create_tab` reached the remote — proven from the fake-ssh log: `box tab create --workspace w2 --focus` |
| A10 | Unknown and two-host workspaces both refused |
| A4 | With config unset, the connect wire and `create_tab` behave exactly as before P1 |
| A6 | Relative path, unknown host, and malformed JSON each exit 1 naming path and entry |

### Against the real herdr

Live panes on the operator's machine, with the real three-Project config:

```
projects: ['herdr-remote', 'charts.TS', 'tsignal']
  w8:p1  claude  -> charts
  w9:p1  codex   -> charts
```

### UI

Headless screenshots of four states: Projects list, Project selected, Project + workspace +
tab, and legacy (config disabled). Hierarchy nests correctly, blocked hoist stays global and
on top, zero-session Project reads "No sessions", unmatched panes land under Other sessions.

An apparent horizontal overflow in the first screenshots was traced to headless Chrome
ignoring `--window-size` for the viewport (500px, not 430) — confirmed by probing
`scrollWidth` on a blank page. Not an app defect; no layout change was made on a false alarm.

### Suite

82 unit tests pass. `git diff --check` clean. No edit to `herdr_tui.py`, `herdr_telegram.py`,
`herdi-mac/`, or `herdi-ios/` (A13).

---

## 3. Deviations from the plan

Three, each deliberate and reflected back into the spec.

**1. Duplicate roots are rejected per `(host, cwd)`, not per `cwd`.** The spec said
"duplicate ID/root". Taken literally that refuses the ordinary case of one repo checked out
on both a laptop and a build box, which resolves unambiguously because the host differs.

**2. `~` expands, but only for local entries.** The configs are hand-written and the operator
supplied `~` paths. A remote entry's `cwd` starting with `~` is *refused*: `expanduser`
resolves against the relay's home, not the SSH target's, and would silently name a path that
may not exist there.

**3. Connect-time push is gated on Projects existing.** Emitting `projects: []` to a
config-disabled relay would itself be a new message on a wire A4 requires to be unchanged.
Found during review; code and docs are now aligned.

---

## 4. Behaviour changes to be aware of

1. **`create_tab` can now fail.** Previously it always "succeeded" against the local host.
   Unknown or two-host workspaces are refused. This is the G2 fix; the only caller is the
   web app.
2. **Startup can `exit(1)`.** Only when `HERDR_PROJECTS_FILE` is set and invalid. Deliberately
   fail-closed — but it means a typo in `projects.json` takes the relay down rather than
   silently disabling Projects.
3. **Two messages on connect** where there were none, when Projects are configured (G3).

---

## 5. Deployment

```
~/.config/herdr-remote/projects.json   three local roots (herdr-remote, charts.TS, tsignal)
~/.config/herdr-remote/config.env      exports HERDR_PROJECTS_FILE, HERDR_TUNNEL_MODE=none
```

`relay/start.sh` sources `config.env`; a bare `uv run` does **not**, and would start with
Projects silently disabled. LAN-only, no tunnel. The relay serves the web app on the same
port (`herdr_relay.py:419`).

Security note carried forward, unchanged by P1: the relay binds `0.0.0.0` and
`HERDR_RELAY_TOKEN` is optional, so anyone on the LAN can approve, deny, and send text to
agents. P2's `start_agent` is gated behind `HERDR_ENABLE_WRITE_EXT` plus a *mandatory* token
for exactly this reason.

---

## 6. Open items

| # | Item | Blocks | Owner |
|---|---|---|---|
| 1 | **P3 bracketed-paste preflight is INCONCLUSIVE.** Both attempts read empty — the scratch pane exited, the existing pane produced no visible text. INCONCLUSIVE is not FAIL; the sending path cannot be chosen from it. Retry needs a visible, focused pane. The FAIL fallback also requires adding `M-Enter` to `SAFE_KEYS`, so a wrong call costs a protocol change, not a constant. | P3 | User |
| 2 | **Relay wedge, cause unproven.** One instance hung with the event loop blocked acquiring a threading lock; HTTP and WebSocket both stopped, and `SIGTERM` could not kill it because the handler runs on the blocked loop. Ruled out: slow herdr (0.00s), dependency skew (identical versions under `uv run` and the venv), log rotation (7KB, never rotated). Pre-existing — nothing in P1 touches threads, locks, or logging, and the pre-P1 relay ran three hours before being killed. **If it recurs, do not kill it**; a live `sample` while its threads exist would settle the cause. | nothing | — |
| 3 | **`start.sh` misreports startup failures.** It prints "Check if port 8375 is in use" for *any* death within 2s, including a fail-closed config `exit(1)` whose real message goes to stderr. This actively misled diagnosis once already. | nothing | — |
| 4 | Promotion of these docs from `07_dev_notes/` to `02_architecture/` | — | User |

---

## 7. P2 readiness

**Ready.** The four CLI signatures that blocked the P2 spec were run and recorded, and the
returned ID paths are nested rather than flat:

| | Verified |
|---|---|
| Workspace ID | `result.workspace.workspace_id` |
| Tab ID | `result.tab.tab_id` |
| Pane ID | `result.agent.pane_id` |
| `pane rename <pane_id> "Architect 1"` | accepts a spaced label |
| `agent start` | **requires** `-- <argv...>` |

Confirmed independently against `herdr agent start --help`:

```
usage: herdr agent start <name> [--cwd PATH] [--workspace ID] [--tab ID]
       [--split right|down] [--env KEY=VALUE] [--focus|--no-focus] -- <argv...>
```

Because argv is required, the relay must always supply it. It supplies a fixed `-- <name>`
derived from the already-allowlisted agent name, so D4 holds: no argv, env, cwd, host, tab
ID, or prompt text reaches the CLI from a client. The consequence worth stating plainly is
that the relay will exec whatever binary matches an allowlisted name on the target host's
PATH — **`HERDR_START_AGENTS` is doing all of the security work**, which is the intended
design, not an oversight.

Nothing left to discover for P2. Remaining work is new code: the `start_agent` handler,
`HERDR_START_AGENTS`, the `HERDR_ENABLE_WRITE_EXT` + mandatory-token gate, `start_options`
on connect, the `Role N` allocator, and the Start session dialog. Suggested order, mirroring
P1: relay validation and handler with tests, then the dialog, then an end-to-end run against
the fake-herdr harness with the write gate both on and off.

**P3 remains blocked** on item 1 above.
