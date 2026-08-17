# Debt inventory

Running list of work that is known, deliberate, and not done yet. One entry per item: what it is,
why it was left, and what would close it. Items are struck from the list by fixing them, not by
ageing out.

Opened 2026-08-17, on the merge of `feat/history-capture` into `main`.

## Open

### Three role prompts are still placeholders
`START_ROLES` in `web/src/pairs_pure.js` offers Architect, Reviewer, Arbitrator and Orchestrator,
but only Architect has a real starter prompt behind it; the other three are TBD text. Starting a
session in one of those roles works and says nothing useful to the agent.

Left because the prompts are content, not code — they need writing by whoever owns how these roles
are meant to behave, and a guessed prompt would be worse than an obvious placeholder.

Closes when: the three prompt bodies exist and `roleStarter` returns them.

### `healPairs` will not repair an ambiguous seat
A pair member whose pane came back under a new ID is re-pointed onto the unique live pane with the
same host, harness and cwd (`healPairs`, `web/src/pairs_ui.js`). Two claude panes in one directory
are two colleagues, so that case is deliberately left alone and the pair stays stale until the user
re-pairs by hand.

Left because guessing between them would put one agent's work in the other's terminal — a wrong
repair is much worse than no repair.

Closes when: there is a stable per-session identity to match on that survives a restart. herdr's
pane ID is not it.

### Live checks not yet run against a real agent
Two paths have only fake-herdr coverage:
- a role-started agent and the starter prompt it actually receives;
- a long Claude/Codex capture, including the interim bubbles that arrive mid-turn.

Left because both need a real agent doing real work for minutes, which the fake herdr cannot stand
in for.

Closes when: both are exercised against a live herdr and what they showed is written down here.

### Phone visual pass owed on two new surfaces
The Activity storage table and the harness filter badges in the agent-card header were built and
checked on desktop widths only.

Closes when: both are looked at on a phone viewport and the pixel problems found there are fixed.

### Cloudflare Pages publishes the unbuilt form
Pushing `main` deploys `web/` to Cloudflare Pages, which serves `index.html` plus `src/*.js` — not
the single inlined file GitHub Pages gets from `make deploy-web`. Both work; they are not the same
artifact, so a bug reproducible on one host may not reproduce on the other.

Closes when: the Pages project points at `web/dist` with `python3 scripts/build.py` as its build
command.
