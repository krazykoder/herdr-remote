# Column parity and the line ruler

**Date:** 2026-08-09
**Status:** Part 1 **approved and implemented** (2026-08-09). Part 2 proposed, not scheduled.
**Phase:** P6. Part 1 shipped ahead of P5 at the user's direction.
**Implementation:** `.workflow/05_implementation/2026-08-09_column_parity.md`

Two requests came in together. They are the same problem seen from two ends, and the cheap
version of the second one only exists if the first is solved. That is the main finding here.

---

## The one root cause

`herdr pane read` returns scrollback **already hard-wrapped at the pane's column width**. Measured
against a live pane just now (`w11:p2`, 87 columns): no line exceeds 84 characters, in any of the
three sources. The backend is not sending logical lines. It is sending terminal rows.

The browser then wraps those rows *again*, at its own narrower width. Every agent line long enough
to matter becomes two or more visual rows, and there is nothing in the output distinguishing "the
agent broke this line" from "your phone broke this line".

That double wrap is request 1's complaint. It is also what makes request 2 expensive: once a
logical line can occupy an unknown number of visual rows, line index ↔ screen position stops being
arithmetic and starts needing per-line DOM.

---

## Part 1 — Column parity

### What herdr already gives us

`herdr pane layout --pane <id>` returns every pane's rect in cells:

```json
{"pane_id": "w11:p2", "rect": {"height": 48, "width": 87, "x": 114, "y": 1}}
```

`rect.width` **is** the column count. It is exact, it is free (measured: 4ms), and it needs no
guessing, no probing, and no config. It also changes when the user splits or resizes a pane, so it
must be read per request, never cached across snapshots.

`herdr pane read` also offers `--source recent-unwrapped`. Against the live pane it differed from
`recent` by one line in 400 — codex self-wraps well inside the pane width, so there was almost
nothing left for the terminal to wrap. It is not a substitute for knowing the width; it is a
refinement worth taking anyway, since it removes the one class of line that *was* wrapped by the
terminal rather than by the agent.

### What the browser needs

In a monospace font, CSS `1ch` is exactly one cell. So a container of `width: 87ch` with
`white-space: pre` reproduces the pane's geometry byte for byte. No wrapping, no reflow, no
approximation.

The font size that makes 87 columns fit a given width is:

```
fontSize = availableWidth / (cols × advanceRatio)
```

`advanceRatio` (advance width ÷ font size) is a constant per font, but **it must be measured at
runtime**, not hardcoded — the stack is `'SF Mono', 'Menlo', monospace` and which one resolves
depends on the platform. One hidden `<span>` of 100 zeros, measured once and re-measured on font
change, settles it.

With a typical ratio of ~0.6:

| Viewport | Usable width | Size to fit 87 cols | Readable? |
|---|---|---|---|
| iPhone portrait 390px | ~370px | **7.1px** | No |
| iPhone landscape 844px | ~824px | 15.8px | Yes |
| iPad portrait 1024px | ~1004px | 19.2px | Comfortably |
| Desktop 960px column | ~940px | 18.0px | Comfortably |

This is the honest finding: **on a portrait phone you cannot have both the agent's line breaks and
readable text.** 87 columns in 370 points is 4.2 points per column. No amount of engineering moves
that. Anything that claims otherwise is hiding a re-wrap somewhere.

So the answer is not one behaviour, it is a choice the user makes per their device:

### Three render modes

> **As built:** default is **True size**, persisted under `herdr_wrap_mode`, chosen from `Line
> width` in the pane gear menu. The user's iPhone sweet spot is a 9px terminal, which at a ~0.6
> advance ratio shows ~68 of an 87-column pane before panning.

| Mode | Behaviour | Where it wins |
|---|---|---|
| **Fit width** | Solve for the font size that makes `cols` fit. No horizontal scroll, no wrap. | Tablet, desktop, landscape phone |
| **True size** (default on phones) | Keep the user's chosen text size, `white-space: pre`, **horizontal scroll**. Line breaks are the agent's; you pan to read long ones. | Portrait phone, small text unusable |
| **Reflow** (today's behaviour) | Wrap at the viewport. | Reading prose output where the agent's exact geometry does not matter |

Reflow stays available and stays honest about itself: in that mode a continuation row gets a
left gutter mark, so a viewport wrap is visibly not an agent line break.

Mode belongs in the pane gear menu next to the two text-size controls, persisted under
`herdr_wrap_mode`, defaulting to **True size**.

### Protocol change

Minimal. `pane_content` gains one field:

```json
{"type": "pane_content", "pane_id": "w11:p2", "cols": 87, "content": "…"}
```

The relay's WS `read_pane` handler makes one extra `herdr pane layout --pane <id>` call (4ms) and
reads `rect.width` for that pane. Only for the pane the client is actually reading — not for every
pane in every snapshot. No new message type, no new direction, no change to any existing field.

`--source recent-unwrapped` replaces `recent` in the same handler.

### What this does not fix

Wide output — tables, diffs with long paths, box-drawing rules — is wide. Column parity makes the
app agree with the terminal about *where* the breaks are. It does not make an 87-column table fit a
phone. That is what True size + horizontal pan is for.

---

## Part 2 — The line ruler

### Why native selection fails here

iOS text selection is built for prose: character-granular, handles that land *on* the glyphs they
are selecting, and a magnifier that assumes the text is large enough to magnify usefully. At the
terminal's 6–13px, with a finger, all three assumptions break. The user cannot see the handle
because their thumb is on it, cannot land on the intended character, and does not want character
granularity in the first place — they want **lines**.

### The design

A **ruler**: a fixed 32px column pinned to the right edge of the terminal viewport, present
whenever a pane is open. It does not scroll; the content scrolls under it. Selection is a range of
**line indices**, never a character range.

```
┌────────────────────────────────────────────┬────┐
│  • Ran sed -n '1,220p' /Users/towshif/.co  │    │
│    │ skills/ponytail/SKILL.md; git status  │    │
│    └ ---                                   │ ═╤═│ ← top handle (44px target)
│ ▍  name: ponytail                          │  ┃ │
│ ▍  description: lazy senior developer      │  ┃ │   selected band
│ ▍  ---                                     │  ┃ │
│ ▍  # Ponytail                              │ ═╧═│ ← bottom handle
│                                            │    │
│    You are a lazy senior developer. Lazy   │    │
└────────────────────────────────────────────┴────┘
   ┌──────────────────────────────────────────────┐
   │  4 lines          Copy    Transfer →   ✕     │
   └──────────────────────────────────────────────┘
```

**Why the handles live in a column of their own** is the whole point: a finger dragging a handle
never covers the text it is selecting. That single property is what native selection cannot offer
and what makes this work at 6px.

### Why it is cheap — and why it needs Part 1

With `white-space: pre` and no wrapping, one logical line is exactly one visual row of known
height. Line index ↔ y is then pure arithmetic:

```
index = floor((clientY - contentTop + scrollTop) / lineHeight)
```

No per-line DOM. No `<div>` per row. No `Range` walking. The highlight is one absolutely-positioned
band whose `top` and `height` are computed from two integers, and the extracted text is
`lines.slice(a, b + 1).join('\n')` from the array the client already has.

Under reflow this collapses: a logical line spans an unknown number of rows, so index ↔ y needs a
measured DOM node per line, and 5000 lines of scrollback becomes 5000 elements re-created on every
poll. **The ruler is therefore only offered in Fit width and True size modes.** In Reflow mode the
ruler is hidden and native selection remains. That is a feature boundary, not a limitation to
paper over.

### Interaction

| Gesture | Result |
|---|---|
| Tap the ruler | Selects the single line at that y; handles appear |
| Drag a handle | Moves that end of the range; the other end stays pinned |
| Drag a handle past the viewport edge | Content auto-scrolls, range keeps growing |
| Drag *left* off the ruler while holding a handle | Fine mode: 4:1 gain, for picking one line out of a dense screen |
| Tap outside the ruler and band | Clears the selection |
| Handle dragged past the other | Ends swap, as every selection UI does |

While a handle is dragging, a bubble beside it shows that line's first ~40 characters. At 6px the
user cannot read the row they are landing on; the bubble is how they confirm it without needing
pixel precision.

When the range extends off-screen, the handle parks at the viewport edge with a small chevron
meaning "continues past here" — it never disappears, because a handle you cannot find is a
selection you cannot adjust.

The action bar is the existing dock pattern: `N lines` · Copy · Transfer → · dismiss.

### How it plugs into transfer

`openTransfer()` currently does:

```js
transferSelection = String(window.getSelection() || '').trim();
```

That becomes: use the ruler's range when one exists, fall back to `window.getSelection()`
otherwise. **One line.** Everything downstream — the instruction shortcuts, the 600-character
preview, the prefill-and-stop rule that never sends — is untouched. The ruler is a better input to
a flow that already works, not a new flow.

Pair transfer is the stated reason this feature exists, so that seam is the one that matters.

---

## Sequencing

1. **Part 1 first, alone.** It is small — one relay field, one CLI call, a mode setting and a
   measured font ratio — and it is independently valuable: the output stops disagreeing with the
   terminal. Ship it and use it for a while.
2. **Part 2 after.** It is the larger piece and it inherits its cheap implementation from Part 1.
   Building it first would mean building the expensive per-line-DOM version and then throwing it
   away.

Neither should start before P5 lands. P5 changes the shell's height model and adds
`viewport-fit=cover`, and the ruler is positioned against that shell.

---

## Open questions

1. **Does `pane layout` report the right width for a remote pane over SSH?** Assumed yes, same as
   `pane read`, but unverified — this needs one check against a live `HERDR_REMOTES` host before
   Part 1 is planned.
2. **Fit width when a pane is resized mid-session.** The font size would change under the user's
   feet. Re-solve on every snapshot, or only when the pane is opened? Leaning: re-solve, but only
   when `cols` actually changes, and never while a ruler selection is active.
3. **Does the ruler belong on desktop?** A mouse can select lines fine. Cheapest answer is to show
   it everywhere and let it be redundant on desktop rather than maintain two selection stories.
4. **`--format ansi` is available.** Colour would make the terminal far more readable, and is
   entirely separate from both of these. Worth its own proposal.
