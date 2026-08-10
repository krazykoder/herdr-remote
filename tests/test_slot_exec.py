#!/usr/bin/env python3
"""slot_exec applies a slot plan and labels every spacer it creates.

The label is the whole safety story. `plan_slot` decides what may be closed by reading it, and
those decisions are tested next door — but nothing there ever *writes* one. This does. A spacer
that reaches the layout unlabelled is a shell no later slot change will clean up, and worse, the
same code path is what keeps `wide` from closing a shell the user split themselves.

Blocking herdr calls are faked. What is being tested is the order and content of the argv this
sends, and that a failure anywhere stops the rest — not herdr's behaviour, which the E2E probe
covers against the real binary.
"""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay  # noqa: E402
from start_agent import SPACER_LABEL  # noqa: E402


class FakeResult:
    def __init__(self, stdout="{}", returncode=0, stderr=""):
        self.stdout, self.returncode, self.stderr = stdout, returncode, stderr


def pane_list(*panes):
    return json.dumps({"result": {"panes": list(panes)}})


def pane(pane_id, tab_id="t1", agent="codex", label="", cwd="/work"):
    return {"pane_id": pane_id, "tab_id": tab_id, "agent": agent, "label": label, "cwd": cwd}


def spacer(pane_id, tab_id="t1"):
    return pane(pane_id, tab_id=tab_id, agent="", label=SPACER_LABEL)


class SlotExecTests(unittest.TestCase):
    def run_slot(self, panes, pane_id, slot, split_pane="w1:p9", fail_on=None, remote=None):
        """Run slot_exec against a faked herdr. Returns (error, [argv, ...])."""
        calls = []

        def fake(*args, remote=None, timeout=15):
            calls.append((args, remote))
            if fail_on and args[:len(fail_on)] == fail_on:
                return FakeResult(returncode=1, stderr="herdr said no")
            if args[:2] == ("pane", "list"):
                return FakeResult(pane_list(*panes))
            if args[:2] == ("pane", "split"):
                body = {"pane_id": split_pane} if split_pane else {}
                return FakeResult(json.dumps({"result": {"pane": body}}))
            return FakeResult()

        with patch.object(herdr_relay, "run_herdr_result", side_effect=fake):
            err = herdr_relay.slot_exec(pane_id, slot, remote=remote)
        return err, [c[0] for c in calls], [c[1] for c in calls]

    def test_narrow_labels_the_pane_it_just_created(self):
        err, calls, _ = self.run_slot([pane("w1:p1")], "w1:p1", "narrow")
        self.assertIsNone(err)
        self.assertEqual(calls[1][:2], ("pane", "split"))
        # The rename names the *new* pane, not the one that was split.
        self.assertEqual(calls[2], ("pane", "rename", "w1:p9", SPACER_LABEL))

    def test_the_labelled_spacer_is_the_one_a_later_wide_closes(self):
        # The round trip the label exists for, in two halves: what narrow writes, wide reads.
        _, calls, _ = self.run_slot([pane("w1:p1")], "w1:p1", "narrow")
        rename = next(c for c in calls if c[:2] == ("pane", "rename"))
        made = spacer(rename[2])
        err, calls, _ = self.run_slot([pane("w1:p1"), made], "w1:p1", "wide")
        self.assertIsNone(err)
        self.assertIn(("pane", "close", rename[2]), calls)

    def test_a_split_that_reports_no_pane_id_is_an_error_not_an_unlabelled_spacer(self):
        err, calls, _ = self.run_slot([pane("w1:p1")], "w1:p1", "narrow", split_pane=None)
        self.assertEqual(err, "pane split returned no pane_id")
        self.assertNotIn("rename", [c[1] for c in calls])

    def test_a_failed_rename_is_reported_rather_than_swallowed(self):
        err, _, _ = self.run_slot([pane("w1:p1")], "w1:p1", "narrow",
                                  fail_on=("pane", "rename"))
        self.assertIsNotNone(err)
        self.assertIn("herdr said no", err)

    def test_a_failed_step_stops_the_ones_after_it(self):
        panes = [pane("w1:p1"), spacer("w1:p2"), spacer("w1:p3")]
        err, calls, _ = self.run_slot(panes, "w1:p1", "wide", fail_on=("pane", "close", "w1:p2"))
        self.assertIsNotNone(err)
        self.assertNotIn(("pane", "close", "w1:p3"), calls)

    def test_wide_over_a_spacer_never_renames_anything(self):
        err, calls, _ = self.run_slot([pane("w1:p1"), spacer("w1:p2")], "w1:p1", "wide")
        self.assertIsNone(err)
        self.assertEqual(calls, [("pane", "list"), ("pane", "close", "w1:p2")])

    def test_already_in_the_slot_runs_nothing_beyond_the_read(self):
        err, calls, _ = self.run_slot([pane("w1:p1")], "w1:p1", "wide")
        self.assertIsNone(err)
        self.assertEqual(calls, [("pane", "list")])

    def test_a_planning_refusal_never_reaches_herdr(self):
        for pane_id, slot in (("w1:p1", "half"), ("w1:p404", "wide")):
            err, calls, _ = self.run_slot([pane("w1:p1")], pane_id, slot)
            self.assertIsNotNone(err, slot)
            self.assertEqual(calls, [("pane", "list")], slot)

    def test_every_call_goes_to_the_pane_s_own_host(self):
        # A slot change that read the remote host and then split locally would put the spacer on
        # the wrong machine, and close a pane on the wrong one.
        _, _, remotes = self.run_slot([pane("w1:p1")], "w1:p1", "narrow", remote="box")
        self.assertEqual(set(remotes), {"box"})

    def test_an_unreadable_pane_list_stops_before_any_layout_change(self):
        err, calls, _ = self.run_slot([pane("w1:p1")], "w1:p1", "narrow",
                                      fail_on=("pane", "list"))
        self.assertIsNotNone(err)
        self.assertEqual(calls, [("pane", "list")])


if __name__ == "__main__":
    unittest.main()
