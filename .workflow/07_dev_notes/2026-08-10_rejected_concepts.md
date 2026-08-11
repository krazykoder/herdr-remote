# Rejected concepts — 2026-08-10

Rejected, not deferred. Both were designed far enough to cost something, and both were turned
down on value, not on difficulty. Recorded so the next person who has the same idea reads why it
was dropped instead of rebuilding it.

A third idea from the same day — publishing a localhost port to the remote browser — is **deferred,
not rejected**, and lives in
[01_concepts/ideas/2026-08-10_localhost_port_publishing.md](../01_concepts/ideas/2026-08-10_localhost_port_publishing.md).

---

## 1. Liveness status model (bottom-right label + dot colours)

**What was proposed.** Replace the current three-way dot colour with an activity-recency scale:

| Colour | Meaning |
|---|---|
| green | live — active now, or last active < 5 min |
| yellow | idle — last active 5 min – 1 hr |
| transparent ring | paused — was active, status unknown, or > 1 hr |

Applied to the agent cards, the tab strip dots, and the `active`/`idle` text at bottom right.

**Why rejected.** The signal needed to drive it does not exist, and manufacturing it is a wire
change for a cosmetic return.

- The relay polls `herdr pane list` every `POLL_INTERVAL` (2s). That returns per-pane metadata
  and `status` only — **no timestamp**. See `split_panes()` in `relay/herdr_relay.py`, whose key
  order is contractually frozen byte-for-byte when terminal mode is off.
- Pane **content** is read on demand (`read_pane`) for the *open* pane only. So the two things
  that can stamp "activity" client-side are (a) a herdr status transition, any pane, and (b) the
  open pane's text changing, one pane.
- Consequence: an agent that receives a message and replies in a pane you are not viewing,
  without a status transition herdr reports, never stamps. Its dot drifts yellow then transparent
  while it is genuinely working. Same for anything at all that happens while the phone is asleep —
  come back after 20 minutes and every pane reads paused.

So the 5-minute band would only be honest for the pane currently on screen. Making it honest
everywhere means the relay recording a per-pane `last_change` (it already tracks `last_statuses`
for blocked detection) and putting it on the wire — a protocol change plus a test, to move a dot
from one shade to another.

**Unresolved design gaps, for the record.** Even with the data, the model had holes: `blocked` has
no place on a single liveness axis and must outrank it; "unknown status → paused" and
"active < 5 min → green" can both match the same pane; a never-seen pane renders "paused" while
claiming it *was* active, which is not known; the tab strip caches markup on a signature, so the
recency *bucket* would have to enter that signature or tabs never repaint as they age; and a
transparent dot needs a border ring, not a `box-shadow`, because `.agent-tab.active .dot` already
owns `box-shadow`.

**Verdict.** Current model stays: red blocked, green working, muted otherwise.

---

## 2. Live shell / SSH-like terminal experience

**What was proposed.** Close the gap between the existing terminal mode and a real interactive
shell. Three cheap steps were offered as an 80% path:

1. Poll the focused shell pane at ~800ms instead of 3s while the composer is warm.
2. Local echo — paint sent text into the pane immediately, let the next read overwrite it.
3. Widen `SAFE_KEYS` to the full `ctrl+a..z` set.

**Why rejected.** The product's job is remote *supervision* of agents, not remote *typing*. The
terminal exists to unblock an agent and glance at output, and it already does that. Faster polling
and local echo make the pane feel like a shell it is deliberately not, which invites a class of use
(interactive TUIs, long sessions) the architecture cannot honour — see below. Chasing that feel is
work spent moving away from the core loop.

**What exists today**, for reference, so this is not re-surveyed:

| Piece | Where |
|---|---|
| Shell panes listed / readable / writable, gated by `HERDR_ENABLE_TERMINAL` | `relay/herdr_relay.py` `split_panes` |
| Create a shell at a Project cwd (`open_terminal`) | `relay/start_agent.py:171`, `herdr_relay.py:681` |
| Write path: `send_text` (raw, ≤ 4000 chars) then `send_keys ['Enter']` | `herdr_relay.py:1070`, `:1046` |
| Read path: `read_pane`, full re-read, `recent-unwrapped` or `visible` | `herdr_relay.py:1024` |
| Remote hosts over SSH: `HERDR_REMOTES`, `pane_remote_map`, `run_herdr(remote=)` | `herdr_relay.py:175` |
| Mobile keys dock, ctrl presets, palette, wrap/reflow, measured `cols` | `web/index.html` |

**Structural ceilings that no amount of polling removes:**

- Poll-and-repaint, not stream. Open pane re-reads every 3s (`index.html:4184`) plus a burst at
  400/1200/2500 ms after a keystroke (`:4007`). Full 200-line re-read, full re-render, no delta.
- No local echo — a typed character appears only after a round trip.
- 24-entry key allowlist (`SAFE_KEYS`, `herdr_relay.py:196`). Deliberate: these become argv
  elements. No alt, no function keys.
- No ANSI. `read_pane` returns plain text and the client HTML-escapes it. Colour, bold, and cursor
  position are gone, so `vim` / `htop` are only half-usable via `source: 'visible'`.
- No PTY resize from the client — only herdr's `wide` / `narrow` slot.

A genuine live shell means per-pane push at 100–200 ms with diffs, plus `xterm.js` for ANSI. That
kills the single-file no-build-step property of `web/index.html` and fights the allowlist security
model, which is the second reason this is closed rather than parked.

**Verdict.** Terminal mode stays a supervision tool. Not a shell.
