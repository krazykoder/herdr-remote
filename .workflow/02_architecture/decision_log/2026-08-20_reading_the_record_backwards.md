# Decision — The record is walked backwards by hand, never automatically

**Class B** — one new optional selector on an existing message; no new message type, no schema
change, no new index.

`conv_log` has only ever gone forwards. `last` bounds the window at the newest end, the byte cap
drops from the oldest, and `since_id` asks for what has happened since. A pane with a thousand
turns therefore shows its recent end — roughly seventy, at the sizes this record actually reaches —
and grows from there. The rest was unreachable by any question the client knew how to ask.

`until_id` is the mirror: turns strictly before a row id. It needs no new sort and no new index —
the query is already newest-first-then-reversed over `(at, id)`, and `turns_fp` covers it — so it
moves which window "the newest `last`" means, from the end of the record to the end of what the
asker already holds.

**Manual, and it stays manual.** Automatic behaviour is untouched: nothing walks back on its own.
The rows are the reader's disk and the relay's time, and neither is spent on history nobody asked
to see. The control is at the top of the thread, above the oldest bubble, because that is where
the reader is by the time they want it.

**Bounded at `CONV_LIVE_DEEP_MAX` (2000) a pane.** This store shares an IndexedDB budget with the
transcripts, so an uncapped walk evicts another conversation's history to make room — a silent
eviction of something the reader did not ask about is worse than a button that stops. What it
costs is visible while it is spent: the storage panel reports this store per pane.

Three things had to be got right, and each is invisible when wrong:

* **The ceiling is raised before the ask, not after the answer.** The per-pane trim runs on the
  tick the rows land, so a ceiling still at one window discards every backfilled row immediately —
  the walk fetches, trims, and shows nothing.
* **A backfill is never a watermark.** Its highest id is *older* than the bucket's `syncedTo`, so
  taken as one it winds the bucket backwards and the next delta re-fetches everything between. The
  relay echoes `until_id` for exactly this check, alongside the `pane` echo that already exists for
  the same class of mistake.
* **A joint thread asks once per member.** Members do not share an oldest row, so one bound over
  the roster hands the newer members a window they already hold.

The reader's place is put back by measuring how much taller the box got, not by counting rows:
bubbles are variable height and a wrapped one is not the same height twice.

An empty backfill answer is the bottom of the record for that pane and is stored as such, so the
control says which of two things ended the walk — the record's start, or this device's ceiling.
