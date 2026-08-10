# Spec — Terminal Mode

**Date:** 2026-08-09
**Architecture:** `.workflow/02_architecture/2026-08-09_terminal_mode.md`
**Decisions:** `.workflow/02_architecture/decision_log/2026-08-09_terminal_mode_trust_model.md`
**Plans:** T1 — `.workflow/04_implementation_plans/2026-08-09_t1_terminal_read_only.md`

Behaviour only. Phase labels mark when each clause becomes live; a clause with no label is T1.

---

## 1. Definitions

| Term | Meaning |
|---|---|
| **Shell pane** | A pane herdr reports with no `agent` field and whose `label` is not `"· spacer ·"` |
| **Spacer** | A pane with no agent whose label is exactly `"· spacer ·"`. Never a shell pane |
| **Agent pane** | A pane herdr reports with an `agent` field. Unchanged by this spec |
| **Terminal mode** | `HERDR_ENABLE_TERMINAL=1` in the relay's environment |

A pane is exactly one of these three at any moment. A shell pane that is handed an agent becomes an
agent pane on the next poll, and leaves the shells list in the same snapshot that adds it to agents.

## 2. Relay — discovery

### 2.1 Terminal mode off (default)

The relay's observable behaviour is identical to before this feature. Shell panes are not parsed,
not broadcast, and not admitted to `known_panes`, `pane_remote_map`, or the ambiguity set.
`pane_guard` answers `"unknown pane_id"` for a shell pane, as it does today.

### 2.2 Terminal mode on

Each poll of each host parses the **existing** `herdr pane list` result into two lists. No additional
subprocess call is made; a diff that adds one has failed this clause.

| Input pane | Goes to |
|---|---|
| `agent` present | agents — unchanged in content and order |
| no `agent`, `label == "· spacer ·"` | dropped |
| no `agent`, any other label (including empty) | shells |

Every shell pane record carries:

| Field | Source | Notes |
|---|---|---|
| `pane_id` | `pane_id` | |
| `label` | `label`, default `""` | May be empty; the client supplies a fallback (§5.2) |
| `cwd` | `cwd`, default `""` | |
| `project` | `basename(cwd)` | Same derivation agents use |
| `host` | remote name, or `"local"` | |
| `workspace_id`, `tab_id` | as reported, default `""` | |
| `remote` | remote name, or `None` | |
| `project_id` | `annotate_agents` | Present only when a Project matches `cwd` + `host` |

A shell record carries exactly the fields an agent record carries, minus `agent` and `status`. That
includes `remote`, which the agent snapshot has always sent (`herdr_relay.py:299`) — matching it is
correct here, and narrowing it is a separate change to both lists, not a terminal-mode decision.

### 2.3 Guard registration

Shells join `known_panes`, `pane_remote_map`, and the ambiguity set **in the same poll pass** as
agents. The ambiguity computation runs over agents and shells together:

- A pane ID reported by more than one host is ambiguous whether it is an agent, a shell, or one of
  each. `pane_guard` refuses it.
- A shell pane that leaves the snapshot is removed from `known_panes` and `pane_remote_map` by the
  same stale-cleanup pass that removes agents.

### 2.4 Snapshot message

The existing snapshot gains one key. No new message type:

```json
{"type": "agents", "agents": [...], "shells": [...]}
```

- `shells` is present whenever terminal mode is on, including as `[]`. Absent when off.
- Sent on connect (the cached snapshot) and on every poll, exactly as `agents` is.
- `agent_update` is unchanged and never carries shells — a shell has no status to update.
- A shell record never carries `status` or `agent`, not even as `""` or `null`.

## 3. Relay — addressing a shell pane

Once terminal mode is on and a shell pane is in `known_panes`, `pane_guard` accepts it. The six
message types then behave as follows.

| Message | Shell pane | Notes |
|---|---|---|
| `read_pane` | **Allowed** | Unchanged, including `cols` and `source` |
| `send_keys` | **Allowed** | `SAFE_KEYS` allowlist unchanged |
| `rename_pane` | **Allowed** | `validate_pane_label` unchanged |
| `set_slot` | **Allowed** | Still behind `HERDR_ENABLE_WRITE_EXT` |
| `respond` | **Refused, permanently** | `"respond is not available on a terminal pane"` |
| `send_text` | **Refused in T1**, allowed from T2 | T1: `"terminal panes are read-only in this relay"` |

Refusals are `{"type": "error", "message": …}` on the requesting socket, and are logged. A refusal
never reveals anything the client did not already send.

Audit lines are unchanged in shape. Every accepted write to a shell pane is audited with the same
ip / device / listener attribution as a write to an agent pane.

## 4. Relay — startup

| Condition | Behaviour |
|---|---|
| `HERDR_ENABLE_TERMINAL` unset or not `1` | Terminal mode off. No log line |
| `HERDR_ENABLE_TERMINAL=1` | Terminal mode on. Log at INFO, naming the mode |
| `HERDR_ENABLE_TERMINAL=1` **and** `HERDR_LAN_OPEN=1` | Additionally log at **WARNING**, naming both settings and stating that any device on the LAN can run commands as the herdr user. The relay still starts — this combination is a decision, not an error (D2) |

The relay never refuses to boot over terminal mode.

## 5. Client — agent list

### 5.1 The Terminals section

Rendered through the existing `section()` helper, after Idle and before Recents.

- Present only when the snapshot carried a `shells` key with at least one entry. A relay with
  terminal mode off produces no section, no header, and no empty state — presence of the key is the
  feature gate, matching how `start_options` gates Start session.
- Filters with the active Project chip on `project_id`, exactly as agents do. A shell with no
  `project_id` appears only in the unfiltered list.
- Section colour is a dedicated variable, not the red / green / muted that mean agent status.
- Shells never appear in Blocked, Working, Done, or Idle.

### 5.2 The terminal card

| Element | Behaviour |
|---|---|
| Leading glyph | `$`, in the section colour. Never a status dot, never pulsing |
| Title | `label`, monospace. Falls back to `basename(cwd)`, then to `pane_id` |
| Second line | cwd, last two segments, as agents render it |
| Host suffix | `@host` when not local, as agents render it |
| Pair button | **Absent** |
| Activation | Click, Enter, or Space opens the terminal view. Same roles and ARIA as an agent card |

### 5.3 Recents and session history

A visited terminal enters Recents, the live header tab strip, and the back/forward history on the
same terms as an agent, and is rendered there with the terminal card. `navPush` and `navStep` are
unchanged — they key on `pane_id` and do not care what kind of pane it is. A history entry whose pane
has left the snapshot is skipped, which is existing behaviour and already covers a terminal that was
closed on the host.

## 6. Client — terminal view

### 6.1 Unchanged

Content region, ruler and line selection, all wrap modes, Load more, scroll and sticky-bottom,
Refresh, CLS, the slot control, session back/forward, and rename. `read_pane` does not care what is
in the pane, and none of this needs to.

### 6.2 Demarcation

- A 2px accent rule below the header, in the terminal colour.
- The title is prefixed `$ `.
- Both are driven by one class on the terminal view, set when the open pane is a shell and cleared
  when it is not. Nothing else may set it.

### 6.3 Absent in a terminal

Pair strip, Pair with… / Edit pair / Unpair menu items, Transfer, approval quick actions, the prompts
dock, and New session in \<project\>. Each is hidden by the pane being a shell, not by an incidental
absence of data — a shell must never show an empty pair strip or a disabled transfer button.

### 6.4 Input

| Phase | Composer |
|---|---|
| T1 | Text input and Send are **absent**. The keys pad is present, with Ctrl+C in the first row |
| T2 | Text input, Send, and the shortcut grid |

The keys pad in a terminal offers the same `SAFE_KEYS` set the agent view offers. Ctrl+C is promoted
to the first row because it is the only way to stop something that was started.

### 6.5 The open pane disappears

When a poll returns a snapshot in which the open terminal's `pane_id` is absent from both `agents`
and `shells`, the view closes back to the list and says the terminal ended. It does not keep polling
a dead ID, and it does not silently retarget: herdr reuses pane IDs, and writing into the pane that
inherited one is the worst failure available here.

## 7. Client — shortcuts (T2)

Stored under a versioned `localStorage` key following the `herdr_pairs` convention: an unreadable or
wrong-version blob is discarded and replaced with an empty set, and must not brick the terminal view.
**No stored value at all is a first run, not a corrupt one**, and seeds a small set of read-only
defaults — an empty grid is a dead end, and replacing something the user wrote is worse than showing
them nothing. Nothing that writes ships as a default.

Each entry is a label and a text. Sending is `send_text` followed by `send_keys ["Enter"]`, the same
two-step every composer already uses. An entry marked destructive arms on first tap and fires on the
second, reusing the Clear control's existing arm-and-fire behaviour rather than adding a modal.

The grid occupies the prompts dock rather than a fourth one: same place, same toggle, same "only one
dock is open" rule, and the pane's kind chooses the contents. The two are not interchangeable —
a prompt is inserted into the composer to be read before it is sent, a command is the thing sent —
so the dock's title and its opening button say which one is on screen.

No completion signal is displayed. herdr exposes no process lifetime; the view polls faster for a
short window after a send and then returns to the normal interval.

## 8. Creating a terminal (T3)

`open_terminal` takes a `project_id` and an optional placement, and creates a shell pane at that
Project's cwd. cwd comes from the Projects config and from nowhere else — a client may not supply a
path. Gated on `HERDR_ENABLE_WRITE_EXT` in addition to terminal mode, because it creates a process.
The new pane is labelled at creation, and never with the spacer label.

## 9. Failure modes

| Situation | Required behaviour |
|---|---|
| `herdr pane list` fails or returns unparseable JSON | Both lists empty for that host, as today. Never a partial list |
| A shell pane ID also appears on another host | Ambiguous. `pane_guard` refuses every message for it. It still renders in the list, and opening it surfaces the relay's refusal rather than a silent failure |
| Terminal mode on, no shell panes anywhere | `shells: []`. No section rendered. Not an error |
| Client newer than relay sends `open_terminal` to a T1 relay | The existing unknown-message-type error, which already says the relay may be older than the client |
| Relay newer than client | The client ignores the `shells` key. iOS, macOS, Telegram, and the TUI are unaffected and require no change |
| A shell pane gains an agent between polls | It leaves `shells` and enters `agents` in the same snapshot. If it was open, the view drops the terminal class and gains the agent controls on that snapshot |
| `send_text` to a shell pane in T1 | Refused with a message naming the reason. Not silently dropped |

## 10. Acceptance

1. With `HERDR_ENABLE_TERMINAL` unset, the relay's wire output is byte-identical to before the
   change for the same herdr state.
2. With it set, a shell pane appears in `shells`, in `known_panes`, and in the ambiguity computation,
   and carries no `status` or `agent` key.
3. Two hosts reporting the same shell pane ID make it ambiguous, and every message for it is refused.
4. A spacer never appears in `shells`.
5. `read_pane` and `send_keys` succeed against a shell pane; `send_text` and `respond` are refused
   with distinct messages.
6. The web app renders a Terminals section that no agent appears in, and an agent group that no
   shell appears in.
7. Opening a terminal shows the accent rule and the `$` prefix, and shows no pair, transfer, prompt,
   or approval affordance.
8. `HERDR_ENABLE_TERMINAL=1` with `HERDR_LAN_OPEN=1` logs a warning naming both.
