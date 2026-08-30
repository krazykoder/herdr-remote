# The agent is the address

**Date:** 2026-08-30 · **Class:** B · **Spec:** `.workflow/03_specs/2026-08-30_addressing_a_pane_by_its_agent_spec.md`

A pane id is a per-server counter, so a relay polling two hosts sees `w1:p1` twice and cannot route
it. The relay has always answered this by refusing: `ambiguous_pane_ids` finds the collisions each
poll and `pane_guard` declines every command naming one. The client had the same fault and no such
answer, and got by on a side effect — `pairHealth` called such a pair stale, which happened to keep
the switch button and the transfer off a pane the relay would not have served anyway.

That made the refusal look like a pairs problem, and the obvious fix — an `aid` on the member means
we know who it is, so stop calling it stale — was tried and reverted the day before
(`2026-08-29_an_agent_id_is_not_an_address.md`). Knowing *who* does not say *where*. Every lookup
below the strip is keyed on the bare pane id, up to and including the relay's own map.

The decision is to stop refusing and start addressing. `aid` is already unique by construction,
already minted on every agent pane, already stored on every pair member — it was built as an
identity, and an identity that survives a restart is exactly what a stable address needs to be. A
pane command may now name its pane by `aid`, and the relay resolves it to wherever that agent is
now and to that pane's host. There is nothing to disambiguate, so the guard simply never applies.

Offered alongside `pane_id`, never instead of it. The bare id is what herdr is given, what the
conversation log stores, and what `pane_branch`, `pane_config`, `pane_turn_ids` and the arbitration
sessions key on; making it host-qualified on the wire would have been a shorter change and would
have invalidated every one of those stored references. A client that sends both costs one field and
needs no migration, and a relay too old to read it behaves exactly as it does today.

The client half is the same move: the open pane is remembered as an `aid` beside its `pane_id`, and
the three pair lookups take an agent instead of a pane id so they resolve through `memberMatches`,
which already prefers the `aid`. Only once those are unambiguous is `pairHealth`'s collision clause
removed — in the same change, never before it, because it is the thing standing in for them.

Shell panes keep the refusal. Nothing mints an id for a pane with no agent in it, and inventing one
is a different question.
