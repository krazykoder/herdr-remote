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
import json
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


# The relay's own normalised agent, which is what the poll loop hands both of the functions
# below — `status`, not herdr's raw `agent_status`. Fed the raw shape, these tests passed
# while the code read a key that was never there: every held turn looked like a pane back
# at work and was dropped, and no send was ever confirmed by one going back to work.
PANE = {"pane_id": "w1:p1", "agent": "agy", "status": "idle", "label": "test 1"}


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
        await self.run_collect(log, [dict(PANE, status="working")])
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


class Socket:
    """A client, holding what it was told and whether it is still there."""

    def __init__(self, open_=True):
        self.sent, self.open = [], open_

    async def send(self, payload):
        if not self.open:
            raise RuntimeError("closed")
        self.sent.append(json.loads(payload))


class PendingSends(unittest.IsolatedAsyncioTestCase):
    """A send the relay could not prove landed, answered by the next thing the pane does.

    Both reasons resolve themselves: a pane already working takes the queued text when it finishes,
    and a pane that never moved moves when it takes it. The proof is a transition, so a queued
    message needs two — out of the turn it was queued behind, then back to work — and a pane that
    was idle needs only the second.
    """

    def setUp(self):
        herdr_relay.pending_sends.clear()
        self.addCleanup(herdr_relay.pending_sends.clear)
        self.ws = Socket()

    def wait(self, idled=True, until=None):
        herdr_relay.pending_sends["w1:p1"] = {
            "ws": self.ws, "until": _later() if until is None else until, "idled": idled}

    async def test_a_pane_going_to_work_is_the_confirmation(self):
        self.wait(idled=True)
        await herdr_relay.confirm_pending_sends([dict(PANE, status="working")])
        self.assertEqual([True], [m["ok"] for m in self.ws.sent])
        self.assertEqual([False], [m["pending"] for m in self.ws.sent])
        self.assertEqual({}, herdr_relay.pending_sends)

    async def test_a_queued_message_waits_for_the_turn_it_is_behind_to_end(self):
        self.wait(idled=False)
        # Still working on what it was doing when the text arrived. That is not the confirmation —
        # it is the same `working` the pane was already reporting.
        await herdr_relay.confirm_pending_sends([dict(PANE, status="working")])
        self.assertEqual([], self.ws.sent)
        await herdr_relay.confirm_pending_sends([dict(PANE, status="idle")])
        self.assertEqual([], self.ws.sent, "the turn ended; nothing has been taken yet")
        await herdr_relay.confirm_pending_sends([dict(PANE, status="working")])
        self.assertEqual([True], [m["ok"] for m in self.ws.sent])

    async def test_a_pane_that_never_moves_is_given_up_on_at_the_deadline(self):
        self.wait(idled=True, until=0)
        await herdr_relay.confirm_pending_sends([PANE])
        self.assertEqual([False], [m["ok"] for m in self.ws.sent])
        self.assertIn("never confirmed", self.ws.sent[0]["message"])
        self.assertEqual({}, herdr_relay.pending_sends)

    async def test_a_pane_that_vanished_is_dropped_without_a_word(self):
        # There is nothing left to confirm and nothing a person could do about it.
        self.wait()
        await herdr_relay.confirm_pending_sends([])
        self.assertEqual([], self.ws.sent)
        self.assertEqual({}, herdr_relay.pending_sends)

    async def test_a_client_that_hung_up_does_not_break_the_poll(self):
        # This wait is minutes long. A phone that locked in the middle of it is the ordinary end.
        self.ws.open = False
        self.wait()
        await herdr_relay.confirm_pending_sends([dict(PANE, status="working")])
        self.assertEqual({}, herdr_relay.pending_sends)


async def _none():
    return None


def _later():
    import time
    return int(time.time() * 1000) + 60_000


if __name__ == "__main__":
    unittest.main()
