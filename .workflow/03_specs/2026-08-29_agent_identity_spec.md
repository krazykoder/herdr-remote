# Agent identity — spec

**Date:** 2026-08-29
**Status:** implemented, 2026-08-29
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

1. **Named start.** The pane carries a `ref` an `aid` is bound to → that `aid`, and the binding is
   spent. The explicit path: the client said which agent the start continues, so no guessing is
   involved. **First, not second** — see §8: a restart quits the old pane and starts a new one, and
   the relay can see both in one poll, so a slot claim would take the id before the statement was
   read.
2. **Known pane.** `(host, workspace_id, pane_id)` already carries an `aid` and the seat still
   agrees (`agent`, `cwd` unchanged) → that `aid`. `last_seen` updated.
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

- `start_agent` — optional `aid`: "this start continues that agent". The relay binds it to the
  start's own `ref` *before* the start runs, and rule 1 claims it on the first poll that sees the
  pane. Refused rather than ignored when malformed, unknown, or sent without a `ref` — the binding
  is made against the ref, so there is nothing to bind to without one. `ref` keeps the job it was
  built for (finding the pane a start made when the answer was thrown away).
- `start_agent` — optional `starter`: the client's own name for the opening prompt, an opaque slug.
  The relay never reads it and never types it; it stores it against the agent so that a browser
  which never watched the original start can ask for the same opening when it restarts.

## 5. The FE

**The member key is not replaced.** The draft proposed moving four documents onto `aid` as their
key. That was rejected during implementation: `member.key` is also the name the transcript is filed
under in IndexedDB, so re-keying the roster means re-keying every transcript in every browser, and
the one tool for moving a transcript — `convContinueTranscript` — deliberately marks a
*continuation* boundary rather than performing a rename. A migration that draws a false seam
through every existing thread is a worse outcome than the problem.

What is done instead is smaller and gets the same result: **a member row carries `aid` beside the
key, and the id drives the succession machinery that already exists.**

- `convMemberOf` records `aid` on every new member.
- `convFollowAids()`, on the ordinary snapshot, does two things:
  - **the fold** — a member whose key names a live pane takes that pane's `aid`. No migration step,
    no version number, nothing to run by hand.
  - **the follow** — a member whose pane is gone, whose `aid` is on another pane, is moved onto it
    through `convLandMember`: transcript carried over the seam, pair repointed, row moved, `was[]`
    extended. Exactly what a restart the reader watched has always done, now done in every browser.
- Never onto a pane the conversation already names, never before the shared index has arrived, and
  never against an empty roster.

`pane_id` and `activePane` stay exactly as they are wherever they are an **address** — reading a
pane, writing to it, `send_keys`, the ruler, the composer.

**Pairs** do pin the agent: `memberMatches` compares `aid` when both sides have one and falls back
to the four-field fingerprint otherwise. A pair made before this stays on the fallback until
`healPairs` re-points it once, which writes the id in.

**`spawnOf(key)`** answers "what was this member started as" from the local transcript record first
and the relay's `retired` list second — matched by `aid` and by nothing else. That is what makes
Restart available in a browser that never watched the start.

## 6. Phases

1. **Relay mints.** `agent_ids.py`, the table, the four rules, `aid` on every pane, `retired` on the
   snapshot. Nothing in the FE reads it. Commit `acd6bd4`.
2. **FE reads.** `aid` on member rows, `convFollowAids`, pairs pinned on the agent, `start_agent`
   carries `aid`. Commit `550ea0d`.
3. **Spawn details from the relay.** `retired` feeds `spawnOf` and so `canRespawn`; `start_agent`
   carries `starter`. Same commit as phase 2 — the two are one change from the reader's side.

`healPairs`' guessing rule was **kept**, not deleted. It is what writes an `aid` into a pair made
before any of this existed, and it is the only thing that repairs a pair against a relay too old to
mint ids. It costs nothing once both members carry one, because `memberMatches` no longer goes
stale.

## 7. Checks

- `tests/test_agent_ids.py` — 25 cases: the four rules, both refusals (two panes for one retired
  seat, two retired agents for one returning pane), the spent binding, retirement, and the spawn
  details surviving a snapshot that stopped carrying them.
- `relay/agent_ids.py --demo` (`python3 relay/agent_ids.py`) — the same story as one runnable
  assert chain, for a reader who has the module open.
- `tests/test_start_agent.py` — `validate_start_aid`: shape only, so a pane id, a path or a
  fingerprint cannot be smuggled in as an identity.
- `tests/test_conv_follow_aid.js` — the fold and the follow, and the four things neither may do.
- `tests/e2e/e2e_start_agent.py` — every pane on a real snapshot carries an `aid`, one each, and
  `retired` is present and empty while every agent has a pane.

## 8. What changed during implementation

- **Rule order.** The draft put the slot first and the named start second. A restart quits the old
  pane and starts a new one, and the relay can see both in a single poll — so the corpse's slot
  claim would take the id before the client's statement was read, and the new pane would come up a
  stranger. A statement must outrank an inference. Bindings are spent on use, or the next poll moves
  the agent again onto whichever pane still wears that ref.
- **`resolve` is keyed by the whole slot,** not by `pane_id`. A pane id is a per-server counter, so
  the same string names a different pane on each host — which the relay's own collision guards exist
  for.
- **The member key stays.** See §5.
- **`starter` was added to `start_agent`.** The spec's table listed it as a column but nothing would
  have filled it: the opening prompt's name is a client concept the relay had never been told. It is
  the field that makes "restart with the same prompt" work from a browser that did not watch the
  original start, which was the question that started all of this.
