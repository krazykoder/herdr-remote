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
    child_path_ok,
    child_projects,
    child_target,
    create_child,
    make_child_dir,
    load_projects,
    public_projects,
    resolve_project_id,
    resolve_workspace_remote,
    scan_root,
)


import herdr_relay  # noqa: E402
import start_agent  # noqa: E402


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

    def test_an_id_collision_at_another_cwd_is_reported_not_swallowed(self):
        # Two directories can fold to one id, and an id is what every other document points at.
        # The authorised entry keeps it; the loser has to be findable, or a directory somebody
        # made is permanently not a project with nothing said anywhere.
        written = self.roots() + [{"id": "common-web-app", "label": "Web App",
                                   "cwd": "/work/elsewhere", "host": "local",
                                   "children": False, "marker": ""}]
        notes = []
        got = child_projects(written, scan=self.scanner("web.app"),
                             note=lambda *row: notes.append(row))
        self.assertEqual(got, [])
        self.assertEqual(notes, [("common", "web.app", "its id (common-web-app) is already taken")])

    def test_the_loser_of_a_fold_collision_is_reported(self):
        notes = []
        got = child_projects(self.roots(), scan=self.scanner("web-app", "web.app"),
                             note=lambda *row: notes.append(row))
        self.assertEqual([c["label"] for c in got], ["web-app"])
        self.assertEqual([(n[1], "taken" in n[2]) for n in notes], [("web.app", True)])

    def test_a_directory_an_explicit_entry_already_claims_is_not_a_skip(self):
        # It is a project, under the name somebody chose for it — nothing was lost, so nothing is
        # reported. This is the case the collision notes must not be confused with.
        written = self.roots() + [{"id": "webapp", "label": "Web App",
                                   "cwd": "/work/common/webapp", "host": "local",
                                   "children": False, "marker": ""}]
        notes = []
        child_projects(written, scan=self.scanner("webapp"), note=lambda *row: notes.append(row))
        self.assertEqual(notes, [])

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
            {"id": "common", "label": "Common", "host": "local", "root": True},
            {"id": "common-webapp", "label": "webapp", "host": "local", "parent": "common"},
        ])

    def test_a_marker_root_does_not_say_a_start_may_make_a_child(self):
        # It can list one, but the relay cannot write the marker file — so a directory a start
        # made there would never be adopted, and the app is told not to offer the field.
        roots = [dict(self.roots()[0], marker=".git")]
        self.assertEqual(public_projects(roots),
                         [{"id": "common", "label": "Common", "host": "local"}])


class RefreshProjectsTests(unittest.TestCase):
    """The roster follows the disk without a restart, and a bad edit does not cost a session."""

    def setUp(self):
        self.root = self.enterContext(tempfile.TemporaryDirectory())
        self.path = write_config([{"id": "common", "label": "Common",
                                   "cwd": self.root, "children": True}])
        self.enterContext(unittest.mock.patch.object(herdr_relay, "PROJECTS_PATH", self.path))
        self.enterContext(unittest.mock.patch.object(herdr_relay, "_projects_stamp", ()))
        self.enterContext(unittest.mock.patch.object(herdr_relay, "_projects_listed", 0.0))
        self.enterContext(unittest.mock.patch.object(herdr_relay, "_projects_skipped", ()))
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

    def test_a_directory_that_is_not_a_project_is_logged_once(self):
        # The reason has to reach a human, and it has to stop reaching them once they have it:
        # the condition stays true for as long as the directory does, and the poll runs forever.
        os.makedirs(os.path.join(self.root, "web-app"))
        os.makedirs(os.path.join(self.root, "web.app"))
        with self.assertLogs("herdr-relay", level="WARNING") as caught:
            herdr_relay.refresh_projects()
        self.assertEqual(len(caught.output), 1)
        self.assertIn("common/web.app", caught.output[0])
        self.assertIn("already taken", caught.output[0])
        # Same skip, same reason, nothing new to say.
        herdr_relay._projects_listed = 0.0
        with self.assertNoLogs("herdr-relay", level="WARNING"):
            herdr_relay.refresh_projects()

    def test_no_projects_file_means_nothing_to_refresh(self):
        with unittest.mock.patch.object(herdr_relay, "PROJECTS_PATH", ""):
            self.assertFalse(herdr_relay.refresh_projects())


class ChildPathGuardTests(unittest.TestCase):
    """The scan is one moment and a start is a later one. This is the later one."""

    def setUp(self):
        self.root = os.path.realpath(self.enterContext(tempfile.TemporaryDirectory()))
        self.outside = os.path.realpath(self.enterContext(tempfile.TemporaryDirectory()))
        os.makedirs(os.path.join(self.root, "webapp"))
        self.projects = [
            {"id": "common", "label": "Common", "cwd": self.root, "host": "local",
             "children": True, "marker": ""},
        ] + child_projects([{"id": "common", "label": "Common", "cwd": self.root,
                             "host": "local", "children": True, "marker": ""}])

    def child(self):
        return next(p for p in self.projects if p.get("parent"))

    def swap_for_a_symlink(self):
        """What the scan cannot see: the directory it listed, replaced after it listed it."""
        path = self.child()["cwd"]
        os.rmdir(path)
        os.symlink(self.outside, path)

    def test_a_real_directory_under_its_root_is_allowed(self):
        self.assertTrue(child_path_ok(self.child(), self.projects))

    def test_a_directory_swapped_for_a_symlink_after_the_scan_is_refused(self):
        self.swap_for_a_symlink()
        self.assertFalse(child_path_ok(self.child(), self.projects))

    def test_a_directory_that_has_gone_away_is_refused(self):
        os.rmdir(self.child()["cwd"])
        self.assertFalse(child_path_ok(self.child(), self.projects))

    def test_a_file_project_is_not_asked_about_its_symlinks(self):
        # Authorised by the file itself; a user who points their own config at one meant it.
        root = next(p for p in self.projects if not p.get("parent"))
        self.assertTrue(child_path_ok(root, self.projects))

    def test_a_child_whose_root_is_gone_is_refused(self):
        self.assertFalse(child_path_ok(self.child(), [self.child()]))

    def test_a_start_into_a_swapped_directory_is_refused(self):
        self.swap_for_a_symlink()
        plan, err = start_agent.validate_start_request(
            {"type": "start_agent", "name": "claude", "role": "agent",
             "project_id": self.child()["id"], "placement": "new_workspace"},
            self.projects, [], ["claude"])
        self.assertIsNone(plan)
        self.assertIn("no longer inside its root", err)

    def test_open_terminal_is_refused_by_the_same_guard(self):
        # Both routes go through _placement_plan, which is the whole reason the check sits there.
        self.swap_for_a_symlink()
        plan, err = start_agent.validate_open_terminal(
            {"type": "open_terminal", "project_id": self.child()["id"],
             "placement": "new_workspace"},
            self.projects, [])
        self.assertIsNone(plan)
        self.assertIn("no longer inside its root", err)

    def test_both_routes_still_work_before_the_swap(self):
        # Or the two refusals above would pass against a guard that refuses everything — and a
        # regression that broke *valid* derived starts would be invisible. Both routes, so both
        # are covered going through as well as being stopped.
        routes = (
            (lambda m: start_agent.validate_start_request(m, self.projects, [], ["claude"]),
             {"type": "start_agent", "name": "claude", "role": "agent",
              "project_id": self.child()["id"], "placement": "new_workspace"}),
            (lambda m: start_agent.validate_open_terminal(m, self.projects, []),
             {"type": "open_terminal", "project_id": self.child()["id"],
              "placement": "new_workspace"}),
        )
        for call, msg in routes:
            with self.subTest(route=msg["type"]):
                plan, err = call(msg)
                self.assertIsNone(err)
                self.assertEqual(plan["cwd"], os.path.join(self.root, "webapp"))
                self.assertEqual(plan["parent"], "common")

    def test_the_executor_looks_once_more_before_it_creates_anything(self):
        # The gap validation cannot cover: a config line is built and the work is queued between
        # the check and the spawn. Narrower, not closed — see the ponytail note at the call site.
        plan, err = start_agent.validate_open_terminal(
            {"type": "open_terminal", "project_id": self.child()["id"],
             "placement": "new_workspace"}, self.projects, [])
        self.assertIsNone(err)
        self.swap_for_a_symlink()
        with unittest.mock.patch.object(herdr_relay, "PROJECTS", self.projects):
            pane, rollback, exec_err = herdr_relay._create_target_pane(plan, None)
        self.assertIsNone(pane)
        self.assertIn("no longer inside its root", exec_err)

    def test_the_executor_refuses_a_plan_whose_row_moved_under_its_id(self):
        # A derived id folds the directory name, so two different directories can present the
        # same id — here `webapp` and `webapp.`, which differ on disk and fold to one slug. The
        # planned `webapp` is swapped for a symlink out of the root; the next scan skips the
        # symlink and hands `common-webapp` to `webapp.`, which really is under the root. So the
        # re-check passes on the new row while the herdr calls below still carry the old path.
        # Both the check and the spawn must refuse, and neither directory may be started in.
        plan, err = start_agent.validate_open_terminal(
            {"type": "open_terminal", "project_id": self.child()["id"],
             "placement": "new_workspace"}, self.projects, [])
        self.assertIsNone(err)
        planned_cwd = plan["cwd"]

        os.makedirs(os.path.join(self.root, "webapp."))
        self.swap_for_a_symlink()
        roots = [p for p in self.projects if not p.get("parent")]
        rescanned = roots + child_projects(roots)
        stand_in = next(p for p in rescanned if p.get("parent"))
        self.assertEqual(stand_in["id"], plan["project_id"])
        self.assertNotEqual(stand_in["cwd"], planned_cwd)
        self.assertTrue(child_path_ok(stand_in, rescanned))  # the new row is genuinely fine

        with unittest.mock.patch.object(herdr_relay, "PROJECTS", rescanned), \
                unittest.mock.patch.object(herdr_relay, "_herdr_json") as herdr_call:
            pane, _, exec_err = herdr_relay._create_target_pane(plan, None)
        self.assertIsNone(pane)
        self.assertIn("changed since the start was planned", exec_err)
        herdr_call.assert_not_called()

    def test_the_executor_leaves_a_file_project_alone(self):
        # It has no `parent`, so there is nothing derived to re-check and no herdr call is made
        # here that was not made before.
        plan = {"project_id": "common", "parent": "", "cwd": self.root,
                "placement": "new_workspace", "project_label": "Common"}
        with unittest.mock.patch.object(herdr_relay, "PROJECTS", self.projects), \
                unittest.mock.patch.object(herdr_relay, "_herdr_json",
                                           return_value=(None, "herdr not called for real")):
            _, _, exec_err = herdr_relay._create_target_pane(plan, None)
        self.assertEqual(exec_err, "herdr not called for real")


class CreateProjectTests(unittest.TestCase):
    """A Project made without starting anything: the directory is the whole registration."""

    def setUp(self):
        # The root sits *inside* a temporary directory rather than being one. The swap test below
        # renames it to a sibling, and a sibling of a system temp directory is a directory nothing
        # cleans up — so that test passed once per machine and failed on every run afterwards, on
        # the rename, with "Directory not empty".
        base = os.path.realpath(self.enterContext(tempfile.TemporaryDirectory()))
        self.root = os.path.join(base, "root")
        self.outside = os.path.realpath(self.enterContext(tempfile.TemporaryDirectory()))
        os.makedirs(os.path.join(self.root, "webapp"))
        self.roots = [{"id": "common", "label": "Common", "cwd": self.root, "host": "local",
                       "children": True, "marker": "", "container": False}]
        self.projects = self.roots + child_projects(self.roots)

    def test_a_new_name_becomes_a_directory_and_the_row_the_scan_will_build(self):
        project, err = create_child("notes", "common", self.projects)
        self.assertIsNone(err)
        self.assertEqual(project["id"], "common-notes")
        self.assertEqual(project["label"], "notes")
        self.assertEqual(project["parent"], "common")
        self.assertTrue(os.path.isdir(os.path.join(self.root, "notes")))
        # The row it returned is the row a rescan derives, which is what makes the mkdir the
        # only thing that had to happen.
        scanned = child_projects(self.roots)
        self.assertIn(project["id"], [p["id"] for p in scanned])

    def test_a_name_that_is_already_a_project_answers_with_that_project(self):
        project, err = create_child("webapp", "common", self.projects)
        self.assertIsNone(err)
        self.assertEqual(project["id"], "common-webapp")

    def test_a_project_that_is_not_a_root_takes_no_new_child(self):
        projects = self.projects + [{"id": "solo", "label": "Solo", "cwd": self.outside,
                                     "host": "local", "children": False, "marker": ""}]
        project, err = create_child("notes", "solo", projects)
        self.assertIsNone(project)
        self.assertEqual(err, "unknown root")

    def test_an_unknown_root_is_refused(self):
        project, err = create_child("notes", "nope", self.projects)
        self.assertIsNone(project)
        self.assertEqual(err, "unknown root")

    def test_a_root_whose_directory_is_gone_is_not_made_again(self):
        gone = os.path.join(self.outside, "went-away")
        roots = [dict(self.roots[0], cwd=gone)]
        project, err = create_child("notes", "common", roots)
        self.assertIsNone(project)
        self.assertEqual(err, "that root is no longer a directory")
        self.assertFalse(os.path.exists(gone))

    def test_a_name_outside_the_charset_is_refused_before_anything_is_made(self):
        project, err = create_child("../escape", "common", self.projects)
        self.assertIsNone(project)
        self.assertIn("child must be", err)
        self.assertEqual(sorted(os.listdir(self.root)), ["webapp"])

    def test_a_marker_root_takes_no_new_child(self):
        roots = [dict(self.roots[0], marker=".git")]
        project, err = create_child("notes", "common", roots)
        self.assertIsNone(project)
        self.assertIn(".git", err)

    def test_a_name_already_holding_a_symlink_out_of_the_root_is_refused(self):
        os.symlink(self.outside, os.path.join(self.root, "away"))
        project, err = create_child("away", "common", self.projects)
        self.assertIsNone(project)
        self.assertEqual(err, "that name is not a directory inside this root")

    def test_a_root_swapped_during_mkdir_cannot_redirect_the_write(self):
        parent = os.path.dirname(self.root)
        old = os.path.join(parent, "root-before-swap")
        real_mkdir = os.mkdir

        def swap_then_mkdir(name, *, dir_fd=None):
            os.rename(self.root, old)
            os.symlink(self.outside, self.root)
            return real_mkdir(name, dir_fd=dir_fd)

        with unittest.mock.patch("projects.os.mkdir", swap_then_mkdir):
            project, err = create_child("notes", "common", self.projects)
        self.assertIsNone(project)
        self.assertEqual(err, "that name is not a directory inside this root")
        self.assertTrue(os.path.isdir(os.path.join(old, "notes")))
        self.assertFalse(os.path.exists(os.path.join(self.outside, "notes")))


class ContainerRootTests(unittest.TestCase):
    """A root that is a place for projects rather than one to work in."""

    def test_a_container_root_says_so_on_the_wire(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        path = write_config([{"id": "scratch", "label": "Scratch", "cwd": tmp,
                              "children": True, "container": True}])
        wire = public_projects(load_projects(path))
        self.assertEqual(wire, [{"id": "scratch", "label": "Scratch", "host": "local",
                                 "root": True, "container": True}])

    def test_a_root_that_is_not_a_container_says_nothing(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        path = write_config([{"id": "scratch", "label": "Scratch", "cwd": tmp, "children": True}])
        self.assertNotIn("container", public_projects(load_projects(path))[0])

    def test_container_without_children_is_refused(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        path = write_config([{"id": "solo", "label": "Solo", "cwd": tmp, "container": True}])
        with self.assertRaises(ProjectConfigError) as e:
            load_projects(path)
        self.assertIn("container means nothing without children", str(e.exception))

    def test_container_must_be_a_boolean(self):
        tmp = self.enterContext(tempfile.TemporaryDirectory())
        path = write_config([{"id": "solo", "label": "Solo", "cwd": tmp,
                              "children": True, "container": "yes"}])
        with self.assertRaises(ProjectConfigError) as e:
            load_projects(path)
        self.assertIn("container must be true or false", str(e.exception))

    def test_a_container_root_still_takes_children(self):
        tmp = os.path.realpath(self.enterContext(tempfile.TemporaryDirectory()))
        roots = [{"id": "scratch", "label": "Scratch", "cwd": tmp, "host": "local",
                  "children": True, "marker": "", "container": True}]
        project, err = create_child("notes", "scratch", roots)
        self.assertIsNone(err)
        self.assertEqual(project["id"], "scratch-notes")


class ChildOnAStartTests(unittest.TestCase):
    """A start may name a directory under a root, and the relay makes it. Nothing else does."""

    def setUp(self):
        self.root = os.path.realpath(self.enterContext(tempfile.TemporaryDirectory()))
        self.outside = os.path.realpath(self.enterContext(tempfile.TemporaryDirectory()))
        os.makedirs(os.path.join(self.root, "webapp"))
        self.roots = [{"id": "common", "label": "Common", "cwd": self.root, "host": "local",
                       "children": True, "marker": ""}]
        self.projects = self.roots + child_projects(self.roots)

    def start(self, **fields):
        msg = {"type": "start_agent", "name": "claude", "role": "agent",
               "project_id": "common", "placement": "new_workspace"}
        msg.update(fields)
        return start_agent.validate_start_request(msg, self.projects, [], ["claude"])

    def test_a_start_can_name_a_directory_that_does_not_exist_yet(self):
        plan, err = self.start(child="notes")
        self.assertIsNone(err)
        self.assertEqual(plan["cwd"], os.path.join(self.root, "notes"))
        self.assertEqual(plan["project_id"], "common-notes")
        self.assertEqual(plan["parent"], "common")
        self.assertEqual(plan["create_child"], "notes")
        # Validation decides; it does not create. The directory appears at the executor.
        self.assertFalse(os.path.exists(plan["cwd"]))

    def test_a_child_that_already_exists_is_started_in_rather_than_made_again(self):
        plan, err = self.start(child="webapp")
        self.assertIsNone(err)
        self.assertEqual(plan["project_id"], "common-webapp")
        self.assertEqual(plan["cwd"], os.path.join(self.root, "webapp"))
        self.assertEqual(plan["create_child"], "")

    def test_a_name_outside_the_charset_is_refused(self):
        for name in ("..", ".", ".hidden", "a..b", "a/b", "/etc", "-x", " notes ", "", None,
                     7, "a\0b", "x" * 65):
            with self.subTest(child=name):
                plan, err = self.start(child=name)
                self.assertIsNone(plan)
                self.assertIn("child must be", err)

    def test_a_name_that_is_a_symlink_is_refused(self):
        os.symlink(self.outside, os.path.join(self.root, "link"))
        plan, err = self.start(child="link")
        self.assertIsNone(plan)
        self.assertEqual(err, "that name is not a directory inside this root")

    def test_a_name_that_is_a_file_is_refused(self):
        open(os.path.join(self.root, "notes"), "w").close()
        plan, err = self.start(child="notes")
        self.assertIsNone(plan)
        self.assertEqual(err, "that name is not a directory inside this root")

    def test_a_project_that_is_not_a_root_refuses_a_child(self):
        plan, err = self.start(project_id="common-webapp", child="deeper")
        self.assertIsNone(plan)
        self.assertEqual(err, "that project is not a root")

    def test_a_root_with_a_marker_refuses_a_new_child(self):
        self.roots[0]["marker"] = ".git"
        plan, err = self.start(child="notes")
        self.assertIsNone(plan)
        self.assertIn(".git", err)

    def test_a_name_whose_id_is_already_another_directory_is_refused(self):
        # `web.app` is a project, and `web-app` folds onto the same id — so the directory this
        # start would make is one no scan will ever adopt. First wins, and it already has.
        os.makedirs(os.path.join(self.root, "web.app"))
        self.projects = self.roots + child_projects(self.roots)
        plan, err = self.start(child="web-app")
        self.assertIsNone(plan)
        self.assertIn("common-web-app", err)
        self.assertIn("already taken", err)
        self.assertFalse(os.path.exists(os.path.join(self.root, "web-app")))

    def test_open_terminal_cannot_name_a_child(self):
        plan, err = start_agent.validate_open_terminal(
            {"type": "open_terminal", "project_id": "common", "placement": "new_workspace",
             "child": "notes"}, self.projects, [])
        self.assertIsNone(plan)
        self.assertIn("unexpected field(s)", err)
        self.assertIn("child", err)

    def test_the_executor_creates_it_and_the_next_scan_finds_it(self):
        plan, err = self.start(child="notes")
        self.assertIsNone(err)
        with unittest.mock.patch.object(herdr_relay, "PROJECTS", self.projects), \
                unittest.mock.patch.object(herdr_relay, "_herdr_json",
                                           return_value=(None, "herdr not called for real")):
            _, _, exec_err = herdr_relay._create_target_pane(plan, None)
        # Past the guard and into the herdr call, which is where the stub answers.
        self.assertEqual(exec_err, "herdr not called for real")
        self.assertTrue(os.path.isdir(plan["cwd"]))
        # Creation and adoption converge: nothing was registered, and the scan finds it anyway.
        rescanned = child_projects(self.roots)
        row = next(p for p in rescanned if p["id"] == "common-notes")
        self.assertEqual(row["cwd"], plan["cwd"])
        self.assertEqual(row["parent"], "common")

    def test_the_executor_refuses_a_root_that_moved_and_makes_nothing(self):
        plan, err = self.start(child="notes")
        self.assertIsNone(err)
        moved = [dict(self.roots[0], cwd=self.outside)]
        with unittest.mock.patch.object(herdr_relay, "PROJECTS", moved), \
                unittest.mock.patch.object(herdr_relay, "_herdr_json") as herdr_call:
            pane, _, exec_err = herdr_relay._create_target_pane(plan, None)
        self.assertIsNone(pane)
        self.assertIn("that root has changed", exec_err)
        self.assertFalse(os.path.exists(plan["cwd"]))
        herdr_call.assert_not_called()

    def test_the_executor_refuses_a_root_that_is_gone_and_makes_nothing(self):
        plan, err = self.start(child="notes")
        self.assertIsNone(err)
        os.rmdir(os.path.join(self.root, "webapp"))
        os.rmdir(self.root)
        with unittest.mock.patch.object(herdr_relay, "PROJECTS", self.roots), \
                unittest.mock.patch.object(herdr_relay, "_herdr_json") as herdr_call:
            pane, _, exec_err = herdr_relay._create_target_pane(plan, None)
        self.assertIsNone(pane)
        self.assertIn("root is no longer a directory", exec_err)
        self.assertFalse(os.path.exists(self.root))
        herdr_call.assert_not_called()

    def test_the_executor_refuses_a_child_id_claimed_since_validation(self):
        plan, err = self.start(child="notes")
        self.assertIsNone(err)
        os.makedirs(os.path.join(self.root, "notes."))
        rescanned = self.roots + child_projects(self.roots)
        with unittest.mock.patch.object(herdr_relay, "PROJECTS", rescanned), \
                unittest.mock.patch.object(herdr_relay, "_herdr_json") as herdr_call:
            pane, _, exec_err = herdr_relay._create_target_pane(plan, None)
        self.assertIsNone(pane)
        self.assertIn("already taken", exec_err)
        self.assertFalse(os.path.exists(plan["cwd"]))
        herdr_call.assert_not_called()

    def test_a_symlink_planted_at_the_mkdir_still_loses(self):
        # makedirs(exist_ok=True) is satisfied by a symlink to a directory — isdir follows it — so
        # the check after it is the guard, not a formality.
        plan, err = self.start(child="notes")
        self.assertIsNone(err)
        outside = self.outside

        def plant(cwd, root):
            os.symlink(outside, cwd)
            return None

        with unittest.mock.patch.object(herdr_relay, "PROJECTS", self.projects), \
                unittest.mock.patch.object(herdr_relay, "make_child_dir", plant), \
                unittest.mock.patch.object(herdr_relay, "_herdr_json") as herdr_call:
            pane, _, exec_err = herdr_relay._create_target_pane(plan, None)
        self.assertIsNone(pane)
        self.assertIn("no longer inside its root", exec_err)
        herdr_call.assert_not_called()

    def test_make_child_dir_refuses_to_build_outside_the_root(self):
        with self.assertRaises(AssertionError):
            make_child_dir(self.outside, self.root)

    def test_child_target_is_the_only_place_the_name_becomes_a_path(self):
        child, create, err = child_target("notes", self.roots[0], self.projects)
        self.assertIsNone(err)
        self.assertEqual(create, "notes")
        self.assertEqual(child["cwd"], os.path.join(self.root, "notes"))
        self.assertIsNone(make_child_dir(child["cwd"], self.root))
        self.assertTrue(child_path_ok(child, self.projects))


if __name__ == "__main__":
    unittest.main()
