# Implementation Report — P2: Remote Start Session

**Date:** 2026-08-08
**Branch:** `feat/projects` — `277ded1` (feature), `196e945` (review fixes), `f43529c` and
`5681cf9` (harness), `35adccf` (unrelated mDNS fix found while testing)
**Spec:** `.workflow/03_specs/2026-08-08_start_agent_spec.md`
**Plan:** `.workflow/04_implementation_plans/2026-08-08_p2_start_agent.md`
**Classification:** Class B — additive protocol extension
**Status:** Complete. A1–A11 pass.

---

## 1. What shipped

Starting an allowlisted agent inside a configured Project, from the browser, on the Project's
own host. Off by default and unavailable without a token.

| File | Diff | Role |
|---|---|---|
| `relay/start_agent.py` | **new, 193** | Pure: allowlist, validation, `Role N`, argument builders |
| `tests/test_start_agent.py` | **new, 249** | 35 tests — every refusal in spec §3 |
| `relay/herdr_relay.py` | **+132 / −1** | Boot gate, `start_options`, handler, executor |
| `web/index.html` | **+124** | Start session sheet, gated on `start_options` |
| `tests/e2e/` | **new, 367** | Two-host harness with checked-in fake `herdr` and `ssh` |

The client sends `{name, role, project_id, placement}` and exactly one placement field. cwd and
host come from the Projects config; argv is a fixed `-- <name>` built from the allowlisted name.
An extra `cwd`, `argv`, `env`, `host`, or `tab_id` key is a **refusal**, not an ignored field —
silently dropping unknown keys would make a future field addition a privilege escalation.

### Three boundaries, not one

1. `HERDR_START_AGENTS` — *what* may be executed.
2. `HERDR_ENABLE_WRITE_EXT` plus the token — *who* may invoke it.
3. Boot refusal — the flag without `HERDR_RELAY_TOKEN` exits non-zero.

The third exists because the relay binds `0.0.0.0`. Enabling remote process spawn on an
unauthenticated LAN socket is not a configuration the operator should be able to reach by
forgetting one variable.

Per-message token checks were deliberately **not** added: `process_request:368` already rejects
the WebSocket handshake when `AUTH_TOKEN` is set, so an authenticated connection is the
precondition, and the boot invariant guarantees a token exists wherever the handler is reachable.

### Two ID spaces, two guards (D6)

`new_tab` resolves `workspace_id` through P1's one-distinct-host rule; `split` puts `split_from`
through the pane ambiguity set. They collide independently — using either guard for the other
job passes a real collision. Both then check that the resolved host and `project_id` match the
Project, so a same-host workspace belonging to a different Project is still refused.

---

## 2. Verification

### End to end, on two hosts

`tests/e2e/e2e_start_agent.py` — **39/39** across four relay boots: boot refusal, write gate off,
write gate on, and injected herdr failures. The fake `ssh` sets `HERDR_FAKE_HOST` and execs
locally, which is what lets one machine present two hosts and reproduce the `w8:p1` pane
collision and `w8` workspace collision.

| Area | Result |
|---|---|
| A1 | Local and remote New workspace; all three calls land on the Project's host, none on the other |
| A2 | New tab created on the workspace's host, agent anchored to the returned `tab_id` |
| A3 | Split reuses the source pane's tab; no tab created |
| A4 | Unknown agent/role/project, client-supplied `cwd`/`argv`, cross-host tab and split — all refused with **no herdr write issued** |
| A5 | Gate off: refused before any herdr call |
| A6/A7 | Injected `workspace create` with no ID, and injected `agent start` failure: `ok:false`, no `pane_id` claimed, no rename attempted |
| A9 | `Role N` label applied to the pane, and to the tab for New tab |
| A10 | Gate off: no `start_options`, and the UI renders identically to P1 |
| A11 | A `workspace_id` reported by two hosts is refused |

Argv proven from the fake-ssh log rather than asserted in Python:

```
box agent start claude --cwd /srv/relay --tab box:tNew --focus -- claude
```

### Against real herdr

One token-gated start into `tsignal`, a Project with zero live sessions:

```
result:   {"ok": true, "pane_id": "wB:p2", "label": "Architect 1"}
new pane: cwd=/Users/towshif/code/python/tsignal  project_id=tsignal  host=local
herdr:    wB 'tsignal'
audit:    name=claude role=architect project=tsignal placement=new_workspace host=local
```

`~` expanded, workspace took the Project label, pane took `Architect 1`, next poll grouped it.

### UI

Six headless states: no-gate, Project list, Project view, dialog, New tab, Split. With the gate
off the page is identical to P1 — no control, not a disabled one. The P1 report's suspected
horizontal overflow was also settled here: at a 500px capture the cards are complete, confirming
it was the headless viewport.

### Suite

117 unit tests. `git diff --check` clean. No edit to `agent_state.py`, `herdr_tui.py`,
`herdr_telegram.py`, `herdi-mac/`, or `herdi-ios/`.

---

## 3. Deviations and additions

**1. herdr calls run off the event loop.** `asyncio.to_thread` for the executor. New workspace is
three subprocess calls at 15s timeout each; on the loop that is a 45s freeze of every other
client. Not in the plan, added during implementation.

**2. New tab labels the tab as well as the pane** (review fix, `196e945`). Spec §2 asked for it;
the first implementation only labelled the pane.

**3. `start_options` clears on reconnect** (review fix). It is a per-connection capability. A
relay restarted with the gate off would otherwise leave a stale control on screen that errors.

**4. The E2E harness is checked in.** Kept only because it runs from the repo with checked-in
fakes; it is named so `unittest discover` skips it, since it spawns relays and binds a port.
Startup waits for the port with a bounded poll rather than a fixed sleep.

---

## 4. Behaviour changes to be aware of

1. **The relay can refuse to boot** on `HERDR_ENABLE_WRITE_EXT=1` without a token, or on a
   malformed `HERDR_START_AGENTS`. Both print to stderr; `start.sh` now reports the real exit
   status rather than blaming the port (`743675c`).
2. **A third message on connect** when the gate is on: `projects`, `start_options`, `agents`.
3. **Partial layout can outlive a failed start.** If `agent start` fails after a workspace or tab
   was created, that empty layout remains. It is native layout, not a session, and no session is
   reported — stated in spec §3 and verified by the injected-failure run.

---

## 5. Open items

| # | Item | Blocks | Owner |
|---|---|---|---|
| 1 | **Real *remote* smoke start is untested.** There is no `HERDR_REMOTES` on this machine, so the real run confirmed the *local* path only. Remote routing evidence is the fake-ssh harness. Run one real start into a remote Project when an SSH target exists. | — | User |
| 2 | **P3 bracketed-paste preflight is INCONCLUSIVE.** Unchanged from the P1 report; needs a visible focused pane. The FAIL fallback costs a protocol change (`M-Enter` in `SAFE_KEYS`). | P3 | P3 implementer |
| 3 | **Relay wedge, cause unproven.** Unchanged from the P1 report. If it recurs, **do not kill it** — take a live `sample` first. | nothing | — |
| 4 | Smoke-test workspace `wB` is still open with a live claude in it — `herdr workspace close wB`. | — | User |
| 5 | Promotion of the Projects/Pairs docs from `07_dev_notes/` to `02_architecture/` | — | User |

---

## 6. P3 readiness

**Blocked**, on item 2 only. Nothing in P2 touched `send_text`, the composer, pairs, or transfer,
and the spec's §4 boundaries held: no pair, prompt seeding, or `send_text` cap change landed.
