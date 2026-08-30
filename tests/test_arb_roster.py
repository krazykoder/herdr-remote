#!/usr/bin/env python3
"""Who may be in one roster, now that the picker offers every pane in the project.

The app used to draw the arbitrator from panes *outside* the conversation, so "an agent arbitrating
itself" was a roster no client could build and `_enrol`'s duplicate check could only ever catch a
client bug. That filter is gone — which pane is well placed to referee is the person's judgement —
so the check is now load-bearing, and these pin it: a session where one pane is both a member being
written to and the thing deciding who is written to next deadlocks on its own first trigger.
"""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from arbitration import Arbitration, ArbiterError


def pane(pane_id, agent="claude", cwd="/w", status="idle"):
    return {"pane_id": pane_id, "agent": agent, "cwd": cwd, "agent_status": status,
            "label": pane_id, "host": "local"}


class Roster(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.live = [pane("p1"), pane("p2", agent="codex"), pane("pA")]
        self.sent = []
        self.arb = Arbitration(str(Path(self.tmp.name) / "a.sqlite3"),
                               send=lambda pid, text: (self.sent.append(pid), True)[1],
                               panes=lambda: list(self.live),
                               notify=lambda s, reason: None,
                               clock=lambda: 1_000_000)
        self.addCleanup(self.arb.close)

    def start(self, members, arbitrator):
        return self.arb.start(conversation="c1", members=members, arbitrator=arbitrator,
                              scope="Ship the footer change.")

    def test_an_agent_may_not_arbitrate_itself(self):
        with self.assertRaises(ArbiterError) as caught:
            self.start([self.live[0], self.live[1]], self.live[0])
        self.assertEqual(caught.exception.code, "duplicate_participant")

    def test_one_pane_may_not_be_both_members(self):
        # Said in the dialog too, where the message is readable. This is the same rule as law.
        with self.assertRaises(ArbiterError) as caught:
            self.start([self.live[0], self.live[0]], self.live[2])
        self.assertEqual(caught.exception.code, "duplicate_participant")

    def test_three_distinct_panes_are_enrolled(self):
        session = self.start([self.live[0], self.live[1]], self.live[2])
        roster = self.arb.members(session["id"])
        self.assertEqual([m["pane_id"] for m in roster], ["p1", "p2"])
        self.assertEqual(session["arbitrator_pane"], "pA")

    def test_a_busy_arbitrator_is_still_the_refusal_it_was(self):
        # The picker no longer hides a working pane — whether it can take the brief is this
        # answer, at the moment of the send, rather than a guess three seconds old.
        self.live[2]["agent_status"] = "working"
        with self.assertRaises(ArbiterError) as caught:
            self.start([self.live[0], self.live[1]], self.live[2])
        self.assertEqual(caught.exception.code, "arbitrator_busy")


if __name__ == "__main__":
    unittest.main()
