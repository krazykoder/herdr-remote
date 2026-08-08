# Spec — P1: Projects

**Date:** 2026-08-08
**Phase:** 3 (Specs)
**Architecture:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs.md` §2, §4
**Decisions:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs_decisions.md` (D1, D6, D7)
**Classification:** Class B — additive, backward compatible.

Defines behaviour only. Implementation is `.workflow/04_implementation_plans/P1_projects.md`.

---

## 1. Scope

| In | Out |
|---|---|
| Load and validate `HERDR_PROJECTS_FILE` | `start_agent` (P2) |
| Resolve `project_id` for every live pane | Session Pairs, transfer (P3) |
| `projects` message + cached `agents` snapshot on connect | Raising the `send_text` cap (P3) |
| Refuse ambiguous pane IDs (D6) | `(host, pane_id)` protocol identity (Class C, deferred) |
| Delete `create_tab` and the workspace/tab chip strips | |

---

## 2. Configuration

`HERDR_PROJECTS_FILE` — absolute path to a trusted JSON file. Read once at startup.

```json
[
  {"id":"herdr-remote","label":"herdr-remote","cwd":"/Users/towshif/code/python/herdr-remote","host":"local"},
  {"id":"charts","label":"Charts","cwd":"/Users/towshif/code/js/charts.TS","host":"local"}
]
```

### 2.1 Validation

The file is trusted input that determines where processes are launched in P2. Validation is **fail-closed at startup**: any violation exits non-zero with a message naming the offending entry. Never skip-and-continue — a silently dropped Project becomes a mis-grouped session, and in P2 a Project the operator believes is configured but is not.

| Field | Rule | On violation |
|---|---|---|
| — | File exists and parses as a JSON **array** | `exit(1)` |
| `id` | Matches `^[a-z0-9_-]{1,64}$` | `exit(1)` |
| `id` | Unique across the file | `exit(1)` |
| `label` | Non-empty string, ≤ 64 chars | `exit(1)` |
| `cwd` | Non-empty string, absolute (`os.path.isabs`) | `exit(1)` |
| `cwd` | After `os.path.normpath`, unique per `host` | `exit(1)` |
| `host` | `"local"` or a member of `HERDR_REMOTES` | `exit(1)` |

`cwd` is stored normalized (`os.path.normpath`), which strips a trailing slash and collapses `..` and `//`. Matching in §3 uses the normalized value.

### 2.2 Unset variable

`HERDR_PROJECTS_FILE` unset ⇒ zero Projects. This is the default and must stay fully working:

- `projects` is sent as an empty list.
- No pane carries a `project_id`.
- The web app falls back to its existing flat status-grouped list.

An empty JSON array (`[]`) behaves identically.

---

## 3. Grouping

For each live pane the relay resolves at most one `project_id` from the pane's `host` and `cwd`.

**Algorithm.** Consider only Projects whose `host` equals the pane's host label (`remote or "local"`). A Project matches when the pane's `cwd` equals its root, or is a descendant at a path boundary. Among matches, the **longest root wins**. No match ⇒ no `project_id`.

```
matches(cwd, root) := cwd == root  or  cwd.startswith(root.rstrip("/") + "/")
```

`rstrip("/")` handles a root of `/`. Plain `startswith` is wrong: it groups `/code/x-old` under `/code/x`.

### 3.1 Cases

| Pane `cwd` | Configured roots | Result |
|---|---|---|
| `/code/app` | `/code/app` | `project_id = app` |
| `/code/app/relay/sub` | `/code/app` | `project_id = app` |
| `/code/app/web` | `/code/app`, `/code/app/web` | `project_id` = the `/code/app/web` Project (longest) |
| `/code/app-old` | `/code/app` | **no** `project_id` |
| `/code/app` on `devbox` | `/code/app` on `local` | **no** `project_id` (host mismatch) |
| `/other` | any | **no** `project_id` |
| any | none configured | **no** `project_id` |

### 3.2 Absent, not null

An unmatched pane's snapshot entry **omits the `project_id` key entirely**. Not `null`, not `""`.

`agent_state.py:24` treats an empty value on a tracked field as "keep the previous value", and `apply_agent_message:49` merges with `dict.update`. A `null` would therefore be indistinguishable from "unchanged" and could resurrect a stale grouping after a pane's `cwd` changes. Absent is unambiguous.

### 3.3 Not resolved

Symlinks are not resolved, and no git or worktree lookup happens. Matching is lexical, on the `cwd` string herdr reports. Operators configure canonical paths. This keeps grouping free of subprocesses and remote round trips.

---

## 4. Protocol

### 4.1 Server → Client: `projects`

```json
{"type": "projects", "projects": [{"id": "app", "label": "App", "host": "local"}]}
```

Sent **once, immediately on client connect**, before anything else. `cwd` is deliberately omitted — the browser has no use for it, and withholding it keeps path knowledge on the relay side of the launch boundary (D1).

Projects are fixed for the life of the relay process. Editing the file requires a restart; connected clients will not see the change. Acceptable while the file is hand-maintained. `SIGHUP` re-read is additive and deferred.

### 4.2 Server → Client: connect-time `agents`

Immediately after `projects`, the relay sends the most recent `agents` snapshot broadcast by the poll loop.

Required, not cosmetic: `projects` has no poll behind it, so a client that renders Projects from `projects` alone would show every Project as zero-session for up to `POLL_INTERVAL` (2s). It also removes the empty-list flash the app has today.

Before the first poll completes, the cached snapshot is `{"type":"agents","agents":[]}` — the same payload the client would receive on the first tick.

### 4.3 Snapshot field

`agents[].project_id` — optional string, present only when §3 matched. Additive: `herdr_tui.py`, `herdr_telegram.py`, `herdi-mac/`, `herdi-ios/` ignore unknown fields and are unchanged.

`workspace_id` and `tab_id` remain on the snapshot as raw pane metadata. They are no longer a user-facing concept.

### 4.4 Removed: `create_tab`

The `create_tab` client message and its `tab_created` reply are deleted. The sole caller is `web/index.html:506-511`; no Swift, TUI or Telegram client sends it. A `create_tab` from an old client falls through the `handle_client` chain and is ignored, which is the existing behaviour for any unrecognized type.

This disposes of G2 — `create_tab:535` calls `run_herdr` with no `remote=` and always targets the local host.

---

## 5. Ambiguous pane IDs (D6)

herdr pane IDs are per-server counters (`w8:p1`). Under `HERDR_REMOTES`, two hosts starting fresh produce the same IDs. `_poll_once:250-253` keys `pane_remote_map`, `known_panes` and `agent_cache` on the bare `pane_id` while iterating every host, so the last host polled wins, and `respond`, `send_text`, `send_keys` and `read_pane` then route to the wrong machine (G7).

The full fix is a protocol-wide `(host, pane_id)` identity — Class C, out of scope. P1 makes the relay **refuse rather than guess**.

### 5.1 Behaviour

Each poll cycle recomputes the set of pane IDs reported by more than one host in that cycle.

| Condition | Response |
|---|---|
| `pane_id` not in `known_panes` | `{"type":"error","message":"unknown pane_id"}` (unchanged) |
| `pane_id` reported by >1 host in the last poll | `{"type":"error","message":"ambiguous pane_id (same id on multiple hosts)"}` |
| otherwise | proceed as today |

Applies to all four pane-addressed commands: `respond`, `read_pane`, `send_keys`, `send_text`. `read_pane` is included deliberately — it leaks another machine's terminal content otherwise.

### 5.2 Properties

- **Fail-closed.** A user with one host sees no change; the set is always empty.
- **Self-healing.** Recomputed every cycle, so it clears within one `POLL_INTERVAL` of the collision ending.
- **Not a P1 regression.** These commands already mis-route on collision; P1 turns a silent wrong-host write into a visible refusal.
- Pushed events (`event_push:322`) add to `known_panes` without a host, so a pane known only from an event is never ambiguous. It becomes ambiguous on the next poll if a real collision exists.

---

## 6. Web app

### 6.1 Rendering

Replaces the derived-workspace view (`web/index.html:427-511`).

1. **Needs you** — blocked agents hoisted to the top, as today.
2. **One section per configured Project**, in configured file order (D7): `label`, a `@host` badge when `host != "local"`, and its sessions grouped by status.
3. A Project with no live sessions renders with a "No sessions" placeholder. It is inert in P1; the start control arrives in P2.
4. **Other sessions** — every agent with no `project_id`. Rendered last, always visible, never hidden.

**Ordering is stable.** Projects do not reorder by activity: the list must not move under the user's thumb on mobile while they reach for a card. Blocked agents are surfaced by the hoist in step 1, which is what urgency needs.

Zero configured Projects ⇒ the existing flat status-grouped list, unchanged (§2.2).

### 6.2 Removed

`renderWorkspaces` chip strips (`:447-472`), `selectWorkspace`, `backToWorkspaces`, `selectTab`, `createTab`, and the `activeWorkspace` / `activeTab` state.

---

## 7. Acceptance

| # | Given | Then |
|---|---|---|
| A1 | Pane cwd == configured root | Grouped under that Project |
| A2 | Pane cwd is a subdirectory of a configured root | Grouped under that Project |
| A3 | Two roots match, one nested | Longest root wins |
| A4 | Pane cwd `/code/x-old`, root `/code/x` | **Not** grouped |
| A5 | Pane on `devbox`, Project root on `local`, same cwd | **Not** grouped |
| A6 | Unmatched pane | Snapshot entry has **no `project_id` key**; appears under Other sessions |
| A7 | Project with zero sessions | Renders as a card with "No sessions" |
| A8 | Fresh client connects | Receives `projects`, then a full `agents` snapshot, with no empty-list flash |
| A9 | `HERDR_PROJECTS_FILE` unset | Relay starts; `projects` is `[]`; flat list renders exactly as before |
| A10 | Config with a duplicate `id`, a relative `cwd`, or an unknown `host` | Relay exits non-zero naming the entry |
| A11 | Same `pane_id` reported by two hosts | All four pane commands return the ambiguity error; neither host is written to |
| A12 | Collision ends | Commands work again within one poll interval |
| A13 | Old client sends `create_tab` | Ignored; no crash, no local tab created |
