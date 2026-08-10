# Plan — T2: Terminal input and the shortcut grid

**Date:** 2026-08-10
**Spec:** `.workflow/03_specs/2026-08-09_terminal_mode_spec.md` §6.4 (T2 row), §7
**Architecture:** `.workflow/02_architecture/2026-08-09_terminal_mode.md`
**Decisions:** `.workflow/02_architecture/decision_log/2026-08-09_terminal_mode_trust_model.md`
**Precedes:** T1 — `.workflow/04_implementation_plans/2026-08-09_t1_terminal_read_only.md` (shipped, `f1cd623`)

---

## 1. Goal

A terminal pane becomes writable: the composer comes back, and a grid of saved commands sends
without typing. `respond` stays refused forever — it is a list of agent approval strings.

Out of scope: `open_terminal` and the `+ New terminal` chip. That is T3, and it needs
`HERDR_ENABLE_WRITE_EXT` on top of terminal mode because it spawns a process.

---

## 2. `relay/herdr_relay.py` [MODIFY]

Delete the `send_text` shell refusal (1016–1022) — comment and all. It was labelled "T1 only" for
this moment. Nothing replaces it: `pane_guard` already covers unknown and ambiguous pane IDs, the
4000-byte cap already covers the payload, and the audit line already names ip / device / listener.

The `respond` refusal at 945 stays, and its comment already says why.

No new flag. The shell was already writable through `send_keys` in T1; `send_text` is the same
authority with a longer payload, and gating them apart would be theatre.

---

## 3. `web/index.html` [MODIFY]

### 3.1 CSS — give the composer back

Remove from the `.terminal-view.is-terminal` hide list: `#termInput`, `.term-input .send`,
`.term-input .clear`, `#micBtn`, `#promptDock`, `#promptsBtn`. Remove the
`.terminal-view.is-terminal .term-input { justify-content: flex-start }` rule with them — it exists
only to stop the row collapsing when the textarea is gone.

Still hidden, permanently: `#commandBtn` (the `/` palette is agent slash commands), `#quickDock`
and `#quickDockBtn` (yes / no / continue are approval words), and every pair, transfer, and
New session control.

### 3.2 The shortcut store

Beside `PAIRS_KEY`, inside the pure block, so `tests/test_pairs.js` reaches the parser:

```js
const TERM_KEY = 'herdr_term_shortcuts';
const TERM_VERSION = 1;
const MAX_TERM_SHORTCUTS = 24;
```

`parseTermShortcuts(raw)` mirrors `parsePairs`: a blob that is unreadable, wrong-version, or the
wrong shape yields `[]` rather than throwing. It returns entries with a non-empty string `label`
and `text`, `danger` coerced to a boolean, capped at `MAX_TERM_SHORTCUTS`.

**Absent key is not a corrupt key.** No stored value at all seeds `DEFAULT_TERM_SHORTCUTS` — an
empty grid is a dead end for a first-time user. A corrupt value is discarded to `[]`, because the
alternative is silently replacing something the user wrote.

Defaults are read-only commands only: `ls -la`, `git status`, `git log --oneline -10`, `pwd`.
Nothing that writes ships as a default.

### 3.3 One dock, two contents

`#promptDock` already holds `#shortcutRow` and is already toggled by `#promptsBtn`. It renders
agent prompts, which *insert at the cursor*; for a shell it renders saved commands, which *send*.
Same dock, one renderer, chosen by `isShell(activePane)` — a second dock would duplicate the
toggle, the close button, and the "only one dock is open" rule.

- Header text: `Prompts` for an agent, `Commands` for a shell. Give the existing `<span>` an id.
- `renderShortcutDock()` replaces the one-shot `#shortcutRow` fill at line 4188 and is called from
  `toggleDock('promptDock')` and `syncOpenPaneChrome()`.
- Shell rows are the command button plus a `✕`; an agent's rows are unchanged.
- A `+ Add` row, shell only.

### 3.4 Running one

```js
runShortcut(i, btn)   // send_text, then send_keys ['Enter'] — the two-step every composer uses
```

A `danger` entry arms on the first tap and fires on the second, reusing `CLS_ARM_MS` and the
`armed` class the Clear control already has. No modal. The arm belongs to one entry; tapping a
different one moves it, and a re-render disarms.

After a send, `burstPoll()` — three extra reads over the first few seconds. herdr exposes no
process lifetime, so "has it finished" can only be answered by looking, and the steady 3s interval
is too slow to feel like a terminal right after a command. It does not change that interval.

### 3.5 Editing

`prompt()` for label and text, `confirm()` for the destructive flag and for delete — the same
idiom `renamePane` uses. Text longer than `SEND_TEXT_MAX` is refused at save with a toast, not at
send: the relay's cap is 4000 and a shortcut that can never run should never be storable.

---

## 4. Tests

**`tests/test_pairs.js` [MODIFY]** — `parseTermShortcuts` is in the extracted pure block, so it
tests for free: corrupt blob, wrong version, wrong shape, cap, `danger` coercion.

**`tests/e2e/e2e_start_agent.py` [MODIFY]** — in `terminal_run`, the send_text refusal check
inverts. `send_text` has no `command_result` reply, so assert on the fake herdr log:
`pane send-text w9:p3 …` appears, and no `error` frame arrives. The `respond` refusal check stays
exactly as it is — that one is permanent, and the test is what keeps it that way.

## 5. Verification

```bash
.venv313/bin/python -m unittest discover -s tests -t tests
node --test tests/test_pairs.js
HERDR_ENABLE_TERMINAL=1 .venv313/bin/python tests/e2e/e2e_start_agent.py
```

Manual: a real shell pane, `HERDR_ENABLE_TERMINAL=1`, type a command and send it; run a default
shortcut; add one, mark it destructive, confirm it takes two taps; delete it.

## 6. Acceptance

1. `send_text` to a shell pane reaches herdr and is audited.
2. `respond` to a shell pane is still refused, with the same message.
3. A terminal shows the composer, Send, Clear, and the Commands dock; it shows no `/` palette, no
   quick-actions dock, and no pair, transfer, or New session control.
4. An agent shows the Prompts dock with its prompts, unchanged, and they still insert rather
   than send.
5. A corrupt `herdr_term_shortcuts` blob loads as no shortcuts and does not break the view; an
   absent one loads the defaults.
6. A shortcut marked destructive requires two taps within the arm window.
7. Existing suites pass unchanged.
