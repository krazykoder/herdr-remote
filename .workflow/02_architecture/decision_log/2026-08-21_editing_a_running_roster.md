# Editing a running roster

**2026-08-21** — N6 changes. The roster is no longer fixed at session start.

## What it said, and why

> **N6 — The roster is fixed at session start.** The set of addressable members never grows while
> a session runs.

The reason was sound: `to` is an enum over the roster, and an arbitrator that can be handed a
recipient it was never briefed on is one whose decisions cannot be validated against anything.
Freezing the set made that impossible by construction.

## Why it was too strong

It froze the wrong thing. The danger is a roster that changes *underneath* the arbitrator — as a
consequence of something an agent said, or in the window where a decision is already in flight.
A person deliberately swapping one member for another is neither.

And the cost of the freeze was paid on the ordinary repair. A member exits, the session pauses
`member_gone`, and the only way forward was End and Start: a new session id, a new starter prompt,
budget back to full, and the arbitrator's whole record of what it had already decided orphaned
under an id nothing points at any more. Restarting the crew meant restarting the thinking.

## What replaces it

`arb_members` replaces the roster of a running session, and:

1. **The arbitrator is told, on the same call.** `roster_prompt` is an announcement, not a trigger
   — it names the new roster, says that member ids are positional so one it has used before may now
   be a different agent, and says explicitly not to write a decision record for it.
2. **It is refused while `awaiting`.** A prompt is already out whose recipient set is the roster as
   it was. A decision answering it that named a member who left in the meantime would be recorded
   as `unknown_member` — the arbitrator blamed for the person's edit.
3. **An announcement that cannot be proven pauses the session.** The rows are written by then, so
   the alternative is a session whose arbitrator is deciding against a roster it does not know.
4. **The size does not move.** §14.1 still says two. Which two is the person's; how many is not.

Everything else about the session survives the edit: id, arbitrator pane, brief, budget, step
count, and every decision already made. That is the point of it.

## What was not done

Sticky member ids. `member-2` is positional and a swap re-uses it for whoever takes that seat,
rather than retiring the id and issuing `member-3`. Stable ids would let the arbitrator remember
"member-2 is the reviewer" across an edit — but they also grow the id space without bound over a
long session, and the arbitrator is handed the full roster in every trigger message anyway. The
announcement says the ids are positional, which is cheaper than making them not be.
