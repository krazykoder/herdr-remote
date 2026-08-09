#!/usr/bin/env python3
"""pane_cols turns `herdr pane layout` into the pane's width in cells.

The width is what lets the browser lay pane output out at the pane's true geometry instead of
re-wrapping rows herdr already wrapped. Every failure mode here returns None rather than a wrong
number: a wrong width is worse than no width, because the client would lay out confidently to it.
"""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay


def layout(*panes):
    return json.dumps({"result": {"layout": {"panes": [
        {"pane_id": pid, "rect": {"height": 48, "width": w, "x": 0, "y": 1}} for pid, w in panes
    ]}}})


class PaneColsTests(unittest.TestCase):
    def cols(self, raw, pane_id="w11:p2", remote=None):
        with patch.object(herdr_relay, "run_herdr", return_value=raw) as run:
            got = herdr_relay.pane_cols(pane_id, remote=remote)
        return got, run

    def test_returns_the_named_panes_width(self):
        got, _ = self.cols(layout(("w11:p1", 88), ("w11:p2", 87)))
        self.assertEqual(got, 87)

    def test_picks_the_pane_by_id_not_by_position(self):
        # The layout lists every pane in the tab. Taking the first would silently lay the
        # output out at a sibling's width.
        got, _ = self.cols(layout(("w11:p2", 87), ("w11:p1", 88)), pane_id="w11:p1")
        self.assertEqual(got, 88)

    def test_pane_absent_from_layout(self):
        got, _ = self.cols(layout(("w11:p1", 88)))
        self.assertIsNone(got)

    def test_not_json(self):
        got, _ = self.cols("herdr: no such pane")
        self.assertIsNone(got)

    def test_empty_output(self):
        # run_herdr swallows failures and returns "", so this is the shape of every CLI error.
        got, _ = self.cols("")
        self.assertIsNone(got)

    def test_missing_rect(self):
        raw = json.dumps({"result": {"layout": {"panes": [{"pane_id": "w11:p2"}]}}})
        got, _ = self.cols(raw)
        self.assertIsNone(got)

    def test_zero_and_negative_are_rejected(self):
        for width in (0, -1):
            with self.subTest(width=width):
                got, _ = self.cols(layout(("w11:p2", width)))
                self.assertIsNone(got)

    def test_non_integer_width_is_rejected(self):
        got, _ = self.cols(layout(("w11:p2", "87")))
        self.assertIsNone(got)

    def test_passes_the_remote_through(self):
        _, run = self.cols(layout(("w11:p2", 87)), remote="box")
        run.assert_called_once_with("pane", "layout", "--pane", "w11:p2", remote="box")


if __name__ == "__main__":
    unittest.main()
