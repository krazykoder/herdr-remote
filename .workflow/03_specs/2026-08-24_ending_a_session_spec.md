# Spec: Ending a session

Decision log: `../02_architecture/decision_log/2026-08-24_ending_a_session.md`.
Class A. No wire change, no storage change, no new environment variable.

## 1. Vocabulary

| Term | Meaning |
|------|---------|
| **agent pane** | a pane in the `agents` list of the latest `agents` snapshot |
| **shell pane** | a pane in `shells`. Only ever populated when the relay runs `HERDR_ENABLE_TERMINAL=1` |
| **live** | `paneOf(id)` is non-null, i.e. present in `agents` or `shells` |
| **End** | the operation specified here: take a pane from live to closed |

## 2. Behaviour

### 2.1 End of an agent pane

1. Refuse, with a message, if the pane is not live.
2. Refuse, with a message, if `pane.status === 'blocked'`. The relay declines `send_text` at a
   blocked pane; End must not send into that refusal.
3. Send `/quit` via `submitText(pane_id, '/quit')`. If it returns false (socket not open), stop and
   report; nothing has been sent.
4. Record the pane as *ending*, with the time and the label it had.
5. `burstPoll(pane_id)`, so the snapshot that ends step 6 arrives in seconds rather than on the
   ordinary poll.

Then, on **every** subsequent `agents` snapshot, for each ending pane:

6. If the pane is now in `shells` — its agent has exited — send `exit` via `submitText` and stop
   watching it. This is 2.2 applied to a pane already being watched.
7. Else if the pane is no longer live at all, stop watching it. herdr closed the pane itself, which
   some harnesses do on `/quit`.
8. Else if more than `END_TIMEOUT_MS` (30 000) has passed since step 4, stop watching it and report
   that the pane did not quit and is still running.
9. Else keep watching.

### 2.2 End of a shell pane

Send `exit` via `submitText(pane_id, 'exit')`. One step; there is no agent to leave first. Refusals
as in 2.1 steps 1 and 3.

### 2.3 End with terminal mode off

When the connected relay does not send `shells` (`startOptions.terminal` is falsy), step 6 can never
fire: a quit agent pane leaves `agents` and is not listed anywhere. End therefore performs step 3
only, does not record the pane as ending, and its confirmation says the agent was quit and the pane
may remain. This is a stated ceiling, not a failure path.

### 2.4 End of a whole conversation

Ends every **live** member of the conversation, each by 2.1 or 2.2 as its kind requires. Members
that are already ended are skipped silently — they are the state this is aiming for. The
conversation record, its name and every transcript survive untouched; nothing is deleted and no
field is written.

## 3. What End never does

- Never records into a transcript. `/quit` and `exit` go through `submitText`, not `sendTextTo`, so
  `noteSent` is not called — matching `armQuit`, whose lines are also absent from the record. These
  are control keystrokes, not something the user said to an agent.
- Never deletes a conversation, a member, a transcript, a pair or a launcher tile.
- Never touches the relay's state documents.
- Never fires on one tap. Every End is an `arm-btn`, the two-tap promise CLS and QUIT already make.

## 4. Greying

Derived, never stored. A conversation is grey when none of its members is live — the condition
`convRosterHtml` and the landing card already compute. No new field, and correct again by itself
after a relay restart or a respawn.

## 5. Surfaces

| Where | Control | Scope |
|-------|---------|-------|
| Conversation roster row (`convRosterHtml`) | **End** | one member, live only |
| Conversation roster actions (`conv-roster-actions`) | **End** | every live member |
| Landing agent card (`agentCard`) | **End** | that pane |
| Landing terminal card (`terminalCard`) | **End** | that pane |

Roster row control order is **End, Remove, Open** on a live member and **Remove, Start again** on an
ended one — the destructive pair first, then the way in.

The pane header keeps `armQuit` unchanged. QUIT is "stop what is running here" and stays a distinct,
useful thing; End is "this session is over".

## 6. Failure modes

| Case | Result |
|------|--------|
| Socket closed | Nothing sent, message says so, pane not marked ending |
| Pane `blocked` | Nothing sent, message names the prompt as the thing to answer |
| Pane already gone | Nothing sent, no error — the goal state |
| Agent ignores `/quit` for 30 s | Watch dropped, message says it is still running. Pane unharmed |
| Agent closes its own pane on `/quit` | Watch dropped silently, no `exit` sent |
| Terminal mode off | `/quit` only, per 2.3 |
| End of an arbitration member | Allowed. The session's own guards already report a pane that has left; End is not special-cased into arbitration |

## 7. Acceptance

1. A live agent pane in a conversation, ended from its roster row, disappears from `agents`, then
   from `shells`, and its row becomes `no longer live` with **Start again** offered.
2. That conversation, once no member is live, is grey on the landing page with no field written.
3. **Start again** on the ended row brings the session back under the same name and role — the
   existing `convRespawn` path, unmodified.
4. A terminal ended from its landing card leaves `shells` and does not come back.
5. A blocked pane's End sends nothing and says why.
6. `/quit` and `exit` appear in no transcript.
