# A roster that can be woken

**2026-08-29 · Class B · web only**

Appointing an arbitration session asked three questions of a list that had already answered them.
`Agent 1` and `Agent 2` were drawn from `arbLiveMembers` — the conversation's members mapped
through the live pane list — so a member whose session had been paused was not in the picker at
all, and a conversation with one paused member could not start a session on any terms. The
`Arbitrator` list was narrower still: panes outside the conversation, inside its project, and
neither `working` nor `blocked`. A pane that went busy for one poll while somebody was writing the
scope disappeared from under their thumb.

Three things change.

**The arbitrator may be any pane in the project, whatever it is doing, including a member of this
conversation.** The old rule — the arbitrator is not a participant, it is the thing deciding what
happens between participants — was a good description of the usual case and a bad constraint on
the picker: it is the person's judgement which pane is well placed to referee, and a colleague who
has been reading the same repository all afternoon is often the best-placed one. What must not
happen is a pane arbitrating *itself*, and that is already refused where refusals belong: the
relay's `_enrol` has always rejected a roster with a repeated pane id (`duplicate_participant`).
Until now that check could only ever catch a client bug, because the picker made such a roster
impossible to build; it becomes load-bearing here, and `tests/test_arb_roster.py` pins it as such. The status filter goes with it: whether a pane can take
the brief is the relay's answer (`arbitrator_busy`, N7), and a picker that hides candidates to
avoid a refusal hides them on stale information three seconds old.

**A paused member may be picked.** The record of how a member was started is what a restart is
rebuilt from, and it survives the session it describes — so "the agent that used to be here" is a
thing a person can point at even when there is no pane. Picking one means the session should have
it, so the app restarts it and waits, rather than telling the person to go and do that themselves
in a different part of the same window and then come back and retype the scope.

**Which makes the trio start fall out.** Once a slot can name something that is not running, a
session whose whole roster is paused is the same operation as a session with one paused member,
and `Start` is the one press for it: restart what is missing, wait for the panes, then enrol. The
restarts go through the durable spawn note from
[a spawn that outlives the view it was asked from](2026-08-29_a_spawn_that_outlives_the_view.md) —
which is the reason that change comes first. Without it the three starts trample each other's
binding and the session enrols panes that belong to no member.

The waiting is bounded by the same deadline the note is (two minutes) and is said out loud while
it happens. A start that cannot be completed is dropped with the reason, and the form is left
standing with everything typed into it — the scope is the expensive part and nothing here is worth
losing it over.
