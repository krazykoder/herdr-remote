# Architecture Proposal — Desktop Mode

**Date:** 2026-08-09
**Scope:** `web/index.html` only.
**Classification:** **Class A** — feature-only. No WebSocket message type added or altered, no relay
state change, no new gate. Everything below is reachable with today's protocol.
**Status:** Proposal. Not a spec, not a plan. §9 lists what must be answered before either is written.
**Obeys:** `.workflow/02_architecture/2026-08-09_ui_shell_layout.md` §3 (the shell invariant) and
`decision_log/2026-08-09_app_shell_no_document_scroll.md`.

---

## 1. Problem

The app is a phone app that a desktop browser is allowed to open. On a 27" monitor it renders as a
960px column showing one pane at a time, and the two things a desktop user actually has — width and
a keyboard — are unused. Concretely:

1. Reading agent A while agent B works requires navigating away from A and losing the ruler
   selection, the scroll position, and the composer draft.
2. The agent list and the terminal are mutually exclusive views. On a phone that is correct. On a
   desktop it means every context switch is a full-screen transition and a re-read.
3. A Session Pair — the app's own model of "these two agents work together" — still shows one member
   at a time. Transfer prefills a composer the user cannot see while selecting the payload.

Desktop mode is not a new app. It is the same shell with a different arrangement of the same parts.

## 2. Proof of Discovery

| Finding | Location | Consequence for this proposal |
|---|---|---|
| `activePane` is a single global read directly by ~30 call sites | `web/index.html:1732`, and every `ws.send` in the file | The dominant cost of this change. §4 keeps every one of those call sites working unchanged |
| Per-pane state is six parallel globals: `paneLines`, `paneSource`, `paneCols`, `paneText`, `paneRows`, `paneStampAt` | 1732, 3277–3281, `openTerminal` 3217–3259 | These already *are* a per-pane record. There is one instance because there is one pane |
| `openTerminal` clears the previous pane's state field by field, with a comment per field explaining that it belongs to the pane it was made on | 3231–3236, 3256 | The record boundary is already documented in the code. Making it a record deletes the clearing, it does not add bookkeeping |
| One `refreshInterval`, cleared on every open to stop poller pile-up | 3218–3220, 3259 | Becomes one interval that reads every open column, not one interval per column |
| `pane_content` is answered to the requesting socket, keyed by `pane_id`; the client discards anything not matching `activePane` | `relay/herdr_relay.py:905`, `web/index.html:2188` | **Two concurrent reads already work on the wire.** The frontend filter is the only thing preventing it |
| `openTerminal` hides `agentListView`/`settingsView`/`timelineView` by inline `style.display` | 3225–3228 | A persistent sidebar means those toggles become conditional on layout. Inline display beats the `.active` class rule that is already dead (shell doc §2) |
| Desktop breakpoint exists at 768px; body capped at 960px / 1100px | 1290–1319 | The cap is deliberate for a reading column. Desktop mode must opt out of it, not raise it |
| `slotFor()` returns `wide`/`narrow` from `window.innerWidth < 768` | 3290 | Wrong input once a window holds two columns. §5.4 |
| Pairs are a frontend binding over two same-host live panes, with health recomputed per snapshot | `03_specs/2026-08-09_pairs_transfer_spec.md` §3 | The second column has a source of truth already. Desktop mode must not invent a second one |
| `tests/test_pairs.js` extracts only the block between the `// --- P3 pair logic (pure) ---` markers | `tests/test_pairs.js` | Untouched by this work. Do not move the markers |

**Invariants to preserve**

- Single self-contained file, no build step, all CSS/JS inline.
- The document never scrolls; every scrollable region is a flex child with `min-height: 0`.
- No layout depends on a hardcoded header pixel offset.
- Mobile and desktop share one height model; media queries adjust chrome and widths only.
- 44px touch targets survive on touch; `@media (pointer: fine)` may tighten them.
- The pair-logic markers.

## 3. Contract — one focus, many views

> **Exactly one pane holds focus at any time. Focus is what every write, every key, the ruler, the
> selection, the composer, and the clear-arm bind to. Additional columns render and poll; they do
> not receive input until they are focused.**

Binding for `web/index.html`. Consequences that follow and must not be re-litigated per feature:

- `activePane` continues to mean *the focused pane*. It is never a list. A feature that needs "the
  other column" asks the layout, not `activePane`.
- Focus changes are a single function. Nothing else may assign `activePane`.
- A control that acts on a pane reads it from the column it was rendered into, never from a global,
  once that control exists per column.
- Adding a column never changes the height model. Columns are flex children of the terminal view
  with `min-height: 0` and their own `overflow-y: auto`.
- Two columns is the ceiling for this phase. The protocol does not care; the ergonomics do — see §8.

**Why one focus and not two live composers.** The code already asserts, in six separate comments,
that a selection, a clear-arm, a source mode, and a timestamp belong to the pane they were made on.
Two focusable composers would multiply the ruler, the selection anchor, the key queue, the prompt
dock, and the transfer sheet by the column count, and every one of those is a singleton in the DOM
today. One focus keeps the entire input apparatus a singleton, which is why this lands as Class A.

## 4. The refactor this rests on

Six globals become one record; the globals become accessors on the focused record.

```
column := {
  paneId, el,              // el is the .term-content node for this column
  lines, source,           // read parameters
  cols, text, rows,        // last pane_content and its measurements
  stampAt                  // when it last changed
}
```

`columns` is an ordered array, length 1 or 2. `focusIndex` names the focused entry.
`activePane` becomes `columns[focusIndex].paneId`.

| Step | Change | Risk |
|---|---|---|
| 1 | Introduce the record; keep exactly one column. `activePane` and the six globals become one-line accessors over `columns[0]`. Behaviour identical, mobile untouched | Low. Mechanical, and `openTerminal`'s per-field clearing collapses into replacing the record |
| 2 | `pane_content` dispatches by `pane_id` to whichever column holds it, instead of comparing to `activePane` | Low. The relay already keys the reply |
| 3 | `refreshPane` iterates columns | Low. §7 covers the poll cost |
| 4 | Terminal view becomes a flex row; a second column can be appended | Medium — 20+ `getElementById('termContent')` call sites resolve against the focused column's `el` |
| 5 | Sidebar, focus model, keys, slot negotiation | The feature work. Everything above is a precondition |

Steps 1–3 are worth doing whether or not desktop mode ships. They delete state-clearing code and
make the `pane_content` handler say what it means.

## 5. Target layout

### 5.1 Desktop, two columns

```
┌───────────────┬─────────────────────────┬─────────────────────────┐
│ ● herdr   ⚙   │  Architect 1   ⌄ ⟳ CLS  │  Reviewer 2    ⌄ ⟳ CLS  │
├───────────────┼─────────────────────────┼─────────────────────────┤
│ BLOCKED       │                         │                         │
│  ▸ Reviewer 2 │  pane content           │  pane content           │
│               │  (focused: ruler,       │  (renders and polls,    │
│ WORKING       │   selection, sticky     │   dimmed header,        │
│  ▸ Architect1 │   scroll)               │   click to focus)       │
│  ▸ pi         │                         │                         │
│               │                         │                         │
│ IDLE          │                         │                         │
│  ▸ codex      ├─────────────────────────┴─────────────────────────┤
│               │ [P] composer — writes to the focused column       │
│ + Start       │ keys · prompts · quick actions · transfer         │
├───────────────┼───────────────────────────────────────────────────┤
│ 4 agents      │ updated 3s ago                        ● connected │
└───────────────┴───────────────────────────────────────────────────┘
```

One header row per column; one composer for the window. The unfocused column's header is dimmed and
its content is not interactive beyond scroll and click-to-focus.

### 5.2 Sidebar

The sidebar is `agentListView` in a narrower, always-visible form — the same `agentCard` render, the
same grouping, the same recents strip. It is not a second list implementation.

- Below 1200px: no sidebar, current behaviour, list and terminal remain mutually exclusive views.
- 1200px and above: sidebar visible, `openTerminal` no longer hides the list.
- The `body` max-width cap does not apply when the sidebar is present.
- Selecting an agent focuses it in the focused column. Modifier-select (or an explicit control on the
  card) opens it in the other column.

### 5.3 Where the second column comes from

Three sources, in the order a user will reach for them:

1. **A pair.** A pane in a healthy pair offers "Open pair side by side" — one action, both members,
   roles already named. This is the primary path and it is the reason pairs exist.
2. **Explicit split.** A control in the pane menu opens a picker of live same-host panes, the same
   candidate list the pair sheet already builds.
3. **Restore.** The column arrangement persists in `localStorage` under `herdr_layout`, versioned and
   discarded on mismatch exactly as `herdr_pairs` is. A pane that is no longer live restores as one
   column, never as an error.

Cross-host pairing stays out, matching the pair spec.

### 5.4 Slot negotiation follows the column, not the window

`slotFor()` currently asks whether the *window* is under 768px. With two columns a 1600px window
gives each pane an 800px column, and asking for `wide` fills it with a 139-column pane read that then
gets scaled down. The input becomes the column's own width:

| Columns | Column width | Requested slot |
|---|---|---|
| 1 | ≥768px | `wide` |
| 1 | <768px | `narrow` |
| 2 | either | `narrow` for both |

`set_slot` is already gated behind `HERDR_ENABLE_WRITE_EXT` and already reports failure as a
`command_result`. When the gate is off, columns still work — the panes are simply read at whatever
width the host gave them, which is the current behaviour for every phone.

## 6. Keyboard

Desktop's second affordance. The existing global key handler (3525) already owns a pair-switch
binding, so this extends one handler rather than adding another.

| Key | Action |
|---|---|
| `Ctrl/Cmd + [` / `]` | Move focus between columns |
| `Ctrl/Cmd + 1…9` | Focus the nth agent in the sidebar, in the focused column |
| `Ctrl/Cmd + Enter` | Send — already bound in the multiline composer |
| `Esc` | Close the topmost sheet, then unfocus the composer, then nothing. Never closes a column |

Closing a column is deliberate and mouse-driven. A keystroke that discards a scroll position and a
draft is a bug report waiting to happen.

## 7. Cost, and the one thing that needs measuring

Each `read_pane` costs the relay **two** herdr subprocess calls: the read itself, and `pane_cols`,
which re-reads the same lines with `--source recent` to measure the wrap column. That second call is
deliberately uncached (`herdr_relay.py:316` explains why). Today: 2 subprocesses per 3s per connected
client. Two columns doubles it to 4, and clients multiply it.

This is the only scaling question in the proposal and it belongs in the spec, not here. Three
candidate answers, in increasing order of effort:

1. Accept it. Two local subprocess spawns per 1.5s is not obviously a problem; measure before
   treating it as one.
2. Skip the `pane_cols` read when the returned content is byte-identical to the last one — an idle
   pane then costs one call instead of two, and a pane cannot change width without changing content.
3. Poll the unfocused column at a longer interval than the focused one.

**Do not pick one here.** Measure first: `time` a `pane read` against a live pane on the target host,
and count the calls a two-column session actually makes over a minute.

## 8. Explicitly out of scope

| Excluded | Why |
|---|---|
| Three or more columns | Nothing in the protocol objects. A third pane read at ~46 columns is unreadable, and the composer's "which column am I writing to" ambiguity grows faster than the value |
| A draggable splitter | 50/50 covers the case. A splitter is a stored ratio, a resize observer, and a slot renegotiation on every drag |
| Two live composers | Would multiply the ruler, selection, key queue, and prompt dock by the column count. §3 |
| Separate browser windows | `localStorage` and one WebSocket per window; two windows means two polls of the same pane and no shared focus |
| Auto-following a blocked agent into a column | The pair spec already rejects auto-following on state. Same reasoning: the user loses their place without asking to |
| Any relay change | Keeps this Class A. If the spec finds it needs one, the classification changes and this document is amended, not quietly widened |

## 9. Open questions — must be answered before the spec

1. **Sidebar breakpoint.** 1200px, or a user toggle that persists? A 1280px laptop with a sidebar
   leaves ~1000px for two columns, which is ~69 host columns each after chrome — exactly one narrow
   slot, and workable. Below that, the sidebar costs more than it gives.
2. **Does the second column poll while the browser tab is hidden?** Today one pane does. Two panes
   in a background tab doubles a cost nobody is looking at. Recommend pausing all polling on
   `visibilitychange` — which is a fix worth making for one column too.
3. **Does the composer show which column it writes to, or does the focused column show it?** A ring
   on the focused column is cheaper and less noisy than a label on the composer. Needs a look at the
   real thing.
4. **Transfer with both members visible.** The pair spec's transfer sheet exists so the user reads
   the payload before it sends. With the target composer on screen, is the sheet still the right
   flow, or does select → shortcut prefill the visible composer directly? This is a spec-level
   change to P3 behaviour and needs an explicit decision, not a default.
5. **Mobile landscape.** A 900px-wide phone in landscape passes a width test and fails a usability
   one. Recommend gating desktop mode on `@media (pointer: fine)` as well as width.
