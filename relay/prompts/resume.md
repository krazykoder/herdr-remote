<!--
What a resume has to say before it asks for anything. A session comes back from a pause for a
reason, and two of those reasons change what the next decision may safely be:

  * `send_unconfirmed` is the exactly-once problem in miniature. The relay pressed Enter and could
    not prove the pane took it, so the last instruction may have landed, twice or not at all. The
    only reader that can settle it is the one that can look at the pane, which is the arbitrator.
  * `call_human` means a person was asked for and has now answered — possibly by typing at a member
    themselves, which is a turn the arbitrator did not ask for and must read as one.

Everything else is said plainly rather than dressed up: what stopped it, and that a person started
it again. A pause reason with no section here gets `fallback`, so adding a section is all it takes
to give a new reason its own words.

  $reason   the pause reason, underscores replaced with spaces — `fallback` only
-->

## send_unconfirmed

This session stopped because the relay could not confirm that its last instruction reached the pane it was typed into. It may have arrived, it may not. Read that member's recent turns below before repeating anything — a duplicated instruction is worse than a late one.

## call_human

This session stopped because you called for a person. They have read it and started the session again. Anything they said to a member themselves is in the turns below, under that member's name.

## user

A person paused this session by hand and has now started it again. Anything they did in the meantime is in the turns below.

## holding

This session stopped because you held three times in a row without sending anything. If the members really have nothing to do, call_human and say so. If they do, write to one of them.

## restart

The relay was restarted while this session was running, which stops it: a send in flight at that moment cannot be proven either way. Read the turns below before repeating an instruction.

## fallback

This session stopped ($reason) and a person has started it again.
