# Pane slots — spawning and adjusting a pane to the screen reading it

2026-08-09

## Problem

A session spawned from the phone came up at the full tab width — 139 columns — and the web app
scaled every glyph down to fit them on a 370px screen. Column parity (P6a) made the text *correct*
at that width; it could not make it *readable*. The pane itself had to be narrower.

## Why a slot and not a resize

herdr's `pane resize --amount` is a ratio of the tab area, not a column count, and the next split
in that tab discards it. Measured on this display: a lone pane is 139 wide, `--amount 0.1` takes it
to 125 and then 111, and a resize on a pane that is alone in its tab is a no-op. Nothing about that
composes into "make this pane 69 columns".

What *is* stable is pane count. herdr gives a pane the whole area when it is alone in its tab and
divides the area evenly otherwise. So there are exactly two widths worth naming:

| Slot | Layout | Columns here |
|------|--------|--------------|
| `wide` | alone in its tab | 139 |
| `narrow` | sharing its tab with one sibling | 69 |

69 columns is the phone target: 370px ÷ (0.6 × 9px) ≈ 68.5. That the two slots land on the two
screen sizes is why this is a slot mechanism and not a width setting.

**The tab area itself is not ours to set.** It is herdr's model of the attached client's window —
your terminal. `workspace create` and `tab create` take `--cwd`, `--label`, `--env`, `--focus` and
nothing else. Widen the terminal and both slots widen with it.

## The spacer

herdr has no placeholder pane. A pane is a PTY, so the thing occupying the other half of a narrow
slot is a live shell sitting at a prompt.

It is created by `pane split --direction right` (no `--focus` — the point of the pane is to occupy
columns, and focusing an empty shell is the opposite of what the user clicked for), then relabelled
to `SPACER_LABEL` immediately.

That label is the disposal contract. `is_spacer` requires **both** no agent and that exact label:

- no-agent alone would close a shell the user split themselves and left a build running in
- the label alone would let a rename turn any live session into something closable

A spacer that fails to get its label is stranded rather than mis-collected — the safe direction.
Spacers are never moved or reused; they are created and closed in place.

## Plan

`plan_slot(panes, pane_id, slot)` in `relay/start_agent.py` is pure: it takes a whole `pane list`
and returns an ordered list of argv tuples. Nothing is read or run there, so every branch is a unit
test.

It needs the *unfiltered* pane list. `get_agents_from_host` drops panes with no agent, which is
precisely what a spacer is — so `slot_exec` reads `pane list` itself rather than using the poll
snapshot.

| From | `wide` | `narrow` |
|------|--------|----------|
| alone | nothing | `pane split` |
| one spacer sibling | `pane close` the spacer | nothing |
| one live sibling | `pane move --new-tab` | nothing |
| crowded, all spacers | close them | move out, close them, split |
| crowded, some live | move out | move out, split |

`wide` closes a spacer rather than moving out of the tab: both widen the pane, but moving leaves a
tab holding a shell nobody asked for. Conversely a live sibling is never closed — the pane leaves
instead, which costs that sibling nothing.

No rollback on a failed step. Each step is a layout change that stands on its own; undoing a
half-applied plan means guessing which half.

## Wiring

- `set_slot` — `{pane_id, slot}`, gated on `HERDR_ENABLE_WRITE_EXT`. Unlike `rename_pane`, this one
  *is* behind the gate: a narrow slot is made by splitting, and a split starts a shell. That is
  process creation, which is what the flag governs.
- `start_agent` takes an optional `slot`, applied after the agent is up and **never fatal** — the
  session is usable at whatever width the placement gave it, and failing the start would roll back
  a working agent over a layout preference.
- The web app sends `slotFor()` — `innerWidth < 768 ? 'narrow' : 'wide'` — on spawn, and from
  "Fit pane to this screen" in the pane menu. Not on `placement: 'split'`: "beside that pane" is
  already a statement about width, and a desktop asking for `wide` would move the new session
  straight back out of the split the user picked.
- After a slot change the client waits 600ms and re-reads. `pane_cols` measures the pane's own
  scrollback, so the new width only appears once the pane has redrawn at it — one late read beats
  laying text out at a column count herdr may not have agreed to.

## Verified

| Where | What |
|-------|------|
| `tests/test_start_agent.py` | 12 tests over `plan_slot`'s branches and the start-request `slot` field |
| `tests/test_slot_exec.py` | 10 tests over the applied plan: that the spacer is labelled with the id the split returned, that a failed step stops the ones after it, that a planning refusal never reaches herdr, that every call goes to the pane's own host |
| `tests/e2e/e2e_pane_slots.py` | The real herdr, in a throwaway workspace, calling `slot_exec` itself |

The unit tests assert argv. Only the E2E can assert herdr's *geometry contract* — that a lone pane
owns the area, that a split halves it, that closing a sibling hands the columns back — which is
what a herdr release could change under this feature. Run it after an upgrade.

```
baseline       area=144  p1=144
narrow         area=144  p1=72 | p2=72   (p2 carries the spacer label)
narrow again   area=144  p1=72 | p2=72   (no compounding)
wide           area=144  p1=144          (spacer closed, not parked in a tab of its own)
crowded, hand-split and so unlabelled
narrow         area=144  p1=72 | p5=72   (moved out; nothing of theirs closed)
```

That run reads 144 where an earlier one read 139: the terminal window had been resized between
them. The slot follows the area with no code involved, which is the whole reason the feature
counts panes instead of columns.

Full suite: 173 Python tests, 43 JS tests, both E2Es.

## Not done

- The 768px breakpoint is the browser's guess at "phone". A pane adjusted on a phone stays narrow
  when opened from a laptop until someone hits Fit again — deliberate, since the pane is shared
  state and a viewport is not a claim on it.
- Nothing reaps a spacer whose agent pane went away by some other route. It shows up as a labelled
  shell in an otherwise empty tab, and the next `narrow` in that tab clears it.
