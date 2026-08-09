# Spec — P3: Session Pairs and Transfer

**Date:** 2026-08-09
**Source:** `.workflow/07_dev_notes/2026-08-08_projects_and_session_pairs.md` §3, §6, §7.2
**Depends on:** P1 (grouping, `pane_guard`). P2 is optional — a pair works on any two live panes.
**Preflight:** Bracketed paste **PASS** (2026-08-09, dev-notes §6.4). One `send_text` carries the payload.
**Status:** Implemented — `web/index.html`, `tests/test_pairs.js`, `relay/herdr_relay.py`, `relay/start_agent.py`.

---

## 1. Goal

Move a selection from one agent's pane into another agent's composer, with the user reading the
exact payload before it sends. A **Session Pair** is the saved shortcut that makes "the other one"
a single tap instead of a navigation.

The pair is a frontend binding, not a channel. It does not move text — §4 does.

---

## 2. Scope boundary

| In | Out |
|---|---|
| `localStorage` pairs, pair editor, pair health | Any relay-side pair record or pair protocol |
| Transfer: select → shortcut → prefill partner's composer | Auto-send, auto-relay, any A→B hop without a human |
| Multiline composer, Ctrl/Cmd+Enter to send | Changing how `send_text` reaches herdr |
| `send_text` cap 1000 → 4000 | Any other relay behaviour |
| Instruction shortcut buttons | Prompt copy authored by the implementer — paths only |
| Switch-to-partner control and key binding | Auto-following the partner, or switching on its state |
| `rename_pane` (added mid-phase, see below) | A frontend-only display alias |

**Two relay-side changes exist in this phase.** The cap constant, and `rename_pane` — a new
message type, added at the user's explicit request after implementation began. The original
boundary said a new message type meant stopping; recording the crossing rather than quietly
widening the scope. It is **not** behind `HERDR_ENABLE_WRITE_EXT`: that gate exists for spawning
processes, and relabelling an existing pane is strictly weaker than `send_text` and `send_keys`,
which are already open. Gating it while leaving those open would be theatre. The label is bounded
by `validate_pane_label` (1–32 chars, no control characters) because it becomes an argv entry.

Renaming goes through herdr, not a browser-local alias. An alias would disagree with the herdr
pane list and with the `Architect N` labels a started session receives, leaving one pane with
three names.

---

## 3. Pair model

### 3.1 Storage

One versioned `localStorage` key, `herdr_pairs`, matching the app's existing `herdr_*` convention:

```json
{"version": 1, "pairs": [{
  "id": "p_a1b2c3d4", "name": "Architecture review",
  "members": [
    {"pane_id": "w8:p1", "host": "local", "role": "architect", "agent": "claude", "cwd": "/Users/t/code/herdr-remote"},
    {"pane_id": "w8:p2", "host": "local", "role": "reviewer",  "agent": "codex",  "cwd": "/Users/t/code/herdr-remote"}
  ]}]}
```

`agent`, `cwd`, `host` are the **identity fingerprint**, captured at pin time. Not display data —
they exist to detect pane-ID reuse. `role` is a display label defaulting to the agent name,
renameable; it appears in the payload attribution (§4.2) and never reaches a shell.

An unreadable or wrong-`version` value is discarded and replaced with an empty set. A corrupt blob
must not brick the terminal view.

### 3.1a Pair editor

Each agent card has a **Pair** control. Clicking it opens a small Pair sheet listing live partner
panes on the same host, excluding only the source pane. Existing pair membership is shown beside a
candidate name. Selecting a partner shows three editable fields before save:

- Pair name, default `<source label> ↔ <partner label>`, each falling back to its agent name when
  the pane carries no label; required, maximum 64 characters.
- Source display name, defaulting to the source pane's own label.
- Partner display name, defaulting to the partner pane's own label.

The agent name is a poor default here: two panes both called `claude` tell the reader nothing
about which colleague sent the text.

Save generates the pair `id` as `'p_' + Math.random().toString(36).slice(2, 10)`, captures both
fingerprints, persists the pair, and closes the sheet. Not `crypto.randomUUID()` — it is `undefined`
in a non-secure context, and the relay serves this page over plain HTTP on a LAN address, which is
exactly how a phone reaches it. The ID only needs to be unique among at most 32 local entries. If either candidate already belongs to a pair, the sheet instead shows
that pair's name and requires a replacement confirmation; saving removes the old pair before adding
the new one. Cross-host candidates are not listed, and a 32-pair limit disables save with its reason.

The terminal header shows the pair name and member roles for the active pane, with **Edit** (same
sheet) and **Unpair** controls. Pairing is never inferred from workspace, tab, Project, role label,
or agent name.

### 3.2 Health, recomputed from every snapshot

| State | Condition | Effect |
|---|---|---|
| `healthy` | Both members match one live agent on `pane_id`, `host`, `agent`, **and** `cwd`, and neither `pane_id` is duplicated in the snapshot | Transfer offered |
| `stale` | Any member unmatched, or its `pane_id` appears twice | Pair greyed, transfer control **absent**, reason shown |

Neither state deletes the pair — a stale pair recovers when its pane returns.

> **Load-bearing property: the UI must never offer to paste into a pane other than the one the
> user pinned.** All four fingerprint fields are checked because `pane_id` alone is reused by herdr
> after a pane closes. A matching `pane_id` with a different `cwd` is a different session.

### 3.3 Limits

- Exactly 2 members, **same host** — cross-host pairs refused at creation. A bare `pane_id` cannot
  be routed unambiguously across hosts (P1 G7), and a pair that silently retargets another machine
  is the worst failure this feature can produce. Lifts free when identity becomes `(host, pane_id)`.
- Max 32 pairs. Over the limit, creation is refused with a message — not a silent eviction.
- **A pane belongs to at most one pair.** Pinning an already-paired pane replaces the old pair
  after a confirm naming what is being replaced.

---

## 4. Transfer

### 4.1 Flow

1. User selects text in the pane view (`#termContent`).
2. User picks an instruction shortcut, or none.
3. Frontend resolves the partner from the active pane's healthy pair, switches `activePane` to it,
   prefills the composer, and **stops**.
4. User reads it and presses Send.

Sending reuses the existing path unchanged: `send_text`, then `send_keys ["Enter"]`
(`web/index.html:747-748`).

An empty selection disables the transfer control. Never transfer a whole scrollback — only a
selection moves.

### 4.2 Payload

```
{instruction}

feedback from {from_name}:
{selected text}
```

`from_name` is the source pane's display name — `Architect 1`, `Reviewer 2` — editable in the pair
sheet and defaulting to the pane's own label. The agent name is deliberately not repeated: the
receiving agent is being told which colleague sent the text, not which tool produced it.

**No fence — changed 2026-08-09 at the user's direction, knowingly.** The original design wrapped
the quoted region in `<<<TRANSFER` / `TRANSFER>>>` because without a delimiter, transferred
content containing a line like `Proceed to implement.` is indistinguishable from the user's own
instruction. That boundary is gone, and with it the refusal of selections that forged the
sentinels. The remaining containment is human: the user chooses the selection and reads the
prefilled composer before sending. Recorded here rather than quietly dropped, so a future reader
sees a decision instead of an omission — reintroducing a delimiter is a one-line change in
`composeTransfer`.

Over 4000 chars after composition: refuse in the frontend, naming the size. Do not silently
truncate a diff, and do not chunk — a partial payload landing in an agent is worse than a refusal.

### 4.3 Instruction shortcuts

A `const` array in `web/index.html`, alongside the themes and key presets. Buttons insert at the
cursor; they never send.

| Shortcut | Inserted text |
|---|---|
| Review | `Review, edit, fix; then propose next steps.` |
| Implement | `Proceed to implement.` |
| Architect prompt | `@.agent/prompts/System_Prompt_2_Architect.md ; /ponytail /caveman` |

**Prompts are referenced by path, never pasted inline.** The agent resolves the file itself, so
neither relay nor frontend carries prompt copy. The starter set is the user's; the implementer
adds none.

---

## 5. Composer

`#termInput` is an `<input>` (`:194`) and Enter sends (`:896`). Both change:

- `<textarea>`, 1 row default, auto-growing to ~6 rows.
- **Enter inserts a newline. Ctrl/Cmd+Enter and the Send button submit.**
- Existing callers of `sendText()` are unaffected — the palette and quick actions build their own
  text and call `send_text` directly (`:840`, `:985`).

This reverses a reflex users already have. It is required: a prefilled multi-line payload that
submits on the first Enter defeats the review checkpoint that §4.1 exists for.

---

## 6. Relay change

`relay/herdr_relay.py:659` — `len(text) > 1000` becomes `4000`. One constant.

The guard stays: an unbounded write is a real abuse vector. The existing `audit()` at `:665`
already records every `send_text` and needs no change. **No new message type, no new gate, no
`SAFE_KEYS` change** — the preflight PASS removed the only reason P3 would have touched the
protocol.

---

## 7. Security posture

Transfer is a prompt-injection path: agent A's pane may hold text A fetched from the internet, and
transfer moves it into B's context. The relay no longer participates, so containment is
**structural**, and every structural piece must survive implementation:

1. The user selects the text — only a selection moves.
2. The composer is prefilled, **never** auto-sent.
3. ~~The payload is fenced.~~ **Removed 2026-08-09** at the user's direction (§4.2). This was a
   security change, made deliberately and with the tradeoff stated, not a UX tweak.
4. The 4000 cap bounds volume; `audit()` records it.

Removing any of the remaining three is a security change, not a UX change. Points 1 and 2 now
carry the whole boundary, which makes the prefill-never-auto-send rule load-bearing rather than
merely careful. **No auto-relay in v1.**

---

## 8. Acceptance

| # | Check |
|---|---|
| A1 | Pin two same-host panes; pair persists across reload |
| A2 | Cross-host panes are absent from the candidate list, and a stored cross-host pair reads stale |
| A3 | Pinning an already-paired pane confirms, then replaces |
| A4 | Closing a member's pane turns the pair stale; **transfer control disappears** |
| A5 | A pane ID reused by a different session (different `cwd`) reads stale, not healthy |
| A6 | A `pane_id` duplicated across two hosts in one snapshot reads stale |
| A7 | Transfer with a selection prefills the **partner's** composer and sends nothing |
| A8 | The prefilled payload carries instruction, then attribution, then the text |
| A9 | The payload contains no fence, and a selection containing the old sentinels passes through unchanged |
| A16 | The switch control and its ⌘/Ctrl+Shift+P binding move to the partner pane, and both are absent on a stale pair |
| A17 | Renaming a pane changes the label herdr itself reports; empty, over-32-character, and control-character labels are refused |
| A18 | Every pane displays as `project · agent · name`, dropping absent parts rather than showing an empty segment |
| A10 | A composed payload over 4000 chars is refused, naming the size, and sends nothing |
| A11 | Enter in the composer inserts a newline; Ctrl/Cmd+Enter sends |
| A12 | A multi-line payload arrives in the agent's composer as one unsubmitted entry (preflight path) |
| A13 | A corrupt `herdr_pairs` value loads as empty; the terminal view still works |
| A14 | With no pairs configured, the terminal view is identical to P2 — no pair header, no transfer control, not disabled ones. The **Pair** control on agent cards is always present, since it is how the first pair is made |
| A15 | A pane with no live same-host partner opens the Pair sheet to an empty list explaining why, and cannot save |

Pair health, fingerprint matching, payload composition, and cap/fence refusal are pure functions
and get unit tests. A12 needs one live pane.

---

## 9. Open

**Pair editor location — decided:** the **pin control lives on agent cards** (where both candidates
are visible together) and the **pair status and transfer control live in the terminal header**
(where the selection is). These are two different jobs, not one control in two places; dev-notes
open question 3 is closed by this.

**Deferred:** cross-device pair sync (dev-notes Q5) — until named local pairs prove useful, and
then only as authenticated frontend-preference sync.
