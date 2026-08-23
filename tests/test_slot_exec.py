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


def pane(pane_id, tab_id="t1", agent="codex", label="", cwd="/work", workspace_id="w1"):
    return {"pane_id": pane_id, "tab_id": tab_id, "agent": agent, "label": label, "cwd": cwd,
            "workspace_id": workspace_id}


def spacer(pane_id, tab_id="t1", cwd="/work"):
    return pane(pane_id, tab_id=tab_id, agent="", label=SPACER_LABEL, cwd=cwd)


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


class StartIntoASpacerTests(unittest.TestCase):
    """A narrow start fills a spacer that is already standing instead of opening a tab.

    The spacer is a shell at a prompt, which is what `agent start --pane` wants — so the check
    that matters is that no tab was created and the agent went to the spacer's own pane_id.
    """

    def start(self, panes, slot="narrow", spacer_cwd="/work"):
        calls = []

        def fake(*args, remote=None, timeout=15):
            calls.append(args)
            if args[:2] == ("pane", "list"):
                return FakeResult(pane_list(*panes))
            if args[:2] == ("agent", "list"):
                return FakeResult(json.dumps({"result": {"agents": []}}))
            if args[:2] == ("tab", "create"):
                return FakeResult(json.dumps(
                    {"result": {"tab": {"tab_id": "w1:t9"}, "root_pane": {"pane_id": "w1:pN"}}}))
            if args[:2] == ("agent", "start"):
                return FakeResult(json.dumps(
                    {"result": {"agent": {"pane_id": args[args.index("--pane") + 1]}}}))
            return FakeResult()

        plan = {"name": "codex", "role": "agent", "project_id": "charts",
                "project_label": "Charts", "cwd": "/work", "remote": None,
                "placement": "new_tab", "label": "Agent 1", "slot": slot,
                "workspace_id": "w1"}
        with patch.object(herdr_relay, "run_herdr_result", side_effect=fake):
            pane_id, err = herdr_relay.start_agent_exec(plan)
        return pane_id, err, calls

    def test_a_narrow_start_claims_the_spacer_and_opens_no_tab(self):
        pane_id, err, calls = self.start([pane("w1:p1"), spacer("w1:p2")])
        self.assertIsNone(err)
        self.assertEqual(pane_id, "w1:p2")
        self.assertNotIn(("tab", "create"), [c[:2] for c in calls])

    def test_a_wide_start_opens_a_tab_and_leaves_the_spacer_alone(self):
        # A wide session landing in a spacer would come up half-width and move straight back out.
        pane_id, err, calls = self.start([pane("w1:p1"), spacer("w1:p2")], slot="wide")
        self.assertIsNone(err)
        self.assertEqual(pane_id, "w1:pN")
        self.assertIn(("tab", "create"), [c[:2] for c in calls])

    def test_a_spacer_in_the_wrong_directory_is_not_claimed(self):
        _, err, calls = self.start([spacer("w1:p2", cwd="/elsewhere")])
        self.assertIsNone(err)
        self.assertIn(("tab", "create"), [c[:2] for c in calls])


class PaneNotAtItsPromptYetTests(unittest.TestCase):
    """A tab is born before its shell reaches a prompt, and `agent start` refuses until it does.

    This is what made Duplicate look broken: the tab opened, the start was refused about a second
    later, the rollback closed the tab again, and nothing appeared to have happened. The same
    start succeeded when it was made by hand a few seconds afterwards.
    """

    def start(self, refusals, refusal, wait=5.0):
        """Refuse `refusals` starts with `refusal`, then let one through. Returns (pane_id, err)."""
        starts = []
        slept = []

        def fake(*args, remote=None, timeout=15):
            if args[:2] == ("agent", "list"):
                return FakeResult(json.dumps({"result": {"agents": []}}))
            if args[:2] == ("tab", "create"):
                return FakeResult(json.dumps(
                    {"result": {"tab": {"tab_id": "w1:t9"}, "root_pane": {"pane_id": "w1:pN"}}}))
            if args[:2] == ("agent", "start"):
                starts.append(args)
                if len(starts) <= refusals:
                    return FakeResult(**refusal)
                return FakeResult(json.dumps(
                    {"result": {"agent": {"pane_id": args[args.index("--pane") + 1]}}}))
            return FakeResult()

        plan = {"name": "codex", "role": "agent", "project_id": "charts",
                "project_label": "Charts", "cwd": "/work", "remote": None,
                "placement": "new_tab", "label": "Agent 1", "slot": None,
                "workspace_id": "w1"}
        with patch.object(herdr_relay, "run_herdr_result", side_effect=fake), \
                patch.object(herdr_relay.time, "sleep", slept.append), \
                patch.object(herdr_relay, "PANE_READY_WAIT", wait), \
                patch.object(herdr_relay, "_rollback_layout") as rollback:
            pane_id, err = herdr_relay.start_agent_exec(plan)
        return pane_id, err, starts, slept, rollback

    # herdr puts its error body on stdout on one route and stderr on the other, so the refusal
    # arrives as the message alone or as the whole JSON blob. Both have to be recognised.
    ON_STDOUT = {"returncode": 1, "stdout": json.dumps(
        {"error": {"code": "agent_pane_busy",
                   "message": "agent target pane w1:pN is not an available shell"}})}
    ON_STDERR = {"returncode": 1, "stderr": json.dumps(
        {"error": {"code": "agent_pane_busy",
                   "message": "agent target pane w1:pN is not an available shell"}})}

    def test_the_start_is_offered_again_until_the_shell_arrives(self):
        for name, refusal in (("stdout", self.ON_STDOUT), ("stderr", self.ON_STDERR)):
            with self.subTest(name):
                pane_id, err, starts, slept, rollback = self.start(2, refusal)
                self.assertIsNone(err)
                self.assertEqual(pane_id, "w1:pN")
                self.assertEqual(len(starts), 3)
                self.assertEqual(len(slept), 2)
                # The tab it opened has to survive the retries — rolling it back would leave the
                # next attempt offering a pane that no longer exists.
                rollback.assert_not_called()

    def test_a_shell_that_never_arrives_still_fails_and_rolls_back(self):
        pane_id, err, starts, _, rollback = self.start(99, self.ON_STDOUT, wait=0)
        self.assertIsNone(pane_id)
        self.assertIn("not an available shell", err)
        self.assertEqual(len(starts), 1)      # nothing to wait for: the deadline is already past
        rollback.assert_called_once()

    def test_any_other_refusal_is_not_retried(self):
        taken = {"returncode": 1, "stdout": json.dumps(
            {"error": {"code": "agent_name_taken", "message": "agent name is already used"}})}
        _, err, starts, slept, _ = self.start(1, taken)
        self.assertIn("already used", err)
        self.assertEqual(len(starts), 1)
        self.assertEqual(slept, [])


class AgentInitTests(unittest.TestCase):
    def test_kiro_init_uses_the_confirmed_send_path(self):
        sent = object()
        def paste(*args, **kwargs):
            self.assertEqual(args, ("w1:p1", "/tools trust-all"))
            self.assertEqual(kwargs, {"remote": None})
            return sent

        with patch.object(herdr_relay, "submit_paste", new=paste), \
             patch.object(herdr_relay, "on_loop", return_value=True) as on_loop:
            herdr_relay.agent_init_exec("w1:p1", "kiro", None)
        on_loop.assert_called_once_with(sent, wait=True)


if __name__ == "__main__":
    unittest.main()
