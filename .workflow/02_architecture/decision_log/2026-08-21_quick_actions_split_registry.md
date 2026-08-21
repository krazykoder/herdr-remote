# Decision Log: A Quick Action names a command, it does not carry one

**Class B** — additive protocol, additive storage, backward-compatible.
**Branch:** `feat/quick-actions`. Full proposal: `../2026-08-21_quick_actions.md`.

## Decision

Quick Actions are split across two stores that already exist and are already trusted differently.
What a Quick Action *may do* — the argv of every runnable command, the agent kinds, the projects
and their cwd/host, the parameter specs — is server configuration, read from the `ops.json`
registry `ops_config.py` already owns. What the user *arranged* — which tiles exist, their order,
labels, and the parameter values typed into them — is a fifth shared document in state sqlite,
editable from the app by any connected browser. The wire carries the name of a command and never
its payload, in either direction.

## Why the alternative is remote code execution

`state_put` is deliberately not behind `HERDR_ENABLE_WRITE_EXT`; the existing contract says why —
"that gate is for process creation, and this writes a label." Every connected client may write
every shared document. Had a Quick Action stored its own argv there, a browser could write
`["curl", "…|sh"]` into the document and press its own tile, and the one message in this protocol
with no write gate would have become the way to run anything on the machine. The split is not
defensive layering; it is the only shape in which a user-editable launcher and an ungated state
store can both exist. The rule it follows is already frozen one layer over, in `start_agent`: cwd
and host come from the configured Project, never from the wire (D4). A Quick Action of kind `run`
names a key in `commands` the same way a spawn names a `project_id` — the user chooses among what
the machine's owner permitted, and cannot widen it.

## Why `ops_config.py` and not a second registry

It is already this boundary, already hardened, already tested, and pure — reading a file is its
only I/O, so the relay can import it without adding a dependency or touching the poll loop. It
enforces at *load* time that a `{placeholder}` is a whole argv element, which is what makes a
validated parameter unable to grow into a second argument, an option, or a shell fragment; it runs
`shell=False` with no escape hatch; and its `tier: "W"` is already the project's word for "confirm
before this runs," so the UI reuses that rather than inventing a second notion of dangerous. A
machine that has never written an `ops.json` gets an empty command list and is offered no `run`
actions at all — the correct degradation, because a person who has not said what may execute has
not been overruled.

## Three action types, two kinds

The request named three things; two of them are the same thing. Spawning one preconfigured agent is
spawning a collection whose roster has one member and no conversation, so the document carries
`kind: "run" | "spawn"` and nothing else. Folding them avoids two code paths that would drift, and
a `spawn` is executed client-side as the `start_agent`, conversation-write and `arb_start` calls the
user would otherwise have made by hand — so the relay learns no new verb, every existing validation
applies unchanged, and a partial failure leaves the panes that did start, which is both what the
user wants and all a server-side path could have offered anyway, `start_agent` being irreversible.

## The extension rule that makes future kinds safe

`kind` is a string and the renderer switches on it; that is the whole extension mechanism, and no
plugin registry or handler interface is built. What makes it hold is one rule: an unknown `kind`
renders as a disabled tile and is written back untouched. Without it, a browser on an older build
would drop rows it did not understand on its next `state_put` and destroy actions every other
browser can see — which is the failure `stateSyncPlan` exists to prevent one level up. With it, the
old phone is merely unable to press the new action.

## Cost accepted

The existing `quickActions*` family in `history.js` — the approval-button strip, thirteen call
sites, storing the string `off` under `herdr_quick_actions` — collides with this feature by name
and by storage key. The new document takes `herdr_quick_actions_v2` and the new renderer is
`renderQuickActionTiles`, and the old family is renamed to `approvalStrip*` in a separate commit
ahead of this work, so the diff that renames is not the diff that adds.
