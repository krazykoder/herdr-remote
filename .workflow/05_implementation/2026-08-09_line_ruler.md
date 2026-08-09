# Line ruler — implementation walkthrough

**Date:** 2026-08-09
**Proposal:** `.workflow/01_concepts/ideas/2026-08-09_column_parity_and_line_ruler.md` (Part 2)
**Depends on:** `.workflow/05_implementation/2026-08-09_column_parity.md` (Part 1)
**Status:** Implemented. Frontend only — no relay change, no protocol change.

## What changed

Selecting agent output on a phone was native iOS text selection: character-granular, handles that
land on the glyphs they select, and a magnifier that assumes the text is big enough to magnify. At
a 9px terminal all three fail. Pair transfer depends on that selection, so the feature it feeds was
only as good as a gesture that does not work.

The ruler replaces it with a **range of line indices**, driven from a column of its own.

## The one property that matters

The handles live in a 32px column to the **right of the text**. A finger dragging a handle
therefore never covers the line it is selecting. That is what native selection cannot offer and the
reason this works at 9px; every other decision here is downstream of it.

## Why it is cheap

Part 1 shipped `white-space: pre`, so one logical line is one visual row of known height. Line
index ↔ y is then arithmetic:

```
index = floor((clientY - contentTop + scrollTop - paddingTop) / lineHeight)
```

No per-line DOM. No `<div>` per row, no `Range` walking, nothing rebuilt on the 3s poll. The
highlight is **one** absolutely-positioned band whose `top` and `height` come from two integers,
and the extracted text is `paneRows.slice(a, b + 1).join('\n')`.

Under Reflow a logical line spans an unknown number of rows and all of that collapses — index ↔ y
would need a measured node per line, and 5000 lines of scrollback would mean 5000 elements
re-created every poll. **`rulerOn()` is therefore false in Reflow**, where native selection remains.
That is a feature boundary, not a limitation papered over.

## Structure

`.term-content` gained a positioned parent, `.term-wrap`, because the band and the ruler are
positioned against the viewport box rather than the scrolled content. The band lives *outside* the
scroller and is re-placed on every scroll event — one style write, against the alternative of
injecting an element into the content and having `el.textContent = next` destroy it on each read.

`placePairStrip()`'s `top` branch now inserts before `#termWrap`; `insertBefore` against a node that
is no longer a child of `.terminal-view` would throw.

| Element | Role |
|---|---|
| `#termWrap` | Positioning context; clips the band |
| `#ruler` | 32px column, `touch-action: none`, owns all pointer events |
| `#rulerTop` / `#rulerBot` | 44px targets painting a 6px bar |
| `#selBand` | The highlight; `right: 32px` so it stops at the ruler |
| `#selBubble` | First 40 chars of the line under the finger, while dragging |
| `#selBar` | `N lines` · Copy · Transfer › · ✕ |

**The ruler paints no background.** In True size the text pans underneath it, and a solid 32px strip
would hide a column of it. Only the track and the handles draw.

## Decisions worth naming

**Handles park, they do not leave.** When an end scrolls out of view its handle clamps to the
viewport edge and takes a `.parked` style. A handle you cannot find is a selection you cannot
adjust.

**Drag past the edge auto-scrolls** (60ms tick, one line per tick). Without it no selection can be
larger than one screen.

**Ends swap on release**, as every selection UI does. Mid-drag the dragged end keeps following the
finger even after crossing; `drawSel` normalises with min/max for display and the swap is committed
on `pointerup`.

**The bubble exists because 9px is unreadable under a thumb.** It is how the user confirms which
line they landed on without needing pixel precision.

**Copy has a fallback.** `navigator.clipboard` is undefined on a plain-http LAN origin, which is the
ordinary way this app is reached. The hidden-textarea + `execCommand('copy')` path is the one that
actually runs at home; the async API is the exception, not the rule.

**Transfer is hidden unless the pane is half of a pair.** A button that silently does nothing is
worse than no button.

## Selection drift — the part that is not obvious

`pane read` returns the **last N lines**. Every line the agent prints slides the whole window up, so
a selection held as two integers points somewhere else one poll later. Loading more scrollback
slides it the other way.

So the selection follows **its own text**, not its position. `reanchorSel(text, selText, a, b)` is
pure and lives in the tested block:

1. If the held indices still yield the same text, keep them. This is the common case and costs one
   slice.
2. Otherwise search for the block, accepting only **whole-line** matches — both a mid-line match and
   one that stops short of the line's end are a different selection that happens to share
   characters.
3. If it is gone, the selection is gone. That is the honest answer; a band left sitting on unrelated
   lines is worse than no band.

A block that repeats verbatim resolves to the first match. Distinguishing them would need an anchor
the pane does not give us.

## Transfer seam

```js
transferSelection = selText || String(window.getSelection() || '').trim();
```

One line. Everything downstream — the instruction shortcuts, the 600-character preview,
`composeTransfer`'s `SEND_TEXT_MAX` guard, and the prefill-and-stop rule that never sends — is
untouched. The ruler is a better input to a flow that already works, not a new flow.

## Verification

```bash
node --test tests/test_pairs.js                              # 43, +10 for reanchorSel
.venv313/bin/python -m unittest discover -s tests -t tests   # 142, unchanged
.venv313/bin/python tests/e2e/e2e_start_agent.py             # ALL PASS
```

`reanchorSel` covers: no movement, appended output, loaded scrollback, vanished text, a mid-line
match, a match stopping short of the line end, whole lines at the first and last position, repeated
blocks, an empty selection, and a blank line inside the block.

Static checks: tag balance via `HTMLParser`, CSS brace depth, the app script extracted and passed
through `node --check`, every `getElementById` target resolved against the markup, no NUL bytes, and
the page served from a live relay (`GET / → 200`, `id="ruler"` present).

The pointer handling itself is not automated — there is no browser in this environment. It is the
manual checks below.

## Manual checks

| # | Check | Expected |
|---|---|---|
| R1 | Open a pane in True size, tap the ruler | That one line highlights; both handles and the bar appear |
| R2 | Drag the bottom handle down | Range grows; the bubble names the line being landed on |
| R3 | Drag the bottom handle above the top one | Ends swap on release; the count stays right |
| R4 | Drag a handle to the bottom edge and hold | Content auto-scrolls, range keeps growing |
| R5 | Scroll the pane with a selection active | The band tracks its lines; a handle at the edge parks and dims |
| R6 | Let the agent print while a selection is held | The band follows its text upward, not its old position |
| R7 | Let the agent overwrite the selected lines | The selection clears rather than sitting on new text |
| R8 | Scroll to the top so more scrollback loads | The band follows its text downward |
| R9 | Tap Copy over plain http on the LAN | Button reads "Copied"; paste elsewhere matches the lines |
| R10 | With a healthy pair, tap Transfer › | The sheet opens prefilled with the ruler's lines, not the empty native selection |
| R11 | Without a pair | The Transfer button is absent |
| R12 | Switch to Reflow | Ruler, band and bar all disappear; native selection still works |
| R13 | Switch panes with a selection active | Selection is gone; nothing re-anchors into the new pane's lines |
| R14 | Change terminal text size with a selection active | The band still covers the same lines |
| R15 | Drag-select text natively with a mouse, then release | The ruler selection is not cleared by that click |

## Not in scope

**Fine mode** — the proposal's drag-left-off-the-ruler 4:1 gain for picking one line out of a dense
screen. Skipped: at 9px a line is ~13.5px, and the bubble already closes the feedback loop. Add it
if R2 proves fiddly in practice.

Character-level selection within a line, and multi-pane selection, remain out of scope. The ruler is
line-granular by design — that is what pair transfer wants.
