#!/usr/bin/env python3
"""Getting a pasted message actually submitted.

This is the third design for one line of behaviour, and the first two each shipped as a fix for a
real bug and became the next one. The history is the reason this file exists:

  1. The browser sent the text and then its own `send_keys ["Enter"]`, held apart by a fixed
     `SEND_SETTLE` in the relay. Fine for a running TUI. Useless for a starting one — an agent
     that has been alive 200 ms has no composer yet, and the Enter goes nowhere. That is the New
     agent dialog's opening prompt, every single time.
  2. So the relay served `submit` with herdr's `pane run`, text and Enter in one call. Nothing
     could arrive between them, and nothing separated them either — and herdr pastes with bracketed
     paste, so a TUI still laying out a transferred payload dropped the Enter. Short generated
     commands submitted; long or hand-edited ones sat in the composer.
  3. Both are the same mistake at different scales: choosing a duration for something with no fixed
     duration. A boot is seconds. A paste is milliseconds. No constant covers both.

So the relay watches `agent_status` instead of a clock, and what is proven here is that watching:
that it waits for a pane that is not ready, presses again for one that did not take it, stops when
it did, gives up rather than pressing forever — and never, under any of those, presses Enter at a
pane that is `blocked`, because that box is a permission prompt and Enter accepts its default.
"""
import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay


class SubmitPaste(unittest.TestCase):
    def setUp(self):
        # The real numbers are seconds. Nothing here is about their size — only about the order of
        # what happens — so they are shrunk to keep the suite instant.
        for name, value in (("SUBMIT_POLL", 0.001), ("SUBMIT_TIMEOUT", 0.5),
                            ("SEND_SETTLE", 0.001), ("SEND_SETTLE_MAX", 0.001)):
            p = patch.object(herdr_relay, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.calls = []

    def run_paste(self, statuses, text="hello"):
        """Drive one submit_paste over a scripted sequence of pane statuses.

        The last entry repeats once the script runs out, which is how "and it stays that way" is
        expressed — a pane that never moves is the case the bound exists for.
        """
        seen = iter(statuses)
        last = [statuses[-1]]

        def status(pane_id, remote=None):
            try:
                last[0] = next(seen)
            except StopIteration:
                pass
            return last[0]

        def herdr(*args, remote=None):
            self.calls.append(args)
            return ""

        with patch.object(herdr_relay, "pane_agent_status", status), \
             patch.object(herdr_relay, "run_herdr", herdr):
            took = asyncio.run(herdr_relay.submit_paste("w1:p1", text))
        return took

    def enters(self):
        return [c for c in self.calls if c[:2] == ("pane", "send-keys")]

    def test_the_text_is_pasted_before_anything_is_pressed(self):
        self.run_paste(["idle", "working"])
        self.assertEqual(self.calls[0][:3], ("pane", "send-text", "w1:p1"))

    def test_a_pane_that_takes_it_is_pressed_once_and_no_more(self):
        self.assertTrue(self.run_paste(["idle", "working"]))
        self.assertEqual(len(self.enters()), 1)

    def test_a_starting_agent_is_waited_for_rather_than_pressed_into(self):
        # herdr reports no status at all for a pane whose TUI has not finished starting. Pressing
        # Enter at that is the original bug: the keystroke goes into a terminal with nothing
        # listening, and no fixed delay ever covered a boot.
        self.assertTrue(self.run_paste(["", "", "", "idle", "working"]))
        self.assertEqual(len(self.enters()), 1)

    def test_a_pane_that_swallowed_the_first_enter_is_pressed_again(self):
        # The paste-layout case: the pane is up and idle, the Enter went into a composer still
        # redrawing itself, and nothing happened. One more press is the whole fix.
        self.assertTrue(self.run_paste(["idle", "idle", "idle", "working"]))
        self.assertEqual(len(self.enters()), 3)

    def test_a_pane_that_never_moves_is_given_up_on_rather_than_hammered(self):
        took = self.run_paste(["idle"])
        self.assertFalse(took)
        self.assertLessEqual(len(self.enters()), herdr_relay.SUBMIT_TRIES)

    def test_a_blocked_pane_is_never_pressed(self):
        # The one outcome worse than a message that did not send: a blocked pane is showing a
        # permission prompt, and Enter accepts whatever it has selected.
        self.assertTrue(self.run_paste(["blocked"]))
        self.assertEqual(self.enters(), [])

    def test_a_pane_that_blocks_after_the_first_press_is_not_pressed_again(self):
        self.assertTrue(self.run_paste(["idle", "blocked"]))
        self.assertEqual(len(self.enters()), 1)

    def test_a_busy_pane_is_pressed_once_and_not_watched(self):
        # A message queued behind what an agent is already doing. It will say `working` whether the
        # Enter landed or not, so there is nothing to watch — and saying "it took" would be a claim
        # this cannot support.
        took = self.run_paste(["working"])
        self.assertFalse(took)
        self.assertEqual(len(self.enters()), 1)


if __name__ == "__main__":
    unittest.main()
