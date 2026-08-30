# Addressing a pane by its agent

**Date:** 2026-08-30 · **Class:** B (additive on the wire, backward-compatible)
**Depends on:** `2026-08-29_agent_identity_spec.md` (phases 1–3, the `aid` the relay mints)

## 1. The condition

A herdr `pane_id` is a per-server counter. Two hosts polled by one relay both start at `w1:p1`, so
with any second entry in `HERDR_REMOTES` colliding ids are the **default case**, not an edge one.

The relay already knows this and refuses to act on it. `ambiguous_pane_ids` (`relay/projects.py:432`)
collects every bare id reported by more than one host each poll, and `pane_guard`
(`relay/herdr_relay.py:1564`) turns every `respond`, `read_pane`, `send_keys`, `send_text`,
`rename_pane` and `set_slot` naming one into an error. `pane_remote_map` is keyed on the bare id and
would otherwise route to whichever host was polled last.

The client has the same fault and no such guard. It identifies the open pane with `activePane`, a
bare `pane_id`, and resolves it with `agents.find(x => x.pane_id === activePane)` in twelve places —
which returns whichever host's pane sorts first. `pairFor`, `memberOf` and `partnerOf`
(`web/src/pairs_pure.js:312-317`) are keyed the same way. The single line standing between that and
a mis-routed transfer is `pairHealth`'s collision check, which calls such a pair stale.

So today a colliding pane is **unusable at every layer, consistently**: the relay declines it, the
app cannot open the second one, and its pair reads stale. That consistency is the only thing keeping
it honest. Relaxing any one layer alone — as an `aid`-aware `pairHealth` did — makes that layer lie
about a condition the others still enforce.

## 2. What this changes

`aid` becomes a **pane address**, not only an identity. It is unique by construction, minted by this
relay, already on every agent pane in the snapshot, and already stored on every pair member.

- On the wire, a pane command may name its pane by `aid`. The relay resolves it to the pane that
  agent is in **now** and to that pane's host. There is nothing to disambiguate, so the ambiguity
  refusal never applies to it.
- In the client, the open pane is remembered as an `aid` beside its `pane_id`, and the pair lookups
  take an agent rather than a pane id.
- `pairHealth`'s collision check is then removed — but only in the same change that makes the
  lookups it was standing in for unambiguous, and never before.

`pane_id` stays on the wire and stays the address of record. It is what herdr is given, what the
conversation log stores, what `pane_branch`, `pane_config`, `pane_turn_ids` and the arbitration
sessions key on. None of that is touched. `aid` is offered **alongside** it, never instead.

## 3. Relay behaviour

### 3.1 `pane_by_aid`

Rebuilt each poll from the roster the identity pass has just stamped, after `agent_ids.resolve`:

```
pane_by_aid = { a["aid"]: a for a in agents if a.get("aid") }
```

Agents only. A shell pane has no agent and so no `aid`; see §6.

### 3.2 `pane_target(msg) -> (pane_id, remote, error)`

The one place a client's pane address is resolved. Replaces the `pane_guard` + `pane_remote_map.get`
pair repeated at each handler.

| `msg` carries | Result |
|---|---|
| `aid` naming a pane in `pane_by_aid` | `(that pane's pane_id, that pane's remote, None)` |
| `aid` naming nothing | `(None, None, "unknown aid")` |
| no `aid`, `pane_id` known and unambiguous | `(pane_id, pane_remote_map[pane_id], None)` |
| no `aid`, `pane_id` unknown | `(None, None, "unknown pane_id")` |
| no `aid`, `pane_id` ambiguous | `(None, None, "ambiguous pane_id (same id on multiple hosts)")` |

An `aid` present **wins**: the pair `{aid, pane_id}` a client sends names one agent, and the
`pane_id` in it is that client's last snapshot's idea of where it was. When they disagree the agent
has moved and the `aid` is the fresher of the two.

A retired `aid` — one whose agent has no live pane — resolves to nothing and answers `unknown aid`.
It is not looked up in the registry: this addresses panes that exist, not agents that once did.

`pane_guard` itself is unchanged and keeps its meaning for the bare-`pane_id` path.

### 3.3 Handlers

Each of the six becomes:

```python
pane_id, remote, pane_err = pane_target(msg)
if pane_err:
    await ws.send(json.dumps({"type": "error", "message": pane_err}))
    return
```

with the later `remote = pane_remote_map.get(pane_id)` deleted. Everything downstream — the shell
check, the allowlist, the audit line — is unchanged and keys off the resolved `pane_id`.

## 4. Client behaviour

### 4.1 The open pane

`activePane` keeps its meaning and its type: the `pane_id` the app is reading and writing. A second
global `activeAid` records which agent that was, set and cleared with it in `openPane`/`closePane`.

`activeAgent()` replaces the twelve open-coded finds:

```js
function activeAgent() {
  if (!activePane) return null;
  return agents.find(a => activeAid ? a.aid === activeAid : a.pane_id === activePane) || null;
}
```

The fallback is not decoration: a relay too old to mint ids sends no `aid`, and a pane opened before
one arrived has none. In both cases behaviour is exactly what it is today.

### 4.2 Addressing a send

```js
function paneAddr(a) { return a && a.aid ? { pane_id: a.pane_id, aid: a.aid } : { pane_id: a ? a.pane_id : null }; }
```

Spread into every pane command. Both fields, always, when an id exists: `aid` is what the relay
routes on, `pane_id` is what a relay too old to know the field still needs.

### 4.3 Pair lookups

`pairFor`, `memberOf` and `partnerOf` take a **live agent** and match it through `memberMatches` —
which already prefers `aid` and falls back to the four-field fingerprint. Their contract is otherwise
unchanged, and `partnerOf` still answers the member that is not the one given.

Call sites all hold the agent already, or reach it through `activeAgent()`.

`pairHealth`'s ambiguity clause is removed in the same change. Its second clause — the member no
live pane matches — stays, and stays the whole of what "stale" now means.

## 5. Behaviour, stated as cases

| Case | Before | After |
|---|---|---|
| One host, no collision | works | unchanged |
| Two hosts, ids collide, pane opened | relay refuses every command | commands route to the right host |
| Two hosts, ids collide, second pane opened from the list | opens the first host's pane | opens the one that was tapped |
| Pair spanning that pane | stale, "reported by more than one host" | healthy; switch and transfer work |
| Agent restarts into a new pane | `healPairs` re-points the member | unchanged |
| Agent moves host, keeps its pane id | member left naming the old host | re-stamped (fixed 2026-08-29) |
| Relay too old to mint `aid` | — | `aid` absent everywhere, every path is the bare-`pane_id` one |
| Client too old to send `aid` | — | bare `pane_id`, guarded as it is today |
| `aid` of an agent that has ended | — | `unknown aid` |

## 6. Deliberately not covered

- **Shell panes.** A terminal has no agent, so nothing mints an id for it, so a colliding shell id
  stays refused. Fixing it means an identity for a pane with no agent in it, which is a different
  question from this one. The refusal is honest and unchanged.
- **`activePane` becoming an `aid` outright.** It is the address herdr is given and the key several
  stored maps use. Keeping it and carrying the `aid` beside it costs one global and no migration.
- **The conversation log's `pane_id` column.** Historical rows name panes that are gone; an
  ambiguity in the record is not an ambiguity in a command.

## 7. Checks

- `tests/test_pane_target.py` — the table in §3.2, case for case: `aid` resolving to its pane's host,
  `aid` winning over a stale `pane_id`, unknown `aid`, and each of the three bare-`pane_id` answers.
- `tests/test_pairs.js` — a pair across two hosts whose ids collide reads healthy; `pairFor` given
  the second host's agent finds that host's pair and not the first's.
- `tests/e2e/e2e_start_agent.py` — already runs two simulated hosts through the fake `ssh`; it is
  where a colliding id is real rather than constructed.
