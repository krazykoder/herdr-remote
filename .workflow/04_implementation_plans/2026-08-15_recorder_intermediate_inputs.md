# Every input the pane highlights becomes a bubble

*2026-08-15 · implementation plan · recorder (`web/src/conversation_pure.js`,
`web/src/conversation_store.js`)*

Three reports, one mechanism behind them:

1. Messages miss intermediate user inputs that the rows view highlights correctly.
2. A message broken across lines by the terminal may be worth normalizing before it is committed,
   to help matching and duplicate detection.
3. After an execution interrupt, duplicates appear until "Remove duplicates" is pressed.

The user's own ordering: **"if rows are detecting inputs and summary, those should appear in
bubbles — deep history is a bonus."**

## Why the bubbles miss what the rows show

Detection is not the problem. The rows view and the recorder call the *same* detector —
`userInputLines()`, from `terminal.js:165` and `conversation_pure.js:55` — and `paneMessages()`
already returns every contiguous run of user lines as one message.

The loss is at commit time. `recordPaneNow` (`conversation_store.js:291`) makes a durable write on
three events only:

| Event | What it commits |
|---|---|
| first read | everything on screen, as backfill |
| deep read (Load more) | anchored append and prepend, via `deepEntries` |
| **turn end** | `turnEntries` → **`turnMessages`: the last agent block, plus the user runs directly above it** |

`turnMessages` (`conversation_pure.js:162`) walks back from the last agent message and stops at the
first line that is not the user's. So a user input that is not immediately above the closing message
is never committed:

- an interrupt,
- a steer sent while the agent is working,
- a second prompt sent before the first reply lands,
- anything typed straight into the terminal, or sent from another client.

Prompts sent from *this* browser survive regardless, because `noteSent` commits them at the send —
which is exactly why your own sends look right and the intermediate ones vanish.

`newTurnMessages` (`:186`) compounds it: when the stored tail is already a user entry it drops
*every* user message in the turn, on the assumption that the only one that could be there is the
echo of the prompt just sent.

## The plan

### 1. The turn-end append becomes anchored

At a turn end, stop taking "the last block only". Locate the record's own newest agent entry inside
the window and append everything below it, less whatever was already committed as a send. That is
precisely what `deepEntries` does for a deep read, so it is reused rather than cloned.

- Anchor found → every message below it is appended, intermediate inputs included.
- Anchor missed → fall back to today's `turnMessages` behaviour. A window that cannot locate the
  record's end contributes what it can prove and nothing more (§5.2 of the spec's rule: never guess).
- Idempotent on the same window, so the 3s poll behind the turn-end read still writes nothing, and
  the `held.lastTurn` guard stays as it is.

### 2. One comparison key, whitespace-free

`convKey` collapses whitespace; a line the terminal wrapped still breaks a match mid-word, which is
the "continuous sentence split into two snapshots" case. `convDupKey` already strips whitespace
*entirely* for the duplicate repair, and that is the right normalization for every comparison:
anchor lookup, send matching, dedupe.

Stored text is untouched — a thread that ran Codex's three closing paragraphs together would lie
about what was said. Only the key changes.

Effect: a higher anchor hit rate, which is what makes step 1 land more often, and a smaller class of
duplicates at the source.

### 3. Interrupt duplicates — reproduce first

Hypothesis: an interrupt commits a partial closing block; the pane then rewrites that block; the
text anchor no longer matches; the next read writes the tail a second time.

Repro before any fix: a fake-herdr fixture where a pane goes working → interrupted → done with the
closing block rewritten between the two ending transitions.

Steps 1 and 2 both attack this — an anchored, whitespace-free append is idempotent — so the repro is
expected to go green without a third change. If it does not, the fix is to refuse an interrupted
block as a *final* message and let the next real turn end record it.

## What shipped, and the one thing the plan got wrong

Steps 1 and 2 landed as written, with one correction found by the tests.

**A single-message anchor is not enough.** Anchoring on the record's newest agent message alone
picks the *newest* occurrence of that text in the window — and an agent that closes two turns
running with the same words ("Done.") has its record's newest entry matching the **last** message on
screen, so the turn between the two copies is invisible. `messagesAfterRecord` therefore lines up
the last `CONV_ANCHOR_CONTEXT` (3) stored messages, not one. A context line that falls off the top
of the window is absent rather than a mismatch — a window is allowed to begin mid-record.

Where nothing distinguishes two copies, including their context, the newest still wins and the
recovery is short: duplicating what is already recorded is permanent, being a turn behind is not.

**The context match is speaker-aware** (ARCH-Codex's review of `4c690b9`). Matched on text alone, a
context slot would accept the agent's "ok" where the record holds the user's — and the two speak in
turn, so aligning on the wrong one aligns half a turn out, which is the very off-by-one the context
exists to prevent.

**An empty answer is not a missing anchor.** `turnEntries` falls back to the last-block rule only
when the record's end cannot be found at all. When it is found at the end of the window there is
nothing past it, and that is the answer — falling back there would append the closing message a
second time, which is exactly what an interrupt did.

**The turn branch reads `body`, not `fresh`** (`conversation_store.js:378`). The append now takes
everything past the record's end, so a pane that has already begun its next turn would otherwise
commit that turn's half-written block — and a record only ever extends, so it would stay
half-written.

## Tests

- vm slice, `tests/test_conversation.js`: an input between two replies recorded, only the closing
  message carrying the transition, idempotence on a repeated window, a sent prompt not recorded
  twice, the `/clear` fallback, and the two anchor-ambiguity cases.
- browser, `tests/e2e/browser/conversation.spec.js`: the same two through the real store — a
  mid-turn input arriving as a bubble, and a second turn end over an unchanged window adding
  nothing. Both windows are the same row count on purpose: a deeper one takes the recovery path,
  which was already anchored, and would not have tested the turn append at all.

Against the code before the fix, those two browser tests fail with **4 of 6** messages (the
interruption and its reply missing) and **5 of 6** (a duplicate appended at the second turn end) —
the two reports, reproduced.

## Branch

`feat/followups`, off `main` at `57de0d7`.
