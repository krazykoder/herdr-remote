# Decision — Backend authority with a pending-create outbox

**Class B** — client-only extension of shared-state reconciliation; protocol and relay storage are
unchanged.

The relay is authoritative for every shared-state row it already holds. On connect, a browser
adopts every non-empty relay document wholesale; stale local content cannot replace, merge into,
or resurrect it.

Conversations are the narrow exception needed for offline creation. `saveConvIndex()` records an
id that did not exist in its immediately preceding local index in the local-only
`herdr_conversations_pending` outbox. On connect or conflict, only ids still in that outbox and
absent from the returned relay index are appended. Their complete conversation objects — including
their pane members — are retained. An acknowledgement, or a returned body already containing an
id, removes that id from the outbox — and so does the id leaving the local index, since a
conversation deleted before it synced, or one `convFit` trimmed, is not waiting to be sent
anywhere and would otherwise sit in the outbox for good.

This is not general union: unmarked local rows and all local changes to a backend-known id lose to
the backend. Auto conversations are eligible pending creations only after `state_get` completes;
none may be manufactured while the first response is pending.
