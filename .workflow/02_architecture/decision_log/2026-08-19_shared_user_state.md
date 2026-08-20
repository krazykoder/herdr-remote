# Decision Log: Shared user state across browsers

**Class B** — additive protocol, additive storage, backward-compatible.
**Branch:** `feat/state-sync`.

## Decision

The relay becomes the home of record for four documents the app previously kept only in
`localStorage`: `pairs`, `conversations`, `conv_view`, `conv_hidden`. Clients read them on connect,
write them back through two new WebSocket messages (`state_get`, `state_put`), and every other
connected client is told about a write as it happens. `localStorage` stays as the working copy the
render reads from, so the app is unchanged offline and against a relay that has never heard of
this.

## Why these four and not all forty-three

The app has 43 `localStorage` keys. Most are answers to "how do I want this device to behave" —
theme, font size, wrap mode, dictation, the relay URL and token. Those are facts about a phone, not
about the work, and syncing them makes a desktop adopt a phone's font size. The four chosen are the
opposite: a pair, a conversation's name and roster, which conversation a pane is read under, and
which conversations are hidden are assertions the user made about the *agents*, and a second
browser that does not know them is showing a different fleet. A fixed allowlist rather than an open
key/value mirror, because an open mirror makes the relay a blob store for anything a client names,
and there is no version of that whose security story is short.

## The relay never parses a body

A document is an opaque JSON string with a revision number. The relay stores bytes, caps their
size, and hands them back. Every question about what a pair *is* stays in `pairs_pure.js`, which is
where the tests already are — and a schema change in the app ships without a relay change, which is
what keeps a phone on an old build from being broken by a desktop on a new one.

## Last-write-wins, guarded, and the loss it admits

Each document carries a server revision. A `state_put` naming a stale revision is refused and the
current document comes back instead; the client adopts it and drops the write it was holding. Two
browsers editing different pairs at the same instant means one of those edits is lost — a per-entity
merge would keep both, and it would also mean the relay understanding what a pair is, which the
paragraph above rules out. The window is one round trip against a store on the same machine, and
the loss is a document the user is looking at, so it is visible rather than silent. Before adopting,
the client copies any differing local body to a `_local` backup key: overwriting user data is
allowed, losing it without a copy is not.

## First connect decides who seeds

Server holds the document → the client adopts it, whatever it had. Server holds nothing and the
client has something → the client uploads at revision 0. Whichever browser connects first after
this ships seeds the fleet, and the second adopts. Stated plainly because it is the one moment the
feature deletes something the user typed, and the backup key is the reason that is survivable.

## No new gate

`HERDR_CONV_LOG` exists because a transcript puts what agents *said* on disk, which is the user's
call. A pair's name is a label the user typed into this app and cannot be anything else, so it
carries no such decision, and a feature that is off by default is a feature that silently does not
work. The store is unconditional; `HERDR_STATE_DB` moves the file, and deleting the file resets it.
Under `HERDR_LAN_OPEN=1` anyone on the LAN can rewrite these labels — the same LAN that can already
`send_text` into a running agent, so this widens nothing.

## Transcripts are not synced

A second browser gets the conversation's name and roster from this store and its text from
`conv_log`, which the relay already holds under `HERDR_CONV_LOG`. Uploading IndexedDB transcripts
would put megabytes on the wire to duplicate a table that is already there.
