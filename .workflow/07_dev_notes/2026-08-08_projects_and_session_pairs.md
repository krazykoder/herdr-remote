# Architecture — Projects and Session Pairs

**Date:** 2026-08-08
**Status:** **Proposal — under review.** Promote to `.workflow/02_architecture/` once accepted.
**Decisions:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs_decisions.md`
**Source proposal:** `.workflow/07_dev_notes/2026-08-08_workspace_and_session_pair_proposal.md`
**Classification:** **Class B** — additive protocol extension, backward compatible. No existing message shape changes.

---

## 1. Proof of Discovery

No `.codegraph/` or `graphify-out/` in this repo; the map below was built by reading the code.

### Affected modules

| Path | Role today | Change |
|---|---|---|
| `relay/herdr_relay.py:176` `get_agents_from_host` | Only source of pane state | `[MODIFY]` add `project_id` |
| `relay/herdr_relay.py:247` `_poll_once` | Poll, diff, broadcast | `[MODIFY]` pair health validation |
| `relay/herdr_relay.py:437` `handle_client` | Client command switch | `[MODIFY]` 4 new commands |
| `relay/herdr_relay.py:530` `create_tab` | Tab creation | `[DELETE]` superseded by `start_agent` |
| `relay/agent_state.py` | Snapshot/merge helpers | `[MODIFY]` add `project_id` to field tuple |
| `web/index.html:427-511` | `render` / `renderWorkspaces` / `createTab` | `[MODIFY]` Projects replace workspace chips |
| `relay/herdr_tui.py`, `relay/herdr_telegram.py`, `herdi-mac/`, `herdi-ios/` | Consume `agents` snapshot | **No change** — additive fields, unknown types ignored |

### Invariants that must survive

1. **`known_panes` gate on every write command.** Enforced at `:473`, `:488`, `:497`, `:520`. New write commands inherit it.
2. **Allowlist-shaped write surface.** `SAFE_RESPONSES` (`:76`), `SAFE_KEYS` (`:77`), `send_text` 1000-char cap (`:523`). New commands extend this pattern; they do not introduce free-form execution.
3. **`audit()` on every write.** `:481`, `:505`, `:528`, `:534`.
4. **Route order in `process_request`.** The comment at `:366` is load-bearing: event push (`?d=`) must be handled before any static route, or events are silently dropped while the caller still gets 200. New routes go below.
5. **Snapshot fields are additive-only.** Five clients consume `agents`; `apply_agent_message` (`agent_state.py:33`) merges by `pane_id`.

### Gaps found during discovery

| # | Finding | Consequence |
|---|---|---|
| G1 | `get_agents_from_host:195` filters `if p.get("agent")` — the relay only ever sees panes that *already* have an agent | A Project with no running agent is invisible. Acceptable for v1 (Projects are discovered from live panes), but it means "start an agent in a brand-new repo" is out of scope by construction. |
| G2 | `create_tab:535` calls `run_herdr(...)` with **no `remote=`** | Pre-existing bug: tab creation always targets the local host, silently wrong for `HERDR_REMOTES`. Only caller is `web/index.html:509`. Being deleted, so the bug dies with it. |
| G3 | No state is pushed on client connect | A new client shows an empty list for up to `POLL_INTERVAL` (2s). Pairs make this worse — pair state changes rarely, so a connect-time push becomes required, not just nice. |
| G4 | `herdr` CLI already exposes every primitive needed | `agent start <name> [--cwd] [--tab] [--split right\|down]`, `pane split`, `pane send-text`, `pane rename`, `tab create`. No new external machinery. |
| G5 | Pane IDs are reusable | A pinned pair can outlive its panes and end up pointing at a *different* agent. Drives the fingerprint design in §3.2. |
| G6 | `herdr agent start` returns as soon as the pane exists, before the agent TUI accepts input | Seeding a start prompt immediately after the call drops it. Needs `herdr wait agent-status --status idle`, which can run 30s — longer than `run_herdr`'s shared 15s timeout at `:166`, so it cannot reuse that helper on the event loop. Drives §5.2. |

---

## 2. Concept: Project

**A Project is the grouping of agents by code root directory.** It is deliberately *not* herdr's workspace.

herdr's `workspace_id` and `tab_id` remain on the pane snapshot as raw metadata. They are not a user-facing concept in herdr-remote and the workspace/tab chip strips (`web/index.html:447-472`) are removed.

**Resolution rule (decided, see D1):** raw `cwd`, no git.

```
project_id = f"{host}:{cwd}"        # stable grouping key
project    = basename(cwd)           # display label — already exists at :189
```

`project_id` includes `host` so that the same path on two SSH remotes does not collapse into one Project.

**Label collisions.** Two Projects can share a basename (`~/a/web` and `~/b/web`). Resolution is presentational and belongs in the client: when two visible `project_id`s produce the same label, extend each label leftward by one path segment until unique. No relay involvement.

**Known limits of raw-cwd grouping** (accepted, revisit in Phase 5):
- An agent started in `repo/relay` and one in `repo/web` are two Projects.
- A `herdr worktree create` sibling is its own Project.

---

## 3. Concept: Session Pair

**A Session Pair is two pinned agent panes that can hand text to each other under human control.** Canonical case: architect Claude + reviewer codex.

**Definition (decided, see D2):** explicit, user-pinned, persisted in the relay. Members may live in different tabs, different Projects, and on different hosts.

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

| State | Condition | Transfers |
|---|---|---|
| `healthy` | Both `pane_id`s in `known_panes` **and** each member's live `agent` + `cwd` + `host` match the stored fingerprint | Allowed |
| `stale` | A member's `pane_id` is absent from `known_panes` | Refused |
| `broken` | A member's `pane_id` is present but the fingerprint no longer matches | Refused |

Neither `stale` nor `broken` auto-deletes the pair — a `stale` pair recovers on its own if the pane comes back (relay restart, SSH blip). A `broken` pair requires an explicit re-pin, because the pane ID now belongs to something else.

> This is the load-bearing safety property of the whole feature: **a transfer must never be delivered to a pane other than the one the user pinned.**

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
| `transfer` | `pair_id`, `to_pane`, `text`, and one of `instruction_id` \| `instruction` | pair `healthy`; `to_pane` is a member of *this* pair; `len(text) <= 4000`; `instruction_id` in preset table, or custom `instruction` `<= 500` chars |
| `start_agent` | `name`, `project_id`, `mode: "tab" \| "split"`, `prompt_id: "architect" \| "reviewer" \| "none"`, optional `pair_with: pane_id` | `name` in `HERDR_START_AGENTS`; `project_id` in the discovered Project set; `prompt_id` one of exactly three values; **no `argv`, no `env`, no `cwd`, no prompt text accepted from the client** |

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

## 5. Agent Start Prompts

A newly started agent is seeded with a role prompt. There are exactly **three** choices, and the client picks one by ID — the prompt text itself never crosses the wire.

| `prompt_id` | Meaning |
|---|---|
| `architect` | Seed the agent as the Architect side of a pair |
| `reviewer` | Seed the agent as the Reviewer side of a pair |
| `none` | Start the agent bare, send nothing |

`none` is a first-class option, not a fallback: starting a plain agent in a Project is the common case and must not require dismissing a prompt picker.

### 5.1 Prompt table

Server-side, same shape as the transfer presets in §6.1.

> **⚠ PLACEHOLDER — prompt text to be supplied by the operator.** The three keys below are frozen; the strings are not. Do not invent copy for them. The Implementer wires the table and the lookup; the text lands via `HERDR_PROMPTS_FILE` or a follow-up edit.

```python
START_PROMPTS = {
    "architect": "<<TBD — architect seed prompt>>",
    "reviewer":  "<<TBD — reviewer seed prompt>>",
    "none":      None,   # explicit: send nothing
}
```

The keys are the contract; the values are prompt-engineering copy and will be retuned far more often than the code around them. An optional `HERDR_PROMPTS_FILE` JSON override loads over both `START_PROMPTS` and `TRANSFER_PRESETS` at startup, so tuning does not require editing the relay. Unknown keys in the override are ignored; the built-in dict is the schema.

Until real copy is supplied, a `<<TBD …>>` value behaves exactly like `none` — the pane starts and nothing is sent, and the relay logs a warning naming the unset key. It must never send the placeholder string to an agent.

### 5.2 Seeding sequence

`herdr agent start` returns as soon as the pane exists — the agent TUI is not yet accepting input. Seeding must wait for readiness, and herdr already provides the primitive:

```bash
herdr agent start <name> --cwd <project cwd> [--tab <tab_id> | --split right] --focus
herdr wait agent-status <pane_id> --status idle --timeout 30000
herdr pane send-text <pane_id> "<START_PROMPTS[prompt_id]>"
herdr pane send-keys <pane_id> Enter
```

The wait must not block the event loop — `run_herdr` is a synchronous `subprocess.run` with a 15s timeout (`:166`), so a 30s wait needs `asyncio.to_thread` or a dedicated task. Do not raise the shared timeout; other callers depend on it staying short.

On `prompt_id == "none"`, steps 2–4 are skipped entirely and the command returns as soon as the pane exists.

If the wait times out, the pane still exists and is reported normally on the next poll — the relay returns `command_result` with `ok: true` and `seeded: false` rather than pretending the seed landed. The operator can then type into the pane directly.

### 5.3 Pairing on start

`pair_with: <pane_id>` starts the new agent with `--split right` in the existing pane's tab and pins the pair in one action. This is the intended path to an architect/reviewer setup: start the architect with `prompt_id: "architect"`, then start the reviewer with `prompt_id: "reviewer"` and `pair_with` pointing at the architect's pane.

Roles on the resulting pair default to the two `prompt_id` values. When either side used `none`, the role falls back to the agent name (§3.4).

---

## 6. Transfer Semantics

### 6.1 Instruction presets

Server-side table, mirroring the `SAFE_RESPONSES` pattern — the client sends an ID, not the text:

```python
TRANSFER_PRESETS = {
    "review":    "Review, edit, fix; then propose next steps.",
    "implement": "Proceed to implement.",
    "architect": "@system architect ; /ponytail /caveman",
}
```

A custom `instruction` string is accepted, capped at 500 chars, and recorded in the audit log.

### 6.2 Composed payload

```
{instruction}

feedback from {from_role} ({from_agent}):
<<<TRANSFER
{text}
TRANSFER>>>
```

**The fence is not decoration.** Without it, transferred pane content containing a line like `Proceed to implement` is indistinguishable from the operator's own instruction. The delimiter gives the receiving agent an unambiguous boundary for the quoted region.

### 6.3 Delivery — open implementation question

Delivery is `pane send-text <to_pane> <composed>` followed by `pane send-keys <to_pane> Enter`, the same two-step the web app already uses at `web/index.html:568-569`.

**The payload is multi-line, and agent TUIs treat Enter as submit.** Whether embedded newlines submit early depends on whether `herdr pane send-text` emits a bracketed paste. The `herdr agent` help text distinguishes `agent send` ("writes literal text") from `pane run` ("command text plus Enter"), which suggests it does — but the Implementer must verify rather than assume:

```bash
# With a live agent pane open, against a scratch pane:
herdr pane send-text <pane_id> $'line one\nline two\nline three'
herdr pane read <pane_id> --lines 20
# PASS: all three lines sit unsubmitted in the agent's composer.
# FAIL: "line one" was submitted on its own.
```

On FAIL, the fallback is per-line `send-text` with `M-Enter` (Alt+Enter — newline without submit in Claude Code and codex) between lines, which requires adding `M-Enter` to `SAFE_KEYS` (`:77`). Do not fall back to flattening newlines into spaces; the payload is usually code or diffs.

---

## 7. Security

This section is written plainly and deliberately. Two of the four new commands widen the relay's write surface in ways the existing allowlists do not cover.

### 7.1 `start_agent` spawns a process from a network request

`herdr agent start` accepts `-- <argv...>`, which is arbitrary command execution. The mitigations are structural, not advisory:

- The client sends an **agent name**, never an argv, never an env, never a path.
- `name` must appear in `HERDR_START_AGENTS` (default: `claude,codex`).
- `project_id` must already exist in the discovered Project set. The relay looks up the `cwd` itself; a client-supplied path is never honoured. Starting an agent in a repo herdr has never opened is out of scope by design (G1).
- `prompt_id` selects from three server-side strings (§5.1). Prompt text is never accepted from the client — a client-supplied seed prompt would be an unreviewed instruction injected into a fresh agent with the operator's credentials.
- Every start is audited via the existing `audit()` helper, recording `name`, `project_id`, `mode` and `prompt_id`.

### 7.2 `transfer` is a prompt-injection channel

Agent A's pane content may contain text A fetched from the internet. `transfer` moves that text into agent B's prompt. Containment:

- **Human-initiated on every hop.** No auto-relay in v1 (D3). The operator sees the text before it moves.
- Destination is restricted to the *other member of the same pair* — text cannot be fanned into arbitrary panes.
- Payload capped at 4000 chars; instructions come from a server-side preset table.
- Fenced payload (§6.2) so the receiving agent can see the boundary.
- Audited with truncated detail, reusing the existing 120-char truncation at `:101`.

### 7.3 Authentication must become mandatory for these commands

The relay binds `0.0.0.0` (`:596`) and `HERDR_RELAY_TOKEN` is **optional** today (`:47`). That is defensible for a read-mostly relay with allowlisted responses. It is not defensible once `start_agent` exists.

**Requirement:** the relay refuses to start if the write-extension commands are enabled without a token.

```
HERDR_ENABLE_WRITE_EXT=1 without HERDR_RELAY_TOKEN  ->  exit(1) with a clear message
```

`start_agent`, `pair_create`, `pair_delete` and `transfer` are all gated on `HERDR_ENABLE_WRITE_EXT`; the default is off, so an existing deployment gains no new surface until the operator opts in and sets a token.

Confirmed during discovery: the token check in `process_request` (`:334-347`) runs **before** the WebSocket upgrade check (`:349-355`), so WebSocket connections are already covered by it.

### 7.4 Pane ID reuse

Covered by the fingerprint validation in §3.2. Called out separately here because a stale pair silently retargeting a different agent is the failure mode with the worst consequences and the least visibility.

---

## 8. Phasing

| Phase | Scope | Touches | Gate |
|---|---|---|---|
| **P1 — Projects** | `project_id` on snapshot; web app groups by Project; workspace/tab chips and `create_tab` deleted | `herdr_relay.py`, `agent_state.py`, `web/index.html` | Two agents in different repos group into two Projects; one repo with two agents groups into one; `tests/test_agent_state.py` extended |
| **P2 — Start agent** | `start_agent` + allowlists + three-option `prompt_id` seeding + `HERDR_ENABLE_WRITE_EXT` + token requirement | `herdr_relay.py`, `web/index.html` | Start refused for unlisted name, unknown `project_id`, unknown `prompt_id`, and missing token; `architect`/`reviewer` land their seed prompt after the agent reaches idle; `none` starts a bare agent and sends nothing; a seed timeout returns `seeded: false` with the pane still alive; audit line present on success |
| **P3 — Pairs** | `pairs.json`, `pair_create`/`pair_delete`, poll-time health validation, `pairs` broadcast, connect-time state push | `herdr_relay.py`, `web/index.html` | Pair survives relay restart; killing a member yields `stale`; replacing a pane so the fingerprint mismatches yields `broken` and refuses transfer |
| **P4 — Transfer** | `transfer`, presets, fence, caps; pane text selection in the web app | `herdr_relay.py`, `web/index.html` | §6.3 delivery check passes; oversize payload and unknown `instruction_id` both refused; audit line present |
| **P5 — Deferred** | Auto-relay with per-pair opt-in and hop cap; 3+ member pairs; worktree-aware Projects | — | Not specced. Requires its own threat model. |

Each phase is independently shippable. P3 does not depend on P2.

---

## 9. Decisions

Logged in `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs_decisions.md`.

| ID | Decision |
|---|---|
| D1 | Project key is raw `cwd`, no git resolution |
| D2 | Session Pairs are explicitly pinned and persisted, not derived from herdr layout |
| D3 | No auto-relay in v1; every transfer is human-initiated |
| D4 | `start_agent` is restricted to allowlisted agent names in already-discovered Projects |
| D5 | Start prompts are three server-side IDs — `architect`, `reviewer`, `none` — with `none` a first-class choice |

---

## 10. Open Questions for Phase 3 (Specs)

1. **Multi-line delivery** (§6.3) — must be settled by experiment before the transfer spec is frozen. It gates the seed prompts in §5.2 as well, though those are single-line today.
2. **Pair discoverability** — should the relay *suggest* a pair when two agent panes share a `tab_id`, as a one-tap pin? Cheap, and it recovers most of the ergonomics of the derived-pair design without its state model.
3. **Project ordering in the client** — most-recently-blocked first, or stable alphabetical? Affects whether the list moves under the user's thumb on mobile.
