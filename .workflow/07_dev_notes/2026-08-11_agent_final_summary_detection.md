# Agent Final Summary Detection

Change class: **A** — frontend only, `web/index.html`. No wire change, no relay change, no new
message type, no dependency, no agent call, no backend assessment.

## Problem statement

1. Agents end a session by printing a final message, sometimes spanning many lines.
2. Users want Herdi to find that text so it can preselect the line ruler for transfer.
3. Herdi must not generate, rewrite, or send a summary. It only picks a line range.
4. The hard part is not finding a heading. It is **separating the agent's closing prose from the
   tool executions above it** — the command runs, diffs, and test output that dominate the pane.

## Evidence — real panes, read `2026-08-11`

Read with `herdr pane read <id> --lines 200 --source recent-unwrapped`, the exact call the relay
makes (`relay/herdr_relay.py:418`). Both harnesses were live in workspace `w24`.

### Claude — tool execution

```
⏺ Bash(for f in ~/.claude/settings.json .claude/settings.json; do echo "=== $f"; done)
  ⎿  === /Users/towshif/.claude/settings.json
     … +202 lines (ctrl+o to expand)
  ⎿  Allowed by auto mode classifier
```

### Claude — closing prose

```
⏺ Sound half committed on main as dd51cea. Notifications work done both halves:

  Badge (2a4d58d) — one needsAttention predicate, blocked and done identical, feeding five surfaces:
  - agent list cards: hoisted into a "Needs you (n)" section
  …
  Green: node 157/0, Playwright 28, Python 236 OK, both e2e ALL PASS.

✻ Worked for 28m 3s

❯ /update-config
```

### Codex — tool execution

```
• Ran npm run test:e2e
  └ [WebServer] 2026-08-11 08:22:25 [INFO] mDNS registering at 192.168.86.41
    … +67 lines (ctrl + t to view transcript)
```

### Codex — closing prose

```
• S2b review clean. No edit needed.

  Verified: 118 Node + 19 Playwright tests pass.

  Next: S3. Convert poll/render path to explicit view, then remove S1 accessors.

─ Worked for 1m 01s ───────────────────────────────────────────────────────────
```

### Leading-character histogram over those two panes

| Claude | count | | Codex | count |
|--------|-------|-|-------|-------|
| col 0 `⏺` U+23FA | 13 | | col 0 `•` U+2022 | 16 |
| col 2 `⎿` U+23BF | 18 | | col 2 `│` U+2502 | 12 |
| col 0 `✻` U+273B | 3 | | col 2 `└` U+2514 | 8 |
| | | | col 0 `─` U+2500 | 7 |

Everything else is indented continuation text.

**Both harnesses already mark the distinction we need, in the gutter column, with one
character.** Prose and tool calls share the speaker glyph; what separates them is that a tool call
is followed by result-gutter lines and prose is not. Test fixtures retain only sanitized excerpts
that preserve this shape; full live-pane history does not belong in the repository.

## Mechanism — gutter parsing, not text matching

One rule, identical for both harnesses:

1. A **block** starts at a line whose column-0 character is the harness's *speaker glyph*, and
   runs until the next column-0 glyph, footer, or full-width rule. Blank lines do not end a block
   — Codex's closing message is three paragraphs separated by blanks.
2. A block is a **tool execution** if any line in it starts (after indent) with a *result glyph*.
   `⏺ Bash(…)` always carries `⎿`; `• Ran …` always carries `└` or `│`. Closing prose never does.
3. The **final summary** is the last block that is not a tool execution, bounded above the latest
   harness-specific user-input gutter (`❯` / `>` for Claude, `›` for Codex) when one exists.
   `start` = its glyph line. `end` = its last non-blank line.
4. No such block: no selection, no message.

Nothing above reads a word of the content. It reads column 0 and one character.

### Harness profiles — seeded gutter characters

| harness | speaker | result gutter | user prompt | turn footer |
|---------|---------|---------------|-------------|-------------|
| `claude` | `⏺` | `⎿` | `❯` `>` | `✻ Worked for` / `✻ Baked for` |
| `codex` | `•` | `└` `│` | `›` | `─ Worked for` |

Keyed on `a.agent`, which the relay already sends.

The prompt column was read off live panes on `2026-08-11` rather than guessed: `herdr pane read`
on a running Claude pane shows `❯ /update-config` and `❯ allow the test commands without
prompting` at column 0, and on a running Codex pane `› Summarize recent commits`, both in
scrollback and as the composer at the foot of the pane. Neither pane had a single line of tool
output starting with those characters, which is what the test *the composer at the foot of a real
pane is a prompt line* now pins: one prompt line in each fixture, no false positives.

## Unknown harnesses

1. The profile table covers the only two sampled harnesses: Claude and Codex.
2. An unknown harness gets no suggestion. A wrong tool-output selection is worse than no
   convenience.
3. A user-selected final block can reveal a candidate speaker glyph, but it cannot reliably reveal
   the result-gutter glyph: that glyph sits in the tool blocks the user did *not* select. One
   selection therefore cannot teach a complete profile.

**What is built on top of that ceiling.** The half a selection *can* teach is worth having, so
**Learn** stores the speaker glyph alone, under `herdr_gutters`
(`{version: 1, byAgent: {pi: "◆"}}`), and `profileFor()` returns it with an empty result list.
That is enough to cut the pane into blocks: trim learning, the ↓↑ pill, and **Summary** on demand
all work from it. It is not enough to *volunteer* a range. With no result glyph `blockSpan` cannot
tell a command from a sentence, so the automatic suggestion alone gates on `GUTTERS[a.agent]` —
the complete shipped table — rather than on `profileFor`. The vm test *a learned harness never
suggests on its own* is that rule.

Stepping on a learned profile can therefore land on a tool block, and pressing again passes it.
That was weighed against hiding the pill entirely and lost: a marker the user was asked to teach,
which then drives nothing they can see, is worse than a step that occasionally overshoots.

**Confirmed by showing, not by counting.** Pressing a button twice conveys no new information;
showing the character it read does. So teaching a glyph asks `Learn "◆" as pi's message marker?`
and a whitespace or word character in column 0 is refused outright — prose, not a marker. A wrong
glyph breaks every block boundary in the pane, which is why this one step confirms; a wrong trim is
outvoted by the tally, which is why that one does not.

A shipped profile still needs a real pane sample containing both a tool block and a closing prose
block; add it to `GUTTERS` and that harness gets suggestions like the other two.

`pi` was sampled on `2026-08-11` and had no glyph to ship: it indents its whole transcript by a
space, so column 0 is empty, and user and agent text are the same shape. The evidence and the three
ways out are in `2026-08-11_pi_has_no_gutter.md`; option C was taken.

## pi — a gutter the harness does not have

`extensions/pi/herdr-gutter.ts` is a pi package that registers a markdown transformer and writes
the missing distinction into the render: `›` for the user, `⏺` for the agent, `⋯` for reasoning.
It is display-only — the session file and the model's context never see it — and it costs the relay
nothing, so the wire is unchanged and the whole feature stays in the frontend. Its README carries
the install and the glyph collision scan.

Three things about pi then had to reach the parser, and each is a field on the profile rather than
a branch in the code:

| field | why |
|-------|-----|
| `indent: 1` | pi indents everything, so its gutter is column 1. Not "first non-space character", which would let indented Claude prose pass as a marker |
| `ends: ['⋯']` | pi does **not** hang-indent a wrapped line — a continuation sits in the same column a glyph does, so column 0 alone cannot end a block and the glyph set has to |
| `composer: false` | Claude and Codex draw their composer with the prompt glyph, so it is the foot of every live pane and the closing message is the block above it. pi's composer is a box the extension cannot reach, so pi's last `›` is the newest *request* and the answer is below it |

`result: ['$']` is pi's tool marker, which makes the harness a complete shipped profile rather than
a learned half one: a reply followed by a command is correctly no closing message.

Two helpers, `gutterOf` and `endsBlock`, are where all of this lives; every column-0 read in the
parser now goes through them. For a harness with no `indent` both collapse to what was there
before, so Claude and Codex are byte-identical.

Marking reasoning was not cosmetic. pi's thinking sits between the request and the reply with
nothing in front of it, and without a marker the blue user-turn rule ran straight down through it.

**Streaming.** The transformer skips partial updates, so a glyph appears when its message finishes
rather than as it is written. Nothing downstream minds — a suggestion is only offered on a pane
herdr reports as `done`.

**Per host.** Every machine running pi needs the extension. One without it parses exactly as it did
before, so the failure is soft.

## Detection trigger

Runs after a `pane_content` update when `status === 'done'`, `selA === null`, and this pane-content
snapshot has not already been suggested. The in-memory suggestion key is `pane_id` plus the line
count plus the final line; it prevents the 3s poll from reselecting a range the user cleared. The
existing `reanchorSel` keeps an accepted suggestion aligned on later reads.

**Two guards, not one.** `selA === null` at the moment of the read is not sufficient: a read whose
text no longer contains the user's selection clears it, and the ruler is then empty for the wrong
reason. So the trigger reads whether a range existed when the read *arrived*, and a read that just
destroyed one makes no suggestion. Found while building, not while designing — the browser spec
`a read that destroys the range does not replace it with a guess` is there to keep it.

## Trim — the one thing that is learned

The gutter parse gets the *block* right. What it cannot know is how much of that block a given
person wants: some always drop the opening sentence, some always drop the trailing next-steps
paragraph. That difference is a pair of line offsets measured from the block's own edges, it is
stable per harness, and it is the only thing worth remembering.

- **Taught by committing to a range, not by dragging one.** A drag is exploratory. Transfer, Copy
  and **Learn** all call `learnFromSelection()`; Copy is in that list because Transfer only exists
  on a configured pane pair, and Learn because the range worth teaching is often one the user has
  no intention of sending anywhere.
- **Measured against the untrimmed block**, which `blockContaining(paneRows, agent, selA)` recovers
  from the selection itself. Learning against the already-trimmed range would compound: each
  transfer would trim one more line than the last, forever. Deriving the block at teach time rather
  than remembering the last parse is also what lets a hand-drawn range anywhere in the pane teach —
  the user is not restricted to correcting the suggestion.
- **A selection outside the block teaches nothing.** Different intent, not a smaller trim.
- **Stored as a tally, not a last-write.** `{version: 2, byAgent: {claude: {"2,0": [3, 8]}}}`
  under `herdr_summary_trim`: count plus a local recency tick. The most-confirmed pair wins;
  ties use the most recent explicit trim. An untouched suggested range teaches nothing — otherwise
  its accidental `0,0` votes would drown out a real correction. A corrupt or older-version blob is
  read as no trim.
- **Blank edges come off after.** The parse already ends on the last non-blank line, but a learned
  head offset can land on one. A trim that would leave nothing is discarded and the block kept
  whole — a preference, not a licence to select zero lines.

No content is stored: two integers and a count, per harness.

## UI

`selCount` gains the source: `12 lines · final message`, and the band and handles paint orange
(`.auto`) to say the range was found rather than dragged. Touching a handle drops both — it is the
user's range from then on. A **Summary** button in the quick-actions nav row selects it on demand;
it appears only on a pane that has one, and unlike the automatic suggestion it has no `done` gate,
because pressing it is the user asking. The range it selects is trimmed — that is the point of
learning a trim, and only ranges the user shaped by hand are in the tally. Otherwise a suggested
range is an ordinary ruler range — drag it, tap the text to clear it (`:3937`), transfer it.

**Learn**, left of Copy in the selection bar. On a harness with a profile it records the trim and
says what it recorded — `Learned 1/0 ✓`, head and tail — so the user finds out what was inferred
after the fact rather than having to predict it. On one without, it reads the glyph off the line
the selection starts on and asks before storing it, and that harness gains the pill and Summary.
Pressing it on an untouched suggestion says `Trim it first`: confirming the parser's own output
teaches nothing, and letting it vote is what made the tally useless. It hides itself on a selection
that is not inside a block, because there is nothing there to learn.

**↓ ↑**, a floating pill at the pane's top-right (`.block-nav`, out of flow so the pane keeps its
height). Beside the ruler rather than on it: the ruler's handles travel that same track, and a tap
target sitting on a drag target turns a drag into a jump. It scrolls the range it finds into view
and selects it as a found range; at the top of what is loaded, ↑ calls `loadMore()` rather than
reporting nothing there. Hidden when the harness has no profile at all — that absence is the
invitation to press Learn.

**One stop per turn, not per block.** `turnSummaries()` is the list it walks: for every prompt
line, the last agent block above it, tool blocks skipped and duplicates collapsed where two
prompts share one. Between two prompts an agent says a dozen things and only the last of them
answers the question, so stepping message-by-message meant several presses of ↑ to cross a single
turn and no way to tell which stop was the answer. On a harness with no prompt gutter — a learned
one — the list is empty and stepping falls back to `blockBefore`/`blockAfter`, which walk messages
and skip tool blocks.

**User prompts** are harness-specific column-zero gutters (`❯` / `>` for Claude, `›` for Codex).
The treatment starts there and runs through the turn's continuation lines, stopping at the last
line with text on it — trailing blanks are the gap before the agent answers, and a rule running
down empty rows reads as a turn that never ended.

**Colour and a rule, no fill.** The first version tinted the whole row and put a fainter halo above
and below it. A filled block behind monospace reads as damage rather than as structure, so what is
left is blue text and a 3px rule pulled into the pane's own left padding (`margin-left: -7px;
padding-left: 4px`) — outside the first character cell, so the `❯` it belongs to is never sitting
underneath it. The detected summary gets the same treatment in orange, the colour the ruler already
paints a found range in.

**Rows are real DOM.** `renderPaneRows()` writes one `<span class="term-line">` per line instead of
one text node, which is what lets the rule stay attached to its text in every wrap mode. Two things
fall out of it: `rowGeom` reads reflow geometry off a box rather than measuring a `Range`, and the
rebuild is skipped when a read delivers text identical to the last one — the pane is re-read every
3s and rebuilding thousands of spans for an unchanged read is the one cost per-line DOM could
plausibly carry.

**Every turn is marked, not only the newest.** `summaryRows()` paints the same list stepping
walks, trimmed the same way, so the orange rows and the range ↑ selects are the same lines.
Marking only `finalAt` looked right on an open pane and was useless where it mattered: the newest
summary is on screen anyway, and the one being hunted for is four screens up. On a harness with no
prompt gutter there is one mark, the pane's final message.

**Highlight preferences** sit below Appearance in Settings, both default on, both persisted
(`herdr_highlight_user`, `herdr_highlight_summary`). Only the row classes are affected — the parse
runs either way, because the ruler, Summary and stepping all depend on it. Toggling repaints the
open pane, and so does teaching a trim: the trim moves the summary, and the orange rows are drawn
from it.

## Rejected options, and why

| Rejected | Why |
|----------|-----|
| Heading vocabulary (`Summary`, `What changed`, `Next steps`) | Neither real pane contained one. Claude closed with `Sound half committed on main as dd51cea`, Codex with `S2b review clean. No edit needed.` A word list would have matched nothing and learned nothing. |
| Per-feature weight vector, online ranking, ~10-selection warmup | Bullet density and line count are the *varying* part of the output. Weighting them fits noise. The invariant is one gutter character, and counting characters needs no model. |
| TensorFlow.js or any ML dependency | No generic model knows harness terminal chrome, and there is nothing left to learn once the glyph is known. |
| Relay-side or agent-side assessment | Explicitly out of scope. The browser holds the text and the selection state; the parse is column-0 character comparison. |
| `Useful` / `Not summary` feedback buttons | Transferring is yes, dragging elsewhere is no. Both already exist on screen. |
| High/medium/low confidence tiers | Either a non-tool block was found or it was not. |
| Running detection on every pane read | Poll is 3s. Once per done-run, guarded by `selA === null`. |
| Learning the *end* boundary from the block rule | Superseded, not rejected: the block rule gives the last non-blank line, and the trim tally then learns how many lines back from it this user actually wants. See *Trim*. |

## Open product decision — closed

*"Should a detected range include tests and next steps, or only completed work?"* — The whole
final block, because that is one message and splitting it needs content parsing. In the Codex
sample that means `S2b review clean` through `Next: S3 …` in one range; a user who wants less
drags the handle.

## Risks

1. **Glyphs change between harness versions.** Detection degrades to no selection, never to a
   guessed tool-output selection. Add a new literal profile after sampling the changed output.
2. **`--source visible`** truncates the block at the top of the frame. `recent-unwrapped` is the
   default (`relay/herdr_relay.py:1091`) and is what detection assumes; when the block's glyph
   line is off-screen, no selection.
3. **A `done` pane whose last block is a tool execution** (agent stopped after a command) gets no
   selection. Correct — there is no closing message to select.
4. **A prompt gutter appearing in tool output.** `>` at column 0 is the one plausible collision;
   both sampled panes had none, because tool output sits indented under a result gutter. A false
   prompt line splits a turn — one extra stop for ↑ — rather than corrupting a range, so it
   degrades to the message-by-message behaviour this replaced.

## Files

- `[MODIFY] web/index.html` — one `// --- Final message detection ---` block (profiles, block
  parse, trim tally, learned gutters, stepping), a call site in the `pane_content` handler,
  in-memory suggestion state, the `.auto` band styling and string in `drawSel`, the Summary button
  in `renderQuickActions`, the `.block-nav` pill and the Learn button, and a `learnFromSelection()`
  call in `doTransfer` and `copySel`.
- `[NEW] tests/test_summary_detect.js` — vm-slice over that block, same trick as
  `tests/test_attention.js`.
- `[NEW] tests/e2e/browser/summary_detect.spec.js` — the wiring the slice cannot see: that a read
  is what runs the parse, that only a finished pane is suggested for, that the band and footer
  paint, and that a held or deliberately cleared range is never overwritten by the poll.
- `[NEW] tests/fixtures/pane_claude_done.txt`, `pane_codex_done.txt` — minimal sanitized excerpts
  preserving the real gutter shape, each ending in the composer prompt line the live pane ends in.
  The fixtures are the spec; a glyph change breaks a test rather than a user.

Test cases: Claude fixture selects the `⏺ Ready. Name the change.` block and excludes every `⎿`
line; Codex fixture selects `• S2b review clean` through `Next: S3 …` across two blank lines and
stops before `─ Worked for`; each fixture has exactly one line the prompt gutters match; a pane
ending in a tool execution selects nothing; an unknown harness selects nothing.

## Verification

```bash
node --test tests/test_summary_detect.js
npx playwright test          # page still boots, selection still clears between panes
```

## Acceptance

1. A `done` Claude pane preselects its closing `⏺` block, with no `⎿` result lines inside it.
2. A `done` Codex pane preselects its closing `•` block, blank lines included, footer excluded.
3. A pane whose last block is a tool execution opens with no selection.
4. An unknown harness makes no selection.
5. A range the user is holding is never replaced by a suggestion.
6. A transfer of a trimmed range makes the next suggestion on that harness arrive trimmed the same
   way; a selection outside the block changes nothing.
7. A suggested range never starts or ends on a blank line.
8. Nothing on the wire changed.
9. ↓ ↑ step one stop per turn on a harness with a prompt gutter, landing on the message that
   closed each turn; the pill is absent on a harness with no profile at all.
10. Learn on an unseen harness asks before storing, shows the character it read, and stores nothing
    when declined. Once accepted that harness gains the pill and Summary, and still never gets an
    automatic suggestion.
11. Turning a highlight off changes only what is painted: the ruler, Summary and stepping are
    unaffected, and the preference survives a reload.

## What is deliberately left for later

Syncing what a browser has learned to the relay, so a second device starts taught. Proposed and
postponed: the store is two small JSON blobs under known keys, so the shape does not have to change
for it — a `learning` message in each direction and a merge (glyph: last write; trim: add the
counters) is the whole of it. Nothing in the current code assumes the store is local.

---

# Appendix — REJECTED proposals, kept for the record

Two designs preceded the gutter mechanism above. Both are superseded. Kept verbatim so the
reasoning is recoverable and neither gets re-proposed from scratch.

## REJECTED — v1: heading heuristics with per-feature weight learning (original note)

Rejected because both real panes read on 2026-08-11 contained **no heading at all** in the closing
message, so the heading vocabulary would have matched nothing and the weight learner would have
had no positive examples to learn from. The features it proposed to weight — bullet density, line
count, distance from tail — are the *varying* part of agent output; weighting them fits noise.
Superseded by the gutter parse, which reads the one invariant the harnesses actually print.

### Problem statement

1. Agents commonly end a session by printing a short final summary, sometimes spanning many lines.
2. Users want Herdi to find that existing text so it can preselect the line ruler for transfer or support a notification.
3. Herdi must not generate, rewrite, or send a summary. It only identifies a likely start and end range in the pane output.
4. Claude, Codex, and other harnesses render final responses differently, so one fixed marker cannot be assumed.

### Existing capability

1. The web app already receives raw pane text, splits it into lines, supports line-range selection, and transfers selected text.
2. A frontend detector can set the existing selection range; no new WebSocket message is needed for an initial version.
3. The relay has no richer summary boundary than the browser already has in pane content.

### Proposal: frontend detection

1. Run detection only after an agent becomes `done`, not during every pane update.
2. Inspect a bounded tail of raw, unwrapped pane lines.
3. Exclude known terminal chrome, prompts, and empty trailing lines.
4. Treat last remaining content line as the candidate end.
5. Search backward for a high-confidence summary start:
   - Harness-specific final-turn markers.
   - Headings such as `Summary`, `What changed`, `What landed`, `Tests`, or `Next steps`.
   - A final contiguous bullet or paragraph block with a summary-like shape.
6. Return a contiguous line range and a confidence level.

### User interaction

1. High confidence: preselect the ruler range.
2. Medium confidence: show `Likely summary`; user chooses whether to select it.
3. Low confidence: make no selection.
4. A deliberate user selection always wins over a suggested range.
5. Transfer remains an explicit user action; detection never auto-sends content.

### Harness profiles

1. Keep a small built-in profile per harness rather than one universal parser.
2. Add a generic fallback for headings and final bullet/paragraph blocks.
3. Profiles are detection hints, not a claim that all output from a harness has one format.
4. Start with Claude and Codex evidence captured from real panes; add other profiles only when examples prove a distinct pattern.

*Point 4 was the right instinct. Acting on it is what killed the rest of this proposal.*

### Reliability boundary

1. Without an explicit delimiter, final-summary detection is heuristic.
2. The only fully reliable contract is for a harness to emit a final delimiter, for example:

   ```text
   --- HERDI SUMMARY ---
   ```

3. When present, select from delimiter through final content line.
4. When absent, use the confidence-scored heuristic and avoid asserting that a summary was found.

*Superseded: the harnesses already emit a delimiter. It is the gutter glyph, and it is there today
without asking anyone to adopt a contract.*

### Backend and agent decision

1. No backend change for initial selection: browser already has required text and selection state.
2. No LLM or agent processing for initial selection: it adds latency, cost, privacy exposure, and nondeterministic boundaries.
3. Consider relay metadata later only if a detected range must be shared across clients, retained after a browser disconnect, or computed from pane history unavailable to the browser.

*Carried forward unchanged — still correct, and now a hard requirement.*

### Open product decision

1. Should a detected range include tests and next steps, or only completed work?

### FAQ

#### Can the frontend learn incrementally from manual user selections? Is there a frontend ML script or ready-made library for this?

1. Yes. Use local online ranking rather than a general ML model.
2. Generate candidate summary ranges after an agent reaches `done`.
3. When a user manually selects and transfers a range, treat it as positive feedback; nearby unselected candidates are negative feedback.
4. Update small per-harness weights for stable features: heading type, bullet density, distance from output tail, line count, and terminal-footer distance.
5. Rank future candidates with learned weights plus deterministic rules.
6. Store only versioned weights and feedback counts in browser `localStorage`; never store raw pane output.
7. Start learning after roughly ten confirmed selections. Before then, deterministic rules remain authoritative.
8. Provide `Suggested summary`, `Useful`, and `Not summary` feedback. A user selection always overrides a suggestion.
9. Do not add TensorFlow.js or another ML library initially. Browser training is possible, but dependency size and sparse per-user data do not justify it; no generic model understands harness-specific terminal chrome.

*Points 6 and 9 survive into the current design. Points 4, 7 and 8 do not: there is nothing to
warm up and nothing to weight once the glyph is known.*

## REJECTED — v2: learned marker store plus a two-strategy counter

An intermediate design, written before the panes were read. Rejected for the same root cause as
v1 — it keyed on the text of a heading line that real output does not contain.

- `localStorage['herdr_summary_markers']` = `{version:1, byAgent:{claude:{"summary":4,…}}}`, keyed
  on the normalized first line of the user's range (strip box-drawing and leading `#*•>-`,
  lowercase, collapse whitespace, cut at 40 chars), written on Copy and Transfer only, seeded with
  `summary`, `what changed`, `what i did`, `changes`, `tests`, `next steps`,
  `--- herdi summary ---`, capped at 20 per harness.
- Detection walked up ≤120 lines from the last content line to the nearest known marker, then kept
  extending upward past further markers while the gap was ≤30 lines.
- A second strategy, `lastblock` (last contiguous run of non-blank lines), covered headless
  output. A per-harness `{marker: n, lastblock: m}` counter picked between them by argmax,
  credited on each Transfer to whichever strategy reproduced the user's actual range.

Why it fails on real panes: `lastblock` would have selected only the final paragraph of Codex's
three-paragraph closing message, and on Claude it would have swallowed `✻ Worked for 28m 3s` and
any trailing chrome; `marker` would never have fired at all. The two-strategy counter was solving
a choice between two wrong answers.

Nothing survives into the current design. The gutter parser needs a complete, sampled harness
profile; a final-range selection alone cannot establish one safely.
