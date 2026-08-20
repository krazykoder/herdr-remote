# Decision — A commit is attributed to a checkout, not to a pane

**Date:** 2026-08-19
**Context:** `relay/herdr_relay.py:probe_git`, `relay/conversation_log.py:last_commit`,
`relay/git_probe.py:_commits`, and the commit strip drawn by `web/src/conv_live.js:convGitRules`.
Shipped as `1bba7c9`.
**Decided by:** the user, on the report "I see `bd575630` in Architect 1's record but this commit
belongs to Architect 5 — I don't see why this was recorded in the wrong place."

---

## The problem

A turn carries the commits its directory gained since the last turn recorded there. The range is
keyed by `(host, cwd)` — `last_commit(host, cwd)` — so it is *everything new in this checkout*,
made by any pane. The app hung that list under the bubble of the turn that ended, at that bubble's
width and side, painted in that agent's colour. Read as authorship. It is not.

Two ways the wrong pane gets the credit, both observed:

1. **Two panes, one checkout.** Architect 1 and Architect 5 both open at the repo root. Whichever
   ends a turn first after a commit lands gets the whole range, including the other's work.
2. **A merged worktree.** While a branch lives in its own worktree the cwd differs, so its commits
   sit in their own bucket and nothing crosses. At `merge --ff-only main` they become reachable
   from the main checkout's HEAD, and the main checkout's next range — `prev_sha..HEAD` — picks up
   the whole batch at once. `git reflog show main` records exactly this as
   `merge fix/keyboard-inset: Fast-forward`.

Per-checkout counting is deliberate and is not the bug. Counted per pane, each pane would carry the
previous sha *it* last ended on, and the same commit would appear under a bubble from each of them —
twice, once misattributed. Per checkout it appears exactly once, under the first turn to end after
it was made.

**Git cannot break the tie.** Every agent in one repository commits as the same person: `bd57563`
is authored and committed by `krazykoder`, like every other commit here. There is no per-pane
provenance to appeal to. The relay never witnesses a commit either — it polls herdr, and runs
`git log since..HEAD` at turn end, by which point the commit is minutes old.

---

## What was decided

Drop the claim rather than guess at it. The strip is now a rule across the thread like the branch
line above it: full width, centred, neutral, led by `landed in <checkout>`, and its tooltip says
"Commits are per checkout — another agent working here may have made them."

The data is unchanged and correct. Only the sentence the layout was speaking was wrong.

---

## The options that were weighed, and are still open

### 1. Timestamp bracketing — the cheap partial, recommended if this is picked up

A commit has a committer date. A turn has `at` (its end), and the same pane's previous `at` is the
start of the window it was working in. A commit whose time falls inside exactly one pane's window
belongs to that pane.

Cost is small and mostly already paid: `git_probe.py:86` already runs one `git log` per range with
`--format=%H%x1f%s`; making it `%H%x1f%ct%x1f%s` adds the committer date at the cost of nothing —
same subprocess, one more field. `commit_time()` already exists for the `since_commit`/`until_commit`
query and does the same thing one sha at a time. The rest is a query over `turns` by `cwd`.

Its ceiling: two agents working the same cwd with overlapping windows stay ambiguous — which is
precisely the case that produced the report. Agents run for minutes; overlap is common.

**So it should not ship as attribution.** Ship it as the honest question it can actually answer:
*which turns were open in this checkout when this commit landed*. One pane, and the chain that led
to the commit is that pane's thread. Two, and it says two — still narrowing a whole checkout's
history to two threads, and never lying.

### 2. A commit trailer, written by a git hook

A `post-commit` hook stamping the pane id from the environment. The only *certain* attribution,
because the process that commits is the one that records it. Rejected for now: per-repo setup,
rewrites commit messages, silently absent for any agent whose environment lacks the id, and lost
on rebase. Invasive for what it buys.

### 3. Leave it — chosen

The strip says what is true. Nothing further is owed until the ambiguity costs something.

---

## What already exists, and is easy to forget

`conv_log` takes `since_commit` and `until_commit`, resolved against the `cwd` in the same message:
every conversation between two commits, without the record storing a commit list. The gap this
document describes is only the pane-level narrowing *inside* a shared checkout.

Worktrees close it for free — a distinct cwd is a distinct bucket, so parallel agents in separate
worktrees are already attributed correctly until the moment their branches merge.
