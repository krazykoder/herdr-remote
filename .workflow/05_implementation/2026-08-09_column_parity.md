# Column parity — implementation walkthrough

**Date:** 2026-08-09
**Proposal:** `.workflow/01_concepts/ideas/2026-08-09_column_parity_and_line_ruler.md` (Part 1)
**Status:** Implemented. Part 2 (line ruler) not started.

## What changed

`herdr pane read` returns scrollback already hard-wrapped at the pane's column width. The browser
then wrapped those rows a second time at its own width, so no line break in the app could be
attributed to the agent rather than to the viewport. The client now knows the pane's true width and
lays out to it.

### Relay

**`pane_cols(pane_id, remote=None)`** — new. Runs `herdr pane layout --pane <id>` and returns the
matching pane's `rect.width`, or `None`.

It matches **by `pane_id`, not by position**. `pane layout` lists every pane in the tab, so taking
the first would silently lay the output out at a sibling's width — against a real split that is 88
where the answer is 87. Every failure mode returns `None`: bad JSON, pane absent from the layout,
missing `rect`, a non-integer width, or a width ≤ 0. A wrong width is worse than no width, because
the client lays out confidently to whatever it is given.

Read per request. Splitting or resizing a pane changes it mid-session.

> **Superseded 2026-08-09 — `pane layout` is not the PTY.** `rect.width` describes herdr's *layout
> model* of an attached client's window, not the pseudo-terminal the agent writes into. With no
> client attached herdr models a default 80×24 window with a 26-column sidebar and reports
> `width: 54` for every pane on the host, whatever their real size; the value also lags a pane that
> was resized after it was created. Observed on a live pane whose recent output demonstrably wrapped
> at 138 while this function returned 54 — the client then solved `fit` for a pane less than half the
> real width, which is the "terminal is half width" report that found this.
>
> The signature is now `pane_cols(pane_id, lines, remote=None)` and the width is **measured**:
> `pane read --source recent` returns the same scrollback `recent-unwrapped` does with the
> terminal's own breaks left in, so the longest line in it *is* the column those breaks were made
> at. No `pane layout` call remains anywhere in the relay.
>
> The sample is bounded to the same `lines` the client asked for, deliberately. A pane that has been
> made *narrower* still holds wider rows further back in its scrollback, and a deeper sample would
> find one and lay the visible text out too wide. Bounded this way the function can only ever
> under-report — when nothing in the sample wrapped — and an under-report is harmless: nothing was
> wrapped, so nothing is laid out wrongly and the text is merely scaled larger than it had to be.
> Empty output or blank lines still return `None`. Call count is unchanged: one read replaced one
> layout.

**WS `read_pane` handler** — two changes:

- `--source recent` becomes `--source recent-unwrapped`, which drops the line breaks the terminal
  itself inserted and leaves only the ones the agent wrote.
- `pane_content` carries `"cols"`. One field on an existing message; no new type, no new
  direction, nothing existing altered.

One extra CLI call per read, measured at 4ms, and only for the pane the client is actually reading
— not for every pane in every snapshot.

The polling `read_pane()` used for snapshot previews is untouched: it strips chrome and keeps the
last 20 lines for the agent card, and is never rendered as terminal output.

### Web

**Three modes**, in the pane gear menu under `Line width`, persisted as `herdr_wrap_mode`,
defaulting to `true`:

| Value | Class | Behaviour |
|---|---|---|
| `true` | `.wrap-pre` | `white-space: pre`, horizontal scroll. The agent's breaks, at the user's text size. |
| `fit` | `.wrap-pre` | Same, but the font size is solved so `cols` fits with no horizontal scroll. |
| `reflow` | `.wrap-reflow` | The old behaviour, wrapped at the viewport. |

**Reflow is marked.** A hanging indent (`text-indent: -2ch` with matching left padding) means a
continuation row is visibly indented, so a wrap the phone inserted never reads as a line the agent
wrote. This is what keeps the fallback mode honest rather than merely tolerated.

**`measureCellRatio()`** measures the cell advance as a fraction of font size, from a hidden
100-zero probe at 100px. Measured, not hardcoded: the stack is `'SF Mono', 'Menlo', monospace` and
which one resolves depends on the platform. A zero result falls back to 0.6 rather than dividing by
zero downstream.

**`applyWrapMode()`** toggles the class and, in `fit`, sets an inline
`font-size = (clientWidth - 20) / (cols × cellRatio)`, floored at 4px. Below that the text is a
texture, and rendering it silently would look like a bug rather than like the pane being too wide
for the screen.

**`syncFontButtons()`** is the single owner of the two terminal `A−`/`A+` disabled states. In `fit`
the size is computed, so the manual control has to read as unavailable rather than appear to work
and do nothing. Both `setFont` and `applyWrapMode` route through it.

Re-applied on three events: `cols` differing from the last read (a split or resize mid-session),
opening a pane (`paneCols` reset to `null` first — a new pane's width is not the old one's), and
`resize` (rotation changes the solve in `fit`).

`#wrapHint` states the pane's column count, and in `fit` the size it solved to. When the relay
reports no width it says so, rather than leaving the user to guess why a mode looks inert.

## The number that does not move

An 87-column pane in ~370 usable points is **4.2 points per column**. There is no font size that is
both readable and fits, which is why this is three modes rather than one behaviour. At the user's
stated 9px iPhone sweet spot and a ~0.6 advance ratio, True size shows ~68 of 87 columns before
panning.

## Verification

```bash
.venv313/bin/python -m unittest discover -s tests -t tests   # 142, +9 for pane_cols
.venv313/bin/python tests/e2e/e2e_start_agent.py             # ALL PASS
node --test tests/test_pairs.js                              # 33
```

`tests/test_pane_cols.py` covers the width, id-not-position matching, absent pane, non-JSON, empty
output (the shape of every `run_herdr` failure), missing `rect`, zero/negative, non-integer, and
remote pass-through.

The fake herdr gained a `pane layout` branch returning **two panes of different widths**, so a
client that picks the wrong one is visibly wrong rather than accidentally right.

Live socket probe against the fake relay:

```
pane_content pane=w1:p1 cols=87
local pane layout --pane w1:p1
local pane read w1:p1 --lines 30 --source recent-unwrapped
```

> **Superseded 2026-08-09, with the measurement change above.** `tests/test_pane_cols.py` was
> rewritten around the wrap column: it asserts the width survives a short final line (every read
> ends in a partial one), that trailing padding is not counted as width, that a *widened* pane
> reports its new width rather than the old one — the 54-then-138 regression itself — that the read
> is bounded to the lines the client asked for, and that it reads `recent` rather than
> `recent-unwrapped`, which would drop the very breaks being measured. The fake herdr's
> `pane layout` branch is gone, replaced by a `pane read` branch emitting hard-wrapped rows at a
> known width. The e2e suite gained **W1**, asserting `pane_content.cols == 87` and that no
> `pane layout` call is made at all — the gap that let this ship.

## Manual checks

| # | Check | Expected |
|---|---|---|
| C1 | iPhone, 9px, True size, open a wide pane | Long lines run off the right and pan; no re-wrap |
| C2 | Same pane, switch to Fit width | Text shrinks until the full width fits; no horizontal scroll |
| C3 | In Fit width, try `A−`/`A+` | Both disabled; the hint names the solved size |
| C4 | Switch to Reflow | Lines wrap, and every continuation row is indented under its parent |
| C5 | Rotate the phone in Fit width | The size re-solves for the new width |
| C6 | Split the pane in herdr while it is open | Within one poll the width and layout follow |
| C7 | Open pane A then pane B, different widths | B never lays out at A's width |
| C8 | A relay that reports no width (old relay, or a failing CLI) | The hint says so; True size and Reflow still work, Fit falls back to the chosen size |
| C9 | Compare a wide table against the real terminal in True size | Same line breaks in the same places |

## Not in scope

Wide output is still wide — column parity makes the app agree with the terminal about *where* the
breaks are, not fit an 87-column table on a phone. `--format ansi` (colour) remains its own
proposal. Part 2, the line ruler, is unstarted and inherits its cheap implementation from the
non-wrapping modes shipped here.
