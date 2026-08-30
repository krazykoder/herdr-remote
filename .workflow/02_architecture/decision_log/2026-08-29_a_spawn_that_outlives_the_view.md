# A spawn that outlives the view it was asked from

**2026-08-29 · Class B (additive) · web only, no wire change**

A restart pressed in the conversation window binds the pane herdr is about to make to the member
it continues. Until now that binding lived in four JavaScript globals — `pendingStart`,
`startIntent`, `startPrompt`, `startStarter` — plus one `sessionStorage` slot with a two-minute
deadline. Every one of those is a fact about *this tab, right now*: `openStartDialog` clears
`startIntent` unconditionally, a second start overwrites the single note, another tab has none of
it, and a reload keeps only the one slot. So a reader who pressed Restart and then changed views,
switched to another agent, or opened the Start dialog could have the new pane land with nothing
saying which member it was, and the conversation would never get its session back.

The relay already carries the durable half. A start may name itself with `ref`; the relay stamps
that on the pane and repeats it on every snapshot, for as long as the pane lives, to every client.
What was missing was not a backend fact but a durable record of what a `ref` *meant* — and the
conversation index is exactly that kind of record: it is the document conversations already live
in, it is synced through `user_state`, and every tab reads it.

So a start made for a conversation writes its note into that index, on the member it will continue
(`member.pending = {ref, at}`) or on the conversation itself when the start joins a member that
does not exist yet (`conv.pending = [{ref, at, label}]`). Any snapshot in any tab that sees a pane
carrying a matching `ref` performs the succession. The tab that pressed the button no longer has
to be the tab that finishes the job, no longer has to still be on that screen, and no longer has
to be the only start in flight.

The alternative was to teach the relay about conversations — to have it rewrite membership itself.
That was refused: `user_state` bodies are opaque strings the relay never parses, and making
conversation semantics a relay concern is a version bump and a full re-audit to buy a property the
`ref` we already ship provides.

The opening prompt deliberately does **not** move into the note. It stays on the fast path, where
the globals still hold it and the tab that asked is still there to send it — the same rule the old
recovery path already applied, and the only way one start's opening words cannot be said twice by
two tabs. A note is about membership; membership can be landed by anybody, and words cannot.

One limitation is accepted rather than engineered away: the conversations document is adopted
whole from the relay, so a note written locally can be lost to a merge that arrives in the same
second. That degrades to exactly today's behaviour — the pane is filed into an auto conversation
and the reader moves it — and is not worth a second store to close.
