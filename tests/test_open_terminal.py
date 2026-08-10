#!/usr/bin/env python3
"""validate_open_terminal — the same spawn rules a start obeys, minus the agent.

Most of what is asserted here is shared with validate_start_request by construction, and that is
the point: the checks that decide whether a spawn is *allowed* — cwd from the Projects config and
nowhere else, the host of the target, the ownership of the workspace or pane it lands beside —
must not exist in two versions. What is tested as genuinely its own is what a terminal adds: no
agent fields on the wire, the "Terminal N" sequence, shells counting as valid targets, and the
spacer label being refused.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from start_agent import SPACER_LABEL, validate_open_terminal  # noqa: E402

PROJECTS = [
    {"id": "charts", "label": "Charts", "cwd": "/work/charts", "host": "local"},
    {"id": "relay", "label": "Relay", "cwd": "/work/relay", "host": "box"},
]


def agent(pane_id, **kw):
    a = {"pane_id": pane_id, "agent": "claude", "label": "Architect 1", "status": "idle",
         "cwd": "/work/charts", "project_id": "charts", "host": "local", "remote": None,
         "workspace_id": "w1", "tab_id": "w1:t1"}
    a.update(kw)
    return a


def shell(pane_id, **kw):
    s = {"pane_id": pane_id, "label": "build watch", "cwd": "/work/charts",
         "project_id": "charts", "host": "local", "remote": None,
         "workspace_id": "w1", "tab_id": "w1:t1"}
    s.update(kw)
    return s


def msg(**kw):
    m = {"type": "open_terminal", "project_id": "charts", "placement": "new_workspace"}
    m.update(kw)
    return m


class Validation(unittest.TestCase):
    def test_a_new_workspace_terminal_takes_cwd_and_host_from_the_project(self):
        plan, err = validate_open_terminal(msg(), PROJECTS, [])
        self.assertIsNone(err)
        self.assertEqual(plan["cwd"], "/work/charts")
        self.assertIsNone(plan["remote"])
        self.assertEqual(plan["placement"], "new_workspace")

    def test_a_remote_project_carries_its_host(self):
        plan, err = validate_open_terminal(msg(project_id="relay"), PROJECTS, [])
        self.assertIsNone(err)
        self.assertEqual((plan["cwd"], plan["remote"]), ("/work/relay", "box"))

    def test_the_plan_carries_no_agent_fields(self):
        plan, _ = validate_open_terminal(msg(), PROJECTS, [])
        self.assertNotIn("name", plan)
        self.assertNotIn("role", plan)

    def test_a_cwd_on_the_wire_is_an_unexpected_field(self):
        """D4. The one rule that makes a Projects-only cwd mean anything."""
        _, err = validate_open_terminal(msg(cwd="/etc"), PROJECTS, [])
        self.assertEqual(err, "unexpected field(s) for new_workspace: cwd")

    def test_agent_fields_are_unexpected_too(self):
        _, err = validate_open_terminal(msg(name="claude", role="architect"), PROJECTS, [])
        self.assertEqual(err, "unexpected field(s) for new_workspace: name, role")

    def test_unknown_project_and_placement(self):
        _, err = validate_open_terminal(msg(project_id="nope"), PROJECTS, [])
        self.assertEqual(err, "unknown project_id")
        _, err = validate_open_terminal(msg(placement="sideways"), PROJECTS, [])
        self.assertEqual(err, "unknown placement")

    def test_the_spacer_label_is_refused(self):
        """plan_slot closes a pane carrying this label — creating one on request is asking the
        relay to delete the user's terminal at the next slot change."""
        _, err = validate_open_terminal(msg(label=SPACER_LABEL), PROJECTS, [])
        self.assertEqual(err, "label is reserved")

    def test_a_label_is_bounded_like_any_other_argv_element(self):
        _, err = validate_open_terminal(msg(label="x" * 33), PROJECTS, [])
        self.assertTrue(err)
        _, err = validate_open_terminal(msg(label="tail\nrm -rf"), PROJECTS, [])
        self.assertTrue(err)

    def test_an_unknown_slot_is_refused_and_a_known_one_is_carried(self):
        _, err = validate_open_terminal(msg(slot="huge"), PROJECTS, [])
        self.assertEqual(err, "unknown slot")
        plan, err = validate_open_terminal(msg(slot="narrow"), PROJECTS, [])
        self.assertIsNone(err)
        self.assertEqual(plan["slot"], "narrow")


class DefaultLabel(unittest.TestCase):
    def test_the_first_terminal_in_a_project_is_terminal_1(self):
        plan, _ = validate_open_terminal(msg(), PROJECTS, [])
        self.assertEqual(plan["label"], "Terminal 1")

    def test_the_sequence_counts_terminals_already_in_this_project(self):
        panes = [shell("w1:p2", label="Terminal 1"), shell("w1:p3", label="Terminal 2"),
                 shell("w9:p1", label="Terminal 1", project_id="relay")]
        plan, _ = validate_open_terminal(msg(), PROJECTS, panes)
        self.assertEqual(plan["label"], "Terminal 3")

    def test_an_explicit_label_wins(self):
        plan, _ = validate_open_terminal(msg(label="build watch"), PROJECTS, [])
        self.assertEqual(plan["label"], "build watch")


class Targets(unittest.TestCase):
    """A workspace of terminals is a place to open another tab, and a terminal is a pane to
    split off. Both are refused if the caller passes agents alone, which is why the relay hands
    this function agents + shells."""

    def test_a_tab_lands_in_a_workspace_holding_only_terminals(self):
        panes = [shell("w1:p2")]
        plan, err = validate_open_terminal(
            msg(placement="new_tab", workspace_id="w1"), PROJECTS, panes)
        self.assertIsNone(err)
        self.assertEqual(plan["workspace_id"], "w1")

    def test_a_split_source_may_be_a_terminal(self):
        plan, err = validate_open_terminal(
            msg(placement="split", split_from="w1:p2"), PROJECTS, [shell("w1:p2")])
        self.assertIsNone(err)
        self.assertEqual(plan["split_from"], "w1:p2")

    def test_a_target_in_another_project_is_refused(self):
        panes = [shell("w1:p2", project_id="relay")]
        _, err = validate_open_terminal(
            msg(placement="new_tab", workspace_id="w1"), PROJECTS, panes)
        self.assertEqual(err, "workspace does not belong to this project")
        _, err = validate_open_terminal(
            msg(placement="split", split_from="w1:p2"), PROJECTS, panes)
        self.assertEqual(err, "pane does not belong to this project")

    def test_a_target_on_another_host_is_refused(self):
        panes = [shell("w1:p2", host="box", remote="box", project_id="relay")]
        _, err = validate_open_terminal(
            msg(placement="split", split_from="w1:p2"), PROJECTS, panes)
        self.assertEqual(err, "pane is not on this project's host")

    def test_a_pane_id_on_two_hosts_is_refused(self):
        """The same D6 guard a start gets, and it has to see shells to apply to one."""
        panes = [agent("w1:p2"), shell("w1:p2", host="box", remote="box")]
        _, err = validate_open_terminal(
            msg(placement="split", split_from="w1:p2"), PROJECTS, panes)
        self.assertEqual(err, "ambiguous pane_id (same id on multiple hosts)")

    def test_a_missing_target_is_named_rather_than_defaulted(self):
        _, err = validate_open_terminal(msg(placement="new_tab"), PROJECTS, [])
        self.assertEqual(err, "workspace_id required for new_tab")
        _, err = validate_open_terminal(msg(placement="split"), PROJECTS, [])
        self.assertEqual(err, "split_from required for split")


if __name__ == "__main__":
    unittest.main()
