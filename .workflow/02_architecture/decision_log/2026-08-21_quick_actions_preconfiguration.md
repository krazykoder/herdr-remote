# Decision Log: Quick Actions are preconfiguration, not a new capability

**Class B** — additive storage, backward-compatible. **No new WebSocket message, no new relay verb,
no new environment variable.**
**Branch:** `feat/quick-actions`. Full proposal: `../2026-08-21_quick_actions.md`.

## Decision

A Quick Action stores the answers a user would otherwise type into the Start dialog or the composer,
and replays them as the existing calls. `run` is `open_terminal` followed by `send_text` with
`submit`. `spawn` is a run of `start_agent` calls, a conversation record, and optionally `arb_start`.
All of it executes client-side, in the order a person would have done it by hand. The relay's entire
diff is one name added to `DOC_NAMES` in `user_state.py`, so the definitions sync between browsers
the way pairs and conversations already do.

The feature is a shortcut through machinery that exists. Nothing here can do something the app could
not already do; it removes the four dialogs between wanting it and having it.

## Every press lands somewhere the user can watch it

This is the rule the design turns on, and it is what keeps the feature small. A command runs in a
terminal, because a terminal is the thing that shows output. One agent lands on its pane. Several
agents land on the conversation they share. Because nothing is executed into a void, there is no
result channel to design, no output cap to pick, no streaming to build, and no message for the relay
to learn — the pane's scrollback is the output, read by the reader that already reads panes.

## Why the command registry was dropped

An earlier draft put an `ops.json` allowlist in front of the run path, reasoning that `state_put`
carries no `HERDR_ENABLE_WRITE_EXT` gate, so a command stored in a shared document and executed by
the relay would have turned the one ungated message into a way to run anything on the machine.

That reasoning is correct for a server-executed argv and irrelevant to a command typed into a
terminal. `send_text` has no write gate either — only `pane_guard` — and that is what terminal mode
*means*: `HERDR_ENABLE_TERMINAL` "makes them readable and writable." Any client that can see a shell
pane can already type anything into it and press Enter. A Quick Action that types a command into a
terminal grants nothing that was not already granted, so an allowlist in front of it defends nothing
and leaves a registry to maintain. The real gate was always the pair of switches that decide whether
a shell may be opened at all, and a `run` tile is simply disabled when they are off.

What survives is smaller and honest: the command text lives in a document every browser can write,
so browser A can label its text "Run tests" and browser B can press it believing the label. Not
escalation — A could have typed it directly — but a new way to be misled, since a typed command used
to be typed by the person running it. The answer is to show the payload: the literal text appears on
the tile and again in the confirm, and `send_text` already audits it byte for byte.

## Three types, two kinds, one queue

Spawning one preconfigured agent is spawning a roster of one, so the document carries
`kind: "run" | "spawn"` and folds the third case in rather than growing a second code path to drift.
Members start serially, each waiting for the previous `command_result`, because `next_role_label`
derives a pane's label from the live agent list and parallel starts collide on names — the relay
renames around it, but the user gets a roster they did not choose. The intermediate panes stay off
screen through a fourth `startIntent` variant that adopts silently, exactly as the arbitration
dialog's `{arb}` intent already does for the same reason.

## The extension rule

`kind` is a string and the renderer switches on it; no plugin registry and no handler interface are
built. One rule makes future kinds safe: an unknown `kind` renders as a disabled tile and is written
back untouched. Without it a browser on an older build would drop rows it does not understand on its
next `state_put` and destroy actions every other browser can see — the failure `stateSyncPlan`
exists to prevent one level up. With it, the old phone is merely unable to press the new tile.

## Cost accepted

The existing `quickActions*` family in `history.js` — the approval-button strip, thirteen call sites,
storing the string `off` under `herdr_quick_actions` — collides with this feature by name and by
storage key. The new document takes `herdr_quick_actions_v2`, the new renderer is
`renderQuickActionTiles`, and the old family is renamed to `approvalStrip*` in a separate commit
ahead of this work, so the diff that renames is not the diff that adds.
