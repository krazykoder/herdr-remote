#!/usr/bin/env python3
"""The prompt files, as files: they load, they carry what the code asks for, and a bad edit is
survivable.

These exist because `relay/prompts/*.md` is meant to be edited by hand between sessions. Every
other test in this repo reads a prompt through `arbitration.py` and would pass just as happily
against a file that had silently lost half its headings.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "relay"))

import arb_prompts


class Files(unittest.TestCase):
    def setUp(self):
        arb_prompts._cache.clear()

    def test_every_file_loads_with_the_sections_the_code_asks_for(self):
        for name, wanted in arb_prompts.REQUIRED.items():
            got = arb_prompts.sections(name)
            for section in wanted:
                self.assertTrue(got.get(section), f"{name}.md is missing {section}")

    def test_the_editor_note_above_the_first_heading_is_never_sent(self):
        # Each file opens with an HTML comment explaining what may be substituted into it. It is
        # for the person editing the file and would be noise in an agent's terminal.
        body = arb_prompts.starter(scope="S", gates="g", max_instruction=10, query_path="/q")
        self.assertNotIn("<!--", body)
        self.assertNotIn("$placeholder", body)

    def test_the_brief_carries_both_instruction_styles(self):
        # Both, not the one in force: a person switching style mid-session edits a column, and
        # re-briefing to make that take would throw away everything the arbitrator has decided.
        body = arb_prompts.starter(scope="S", gates="g", max_instruction=10, query_path="/q")
        self.assertIn("minimal", body)
        self.assertIn("detailed", body)

    def test_every_placeholder_is_substituted(self):
        body = arb_prompts.starter(scope="SCOPE-HERE", gates="implement, hold",
                                   max_instruction=4000, query_path="/tmp/q.py")
        for token in ("SCOPE-HERE", "implement, hold", "4000", "/tmp/q.py"):
            self.assertIn(token, body)
        # `$` survives only where a person wrote one on purpose, and nobody has.
        self.assertNotIn("$", body)

    def test_the_trigger_line_names_the_mode(self):
        self.assertIn("minimal", arb_prompts.mode_line("minimal"))
        self.assertIn("detailed", arb_prompts.mode_line("detailed"))

    def test_a_pause_reason_with_no_section_gets_the_fallback(self):
        self.assertIn("budget steps", arb_prompts.resume_note("budget_steps"))
        # And one that has a section of its own gets it, rather than the fallback's sentence.
        self.assertIn("held three times", arb_prompts.resume_note("holding"))

    def test_an_unreadable_file_keeps_the_last_copy_that_loaded(self):
        # The Projects config rule, for the same reason: a typo in a text file must not take a
        # running relay's sessions down, and a half-written brief is worse than yesterday's whole
        # one. Boot is where a broken prompt directory is caught — `check()` runs at import.
        was = arb_prompts.sections("modes")
        path = os.path.join(arb_prompts.DIR, "modes.md")
        with open(path, encoding="utf-8") as fh:
            kept = fh.read()
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("## rules\n\nonly half of it\n")   # `line` is gone
            self.assertIs(was, arb_prompts.sections("modes"))
        finally:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(kept)

    def test_an_edit_takes_without_a_restart(self):
        path = os.path.join(arb_prompts.DIR, "modes.md")
        with open(path, encoding="utf-8") as fh:
            kept = fh.read()
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(kept.replace("Instruction style: $mode", "Style now: $mode"))
            self.assertEqual("Style now: minimal", arb_prompts.mode_line("minimal"))
        finally:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(kept)
            arb_prompts._cache.clear()
        self.assertEqual("Instruction style: minimal", arb_prompts.mode_line("minimal"))


if __name__ == "__main__":
    unittest.main()
