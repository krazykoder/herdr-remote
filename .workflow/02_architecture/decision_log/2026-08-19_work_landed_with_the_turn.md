# Where the work landed, recorded with the turn

*2026-08-19 — accepted, shipped on `feat/state-sync`.*

## What was asked

Find the changes that belong to one message: this prompt, that summary — which branch, which
commits.

## What was built

Three columns on `turns`, filled at the two moments the relay already writes to the record:

| Column | What |
|---|---|
| `branch` | The branch the pane's `cwd` was on. Empty on a detached HEAD, which is a commit and not a branch. |
| `commit_sha` | The commit it was at when the turn was recorded. |
| `commits` | The commits between the previous turn recorded for that directory and this one, as `[{sha, subject}]`. |

`relay/git_probe.py` runs the two read-only commands; `relay/conversation_log.py` stores what it is
handed and runs nothing.

## Why the range is derived from the record and not from a second table

The other end of a turn's range is the commit the *previous* turn for that directory was at, which
the record already holds. So there is no commit table, no ingestion, and no state that can disagree
with the turns it describes. A relay restart is not a gap either: the previous end is read back out
of SQLite rather than out of memory, so commits made while the relay was down still land on the
turn that follows them.

## What this admits

- **A range is not authorship.** These are the commits that appeared while the agent was working,
  whoever made them. A person committing in the same checkout lands in the same range. Attributing
  them properly would mean reading the author of each commit and knowing which agent is which
  person, and that is a bigger claim than this feature makes.
- **A rebase erases a range.** When the stored sha is no longer reachable, `git log` is asked for a
  range that does not exist and the answer is nothing. Nothing is the honest answer — the
  alternative is attaching the whole history to one turn. The subjects already recorded stay, which
  is why they are stored as text rather than resolved at read time.
- **One directory, one branch.** A pane that changes branch mid-turn is recorded at the branch it
  ended on. The commits are still right; only the label is the later of two.
- **It costs a subprocess per turn**, and an ssh round trip for a remote pane. Not per poll — at
  turn end and at a send, which is where the record is written anyway. `HERDR_GIT_TRACK=0` stops it.

## Why it is on by default

It is on with `HERDR_CONV_LOG` and nothing without it. The record already keeps what agents *said*,
which is the decision about the user's data; `git rev-parse` in a directory the user is already
recording adds no new category of thing on disk. A feature that has to be found in an environment
variable before it works is a feature that silently does not.

## What was not built

Commit *contents*: no diffs, no file lists, no stats. A subject and a sha are what a person needs to
find the change in their own tools, and a diff in the record is a second copy of the repository.
