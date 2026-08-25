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

from pane_summary import (block_span, final_message, is_user_input, last_user_input, pane_messages,
                          profile_for, summary_body, turn_messages, user_input_lines)


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

    def test_a_result_glyph_quoted_in_prose_does_not_make_a_message_a_tool_call(self):
        # Read off a live pane on 2026-08-22, where this cost a whole message: an agent writing
        # *about* the terminal quoted claude's own result glyph, the wrap put it at the start of a
        # line, and the summary was read as a tool execution — not shown, and never recorded. A
        # real result hangs directly under the call that produced it, so a blank line above the
        # glyph is what says this one is prose.
        rows = ["⏺ Pinned as a fixture, asserted from both copies.", "",
                "  Verdict: go. No code change needed.", "",
                "  ⎿ is claude's result glyph; agy's profile has result: [], so the reply gets",
                "  swallowed into the prompt run above it.", ""]
        self.assertEqual(final_message(rows, "claude"), (0, 5))

    def test_a_result_glyph_under_the_call_still_means_a_tool_ran(self):
        rows = ["⏺ Bash(git status --short)", "  ⎿  M web/index.html", "", "⏺ Done."]
        self.assertIsNone(block_span(rows, profile_for("claude"), 0))
        self.assertEqual(final_message(rows, "claude"), (3, 3))

    def test_agys_own_footer_is_not_a_message(self):
        # Read off a live pane on 2026-08-22. agy right-aligns a model and credit line under a rule
        # at the foot of the pane, and a positional harness reads any indented line under a column-0
        # line as the start of one. So a turn where agy had not answered yet was recorded as agy
        # saying `Gemini 3.7 Flash · medium · AI: Out of credits` — and the arbitrator, reading the
        # record, called a human over it three times.
        rows = ["────────────────────", "> review the change", "", "  Looks good to me.", "",
                "────────────────────", ">", "", "",
                "                              Gemini 3.7 Flash · medium · AI: Out of credits"]
        self.assertEqual(final_message(rows, "agy"), (3, 3))
        self.assertEqual([m[1] for m in pane_messages(rows, "agy")],
                         ["review the change", "Looks good to me."])

    def test_the_status_line_agy_ships_now_is_not_a_message_either(self):
        # agy replaced that right-aligned bar with a three-line status block in column 0, read off
        # a live pane on 2026-08-22. Column 0 is what a positional block *cannot* start on, so the
        # shape that caused the bug is gone — and the composer trim still holds it, which is two
        # answers rather than one. The fixture is here so a third status line does not quietly
        # become the fourth thing agy is recorded as having said.
        rows = fixture("pane_agy_statusline.txt")
        self.assertEqual(final_message(rows, "agy"), (3, 3))
        said = [m for m in pane_messages(rows, "agy") if m[0] == "agent"]
        self.assertEqual([m[1] for m in said], ["Yes, I'm ready! Please share the next instructions."])

    def test_kiro_answers_a_prompt_with_nothing_in_column_zero_between_them(self):
        # kiro is the second harness with no speaker glyph, and unlike agy it has no prompt gutter
        # either: a turn opens with a full-width rule and the prompt is the first line under it,
        # indented exactly as much as everything kiro says itself. The last turn of the fixture is
        # the one agy's rule cannot reach — answered in prose with no tool call at all, so there is
        # no column-0 marker anywhere between the prompt and the answer and only the prompt itself
        # can open the block. Without that, a whole turn is lost rather than a line of it.
        rows = fixture("pane_kiro_done.txt")
        self.assertEqual(final_message(rows, "kiro"), (155, 158))
        self.assertTrue(rows[153].startswith("  In one short paragraph"), rows[153])
        self.assertTrue(rows[155].startswith("  Git rebase rewrites"), rows[155])

    def test_kiro_has_no_closing_message_for_a_turn_it_has_not_answered(self):
        # The prompt, then the pane's own footer. The placeholder in that footer is indented, and
        # the walk back for what opened it runs past kiro's column-0 chrome to the last marker
        # above — so the footer was read as the answer, and `ask a question or describe a task ↵`
        # went into the record and into the thread as something kiro said.
        rows = [
            "─" * 40,
            "  explain what a git rebase does",
            "",
            "─" * 40,
            "kiro_default · deepseek-3.2 · 13%                    ~/code · (main)",
            "",
            " ask a question or describe a task ↵",
            "                                          /copy to clipboard",
        ]
        self.assertIsNone(final_message(rows, "kiro"))

    def test_kiros_own_chrome_is_neither_a_prompt_nor_a_message(self):
        # Its credit line, its rules and its status bar are in column 0, which a positional block
        # cannot start on. The composer placeholder under them *is* indented, and is refused
        # because a status bar and not a rule is what it hangs under — otherwise every kiro pane
        # records `ask a question or describe a task` as something the user typed.
        rows = fixture("pane_kiro_done.txt")
        self.assertEqual(sorted(user_input_lines(rows, "kiro")), [1, 12, 42, 77, 153])
        said = pane_messages(rows, "kiro")
        self.assertEqual(said[-1][2], (155, 158))
        # `<｜DSML｜function_calls` is the model's own call marker, which kiro prints rather than
        # swallows. A marker opens nothing: without that rule the turn at line 42 — where kiro
        # reached for a tool before saying anything — is recorded as kiro having said it.
        self.assertFalse([m for m in said if "DSML" in m[1]], "a call marker was read as prose")

    def test_a_prompt_in_the_composer_is_not_a_cut(self):
        # Only the *empty* composer. A `>` with text after it is a prompt in the transcript and
        # cannot be told from the live one by shape, so cutting there would drop a real answer.
        rows = ["────────────────────", "> review the change", "", "  Looks good to me.", ""]
        self.assertEqual([m[1] for m in pane_messages(rows, "agy")],
                         ["review the change", "Looks good to me."])

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


class PaneMessages(unittest.TestCase):
    """Everything said in a window, which is what the *record* captures — not the one closing
    message a Lock Screen asks for.

    The expected shapes below are what `paneMessages` in web/src/conversation_pure.js returns over
    these same bytes, taken from it rather than invented here. Two copies of one parser stay in step
    only if one set of bytes proves both, and this is the wider half of that: the closing message,
    the narration above it, and the prompts the user typed.
    """

    # (agent, fixture) -> the who-sequence, and a distinguishing opening for each message.
    CASES = {
        "claude": ("pane_claude_done.txt", [
            ("agent", "Ready. Name the change."),
            ("user", "allow the test commands without prompting"),
        ]),
        "codex": ("pane_codex_done.txt", [
            ("agent", "S2b review clean."),
        ]),
        "pi": ("pane_pi_done.txt", [
            ("user", "explain the last commit"),
            ("agent", "Here's a breakdown"),
        ]),
        "kiro": ("pane_kiro_done.txt", [
            ("user", "What is the status of this repo"),
            ("agent", "I'll check the status of the current repository"),
            ("user", "continue"),
            ("agent", "I'll check the status of the current repository"),
            ("agent", "Now I'll get more repository information:"),
            ("agent", "Based on the information gathered"),
            ("user", "list out all 10 last commits"),
            ("agent", "Here are the last 10 commits:"),
            ("user", "review the lasrt commit"),
            ("agent", "I'll review the last commit"),
            ("agent", "Based on my review of the last commit"),
            ("user", "In one short paragraph"),
            ("agent", "Git rebase rewrites your branch"),
        ]),
        "agy": ("pane_agy_done.txt", [
            ("user", "summarize the last 5 commits"),
            ("agent", "Here is a summary of the last 5 commit"),
            ("user", "and explain the pi extension"),
            ("agent", "Formulating The Response"),
            ("user", "say only the word OK"),
            ("agent", "OK"),
        ]),
    }

    def test_the_same_messages_the_browser_extracts(self):
        for agent, (name, want) in self.CASES.items():
            with self.subTest(agent=agent):
                got = pane_messages(fixture(name), agent)
                self.assertEqual([w for w, _, _ in got], [w for w, _ in want])
                for (_, text, _), (_, opening) in zip(got, want):
                    self.assertTrue(text.startswith(opening), f"{agent}: {text[:60]!r}")

    def test_a_message_carries_its_own_range(self):
        rows = fixture("pane_claude_done.txt")
        for _, text, span in pane_messages(rows, "claude"):
            self.assertLessEqual(span[0], span[1])
            self.assertLess(span[1], len(rows))
            # The range is where the text came from, which is the whole use a reader has for it.
            self.assertIn(text.split("\n")[0], rows[span[0]])

    def test_no_gutter_glyph_survives_into_a_message(self):
        for agent, (name, _) in self.CASES.items():
            for _, text, _ in pane_messages(fixture(name), agent):
                self.assertFalse(text.startswith(("⏺", "•", "❯", "›", ">")), f"{agent}: {text[:40]!r}")

    def test_agy_is_found_positionally_and_needs_its_blank_lines(self):
        # agy has no speaker glyph at all: a block is the first indented line under a column-0 line
        # agy itself printed, and the blank line above it is what tells a reply from the rest of a
        # wrapped prompt. This is the case the relay's old push-preview read destroyed by dropping
        # blank lines — and the failure is not a message missing, it is a message misattributed:
        # the agent's reply is swallowed into the prompt above it and the record says the user
        # said it. Which is worse than recording nothing, and why capture reads raw rows.
        rows = fixture("pane_agy_done.txt")
        self.assertEqual(pane_messages(rows, "agy")[-1], ("agent", "OK", (37, 37)))
        stripped = pane_messages([r for r in rows if r.strip()], "agy")
        self.assertEqual(stripped[-1][0], "user")
        self.assertIn("OK", stripped[-1][1])

    def test_a_harness_with_no_profile_says_nothing(self):
        self.assertEqual(pane_messages(fixture("pane_claude_done.txt"), "amp"), [])
        self.assertEqual(pane_messages(fixture("pane_claude_done.txt"), None), [])

    def test_a_turn_is_its_closing_message_and_the_prompt_that_opened_it(self):
        ms = [("user", "first", (0, 0)), ("agent", "answer one", (1, 1)),
              ("user", "second", (2, 2)), ("user", "and also", (3, 3)),
              ("agent", "answer two", (4, 4))]
        self.assertEqual([w for w, _, _ in turn_messages(ms)], ["user", "user", "agent"])
        self.assertEqual(turn_messages(ms)[-1][1], "answer two")

    def test_a_turn_with_no_reply_in_it_contributes_nothing(self):
        self.assertEqual(turn_messages([("user", "hello", (0, 0))]), [])
        self.assertEqual(turn_messages([]), [])


if __name__ == "__main__":
    unittest.main()
