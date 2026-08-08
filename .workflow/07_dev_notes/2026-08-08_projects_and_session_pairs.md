# Architecture — Projects and Session Pairs

**Date:** 2026-08-08
**Status:** **Proposal — under review.** Promote to `.workflow/02_architecture/` once accepted.
**Decisions:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs_decisions.md`
**Source proposal:** `.workflow/07_dev_notes/2026-08-08_workspace_and_session_pair_proposal.md`
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
| `relay/herdr_relay.py:530` `create_tab` | Tab creation | `[DELETE]` superseded by `start_agent` |
| `relay/agent_state.py` | Snapshot/merge helpers | `[MODIFY]` add `project_id` to field tuple |
| `web/index.html:427-511` | `render` / `renderWorkspaces` / `createTab` | `[MODIFY]` Projects replace workspace chips |
| `web/index.html:531-573` | Terminal view, `sendText` | `[MODIFY]` selection, shortcuts, transfer UI |
| `relay/herdr_tui.py`, `relay/herdr_telegram.py`, `herdi-mac/`, `herdi-ios/` | Consume `agents` snapshot | **No change** — additive fields, unknown types ignored |

### Invariants that must survive

1. **`known_panes` gate on every write command.** Enforced at `:473`, `:488`, `:497`, `:520`. New write commands inherit it.
2. **Allowlist-shaped write surface.** `SAFE_RESPONSES` (`:76`), `SAFE_KEYS` (`:77`), `send_text` length cap (`:523`). New commands extend this pattern; they do not introduce free-form execution.
3. **`audit()` on every write.** `:481`, `:505`, `:528`, `:534`.
4. **Route order in `process_request`.** The comment at `:366` is load-bearing: event push (`?d=`) must be handled before any static route, or events are silently dropped while the caller still gets 200. New routes go below.
5. **Snapshot fields are additive-only.** Five clients consume `agents`; `apply_agent_message` (`agent_state.py:33`) merges by `pane_id`.

### Gaps found during discovery

| # | Finding | Consequence |
|---|---|---|
| G1 | `get_agents_from_host:195` filters `if p.get("agent")` — live panes alone cannot represent empty Projects | Projects must come from trusted configuration, not agent discovery. |
| G2 | `create_tab:535` calls `run_herdr(...)` with **no `remote=`** | Pre-existing bug: tab creation always targets the local host, silently wrong for `HERDR_REMOTES`. Only caller is `web/index.html:509`. Deleting it removes the instance but not the trap — `start_agent` is the same shape of call and must thread the Project's configured host through `remote=` (§5). |
| G3 | Nothing is pushed to a client on connect (`handle_client:461`) | Tolerable at a 2s poll for `agents`. Not tolerable for `projects`, which has no poll behind it, so connect-time push becomes required (§4.2). |
| G4 | `herdr` CLI already exposes every primitive needed | `agent start <name> [--cwd] [--tab] [--split right\|down]`, `pane split`, `pane send-text`, `tab create`. No new external machinery. |
| G5 | Pane IDs are reusable | A pinned pair can outlive its panes and end up pointing at a *different* agent. Drives the fingerprint design in §3.2. |
| G6 | `send_text` caps client text at 1000 chars (`:523`) | Fine for typing. Too small for a pasted diff or a block of pane output, which is exactly what transfer moves. Drives §6.4. |
| G7 | Relay and every client key pane state by bare `pane_id` (`herdr_relay.py:72-74`, `agent_state.py:33`, `web/index.html:531`) | **Pre-existing bug, not a limitation of this proposal.** `_poll_once:251-253` writes `pane_remote_map`, `known_panes` and `agent_cache` keyed on bare `pane_id` while iterating every host, so on a collision the last host polled wins. `respond`, `send_text`, `send_keys` and `read_pane` then resolve `remote` from that map (`:479`, `:491`, `:503`, `:526`) and **route to the wrong machine today**, with no pairs involved. herdr pane IDs are per-server counters (`w8:p1` form; `w8:t1` is a tab ID), so two hosts each starting fresh collide immediately — this is likely under `HERDR_REMOTES`, not theoretical. The real fix is a protocol-wide `(host, pane_id)` identity, which is Class C and out of scope here. **P1 ships the narrow mitigation (D6):** each poll recomputes the set of pane IDs reported by more than one host, and all four commands refuse with `ambiguous pane_id` rather than guessing — ~10 lines, fails closed, empty for single-host operators, self-heals in one poll interval. It cannot reach either colliding pane; not reaching the *wrong* one is the property that matters. On top of that: v1 pairs must be **same-host**, and the frontend's duplicate-ID check (§3.3) refuses the ambiguous case rather than pretending to resolve it. |

---

## 2. Concept: Project

**A Project is a configured launch target and grouping root.** It exists with zero live sessions and is deliberately *not* herdr's workspace.

herdr's `workspace_id` and `tab_id` remain on the pane snapshot as raw metadata. They are not a user-facing concept in herdr-remote and the workspace/tab chip strips (`web/index.html:447-472`) are removed.

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

An unmatched pane carries **no `project_id` field at all** — the key is absent rather than `null` or `""`. This matters for `agent_state.py`: `complete_agent_update_message:24` treats empty values as "keep the previous value" for required fields, and `apply_agent_message:49` merges with `dict.update`, so a `null` would be indistinguishable from "unchanged" and could resurrect a stale grouping after a pane's cwd changes. Absent is unambiguous. The frontend buckets every agent without a `project_id` into **Other sessions**.

The path-boundary test is exact-or-descendant: `cwd == root` or `cwd.startswith(root + "/")`. Plain `startswith` is wrong — it groups `/code/herdr-remote-old` under `/code/herdr-remote`.

Symlinks are not resolved in v1. Configure canonical paths when they matter.

### 2.2 Browser workflow

1. Browser receives configured Projects and renders every Project card, including zero-session cards.
2. User chooses Project and starts raw `claude` or `codex`; relay resolves configured cwd and host.
3. Live sessions appear below Project. User leaves them standalone or selects two and creates named local Pair.
4. Pair adds transfer shortcut only. User can unpair or create another pair at any time.
5. Closing session leaves Project visible and makes affected local pairs stale.

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
| `start_agent` | `name`, `project_id`, `mode: "tab" \| "split"`, optional `split_from: pane_id` | `name` in `HERDR_START_AGENTS`; `project_id` in configured Projects; for `split`, `split_from` is a live pane on that Project's host; **no argv, no env, no cwd, no prompt accepted from the client** |

For `mode: "split"` the relay resolves the target tab itself from `agent_cache[split_from]["tab_id"]` (`:193`); the client sends `split_from` and nothing else. A `split_from` on a different host than the Project is refused — `herdr agent start --tab` addresses a tab on one server.

There is no `transfer` command. Transfer is frontend-only (§6) and rides the existing `send_text`.

### 4.2 Server → Client

| type | Payload | When |
|---|---|---|
| `projects` | `{projects: [{id, label, host}]}` | On client connect |

`projects` intentionally omits `cwd`; browser does not need it.

Two consequences of sending this only on connect, both accepted for v1 and both worth stating so they are not discovered as bugs:

- **The relay currently pushes nothing on connect.** `handle_client:461` adds the socket to `clients` and drops straight into the receive loop; the first `agents` snapshot arrives on the next poll tick, up to `POLL_INTERVAL` (2s) later. `projects` has no poll behind it, so connect-time push is now load-bearing rather than a nicety. Send the cached `agents` snapshot at the same moment — it costs one line and removes the empty-list flash the app has today.
- **Projects are fixed for the life of the relay process.** Editing `HERDR_PROJECTS_FILE` requires a restart, and connected clients will not see the change. Acceptable while the file is hand-maintained; if it starts changing often, re-read on `SIGHUP` and re-broadcast, which is additive.

### 4.3 Removals

`create_tab` (`:530-538`) and `web/index.html:506-511` are deleted. Sole caller is the web app; `start_agent` supersedes it. This also disposes of G2.

---

## 5. Starting Agents

**A new agent is started raw.** The relay runs the agent and stops there — no seed prompt, no wait-for-ready, no post-start input. The user drives the agent from the frontend afterwards using the instruction shortcuts in §6.1 (D5).

```python
# The Project's configured host decides where this runs.
# remote=None for host "local"; remote=<ssh target> otherwise.
run_herdr("agent", "start", name, "--cwd", project.cwd, "--focus",
          remote=None if project.host == "local" else project.host)

# mode: "split" — new pane beside an existing one.
# tab_id is resolved by the relay from agent_cache[split_from]["tab_id"] (:193).
# The client never sends a tab_id.
run_herdr("agent", "start", name, "--cwd", project.cwd,
          "--tab", tab_id, "--split", "right", "--focus",
          remote=None if project.host == "local" else project.host)
```

> **The `remote=` argument is mandatory, not optional.** G2 is exactly this bug in `create_tab:535` — a `run_herdr` call that omits `remote=` silently targets the local host and is wrong under `HERDR_REMOTES`. Deleting `create_tab` removes the instance, not the trap. `start_agent` is the same shape of call and will reintroduce it verbatim unless the Project's configured host is threaded through. For `mode: "split"`, `split_from` must live on that same host (§4.1) — a split cannot cross hosts, because `herdr agent start --tab` addresses a tab on one server.

That is the whole operation. It returns as soon as the pane exists; the agent appears on the next poll like any other. Because nothing is sent to the agent, the readiness problem does not arise and `run_herdr`'s existing 15s timeout (`:166`) is sufficient — no `asyncio.to_thread`, no `herdr wait agent-status`.

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
| Architect | `@.agent/prompts/System_Prompt_2_Architect.md ; /ponytail /caveman` |

The set is editable by the operator; the frontend treats it as data, not as a fixed list.

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

The transfer action captures the current text selection, resolves the other healthy pair member, switches `activePane` to it, then places the composed text in `termInput` (`web/index.html:566`) and stops. The user reads it and presses send. The existing UI has one composer, not one per pane; switching first is what makes "partner composer" precise. This is the "every step manual" rule at its most literal, and it is also the last checkpoint before one agent's output enters another agent's context.

Sending then reuses the existing path unchanged: `send_text`, then `send_keys ["Enter"]` (`web/index.html:568-569`).

### 6.4 The `send_text` cap — open implementation question

Two things have to be settled against a live agent pane before this is built.

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

---

## 7. Security

Written plainly and deliberately. Moving transfer to the frontend removes one relay-side vector but does not remove the underlying risk — it relocates it to a place where a human is structurally required to look at it.

### 7.1 `start_agent` spawns a process from a network request

`herdr agent start` accepts `-- <argv...>`, which is arbitrary command execution. The mitigations are structural, not advisory:

- The client sends an **agent name** and a `project_id`. Never an argv, never an env, never a path, never prompt text.
- `name` must appear in `HERDR_START_AGENTS` (default: `claude,codex`).
- `project_id` must exist in configured Projects. Relay looks up cwd and host itself; client-supplied paths and hosts are never honoured.
- Every start is audited via the existing `audit()` helper, recording `name`, `project_id` and `mode`.

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
| **P1 — Projects** | Load `HERDR_PROJECTS_FILE`; emit `projects` and the cached `agents` snapshot on connect; resolve each live pane by longest configured root; refuse ambiguous pane IDs (D6); web app renders zero-session Project cards; workspace/tab chips and `create_tab` deleted | `projects.py` (new), `herdr_relay.py`, `agent_state.py`, `web/index.html`, tests | Root and subdirectory sessions group under configured Project; `/code/x-old` does **not** group under `/code/x`; unmatched session appears under Other sessions with no `project_id` key; zero-session Project appears; a fresh client renders without an empty-list flash; a pane ID reported by two hosts is refused on all four commands. **Specced:** `.workflow/03_specs/projects_spec.md`. **Planned:** `.workflow/04_implementation_plans/P1_projects.md` |
| **P2 — Start agent** | `start_agent` (raw run, no seeding) + allowlists + `HERDR_ENABLE_WRITE_EXT` + token requirement | `herdr_relay.py`, `web/index.html`, tests | Start works from zero-session configured Project; refused for unlisted name, unknown `project_id`, and missing token; **a start on a Project with `host != "local"` reaches that host** (the G2 regression test); `mode: "split"` lands beside `split_from` and is refused cross-host; audit line present on success |
| **P3 — Local pairs + transfer UI** | `localStorage` pairs, pair editor, selection, shortcut dropdown, partner-composer prefill; `send_text` cap raised | `web/index.html`, one constant in `herdr_relay.py` | Pair survives page reload; cross-host pin refused; pinning an already-paired pane replaces after confirm; stale or duplicated fingerprint disables transfer; a 3000-char selection transfers intact; prefill never auto-sends; oversize text still refused |
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

---

## 10. Open Questions for Phase 3 (Specs)

1. **Multi-line delivery** (§6.4b) — must be settled by experiment before the transfer spec is frozen. It is the only thing in this proposal that could force a design change rather than a parameter change.
2. **Pair creation UI** — confirm whether the pair editor lives on agent cards, terminal header, or both.
3. ~~**Project ordering in the client**~~ — **resolved (D7):** configured file order, never reordered by activity.
4. **Pair sync** — keep deferred until named local pairs prove useful; then add authenticated, last-write-wins frontend-preferences sync.
