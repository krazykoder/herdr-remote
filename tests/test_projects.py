#!/usr/bin/env python3
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from projects import (
    ProjectConfigError,
    ambiguous_pane_ids,
    annotate_agents,
    load_projects,
    public_projects,
    resolve_project_id,
    resolve_workspace_remote,
)


def write_config(payload):
    """Write a config file and return its absolute path. Caller keeps the tempdir alive."""
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    tmp.write(payload if isinstance(payload, str) else json.dumps(payload))
    tmp.close()
    return tmp.name


VALID = [
    {"id": "charts", "label": "Charts", "cwd": "/work/charts", "host": "local"},
    {"id": "relay", "label": "Relay", "cwd": "/work/relay", "host": "box"},
]


class LoadProjectsTests(unittest.TestCase):
    def test_unset_path_disables_projects(self):
        self.assertEqual(load_projects("", valid_hosts=["box"]), [])
        self.assertEqual(load_projects(None), [])

    def test_relative_config_path_rejected(self):
        with self.assertRaises(ProjectConfigError):
            load_projects("projects.json")

    def test_valid_config_loads(self):
        got = load_projects(write_config(VALID), valid_hosts=["box"])
        self.assertEqual([p["id"] for p in got], ["charts", "relay"])
        self.assertEqual(got[1]["host"], "box")

    def test_host_defaults_to_local(self):
        got = load_projects(write_config([{"id": "a", "label": "A", "cwd": "/work/a"}]))
        self.assertEqual(got[0]["host"], "local")

    def test_cwd_is_normalized(self):
        got = load_projects(write_config([{"id": "a", "label": "A", "cwd": "/work/a/"}]))
        self.assertEqual(got[0]["cwd"], "/work/a")

    def test_missing_file(self):
        with self.assertRaises(ProjectConfigError):
            load_projects("/nonexistent/projects.json")

    def test_malformed_json(self):
        with self.assertRaises(ProjectConfigError):
            load_projects(write_config("[{"))

    def test_top_level_must_be_array(self):
        with self.assertRaises(ProjectConfigError):
            load_projects(write_config({"id": "a"}))

    def test_bad_ids(self):
        for bad in ["Charts", "has space", "", "x" * 65, 7, None]:
            with self.subTest(bad=bad):
                with self.assertRaises(ProjectConfigError):
                    load_projects(write_config([{"id": bad, "label": "L", "cwd": "/w"}]))

    def test_duplicate_id(self):
        entries = [
            {"id": "a", "label": "A", "cwd": "/work/one"},
            {"id": "a", "label": "B", "cwd": "/work/two"},
        ]
        with self.assertRaises(ProjectConfigError):
            load_projects(write_config(entries))

    def test_duplicate_root_on_same_host(self):
        entries = [
            {"id": "a", "label": "A", "cwd": "/work/one"},
            {"id": "b", "label": "B", "cwd": "/work/one/"},
        ]
        with self.assertRaises(ProjectConfigError):
            load_projects(write_config(entries))

    def test_same_root_on_different_hosts_allowed(self):
        entries = [
            {"id": "a", "label": "A", "cwd": "/work/one", "host": "local"},
            {"id": "b", "label": "B", "cwd": "/work/one", "host": "box"},
        ]
        self.assertEqual(len(load_projects(write_config(entries), valid_hosts=["box"])), 2)

    def test_bad_labels(self):
        for bad in ["", "   ", "x" * 65, 7, None]:
            with self.subTest(bad=bad):
                with self.assertRaises(ProjectConfigError):
                    load_projects(write_config([{"id": "a", "label": bad, "cwd": "/w"}]))

    def test_relative_cwd_rejected(self):
        with self.assertRaises(ProjectConfigError):
            load_projects(write_config([{"id": "a", "label": "A", "cwd": "work/a"}]))

    def test_unknown_host_rejected(self):
        entries = [{"id": "a", "label": "A", "cwd": "/w", "host": "ghost"}]
        with self.assertRaises(ProjectConfigError):
            load_projects(write_config(entries), valid_hosts=["box"])

    def test_error_names_the_path_and_entry(self):
        path = write_config([{"id": "ok", "label": "A", "cwd": "/w"}, {"id": "BAD"}])
        with self.assertRaises(ProjectConfigError) as ctx:
            load_projects(path)
        self.assertIn(path, str(ctx.exception))
        self.assertIn("entry 1", str(ctx.exception))


class ResolveProjectTests(unittest.TestCase):
    def setUp(self):
        self.projects = [
            {"id": "code", "label": "Code", "cwd": "/work", "host": "local"},
            {"id": "charts", "label": "Charts", "cwd": "/work/charts", "host": "local"},
            {"id": "remote", "label": "Remote", "cwd": "/work/charts", "host": "box"},
        ]

    def test_exact_root(self):
        self.assertEqual(resolve_project_id("/work/charts", "local", self.projects), "charts")

    def test_descendant(self):
        self.assertEqual(resolve_project_id("/work/charts/src/x", "local", self.projects), "charts")

    def test_longest_root_wins(self):
        self.assertEqual(resolve_project_id("/work/other", "local", self.projects), "code")
        self.assertEqual(resolve_project_id("/work/charts", "local", self.projects), "charts")

    def test_sibling_prefix_not_matched(self):
        projects = [{"id": "x", "label": "X", "cwd": "/code/x", "host": "local"}]
        self.assertIsNone(resolve_project_id("/code/x-old", "local", projects))

    def test_host_must_match(self):
        self.assertEqual(resolve_project_id("/work/charts", "box", self.projects), "remote")
        self.assertIsNone(resolve_project_id("/elsewhere", "box", self.projects))

    def test_unmatched_and_empty(self):
        self.assertIsNone(resolve_project_id("/tmp/scratch", "local", self.projects))
        self.assertIsNone(resolve_project_id("", "local", self.projects))
        self.assertIsNone(resolve_project_id("/work", "local", []))

    def test_trailing_slash_in_cwd(self):
        self.assertEqual(resolve_project_id("/work/charts/", "local", self.projects), "charts")


class AnnotateTests(unittest.TestCase):
    def setUp(self):
        self.projects = [{"id": "charts", "label": "Charts", "cwd": "/work/charts", "host": "local"}]
        self.agents = [
            {"pane_id": "w1:p1", "cwd": "/work/charts/src", "host": "local"},
            {"pane_id": "w2:p1", "cwd": "/tmp", "host": "local"},
            {"pane_id": "w3:p1", "cwd": "/work/charts", "host": "box"},
        ]

    def test_matched_only(self):
        annotate_agents(self.agents, self.projects)
        self.assertEqual(self.agents[0]["project_id"], "charts")
        self.assertNotIn("project_id", self.agents[1])
        self.assertNotIn("project_id", self.agents[2])

    def test_never_emits_null(self):
        annotate_agents(self.agents, self.projects)
        self.assertNotIn('"project_id": null', json.dumps(self.agents))

    def test_no_projects_is_a_no_op(self):
        annotate_agents(self.agents, [])
        self.assertTrue(all("project_id" not in a for a in self.agents))

    def test_public_projects_omit_cwd(self):
        pub = public_projects(self.projects)
        self.assertEqual(pub, [{"id": "charts", "label": "Charts", "host": "local"}])


class AmbiguousPaneTests(unittest.TestCase):
    def test_same_id_on_two_hosts(self):
        agents = [
            {"pane_id": "w8:p1", "host": "local"},
            {"pane_id": "w8:p1", "host": "box"},
            {"pane_id": "w9:p1", "host": "local"},
        ]
        self.assertEqual(ambiguous_pane_ids(agents), {"w8:p1"})

    def test_single_host_never_ambiguous(self):
        agents = [{"pane_id": "w8:p1", "host": "local"}, {"pane_id": "w8:p2", "host": "local"}]
        self.assertEqual(ambiguous_pane_ids(agents), set())

    def test_empty(self):
        self.assertEqual(ambiguous_pane_ids([]), set())


class WorkspaceResolutionTests(unittest.TestCase):
    def test_unknown_workspace(self):
        remote, err = resolve_workspace_remote([], "w8")
        self.assertIsNone(remote)
        self.assertEqual(err, "unknown workspace_id")

    def test_local_workspace(self):
        agents = [{"workspace_id": "w8", "remote": None}]
        self.assertEqual(resolve_workspace_remote(agents, "w8"), (None, None))

    def test_remote_workspace(self):
        agents = [{"workspace_id": "w8", "remote": "box"}]
        self.assertEqual(resolve_workspace_remote(agents, "w8"), ("box", None))

    def test_three_agents_one_host_is_not_ambiguous(self):
        agents = [{"workspace_id": "w8", "remote": "box"} for _ in range(3)]
        self.assertEqual(resolve_workspace_remote(agents, "w8"), ("box", None))

    def test_two_hosts_is_ambiguous(self):
        agents = [{"workspace_id": "w8", "remote": None}, {"workspace_id": "w8", "remote": "box"}]
        remote, err = resolve_workspace_remote(agents, "w8")
        self.assertIsNone(remote)
        self.assertIn("ambiguous", err)


if __name__ == "__main__":
    unittest.main()
