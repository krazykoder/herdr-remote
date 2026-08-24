# Decision Log: A recorded row belongs to the pane that produced it

**Class A** — a bug fix in the client's reading of the relay's record. No wire change, no relay
change. One additive field on a conversation member (`was`), written at one place.
Spec and plan: `../../04_implementation_plans/2026-08-24_rows_belong_to_panes_plan.md`.

## The bug, as reported

An agent pane named "AGY3.7- arch" was quit by hand. Its turns then appeared inside the conversation
"Arbitrator - ARCH", which it had never been a member of, attributed to that conversation's own agy
member.

Reproduced from the user's live index. "Arbitrator - ARCH" holds `w24:pJ` (claude), `w24:p1F`
(codex) and `w24:p22` (agy). "AGY3.7- arch" is `w24:p25` and `w24:p31`, both agy, both in the same
checkout. All three agy panes share the fingerprint `[local, agy, …/herdr-remote]`.

## Why quitting the pane is what triggered it

`convLiveEntries` (`web/src/conv_live.js:754`) buckets the relay's record by fingerprint —
`[host, agent, cwd]`, with no pane id in it. That is deliberate and correct: it is what lets a
transcript survive the restart that renumbers every pane. It also means every agy pane in one
checkout shares one bucket, so something else has to decide which rows a member may draw.

That something was `convLiveRowIsMine` (`:413`) over the set built by `convLiveClaimed` (`:400`):

```js
return !(mine && pid && pid !== mine && claimed.has(pid));
```

`claimed` was *live panes* plus *the panes this one roster names*. A row from a pane in neither set
was adopted by whoever held the fingerprint. While AGY3.7-arch was running its pane was claimed off
the `agents` list and its rows were repelled. Quitting it removed the only thing claiming it.

The fallback was written for respawns — "a row from a pane that is no longer live has no such
claimant and goes to whoever holds the fingerprint now, which is what keeps a respawned pane's
history attached to it." The intent is right. Its reach was not: it adopts *any* dead pane sharing
a fingerprint, not the one pane a member actually succeeded.

## Decision

Delete the heuristic and record the fact instead.

Inheritance is legitimate at exactly one place: `convContinueTranscript`
(`web/src/conversation_store.js:198`), where a respawn rewrites a member's key from the dead pane to
the new one. That call site now also writes the dead pane's id onto the member as `was`. Ownership
becomes a statement rather than an inference:

```js
function convLiveRowIsMine(t, mine, was) {
  const pid = t.pane_id || '';
  return !pid || pid === mine || (was || []).includes(pid);
}
```

`convLiveClaimed` is deleted along with the `claimed` argument threaded through its four callers. A
row belongs to the pane that produced it, or to the member that recorded itself as that pane's
successor. There is no third case.

## Why not simply widen `claimed`

The obvious three-line fix — claim every pane named by *any* conversation in the index, not just the
one being drawn — does fix the reported symptom, and it was rejected.

The user's index shows why. Auto-filing gives nearly every pane ever run a membership in an
automatic conversation (`herdr-remote · herdr-remote` alone names more than twenty). So after a
respawn the dead pane is still named somewhere, would therefore be claimed, and the deliberate
conversation's respawned member would stop inheriting the history the fallback exists to preserve.
It converts a loud bug into a quiet one, and leaves the heuristic in place to be got wrong again.

## What this costs

A member respawned *before* this change carries no `was`, so in the from-relay view it no longer
inherits its predecessor's rows. Its local transcript is untouched — `convContinueTranscript`
copied those entries at the time, and `conversation_view.js:396` reads them on the non-relay path —
so what is lost is history in one of two views, for members already respawned, until the next
respawn records the link properly.

Taken deliberately. `conversation_pure.js:447` calls wrong attribution "the worst failure this
feature has", and a quiet gap in one view is not that. No migration is written: there is nothing to
migrate from, since the predecessor link was never recorded anywhere to recover it from.
