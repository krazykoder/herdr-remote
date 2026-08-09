# Architecture — Projects and Session Pairs

**Date:** 2026-08-08
**Status:** **Proposal — under review.** Promote to `.workflow/02_architecture/` once accepted.
**Decisions:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs_decisions.md`
**Source notes:** `.workflow/07_dev_notes/2026-08-08_workspace_and_session_pair_initial_notes.md`
**Phase map:** `.workflow/07_dev_notes/2026-08-08_phase_map.md`
**Classification:** **Class B** — additive protocol extension, backward compatible. No existing message shape changes.

**Guiding constraint:** reuse the existing architecture wherever possible, and keep **every step manual in v1**. The relay gains as little as it can; the frontend holds the controls.

---

## 1. Proof of Discovery

No `.codegraph/` or `graphify-out/` in this repo; the map below was built by reading the code.

### Affected modules

| Path | Role today | Change |
|---|---|---|
| `relay/herdr_relay.py:176` `get_agents_from_host` | Only source of pane state | `[MODIFY]` resolve configured `project_id` |
| `relay/herdr_relay.py` startup | Loads relay configuration | `[MODIFY]` load and validate configured Projects |
| `relay/herdr_relay.py:437` `handle_client` | Client command switch and connection setup | `[MODIFY]` send Projects and handle `start_agent` |
| `relay/herdr_relay.py:523` `send_text` length guard | Caps client text at 1000 chars | `[MODIFY]` raise cap (§6.4) |
| `relay/herdr_relay.py:530` `create_tab` | Native workspace layout control | `[MODIFY]` resolve its host and retain it |
| `relay/agent_state.py` | Snapshot/merge helpers | **No change** — `project_id` stays out of `AGENT_EVENT_FIELDS` (D10) |
| `web/index.html:427-511` | Project, workspace and tab navigation | `[MODIFY]` add Projects above existing workspace/tab controls |
| `web/index.html:531-573` | Terminal view, `sendText` | `[MODIFY]` selection, shortcuts, transfer UI |
| `relay/herdr_tui.py`, `relay/herdr_telegram.py`, `herdi-mac/`, `herdi-ios/` | Consume `agents` snapshot | **No change** — additive fields, unknown types ignored |

### Invariants that must survive

1. **`known_panes` gate on every write command.** Enforced at `:473`, `:488`, `:497`, `:520`. New write commands inherit it.
2. **Allowlist-shaped write surface.** `SAFE_RESPONSES` (`:76`), `SAFE_KEYS` (`:77`), `send_text` length cap (`:523`). New commands extend this pattern; they do not introduce free-form execution.
3. **`audit()` on every write.** `:481`, `:505`, `:528`, `:534`.
4. **Route order in `process_request`.** The comment at `:366` is load-bearing: event push (`?d=`) must be handled before any static route, or events are silently dropped while the caller still gets 200. New routes go below.
5. **Snapshot fields are additive-only.** Five clients consume `agents`; `apply_agent_message` (`agent_state.py:33`) merges by `pane_id`.

### Blast radius

The relay is the core library and it must not be rewritten to gain a grouping feature. P1 is measured from the shipped diff; P2 and P3 remain plan estimates.

| Phase | `herdr_relay.py` | Other core | New files |
|---|---|---|---|
| P1 (shipped) | **+63 / −15**, seven localized edits (~10% of lines, mostly the `create_tab` and `pane_guard` blocks) | `agent_state.py` **unchanged** (D10) | `relay/projects.py` (149 lines, pure), `tests/test_projects.py` (228) |
| P1 browser (shipped) | `web/index.html` +91 / −36 — `renderWorkspaces` split into `hoistHtml` + `layoutHtml(list)` so the Project view reuses it | — | — |
| P2 (estimate) | ~+120, one new command handler | none | none |
| P3 (estimate) | one constant (`1000` → `4000`) | none | none |

Every P1 edit is an insertion into an existing function or a new module-level helper. No function changes signature, no control flow is restructured, no dependency is added, and `run_herdr`, `process_request`, `event_push`, the UDP and mDNS paths, the push-subscription code, `audit`, and both allowlists are untouched.

**Verified, not assumed:** the other four clients ignore both unknown message types and unknown JSON keys, so `projects` and `project_id` cannot break them — `herdr_tui.py:161-178` and `herdr_telegram.py:837-855` are `if/elif` chains with no `else`; `herdi-mac/Sources/RelayConnection.swift:303` and `herdi-ios/Sources/Services/RelayConnection.swift` end in `default: break`; and both Swift `AgentData` structs use synthesized `Decodable`, which drops unrecognized keys.

Three genuine behaviour changes, all intended:

1. `create_tab` can now return an error where it previously always "succeeded" against the local host. That is the G2 bug fix; its only caller is `web/index.html`.
2. The relay sends two messages on connect where it previously sent none (G3).
3. The relay can `exit(1)` at startup, only when `HERDR_PROJECTS_FILE` is set and invalid. New failure mode, deliberately fail-closed.

P2 is where the surface actually grows, and it is the phase gated off by default behind `HERDR_ENABLE_WRITE_EXT` plus a mandatory token (§7.3).

### Gaps found during discovery

| # | Finding | Consequence |
|---|---|---|
| G1 | `get_agents_from_host:195` filters `if p.get("agent")` — live panes alone cannot represent empty Projects | Projects must come from trusted configuration, not agent discovery. |
| G2 | `create_tab:535` calls `run_herdr(...)` with **no `remote=`** | Pre-existing bug: tab creation always targets local host, silently wrong for `HERDR_REMOTES`. Retain the control, but resolve the workspace host and pass it through `remote=`. |
| G3 | Nothing is pushed to a client on connect (`handle_client:461`) | Tolerable at a 2s poll for `agents`. Not tolerable for `projects`, which has no poll behind it, so connect-time push becomes required (§4.2). |
| G4 | `herdr` CLI already exposes every primitive needed | `agent start <name> [--cwd] [--tab] [--split right\|down]`, `pane split`, `pane send-text`, `tab create`. No new external machinery. |
| G5 | Pane IDs are reusable | A pinned pair can outlive its panes and end up pointing at a *different* agent. Drives the fingerprint design in §3.2. |
| G6 | `send_text` caps client text at 1000 chars (`:523`) | Fine for typing. Too small for a pasted diff or a block of pane output, which is exactly what transfer moves. Drives §6.4. |
| G7 | Relay and every client key pane state by bare `pane_id` (`herdr_relay.py:72-74`, `agent_state.py:33`, `web/index.html:531`) | **Pre-existing bug, not a limitation of this proposal.** `_poll_once:251-253` writes `pane_remote_map`, `known_panes` and `agent_cache` keyed on bare `pane_id` while iterating every host, so on a collision the last host polled wins. `respond`, `send_text`, `send_keys` and `read_pane` then resolve `remote` from that map (`:479`, `:491`, `:503`, `:526`) and **route to the wrong machine today**, with no pairs involved. herdr pane IDs are per-server counters (`w8:p1` form; `w8:t1` is a tab ID), so two hosts each starting fresh collide immediately — this is likely under `HERDR_REMOTES`, not theoretical. The real fix is a protocol-wide `(host, pane_id)` identity, which is Class C and out of scope here. **P1 ships the narrow mitigation (D6):** each poll recomputes the set of pane IDs reported by more than one host, and all four commands refuse with `ambiguous pane_id` rather than guessing — ~10 lines, fails closed, empty for single-host operators, self-heals in one poll interval. It cannot reach either colliding pane; not reaching the *wrong* one is the property that matters. On top of that: v1 pairs must be **same-host**, and the frontend's duplicate-ID check (§3.3) refuses the ambiguous case rather than pretending to resolve it. |

---

## 2. Concept: Project

**A Project is a configured launch target and grouping root.** It exists with zero live sessions. A herdr workspace and tab are the native terminal layout inside a Project, not competing concepts.

herdr's `workspace_id` and `tab_id` remain first-class UI controls. Project is the persistent outer grouping; workspace and tab are live layout levels below it.

**Configuration (D1):** `HERDR_PROJECTS_FILE` points to trusted JSON loaded by relay startup.

```json
[
  {"id":"herdr-remote","label":"herdr-remote","cwd":"/Users/towshif/code/python/herdr-remote","host":"local"},
  {"id":"charts","label":"Charts","cwd":"/Users/towshif/code/js/charts.TS","host":"local"}
]
```

`id` matches `^[a-z0-9_-]{1,64}$`, is unique, and is what browser sends. `cwd` must be absolute. `host` is `local` or configured `HERDR_REMOTES`; relay rejects invalid file at startup. Client never supplies path or host.

### 2.1 Session grouping

For every live pane, relay matches `host` and `cwd` against configured Projects. A Project matches when cwd equals its root or is below it at a path boundary. Overlapping roots use longest match. This is lexical; no git subprocesses or remote resolution.

- Agent started locally in herdr from configured Project root: **grouped under that Project.**
- Agent started locally from subdirectory of configured Project root: **grouped under that Project**; longest root wins.
- Agent outside every configured root: shown under **Other sessions**, never hidden.

**Grouping is derived from polled snapshots only (D10).** An unmatched pane's snapshot entry carries **no `project_id` field** — the key is absent, not `null` or `""`. A full `agents` snapshot replaces the browser list, so either representation would clear an old grouping; omission is the smaller additive wire shape. The frontend buckets every agent without a `project_id` into **Other sessions**.

Incremental `agent_update` messages carry no `project_id` at all — the field stays out of `AGENT_EVENT_FIELDS`. An update therefore never touches the browser's grouping, which keeps the value from the last snapshot until the next one replaces it wholesale (`apply_agent_message:36`). Maximum staleness is one `POLL_INTERVAL`, 2 seconds, and only for the rare case of an agent `cd`-ing across a configured root.

The alternative — resolving the Project inside `event_push` and emitting `project_id: null` to clear stale grouping — is correct as a merge rule and wrong as a design, because the host it would resolve against is untrustworthy. `agent_update_message:13-16` normalizes `host` by comparing it to `socket.gethostname()`, so a pushed event describes a pane by *hostname*, while configured Projects are keyed by `"local"` or the **SSH target string** from `HERDR_REMOTES`. For any remote pane those do not match, the resolve returns nothing, and the `null` then clears a grouping that was correct — turning a 2-second staleness window into a persistent wrong answer, on every event. Keeping the field out of the event path removes the trap and the mechanism together.

The path-boundary test is exact-or-descendant: `cwd == root` or `cwd.startswith(root + "/")`. Plain `startswith` is wrong — it groups `/code/herdr-remote-old` under `/code/herdr-remote`.

Symlinks are not resolved in v1. Configure canonical paths when they matter.

### 2.2 Browser workflow

1. Browser receives configured Projects and renders every Project card, including zero-session cards, in file order.
2. Opening a Project shows its live native workspaces; opening a workspace shows its tabs; opening a tab shows its agent sessions. The current workspace/tab chip UI is reused at those two levels.
3. **Start session** is the remote-spawn entry point. User selects session role (**Architect**, **Reviewer**, or **Agent**), an allowlisted agent (for example codex, claude, or pi), and one placement: **New workspace** (default), **New tab** in a selected Project workspace, or **Split** beside a selected Project agent.
4. New workspace creates a workspace at configured Project cwd, then starts chosen agent inside it. New tab creates a tab in selected live Project workspace, then starts chosen agent in that tab. Split starts chosen agent beside selected agent in its tab. There is no standalone empty-workspace action.
5. `+ Tab` remains a layout action: it creates an empty native tab in selected live workspace. It does not start an agent and cannot create a Pair. Use Start session → New tab when a new tab must immediately contain an agent. **Its result is not visible in herdr-remote:** `get_agents_from_host:195` filters `if p.get("agent")`, so an empty tab is absent from every snapshot until an agent is started in it — and Start session → New tab creates its own tab rather than adopting one. `+ Tab` therefore serves the operator sitting at the herdr terminal, and is verified with `herdr tab list`, not in the browser (D8).
6. After the agent starts, relay names its pane `Architect N`, `Reviewer N`, or `Agent N`; a new-tab start applies same label to its tab. `N` is the lowest unused positive number for that role among live sessions in the same Project. Role is naming only: no prompt is sent. `N` is derived by parsing live pane labels, so two starts issued within one poll interval can both pick the same `N`, and a pane renamed in herdr drops out of the numbering. Both are cosmetic and accepted — labels are a convenience, never an identifier.
7. A live agent pane is standalone by default. User may select two same-host panes and create a named local Pair; the pair only makes transfer easier. Unpairing never changes workspaces, tabs, or sessions.
8. Prompt shortcut buttons insert their `@...` string into the frontend composer; user edits and sends it. Composer is a multiline `<textarea>`: Enter creates newline; send button or Ctrl/Cmd+Enter sends.
9. Closing an agent leaves its Project card present. An empty workspace/tab is native herdr layout and may not be visible in the agent snapshot until it contains an agent; this is acceptable in v1.

---

## 3. Concept: Session Pair

**A Session Pair is two pinned agent panes the user works across.** Canonical case: architect Claude + reviewer codex.

**Definition (D2):** explicit, user-pinned, stored in this browser. Members may live in different tabs and Projects, but must share a host (§3.1, G7).

The pair is a **frontend binding, not a channel**. It does not move text — §6 does. It makes a known partner easy to select and never leaves this browser.

### 3.1 Persistence

`localStorage`, under one versioned frontend key. The relay stores no pair data and exposes no pair protocol.

```json
{
  "version": 1,
  "pairs": [
    {
      "id": "p_a1b2c3d4", "name": "Architecture review",
      "members": [
        {"pane_id": "w8:p1", "host": "local", "role": "architect", "agent": "claude", "cwd": "/Users/t/code/herdr-remote"},
        {"pane_id": "w8:p2", "host": "local", "role": "reviewer",  "agent": "codex",  "cwd": "/Users/t/code/herdr-remote"}
      ]
    }
  ]
}
```

`agent`, `cwd` and `host` are the **identity fingerprint**, captured at pin time. They are not display data — they exist to detect pane-ID reuse (G5).

`role` is a display label, defaulting to the agent name and renameable by the user. It exists because §6.2 attributes the transferred text (`feedback from architect (claude):`) — without it the receiving agent is told only which tool produced the text, not what job it was doing. Frontend state only; it never reaches a shell.

**Both members must share a `host`.** Cross-host pairs are refused at creation time — not for lack of ambition, but because G7 means the relay cannot reliably route to a colliding pane ID, and a pair that silently retargets another machine is the worst failure this feature can produce. Same-host is a v1 constraint that lifts for free once pane identity becomes `(host, pane_id)`.

### 3.2 Derived health — computed from each snapshot

| State | Condition | Effect |
|---|---|---|
| `healthy` | Both members match one live snapshot agent by `pane_id`, `host`, `agent`, and `cwd`, and neither `pane_id` is duplicated | Pair usable |
| `stale` | A member has no matching live agent or its `pane_id` is duplicated | Pair shown greyed; transfer UI disabled |

Neither state auto-deletes the pair. A stale pair recovers if its agent pane returns; otherwise user re-pairs it.

> This is the load-bearing safety property of the feature: **the UI must never offer to paste into a pane other than the one the user pinned.**

### 3.3 Limits

- Exactly 2 members in v1, both on the same host.
- Max 32 pairs per browser.
- A pair is usable only when both fingerprints match the current snapshot and both pane IDs are unique across it. This refuses ambiguous bare `pane_id`s (G7).
- **A pane may belong to at most one pair.** Allowing a pane in several pairs makes "resolve the other member" (§6.3) ambiguous, and the resolution — a pair picker in the transfer flow — buys nothing in v1 while adding a step to the one action this feature exists for. Pinning a pane that is already paired replaces the old pair after a confirm.

---

## 4. Protocol Delta

`projects` and `start_agent` are new. Pairing is local frontend state.

### 4.1 Client → Server

| type | Fields | Guards |
|---|---|---|
| `start_agent` | `name`, `role: "architect" \| "reviewer" \| "agent"`, `project_id`, `placement: "new_workspace" \| "new_tab" \| "split"`, optional `workspace_id` or `split_from` | `name` in `HERDR_START_AGENTS`; role is allowlisted naming data; configured Project; exactly placement field required; selected workspace/pane is live, same-host, and belongs to Project; **no argv, env, cwd, host, tab ID, or prompt accepted** |
| `create_tab` | `workspace_id` | workspace is live and unambiguous; relay resolves its host; existing command retained |

For `placement: "new_tab"`, relay resolves selected live workspace and creates the tab itself; client never sends a tab ID. For `placement: "split"`, relay resolves target tab from `agent_cache[split_from]["tab_id"]`. A workspace or split source outside the Project or on another host is refused.

Both placements inherit the ambiguity rules, and they are **different rules for different ID spaces**: `split_from` uses the pane guard (§5 of the P1 spec), `workspace_id` uses the one-distinct-host workspace test (§4.3). Checking a `workspace_id` for "at least one live pane on the Project's host" is not sufficient — that passes while another host also reports `w8`, which is exactly the collision the guard exists to catch.

There is no `transfer` command. Transfer is frontend-only (§6) and rides the existing `send_text`.

### 4.2 Server → Client

| type | Payload | When |
|---|---|---|
| `projects` | `{projects: [{id, label, host}]}` | On client connect |
| `start_options` | `{agents: [...], roles: ["architect", "reviewer", "agent"]}` | On client connect after P2 is enabled |

`projects` intentionally omits `cwd`; browser does not need it. `start_options.agents` is relay's allowlist, not a browser-owned list.

Two consequences of sending this only on connect, both accepted for v1 and both worth stating so they are not discovered as bugs:

- **The relay currently pushes nothing on connect.** `handle_client:461` adds the socket to `clients` and drops straight into the receive loop; the first `agents` snapshot arrives on the next poll tick, up to `POLL_INTERVAL` (2s) later. `projects` has no poll behind it, so connect-time push is now load-bearing rather than a nicety. Send the cached `agents` snapshot at the same moment — it costs one line and removes the empty-list flash the app has today.
- **Projects are fixed for the life of the relay process.** Editing `HERDR_PROJECTS_FILE` requires a restart, and connected clients will not see the change. Acceptable while the file is hand-maintained; if it starts changing often, re-read on `SIGHUP` and re-broadcast, which is additive.

### 4.3 Retained native layout control

`create_tab` remains. Before calling `herdr tab create`, relay resolves `workspace_id` against the live snapshot and passes the resolved remote host to `run_herdr`. An unknown or ambiguous workspace is refused. This fixes G2 without changing what `+ Tab` means.

**The resolution test is one host, not one agent.** herdr workspace IDs are per-server counters in the same way pane IDs are (G7), so `w8` can exist on `local` and on `devbox` simultaneously. The rule is therefore:

- collect every live agent whose `workspace_id` matches;
- **zero** matches → refuse (`unknown workspace_id`);
- matches spanning **more than one distinct host** → refuse (`ambiguous workspace_id`);
- otherwise → use that single host.

"Exactly one matching agent" would be wrong in the opposite direction: a workspace with three agents in it is the normal case, not an ambiguous one.

---

## 5. Starting Agents

**A new agent is started raw.** The relay runs the agent and stops there — no seed prompt, no wait-for-ready, no post-start input. The user drives the agent from the frontend afterwards using the instruction shortcuts in §6.1 (D5).

```python
# placement: "new_workspace" — default and zero-session path.
workspace_id = create_workspace(project.cwd, project.label, remote=project.remote)
run_herdr("agent", "start", name, "--cwd", project.cwd,
          "--workspace", workspace_id, "--focus", remote=project.remote)

# placement: "new_tab" — relay creates a tab in selected live workspace.
tab_id = create_tab(workspace_id, remote=project.remote)
run_herdr("agent", "start", name, "--cwd", project.cwd,
          "--tab", tab_id, "--focus", remote=project.remote)

# placement: "split" — tab resolved from same-Project, same-host source pane.
run_herdr("agent", "start", name, "--cwd", project.cwd,
          "--tab", tab_id, "--split", "right", "--focus", remote=project.remote)
```

> **The `remote=` argument is mandatory, not optional.** G2 is exactly this bug in `create_tab:535` — a `run_herdr` call that omits `remote=` silently targets local host and is wrong under `HERDR_REMOTES`. Both retained `create_tab` and every Start session placement must thread configured/resolved host through `remote=`. For `placement: "split"`, `split_from` must live on that same host (§4.1) — a split cannot cross hosts because `herdr agent start --tab` addresses one server.

`create_workspace` uses `herdr workspace create --cwd <project cwd> --label <project label> --focus`; `create_tab` uses `herdr tab create --workspace <id> --focus`. Both parse and validate their returned ID before starting an agent. If either command fails, relay returns an error and does not pretend a session exists. No prompt is sent, so readiness does not arise and `run_herdr`'s existing 15s timeout remains sufficient.

After `agent start`, relay parses `result.agent.pane_id`, allocates role label from live same-Project pane labels, and calls `herdr pane rename <pane_id> <Role N>` on same host. New-tab placement also creates tab with `<Role N>` label. If naming fails, command reports `ok:false`: agent may be alive, but user is told the named-session request did not complete.

> **P2 CLI contracts verified 2026-08-08.** An unfocused `/tmp` scratch workspace confirmed `workspace create --cwd --label` → `result.workspace.workspace_id`, `tab create --workspace` → `result.tab.tab_id`, `agent start --workspace` → `result.agent.pane_id`, and `pane rename <pane_id> "Architect 1"`. `agent start` requires `-- <argv...>`; relay supplies fixed `-- <name>` from its allowlist. The browser continues to send no argv.

---

## 6. Instruction Shortcuts and Transfer

**Transfer is copy-and-paste in the frontend.** No relay command, no server-side composition, no preset table in Python. The user selects text in one pane's view, picks an instruction shortcut, and the frontend switches to the paired pane and prefills its composer. Every step is a deliberate action (D3).

### 6.1 Instruction shortcuts

A dropdown in the terminal view inserts a shortcut string at the top of the composer. Shortcuts live in a `const` array in `web/index.html` alongside the rest of the app — single file, no build step, consistent with how the app already carries its themes and key presets.

Prompts are referenced by **path**, not pasted inline. The agent resolves the file itself, so the relay and the frontend never carry prompt copy:

```
@.agent/prompts/System_Prompt_2_Architect.md
```

Starter set, from the source proposal:

| Shortcut | Inserted text |
|---|---|
| Review | `Review, edit, fix; then propose next steps.` |
| Implement | `Proceed to implement.` |
| Architect prompt | `@.agent/prompts/System_Prompt_2_Architect.md ; /ponytail /caveman` |

Shortcut buttons insert text at cursor in multiline `termInput`; they never send. The set is editable by operator; frontend treats it as data, not fixed list.

### 6.2 Composed payload

The frontend builds:

```
{instruction}

feedback from {from_role} ({from_agent}):     # role per §3.1, defaults to agent name
<<<TRANSFER
{text}
TRANSFER>>>
```

**The fence is not decoration.** Without it, transferred pane content containing a line like `Proceed to implement` is indistinguishable from the operator's own instruction. The delimiter gives the receiving agent an unambiguous boundary for the quoted region.

### 6.3 Prefill, do not auto-send

The transfer action captures current text selection, resolves other healthy pair member, switches `activePane` to it, then places composed text in multiline `termInput` and stops. User reads it and presses Send. Enter inserts newline; Ctrl/Cmd+Enter and Send submit. This is last checkpoint before one agent's output enters another agent's context.

Sending then reuses the existing path unchanged: `send_text`, then `send_keys ["Enter"]` (`web/index.html:568-569`).

### 6.4 P3 preflight — delivery behavior

Before any P3 code, its implementer runs these checks against a live scratch pane and records the date, pane/agent, and PASS or FAIL in the P3 spec. P3 cannot begin until the newline result selects its sending path.

**(a) Length.** `send_text` refuses text over 1000 chars (`:523`). A pasted diff blows through that. Raise the cap to 4000 — one constant, and the guard stays in place, because an unbounded write is a genuine abuse vector, not a formality. The alternative, chunking client-side into sub-1000 sends, is rejected: it risks a partial payload landing in the agent if a chunk fails midway.

**(b) Newlines.** The payload is multi-line and agent TUIs treat Enter as submit. Whether embedded newlines submit early depends on whether `herdr pane send-text` emits a bracketed paste. The `herdr agent` help distinguishes `agent send` ("writes literal text") from `pane run` ("command text plus Enter"), which suggests it does — verify rather than assume:

```bash
# Against a scratch pane with a live agent:
herdr pane send-text <pane_id> $'line one\nline two\nline three'
herdr pane read <pane_id> --lines 20
# PASS: all three lines sit unsubmitted in the agent's composer.
# FAIL: "line one" was submitted on its own.
```

On FAIL, the fallback is per-line `send-text` with `M-Enter` (Alt+Enter — newline without submit in Claude Code and codex) between lines, which requires adding `M-Enter` to `SAFE_KEYS` (`:77`). Do not fall back to flattening newlines into spaces; the payload is usually code or diffs.

**Attempt record, 2026-08-08:** the command was sent to an unfocused scratch Codex pane and then an existing idle Codex pane. The scratch pane exited before it could be read; both `pane read` and `agent read` returned no visible text for the existing pane. Result: **INCONCLUSIVE**. A visible live terminal must repeat the check and record PASS or FAIL before P3 begins; `C-c` was sent once to clear any unsent test input from the existing pane.

---

## 7. Security

Written plainly and deliberately. Moving transfer to the frontend removes one relay-side vector but does not remove the underlying risk — it relocates it to a place where a human is structurally required to look at it.

### 7.1 `start_agent` spawns a process from a network request

`herdr agent start` accepts `-- <argv...>`, which is arbitrary command execution. The mitigations are structural, not advisory:

- The client sends an **agent name** and a `project_id`. Never an argv, never an env, never a path, never prompt text.
- `name` must appear in `HERDR_START_AGENTS` (default: `codex,claude,pi`).
- `project_id` must exist in configured Projects. Relay looks up cwd and host itself; client-supplied paths and hosts are never honoured.
- Every start is audited via the existing `audit()` helper, recording `name`, `project_id`, `role`, and `placement`.

### 7.2 Transfer is still a prompt-injection path, now human-gated

Agent A's pane content may contain text A fetched from the internet. Transfer moves that text into agent B's prompt. The relay no longer participates, so containment is structural rather than enforced:

- **The user selects the text.** Only a selection moves, never a whole scrollback.
- **The composer is prefilled, not sent** (§6.3). The operator sees the exact payload and presses send.
- The payload is fenced (§6.2) so the receiving agent can see the boundary.
- The `send_text` cap (§6.4) still bounds the volume, and the existing `audit()` at `:528` still records it.

No auto-relay in v1 (D3). Deferring it is what keeps a human on every hop.

### 7.3 Authentication must become mandatory for these commands

The relay binds `0.0.0.0` (`:596`) and `HERDR_RELAY_TOKEN` is **optional** today (`:47`). That is defensible for a read-mostly relay with allowlisted responses. It is not defensible once `start_agent` exists.

**Requirement:** the relay refuses to start if the write-extension commands are enabled without a token.

```
HERDR_ENABLE_WRITE_EXT=1 without HERDR_RELAY_TOKEN  ->  exit(1) with a clear message
```

`start_agent` is gated on `HERDR_ENABLE_WRITE_EXT`; the default is off, so an existing deployment gains no new surface until the operator opts in and sets a token. The raised `send_text` cap (§6.4) is **not** gated — it applies to an existing command and is a size change, not a new capability.

Confirmed during discovery: the token check in `process_request` (`:334-347`) runs **before** the WebSocket upgrade check (`:349-355`), so WebSocket connections are already covered by it.

---

## 8. Phasing

| Phase | Scope | Touches | Gate |
|---|---|---|---|
| **P1 — Projects** | Load `HERDR_PROJECTS_FILE`; emit `projects` and cached `agents` on connect; resolve each live pane by longest configured root; refuse ambiguous pane IDs (D6); add Project outer navigation; retain/fix workspace, tab, and `create_tab` controls | `projects.py` (new), `herdr_relay.py`, `web/index.html`, tests | Root/subdirectory sessions group under Project; unmatched session appears under Other sessions; zero-session Project appears; config-disabled workspace UI is unchanged; remote `create_tab` reaches remote host; duplicate pane ID is refused. **Specced:** `03_specs/2026-08-08_projects_spec.md`. **Planned:** `04_implementation_plans/2026-08-08_p1_projects.md` |
| **P2 — Start session** | `start_agent` raw, no seeding; New workspace/New tab/Split placements; allowlists + `HERDR_ENABLE_WRITE_EXT` + token | `herdr_relay.py`, `web/index.html`, tests | Zero-session local/remote Project starts agent in new workspace; New tab and Split stay same-Project/same-host; invalid placement/refused source fails safely; audit line present. **Specced:** `03_specs/2026-08-08_start_agent_spec.md` |
| **P3 — Local pairs + transfer UI** | **Preflight:** P3 implementer runs §6.4 against a live scratch pane and records the result in P3 spec. Then `localStorage` pairs, pair editor, selection, prompt shortcut buttons, multiline composer, partner-composer prefill; `send_text` cap raised | `web/index.html`, one constant in `herdr_relay.py` | Preflight PASS uses one `send_text`; FAIL uses per-line `send_text` plus `M-Enter`. Then Pair survives page reload; cross-host pin refused; pinning an already-paired pane replaces after confirm; stale or duplicated fingerprint disables transfer; prompt button only inserts `@...`; Enter adds newline, Ctrl/Cmd+Enter sends; a 3000-char selection transfers intact; prefill never auto-sends; oversize text still refused |
| **P4 — Deferred** | Authenticated last-write-wins frontend-preferences sync; auto-relay with per-pair opt-in and hop cap; 3+ member groups; git/worktree-aware Projects; server-side instruction presets shared across clients | — | Not specced. Sync requires an authenticated user/profile model; auto-relay requires its own threat model. |

Each phase is independently shippable. P3 does not depend on P2.

---

## 9. Decisions

Logged in `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs_decisions.md`.

| ID | Decision |
|---|---|
| D1 | Projects are trusted configured `{id, cwd, host}` launch targets; grouping uses longest lexical cwd-root match |
| D2 | Session Pairs are named, fingerprinted frontend state; relay sync is deferred |
| D3 | Every step is manual in v1; transfer is frontend copy-paste with no relay command |
| D4 | `start_agent` is restricted to allowlisted agent names in configured Projects |
| D5 | Agents start raw — no seed prompt; instruction shortcuts are frontend-side path references |
| D6 | Ambiguous pane IDs are refused, not resolved — the narrow G7 mitigation, shipped in P1 |
| D7 | Projects render in configured file order and never reorder by activity |
| D8 | Projects contain native workspaces/tabs; pairs contain agent panes; Start session has New workspace/New tab/Split placements |
| D9 | Start role names the tab/pane only; prompts use explicit multiline-composer shortcuts |
| D10 | Grouping is snapshot-derived only; `project_id` never travels on an incremental `agent_update` |

---

## 10. Open Questions for Phase 3 (Specs)

Two are **experiments, not judgement calls** — each can force a design change rather than a parameter change, and each needs a live herdr. Neither blocks P1.

1. **Multi-line delivery** (§6.4b) — does `herdr pane send-text` bracket-paste? Required P3 preflight; record result before P3 implementation.
2. ~~**Layout CLI signatures**~~ — **verified 2026-08-08:** nested result paths plus required fixed `-- <name>` argv are recorded in §5 and the P2 spec.
3. **Pair creation UI** — confirm whether the pair editor lives on agent cards, terminal header, or both.
4. ~~**Project ordering in the client**~~ — **resolved (D7):** configured file order, never reordered by activity.
5. **Pair sync** — keep deferred until named local pairs prove useful; then add authenticated, last-write-wins frontend-preferences sync.
