# Decision Log: The live stream, and what a thread means by "this pane"

## The slot is the only live element, and it is not a message
A turn that has not ended is in neither record: the relay writes its row at the turn end, and this
browser's transcript settles one at the same moment. Drawing it as an entry therefore meant drawing
something no source agreed on — and the two sources disagreed differently, which is how it shipped
with the local thread promoting a half-written draft to a countable, pickable `.conv-msg` that
Summary could select mid-sentence, while the live thread suppressed it and showed a working agent as
a thread doing nothing. Both now render the standing `.conv-slot`, in every thread including the
conversation window, one per working member. `.conv-msg` keeps its meaning — a message that has been
said — so everything that counts, picks, scrolls to or summarises one is correct by construction
rather than by filtering.

## A fingerprint is what survives a restart; a pane id is who said it
The record is bucketed per fingerprint (`[host, agent, cwd]`) because herdr renumbers every pane on
restart, and that is the right key for *fetching*. It is the wrong key for *attribution*: two agents
of the same kind in one directory share a fingerprint, so a solo thread read straight off the bucket
was filtered by agent and drew both panes. A row is attributed to the member whose `pane_id` it
carries, and a row from a pane no one is on falls through to whoever holds the fingerprint now —
which is exactly the restart case the fingerprint exists for. One predicate, both properties.

## Pane ids are never compared without their host
herdr's pane ids are unique per host and collide across them; `tests/e2e/bin/`'s fake ssh exists to
reproduce that collision. Any client-side match on a pane id carries the host with it, normalised
(`convNormHost`) so the local host's two spellings do not read as two machines. This applies to
addressing a bubble's author as much as to attributing a row.
