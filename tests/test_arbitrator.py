#!/usr/bin/env python3
"""What the relay will and will not act on.

This is T6 of the spec's test plan — one case for every reject code in §12.3 — plus the accepting
cases, plus the ordering the codes are checked in. That order is a contract and not an accident: a
runner re-prompting an arbitrator names the code it got back, so a record with two things wrong has
to name the same one every time or the re-prompt is a coin toss.

The reason this file can be plain function calls with no fixtures at all is the reason `validate`
is pure. Every rule about who may be sent what, and when, is exercised here without a database, a
pane, or a herdr.
"""
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from arbitrator import MAX_INSTRUCTION, MAX_RAW, MAX_WHY, validate

SESSION = {
    "session_id": "s-20260817-1103",
    "sequence": 7,
    "gates": ["implement", "review", "phase_plan", "call_human"],
    "roster": {
        "member-1": {"panes": 1, "status": "idle"},
        "member-2": {"panes": 1, "status": "done"},
        "member-busy": {"panes": 1, "status": "working"},
        "member-gone": {"panes": 0, "status": ""},
        "member-twin": {"panes": 2, "status": "idle"},
    },
}


# Passed as a field's value to leave that field out entirely, which is a different record from one
# carrying null — and several codes here are about a field being absent.
REMOVED = object()


def record(**over):
    """A decision that passes, with the field under test overridden.

    Written as a whole valid record on purpose: a test that builds up from nothing proves the code
    it names and nothing about the checks before it, and the order those run in is half the
    contract here.
    """
    doc = {
        "session_id": "s-20260817-1103",
        "sequence": 7,
        "gate": "review",
        "to": "member-2",
        "instruction": "Review the footer change for mobile layout regressions.",
        "why": "The implementation is ready for an independent check.",
        "ambiguity": "low",
        "decision_complexity": "low",
    }
    doc.update(over)
    return {k: v for k, v in doc.items() if v is not REMOVED}


def check(**over):
    return validate(json.dumps(record(**over)).encode(), SESSION)


class Accepts(unittest.TestCase):
    def test_a_well_formed_action_decision(self):
        doc, code = check()
        self.assertIsNone(code)
        self.assertEqual(doc["to"], "member-2")

    def test_call_human_without_a_target(self):
        doc, code = check(gate="call_human", to=REMOVED, instruction=REMOVED)
        self.assertIsNone(code)
        self.assertEqual(doc["gate"], "call_human")

    def test_an_idle_target_is_addressable_as_much_as_a_done_one(self):
        # Both are a composer waiting. `working` is the one that is not, and it has its own test.
        self.assertIsNone(check(to="member-1")[1])

    def test_prose_is_carried_through_untouched(self):
        # N2: instruction and why are never parsed, and never rewritten either. A validator that
        # normalised them would be editing what lands in someone's terminal.
        text = "  Ship it.\n\nSecond paragraph.  "
        doc, code = check(instruction=text)
        self.assertIsNone(code)
        self.assertEqual(doc["instruction"], text)


class Rejects(unittest.TestCase):
    def assertCode(self, expected, result):
        doc, code = result
        self.assertIsNone(doc, "a rejected record must not be handed back as a decision")
        self.assertEqual(expected, code)

    def test_unparseable_not_json(self):
        self.assertCode("unparseable", validate(b"not json at all", SESSION))

    def test_unparseable_not_an_object(self):
        self.assertCode("unparseable", validate(b'["review", "member-2"]', SESSION))

    def test_unparseable_invalid_utf8(self):
        self.assertCode("unparseable", validate(b'{"why": "\xff\xfe"}', SESSION))

    def test_unparseable_over_the_size_cap(self):
        # Checked before parsing: the point of a cap is to not hand a parser the whole thing.
        self.assertCode("unparseable", validate(b"x" * (MAX_RAW + 1), SESSION))

    def test_unknown_field(self):
        # Rejected, not ignored — an invented field is either protocol drift or an arbitrator
        # trying to do something the schema does not let it say.
        self.assertCode("unknown_field", check(stop=True))

    def test_session_mismatch(self):
        self.assertCode("session_mismatch", check(session_id="s-somebody-elses"))

    def test_session_mismatch_when_absent(self):
        self.assertCode("session_mismatch", check(session_id=REMOVED))

    def test_sequence_mismatch(self):
        self.assertCode("sequence_mismatch", check(sequence=6))

    def test_sequence_mismatch_when_a_string(self):
        self.assertCode("sequence_mismatch", check(sequence="7"))

    def test_sequence_mismatch_when_a_bool(self):
        # `True == 1` in Python, so a bare isinstance(int) check would let True through as
        # sequence 1. It is never a sequence and always a record built by something confused.
        self.assertCode("sequence_mismatch", validate(
            json.dumps(record(sequence=REMOVED) | {"sequence": True}).encode(),
            {**SESSION, "sequence": 1}))

    def test_unknown_gate(self):
        self.assertCode("unknown_gate", check(gate="deploy"))

    def test_unknown_gate_when_absent(self):
        self.assertCode("unknown_gate", check(gate=REMOVED))

    def test_why_missing(self):
        self.assertCode("why_missing", check(why=REMOVED))

    def test_why_missing_when_only_whitespace(self):
        self.assertCode("why_missing", check(why="   \n  "))

    def test_why_missing_when_too_long(self):
        self.assertCode("why_missing", check(why="x" * (MAX_WHY + 1)))

    def test_why_is_required_for_call_human_too(self):
        # The whole value of call_human is the sentence saying why a person is wanted.
        self.assertCode("why_missing",
                        check(gate="call_human", to=REMOVED, instruction=REMOVED, why=REMOVED))

    def test_field_not_allowed_target_on_call_human(self):
        self.assertCode("field_not_allowed", check(gate="call_human", instruction=REMOVED))

    def test_field_not_allowed_instruction_on_call_human(self):
        self.assertCode("field_not_allowed", check(gate="call_human", to=REMOVED))

    def test_field_required_no_target(self):
        self.assertCode("field_required", check(to=REMOVED))

    def test_field_required_no_instruction(self):
        self.assertCode("field_required", check(instruction=REMOVED))

    def test_unknown_member(self):
        self.assertCode("unknown_member", check(to="member-9"))

    def test_unknown_member_when_not_a_string(self):
        self.assertCode("unknown_member", check(to=3))

    def test_target_not_live_when_gone(self):
        self.assertCode("target_not_live", check(to="member-gone"))

    def test_target_not_live_when_two_panes_match(self):
        # §5.2: two claude panes in one directory are two colleagues. Guessing between them would
        # put one agent's work in the other's terminal, so nothing guesses.
        self.assertCode("target_not_live", check(to="member-twin"))

    def test_target_working(self):
        # N7. Rejected, never queued: by the time it finishes, its state and the reason for this
        # decision have both moved, and a stale instruction is worse than none.
        self.assertCode("target_working", check(to="member-busy"))

    def test_instruction_empty(self):
        self.assertCode("instruction_empty", check(instruction="   \t \n "))

    def test_instruction_too_long(self):
        self.assertCode("instruction_too_long", check(instruction="x" * (MAX_INSTRUCTION + 1)))

    def test_instruction_control_chars(self):
        # An instruction is pasted into a terminal. An escape sequence in it is not prose.
        self.assertCode("instruction_control_chars", check(instruction="clear\x1b[2Jthis"))

    def test_instruction_keeps_newlines_and_tabs(self):
        self.assertIsNone(check(instruction="one\n\ttwo")[1])

    def test_bad_enum_ambiguity(self):
        self.assertCode("bad_enum", check(ambiguity="unsure"))

    def test_bad_enum_complexity(self):
        self.assertCode("bad_enum", check(decision_complexity=REMOVED))


class NeverFromProse(unittest.TestCase):
    """N1, the half of it that lives here: prose cannot stand in for a field.

    T5 proves the executor ignores approving language in a transcript. This proves the same thing
    one layer earlier — the words that would fool a keyword matcher carry no weight at all in the
    one place a decision is actually made, whether they arrive as the instruction, the reason, or
    the whole file.
    """

    APPROVING = ("accepted", "LGTM", "approved", "ship it")

    def test_approving_prose_is_not_a_decision(self):
        for text in self.APPROVING:
            with self.subTest(text=text):
                self.assertEqual("unparseable", validate(text.encode(), SESSION)[1])

    def test_approving_prose_does_not_supply_a_missing_gate(self):
        for text in self.APPROVING:
            with self.subTest(text=text):
                self.assertEqual("unknown_gate", check(gate=REMOVED, why=text,
                                                       instruction=text)[1])

    def test_approving_prose_does_not_make_a_working_member_writable(self):
        self.assertEqual("target_working",
                         check(to="member-busy", why="approved", instruction="ship it")[1])


class Order(unittest.TestCase):
    """First failure wins, in the order §12.3 lists. A re-prompt names one thing, not a pile."""

    def test_an_unknown_field_is_named_before_a_wrong_session(self):
        self.assertEqual("unknown_field", check(stop=True, session_id="nope")[1])

    def test_a_wrong_session_is_named_before_a_wrong_gate(self):
        self.assertEqual("session_mismatch", check(session_id="nope", gate="deploy")[1])

    def test_a_missing_why_is_named_before_a_working_target(self):
        self.assertEqual("why_missing", check(why=REMOVED, to="member-busy")[1])

    def test_a_working_target_is_named_before_a_bad_instruction(self):
        self.assertEqual("target_working", check(to="member-busy", instruction="")[1])


class Parity(unittest.TestCase):
    def test_the_instruction_cap_is_the_relays_own_send_text_bound(self):
        # An instruction longer than the relay will send is a decision that validates and then
        # fails at the last step, which is the worst place to find out. One number, two files.
        relay = (ROOT / "relay" / "herdr_relay.py").read_text()
        self.assertRegex(relay, rf"SEND_TEXT_MAX = {MAX_INSTRUCTION}\b")


if __name__ == "__main__":
    unittest.main()
