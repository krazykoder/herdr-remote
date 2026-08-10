# Plan P6 — Realign Start session with herdr 0.8.0 `agent start`

**Class: B** — architectural extension, backward-compatible at the WebSocket boundary.
No client-visible protocol change: `start_agent` message shape, `ok`/`error` reply, and
`HERDR_ENABLE_WRITE_EXT` gating are untouched. The change is confined to how the relay
drives the herdr CLI.

Spec of record: `.workflow/03_specs/2026-08-08_start_agent_spec.md` (§3 remains binding —
never claim success after a partial operation).

---

## 1. Proof of Discovery

### Affected modules

| Module | Role in the flow |
|--------|------------------|
| `relay/start_agent.py` | Pure argv builders + request validation. Owns `agent_start_args`, `tab_create_args`, `workspace_create_args`. |
| `relay/herdr_relay.py` | `start_agent_exec` orchestrates create → start → rename → rollback. `run_herdr_result` is the single subprocess boundary. |
| `tests/test_start_agent.py` | Unit coverage for the builders and validation. |
| `tests/e2e/bin/herdr` | Fake herdr — must model the new response shapes. |
| `tests/e2e/e2e_start_agent.py` | Asserts exact argv strings; every start assertion is now wrong. |

### Blast radius

`agent_start_args` — 6 call sites in `relay/herdr_relay.py`, 4 assertions in
`tests/test_start_agent.py`, 7 assertions in `tests/e2e/e2e_start_agent.py`.
`start_agent_exec` — 1 caller (the `start_agent` WebSocket handler), no unit coverage;
its only guard is the e2e suite.

Nothing outside the Start-session path is affected. Verified against herdr 0.8.0 that
every other command the relay issues is unchanged: `pane list`, `pane layout --pane`,
`pane read --lines --source recent`, `pane send-text`, `pane send-keys`, `pane rename`,
`tab create --workspace --focus`, `agent list`. The iOS/mac/Telegram clients never
construct herdr argv.

### What herdr 0.8.0 changed

Old (0.7.x): `agent start <label> --cwd P --workspace|--tab ID [--split right] --focus -- <bin>`
— herdr created the pane itself, anchored to a container.

New (0.8.0): `agent start <name> --kind KIND --pane ID [--timeout MS] [-- <agent-args>...]`
— **herdr no longer creates a pane.** It attaches an agent to an existing pane that is
already at its interactive shell prompt. Gone: `--cwd`, `--workspace`, `--tab`,
`--split`, `--focus`. New and required: `--kind` (from a fixed enum) and `--pane`.

Confirmed from `herdr api schema --json`:

- `AgentStartParams` requires `name`, `kind`, `pane_id`; optional `args`, `timeout_ms`.
- `workspace.create` → `result.workspace.workspace_id` + `result.root_pane.pane_id` (unchanged).
- `tab.create` → `result.tab.tab_id` + `result.root_pane.pane_id` (unchanged), and
  `TabCreateParams` now accepts `cwd`.
- `pane.split` → `result.pane.pane_id`; `PaneSplitParams` accepts `cwd`, `direction`, `focus`.
- `agent.start` → `result.agent.pane_id` (unchanged), so `dig(data, "result", "agent", "pane_id")` still holds.

Valid `--kind` values: `pi claude codex gemini cursor devin agy cline omp mastracode
opencode copilot kimi kiro droid amp grok hermes kilo qodercli maki`.

### Invariants to preserve

1. **cwd and host come from the Project, never from the wire** (D4). The cwd now rides on
   the *container-creating* command instead of `agent start`; it must still originate from
   `project["cwd"]`.
2. **No success after a partial operation** (spec §3). Rollback still required when the
   agent fails to start after the relay created a container.
3. `anchor_kind` was never client-supplied; its replacement (`--pane <id>`) must likewise
   only ever carry an id the relay just minted or one that passed `validate_start_request`.
4. `unique_agent_name` still applies — herdr agent names remain unique per host.

### Three defects, not one

**D1 — `unknown option: --cwd`.** The reported symptom. Root cause: the argv builder
targets the 0.7.x grammar.

**D2 — latent 15 s subprocess timeout.** `run_herdr_result` hard-codes `timeout=15`
(`relay/herdr_relay.py:257`). In 0.8.0 `agent start` *blocks waiting for interactive
readiness*, default 30000 ms. Once D1 is fixed, a cold `claude`/`codex` start — and any
start over SSH — will be killed by `subprocess.TimeoutExpired` at 15 s while herdr is
still legitimately waiting. The user would see a start that reports failure but leaves a
working agent behind, and a container that never gets rolled back. Fixing D1 alone ships
this bug. All three are in scope.

**D3 — every session name herdr will now refuse.** Found while validating the new grammar
against the real binary, after D1/D2 were written up. herdr 0.8.0 validates the agent name
against `^[a-z][a-z0-9_-]{0,31}$` *before* it looks at the pane:

```
$ herdr agent start "Backend" --kind claude --pane w99:p99
{"error":{"code":"invalid_agent_name","message":"agent name must start with a lowercase
letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)"}}
$ herdr agent start "backend-xbeoe" --kind claude --pane w99:p99
{"error":{"code":"agent_pane_not_found", ...}}          # name accepted, pane is the only problem
```

Every name the relay produces is illegal under that rule: `next_role_label` yields
`Architect 1` (space, capital), and `unique_agent_name`'s collision suffix is uppercase
(`-XBEOE`). Fixing D1 and D2 alone would turn `unknown option: --cwd` into
`invalid_agent_name` on *every* start. `pane rename` is unaffected — probed with
`"Architect 1"` and it got as far as `pane_not_found`, so pretty labels are still fine
there. The label and the herdr agent name must therefore stop being the same string.

### D3's fix: label and agent name diverge

`agent_name_from_label(label, fallback)` slugs the label — lowercase, non-`[a-z0-9_-]`
collapsed to a single `-`, leading digits and dashes stripped so it starts with a letter,
bounded to 32, falling back to the agent kind when a label slugs away to nothing. The plan
carries `agent_name` alongside `label`: `agent start` gets the slug, while `pane rename` and
the `command_result` reply keep the label the user chose. `unique_agent_name`'s collision
suffix moves onto the slug and its alphabet becomes lowercase (`l` and `o` stay excluded, so
a name read off a phone is not retyped as `1` or `0`).

### Simplification the new grammar unlocks

The relay currently creates a workspace/tab, lets `agent start` **split** that container's
root shell pane, then closes the now-idle shell (`herdr_relay.py:481-488`). In 0.8.0 the
root shell pane *is* the pane the agent attaches to. The `shell_pane` bookkeeping and the
`pane close` step are deleted outright — fewer commands, no half-width session, and one
fewer partial-failure branch.

Likewise, `split` placement no longer needs the source pane's `tab_id`: it becomes an
explicit `pane split <split_from> --direction right`. The `tab_id` lookup and its
`"pane has no tab_id"` refusal are deleted.

---

## 2. File-by-file changes

### `[MODIFY] relay/start_agent.py`

**2.1 — `PLACEMENTS` / plan field for `split`.** Store the source pane id, not its tab.

Replace the `elif placement == "split":` tail (lines 183-186):

```python
        source = matches[0]
        if source.get("remote") != remote:
            return None, "pane is not on this project's host"
        if source.get("project_id") != project["id"]:
            return None, "pane does not belong to this project"
        plan["split_from"] = split_from
```

Delete the `tab_id = source.get("tab_id")` lookup and the `"pane has no tab_id"` branch —
herdr 0.8.0 splits a pane by pane id, so the tab is no longer part of the request.

**2.2 — `tab_create_args` carries cwd.** The tab's root pane is now the agent's pane, so
the working directory has to be set when the tab is created.

```python
def tab_create_args(workspace_id, cwd, label):
    return ("tab", "create", "--workspace", workspace_id, "--cwd", cwd,
            "--label", label, "--focus")
```

`workspace_create_args` is unchanged — it already passed `--cwd`.

**2.3 — `[NEW]` `pane_split_args`.** The split placement's container step.

```python
def pane_split_args(pane_id, cwd):
    """Split an existing pane to the right, landing a shell at the Project's cwd.

    herdr 0.8.0 attaches an agent to a pane that already exists, so the relay creates the
    pane itself instead of asking `agent start` to split one.
    """
    return ("pane", "split", pane_id, "--direction", "right", "--cwd", cwd, "--focus")
```

**2.4 — `agent_start_args` rewritten.** Signature drops `cwd`, `anchor_kind`, `anchor_id`,
and `split`; gains the target pane.

```python
def agent_start_args(kind, label, pane_id, timeout_ms=AGENT_START_TIMEOUT_MS):
    """herdr 0.8.0 attaches an agent to an existing pane at its shell prompt.

    The positional is herdr's *agent name*, unique per host — the session label goes there,
    as it did before, because passing the kind there let the first start of an agent succeed
    and every later one fail agent_name_taken. `kind` is the allowlisted agent kind.

    pane_id is always a pane the relay just created or one that passed
    validate_start_request — never a raw client value.
    """
    return ("agent", "start", label, "--kind", kind, "--pane", pane_id,
            "--timeout", str(timeout_ms))
```

With, near the other module constants:

```python
# herdr waits this long for the agent to reach interactive readiness. Explicit rather than
# left to herdr's 30 s default because the relay's own subprocess timeout must exceed it —
# see START_EXEC_TIMEOUT in herdr_relay.py.
AGENT_START_TIMEOUT_MS = 30_000
```

**2.5 — `load_start_agents` docstring.** `HERDR_START_AGENTS` is now an allowlist of herdr
*agent kinds*, not of binaries on the target host's PATH. The parsing rule
(`^[a-z0-9_-]{1,32}$`) is unchanged and every default (`codex`, `claude`, `pi`) is a valid
0.8.0 kind. Do **not** hard-code herdr's kind enum here — herdr rejects an unknown kind
with its own actionable message, and mirroring the enum would rot on every herdr release.
Amend the docstring to say "kind" and drop the "whatever binary matches … on PATH" clause.

### `[MODIFY] relay/herdr_relay.py`

**2.6 — `run_herdr_result` takes a timeout.** Fixes D2 at the single subprocess boundary
rather than per caller.

```python
def run_herdr_result(*args, remote=None, timeout=15):
    if remote:
        cmd = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes", remote, HERDR, *args]
    else:
        cmd = [HERDR, *args]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
```

The 15 s default stays: the poll loop's `pane list` must fail fast on a dead SSH host.
Thread the same kwarg through `_herdr_json(*args, remote=None, timeout=15)` so the start
path can raise it, and define beside it:

```python
# agent start blocks until the agent is interactively ready (AGENT_START_TIMEOUT_MS), so the
# subprocess must outlive herdr's own wait — otherwise a slow cold start is killed here and
# reported as a failure while the agent is in fact coming up.
START_EXEC_TIMEOUT = AGENT_START_TIMEOUT_MS / 1000 + 15
```

**2.7 — `start_agent_exec` rewritten.** Every placement now resolves to a concrete pane id
before `agent start` runs; the shell-pane bookkeeping is deleted.

```python
def start_agent_exec(plan):
    """Run a validated start plan. Returns (pane_id, error).

    Blocking; call through asyncio.to_thread. Never claims success after a partial
    operation — a created workspace, tab, or pane may remain as empty native layout, but no
    session is reported unless the agent actually started (spec §3).
    """
    remote = plan["remote"]
    placement = plan["placement"]
    # Settle the name before anything is created: it is the herdr agent name as well as the
    # pane label, and a collision fails the start after a container already exists.
    plan["label"] = unique_agent_name(plan["label"], live_agent_names(remote))

    # herdr 0.8.0 attaches an agent to a pane already sitting at its shell prompt, so the
    # relay creates that pane. A new workspace or tab is born holding exactly one — that one
    # becomes the agent's pane, so there is no idle shell left to close.
    rollback = None

    if placement == "new_workspace":
        data, err = _herdr_json(*workspace_create_args(plan["cwd"], plan["project_label"]),
                                remote=remote)
        if err:
            return None, err
        workspace_id = dig(data, "result", "workspace", "workspace_id")
        target_pane = dig(data, "result", "root_pane", "pane_id")
        if not workspace_id or not target_pane:
            return None, "workspace create returned no workspace_id or root pane"
        rollback = ("workspace", "close", workspace_id)
    elif placement == "new_tab":
        data, err = _herdr_json(
            *tab_create_args(plan["workspace_id"], plan["cwd"], plan["label"]), remote=remote)
        if err:
            return None, err
        tab_id = dig(data, "result", "tab", "tab_id")
        target_pane = dig(data, "result", "root_pane", "pane_id")
        if not tab_id or not target_pane:
            return None, "tab create returned no tab_id or root pane"
        rollback = ("tab", "close", tab_id)
    else:  # split — the source pane's sibling is the user's own, so only the new pane rolls back
        data, err = _herdr_json(*pane_split_args(plan["split_from"], plan["cwd"]), remote=remote)
        if err:
            return None, err
        target_pane = dig(data, "result", "pane", "pane_id")
        if not target_pane:
            return None, "pane split returned no pane_id"
        rollback = ("pane", "close", target_pane)

    data, err = _herdr_json(*agent_start_args(plan["name"], plan["label"], target_pane),
                            remote=remote, timeout=START_EXEC_TIMEOUT)
    if err:
        _rollback_layout(rollback, remote)
        return None, err
    pane_id = dig(data, "result", "agent", "pane_id")
    if not pane_id:
        _rollback_layout(rollback, remote)
        return None, "agent start returned no pane_id"

    try:
        rename = run_herdr_result(*pane_rename_args(pane_id, plan["label"]), remote=remote)
    except Exception as e:
        return None, f"agent started as {pane_id} but pane rename failed: {e}"
    if rename.returncode != 0:
        return None, f"agent started as {pane_id} but pane rename exited {rename.returncode}"
    return pane_id, None
```

Deleted: the `shell_pane` variable, the `pane close` block at 481-488, and the `split=True`
branch. Rollback for `split` is now `pane close <new pane>` — safe because the id is one the
relay minted seconds earlier, matching `_rollback_layout`'s existing contract.

Update the import block (lines 21-29) to add `pane_split_args` and `AGENT_START_TIMEOUT_MS`.

### `[MODIFY] tests/e2e/bin/herdr`

Add a `pane split` response and correct the stale comment on `workspace create`:

```python
elif args[:2] == ["pane", "split"]:
    print(json.dumps({"result": {"pane": {"pane_id": f"{host}:pSplit"}}}))
```

The `workspace create` / `tab create` branches keep returning `root_pane`, but the comment
above them ("which is why the relay closes it once the agent's own pane exists") is now
false — the root pane *is* the agent's pane. Rewrite it accordingly.

`FAKE_FAIL="pane split"` must work for the split rollback case; it already does, since the
fail hook matches on `" ".join(args[:2])`.

### `[MODIFY] tests/test_start_agent.py`

- `test_split_plan` (≈line 183): assert `plan["split_from"] == "w1:p2"`, not `plan["tab_id"]`.
- Delete `test_pane_without_tab_id_refused` (≈line 213) — the refusal no longer exists.
- `tab_create_args` assertion (≈line 222): expect `--cwd` in the tuple.
- The three `agent_start_args` assertions (≈lines 226-237): expect
  `("agent", "start", "Architect 1", "--kind", "claude", "--pane", "local:pShell", "--timeout", "30000")`.
- Keep `test_herdr_agent_name_is_the_label_not_the_binary` — the invariant survives, only
  the flag spelling changed. Rename it to `…_not_the_kind`.
- `[NEW]` `test_pane_split_args` — asserts direction, cwd, and that the pane id is the
  first positional.

### `[MODIFY] tests/e2e/e2e_start_agent.py`

Rewrite the argv assertions to the 0.8.0 grammar:

| Check | New expectation |
|-------|-----------------|
| A1 local | `local workspace create --cwd /work/charts --label Charts --focus` then `local agent start Architect 2 --kind claude --pane local:pShell --timeout 30000` |
| A1 remote | `box workspace create --cwd /srv/relay --label Relay --focus` then `box agent start Reviewer 2 --kind codex --pane box:pShell --timeout 30000` |
| A2 | `box tab create --workspace w2 --cwd /srv/relay --label Agent 1 --focus` then `box agent start Agent 1 --kind claude --pane box:pShell --timeout 30000` |
| A3 split | `local pane split w1:p1 --direction right --cwd /work/charts --focus` then `local agent start Architect 2 --kind claude --pane local:pSplit --timeout 30000`, and still no `tab create` |

Delete both `pane close local:pShell` / `pane close box:pShell` assertions (lines 213, 243)
— the shell pane is no longer closed. Replace them with the inverse assertion, so a
regression that reintroduces the close is caught: `not log_lines("pane close")`.

`[NEW]` L3c — `FAKE_FAIL="agent start"` with `placement="split"` must log
`pane close local:pSplit` and report `ok:false`. This is the one rollback path with no
existing coverage, and it is the path most likely to leak panes into a user's real session.

### `[MODIFY] CLAUDE.md`

`HERDR_START_AGENTS` row: "Comma-separated allowlist of herdr *agent kinds* for Start
session (default: `codex,claude,pi`)". Note the minimum herdr version is 0.8.0.

---

## 3. Verification commands

```bash
source .venv313/bin/activate

# Unit
.venv313/bin/python -m unittest discover -s tests -t tests

# End-to-end against the fake herdr on two simulated hosts
.venv313/bin/python tests/e2e/e2e_start_agent.py

# Frontend pair/transfer logic (must stay green — untouched by this change)
node --test tests/test_pairs.js

# Live smoke against real herdr 0.8.0, all three placements.
# Run the relay with HERDR_ENABLE_WRITE_EXT=1 and start one agent per placement from the
# web app. Confirm for each: the agent occupies the FULL pane (no idle shell beside it),
# `herdr pane list` shows the pane labelled with the session label, and the pane's cwd is
# the Project's cwd.
herdr agent list
herdr pane list
```

---

## 4. Acceptance criteria

1. `herdr agent start: unknown option: --cwd` no longer occurs for any placement.
2. All three placements start an agent that occupies the whole pane — no leftover shell,
   no half-width session.
3. The started pane's cwd is the Project's configured cwd, for all three placements,
   local and over SSH.
4. A failed `agent start` leaves no workspace, tab, or pane behind, and replies `ok:false`
   carrying herdr's own error message.
5. A cold start that takes longer than 15 s succeeds rather than being killed by the
   subprocess timeout (D2).
6. `HERDR_START_AGENTS` still gates which agents may be started; an unknown kind is
   refused with herdr's message rather than silently executing anything.
7. A session labelled `Architect 1` starts — the label reaches the pane and the reply, and
   herdr is asked for `architect-1` (D3).
8. No change to the `start_agent` WebSocket message shape — existing web/iOS/mac clients
   work unmodified.

---

## 5. Decision log entry (to file under `.workflow/02_architecture/decision_log/`)

**herdr 0.8.0 moves pane creation out of `agent start`; the relay owns it now.** 0.8.0
redefines `agent start` as "attach an agent to an existing pane at its shell prompt",
removing `--cwd`/`--workspace`/`--tab`/`--split`. Rather than reconstruct the old
one-command behaviour, the relay now creates the target pane explicitly — `workspace
create`, `tab create`, or the new `pane split` — and passes its id to `agent start`. This
is strictly simpler than what it replaces: the root shell pane becomes the agent's pane, so
the create-split-then-close-the-shell dance and its partial-failure branch are deleted, and
`split` placement no longer needs to resolve the source pane's `tab_id`. The one cost is
that `agent start` now blocks on interactive readiness, which forced the relay's
single-valued 15 s subprocess timeout to become a per-call one — the poll loop keeps 15 s so
a dead SSH host still fails fast, while the start path is given herdr's wait plus headroom.
