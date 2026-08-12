#!/usr/bin/env python3
"""pane_cols measures a pane's wrap column from its own hard-wrapped scrollback.

The width is what lets the browser lay unwrapped pane output out at the pane's true geometry
instead of guessing. It used to come from `herdr pane layout`, but that rect describes herdr's
layout model of an attached client's window, not the PTY: a pane resized after it was created
reports its birth width there forever. Measuring the text herdr actually wrapped cannot drift
from the text being displayed, because it *is* that text.

Every failure mode returns None rather than a wrong number: a wrong width is worse than no
width, because the client would lay out confidently to it.
"""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay


def wrapped(width, rows, tail=""):
    """Scrollback as a terminal produces it: full-width rows, then a short final line."""
    return "\n".join(["x" * width] * rows + ([tail] if tail else []))


class PaneColsTests(unittest.TestCase):
    def cols(self, raw, pane_id="w11:p2", lines=30, remote=None):
        with patch.object(herdr_relay, "run_herdr", return_value=raw) as run:
            got = herdr_relay.pane_cols(pane_id, lines, remote=remote)
        return got, run

    def test_returns_the_wrap_column(self):
        got, _ = self.cols(wrapped(87, 4, tail="done."))
        self.assertEqual(got, 87)

    def test_a_short_tail_line_does_not_lower_it(self):
        # The last line of any read is almost always partial; taking the last width, or an
        # average, would report a pane narrower than every wrapped row above it.
        got, _ = self.cols(wrapped(87, 1, tail="ok"))
        self.assertEqual(got, 87)

    def test_trailing_whitespace_is_not_width(self):
        # herdr pads some rows out to the pane edge; counting the padding would over-report.
        got, _ = self.cols("hello" + " " * 40)
        self.assertEqual(got, 5)

    def test_a_widened_pane_reports_its_new_width(self):
        # The regression this replaced pane layout for: old rows wrapped at 54, current output
        # at 138. The layout rect kept saying 54 and the client scaled to half the real pane.
        got, _ = self.cols(wrapped(54, 6) + "\n" + wrapped(138, 6))
        self.assertEqual(got, 138)

    def test_only_the_lines_being_sent_are_sampled(self):
        # A narrowed pane still holds wider rows further back. Sampling deeper than the client
        # asked for would find them and lay the visible text out too wide, so the read is
        # bounded by the same line count the client requested.
        _, run = self.cols(wrapped(54, 4), lines=12)
        run.assert_called_once_with("pane", "read", "w11:p2", "--lines", "12",
                                    "--source", "recent", remote=None)

    def test_the_sample_is_capped_however_deep_the_read_goes(self):
        # A deep read is the client asking for history; the wrap column is a property of the pane
        # now. Sampling all of it would cost a second full read per request — over SSH, every few
        # seconds — to answer with the width the pane used to be.
        _, run = self.cols(wrapped(87, 4), lines=20000)
        self.assertEqual(run.call_args.args[4], str(herdr_relay.COLS_SAMPLE_LINES))

    def test_reads_the_wrapped_source_not_the_unwrapped_one(self):
        # recent-unwrapped drops the very breaks being measured; it would report the longest
        # logical line the agent wrote, which is unbounded by the pane.
        _, run = self.cols(wrapped(87, 2))
        self.assertEqual(run.call_args.args[-1], "recent")

    def test_empty_output(self):
        # run_herdr swallows failures and returns "", so this is the shape of every CLI error.
        got, _ = self.cols("")
        self.assertIsNone(got)

    def test_blank_lines_only(self):
        got, _ = self.cols("\n   \n\n")
        self.assertIsNone(got)

    def test_passes_the_remote_through(self):
        _, run = self.cols(wrapped(87, 2), remote="box")
        self.assertEqual(run.call_args.kwargs, {"remote": "box"})


if __name__ == "__main__":
    unittest.main()
