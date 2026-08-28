#!/usr/bin/env python3
"""Turning what an arbitrator wrote into something the relay is allowed to act on.

This module is the whole of N1. The relay never derives control flow from terminal prose — it may
locate a line range mechanically and it may transport text, but the decision to send anything to
anyone arrives here as JSON fields and leaves as an accepted record or a reject code. Nothing in
this file reads an agent's prose to work out what should happen next; `instruction` and `why` are
carried through untouched and never parsed (N2).

Pure by construction: no filesystem, no database, no herdr, no clock. `validate` is handed the raw
bytes somebody else read and a `session` dict somebody else assembled, and it returns a decision or
a reason it refused. That is what makes every rule in §12.3 of the spec testable as a plain
function call, and what keeps the one piece of code standing between an agent's output and a
keystroke in someone else's terminal small enough to read in a sitting.

  .workflow/03_specs/2026-08-17_arbitrator_spec.md §12

The caller does the impure half: read the drop-box, resolve each member's fingerprint to live panes
(§5.2), ask herdr for their statuses, and hand the results in. Resolution results arrive already
counted, because "exactly one live pane, unclaimed by another member" is a fact about the world at
a moment and not something this function could ask about without doing I/O.
"""
import json

# A drop-box file larger than this is not read as JSON at all. Generous for a handful of fields and
# small enough that a runaway agent writing its whole context into the file cannot cost anything.
MAX_RAW = 64 * 1024
# Prose caps. `why` is what a person reads to review a decision; `instruction` is what gets sent, so
# its cap is the relay's own send_text bound — SEND_TEXT_MAX in herdr_relay.py and in
# web/src/pairs_pure.js, which tests/test_arbitrator.py asserts against rather than trusting.
MAX_WHY = 2_000
MAX_INSTRUCTION = 4_000

# Rejected, not ignored. An unknown field is either an arbitrator inventing protocol or a prompt
# drifting from the schema, and both are things to find out about now rather than in the one run
# where the invented field was load-bearing.
FIELDS = frozenset((
    "session_id", "sequence", "gate", "to", "instruction", "why",
    "ambiguity", "decision_complexity",
))
GRADES = ("low", "medium", "high")

# The one gate that means "send nothing and fetch a person". There is deliberately no `stop` field:
# an arbitrator that wants the loop to end chooses this, which pauses, and the person resumes or
# cancels. Ending is the human's call.
CALL_HUMAN = "call_human"

# The other gate that sends nothing, and the opposite of the one above: nothing to do here, stay
# armed. Its absence is what turned a single spurious trigger into five wake-ups — an arbitrator
# that correctly saw there was nothing to arbitrate had to either write to somebody or stop the
# session, and writing to somebody is itself another turn end and another trigger.
HOLD = "hold"

# Neither writes to a member, so neither carries a target or an instruction. Both still carry a
# `why`: a decision nobody can read the reason for is not reviewable, whichever way it went.
NO_SEND = (CALL_HUMAN, HOLD)

# A pane acting on something is never written to (N7), and a decision naming one is rejected rather
# than held: by the time it finished, its state and the reason for the decision have both moved.
# `blocked` is here for the same reason and not because it is busy: that pane is sitting at a
# permission prompt, so a paste into it either answers the prompt or is swallowed by it. The
# executor stops it either way, but under `target_not_live` — which tells the arbitrator the pane
# has gone when it is in fact right there, waiting for a person, and sends the correction after the
# wrong problem.
BUSY = ("working", "blocked")

# Everything except \n and \t. An instruction is pasted into somebody's terminal, so an escape
# sequence in it is not prose — it is control of that terminal.
_ALLOWED_CONTROL = frozenset("\n\t")


def _control_chars(text):
    return any(ch < " " or ch == "\x7f" for ch in text if ch not in _ALLOWED_CONTROL)


def _prose(value):
    """The string, stripped — or None if this was never a string at all."""
    return value.strip() if isinstance(value, str) else None


def validate(raw, session):
    """Check one drop-box record against the session that asked for it.

    Returns `(decision, None)` on success, where `decision` is the parsed object, or
    `(None, reject_code)` — the codes of §12.3, checked in that order, first failure wins. The
    order is the contract: a caller re-prompting an arbitrator names the code, and a record with
    two things wrong should always name the same one.

    `session` carries what a decision has to agree with:

        {"session_id": str,
         "sequence":   int,                      # the sequence that was asked for
         "gates":      ["implement", ...],       # this session's gate names
         "roster":     {"member-1": {"panes": 1, "status": "idle"}, ...}}

    `panes` is how many live panes that member's fingerprint resolved to, already counted by the
    caller and already excluding panes claimed by another member. One is addressable; zero is gone
    and two is ambiguous, and both are the same refusal here — §5.2 exists so that nothing in this
    system guesses between two colleagues sharing a directory.

    An absent field fails at the check that owns it rather than at a generic "missing" pass: a
    record with no `gate` is not in this session's gate list, one with no `why` has no `why`, and
    one with no `ambiguity` is not one of the three grades. One code per field, whether it is wrong
    or simply not there.
    """
    if len(raw) > MAX_RAW:
        return None, "unparseable"
    try:
        # `raw` is whatever the caller read, and reading the drop-box as bytes is what makes the
        # cap above a byte count. json decodes UTF-8 itself and rejects invalid UTF-8 the same way
        # it rejects invalid JSON — one code for "this is not a record".
        doc = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None, "unparseable"
    if not isinstance(doc, dict):
        return None, "unparseable"

    if set(doc) - FIELDS:
        return None, "unknown_field"

    if doc.get("session_id") != session["session_id"]:
        return None, "session_mismatch"

    sequence = doc.get("sequence")
    # `isinstance(True, int)` is True in Python, and a bool here is a record built by something that
    # is not answering the question asked.
    if isinstance(sequence, bool) or not isinstance(sequence, int) \
            or sequence != session["sequence"]:
        return None, "sequence_mismatch"

    gate = doc.get("gate")
    if gate not in session["gates"]:
        return None, "unknown_gate"

    # Required under every gate, call_human included. A decision whose reason a person cannot read
    # is not reviewable, and call_human without one is the least useful message this can produce.
    why = _prose(doc.get("why"))
    if not why or len(why) > MAX_WHY:
        return None, "why_missing"

    has_target = "to" in doc or "instruction" in doc
    if gate in NO_SEND:
        if has_target:
            return None, "field_not_allowed"
        return doc, None

    if "to" not in doc or "instruction" not in doc:
        return None, "field_required"

    to = doc["to"]
    member = session["roster"].get(to) if isinstance(to, str) else None
    if member is None:
        return None, "unknown_member"
    if member.get("panes") != 1:
        return None, "target_not_live"
    if member.get("status") in BUSY:
        return None, "target_working"

    instruction = _prose(doc["instruction"])
    if not instruction:
        return None, "instruction_empty"
    if len(instruction) > MAX_INSTRUCTION:
        return None, "instruction_too_long"
    if _control_chars(instruction):
        return None, "instruction_control_chars"

    if doc.get("ambiguity") not in GRADES or doc.get("decision_complexity") not in GRADES:
        return None, "bad_enum"

    return doc, None
