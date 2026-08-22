#!/usr/bin/env python3
"""A turn that ends before the pane paints what it is about to say.

A turn end is a *status* transition. Some harnesses flip to idle first and paint after — agy does it
every time — so the one read taken at the transition finds the previous turn and nothing else. There
is no second transition to be caught by, so the answer sat on screen for a person to read and was
absent from the record and from the arbitrator's prompt for ever. Worse than absent, in fact: the
detector read agy's own footer as its closing words, so the arbitrator was asked to decide on
`Gemini 3.7 Flash · medium · AI: Out of credits` and called a human over it three times.

This is the poll loop's half of the answer — the pane is read again on the ordinary poll until it
says something or the deadline passes. `tests/test_pane_summary.py` holds the other half, which is
that the footer is not a message.
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay  # noqa: E402


class FakeLog:
    """Stands in for ConversationLog, answering the one question the loop asks it."""

    def __init__(self, pending=0):
        self._pending = pending
        self.recorded = []

    def pending(self, pane, content):
        return self._pending

    def record_turn_end(self, pane, content, was, status, git=None):
        self.recorded.append((pane["pane_id"], content, was, status))
        return [1]


class FakeArbitration:
    def __init__(self):
        self.turns = []

    def decides(self, pane_id):
        return pane_id == "w1:pA"

    def session_of_pane(self, pane_id):
        self.turns.append(pane_id)
        return None


PANE = {"pane_id": "w1:p1", "agent": "agy", "agent_status": "idle", "label": "test 1"}


class LateTurns(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        herdr_relay.late_turns.clear()
        self.addCleanup(herdr_relay.late_turns.clear)
        self.reads = []

    def read(self, pane_id, remote=None):
        self.reads.append(pane_id)
        return self.content

    async def run_collect(self, log, panes, arbitration=None, content=""):
        self.content = content
        with patch.object(herdr_relay, "conv_log", log), \
             patch.object(herdr_relay, "arbitration", arbitration), \
             patch.object(herdr_relay, "read_pane_for_record", self.read), \
             patch.object(herdr_relay, "probe_git", lambda a: _none()):
            await herdr_relay.collect_late_turns(panes)

    async def test_a_pane_that_says_nothing_is_held_open(self):
        herdr_relay.late_turns["w1:p1"] = {"was": "working", "status": "idle",
                                           "until": _later()}
        log = FakeLog(pending=0)
        await self.run_collect(log, [PANE])
        self.assertEqual([], log.recorded, "nothing to write, so nothing written")
        self.assertIn("w1:p1", herdr_relay.late_turns, "and it is looked at again")

    async def test_what_it_says_late_is_recorded_and_arbitrated(self):
        herdr_relay.late_turns["w1:p1"] = {"was": "working", "status": "idle",
                                           "until": _later()}
        log, arb = FakeLog(pending=2), FakeArbitration()
        await self.run_collect(log, [PANE], arb, content="### Review: PASSED")
        self.assertEqual([("w1:p1", "### Review: PASSED", "working", "idle")], log.recorded)
        # The transition it was recorded under is the one that happened, not the poll that noticed.
        self.assertEqual(["w1:p1"], arb.turns, "and the arbitrator is asked now, not before")
        self.assertEqual({}, herdr_relay.late_turns)

    async def test_a_pane_that_never_speaks_is_recorded_at_the_deadline(self):
        herdr_relay.late_turns["w1:p1"] = {"was": "working", "status": "idle", "until": 0}
        log = FakeLog(pending=0)
        await self.run_collect(log, [PANE], content="only a footer")
        # The tail fallback is what a turn with nothing readable has always got, and a turn that
        # vanished is worse.
        self.assertEqual(1, len(log.recorded))
        self.assertEqual({}, herdr_relay.late_turns)

    async def test_a_pane_that_went_back_to_work_is_dropped(self):
        herdr_relay.late_turns["w1:p1"] = {"was": "working", "status": "idle", "until": _later()}
        log = FakeLog(pending=5)
        await self.run_collect(log, [dict(PANE, agent_status="working")])
        self.assertEqual([], log.recorded, "whatever it says now belongs to the turn it is in")
        self.assertEqual([], self.reads, "and it is not even read")
        self.assertEqual({}, herdr_relay.late_turns)

    async def test_a_pane_that_is_gone_is_dropped(self):
        herdr_relay.late_turns["w1:p1"] = {"was": "working", "status": "idle", "until": _later()}
        log = FakeLog(pending=5)
        await self.run_collect(log, [])
        self.assertEqual({}, herdr_relay.late_turns)

    async def test_the_arbitrator_is_never_held_back(self):
        # Its answer is a file that is already written, and none of it is on the pane. Holding it
        # would delay reading the drop box by the whole deadline for no possible gain.
        with patch.object(herdr_relay, "arbitration", FakeArbitration()):
            self.assertTrue(herdr_relay.decides("w1:pA"))
            self.assertFalse(herdr_relay.decides("w1:p1"))

    async def test_a_lookup_that_raises_does_not_decide_anything(self):
        class Broken:
            def decides(self, pane_id):
                raise RuntimeError("no db")
        with patch.object(herdr_relay, "arbitration", Broken()):
            self.assertFalse(herdr_relay.decides("w1:p1"))


async def _none():
    return None


def _later():
    import time
    return int(time.time() * 1000) + 60_000


if __name__ == "__main__":
    unittest.main()
