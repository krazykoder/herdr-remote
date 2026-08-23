#!/usr/bin/env python3
"""What the arbitrator is shown, and whose words are in it.

A member is pinned by fingerprint — (host, agent, cwd) — because a pane id does not survive a
herdr restart. The cost of that is real and it bit: two panes running the same agent in the same
directory are one fingerprint, so a person's own Claude pane in a repo put their prompts into
another conversation's digest, headed with a member's label. The arbitrator was told a member had
said something nobody in that session ever said, and decided on it.

The rule this pins: a row from a pane that is live now and is not one of this session's panes is
not this session's. A row from a pane that is no longer live may be a member from before a
restart, and that is the whole reason the fingerprint exists, so it stays.
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay

CWD = "/repo"
MEMBERS = [
    {"member_id": "member-1", "host": "local", "agent": "agy", "cwd": CWD, "label": "test 1"},
    {"member_id": "member-2", "host": "local", "agent": "claude", "cwd": CWD, "label": "test claude"},
]
ROSTER = {"member-1": {"pane_id": "w1:p1"}, "member-2": {"pane_id": "w1:p2"}}


def turn(pane, agent, text):
    return {"pane_id": pane, "host": "local", "agent": agent, "cwd": CWD,
            "text": text, "origin": "agent"}


class Digest(unittest.TestCase):
    def entries(self, rows, live):
        class FakeArb:
            members = staticmethod(lambda sid: MEMBERS)
            roster = staticmethod(lambda sid: ROSTER)

        class FakeLog:
            def query(self, **kw):
                self.asked = kw
                return rows, False

        log = FakeLog()
        with patch.object(herdr_relay, "arbitration", FakeArb), \
             patch.object(herdr_relay, "conv_log", log), \
             patch.object(herdr_relay, "live_panes", lambda: [{"pane_id": p} for p in live]):
            return herdr_relay.arbitration_entries_of("s-1"), log

    def test_a_third_pane_on_the_same_fingerprint_is_not_in_the_digest(self):
        # w1:p9 is somebody's own Claude session in the same checkout. Same fingerprint as
        # member-2, no part of this conversation.
        rows = [turn("w1:p1", "agy", "reviewed it"),
                turn("w1:p9", "claude", "my thinking: on resume — change"),
                turn("w1:p2", "claude", "fixed it")]
        got, _ = self.entries(rows, live=["w1:p1", "w1:p2", "w1:p9"])
        self.assertEqual([e["text"] for e in got], ["reviewed it", "fixed it"])

    def test_the_member_keeps_its_label_and_the_stranger_takes_none(self):
        # The leak was worse than an extra row: the label comes from the fingerprint, so a
        # stranger's words arrived under a member's name.
        rows = [turn("w1:p9", "claude", "not a member")]
        got, _ = self.entries(rows, live=["w1:p1", "w1:p2", "w1:p9"])
        self.assertEqual(got, [])

    def test_a_pane_that_is_gone_is_still_the_member_it_was(self):
        # The case the fingerprint exists for: herdr restarted, the member's pane has a new id,
        # and everything it said before that is under the old one. Nothing live claims it, so it
        # is still this session's.
        rows = [turn("w1:pOLD", "claude", "said this before the restart"),
                turn("w1:p2", "claude", "and this after")]
        got, _ = self.entries(rows, live=["w1:p1", "w1:p2"])
        self.assertEqual([e["text"] for e in got],
                         ["said this before the restart", "and this after"])

    def test_the_digest_is_still_the_last_six(self):
        rows = [turn("w1:p2", "claude", str(i)) for i in range(20)]
        got, log = self.entries(rows, live=["w1:p1", "w1:p2"])
        self.assertEqual([e["text"] for e in got], [str(i) for i in range(14, 20)])
        # And the over-fetch is bounded rather than "read everything and filter".
        self.assertEqual(log.asked["last"], herdr_relay.ARB_DIGEST * herdr_relay.ARB_DIGEST_SCAN)

    def test_a_member_with_no_live_pane_does_not_widen_the_net(self):
        # member-2's pane has exited. That must not turn every live claude pane in the directory
        # into it — an exited member is a pause reason, not a licence to read a stranger.
        roster = {"member-1": {"pane_id": "w1:p1"}, "member-2": {"pane_id": ""}}
        rows = [turn("w1:p9", "claude", "not a member"), turn("w1:p1", "agy", "reviewed it")]

        class FakeArb:
            members = staticmethod(lambda sid: MEMBERS)
            roster = staticmethod(lambda sid: roster)

        class FakeLog:
            def query(self, **kw):
                return rows, False

        with patch.object(herdr_relay, "arbitration", FakeArb), \
             patch.object(herdr_relay, "conv_log", FakeLog()), \
             patch.object(herdr_relay, "live_panes",
                          lambda: [{"pane_id": p} for p in ("w1:p1", "w1:p9")]):
            got = herdr_relay.arbitration_entries_of("s-1")
        self.assertEqual([e["text"] for e in got], ["reviewed it"])


if __name__ == "__main__":
    unittest.main()
