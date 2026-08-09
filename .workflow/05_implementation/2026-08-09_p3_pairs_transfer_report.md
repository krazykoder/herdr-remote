# Implementation Report — P3: Session Pairs and Transfer

**Date:** 2026-08-09
**Branch:** `main` — `5f0c335` (feature), `6278236` (review changes), `bd7e119` (error surfacing),
`15f8c47` (switch naming), `bde3562` (docs)
**Spec:** `.workflow/03_specs/2026-08-09_pairs_transfer_spec.md`
**Preflight:** Bracketed paste **PASS**, 2026-08-09 — dev-notes §6.4
**Classification:** Class B — additive protocol extension
**Status:** Complete. A1–A18 pass.

---

## 1. What shipped

Pin two live same-host panes as a pair, jump between them, and move a selection from one agent's
pane into the other's composer with the payload prefilled for review.

| File | Diff | Role |
|---|---|---|
| `web/index.html` | **+447** | Pair model, editor, strip, switch, transfer, rename, toast, composer |
| `tests/test_pairs.js` | **new, 206** | 24 tests over the pure half, run by `node --test` |
| `relay/herdr_relay.py` | **+40 / −4** | `send_text` cap, `rename_pane`, unknown-type reply |
| `relay/start_agent.py` | **+19** | `validate_pane_label` |
| `tests/test_start_agent.py` | **+31** | 6 label tests |

The pair is a frontend binding, not a channel. It lives in `localStorage` under `herdr_pairs`;
the relay has no pair message and stores no pair data.

### Health is the load-bearing part

Recomputed from every snapshot, checking all four fingerprint fields — `pane_id`, `host`, `agent`,
`cwd`. herdr reuses a `pane_id` after a pane closes, so `pane_id` alone would match a different
session and the UI would offer to paste into a stranger. A stale pair loses its transfer **and**
switch controls entirely rather than disabling them.

### Testing a single-file app without a build step

`web/index.html` is deliberately self-contained, so there is nothing to import. The pure logic sits
between two markers and `tests/test_pairs.js` extracts it and evaluates it in a `vm` context. Two
tests earn their keep beyond the obvious: one asserts the frontend and relay caps agree, and the
`vm` context has **no `crypto` at all**, so the `randomUUID` trap below cannot come back.

---

## 2. Verification

### Against real herdr

- Rename applied and read back **from herdr**, both directions (`Architect 1` → `Reviewer 9` →
  restored), surviving a full poll cycle — which only happens because herdr holds the label.
- All three label refusals fired: empty, over 32 characters, control characters.
- Switch moved panes by button and by ⌘/Ctrl+Shift+P; both absent on a stale pair.
- Composed payload carried the instruction, `feedback from Architect 1:`, and no fence.
- Over-cap refusal fired on a real selection: 4063 characters, refused with its size, nothing sent.
- Name fallback chain: `Architect 1` → `charts.TS` → `codex`, and `paneTitle` degrades to
  `charts.TS · claude`, then to the pane ID.

### Suites

123 Python, 24 node, 39/39 E2E, `git diff --check` clean. No edit to `agent_state.py`,
`herdr_tui.py`, `herdr_telegram.py`, `herdi-mac/`, or `herdi-ios/`.

---

## 3. Defects found and fixed during implementation

| Found | Fix |
|---|---|
| `crypto.randomUUID()` is `undefined` in a non-secure context — the relay serves this page over plain HTTP on a LAN address, so pairing would have broken on phones and worked on localhost | `Math.random().toString(36)` |
| Pair sheet text inputs rendered **white** on the dark theme — only `select` was styled | `.start-field input` added |
| Prefilled composer opened scrolled to its **tail** | `setSelectionRange(0,0)` and `scrollTop = 0` |
| Stale reason truncated to `is no lo…` | Reason moved to its own line |
| Replacement warning coloured as a failure | Orange, not red |
| Switch button showed the name captured at **pin time**, so renaming a pane left a stale name on the control that navigates to it | Resolved from the live snapshot, falling back to pinned name, then pane ID |

---

## 4. Two silent failures, one visible symptom

Reported as "rename does not persist across refresh". It was two faults stacking, and neither was
the rename:

1. **The relay answered nothing.** The message-type chain ended with no `else`, so a client newer
   than the relay got silence. Every running relay is older than the client until it restarts.
2. **The web app had no `{type:'error'}` handler at all.** Every refusal the relay has ever sent
   was dropped on the floor — `pane_guard` rejections included, which long predate this phase.

The browser then painted the new label optimistically, and the next 3-second poll undid it.

Fixed on all three counts: the relay logs and answers unknown types saying it may be older than
the client, errors raise a toast, and `rename_pane` applies its label only on confirmation —
matching how `start_agent` already waits for its `command_result`.

**The lesson worth keeping: the optimistic update is what made a total failure look like a partial
one.** Had the browser waited, the missing handler would have shown up the first time.

---

## 5. Deviations from the spec

**1. The fence was removed** (§4.2), at the user's direction, after implementation. It was the
receiving agent's only boundary marker for the quoted region, so a transferred line reading
`Proceed to implement.` now reads the same as an instruction the user typed. Containment is now
entirely the human step: the user chooses the selection and reads the prefilled composer. A test
asserts the *absence*, so reintroducing a delimiter stays deliberate. Recorded in the spec as a
security tradeoff rather than dropped quietly.

**2. `rename_pane` is a new message type**, which the spec had ruled out of phase — "if a change
requires a new message type, it is out of scope — say so and stop." Added on request; the crossing
is written into the spec rather than the scope quietly widened. It is **not** behind
`HERDR_ENABLE_WRITE_EXT`: that gate exists for spawning processes, and relabelling an existing pane
is weaker than `send_text` and `send_keys`, which are already open. Gating it while leaving those
open would be theatre. `validate_pane_label` bounds it at 1–32 characters with no control
characters, since the label becomes an argv entry and lands in herdr's status line.

**3. Renaming goes through herdr**, not a browser-local alias. An alias would disagree with the
herdr pane list and with the `Architect N` labels a started session receives, leaving one pane with
three names.

**4. Attribution is the display name alone.** The receiving agent is told which colleague sent the
text, not which tool produced it. Pair names default to the pane's own label for the same reason:
two panes both called `claude` distinguish nothing.

---

## 6. Behaviour changes to be aware of

1. **Enter no longer sends.** The composer is a `<textarea>`; Enter inserts a newline and
   ⌘/Ctrl+Enter sends. Deliberate — a prefilled multi-line payload that submits on the first Enter
   defeats the review checkpoint the feature exists for. It reverses a daily reflex.
2. **A relay restart is required.** The 4000 cap, `rename_pane`, and the unknown-type reply all
   live in `relay/`. `web/` changes need only a tab reload; `relay/` changes do not.
3. **Relay refusals are now visible** as a toast, across the whole app, not only for this phase.
4. **Panes display as `project · agent · name`** everywhere, dropping absent parts. The card's
   second line no longer repeats the agent.

---

## 7. Open items

| # | Item | Blocks | Owner |
|---|---|---|---|
| 1 | **Nothing is pushed.** `origin/main` is 37 commits behind and carries all of P1, P2 and P3. | — | User |
| 2 | **The Pages deploy workflow was removed** in `271bda8` (`.github/workflows/pages.yml`, untracked by the user). Pushing `main` no longer deploys `web/` by itself — confirm how the web app is meant to reach Cloudflare Pages before relying on a push to publish it. | Deploy | User |
| 3 | **Real *remote* smoke start still untested** (P2 open item 1). No `HERDR_REMOTES` on this machine; remote routing evidence is still the fake-ssh harness. | — | User |
| 4 | Smoke workspace `wB` is still open with a live claude — `herdr workspace close wB`. | — | User |
| 5 | Promotion of the Projects/Pairs docs from `07_dev_notes/` to `02_architecture/`. | — | User |
| 6 | Pair sync across devices stays deferred (dev-notes Q5) until named local pairs prove useful. | — | — |

---

## 8. Post-report changes

Written after §1–§7, from review of the shipped UI.

**Two safety gaps closed.**

1. **Recents stored a bare `pane_id`.** herdr reuses pane IDs, so a chip could open a session the
   user never visited — the same failure the pair fingerprint exists to prevent, reintroduced by a
   convenience list. Recents now store the full fingerprint and are matched with `memberMatches`.
   Version-one entries are dropped rather than migrated: a convenience list is not worth an unsafe
   migration.
2. **Transfer trusted health computed at the last poll.** A pane could die inside that window and
   the prefill would target it. `doTransfer` now rechecks `pairHealth` immediately before it
   prefills, and a test asserts the recheck is present in the source.

**Three UI changes, at the user's direction.**

3. **Recents moved below the Projects chips** — the chips choose a scope and recents jump inside
   it, so scope reads first. `#agents` innerHTML is rewritten on every poll, which detaches the
   node, so it is held by reference and re-placed each render rather than re-queried. With no
   Projects configured there is no strip and it falls back above the list.
4. **The pair sheet shows the full `project · agent · name`** for its header and every candidate,
   matching the cards. Role fields still default to the bare label: that string lands in
   `feedback from …:` in the payload, where the full form is noise.
5. Spacing bug found while doing 4 — `Architect 1· in "Cross check"` had no space, because the
   candidate button is a flex container and whitespace between children collapses.

### Renaming a pane does not rename its tab

Asked during review. `rename_pane` calls `herdr pane rename`, which sets the **pane** label; the
herdr tab bar draws **tab** labels (`herdr tab rename <tab_id>`). They are different objects and
not one-to-one — `wB:p1` and `wB:p2` share tab `wB:t1` — so driving a tab rename from a pane rename
would silently relabel a sibling pane. A pair member is a pane, so the web app shows the pane label.
Driving tab labels too would need a new message type and a rule for shared tabs.

### Pairs do not survive clearing site data

Also asked. Expected: `herdr_pairs` is `localStorage`, browser-local and **origin**-local. Two
consequences worth knowing — pairs do not follow a laptop to a phone, and reaching the relay on a
different origin (`127.0.0.1`, a LAN address, the tunnel hostname) gets a separate set. Spec §2 puts
any relay-side pair record out of scope and dev-notes Q5 defers sync; persisting them would mean
relay-side storage behind `HERDR_RELAY_TOKEN`, since a pair names panes on the user's machine.

---

## 9. What this phase did not touch

No pair record, prompt seeding, or cross-host pairing reached the relay. No auto-relay: every A→B
hop still has a human at the checkpoint. `SAFE_KEYS` is unchanged — the preflight PASS removed the
only reason P3 would have touched the protocol, and the one message type that was added is
unrelated to transfer.
