# Spec — A spawn that outlives the view it was asked from

**2026-08-29 · Phase 3 · obeys** `.workflow/02_architecture/decision_log/2026-08-29_a_spawn_that_outlives_the_view.md`

Three behaviours change. They are independent and can be verified separately.

---

## S1 — The pane↔member binding is durable

### Data

The conversation index (`herdr_conversations`, synced as the `conversations` document) gains two
optional fields. Both are notes about a start in flight; neither is part of the record of what was
said.

| Where | Field | Shape | Meaning |
|---|---|---|---|
| a member | `pending` | `{ref: string, at: number}` | a start named `ref` is in flight and will **continue this member** |
| a conversation | `pending` | `[{ref: string, at: number, label: string}]` | starts in flight that will **join as new members** |

`ref` is the id the client put on `start_agent` and the relay repeats on the pane's snapshot.
`at` is `Date.now()` at the moment the start was sent.

A note is **live** while `Date.now() - at <= CONV_PENDING_MS` (120000). Expired notes are dropped
on the next write of the index; they are ignored on read whether or not they have been dropped yet.

### Behaviour

| # | Given | When | Then |
|---|---|---|---|
| S1.1 | A member is restarted from the conversation window | the `start_agent` goes out | a live note is on that member carrying the start's `ref`, written **before** the send |
| S1.2 | A new agent is started from the conversation window (`New agent`) | the `start_agent` goes out | the start carries a `ref` and a live note is on the conversation carrying it |
| S1.3 | A note is live and a snapshot carries a pane with a matching `ref` | the snapshot is handled | that pane continues the noted member (or joins as a new member for a conversation-level note), and the note is dropped |
| S1.4 | Same as S1.3 | — | the succession is performed by **whichever tab sees it**; it does not require the tab that pressed the button, the conversation window being open, or any particular pane being open |
| S1.5 | The ordinary path already ran (`openPendingStart` landed this pane for this conversation) | — | the note is dropped by it, and S1.3 finds nothing to do |
| S1.6 | A note is live for a member | anything asks whether the landing pane is a fresh pane (`convStartClaimed`) | the answer is no, so `convAutoJoin` does not file it into an auto conversation |
| S1.7 | Two members of one conversation are restarted | — | each carries its own note; neither overwrites the other |
| S1.8 | A note's deadline passes with no pane carrying its `ref` | the index is next written | the note is gone and the member is left as it is |
| S1.9 | A member already carries a live note | Restart is pressed on it again | nothing is sent; if a pane carrying that `ref` is already live it is landed now, otherwise the reader is told the restart is already in flight |

### Explicitly not in scope

The **opening prompt** is not carried in the note and is not sent by S1.3. It stays on the fast
path (`openPendingStart`, from `startPrompt`). A succession recovered by S1.3 lands the member and
says nothing to it — the same rule the previous recovery path applied, for the same reason: two
tabs holding the same note must not both speak.

---

## S2 — Restart all includes paused members

| # | Given | When | Then |
|---|---|---|---|
| S2.1 | A conversation whose members are all paused, and whose records can be restarted | `Restart all` | every one of them is queued and restarted, one at a time |
| S2.2 | A conversation with some live and some paused members | `Restart all` | all of them are queued; live ones are ended first, paused ones are simply started |
| S2.3 | A conversation no member of which satisfies `canRespawn` | `Restart all` | `Nothing here can be restarted.` |
| S2.4 | The queue is draining | a start is in flight (`pendingStart`, or any live note in this conversation) | the next member waits for it |

`Restart all` and a row's own `Restart` now agree: the row already restarts a paused member, and
the only reason the batch did not was a `live.has(k)` filter it did not need.

---

## S3 — A start from the conversation window does not navigate

| # | Given | When | Then |
|---|---|---|---|
| S3.1 | The conversation window is open | a start made for a conversation lands | the pane is **not** opened; the conversation window redraws with the new member in it |
| S3.2 | The conversation window is open | any other start lands | the pane is **not** opened |
| S3.3 | The conversation window is not open, and no pane is open | a start lands | the pane opens — unchanged |
| S3.4 | The conversation window is not open, and a pane is open | a start lands | the pane does not open, unless the start was a Duplicate (`intent === 'open'`) — unchanged |
| S3.5 | A succession recovered by S1.3 lands | — | nothing is opened, ever |

"The conversation window is open" is `openPanelId() === 'convView'` — read off the screen, which is
what that function is for. Which conversation it is showing does not matter: the reader is reading
a conversation, and a start is not a request to stop.

---

## Failure modes

| Case | Behaviour |
|---|---|
| The conversations document is adopted whole from the relay and takes the note with it | The pane is filed into an auto conversation by `convAutoJoin` and can be moved by hand. Same as before this spec. |
| `localStorage` refuses the write (private mode) | The note is not stored; the fast path still works exactly as today. No throw reaches the caller. |
| A pane carries a `ref` matching a note in a conversation that has since been deleted | The note is gone with the conversation; nothing lands. |
| `convContinueTranscript` refuses the copy (the new key is one another conversation records) | The member joins as a new member, as it does today (D3). |
| Two tabs land the same note in the same second | The second finds the member key already moved and joins nothing — the `already` guard in the succession covers this today and is unchanged. |
