# Spec — A roster that can be woken

**2026-08-29 · Phase 3 · obeys** `.workflow/02_architecture/decision_log/2026-08-29_a_roster_that_can_be_woken.md`

**Depends on** `.workflow/03_specs/2026-08-29_durable_spawn_binding_spec.md` (S1). The restarts this
spec performs are the ones that spec made durable; landing this first would enrol panes bound to
nobody.

---

## A1 — What each slot offers

A pick is either a **live pane** (value: its `pane_id`) or a **paused member** of this conversation
(value: `paused:<member key>`). Nothing else is offerable.

| Slot | Offers |
|---|---|
| `Arbitrator` | every live pane in the roster's project, **whatever its status**, including members of this conversation; plus every paused member of this conversation whose record satisfies `canRespawn` |
| `Agent 1`, `Agent 2` | every member of this conversation — live, and paused where `canRespawn` holds |

Still excluded from every slot: a pane another arbitration session holds (`arbUntaken`), and
anything outside the roster's project. Both are refusals the relay would make anyway
(`participant_in_session`, `project_mismatch`), and both are stable facts rather than a status that
moves under the reader.

No longer excluded: `working`, `blocked`, and — for the arbitrator — membership of this
conversation. `arbWithPick` (`arbitration.js:900`), which existed to hold a just-started pane in a
list the status filter had dropped it from, is deleted with the filter.

| # | Given | When | Then |
|---|---|---|---|
| A1.1 | A pane in the project is `working` | the dialog is drawn | it is in the arbitrator list |
| A1.2 | A pane is a member of this conversation | the dialog is drawn | it is in the arbitrator list **and** in the Agent 1/2 lists |
| A1.3 | A member is paused and its record satisfies `canRespawn` | the dialog is drawn | it is offered in all three lists, drawn as `<label> — paused` |
| A1.4 | A member is paused and its record does **not** satisfy `canRespawn` | the dialog is drawn | it is not offered — there is nothing to start |
| A1.5 | A pane is held by another arbitration session | the dialog is drawn | it is offered by no slot — unchanged |
| A1.6 | The conversation has one live member and one paused member | the ⚖ is pressed | the dialog opens. The `live.length < 2` refusal in `arbCheckSetup` and `arbWhyNot` counts **members that can be woken**, not live panes |

## A2 — Picking the same pane twice

| # | Given | When | Then |
|---|---|---|---|
| A2.1 | Agent 1 and Agent 2 resolve to the same pane or the same member | `Start` | `Two different agents — one has nobody to talk to.` Nothing sent. Unchanged behaviour, widened to compare members as well as panes |
| A2.2 | The arbitrator resolves to the same pane or member as Agent 1 or Agent 2 | `Start` | `An agent cannot arbitrate itself.` Nothing sent |
| A2.3 | A client sends a roster with a duplicate `pane_id` anyway | the relay handles `arb_start` or `arb_edit` | refused with `duplicate_participant` — the existing `_enrol` guard, which this change makes load-bearing rather than theoretical |

## A3 — Starting a session whose roster is not all running

| # | Given | When | Then |
|---|---|---|---|
| A3.1 | Every pick is a live pane | `Start` | `arb_start` goes out immediately — unchanged |
| A3.2 | One or more picks are paused members | `Start` | the form is **held**, each paused member is restarted, and `arb_start` goes out once every pick has a pane |
| A3.3 | While A3.2 is waiting | — | the dialog stays open with every field as typed, and says what it is waiting for (`Waiting for 2 agents to come up…`). `Start` is disabled; `Cancel` abandons the wait |
| A3.4 | A restarted member lands | — | its slot's value becomes that pane's id, so the form is a true description of what will be sent |
| A3.5 | Every pick has a pane | — | `arb_start` goes out with the resolved pane ids, then the dialog closes. Ordinary `arbCheckSetup` validation runs again against the resolved roster first |
| A3.6 | Two minutes pass with a pick still without a pane | — | the wait is dropped, the dialog stays open with everything typed still in it, and says `X did not come up — it was left as it is.` Nothing is sent |
| A3.7 | The conversation window is closed, or the dialog is closed | during A3.2 | the wait ends. The restarts do not — they were real presses and land as members the ordinary way (S1) |
| A3.8 | Two paused picks | — | they are restarted one at a time, through the existing `convRestartQueue`, which is the only thing that keeps one start's binding from trampling the next |

## A4 — Editing a running session

`arbSave` uses the same widened lists and the same resolution. A `Save` that names a paused member
holds and restarts exactly as A3 does, and sends `arb_edit` once the roster resolves. A2's checks
apply identically.

---

## Relay

**Nothing changes.** `_enrol` already refuses a roster with a repeated pane id
(`ArbiterError("duplicate_participant")`, `relay/arbitration.py:834`). That check has been there
since the beginning and could only ever catch a client bug, because the picker's "arbitrator is
never a member" filter made such a roster impossible to build. Removing the filter is what makes
it load-bearing, so it gains a comment saying so and a test that pins it
(`tests/test_arb_roster.py`). A2.2 is the same rule said early in the dialog, for a better message. `arbitrator_busy` (N7) is still the answer for a pane mid-turn,
and it is now reachable from the picker — which is the point: the refusal names the real state at
the moment of the send, where the old filter guessed at it three seconds early.

---

## Failure modes

| Case | Behaviour |
|---|---|
| A paused pick's restart is refused by `canRespawn` at press time (record changed under it) | the wait is dropped with `X cannot be restarted — it was left as it is.`; nothing is sent |
| A restarted pane comes up `working` while its TUI starts | it is enrolled; the relay's `arbitrator_busy` is the refusal if it is the arbitrator and still busy. Said in the dialog, form kept |
| The relay refuses the resolved roster (`project_mismatch`, `participant_in_session`) | the existing error path; the dialog stays open |
| A paused member is picked in two slots | A2.1 / A2.2 refuse before anything is restarted |

---

## Addendum, written during implementation

**A1.7 — the project of a room with nothing running.** `arbProject` measured the *live* members'
`project_id`, so a conversation whose panes had all been closed answered `null` and the arbitrator
list came back empty — which would have made A1.6 (a fully paused room can still be assembled)
unreachable. It now reads each member's project off its pane where there is one and off the spawn
record it would be restarted from where there is not. A member nothing is known about is left out
of the count rather than answered `null`: it is not a disagreement.

**A2.4 — three distinct agents, counted before the dialog opens.** With this conversation's own
members offerable as the arbitrator, a two-member room with no third pane draws three full selects
that can only ever be refused by A2.2. `arbOpenFromConv` now counts distinct agents across both
lists and refuses at the ⚖ with the existing "needs a third agent in this project" sentence,
rather than opening a form with no valid answer in it.

**The liveness refusal is gone, not moved.** `arbCheckSetup` no longer re-checks that the chosen
arbitrator is in the candidate list — that check existed only to catch a pane the status filter had
just dropped, and there is no status filter. A busy arbitrator is `arbitrator_busy` from the relay,
at the moment of the send.
