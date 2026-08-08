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
| `relay/herdr_relay.py:176` `get_agents_from_host` | Only source of pane state | `[MODIFY]` add `project_id` |
| `relay/herdr_relay.py:247` `_poll_once` | Poll, diff, broadcast | `[MODIFY]` pair health validation |
| `relay/herdr_relay.py:437` `handle_client` | Client command switch | `[MODIFY]` 3 new commands |
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
| G1 | `get_agents_from_host:195` filters `if p.get("agent")` — the relay only ever sees panes that *already* have an agent | A Project with no running agent is invisible. Accepted: Projects are discovered from live panes, so "start an agent in a repo herdr has never opened" is out of scope by construction. |
| G2 | `create_tab:535` calls `run_herdr(...)` with **no `remote=`** | Pre-existing bug: tab creation always targets the local host, silently wrong for `HERDR_REMOTES`. Only caller is `web/index.html:509`. Being deleted, so the bug dies with it. |
| G3 | No state is pushed on client connect | A new client shows an empty list for up to `POLL_INTERVAL` (2s). Pairs make this required rather than cosmetic — pair state changes rarely, so a client that misses the broadcast waits indefinitely. |
| G4 | `herdr` CLI already exposes every primitive needed | `agent start <name> [--cwd] [--tab] [--split right\|down]`, `pane split`, `pane send-text`, `tab create`. No new external machinery. |
| G5 | Pane IDs are reusable | A pinned pair can outlive its panes and end up pointing at a *different* agent. Drives the fingerprint design in §3.2. |
| G6 | `send_text` caps client text at 1000 chars (`:523`) | Fine for typing. Too small for a pasted diff or a block of pane output, which is exactly what transfer moves. Drives §6.4. |

---

## 2. Concept: Project

**A Project is the grouping of agents by code root directory.** It is deliberately *not* herdr's workspace.

herdr's `workspace_id` and `tab_id` remain on the pane snapshot as raw metadata. They are not a user-facing concept in herdr-remote and the workspace/tab chip strips (`web/index.html:447-472`) are removed.

**Resolution rule (D1):** raw `cwd`, no git.

```
project_id = f"{host}:{cwd}"        # stable grouping key
project    = basename(cwd)           # display label — already exists at :189
```

`project_id` includes `host` so the same path on two SSH remotes does not collapse into one Project.

**Label collisions.** Two Projects can share a basename (`~/a/web` and `~/b/web`). Resolution is presentational and belongs in the client: when two visible `project_id`s produce the same label, extend each label leftward by one path segment until unique. No relay involvement.

**Known limits of raw-cwd grouping** (accepted, revisit in Phase 5):
- An agent started in `repo/relay` and one in `repo/web` are two Projects.
- A `herdr worktree create` sibling is its own Project.

---

## 3. Concept: Session Pair

**A Session Pair is two pinned agent panes the user works across.** Canonical case: architect Claude + reviewer codex.

**Definition (D2):** explicit, user-pinned, persisted in the relay. Members may live in different tabs, different Projects, and on different hosts.

The pair is a **binding, not a channel**. It does not move text — §6 does, and it does so entirely in the frontend. What the pair provides is durable, cross-device identity: pin on the desktop, and the phone shows the same pairing.

### 3.1 Persistence

`pairs.json`, stored next to `push_subs.json` in `LOG_DIR` (`:54`), same load/save pattern as `_load_push_subs` / `_save_push_subs`.

```json
{
  "version": 1,
  "pairs": [
    {
      "id": "p_a1b2c3d4",
      "created": "2026-08-08T12:00:00Z",
      "members": [
        {"pane_id": "%14", "host": "local",  "role": "architect", "agent": "claude", "cwd": "/Users/t/code/herdr-remote"},
        {"pane_id": "%22", "host": "devbox", "role": "reviewer",  "agent": "codex",  "cwd": "/srv/herdr-remote"}
      ]
    }
  ]
}
```

`agent`, `cwd` and `host` are the **identity fingerprint**, captured at pin time. They are not display data — they exist to detect pane-ID reuse (G5).

### 3.2 Derived health — computed each poll, never persisted

| State | Condition | Effect |
|---|---|---|
| `healthy` | Both `pane_id`s in `known_panes` **and** each member's live `agent` + `cwd` + `host` match the stored fingerprint | Pair usable |
| `stale` | A member's `pane_id` is absent from `known_panes` | Pair shown greyed; transfer UI disabled |
| `broken` | A member's `pane_id` is present but the fingerprint no longer matches | Pair flagged; transfer UI disabled until re-pinned |

Neither state auto-deletes the pair. A `stale` pair recovers on its own if the pane returns (relay restart, SSH blip). A `broken` pair requires an explicit re-pin, because that pane ID now belongs to something else.

> This is the load-bearing safety property of the feature: **the UI must never offer to paste into a pane other than the one the user pinned.**

### 3.3 Limits

- Exactly 2 members in v1. `members` is a list so 3+ is a later additive change.
- Max 32 pairs. A pane may belong to at most one pair.

### 3.4 Roles

`role` is a free-form slug, `^[a-z0-9_-]{1,32}$`, defaulting to the agent name. It is relay-side label data only — it never reaches a shell.

---

## 4. Protocol Delta

All additive. Unknown `type` values are already ignored by every client.

### 4.1 Client → Server

| type | Fields | Guards |
|---|---|---|
| `pair_create` | `members: [{pane_id, role}, {pane_id, role}]` | exactly 2; both in `known_panes`; neither already paired; role matches slug regex; `len(pairs) < 32` |
| `pair_delete` | `pair_id` | pair exists |
| `start_agent` | `name`, `project_id`, `mode: "tab" \| "split"`, optional `pair_with: pane_id` | `name` in `HERDR_START_AGENTS`; `project_id` in the discovered Project set; **no argv, no env, no cwd, no prompt accepted from the client** |

There is no `transfer` command. Transfer is frontend-only (§6) and rides the existing `send_text`.

### 4.2 Server → Client

| type | Payload | When |
|---|---|---|
| `pairs` | `{pairs: [...]}` with derived `state` on each | On connect, on any pair mutation, and whenever a pair's derived state changes |
| `command_result` | Existing shape (`:516`) | Reused for `pair_*` and `start_agent` |

### 4.3 Connect-time state push

Fixes G3. On accepting a client in `handle_client`, immediately send the cached `agents` snapshot and the current `pairs` list before entering the receive loop.

### 4.4 Removals

`create_tab` (`:530-538`) and `web/index.html:506-511` are deleted. Sole caller is the web app; `start_agent` supersedes it. This also disposes of G2.

---

## 5. Starting Agents

**A new agent is started raw.** The relay runs the agent and stops there — no seed prompt, no wait-for-ready, no post-start input. The user drives the agent from the frontend afterwards using the instruction shortcuts in §6.1 (D5).

```bash
# mode: "tab"
herdr agent start <name> --cwd <project cwd> --focus

# mode: "split" — new pane beside an existing one
herdr agent start <name> --cwd <project cwd> --tab <tab_id of pair_with pane> --split right --focus
```

That is the whole operation. It returns as soon as the pane exists; the agent appears on the next poll like any other. Because nothing is sent to the agent, the readiness problem does not arise and `run_herdr`'s existing 15s timeout (`:166`) is sufficient — no `asyncio.to_thread`, no `herdr wait agent-status`.

### 5.1 Pairing on start

`pair_with: <pane_id>` starts the new agent with `--split right` in the existing pane's tab and pins the pair in the same action. This is the intended route to an architect/reviewer setup: start the first agent in a Project, then start the second with `pair_with` pointing at it.

Roles default to the two agent names (§3.4) and are renameable afterwards.

---

## 6. Instruction Shortcuts and Transfer

**Transfer is copy-and-paste in the frontend.** No relay command, no server-side composition, no preset table in Python. The user selects text in one pane's view, picks an instruction shortcut, and the frontend prefills the partner pane's composer. Every step is a deliberate action (D3).

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

feedback from {from_role} ({from_agent}):
<<<TRANSFER
{text}
TRANSFER>>>
```

**The fence is not decoration.** Without it, transferred pane content containing a line like `Proceed to implement` is indistinguishable from the operator's own instruction. The delimiter gives the receiving agent an unambiguous boundary for the quoted region.

### 6.3 Prefill, do not auto-send

The composed text lands in the partner pane's composer (`termInput`, `web/index.html:566`) and stops there. The user reads it and presses send. This is the "every step manual" rule at its most literal, and it is also the last checkpoint before one agent's output enters another agent's context.

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
- `project_id` must already exist in the discovered Project set. The relay looks up the `cwd` itself; a client-supplied path is never honoured. Starting an agent in a repo herdr has never opened is out of scope by design (G1).
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

`start_agent`, `pair_create` and `pair_delete` are all gated on `HERDR_ENABLE_WRITE_EXT`; the default is off, so an existing deployment gains no new surface until the operator opts in and sets a token. The raised `send_text` cap (§6.4) is **not** gated — it applies to an existing command and is a size change, not a new capability.

Confirmed during discovery: the token check in `process_request` (`:334-347`) runs **before** the WebSocket upgrade check (`:349-355`), so WebSocket connections are already covered by it.

### 7.4 Pane ID reuse

Covered by the fingerprint validation in §3.2. Called out separately because a stale pair silently retargeting a different agent is the failure mode with the worst consequences and the least visibility — and with transfer in the frontend, the pair is what tells the UI where to paste.

---

## 8. Phasing

| Phase | Scope | Touches | Gate |
|---|---|---|---|
| **P1 — Projects** | `project_id` on snapshot; web app groups by Project; workspace/tab chips and `create_tab` deleted | `herdr_relay.py`, `agent_state.py`, `web/index.html` | Two agents in different repos group into two Projects; one repo with two agents groups into one; colliding basenames disambiguate; `tests/test_agent_state.py` extended |
| **P2 — Start agent** | `start_agent` (raw run, no seeding) + allowlists + `HERDR_ENABLE_WRITE_EXT` + token requirement | `herdr_relay.py`, `web/index.html` | Start refused for unlisted name, unknown `project_id`, and missing token; `mode: "split"` lands beside `pair_with`; audit line present on success |
| **P3 — Pairs** | `pairs.json`, `pair_create`/`pair_delete`, poll-time health validation, `pairs` broadcast, connect-time state push | `herdr_relay.py`, `web/index.html` | Pair survives relay restart and appears on a second device; killing a member yields `stale`; replacing a pane so the fingerprint mismatches yields `broken` and disables the transfer UI |
| **P4 — Transfer UI** | Pane text selection, shortcut dropdown, partner-composer prefill; `send_text` cap raised | `web/index.html`, one constant in `herdr_relay.py` | §6.4(b) newline check passes; a 3000-char selection transfers intact; prefill never auto-sends; oversize text still refused |
| **P5 — Deferred** | Auto-relay with per-pair opt-in and hop cap; 3+ member pairs; git/worktree-aware Projects; server-side instruction presets shared across clients | — | Not specced. Auto-relay requires its own threat model. |

Each phase is independently shippable. P3 does not depend on P2.

---

## 9. Decisions

Logged in `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs_decisions.md`.

| ID | Decision |
|---|---|
| D1 | Project key is raw `cwd`, no git resolution |
| D2 | Session Pairs are explicitly pinned and persisted in the relay, not derived from herdr layout |
| D3 | Every step is manual in v1; transfer is frontend copy-paste with no relay command |
| D4 | `start_agent` is restricted to allowlisted agent names in already-discovered Projects |
| D5 | Agents start raw — no seed prompt; instruction shortcuts are frontend-side path references |

---

## 10. Open Questions for Phase 3 (Specs)

1. **Multi-line delivery** (§6.4b) — must be settled by experiment before the transfer spec is frozen. It is the only thing in this proposal that could force a design change rather than a parameter change.
2. **Pair discoverability** — should the relay *suggest* a pair when two agent panes share a `tab_id`, as a one-tap pin? Cheap, and it removes most of the pinning friction.
3. **Project ordering in the client** — most-recently-blocked first, or stable alphabetical? Affects whether the list moves under the user's thumb on mobile.
4. **Shortcut portability** — shortcuts start as a `const` in `web/index.html`, which means they do not follow the user to the Telegram or Swift clients. Promote to a relay-served list if that becomes a real complaint (listed under P5).
