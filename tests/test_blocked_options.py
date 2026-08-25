#!/usr/bin/env python3
"""What a blocked pane is offered as its choices.

herdr says a pane is blocked; the options come from reading it. Two shapes exist. claude's own
wording, matched on the strings it prints, which is what this relay has always sent. And a
numbered menu — `1. Yes, continue` — which is how codex asks everything, starting with the trust
prompt it opens with in a directory it has not seen before.

Until codex was read for its own menu it was sent claude's three strings as a fallback, so a
blocked codex arrived at the phone offering "yes, single permission" — not one of its choices,
and nothing at all when typed at a menu that wants a number.

The tail-and-sequence rule in detect_choices is the whole of its safety: an agent that wrote a
numbered list into its answer must not be read as a menu.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay


TRUST = """ codex-trust-probe > codex
> You are in /tmp/probe

  Do you trust the contents of this directory? Working with untrusted contents comes with higher
  risk of prompt injection.

› 1. Yes, continue
  2. No, quit

  Press enter to continue"""

APPROVE = """  Codex wants to run `rm -rf build`

› 1. Yes, proceed
  2. Yes, and don't ask again for this command
  3. No, and tell Codex what to do differently
"""


class ChoiceTests(unittest.TestCase):
    def test_the_trust_prompt_is_read_as_its_two_options(self):
        self.assertEqual(herdr_relay.detect_choices(TRUST),
                         ["1. Yes, continue", "2. No, quit"])

    def test_the_selected_row_keeps_its_words_and_loses_its_marker(self):
        # The glyph is the cursor, not part of the option, and it moves between frames.
        self.assertEqual(herdr_relay.detect_choices(APPROVE)[0], "1. Yes, proceed")
        self.assertEqual(len(herdr_relay.detect_choices(APPROVE)), 3)

    def test_a_redrawn_frame_lists_each_option_once(self):
        # A pane read mid-repaint holds the previous frame above the current one.
        doubled = TRUST + "\n" + TRUST
        self.assertEqual(herdr_relay.detect_choices(doubled),
                         ["1. Yes, continue", "2. No, quit"])

    def test_a_numbered_list_in_an_answer_is_not_a_menu(self):
        # Prose, far above the bottom of the pane, and no menu under it.
        prose = "Two things:\n\n1. Fix the test\n2. Then report back\n" + ("\n" * 40)
        self.assertIsNone(herdr_relay.detect_choices(prose))

    def test_a_menu_must_start_at_one_and_not_skip(self):
        self.assertIsNone(herdr_relay.detect_choices("  2. Second\n  3. Third\n"))
        self.assertIsNone(herdr_relay.detect_choices("  1. Only one\n"))

    def test_options_beyond_the_cap_are_dropped_rather_than_offered(self):
        many = "\n".join(f"  {n}. Option {n}" for n in range(1, 9))
        self.assertEqual(len(herdr_relay.detect_choices(many)), herdr_relay.CHOICE_MAX)


class BlockedOptionsTests(unittest.TestCase):
    def test_claude_is_still_matched_on_its_own_wording(self):
        text = "Do you want to proceed?\n  yes, single permission\n  no (tab to edit)"
        self.assertEqual(herdr_relay.blocked_options(text, "claude"),
                         herdr_relay.TOOL_OPTIONS)

    def test_codex_is_offered_the_menu_it_is_actually_showing(self):
        self.assertEqual(herdr_relay.blocked_options(TRUST, "codex"),
                         ["1. Yes, continue", "2. No, quit"])

    def test_a_pane_with_no_menu_and_no_claude_wording_is_offered_nothing(self):
        # Better than three buttons that do nothing: the prompt itself is still sent, and the
        # pane is still openable.
        self.assertEqual(herdr_relay.blocked_options("something else entirely", "codex"), [])
        self.assertEqual(herdr_relay.blocked_options("something else entirely", "claude"),
                         herdr_relay.TOOL_OPTIONS)


class ChoiceDigitTests(unittest.TestCase):
    def test_an_option_answers_with_its_number_alone(self):
        # The label came out of the pane. Typing it back is not how the menu is answered — and
        # the digit acts on its own, which is why respond sends no Enter after it.
        self.assertEqual(herdr_relay.choice_digit("2. No, quit"), "2")
        self.assertEqual(herdr_relay.choice_digit("1"), "1")

    def test_anything_else_is_left_to_the_allowlist(self):
        for text in ["yes, single permission", "y", "0", "12", "rm -rf /", ""]:
            self.assertIsNone(herdr_relay.choice_digit(text), text)


class SpawnWatchTests(unittest.TestCase):
    """The window a just-started pane is read in.

    herdr calls a codex sitting at its trust prompt `idle` — verified against herdr 0.8.0 with
    codex 0.145.0 — so the poll's blocked branch never fires and the first prompt of a pane's life
    is the one nobody is told about. The watch is what makes that pane get read at all.
    """

    def setUp(self):
        herdr_relay.spawn_watch.clear()

    def test_a_pane_nobody_started_is_never_read(self):
        self.assertFalse(herdr_relay.spawn_menu_pending("w9:p1", 100.0))

    def test_a_just_started_pane_is_read_until_its_window_passes(self):
        herdr_relay.spawn_watch["w9:p1"] = 100.0 + herdr_relay.SPAWN_WATCH_S
        self.assertTrue(herdr_relay.spawn_menu_pending("w9:p1", 100.0))
        self.assertFalse(herdr_relay.spawn_menu_pending(
            "w9:p1", 101.0 + herdr_relay.SPAWN_WATCH_S))

    def test_an_expired_window_is_forgotten_rather_than_kept(self):
        # The map's only cleanup: a pane that closed inside its window is never seen again, and
        # an entry per start would otherwise accumulate for the life of the process.
        herdr_relay.spawn_watch["w9:p1"] = 100.0
        herdr_relay.spawn_menu_pending("w9:p1", 200.0)
        self.assertNotIn("w9:p1", herdr_relay.spawn_watch)


if __name__ == "__main__":
    unittest.main()
