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
is followed by result-gutter lines and prose is not.

## Mechanism — gutter parsing, not text matching

One rule, identical for both harnesses:

1. A **block** starts at a line whose column-0 character is the harness's *speaker glyph*, and
   runs until the next column-0 glyph, footer, or full-width rule. Blank lines do not end a block
   — Codex's closing message is three paragraphs separated by blanks.
2. A block is a **tool execution** if any line in it starts (after indent) with a *result glyph*.
   `⏺ Bash(…)` always carries `⎿`; `• Ran …` always carries `└` or `│`. Closing prose never does.
3. The **final summary** is the last block that is not a tool execution.
   `start` = its glyph line. `end` = its last non-blank line.
4. No such block: no selection, no message.

Nothing above reads a word of the content. It reads column 0 and one character.

### Harness profiles — seeded, three characters each

| harness | speaker | result gutter | turn footer |
|---------|---------|---------------|-------------|
| `claude` | `⏺` | `⎿` | `✻ Worked for` / `✻ Baked for` |
| `codex` | `•` | `└` `│` | `─ Worked for` |

Keyed on `a.agent`, which the relay already sends.

## Unknown harnesses

1. The profile table covers the only two sampled harnesses: Claude and Codex.
2. An unknown harness gets no suggestion. A wrong tool-output selection is worse than no
   convenience.
3. A user-selected final block can reveal a candidate speaker glyph, but it cannot reliably reveal
   the result-gutter glyph: that glyph is outside the selected final block. One transfer therefore
   cannot safely teach a complete profile.
4. Add a profile only after collecting a real pane sample that contains both a tool block and a
   closing prose block. The profile remains two literal characters; no `localStorage`, model,
   content retention, or feedback UI is needed.

## Detection trigger

Runs after a `pane_content` update when `status === 'done'`, `selA === null`, and this pane-content
snapshot has not already been suggested. The in-memory suggestion key is `pane_id` plus the final
content line; it prevents the 3s poll from reselecting a range the user cleared. Never fight a
selection the user is holding. The existing `reanchorSel` keeps an accepted suggestion aligned on
later reads.

## UI

`selCount` gains the source: `12 lines · final message`. That is the entire visible surface. A
suggested range is an ordinary ruler range — drag it, tap the text to clear it (`:3937`),
transfer it.

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
| Learning the *end* boundary | End is the block's last non-blank line, which the block rule already gives. |

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

## Files

- `[MODIFY] web/index.html` — one `// --- Final message detection ---` block (profiles and block
  parse), a call site in the `pane_content` handler, in-memory suggestion state, one string in
  `drawSel`.
- `[NEW] tests/test_summary_detect.js` — vm-slice over that block, same trick as
  `tests/test_attention.js`.
- `[NEW] tests/fixtures/pane_claude_done.txt`, `pane_codex_done.txt` — the real pane reads above,
  verbatim. The fixtures are the spec; a glyph change breaks a test rather than a user.

Test cases: Claude fixture selects the `⏺ Sound half committed` block and excludes every `⎿`
line; Codex fixture selects `• S2b review clean` through `Next: S3 …` across two blank lines and
stops before `─ Worked for`; a pane ending in a tool execution selects nothing; an unknown
harness selects nothing.

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
6. Nothing on the wire changed.

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
