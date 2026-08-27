#!/usr/bin/env python3
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from projects import (
    MAX_CHILDREN,
    ProjectConfigError,
    ambiguous_pane_ids,
    annotate_agents,
    child_id,
    child_projects,
    load_projects,
    public_projects,
    resolve_project_id,
    resolve_workspace_remote,
    scan_root,
)


import herdr_relay  # noqa: E402


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

    def test_tilde_expands_for_local(self):
        got = load_projects(write_config([{"id": "a", "label": "A", "cwd": "~/code/x"}]))
        self.assertEqual(got[0]["cwd"], os.path.expanduser("~/code/x"))

    def test_tilde_rejected_for_remote(self):
        entries = [{"id": "a", "label": "A", "cwd": "~/code/x", "host": "box"}]
        with self.assertRaises(ProjectConfigError) as ctx:
            load_projects(write_config(entries), valid_hosts=["box"])
        self.assertIn("~", str(ctx.exception))

    def test_tilde_in_config_path(self):
        path = write_config([{"id": "a", "label": "A", "cwd": "/w"}])
        home = os.path.expanduser("~")
        if path.startswith(home):
            self.assertEqual(len(load_projects("~" + path[len(home):])), 1)

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

    def test_matched_panes_inherit_the_project_label(self):
        # The subdirectory case: cwd basename is "src", the Project is "Charts".
        panes = [{"pane_id": "w1:p1", "cwd": "/work/charts/src", "host": "local", "project": "src"}]
        annotate_agents(panes, self.projects)
        self.assertEqual(panes[0]["project"], "Charts")

    def test_unmatched_panes_keep_their_own_project(self):
        panes = [{"pane_id": "w2:p1", "cwd": "/tmp/scratch", "host": "local", "project": "scratch"}]
        annotate_agents(panes, self.projects)
        self.assertEqual(panes[0]["project"], "scratch")

    def test_the_label_never_adds_a_key_that_was_absent(self):
        # split_panes always emits "project"; nothing else should grow one, because a key added
        # here lands at the end of the dict and the wire's key order is a contract.
        annotate_agents(self.agents, self.projects)
        self.assertNotIn("project", self.agents[0])

    def test_never_emits_null(self):
        annotate_agents(self.agents, self.projects)
        self.assertNotIn('"project_id": null', json.dumps(self.agents))

    def test_no_projects_is_a_no_op(self):
        annotate_agents(self.agents, [])
        self.assertTrue(all("project_id" not in a for a in self.agents))

    def test_a_pushed_event_gets_the_same_label_as_a_snapshot(self):
        # The event hook names the project after the pane's own cwd, so without this the label
        # resolved by the last poll was overwritten every time an event arrived.
        with unittest.mock.patch.object(herdr_relay, "PROJECTS", self.projects):
            pushed = herdr_relay.annotate_pane(
                {"pane_id": "w1:p1", "agent": "claude", "status": "working",
                 "cwd": "/work/charts/src", "project": "src", "host": "local"}
            )
        self.assertEqual(pushed["project"], "Charts")
        self.assertEqual(pushed["project_id"], "charts")

    def test_a_pushed_event_outside_every_root_keeps_its_own_name(self):
        with unittest.mock.patch.object(herdr_relay, "PROJECTS", self.projects):
            pushed = herdr_relay.annotate_pane(
                {"pane_id": "w2:p1", "agent": "claude", "status": "working",
                 "cwd": "/tmp/scratch", "project": "scratch", "host": "local"}
            )
        self.assertEqual(pushed["project"], "scratch")
        self.assertNotIn("project_id", pushed)

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


class RootValidationTests(unittest.TestCase):
    """A root is a file entry like any other; only what it permits underneath is new."""

    def load(self, **over):
        entry = {"id": "common", "label": "Common", "cwd": "/work/common"}
        return load_projects(write_config([dict(entry, **over)]), valid_hosts=["box"])

    def test_a_plain_project_is_not_a_root(self):
        self.assertEqual(self.load()[0]["children"], False)

    def test_children_and_marker_are_carried(self):
        got = self.load(children=True, marker=".git")[0]
        self.assertEqual((got["children"], got["marker"]), (True, ".git"))

    def test_children_must_be_a_boolean(self):
        with self.assertRaisesRegex(ProjectConfigError, "children"):
            self.load(children="yes")

    def test_a_marker_is_a_file_name_and_never_a_path(self):
        # Joined onto a directory this module scanned, so a separator in it reaches one level
        # further down than the scan is allowed to look.
        # An empty marker is the same as none at all, which is why it is not in this list.
        for bad in ["../git", "a/b", " ", "x" * 65]:
            with self.subTest(bad=bad), self.assertRaises(ProjectConfigError):
                self.load(children=True, marker=bad)

    def test_a_marker_without_children_is_refused_not_ignored(self):
        with self.assertRaisesRegex(ProjectConfigError, "marker"):
            self.load(marker=".git")

    def test_a_remote_root_is_refused_rather_than_never_scanned(self):
        with self.assertRaisesRegex(ProjectConfigError, "local-only"):
            self.load(children=True, host="box", cwd="/work/common")


class ScanRootTests(unittest.TestCase):
    """What a listing of a root is allowed to call a project."""

    def setUp(self):
        self.root = self.enterContext(tempfile.TemporaryDirectory())

    def mk(self, *names):
        for n in names:
            os.makedirs(os.path.join(self.root, n), exist_ok=True)

    def test_direct_subdirectories_sorted(self):
        self.mk("beta", "alpha")
        self.assertEqual(scan_root(self.root), ["alpha", "beta"])

    def test_depth_one_only(self):
        # `src` lives under a child, not under the root, so it is never a candidate — which is
        # what makes "is src a project?" a question nobody has to answer.
        self.mk("proj/src")
        self.assertEqual(scan_root(self.root), ["proj"])

    def test_files_and_dotdirs_are_not_projects(self):
        self.mk(".cache")
        Path(self.root, "notes.md").write_text("x")
        self.assertEqual(scan_root(self.root), [])

    def test_a_symlink_is_skipped_rather_than_resolved(self):
        # The one way the *filesystem* could authorise a path outside the root, and an agent
        # working in one of these directories can make one.
        outside = self.enterContext(tempfile.TemporaryDirectory())
        os.symlink(outside, os.path.join(self.root, "escape"))
        self.assertEqual(scan_root(self.root), [])

    def test_a_marker_narrows_a_root_that_holds_other_things(self):
        self.mk("real", "junk")
        Path(self.root, "real", ".git").write_text("")
        self.assertEqual(scan_root(self.root, ".git"), ["real"])

    def test_a_root_that_is_not_there_has_no_children(self):
        self.assertEqual(scan_root(os.path.join(self.root, "gone")), [])

    def test_the_listing_is_capped(self):
        self.mk(*[f"p{i:03d}" for i in range(MAX_CHILDREN + 5)])
        self.assertEqual(len(scan_root(self.root)), MAX_CHILDREN)


class ChildProjectsTests(unittest.TestCase):
    """Children are ordinary project rows, which is what makes the rest of the relay work."""

    def roots(self, **over):
        return [dict({"id": "common", "label": "Common", "cwd": "/work/common",
                      "host": "local", "children": True, "marker": ""}, **over)]

    def scanner(self, *names):
        return lambda cwd, marker: list(names)

    def test_a_directory_becomes_a_project_under_its_root(self):
        got = child_projects(self.roots(), scan=self.scanner("webapp"))
        self.assertEqual(got, [{"id": "common-webapp", "label": "webapp",
                                "cwd": "/work/common/webapp", "host": "local",
                                "children": False, "marker": "", "parent": "common"}])

    def test_a_project_that_is_not_a_root_is_never_scanned(self):
        plain = [dict(self.roots()[0], children=False)]
        self.assertEqual(child_projects(plain, scan=self.scanner("webapp")), [])

    def test_a_name_outside_the_id_charset_still_gets_one(self):
        got = child_projects(self.roots(), scan=self.scanner("charts.TS"))
        # The id is folded; the label and the cwd keep the real directory name.
        self.assertEqual((got[0]["id"], got[0]["label"], got[0]["cwd"]),
                         ("common-charts-ts", "charts.TS", "/work/common/charts.TS"))

    def test_two_names_that_fold_to_one_id_keep_the_first(self):
        got = child_projects(self.roots(), scan=self.scanner("web-app", "web.app"))
        self.assertEqual([c["label"] for c in got], ["web-app"])

    def test_a_written_entry_wins_over_a_scanned_one(self):
        # It has a label somebody chose and an id other documents already point at.
        written = self.roots() + [{"id": "webapp", "label": "Web App",
                                   "cwd": "/work/common/webapp", "host": "local",
                                   "children": False, "marker": ""}]
        self.assertEqual(child_projects(written, scan=self.scanner("webapp")), [])

    def test_a_name_that_folds_to_nothing_is_dropped(self):
        self.assertEqual(child_projects(self.roots(), scan=self.scanner("...")), [])

    def test_child_id_is_its_root_and_its_directory(self):
        self.assertEqual(child_id("common", "Web App"), "common-web-app")

    def test_a_child_is_grouped_under_itself_not_its_root(self):
        # The whole reason children are ordinary rows: longest-root-wins already does this.
        every = self.roots() + child_projects(self.roots(), scan=self.scanner("webapp"))
        self.assertEqual(
            resolve_project_id("/work/common/webapp/src/deep", "local", every), "common-webapp")
        self.assertEqual(resolve_project_id("/work/common/loose", "local", every), "common")

    def test_only_a_child_says_who_its_parent_is(self):
        every = self.roots() + child_projects(self.roots(), scan=self.scanner("webapp"))
        self.assertEqual(public_projects(every), [
            {"id": "common", "label": "Common", "host": "local"},
            {"id": "common-webapp", "label": "webapp", "host": "local", "parent": "common"},
        ])


class RefreshProjectsTests(unittest.TestCase):
    """The roster follows the disk without a restart, and a bad edit does not cost a session."""

    def setUp(self):
        self.root = self.enterContext(tempfile.TemporaryDirectory())
        self.path = write_config([{"id": "common", "label": "Common",
                                   "cwd": self.root, "children": True}])
        self.enterContext(unittest.mock.patch.object(herdr_relay, "PROJECTS_PATH", self.path))
        self.enterContext(unittest.mock.patch.object(herdr_relay, "_projects_stamp", ()))
        self.enterContext(unittest.mock.patch.object(herdr_relay, "_projects_listed", 0.0))
        self.enterContext(unittest.mock.patch.object(herdr_relay, "FILE_PROJECTS", []))
        self.enterContext(unittest.mock.patch.object(herdr_relay, "PROJECTS", []))

    def ids(self):
        return [p["id"] for p in herdr_relay.PROJECTS]

    def test_the_first_pass_reads_the_file(self):
        self.assertTrue(herdr_relay.refresh_projects())
        self.assertEqual(self.ids(), ["common"])

    def test_an_unchanged_roster_is_not_broadcast_again(self):
        herdr_relay.refresh_projects()
        self.assertFalse(herdr_relay.refresh_projects())

    def test_a_new_directory_is_a_project_on_the_next_pass(self):
        herdr_relay.refresh_projects()
        os.makedirs(os.path.join(self.root, "webapp"))
        self.assertTrue(herdr_relay.refresh_projects())
        self.assertEqual(self.ids(), ["common", "common-webapp"])

    def test_a_bad_edit_keeps_the_roster_that_worked(self):
        herdr_relay.refresh_projects()
        Path(self.path).write_text("{ not json")
        self.assertFalse(herdr_relay.refresh_projects())
        self.assertEqual(self.ids(), ["common"])

    def test_no_projects_file_means_nothing_to_refresh(self):
        with unittest.mock.patch.object(herdr_relay, "PROJECTS_PATH", ""):
            self.assertFalse(herdr_relay.refresh_projects())
