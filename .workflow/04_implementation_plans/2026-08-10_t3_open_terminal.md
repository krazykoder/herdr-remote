# Plan — T3: Creating a terminal

**Date:** 2026-08-10
**Spec:** `.workflow/03_specs/2026-08-09_terminal_mode_spec.md` §8
**Architecture:** `.workflow/02_architecture/2026-08-09_terminal_mode.md`
**Decisions:** `.workflow/02_architecture/decision_log/2026-08-09_terminal_mode_trust_model.md`
**Precedes:** T1 `f1cd623`, T2 `d9ffd71`

---

## 1. Goal

`open_terminal` creates a shell pane at a Project's cwd, and the web app offers it as
`+ New terminal` beside `+ Start session`. Gated on `HERDR_ENABLE_TERMINAL=1` **and**
`HERDR_ENABLE_WRITE_EXT=1` — it spawns a process, which is what the second gate governs.

`open_terminal` is `start_agent` with the `agent start` step removed. It is written that way on
purpose: the placement rules, the host resolution, the cwd-from-Projects rule, and the rollback
are the parts that decide whether a spawn is *allowed*, and they must not fork into two versions
that drift.

---

## 2. `relay/start_agent.py` [MODIFY]

### 2.1 Extract the shared half of `validate_start_request`

Everything from the Project lookup down to the placement-specific checks is identical for both
messages. Move it into `_placement_plan(msg, projects, panes, base_fields, default_label)` →
`(plan, error)`, and leave `validate_start_request` holding only what is agent-specific: the
`name` allowlist check, the `role` check, and stitching both onto the returned plan.

Check order is preserved exactly — name, role, project, placement, unexpected fields, required
field, label, slot, then placement-specific. `tests/test_start_agent.py` asserts on those
messages and must pass untouched.

### 2.2 `validate_open_terminal(msg, projects, panes)` [NEW]

```python
OPEN_TERMINAL_FIELDS = {"type", "project_id", "placement", "label", "slot"}
```

- No `name`, no `role`: there is no agent to name and no role to play.
- Default label `next_role_label("terminal", project_id, panes)` — "Terminal 1", the same
  sequence agents get, counted over the panes it is given.
- **The spacer label is refused.** `plan_slot` closes a pane carrying it, so a client that could
  set it could ask the relay to create a pane the relay would later delete out from under them.
  This is the one rule `validate_start_request` does not need and this one does.
- `panes` is `latest_agents + latest_shells`, not agents alone: a workspace holding only
  terminals is a legitimate place to open another tab, and a terminal is a legitimate pane to
  split off. That is the caller's choice, which is why the list is a parameter.

---

## 3. `relay/herdr_relay.py` [MODIFY]

### 3.1 Extract `_create_target_pane(plan, remote)` from `start_agent_exec`

The three placement branches — new workspace, new tab (with the spacer reuse), split — end in
`(target_pane, rollback)` and are what both messages need. `start_agent_exec` keeps everything
from `agent_start_args` onward.

Spacer reuse stays in the shared half. A spacer is a shell at the Project's cwd; renaming it into
a terminal is exactly what claiming it means, and it stops being reclaimable the moment its label
changes.

### 3.2 `open_terminal_exec(plan)` [NEW]

```
target_pane, rollback, err = _create_target_pane(plan, remote)
rename to plan["label"]        # not optional — a claimed spacer still carries the spacer label
                               # until this lands, and plan_slot may close it
slot, if asked, non-fatal      # same as start: a width preference never fails a create
```

Rollback on a rename failure, unlike `start_agent_exec`: there, a rename failure leaves a working
agent worth more than its label. Here the pane *is* the deliverable and an unrenamed one may be a
spacer, so a create that cannot name what it made reports failure and takes the pane with it.

### 3.3 Handler and capability

- `open_terminal`: refuse with `"write extensions disabled"` when `WRITE_EXT` is off and
  `"terminal mode disabled"` when `TERMINAL` is off, both as `command_result … ok: false`.
  Audited exactly as `start_agent` is, with the same ip / device attribution.
- `start_options` gains `"terminal": TERMINAL`. Presence of `start_options` is already the
  client's gate for Start; this makes it the gate for New terminal too, and it is only sent when
  `WRITE_EXT` is on — so the flag is true only when both gates are.

---

## 4. `web/index.html` [MODIFY]

One dialog, two modes. `startMode` is `'agent'` or `'terminal'`; `openStartDialog(projectId, ev,
mode)` sets it, hides the Role and Agent rows in terminal mode, and retitles the sheet and its
submit button. `submitStart` sends `open_terminal` without `name` and `role`.

Everything else is shared and stays shared: placement, target resolution, the label field, the
`slotFor()` rule, the remembered placement, and the disabled-submit fallback to New workspace.

- `+ New terminal` chip beside `+ Start session` in the active Project strip, shown when
  `startOptions.terminal` is true.
- `renderStartTarget` lists `agents` today. It must list `agents + shells` in terminal mode, or a
  Project whose only live panes are terminals can never place one beside another.
- `openPendingStart` searches `agents`; it must search both lists, or a created terminal is never
  opened and the pending id sticks.
- The `command_result` branch handles `open_terminal` alongside `start_agent`.

---

## 5. Tests

**`tests/test_open_terminal.py` [NEW]** — `validate_open_terminal` is pure. Unknown project,
unknown placement, `name`/`role` rejected as unexpected fields, the spacer label refused, a bad
slot refused, the default label sequence, cwd and remote taken from the Project and never from
the message, a workspace or split target belonging to another Project or another host refused,
and a shell being a valid split source.

**`tests/test_start_agent.py`** — untouched. It is the regression check on the extraction.

**`tests/e2e/e2e_start_agent.py` [MODIFY]** — a new run: refused with terminal mode off, refused
with write extensions off, and with both on a create that reaches herdr as
`workspace create --cwd <project cwd>` followed by `pane rename`, with no `agent start` anywhere
in the log. Plus the spacer-label refusal reaching no herdr call at all.

## 6. Verification

```bash
.venv313/bin/python -m unittest discover -s tests -t tests
node --test tests/test_pairs.js
.venv313/bin/python tests/e2e/e2e_start_agent.py
```

Manual, against real herdr with both gates on: `+ New terminal` in a Project, into each of the
three placements; the pane appears under Terminals, opens, and runs a command.

## 7. Acceptance

1. `open_terminal` with either gate off is refused, and creates nothing.
2. With both on, it creates a shell pane at the Project's cwd, labelled, and never starts an agent.
3. cwd and host come from the Projects config; a `cwd` field on the wire is an unexpected field.
4. A client-supplied spacer label is refused.
5. The created pane appears in `shells` on the next poll and the client opens it.
6. `tests/test_start_agent.py` passes unchanged.
