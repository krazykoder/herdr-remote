#!/usr/bin/env python3
"""Which pane a session says is arbitrating, and which sessions get to say it at all.

A participant is pinned by fingerprint — (host, agent, cwd) — because a pane id does not survive a
herdr restart. That is right for a session about to write to somebody and wrong for one that
stopped a week ago: the fingerprint cannot tell "the arbitrator came back" from "a different claude
in the same directory", so a paused session was adopting whichever pane a person next opened in
that checkout. The app then badged their own agent as arbitrating and asked them to confirm every
line they typed at it.

The rule this pins: only a session that could still write to somebody re-resolves. A stopped one
publishes the pane it last used and claims nobody.
"""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay

CWD = "/repo"
FP = ["local", "claude", CWD]
# The arbitrator's pane before a herdr restart renumbered everything.
GONE = "w1:pOLD"
# Somebody's own claude session in the same checkout, opened long afterwards.
STRANGER = "w9:p3"


def session(state, pause_reason=""):
    return {
        "id": "s-1", "state": state, "pause_reason": pause_reason, "conversation": "c1",
        "scope": "ship it", "triggers_json": json.dumps({"on_turn_end": True}), "warmup": 0,
        "mode": "detailed", "arbitrator_fp": json.dumps(FP), "arbitrator_pane": GONE,
        "budget_json": json.dumps({"max_steps": 8, "max_consecutive": 8,
                                   "max_wall_clock_ms": 60000}),
    }


class Claim(unittest.TestCase):
    def arbitrator(self, row):
        class FakeArb:
            roster = staticmethod(lambda sid: {})
            resume_plan = staticmethod(lambda sid: {"action": "arm", "prompt_id": None})

            class conn:
                # Two callers: the last valid decision (there is none) and the event watermark.
                @staticmethod
                def execute(sql, *a):
                    rows = [0] if "MAX(id)" in sql else None

                    class R:
                        fetchone = staticmethod(lambda: rows)
                    return R()

        live = [{"pane_id": STRANGER, "host": "local", "agent": "claude", "cwd": CWD,
                 "agent_status": "idle", "label": "mine"}]
        with patch.object(herdr_relay, "arbitration", FakeArb), \
             patch.object(herdr_relay, "live_panes", lambda: live), \
             patch.object(herdr_relay, "budget_left",
                          lambda s, now: {"steps": 8, "consecutive": 8, "ms": 60000}):
            return herdr_relay.arb_session_message(row)["session"]["arbitrator"]

    def test_a_paused_session_does_not_adopt_a_pane_it_has_never_written_to(self):
        got = self.arbitrator(session("paused", "user"))
        self.assertEqual(got["pane_id"], GONE)
        self.assertNotEqual(got["pane_id"], STRANGER)

    def test_a_running_session_still_follows_its_arbitrator_across_a_restart(self):
        # The case the fingerprint exists for. Nothing here should change.
        for state in ("active", "awaiting"):
            with self.subTest(state=state):
                self.assertEqual(self.arbitrator(session(state))["pane_id"], STRANGER)

    def test_the_fingerprint_is_published_either_way(self):
        # The thread reads the arbitrator's decisions by fingerprint, not by pane, so a stopped
        # session's bubbles must still be findable.
        got = self.arbitrator(session("paused", "user"))
        self.assertEqual([got["host"], got["agent"], got["cwd"]], FP)


if __name__ == "__main__":
    unittest.main()
