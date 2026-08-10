# Decision — Terminal mode trust model

**Date:** 2026-08-09
**Context:** `.workflow/02_architecture/2026-08-09_terminal_mode.md` §5
**Decided by:** the user, on three questions put by the architect.

---

## D1 — The command catalog is dropped

**Proposed:** an operator-owned `HERDR_COMMANDS_FILE` holding argv lists and typed parameters; the
client sends a command id, the relay resolves and validates it.

**Decided:** no catalog. Shortcuts live in the browser's `localStorage` beside `herdr_pairs`, are
editable from the phone, and `send_text` is permitted to shell panes.

A catalog is a security boundary only if raw input is impossible. Raw input is wanted, so the
catalog would have validated nothing that could not be routed around by typing the command instead —
leaving a file format, a loader, a parameter validator, a reload path, and a new message type whose
only remaining function is storing a list of strings the client can already store for free. Rejecting
it removes roughly a tenth's worth of the feature's code and, more importantly, removes the false
impression that the relay is bounding what a browser may execute. It is not, and the architecture
document now says so in those words.

## D2 — `HERDR_LAN_OPEN=1` carries terminal mode

**Raised as blocking:** the architect recommended that an open LAN listener never carry terminal
mode, on the grounds that `HERDR_LAN_OPEN` is a convenience for approving agent prompts on a trusted
network and should not also hand a shell to anything that can reach the port.

**Decided:** it carries. The user accepted the risk explicitly, with the consequence stated: on an
open LAN listener there is no token, so any device on the network can run anything the herdr user
can run. This is not re-argued in the spec or the plans.

Two things keep it from being reached by accident rather than by choice, and both are required:
`HERDR_ENABLE_TERMINAL` defaults to off, and the relay logs a startup warning naming both settings
when they are on together. The external listener is untouched and still always requires a token.

## D3 — Off means undiscovered, not hidden

With `HERDR_ENABLE_TERMINAL` unset, shell panes are not parsed into the snapshot at all. They do not
enter `known_panes`, so `pane_guard` refuses them exactly as it does today and the relay's behaviour
is byte-identical to before the feature existed. Hiding them client-side instead would leave six
message types quietly accepting shell panes for any client that knew the ID.

## D4 — T1 is read-only by refusal, not by omission

Admitting a shell pane to `known_panes` makes `pane_guard` accept it for all six message types at
once, `send_text` included. T1 therefore adds an explicit refusal of `send_text` on shell panes,
which T2 deletes. One line built and one line deleted, rather than a tri-state environment variable
that would outlive the phase that needed it.

`respond` refuses shell panes permanently — `SAFE_RESPONSES` is a list of agent approval strings, and
sending one to a shell is meaningless at best.

## D5 — Spacers are excluded from the Terminals list

A spacer is a usable shell, and it is also the one pane this application closes on its own
(`plan_slot` may close a spacer to reclaim its columns). Listing a pane the product may delete out
from under a reader is worse than not listing it. The exclusion buys an invariant worth more than the
two panes it costs: every pane in the Terminals list is the user's, and nothing in the product will
close it.
