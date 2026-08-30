# Agent identity — spec

**Date:** 2026-08-29
**Status:** draft, for review
**Decision:** `.workflow/02_architecture/decision_log/2026-08-29_a_pane_is_a_slot_not_a_colleague.md`

A pane id is a slot. An agent occupies a succession of slots. This gives the agent an id of its
own, mints it in the one place that can, and moves the FE's identity keys onto it.

## 1. The id

`aid` — an opaque string, `a_` plus 12 base36 characters. Minted by the relay, never by a client,
never derived from anything a client can guess. Case-sensitive, compared with `===`.

An `aid` names **one agent session's continuity**: the harness that was started, and every pane it
has occupied since. It does not name a person, a role, or a project.

## 2. Where it lives

A new table in `HERDR_STATE_DB` (`.herdr-remote/state.sqlite3`), written by a new
`relay/agent_ids.py`. That database already holds the facts that are about the work rather than
about one browser, and it already has one writer.

```
agents(
  aid TEXT PRIMARY KEY,
  host TEXT, agent TEXT, cwd TEXT,        -- the seat, for adoption
  workspace_id TEXT, pane_id TEXT,        -- where it is now; '' once it has ended
  ref TEXT,                               -- the start that made it, when a client named one
  config TEXT, project_id TEXT, project TEXT, role TEXT, starter TEXT, label TEXT,
  first_seen INTEGER, last_seen INTEGER
)
```

`config`, `project_id`, `role`, `starter` and `label` are the **spawn details** — what the session
was, so that starting it again starts it the same way. They live here because they must outlive
both the pane and the browser that watched it start. Today they live in each browser's IndexedDB
transcript record, which is why a member whose pane died before *this* browser recorded it can only
be offered "Restart as…".

`aid` rows are never deleted. A row is ~200 bytes and the whole point is that it outlives things.

## 3. Minting and adoption

Run once per poll, against the pane list, in this order. The first rule that matches wins.

1. **Known pane.** `(host, workspace_id, pane_id)` already carries an `aid` and the seat still
   agrees (`agent`, `cwd` unchanged) → that `aid`. `last_seen` updated.
2. **Named start.** The pane carries a `ref` this relay issued and an `aid` is bound to that `ref` →
   that `aid`. This is the explicit path: the client said which member the start continues, so no
   guessing is involved.
3. **Adoption.** The pane is new, and there is exactly **one** `aid` whose seat
   `(host, agent, cwd)` matches, whose last pane is no longer live, and which no other new pane also
   matches → that `aid`, re-pointed at the new pane. Ambiguity is refused: two claude panes in one
   directory are two colleagues, and guessing between them puts one agent's work in the other's
   terminal. This is `healPairs`' rule (`web/src/pairs_ui.js:26`), promoted to the relay so it is
   decided once for every browser instead of re-derived by whichever one was watching.
4. **Otherwise** mint a fresh `aid`.

Rule 3 is what carries an agent across a **herdr restart or a machine reboot**: the processes come
back in new slots, the seat is unchanged, and the agent keeps its id and therefore its conversation,
its transcript and its pair.

An `aid` whose pane is gone from the roster is **retired**: `pane_id` set to `''`, the row kept. A
retired `aid` is what rule 3 adopts from and what the FE restarts.

**D3 holds.** An `aid` is only ever attached to a pane by the relay, by one of these four rules. A
recycled pane id whose seat differs falls to rule 4 and gets a fresh id, so it inherits nothing.

## 4. Wire

Additive. A client that ignores every field below behaves exactly as it does now.

**Server → client**

- `agents` — each pane gains `aid`. Every pane, every snapshot, not only ones this app started.
- `agents` — a new top-level `retired`: agents this relay knows that have no live pane, as
  `{aid, agent, label, project_id, project, cwd, host, config, role, starter, last_seen}`. Capped at
  200, newest first. This is what makes "Restart" available for a dead member in **any** browser.

**Client → server**

- `start_agent` — optional `aid`: "this start continues that agent". The relay binds the new pane to
  that existing `aid` instead of minting one, and refuses rather than ignores an `aid` it does not
  know. This replaces `ref` for the restart case; `ref` stays for the reload case it was built for
  (finding the pane a start made when the answer was thrown away).

## 5. The FE

One function:

```js
// The agent in this pane, not the pane. Falls back to the pane fingerprint against a relay too
// old to answer, which is what keeps this working before the relay is upgraded.
function agentId(a) { return (a && a.aid) || convMemberKey(a); }
```

Four keyed documents move onto it: conversation members (`member.key`), pair members, `conv_view`,
and the transcript store key. Each row gains `aid` beside the key it already has; the key stays as
written until the fold below has run.

`pane_id` and `activePane` stay exactly as they are wherever they are an **address** — reading a
pane, writing to it, `send_keys`, the ruler, the composer. The split is "which agent is this" versus
"where do I type", and only the first moves.

Existence checks move too: a member is present when its `aid` is on a live pane, not when its pane
id is.

**The fold.** One pass, at boot, once. For every member and pair member holding a legacy key, find
the live pane whose `aid` the relay reports, or a retired `aid` whose seat matches — using the
`was[]` list the member already carries, which is exactly the succession history this needs — and
write `aid` onto the row. Rows that resolve to nothing keep their legacy key and go on working
as they do today. Idempotent, so a browser that runs it twice changes nothing the second time.

## 6. Phases

1. **Relay mints.** `agent_ids.py`, the table, the four rules, `aid` on every pane, `retired` on the
   snapshot. Nothing in the FE reads it yet. Shippable alone and observable in the wire log.
2. **FE reads.** `agentId()`, the fold, identity keys and existence checks moved. Pairs stop pinning
   `pane_id`; `healPairs` becomes "find the pane carrying this `aid`" and its guessing rule is
   deleted, because the relay now does it once.
3. **Spawn details from the relay.** `retired` feeds `canRespawn`, so any browser can restart any
   dead agent with its own harness, config and opening prompt. `start_agent` takes `aid`. The
   browser-local `spawn` record becomes a fallback.

## 7. Checks

- `tests/test_agent_ids.py` — the four rules, and above all rule 3's refusal: two candidate panes
  for one retired seat adopt neither.
- `tests/test_agent_identity.js` — `agentId` against a relay that answers and one that does not; the
  fold, run twice.
- `tests/test_pairs.js` — a pair whose partner returns in a new pane under the same `aid` is
  healthy, with no re-pointing pass involved.
- `tests/e2e/e2e_agent_ids.py` — a pane, its `aid`, herdr restarted under it, the same `aid`.
