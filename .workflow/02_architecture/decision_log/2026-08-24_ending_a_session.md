# Decision Log: Ending a session is QUIT carried through, not a new relay verb

**Class A** — no new WebSocket message, no new relay verb, no new environment variable, no new
storage. **Branch:** `feat/kiro-agent` (continuing the quick-actions work).
Spec: `../../03_specs/2026-08-24_ending_a_session_spec.md`.

## Decision

**End** types the two lines a person would type: `/quit` at an agent, then `exit` at the shell it
leaves behind. Both go through `submitText`, the addressed primitive `armQuit` already sits on
(`web/src/controls.js:93`). The second line waits for the snapshot that shows the agent has gone —
the pane moving out of `agents` and into `shells` — which is the same watch-the-poll pattern
`launcherLanded` and `openPendingStart` already use.

`herdr pane close` exists and was the obvious alternative. It was rejected: it is a new client to
server message, a new gate to argue about, and a wire change to a relay whose whole surface is
documented in `CLAUDE.md`. What it buys over the two lines is one case — a wedged or `blocked` pane
that will not read text — and that case is named on screen instead (see the spec).

## Why QUIT alone was not already enough

`armQuit` sends `/quit` and stops. On an agent pane herdr keeps the pane: the agent's TUI exits and
the pane survives as a bare shell, still wearing the name the session was started under. With
`HERDR_ENABLE_TERMINAL=1` that corpse then appears in the **Terminals** section, so the list of
shells a user opened is polluted with the remains of agents they ended. It also keeps its slot, so
`free_slot` and `slot_advice` see columns nobody is using.

So the gap was never a missing button. It was QUIT stopping one line short.

## Panes are not recycled into new agents — closing is what recycles IDs

Checked before designing, because the fear driving the original request was that a leftover shell
would be handed to the next spawn. It cannot be. `claimable_spacer` (`relay/start_agent.py:357`)
only claims a pane where `is_spacer` holds, and `is_spacer` (`:312`) requires **both** no agent
**and** `label == SPACER_LABEL`. A quit agent pane keeps its own label, so no start will ever land
on it; every placement mints a fresh pane.

The recycling that does exist runs the other way. herdr re-mints a pane ID after a pane is *closed*
— which is why `convMemberKey` is `[host, pane_id, agent, cwd]` and not the id alone. So ending
panes properly slightly *increases* ID reuse. That is safe here: a collision needs the same id, the
same harness and the same cwd, which is the respawn case, and `convContinueTranscript`
(`web/src/conversation_store.js:198`) already refuses to overwrite a referenced transcript there.

## An ended conversation is grey because nothing is live, not because a flag says so

No `ended` field is stored. Liveness is already derived everywhere it is shown — `convRosterHtml`
computes it from the snapshot, and `conversation_view.js:358` states the rule outright: "A member is
recording or it has ended, and that is derived rather than stored." A stored flag would be a second
answer to a question the snapshot already answers, and it would be wrong for the whole window
between a relay restart and the first poll.

## Relaunch already existed; End was its missing half

The request asked to "check that each killed agent pane has a relaunch configuration". It has one,
and it is complete. Each transcript carries a `spawn` record — `{agent, project_id, cwd, host,
workspace_id, starter, label}` (`web/src/conversation_store.js:108`). `canRespawn`
(`web/src/shortcuts.js:697`) hides the control unless the harness is still in the relay's allowlist
and the Project still exists; `convRespawn` (`:731`) restarts under the same name and role, into the
old workspace when it is still live, replaces the member in place, copies the transcript across the
seam and repoints the pair; `respawnNote` warns when the Project has been repointed since.

Nothing about relaunch is built here. **Start again** was simply the only lifecycle control on the
roster row, so a member could be brought back but never sent away. End is the other half, and it
goes on the same row.

## Per-tile tracking of spawned sessions was abandoned

An earlier draft stamped a `launch_id` on the conversation a tile creates, so the launcher could
draw a collapsible **Active** band of the sessions each tile had spawned. Dropped by the user, and
the reasoning holds: the conversation *is* the record of a launch. It already carries the roster,
the name the tile gave it, its members' liveness and — through the roster row — End and Start again.
A second list keyed by tile would have been the same sessions under a second identity, kept in step
by hand, and it would have needed a `run` tile to invent a conversation for a lone shell just so it
had somewhere to be listed.

The launcher stays what it is: a way to press a roster into a Project. Where those sessions are
watched and ended is the conversation and the landing page, which is where every other session is
watched and ended.

## The ceiling this accepts

Two lines typed at a pane cannot end a pane that will not read them.

- A **`blocked`** pane is sitting on a permission prompt; the relay refuses `send_text` at one by
  design. End says so rather than sending into a refusal.
- With **`HERDR_ENABLE_TERMINAL` off** the relay never lists shell panes, so after `/quit` the pane
  leaves `agents` and appears nowhere. The app cannot tell "herdr closed it" from "it is a shell I
  cannot see", so it stops after the first line and says the pane may remain.

Both are marked `ponytail:` at the code, with `herdr pane close` named as the upgrade. Neither is
worth a wire change today: the first is answerable by the user in one tap, and the second only
affects installs that have already chosen not to see shells.
