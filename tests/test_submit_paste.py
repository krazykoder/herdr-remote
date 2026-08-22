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
        for name, value in (("SUBMIT_POLL", 0.001), ("SUBMIT_POLL_SLOW", 0.002), ("SUBMIT_TIMEOUT", 0.5),
                            ("SEND_SETTLE", 0.001), ("SEND_SETTLE_MAX", 0.001)):
            p = patch.object(herdr_relay, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.calls = []

    def run_paste(self, statuses, text="hello", shell=False, agent=None):
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

        shells = {"w1:p1"} if shell else set()
        cache = {"w1:p1": {"agent": agent}} if agent else {}
        with patch.object(herdr_relay, "pane_agent_status", status), \
             patch.object(herdr_relay, "shell_panes", shells), \
             patch.object(herdr_relay, "agent_cache", cache), \
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
        # `unknown` is the literal a real `herdr pane list` returns for a pane carrying no agent,
        # which is what a TUI that has not finished starting looks like. Pressing Enter at that is
        # the original bug: the keystroke goes into a terminal with nothing listening, and no fixed
        # delay ever covered a boot.
        self.assertTrue(self.run_paste(["unknown", "unknown", "unknown", "idle", "working"]))
        self.assertEqual(len(self.enters()), 1)

    def test_a_pane_herdr_does_not_list_is_waited_for_too(self):
        # The other spelling of "no status": pane_agent_status returns "" for a pane herdr did not
        # list, or for a call that failed outright. Same handling — never press blind.
        self.assertTrue(self.run_paste(["", "", "idle", "working"]))
        self.assertEqual(len(self.enters()), 1)

    def test_a_pane_that_swallowed_the_first_enter_is_pressed_again(self):
        # The paste-layout case: the pane is up and idle, the Enter went into a composer still
        # redrawing itself, and nothing happened. One more press is the whole fix.
        self.assertTrue(self.run_paste(["idle", "idle", "idle", "working"]))
        self.assertEqual(len(self.enters()), 3)

    def test_a_slow_agent_is_still_watched_after_the_presses_are_spent(self):
        # The presses are spent in under two seconds; SUBMIT_TIMEOUT is eight. An agent that takes
        # longer than the presses to report `working` — antigravity does — was being called
        # unconfirmed while its Enter was still being processed, which ended an arbitration session
        # whose starter prompt had in fact landed. Pressing stops; watching does not.
        idle_past_the_presses = ["idle"] * (herdr_relay.SUBMIT_TRIES + 4) + ["working"]
        self.assertTrue(self.run_paste(idle_past_the_presses))
        self.assertEqual(len(self.enters()), herdr_relay.SUBMIT_TRIES)

    def test_a_harness_known_to_be_slow_is_watched_past_the_shared_window(self):
        # agy reports `idle` for tens of seconds after an Enter it did take, because it repaints
        # its whole frame before its status moves. Giving up at the shared window paused an
        # arbitration session with `send_unconfirmed` over a message the member went on to answer,
        # so the window is per harness — SUBMIT_SLOW, read off the poll's own snapshot.
        # Idle for 0.8s against a shared window of 0.5s and an agy window of 5s: the same pane
        # either gives up or waits, and the harness is the only difference.
        long_idle = ["idle"] * 40 + ["working"]
        with patch.object(herdr_relay, "SUBMIT_SLOW", {"agy": 5.0}), \
             patch.object(herdr_relay, "SUBMIT_POLL", 0.02):
            self.assertFalse(self.run_paste(long_idle))
            self.assertTrue(self.run_paste(long_idle, agent="agy"))

    def test_the_watching_slows_down_once_the_presses_are_spent(self):
        # A long window at the fast rate is a `herdr pane list` subprocess every 0.4s for as long
        # as it runs — a hundred process spawns, over SSH for a remote pane, to learn one bit. The
        # presses all fall inside the fast phase; after it there is nothing to do but watch.
        with patch.object(herdr_relay, "SUBMIT_POLL", 0.4), \
             patch.object(herdr_relay, "SUBMIT_POLL_SLOW", 2.0), \
             patch.object(herdr_relay, "SUBMIT_FAST", 4.0):
            self.assertEqual(herdr_relay.submit_delay(0.0), 0.4)
            self.assertEqual(herdr_relay.submit_delay(3.9), 0.4)
            self.assertEqual(herdr_relay.submit_delay(4.0), 2.0)
            self.assertEqual(herdr_relay.submit_delay(44.0), 2.0)

    def test_an_unknown_pane_gets_the_shared_window(self):
        # A pane this relay has never listed has no harness to look up, and the fallback is the
        # number that was always there rather than the longest one anybody registered.
        self.assertEqual(herdr_relay.submit_window("w9:p9"), herdr_relay.SUBMIT_TIMEOUT)

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


class SubmitIntoAShell(unittest.TestCase):
    """A pane with no agent takes the Enter straight away.

    Every rule above is about an agent's TUI: whether it has booted, whether it has finished laying
    out a paste, whether the box on screen is a permission prompt. A shell has none of those. It
    also has no `agent_status` for the loop to watch — a real `pane list` says `unknown` for a pane
    carrying no agent — so watching it means waiting out SUBMIT_TIMEOUT and then giving up with the
    command sitting unsent at the prompt. That is the bug this class exists to keep fixed.
    """

    def setUp(self):
        for name, value in (("SUBMIT_POLL", 0.001), ("SUBMIT_POLL_SLOW", 0.002), ("SUBMIT_TIMEOUT", 0.5),
                            ("SEND_SETTLE", 0.001), ("SEND_SETTLE_MAX", 0.001)):
            p = patch.object(herdr_relay, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.calls = []

    def submit(self, text="ls -la"):
        def herdr(*args, remote=None):
            self.calls.append(args)
            return ""

        def status(pane_id, remote=None):
            # The status a shell really reports, so a regression that goes back to watching it
            # fails here rather than passing on a friendlier fake.
            return "unknown"

        with patch.object(herdr_relay, "shell_panes", {"w1:p1"}), \
             patch.object(herdr_relay, "pane_agent_status", status), \
             patch.object(herdr_relay, "run_herdr", herdr):
            return asyncio.run(herdr_relay.submit_paste("w1:p1", text))

    def test_the_command_is_pasted_and_entered(self):
        took = self.submit()
        self.assertTrue(took, "a shell always takes an Enter — there is nothing to be unsure about")
        self.assertEqual([c[:3] for c in self.calls], [
            ("pane", "send-text", "w1:p1"),
            ("pane", "send-keys", "w1:p1"),
        ])
        self.assertEqual(self.calls[1][3], "Enter")

    def test_the_pane_is_not_polled_at_all(self):
        # Not merely "it works anyway": a shell has no status worth a `pane list` round trip, and
        # the point of the branch is that it does not make one.
        polls = []

        def status(pane_id, remote=None):
            polls.append(pane_id)
            return "unknown"

        def herdr(*args, remote=None):
            return ""

        with patch.object(herdr_relay, "shell_panes", {"w1:p1"}), \
             patch.object(herdr_relay, "pane_agent_status", status), \
             patch.object(herdr_relay, "run_herdr", herdr):
            asyncio.run(herdr_relay.submit_paste("w1:p1", "pwd"))
        self.assertEqual(polls, [])

    def test_an_agent_pane_is_still_watched(self):
        # The guard is membership, not a mode: with terminal mode off `shell_panes` is empty, and
        # every pane goes the long way exactly as before.
        seen = iter(["idle", "working"])
        last = ["working"]

        def status(pane_id, remote=None):
            try:
                last[0] = next(seen)
            except StopIteration:
                pass
            return last[0]

        calls = []

        def herdr(*args, remote=None):
            calls.append(args)
            return ""

        with patch.object(herdr_relay, "shell_panes", set()), \
             patch.object(herdr_relay, "pane_agent_status", status), \
             patch.object(herdr_relay, "run_herdr", herdr):
            self.assertTrue(asyncio.run(herdr_relay.submit_paste("w1:p1", "hello")))
        self.assertEqual(len([c for c in calls if c[:2] == ("pane", "send-keys")]), 1)


if __name__ == "__main__":
    unittest.main()
