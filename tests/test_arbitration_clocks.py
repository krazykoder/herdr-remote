#!/usr/bin/env python3
"""The poll loop's half of §10's clocks.

`tests/test_arbitration.py` proves `due()` decides the right thing; this proves the relay does
anything with it. That glue is twelve lines and exactly the kind that fails on a name — the first
version of the arbitration broadcast shipped with a `NameError` that every unit test passed
through, because no unit test ever ran the relay's own module.
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay  # noqa: E402


class FakeArbitration:
    def __init__(self, due):
        self._due = due
        self.calls = []
        self.session_row = {"id": "s-1", "state": "active"}

    def due(self):
        return self._due

    def turn_ended(self, pane_id, entries, kind="turn_end"):
        self.calls.append((pane_id, kind, entries))
        return {"outcome": "prompted"}

    def running(self):
        return self.session_row

    def session(self, session_id):
        return self.session_row


class Clocks(unittest.TestCase):
    PANES = [{"pane_id": "p1", "agent": "claude"}, {"pane_id": "p2", "agent": "codex"}]

    def run_clocks(self, due):
        fake = FakeArbitration(due)
        with patch.object(herdr_relay, "arbitration", fake), \
             patch.object(herdr_relay, "arbitration_entries", lambda pane: [{"label": "m", "text": "x"}]), \
             patch.object(herdr_relay, "arb_broadcast", lambda s: None):
            herdr_relay.arbitrate_clocks(self.PANES)
        return fake

    def test_a_due_clock_becomes_the_same_call_a_turn_end_makes(self):
        # The clock decides *when* to ask. What is asked, the coalescing and the budget are one
        # path — the trigger's name is the only thing that differs.
        fake = self.run_clocks([{"member": "member-1", "pane_id": "p1", "trigger": "idle"}])
        self.assertEqual([("p1", "idle")], [(c[0], c[1]) for c in fake.calls])
        self.assertEqual([{"label": "m", "text": "x"}], fake.calls[0][2])

    def test_a_member_whose_pane_is_no_longer_in_the_snapshot_is_skipped(self):
        fake = self.run_clocks([{"member": "member-1", "pane_id": "gone", "trigger": "runtime"}])
        self.assertEqual([], fake.calls)

    def test_nothing_due_is_the_ordinary_poll_and_costs_nothing(self):
        self.assertEqual([], self.run_clocks([]).calls)

    def test_a_session_that_raises_does_not_take_the_poll_loop_with_it(self):
        # Arbitration is one feature among many. A relay that stopped telling everyone else what
        # their agents are doing because a clock failed would be the worse failure by far.
        class Exploding(FakeArbitration):
            def due(self):
                raise RuntimeError("database is locked")

        with patch.object(herdr_relay, "arbitration", Exploding([])):
            herdr_relay.arbitrate_clocks(self.PANES)       # must not raise


if __name__ == "__main__":
    unittest.main()
