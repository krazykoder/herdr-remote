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

## Drawn as events, not as labels

A branch is the same for twenty messages in a row. Stamping each of them says nothing a reader
wants; what they are looking for is the moment it changed, which is one line between two messages.
So the thread draws `⎇ Branch changed to feat/x` as a rule of the same kind it already uses for a
break in the recording, and the commits — when the reader switches them on — as a short list where
they happened, between the message before and the message after.

`conv_query`'s text output does the same, and that is the point rather than a nicety: an
orchestrator composing a multi-agent conversation reads the record through that formatter, and it
should be reading the same timeline a person sees. One record, two renderings, the same events.

The commit list is fetched on demand (`git_commits`) rather than stored, so the toggle costs one
git call per range the reader actually looks at. Two guards make that safe to expose: both ends
must be shas, since a ref like `--output=x` reaches git's argument parser, and the directory has to
be one a live pane is open in — otherwise a client could name any path and have the relay read a
repository the user never pointed it at.

## What was not built

Commit *contents*: no diffs, no file lists, no stats. A subject and a sha are what a person needs to
find the change in their own tools, and a diff in the record is a second copy of the repository.


## The standing badge, and what it is not

Drawn as events answers *when did this change*. It does not answer *where am I now*, which is the
question a reader has with their thumb over the composer — and the first is only readable at all
because the second is not repeated on every bubble.

So there is a second drawing of the same fact: a badge floating over the bottom of the thread,
just above the composer, carrying the branch of **the agent the composer is addressing**. Per
agent and not per view, because a conversation's members can be in different checkouts on
different branches; a badge that followed the conversation would be wrong for one of them half the
time. In the pane view that is the open pane, in the conversation view it follows the target chip.

It rides on the `agents` snapshot, filled from the turn-end probe the record already runs — no new
git call, and none per poll. It is painted in the addressed agent's own colour rather than in a
generic git blue, so in a joint thread the badge and the bubbles under it say the same thing twice.

Remembered per **checkout**, not per pane: a branch is a fact about a working directory, and two
agents in one repository are on one branch by definition. Keyed by pane, the second of them would
have run a second subprocess to learn the same thing and shown nothing until its own first turn.

A restart empties that memory, and the badge would then be blank until every pane had ended
another turn. The answer is already on disk — the record stores the branch on every turn — so it
is read back once per directory on first sight, and a miss is remembered as a miss so a pane
outside a checkout is asked about once rather than once per poll.

An earlier attempt closed the same gap with a `branch_get` round trip that probed git whenever a
reader addressed a pane. It was removed: the record already holds the answer, reading it costs one
indexed SELECT instead of a subprocess, and what the round trip bought over it was only the
minutes between a branch switch and the next turn that mentions it. The rest of this feature is
"as of a turn" throughout — the rules, the bubbles, the commit ranges — and a badge alone being
live was an inconsistency paid for per selection.

## Rules divide, badges belong

The two halves of what a turn carries are not the same kind of thing, and drawing them alike was
wrong. A rule across the thread is a divider: it says the thread moved on, and what it announces
is the state of the message *below* it — which is exactly right for a branch change. Commits are
not between two messages. The agent said it had finished and those are what it finished, so they
belong to the bubble above them: they take that bubble's width and its column and hang under it as
badges, the way a caption belongs to its picture.

Badges rather than lines for a second reason. Commits arrive in twos and threes, and three lines
of prose under every turn is a thread nobody skims.
