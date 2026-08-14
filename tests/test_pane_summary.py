#!/usr/bin/env python3
"""The relay's copy of the closing-message detector, over the browser's fixtures.

relay/pane_summary.py is a port of the block in web/index.html, and two copies of one parser stay
in step only if one set of bytes proves both. These are the same panes tests/test_summary_detect.js
reads, asserted to the same line ranges — a harness that changes its glyphs, or a change made to
one copy and not the other, fails here.

The last group is the part the browser has no equivalent of: turning that range into the one line
a Lock Screen shows, and returning None when there is nothing to show so the caller falls back.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from pane_summary import final_message, is_user_input, last_user_input, summary_body


def fixture(name):
    text = (ROOT / "tests" / "fixtures" / name).read_text(encoding="utf-8")
    # split, not splitlines: the JS suite reads these with .split('\n'), and a line index that
    # disagrees between the two suites is exactly the drift this file exists to catch.
    return text.split("\n")


class FinalMessage(unittest.TestCase):
    def test_claude_closing_block_holds_no_tool_result(self):
        rows = fixture("pane_claude_done.txt")
        at = final_message(rows, "claude")
        self.assertIsNotNone(at)
        self.assertTrue(rows[at[0]].startswith("⏺ Ready. Name the change."), rows[at[0]])
        self.assertIn("Hooks, permission rules, env vars", rows[at[1]])
        picked = rows[at[0]:at[1] + 1]
        self.assertFalse([l for l in picked if l.lstrip().startswith("⎿")], "tool result leaked in")
        self.assertFalse([l for l in picked if l.startswith("✻")], "turn footer leaked in")

    def test_codex_keeps_the_blank_lines_between_paragraphs(self):
        rows = fixture("pane_codex_done.txt")
        at = final_message(rows, "codex")
        self.assertIsNotNone(at)
        self.assertTrue(rows[at[0]].startswith("• S2b review clean."), rows[at[0]])
        self.assertTrue(rows[at[1]].startswith("  Next: S3."), rows[at[1]])
        picked = rows[at[0]:at[1] + 1]
        self.assertIn("", picked, "the blank lines between paragraphs were dropped")
        self.assertFalse([l for l in picked if l.startswith("─")], "turn footer leaked in")

    def test_pi_reads_through_the_extension_gutter(self):
        # pi indents its whole transcript by one space and does not hang-indent a wrapped line, so
        # a heading and a table row in column 1 sit inside the message rather than ending it.
        rows = fixture("pane_pi_done.txt")
        at = final_message(rows, "pi")
        self.assertIsNotNone(at)
        self.assertTrue(rows[at[0]].startswith(" ⏺ Here's a breakdown"), rows[at[0]])
        self.assertTrue(rows[at[1]].startswith(" Nothing else changed."), rows[at[1]])
        picked = rows[at[0]:at[1] + 1]
        self.assertTrue([l for l in picked if l.startswith(" ### ")], "a heading ended it early")
        self.assertTrue([l for l in picked if l.startswith(" │ File")], "a table row ended it early")
        self.assertFalse([l for l in picked if l.startswith("~/")], "the status line leaked in")

    def test_agy_closing_message_carries_no_glyph(self):
        rows = fixture("pane_agy_done.txt")
        self.assertEqual(final_message(rows, "agy"), (37, 37))
        self.assertEqual(rows[37], "  OK")

    def test_agy_wrapped_tool_call_still_opens_the_message_under_it(self):
        # agy wraps its own tool-call lines and the continuation lands back in column 0 with no
        # glyph on it, so the marker above the closing message is two lines up rather than one.
        # Read off a live pane on 2026-08-14, where a long run's closing summary was being missed.
        rows = fixture("pane_agy_wrapped.txt")
        self.assertEqual(rows[5], "expand)")
        self.assertEqual(final_message(rows, "agy"), (7, 9))

    def test_agy_wrapped_prompt_is_not_a_reply(self):
        # A prompt too long for the pane continues indented, which is the shape of a reply. Only
        # the missing blank line tells them apart.
        rows = fixture("pane_agy_wrapped.txt")
        self.assertEqual(rows[2], "  and report what passed")
        self.assertEqual(final_message(rows[:4] + [">"], "agy"), None)

    def test_opencode_draws_no_boundary_so_nothing_is_guessed(self):
        # Its reasoning and its answer are both prose behind the same bar, and it prints nothing in
        # column 0 for a block to start on. Declared off rather than found empty.
        self.assertIsNone(final_message(fixture("pane_opencode_done.txt"), "opencode"))

    def test_a_block_that_ran_a_tool_is_not_a_message(self):
        rows = ["⏺ Committed as dd51cea.", "", "⏺ Bash(git status --short)",
                "  ⎿  M web/index.html", ""]
        self.assertIsNone(final_message(rows, "claude"))
        self.assertIsNone(final_message(["• Done.", "", "• Ran npm test", "  └ 19 passed"], "codex"))

    def test_pi_stopping_on_a_command_has_no_closing_message(self):
        rows = [" ⏺ Checking the tree first.", "", " $ git status --short",
                " M web/index.html", "", " Took 0.0s"]
        self.assertIsNone(final_message(rows, "pi"))

    def test_agy_startup_banner_is_not_a_message(self):
        rows = ["────────────────────", "> check the tree", "",
                "● Bash(git status --short) (ctrl+o to expand)", "", "────────────────────", ">"]
        self.assertIsNone(final_message(rows, "agy"))

    def test_an_unknown_harness_is_never_guessed_at(self):
        rows = ["◆ All finished.", "  and here is why"]
        self.assertIsNone(final_message(rows, "amp"))
        self.assertIsNone(final_message(rows, None))
        self.assertIsNone(final_message(rows, "claude"))    # right harness, wrong glyphs present


class UserInput(unittest.TestCase):
    def test_the_composer_at_the_foot_of_a_real_pane_is_a_prompt(self):
        claude, codex = fixture("pane_claude_done.txt"), fixture("pane_codex_done.txt")
        self.assertTrue(is_user_input(claude[11], "claude"), claude[11])
        self.assertTrue(is_user_input(codex[13], "codex"), codex[13])
        # And no line of tool output in either one is mistaken for one.
        self.assertEqual(len([r for r in claude if is_user_input(r, "claude")]), 1)
        self.assertEqual(len([r for r in codex if is_user_input(r, "codex")]), 1)

    def test_opencode_reads_only_the_users_own_lines(self):
        # One gutter for everything: prompts, tool output and the composer box all sit behind `┃`,
        # so which run a line belongs to is the whole question.
        rows = fixture("pane_opencode_done.txt")
        claimed = [r for i, r in enumerate(rows) if is_user_input(r, "opencode", rows, i)]
        self.assertEqual(claimed, [
            "  ┃  List out the last 10 commits in this repo",
            "  ┃  Explain the goal of last commit",
            "  ┃  Let’s explore the details of last commit",
        ])

    def test_opencode_a_read_starting_mid_block_claims_nothing(self):
        # 200 lines off the foot of a long pane routinely begins inside a block, with the `$` that
        # opened it above the window. Guessing "yours" painted a file listing as the user's words.
        rows = fixture("pane_opencode_done.txt")
        cut = next(i for i, r in enumerate(rows) if r.startswith("  ┃  f1762cb"))
        window = rows[cut:]
        claimed = [r for i, r in enumerate(window) if is_user_input(r, "opencode", window, i)]
        self.assertEqual(claimed, ["  ┃  Let’s explore the details of last commit"])

    def test_pi_marks_the_request_and_not_the_reasoning(self):
        rows = fixture("pane_pi_done.txt")
        self.assertEqual(last_user_input(rows, "pi"), 0)
        self.assertEqual(len([r for r in rows if is_user_input(r, "pi")]), 1)


class SummaryBody(unittest.TestCase):
    def test_the_closing_message_arrives_as_one_line_of_push_text(self):
        content = (ROOT / "tests" / "fixtures" / "pane_claude_done.txt").read_text(encoding="utf-8")
        body = summary_body(content, "claude")
        self.assertTrue(body.startswith("Ready. Name the change."), body)
        self.assertNotIn("\n", body)
        self.assertNotIn("⏺", body)

    def test_a_long_message_is_cut_to_what_a_lock_screen_shows(self):
        body = summary_body("⏺ " + "word " * 80, "claude", limit=40)
        self.assertEqual(len(body), 40)
        self.assertTrue(body.endswith("…"))

    def test_none_is_the_signal_to_fall_back(self):
        # Every case the caller has to handle: no harness profile, a pane that ended on a command,
        # and no content at all. On each of them the bottom of the pane is the better answer.
        self.assertIsNone(summary_body("◆ All finished.", "amp"))
        self.assertIsNone(summary_body("⏺ Bash(ls)\n  ⎿  web/", "claude"))
        self.assertIsNone(summary_body("", "claude"))
        self.assertIsNone(summary_body(None, "claude"))


if __name__ == "__main__":
    unittest.main()
