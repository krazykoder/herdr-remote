<!--
Sent when a person edits a running session. An announcement, never a question: no decision is asked
for and no drop path is named, because nothing has happened yet that needs one.

The arbitrator was told the roster once in the opening brief, and every trigger repeats it — so a
roster edited underneath it would arrive as a surprise in the next trigger with no way to tell a
swap from a mistake. This says a person did it, on purpose.

Which of the two things changed is said out loud, because they mean different things to the agent
reading it. A pane that moved invalidates what it remembers about a member id; a role that changed
does not — the same colleague is still there with a different job, and telling it otherwise would
have it distrust a member it has worked with all session.

The `changed-*` sections are the four ways `opening` can end. `moved` and `same` are the two ways
the paragraph after the roster can go.

  $what   one of the four `changed-*` phrases below
-->

## opening

The person running this session has $what.

## changed-both

changed who is in it, and what each of them is for

## changed-members

changed who is in it

## changed-roles

changed what each member is for

## changed-scope

changed what it is for

## columns

The second column is the role: what the person wants that member to do. Address members by the id in the first column — the roles are how you choose between them, never how you name one.

## moved

Anyone not listed above has left and can no longer be addressed. Member ids are positional, so one you have used before may now be a different agent — read the roster in each trigger message rather than remembering it.

## same

The same agents are still here. Only their roles changed, so a member id still means the agent it meant before.

## closing

Do not write a decision record for this message. Wait for the next trigger.
