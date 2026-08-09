#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from start_agent import (
    DEFAULT_START_AGENTS,
    StartAgentConfigError,
    agent_start_args,
    dig,
    load_start_agents,
    next_role_label,
    tab_create_args,
    validate_start_request,
)

PROJECTS = [
    {"id": "charts", "label": "Charts", "cwd": "/work/charts", "host": "local"},
    {"id": "relay", "label": "Relay", "cwd": "/work/relay", "host": "box"},
]

ALLOWED = ["codex", "claude", "pi"]


def agent(pane_id, **kw):
    a = {
        "pane_id": pane_id,
        "workspace_id": kw.get("workspace_id", "w1"),
        "tab_id": kw.get("tab_id", "t1"),
        "host": kw.get("host", "local"),
        "remote": kw.get("remote"),
        "label": kw.get("label", ""),
    }
    if "project_id" in kw:
        a["project_id"] = kw["project_id"]
    return a


LIVE = [
    agent("w1:p1", workspace_id="w1", tab_id="t1", project_id="charts", label="Architect 1"),
    agent("w1:p2", workspace_id="w1", tab_id="t1", project_id="charts", label="Reviewer 1"),
    agent("w5:p1", workspace_id="w5", tab_id="t9", host="box", remote="box", project_id="relay"),
    agent("w7:p1", workspace_id="w7", tab_id="t7"),  # unmatched — no project_id
]


def start(**kw):
    msg = {"type": "start_agent", "name": "claude", "role": "architect",
           "project_id": "charts", "placement": "new_workspace"}
    msg.update(kw)
    return msg


class LoadStartAgentsTests(unittest.TestCase):
    def test_unset_uses_default(self):
        self.assertEqual(load_start_agents(""), DEFAULT_START_AGENTS)
        self.assertEqual(load_start_agents(None), DEFAULT_START_AGENTS)
        self.assertEqual(load_start_agents("   "), DEFAULT_START_AGENTS)

    def test_order_preserved_and_deduplicated(self):
        self.assertEqual(load_start_agents("pi, claude ,codex,claude"), ["pi", "claude", "codex"])

    def test_malformed_name_refused(self):
        for raw in ("cl aude", "Claude", "claude;rm -rf /", "../claude", "a" * 33):
            with self.assertRaises(StartAgentConfigError):
                load_start_agents(raw)

    def test_only_separators_refused(self):
        with self.assertRaises(StartAgentConfigError):
            load_start_agents(",,,")


class RoleLabelTests(unittest.TestCase):
    def test_first_unused_number(self):
        self.assertEqual(next_role_label("architect", "charts", LIVE), "Architect 2")
        self.assertEqual(next_role_label("reviewer", "charts", LIVE), "Reviewer 2")
        self.assertEqual(next_role_label("agent", "charts", LIVE), "Agent 1")

    def test_gaps_are_filled(self):
        agents = [agent("p", project_id="charts", label="Architect 2")]
        self.assertEqual(next_role_label("architect", "charts", agents), "Architect 1")

    def test_scoped_per_project(self):
        self.assertEqual(next_role_label("architect", "relay", LIVE), "Architect 1")

    def test_ignores_user_renamed_labels(self):
        agents = [agent("p", project_id="charts", label="Architect 1 (mine)")]
        self.assertEqual(next_role_label("architect", "charts", agents), "Architect 1")


class ValidateBasicsTests(unittest.TestCase):
    def test_valid_new_workspace_plan(self):
        plan, err = validate_start_request(start(), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["cwd"], "/work/charts")
        self.assertIsNone(plan["remote"])
        self.assertEqual(plan["label"], "Architect 2")
        self.assertEqual(plan["project_label"], "Charts")

    def test_remote_project_resolves_ssh_target(self):
        plan, err = validate_start_request(
            start(project_id="relay", role="agent"), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["remote"], "box")
        self.assertEqual(plan["cwd"], "/work/relay")

    def test_agent_not_in_allowlist(self):
        _, err = validate_start_request(start(name="bash"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "agent not in allowlist")

    def test_missing_name(self):
        msg = start()
        del msg["name"]
        _, err = validate_start_request(msg, PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "agent not in allowlist")

    def test_unknown_role(self):
        _, err = validate_start_request(start(role="root"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown role")

    def test_unknown_project(self):
        _, err = validate_start_request(start(project_id="nope"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown project_id")

    def test_unknown_placement(self):
        _, err = validate_start_request(start(placement="anywhere"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown placement")

    def test_client_cannot_smuggle_cwd_host_env_or_argv(self):
        for field, value in (("cwd", "/etc"), ("host", "box"), ("env", {"X": "1"}),
                             ("argv", ["sh"]), ("tab_id", "t1"), ("prompt", "hi")):
            _, err = validate_start_request(start(**{field: value}), PROJECTS, LIVE, ALLOWED)
            self.assertIn("unexpected field", err, field)

    def test_placement_field_for_the_wrong_placement(self):
        _, err = validate_start_request(start(split_from="w1:p1"), PROJECTS, LIVE, ALLOWED)
        self.assertIn("unexpected field", err)


class NewTabTests(unittest.TestCase):
    def test_valid(self):
        plan, err = validate_start_request(
            start(placement="new_tab", workspace_id="w1"), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["workspace_id"], "w1")

    def test_missing_workspace_id(self):
        _, err = validate_start_request(start(placement="new_tab"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "workspace_id required for new_tab")

    def test_unknown_workspace(self):
        _, err = validate_start_request(
            start(placement="new_tab", workspace_id="w99"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown workspace_id")

    def test_workspace_on_two_hosts_refused(self):
        """A11 — the collision the one-distinct-host test exists to catch."""
        agents = LIVE + [agent("w1:p9", workspace_id="w1", host="box", remote="box")]
        _, err = validate_start_request(
            start(placement="new_tab", workspace_id="w1"), PROJECTS, agents, ALLOWED)
        self.assertIn("ambiguous workspace_id", err)

    def test_cross_host_workspace_refused(self):
        _, err = validate_start_request(
            start(placement="new_tab", workspace_id="w5"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "workspace is not on this project's host")

    def test_foreign_project_workspace_refused(self):
        """Same host, but nothing in that workspace belongs to the Project."""
        _, err = validate_start_request(
            start(placement="new_tab", workspace_id="w7"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "workspace does not belong to this project")


class SplitTests(unittest.TestCase):
    def test_valid(self):
        plan, err = validate_start_request(
            start(placement="split", split_from="w1:p2"), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["tab_id"], "t1")

    def test_missing_split_from(self):
        _, err = validate_start_request(start(placement="split"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "split_from required for split")

    def test_unknown_pane(self):
        _, err = validate_start_request(
            start(placement="split", split_from="w9:p9"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown pane_id")

    def test_ambiguous_pane_refused(self):
        agents = LIVE + [agent("w1:p1", workspace_id="w4", host="box", remote="box",
                               project_id="charts")]
        _, err = validate_start_request(
            start(placement="split", split_from="w1:p1"), PROJECTS, agents, ALLOWED)
        self.assertIn("ambiguous pane_id", err)

    def test_cross_host_split_refused(self):
        _, err = validate_start_request(
            start(placement="split", split_from="w5:p1"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "pane is not on this project's host")

    def test_foreign_project_pane_refused(self):
        _, err = validate_start_request(
            start(placement="split", split_from="w7:p1"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "pane does not belong to this project")

    def test_pane_without_tab_id_refused(self):
        agents = [agent("w1:p1", tab_id="", project_id="charts")]
        _, err = validate_start_request(
            start(placement="split", split_from="w1:p1"), PROJECTS, agents, ALLOWED)
        self.assertEqual(err, "pane has no tab_id")


class ArgsTests(unittest.TestCase):
    def test_new_tab_uses_the_role_label(self):
        args = tab_create_args("w3", "Architect 1")
        self.assertEqual(args, ("tab", "create", "--workspace", "w3", "--label", "Architect 1", "--focus"))

    def test_argv_is_the_allowlisted_name(self):
        args = agent_start_args("claude", "/work/charts", "workspace", "w3")
        self.assertEqual(args[-2:], ("--", "claude"))
        self.assertEqual(args[:3], ("agent", "start", "claude"))
        self.assertIn("--workspace", args)
        self.assertNotIn("--split", args)

    def test_split_adds_right(self):
        args = agent_start_args("codex", "/work/charts", "tab", "t1", split=True)
        self.assertEqual(args[args.index("--split") + 1], "right")
        self.assertIn("--tab", args)


class DigTests(unittest.TestCase):
    def test_reads_nested_ids(self):
        self.assertEqual(dig({"result": {"agent": {"pane_id": "w1:p3"}}},
                             "result", "agent", "pane_id"), "w1:p3")

    def test_missing_hops_read_as_absent(self):
        self.assertEqual(dig({}, "result", "agent", "pane_id"), "")
        self.assertEqual(dig({"result": None}, "result", "agent", "pane_id"), "")
        self.assertEqual(dig({"result": {"agent": {"pane_id": 7}}},
                             "result", "agent", "pane_id"), "")


if __name__ == "__main__":
    unittest.main()
