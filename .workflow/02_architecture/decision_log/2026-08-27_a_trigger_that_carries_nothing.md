# Decision Log: A trigger that carries nothing, and a decision that sends nothing

**Class B** — one new gate (`hold`) in `DEFAULT_GATES`, one new pause reason (`holding`), one
condition added to an existing trigger call, one bug fixed in the conversation log's anchor, and one
client render case for an intentional no-send decision. No wire-message shape changes: `hold` uses
the existing decision row, but the client must not present it as an unconfirmed delivery.

## The problem, from one session's record

`s-20260826-1746-ab40` ran for two hours over two members — ARCH-Claude (`w7R:p1`) and ARCH-Codex
(`w24:p1F`) — under an arbitrator at `w24:p3B`. It produced 24 decisions and 19 sends, and paused
five times for `call_human`, three times by hand, once on a relay restart and once on
`member ambiguous`. Not one decision was rejected: the arbitrator's JSON discipline was never the
problem.

Roughly a quarter of those decisions were spent on nothing, and the session twice had both members
working at once in a design whose whole premise is that they take turns.

### 1. Every `done → idle` transition recorded the turn twice

```
2775  w7R:p1  agent_final  working->done  1893 chars  span 161-188  19:18:16
2780  w7R:p1  agent_final  done->idle     1893 chars  span 161-188  19:19:13
```

Byte-identical text, identical span. Four `done → idle` transitions in the session window, four
duplicate rows. A perfect correlation, and two independent defects behind it.

`TURN_END_STATES` is `("idle", "done", "blocked")`, so a harness passing through `working → done →
idle` ends a turn twice. That is correct and stays: other harnesses only ever reach `idle`, and a
list that dropped it would lose their turns entirely.

The dedupe that should absorb the second one is `_messages_after_record`, and it fails in an
ordinary case. Its anchor is the record's newest three messages *that were read off a pane*,
matched as a contiguous run in the window. Prompts this relay sent are excluded from the anchor —
correctly, since the record holds them whether or not the pane ever echoed them — but they are
still *in the window*. Between turn 2732 and turn 2775 sat an arbitrated instruction and a human
prompt, both `at_src='sent'`. So the run "agent 2732 then agent 2775" never appears in the window;
alignment fails at every offset; and the function falls through to its last resort, "record the
last turn block", which rewrites a turn already in the record.

`_sent_after_read` is the set that would fix this. It is already computed. It is applied to the
messages returned *after* alignment succeeds, and never to the alignment itself.

### 2. A duplicate record woke the arbitrator, and the wake-up broke turn-taking

`arbitrate_turn_end` runs on any transition into an ending state, whether or not
`record_turn_end` wrote anything. So each of those four duplicates cost a full decision.

Decision #15 sent a `review` to Codex at 19:18:51. The duplicate turn arrived 22 seconds later,
and decision #16 wrote to Claude at 19:19:41 — while Codex was still working on the review. Both
members were then running. The arbitrator's own `why` names the situation exactly:

> member-1's turn_end carried no content beyond the commit already sent to review in the previous
> decision, and member-2 is actively working on that review now. Nothing to arbitrate yet

It knew. The roster line in its prompt showed `member-2 … / working`, freshly read from
`herdr pane list`. Knowing was never the gap.

### 3. Knowing and being unable to act is what cost the budget

The gate vocabulary offers two outcomes: write to a member, or `call_human`. There is no way to
say "nothing to do here, stay armed". So an arbitrator that correctly identifies a spurious trigger
must either wake somebody or stop the session. It wakes somebody — and that wake-up is itself a
turn end, which is another trigger:

```
19:19:41  -> Claude   "Nothing new to send you..."        395 chars
19:19:49  <- Claude   "Understood. Holding."
19:20:11  -> Claude   "Correct, keep holding."            138 chars
19:20:16  <- Claude   "Holding."
19:20:41  -> Claude   "Still holding correctly."          113 chars
19:20:47  <- Claude   "Holding."
19:21:05  -> Claude   "Holding acknowledged."             106 chars
19:21:09  <- Claude   "Holding."
19:21:50  -> call_human
```

Four decisions and five wake-ups to escape one bad trigger, ended only by pausing the session. The
same shape ran against Codex at 19:12:50–19:14:00. Decisions cost 17–58 seconds each, median 37,
and the latency does not track prompt size — a 1072-character prompt took 40 seconds and a
19736-character one took 56. The time is in the model's deliberation, not its reading.

## What this settles

Two changes, in the deterministic layer, chosen because each removes a whole class of the above
rather than the instance that was observed.

### The invariants frozen here

**1. A turn end that recorded nothing is not a trigger.** `record_turn_end` already returns the row
ids it wrote, and the poll loop already receives them for `note_turn_ids`. When that list is empty
the pane said nothing the record did not have, so there is nothing for an arbitrator to decide and
it is not asked. The session still gets an event line saying a turn ended and why nothing was
asked, because a trigger that vanishes silently is how this became invisible in the first place.

This is a rule about *members*. The arbitrator's own turn end is checked first, by
`arbitrator_finished`, and is never gated: its answer is a file that is already written, and its
pane is expected to have nothing new on it.

**2. The anchor skips what the relay typed.** `_aligns` walks past window messages that are echoes
of sends the record already holds, using the `_sent_after_read` set the function computes anyway.
A prompt sent by this relay is not evidence about where the record ends inside a window — it is in
the record either way — so it must not be able to break a run.

Fixing this at the source matters more than catching the duplicate later: a duplicate that is never
recorded costs nothing, where one caught at the send has already spent a decision and its 37
seconds, and has already put a wrong row in a permanent record.

**3. `hold` is a decision, not the absence of one.** A gate that writes a row, records a `why`,
sends nothing, and leaves the session armed. It is the honest outcome for a trigger that carried
nothing, for a member that is still working, and for a turn that needs no reply — and its absence
is what turned one bad trigger into five wake-ups.

It spends a step, because it is a decision the model produced and the budget counts those. It does
not spend `consecutive`, because that counter exists to bound how far an unattended session can
drive the members, and a hold drives nobody.

**4. Holding is bounded.** Three consecutive holds pause the session with reason `holding`. An
armed session with a clock trigger could otherwise hold for ever, which looks identical from
outside to a session that is working — and "an unattended loop that stops must not be discovered
hours later" cuts both ways: one that never stops must not be either.

**5. A decision that sends nothing is not an unconfirmed delivery.** The client derives
`delivered` from whether a send row exists, which makes "the arbitrator chose not to write to
anyone" and "the relay could not prove its write landed" the same picture. They are opposites: one
is the loop working, the other is the thing a person most needs to go and look at. `call_human`
has been mis-drawn this way since it existed — five red `not confirmed` badges in the session
diagnosed above, all of them decisions that worked. `hold` makes it common enough to fix rather
than inheriting it.

**6. The path shows what did not happen.** A suppressed trigger and a hold both write an event.
The `events` table is where a person reconstructs a session, and this whole diagnosis was possible
only because triggers that were dropped for other reasons already wrote lines. Two new kinds of
non-event join them rather than being optimised away.

## What is deliberately not here

**The duplicate gate before a send.** Refusing a send whose source turn was already delivered to
that member is the next slice, and it belongs at `_execute` next to the existing `target_not_live`
check, routed through `_reject` so the re-prompt and the two-failures-per-sequence bound apply
unchanged. It needs `hold` to exist first: without it, the re-prompt after a refusal has nowhere to
land but `call_human`, which trades a chatter loop for a stall.

**Serial execution.** Coalescing a trigger while any member is `working` is what actually enforces
turn-taking. `_execute` re-resolves and refuses a `BUSY` *recipient* today, which is a different
guarantee — decision #16 passed that check cleanly, because the member it wrote to was idle and the
busy one was the member nobody was writing to.

**The session-state block in the trigger prompt.** Which member was last written to, at which
sequence, and whether it has ended a turn since. Every line is a query over `sends`, `decisions`
and `turns`; none of it is new state. It makes the judgement mechanical instead of inferred, which
is the precondition for a lighter arbitrator model.

**Minimal and extensive modes.** A per-decision `style` the arbitrator chooses under a session-wide
default, with the relay attaching the triggering turn verbatim when it says minimal. That is a
change to what members receive; everything above is a change to when the arbitrator is asked and
what it may answer. The two are independent, and the fixes go first: under minimal mode a spurious
trigger would paste a member's own summary back at it, which reads as an instruction to redo the
work.

**A fallback guard in `_messages_after_record`.** The last-resort path is reached for legitimate
reasons too — a `/clear`, a record holding nothing read off this pane — and refusing to emit a
block identical to the record's newest row would cover those as well. The `_aligns` fix removes the
case that was observed. Add the guard if a duplicate survives it.

**`member ambiguous`.** The session paused on it once, at 18:59:20, around member-1's pane moving
from `w7C:p1` to `w7R:p1`. Two panes sharing a `(host, agent, cwd)` fingerprint cannot be resolved,
and two Claudes in one checkout is an ordinary way to work. Nothing here touches it.
