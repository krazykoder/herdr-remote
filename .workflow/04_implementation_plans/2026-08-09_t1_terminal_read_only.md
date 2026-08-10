# Plan — T1: Terminal panes, read-only

**Date:** 2026-08-09
**Spec:** `.workflow/03_specs/2026-08-09_terminal_mode_spec.md` (clauses without a phase label)
**Architecture:** `.workflow/02_architecture/2026-08-09_terminal_mode.md`
**Decisions:** `.workflow/02_architecture/decision_log/2026-08-09_terminal_mode_trust_model.md`

---

## 1. Goal

Shell panes become visible and readable. They appear in their own Terminals section, open in the
terminal view with a `$` prefix and an accent rule, answer `read_pane` and `send_keys`, and refuse
`send_text` and `respond`. Behind `HERDR_ENABLE_TERMINAL`, default off, where off means the relay
behaves exactly as it does today.

Out of scope for T1: `send_text`, the shortcut grid, `open_terminal`. Do not build them.

---

## 2. `relay/herdr_relay.py` [MODIFY]

### 2.1 Import `is_spacer`

Add to the existing `from start_agent import (…)` block at line 18, in alphabetical position among
its neighbours:

```python
    is_spacer,
```

### 2.2 Environment flag

Beside `WRITE_EXT` (line 113):

```python
# Not folded into HERDR_ENABLE_WRITE_EXT: that gate exists for starting agents, and someone who
# enabled it to spawn a session from a phone did not thereby consent to a shell. Off means the
# shells are never parsed, so known_panes does not grow and pane_guard behaves exactly as before.
TERMINAL = os.environ.get("HERDR_ENABLE_TERMINAL", "") == "1"
```

### 2.3 Globals

Beside `latest_agents` (line 172):

```python
latest_shells = []  # shell panes from the same snapshot; empty and unused when TERMINAL is off
shell_panes = set()  # pane IDs in latest_shells, for the write refusals below
```

### 2.4 `split_panes` [NEW] — pure, and where the whole change lives

Insert immediately above `get_agents_from_host` (line 284). Pure so it can be tested without a
subprocess, following `plan_slot`:

```python
def split_panes(panes, host_label, remote=None, include_shells=False):
    """(agents, shells) from one host's parsed `pane list`. Pure.

    Shells were always in this payload — the agent filter is the only reason a client has never
    seen one, and reading them costs no extra call. Returned as a second list rather than tagged
    into the first: a shell has no status, and a snapshot that *can* carry one into an agent group
    is a snapshot that eventually will.

    Spacers are dropped. A spacer is a usable shell, and it is also the only pane this application
    closes on its own (`plan_slot`), so listing one offers the reader a pane the product may delete
    out from under them.
    """
    agents, shells = [], []
    for p in panes:
        if p.get("agent"):
            agents.append({
                "pane_id": p["pane_id"],
                "agent": p.get("agent", ""),
                "label": p.get("label", ""),
                "status": p.get("agent_status", "unknown"),
                "cwd": p.get("cwd", ""),
                "project": os.path.basename(p.get("cwd", "")),
                "host": host_label,
                "remote": remote,
                "workspace_id": p.get("workspace_id", ""),
                "tab_id": p.get("tab_id", ""),
            })
        elif include_shells and not is_spacer(p):
            shells.append({
                "pane_id": p["pane_id"],
                "label": p.get("label", ""),
                "cwd": p.get("cwd", ""),
                "project": os.path.basename(p.get("cwd", "")),
                "host": host_label,
                "remote": remote,
                "workspace_id": p.get("workspace_id", ""),
                "tab_id": p.get("tab_id", ""),
            })
    return agents, shells
```

> **The agent dict is copied verbatim, key order included.** Acceptance §7.1 requires byte-identical
> wire output with the flag off, and `json.dumps` preserves insertion order. Do not refactor the two
> literals into a shared base — that reorders the agent keys and fails the check.

### 2.5 `get_agents_from_host` → `get_panes_from_host` [MODIFY]

Replace the body (284–306) with the IO half only:

```python
def get_panes_from_host(remote=None):
    raw = run_herdr("pane", "list", remote=remote)
    try:
        panes = json.loads(raw).get("result", {}).get("panes", [])
    except (json.JSONDecodeError, KeyError, AttributeError):
        return [], []
    return split_panes(panes, remote or "local", remote, include_shells=TERMINAL)
```

`AttributeError` is added because `json.loads("null")` returns `None`, which the old `.get` chain
would have raised on outside the caught set.

### 2.6 `get_all_agents` → `get_all_panes` [MODIFY]

```python
def get_all_panes():
    agents, shells = get_panes_from_host(remote=None)
    for remote in REMOTES:
        more_agents, more_shells = get_panes_from_host(remote=remote)
        agents.extend(more_agents)
        shells.extend(more_shells)
    return annotate_agents(agents, PROJECTS), annotate_agents(shells, PROJECTS)
```

`annotate_agents` matches on `cwd` + `host` and is agnostic to what else is in the dict, so Project
filtering for terminals costs one call.

### 2.7 `snapshot_message` [NEW]

Below `get_all_panes`. Both send sites must produce the same message, and the flag must be checked in
exactly one place:

```python
def snapshot_message():
    """The full-state broadcast. `shells` is present whenever terminal mode is on, including as
    an empty list — its presence is the client's feature gate, as start_options is for Start."""
    msg = {"type": "agents", "agents": latest_agents}
    if TERMINAL:
        msg["shells"] = latest_shells
    return msg
```

### 2.8 `_poll_once` [MODIFY]

```python
async def _poll_once():
        global latest_agents, latest_shells
        agents, shells = get_all_panes()
        latest_agents = agents
        latest_shells = shells
        ambiguous_panes.clear()
        # Over both lists: a shell pane ID is a per-server counter and collides across hosts
        # exactly as an agent's does (D6). A pane the relay will address but has not collision-
        # checked is the bug this set exists to prevent.
        ambiguous_panes.update(ambiguous_pane_ids(agents + shells))
        shell_panes.clear()
        shell_panes.update(s["pane_id"] for s in shells)
        # Always broadcast (even empty list) so clients stay in sync
        for p in agents + shells:
            pane_remote_map[p["pane_id"]] = p.get("remote")
            known_panes.add(p["pane_id"])
        for a in agents:
            agent_cache[a["pane_id"]] = a
        await broadcast(snapshot_message())
```

The blocked-detection loop below it is unchanged and still iterates `agents` only.

Stale cleanup at the end of the function:

```python
        current_pane_ids = {p["pane_id"] for p in agents + shells}
```

The rest of that block is unchanged — `last_statuses` and `agent_cache` never held shell entries, and
`.pop(pid, None)` on an absent key is already a no-op.

### 2.9 Connect-time snapshot [MODIFY]

Line 858:

```python
            await ws.send(json.dumps(snapshot_message()))
```

Keep the existing Projects conditional for the `projects` and `start_options` messages. Send the
cached snapshot when `PROJECTS` is enabled, or when `TERMINAL` is enabled; with both disabled, keep
the legacy no-Projects connect wire unchanged.

### 2.10 Write refusals [MODIFY]

In `respond`, immediately after its `pane_guard` block:

```python
                # Permanent, not a phase gate: SAFE_RESPONSES is a list of agent approval strings,
                # and sending "yes, single permission" to a shell is meaningless at best.
                if pane_id in shell_panes:
                    await ws.send(json.dumps({"type": "error",
                                              "message": "respond is not available on a terminal pane"}))
                    continue
```

In `send_text`, immediately after its `pane_guard` block:

```python
                # T1 only — deleted in T2, which is what makes terminals writable. Admitting a
                # shell pane to known_panes makes pane_guard accept it for every message type at
                # once, so read-only has to be stated rather than assumed.
                if pane_id in shell_panes:
                    await ws.send(json.dumps({"type": "error",
                                              "message": "terminal panes are read-only in this relay"}))
                    continue
```

`read_pane`, `send_keys`, `rename_pane`, and `set_slot` are **not** touched.

### 2.11 Startup logging [MODIFY]

Beside the existing `if LAN_OPEN:` warning (line 1137), after it:

```python
    if TERMINAL:
        log.info("HERDR_ENABLE_TERMINAL=1: shell panes are listed and readable")
    if TERMINAL and LAN_OPEN:
        log.warning(
            "HERDR_ENABLE_TERMINAL=1 with HERDR_LAN_OPEN=1: any device that can reach the LAN "
            "listener can send keys to a shell on this machine, with no token")
```

### 2.12 Stale comment [MODIFY]

`slot_exec` docstring (line 458) says the snapshot drops panes with no agent. Amend to: the snapshot
drops spacers, and drops every shell when terminal mode is off — so `slot_exec` still cannot rely on
it and still reads its own `pane list`.

---

## 3. `web/index.html` [MODIFY]

### 3.1 Theme variable

One variable per theme block, beside the existing accent colours. Name `--term`. Suggested value:
the theme's cyan or teal where it has one, else `--blue` shifted. It must not equal `--red`,
`--green`, or `--muted`, which carry agent status.

### 3.2 State and snapshot

Beside `agents` (line 1753): `shells = []`.

In the `msg.type === 'agents'` handler (2284), after `agents = msg.agents;` and before `render()`:

```js
        shells = Array.isArray(msg.shells) ? msg.shells : [];
```

Not `msg.shells || []` — a relay with terminal mode off sends no key, and this must read as "no
terminals", never as a crash on a later `.filter`.

### 3.3 Pane lookup spanning both lists [NEW]

Beside `paneLabel` (2993):

```js
    // Every existing lookup is agents.find(...), which returns undefined for a terminal and takes
    // the whole terminal view down to a pane_id title. One helper, used by everything that opens
    // or titles a pane.
    function paneOf(id) {
      return agents.find(a => a.pane_id === id) || shells.find(s => s.pane_id === id) || null;
    }
    function isShell(id) { return shells.some(s => s.pane_id === id); }
```

Replace the live-pane lookup with `paneOf(paneId)` in `openTerminal`, `renderStatusBar`, `renamePane`,
the `rename_pane` command-result handler, and the terminal-menu state lookup. **Do not** replace it
in `pairHealth`, `pairFor`, `renderPairStrip`, `openTransfer`, `doTransfer`, or `switchToPartner` —
pairs are agent-to-agent and must keep looking only at `agents`.

### 3.4 Terminal card and section [NEW]

Beside `agentCard` (3266):

```js
    function terminalCard(s) {
      const host = s.host && s.host !== 'local' ? ` <span style="color:var(--orange);font-size:0.6rem">@${s.host}</span>` : '';
      const cwd = s.cwd ? `<span style="font-family:monospace;opacity:0.7">${s.cwd.split('/').slice(-2).join('/')}</span>` : '';
      const title = s.label || s.project || s.pane_id;
      return `<div class="agent" role="button" tabindex="0" aria-label="Terminal ${escapeHtml(title)}" onclick="openTerminal('${s.pane_id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTerminal('${s.pane_id}')}">
    <span class="term-glyph" aria-hidden="true">$</span>
    <div class="info"><div class="project" style="font-family:monospace">${escapeHtml(title)}${host}</div><div class="meta">${cwd}</div></div>
    <span style="color:var(--muted);font-size:1.2rem" aria-hidden="true">›</span>
  </div>`;
    }

    // Not section(): that maps agentCard over its list. Same header markup, different card.
    function terminalsHtml() {
      const list = activeProject ? shells.filter(s => s.project_id === activeProject) : shells;
      if (!list.length) return '';
      return `<div class="section-header"><span class="dot" style="background:var(--term)"></span>Terminals</div>`
        + list.map(terminalCard).join('');
    }
```

`.term-glyph` is styled to occupy the same box as `.dot` so the two card kinds align: same width,
same margin, `color: var(--term)`, monospace, no background, no pulse.

### 3.5 One insertion point for three render paths [MODIFY]

`renderBody` (2356) branches three ways and each branch writes `#agents` itself. Rename the existing
function to `renderBodyMain` — body unchanged — and add:

```js
    function renderBody() {
      renderBodyMain();
      const html = terminalsHtml();
      if (!html) return;
      const el = document.getElementById('agents');
      // "Waiting for agents…" is true of agents and false of the box: a machine with terminals and
      // no agents is not waiting for anything.
      if (!agents.length) el.innerHTML = '';
      el.insertAdjacentHTML('beforeend', html);
    }
```

### 3.6 Terminal view demarcation [MODIFY]

In `openTerminal`, after `document.getElementById('terminalView').classList.add('active')`:

```js
      const shell = isShell(paneId);
      document.getElementById('terminalView').classList.toggle('is-terminal', shell);
      const a = paneOf(paneId);
      document.getElementById('termTitle').textContent =
        (shell ? '$ ' : '') + (a ? paneTitle(a) : paneId);
```

`paneTitle` is called with a shell record; confirm it degrades to the label when `agent` and
`status` are absent, and fix it there if it does not — not with a branch at the call site.

CSS:

```css
    .terminal-view.is-terminal .term-header { border-bottom: 2px solid var(--term); }
```

And, in the same rule block, hide what a shell must not offer:

```css
    .terminal-view.is-terminal #pairStrip,
    .terminal-view.is-terminal #selTransfer,
    .terminal-view.is-terminal #promptDock,
    .terminal-view.is-terminal #quickDock,
    .terminal-view.is-terminal #quickActions { display: none !important; }
```

CSS is the mechanism because these elements are already written by several functions on the poll
path; a branch in each is four places to forget one. Verify the four IDs against the live markup
before writing the rule — correct any that differ, do not add a fifth guess.

In the gear menu builder (~3043), return early with only the terminal-appropriate items when
`isShell(activePane)`: Rename, Hide quick actions bar, and the wrap-mode and text-size controls.
No pair items, no New session in \<project\>.

### 3.7 Composer, keys, approvals [MODIFY]

- Hide `#termInput`, `.term-input button.send`, `.term-input button.clear`, and `#micBtn` when
  `is-terminal`, by the same CSS rule block. Keep the keys entry point; T2 brings the text composer
  back.
- The keys pad stays. Move `C-c` to the first row **for terminals only** — do not reorder the agent
  keys pad.
- The blocked-approval branch in `openTerminal` and the quick-actions renderer must not run for a
  shell. A shell has no `status`, so guard on `isShell(paneId)` rather than on the absence of
  `status`, which would also match a real agent mid-snapshot.

### 3.8 Open pane disappears [MODIFY]

In the `agents` message handler, after `shells` is assigned: if `activePane` is set and is in neither
list, close the terminal view and show a toast naming the pane. Spec §6.5. `navTarget` must consider
both `agents` and `shells`, or terminal history will silently skip every terminal.

`paneTitle` must preserve the existing agent format but return `label || project || pane_id` for a
shell. Toggle `is-terminal` off in `closeTerminal`, not only when opening an agent.

Update Recents in the same pass: its stored fingerprint and matcher must distinguish an agent from
a shell (for example with a boolean `terminal` field), `loadRecents` must accept either kind,
`noteRecent` and `renderRecents` must search `agents + shells`, and rendering must choose
`terminalCard` for a shell. A bare `pane_id` must never match a different pane kind or host.

---

## 4. `tests/test_terminal_panes.py` [NEW]

`split_panes` is pure, which is why §2.4 exists. Test it directly with `include_shells=True` and
`False`; do not mutate relay module state just to test the splitter.

| Case | Assert |
|---|---|
| Pane with `agent` | Lands in agents, and the dict equals the pre-change literal key for key |
| Pane with no agent, label `"· spacer ·"` | In neither list |
| Pane with no agent, label `"build"` | In shells, with no `status` and no `agent` key |
| Pane with no agent, empty label | In shells, `label == ""` |
| `TERMINAL` false | Shells empty; agents identical to the flag-on agents |
| `ambiguous_pane_ids(agents + shells)` with `w8:p1` as an agent on host A and a shell on host B | `w8:p1` is ambiguous |
| `snapshot_message()` with `TERMINAL` false | No `shells` key at all |
| `snapshot_message()` with `TERMINAL` true, no shells | `shells` present and `[]` |

---

## 5. Verification

```bash
source .venv313/bin/activate

# Unit — must stay green, and gains the new file
.venv313/bin/python -m unittest discover -s tests -t tests

# Frontend pure block — unchanged by T1, so this proves the markers were not disturbed
node --test tests/test_pairs.js

# Real herdr, throwaway workspace. Run with the flag on and confirm a hand-split shell
# appears in the snapshot; run with it off and confirm it does not.
HERDR_ENABLE_TERMINAL=1 .venv313/bin/python tests/e2e/e2e_pane_slots.py

# Two simulated hosts — the pane-ID collision the ambiguity guard exists for
HERDR_ENABLE_TERMINAL=1 .venv313/bin/python tests/e2e/e2e_start_agent.py
```

Manual, against a live relay, both required:

```bash
# Flag off: no shells key on the wire
HERDR_ENABLE_TERMINAL= uv run relay/herdr_relay.py
# Flag on, with a shell split by hand in herdr
HERDR_ENABLE_TERMINAL=1 HERDR_LAN_OPEN=1 uv run relay/herdr_relay.py   # expect the WARNING
```

---

## 6. Acceptance criteria

1. With `HERDR_ENABLE_TERMINAL` unset, the `agents` message is byte-identical to before the change
   for the same herdr state, and carries no `shells` key.
2. With it set, a hand-split shell appears in `shells` with no `status` and no `agent` key, and the
   agent entries are unchanged.
3. A spacer never appears in `shells`.
4. The same pane ID reported as an agent on one host and a shell on another is refused by
   `pane_guard` for every message type.
5. `read_pane` and `send_keys` succeed against a shell pane. `send_text` and `respond` are refused,
   with the two distinct messages in §2.10.
6. The web app shows a Terminals section containing no agents, and Blocked / Working / Done / Idle
   containing no terminals. With terminals present and no agents, "Waiting for agents…" is gone.
7. Opening a terminal shows the accent rule and the `$` prefix, and offers no pair, transfer, prompt,
   approval, or Send affordance. Ctrl+C is in the first row of the keys pad.
8. Opening an agent after a terminal shows none of the above — the class is cleared, not left on.
9. Closing the open terminal on the host closes the view on the next poll instead of polling a dead
   pane ID.
10. `HERDR_ENABLE_TERMINAL=1` with `HERDR_LAN_OPEN=1` logs the warning naming both.
11. Existing test suites pass unchanged.

---

## 7. Notes for the Implementer

- `web/index.html` moved under commit `4b7e90d` after the architecture document was written. The
  line numbers above were taken after it; re-anchor on the function names, not the numbers.
- Do not touch `tests/test_pairs.js` or the `// --- P3 pair logic (pure) ---` markers. Nothing in T1
  belongs in the pure block.
- Do not build `send_text`, the shortcut grid, or `open_terminal`. If a change appears to need one,
  stop and say so — it means this plan is wrong, not that the scope is.
