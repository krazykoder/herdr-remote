# Decision Log: A client's messages run one lane per pane, not one lane per socket

**Status: written, measured, not shipped.** The implementation lives on `wip/one-lane-per-pane`
(`38643b5`) with its tests. What made the serial handler *felt* was one 45-second wait, and
`83fa29c` removed that by handing an unconfirmed send to the poll after four seconds — after
which no stall was reproducible by hand across every harness. What remains for this change is a
remote `read_pane` and a 6-second `start_agent`, neither of which anyone has noticed. It is
recorded here so the reasoning does not have to be rebuilt, and it ships the day one of those
two starts costing someone something.

**Class B** — no wire change, no new message, no new environment variable, no new storage. What
changes is when the relay runs what it was already sent. **Branch:** `feat/kiro-agent`.

## Decision

A WebSocket connection dispatches each message it receives as its own task, and the tasks are
serialised **per pane** by a lock: two messages naming the same pane run in arrival order, and
messages naming different panes run at the same time. Messages that name no pane — `start_agent`,
`open_terminal`, `state_put`, `conv_log`, the `arb_*` lifecycle — share one lane between them, so
their order against each other is unchanged.

The alternative was to leave the handler serial and keep shortening the individual waits, which is
what `83fa29c` did. That is the right first move and it is not a general answer: it caps one wait.

## The problem

`handle_client` reads with `async for raw in ws` and awaits each message's handler inline, so the
duration of one handler is how long every later message from that browser waits. It is not a
theoretical cost:

* a send nobody could confirm held the socket for `SUBMIT_SLOW["agy"]` — 45 seconds. Pressing
  **End** and then **Start again** put the `start_agent` on the wire at the click and into the
  relay 47 seconds later, which read as "starting agy takes 30 seconds and starting claude takes
  two";
* a deep `read_pane` of a remote pane is an `ssh` round trip on a 15-second timeout;
* `start_agent` blocks until herdr reports the agent interactively ready — measured at 3.5s for
  agy — during which nothing else that client sends is looked at.

`83fa29c` cut the first from 45s to 4s by handing the watch to the poll. The second and third are
untouched by it, and every future slow handler starts the argument again.

## Why per pane, and not per message

Concurrency here is only safe where the operations are independent, and the unit of dependence is
the pane:

* a `send_text` split into chunks arrives as several messages, and only the last carries `submit`.
  Reordered, the pane gets the text out of order — or an Enter before the text;
* a client that types and then presses a key sends `send_text` then `send_keys`. That is one
  intention in two messages;
* `read_pane` after a send is how a client checks what landed. Answering it from before the send
  is answering the wrong question.

All of those name one pane, and a lock keyed by `pane_id` keeps every one of them in order at no
cost to anything happening elsewhere. `asyncio.Lock` hands the lock to waiters in the order they
asked for it, and each task's first await is that acquire, so arrival order is preserved within a
lane.

Messages with no pane keep one shared lane rather than one lane each. That is deliberate: the
launcher starts a roster one member at a time because `next_role_label` reads the live agent list
to pick "Architect 2", and two starts in flight can choose the same name. The client already waits
for `command_result` before sending the next, and the shared lane means the relay does not depend
on it doing so.

## What this changes that is visible

An exception raised inside a handler used to leave `handle_client` and close the connection.
Dispatched as a task, it is caught, logged with a traceback, and the connection stays up. That is
strictly better for a client that sent one bad message, and it is a behaviour change worth
knowing about when reading the logs.

The audit log and the relay log interleave messages from one client where they used to be strictly
sequential. Each line still carries the pane it is about.

## Bounds

A connection dispatches at most `HANDLER_INFLIGHT` handlers concurrently; past that the loop awaits
the message inline, which stops reading the socket and lets TCP push back. Without it a client
could open one handler per pane per message and have the relay spawn `herdr` subprocesses without
limit.

On disconnect the handler waits for its own in-flight tasks rather than cancelling them: a
cancelled `submit_paste` is a pane that was handed text and never given its Enter. Their sends to
the closed socket fail and are caught.

## What was rejected

**One task per message, no lock.** The failure is invisible in testing and obvious in production:
two chunks of one paste arriving out of order, an Enter before its text.

**A queue and a single worker per connection.** Same serialisation as today with more machinery.

**Threading the slow calls further.** They are already on threads; it is the `await` in the message
loop that blocks, not the subprocess.
