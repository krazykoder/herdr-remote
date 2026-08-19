"""Where the work landed: the branch, the commit, and the range between two turns.

Every test builds a real repository in a temp directory — there is nothing to mock, git is the
thing under test, and a fake one would only prove the fake agrees with itself.

    .venv313/bin/python -m unittest discover -s tests -t tests
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "relay"))

import git_probe  # noqa: E402
from conversation_log import ConversationLog  # noqa: E402
from conv_query import as_wire, open_ro, query  # noqa: E402

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")

ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@e",
       "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@e", "GIT_CONFIG_GLOBAL": os.devnull}


class GitRepo:
    def __init__(self, path):
        self.path = path
        self.run("git", "init", "-q", "-b", "work")

    def run(self, *argv):
        return subprocess.run(argv, cwd=self.path, env=ENV, capture_output=True, text=True,
                              check=True).stdout.strip()

    def commit(self, subject, body="x"):
        with open(os.path.join(self.path, "f"), "w") as fh:
            fh.write(body)
        self.run("git", "add", "f")
        self.run("git", "commit", "-qm", subject)
        return self.run("git", "rev-parse", "HEAD")


class GitProbeTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.repo = GitRepo(self.dir.name)

    def test_head_is_the_branch_and_the_sha(self):
        sha = self.repo.commit("first")
        self.assertEqual(git_probe.head(self.dir.name), ("work", sha))

    def test_a_detached_head_reports_no_branch(self):
        # It is a commit and not a branch. Reporting the literal "HEAD" that rev-parse prints would
        # put a branch called HEAD in the record, which reads later as a real one.
        sha = self.repo.commit("first")
        self.repo.run("git", "checkout", "-q", "--detach")
        self.assertEqual(git_probe.head(self.dir.name), ("", sha))

    def test_a_directory_that_is_not_a_repository_is_not_an_error(self):
        with tempfile.TemporaryDirectory() as plain:
            self.assertEqual(git_probe.head(plain), ("", ""))
            self.assertIsNone(git_probe.probe(plain))

    def test_no_cwd_at_all(self):
        self.assertEqual(git_probe.head(""), ("", ""))

    def test_the_range_is_what_was_committed_between_two_turns(self):
        first = self.repo.commit("first")
        self.repo.commit("second", "2")
        third = self.repo.commit("third", "3")
        got = git_probe.commits(self.dir.name, first, third)
        self.assertEqual([c["subject"] for c in got], ["second", "third"], "oldest first")
        self.assertEqual(got[-1]["sha"], third)

    def test_a_range_that_did_not_move_is_empty(self):
        sha = self.repo.commit("first")
        self.assertEqual(git_probe.commits(self.dir.name, sha, sha), [])

    def test_a_sha_git_has_disowned_yields_nothing_rather_than_a_guess(self):
        # A rebase or a reset leaves the record holding a commit this repository can no longer
        # reach. Returning the whole history instead would attach every commit ever made to one
        # turn, which is worse than attaching none.
        sha = self.repo.commit("first")
        self.assertEqual(git_probe.commits(self.dir.name, "0" * 40, sha), [])

    def test_the_range_is_bounded(self):
        first = self.repo.commit("first")
        for i in range(git_probe.COMMITS_MAX + 5):
            self.repo.commit(f"c{i}", str(i))
        got = git_probe.commits(self.dir.name, first, self.repo.run("git", "rev-parse", "HEAD"))
        self.assertEqual(len(got), git_probe.COMMITS_MAX)

    def test_a_subject_with_a_tab_in_it_survives_the_split(self):
        # The fields are separated by a unit separator precisely because a subject can hold a tab.
        first = self.repo.commit("first")
        self.repo.commit("fix:\tthe thing", "2")
        got = git_probe.commits(self.dir.name, first, self.repo.run("git", "rev-parse", "HEAD"))
        self.assertEqual(got[0]["subject"], "fix:\tthe thing")

    def test_a_long_subject_is_trimmed(self):
        first = self.repo.commit("first")
        self.repo.commit("x" * (git_probe.SUBJECT_MAX + 50), "2")
        got = git_probe.commits(self.dir.name, first, self.repo.run("git", "rev-parse", "HEAD"))
        self.assertEqual(len(got[0]["subject"]), git_probe.SUBJECT_MAX)

    def test_probe_without_a_previous_commit_claims_no_range(self):
        # The first turn ever recorded for a directory has no other end. Everything before it is
        # history that belongs to no turn, and claiming it would date the whole repository to now.
        self.repo.commit("first")
        got = git_probe.probe(self.dir.name)
        self.assertEqual(got["commits"], [])
        self.assertEqual(got["branch"], "work")

    def test_the_cache_collapses_one_moment_into_one_call(self):
        # A turn end writes several rows out of one screen; they must not be several subprocesses.
        self.repo.commit("first")
        cache = git_probe.Cache(ttl=60)
        calls = []
        real = git_probe.probe
        git_probe.probe = lambda *a, **k: (calls.append(a), real(*a, **k))[1]
        self.addCleanup(lambda: setattr(git_probe, "probe", real))
        for _ in range(4):
            cache.probe(self.dir.name)
        self.assertEqual(len(calls), 1)

    def test_the_cache_is_per_directory(self):
        self.repo.commit("first")
        cache = git_probe.Cache(ttl=60)
        with tempfile.TemporaryDirectory() as other_dir:
            other = GitRepo(other_dir)
            other.run("git", "checkout", "-q", "-b", "elsewhere")
            other.commit("theirs")
            self.assertEqual(cache.probe(self.dir.name)["branch"], "work")
            self.assertEqual(cache.probe(other_dir)["branch"], "elsewhere")


class RecordedGitTest(unittest.TestCase):
    """What the record does with a probe, and what a client reads back."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, "rec.sqlite3")
        self.log = ConversationLog(self.db)
        self.addCleanup(self.log.close)

    def wire(self):
        return [as_wire(r) for r in self.log.query()[0]]

    def record(self, **kw):
        base = dict(agent="claude", pane_id="w1:p1", kind="agent_final", origin="agent",
                    at_src="poll", host="local", cwd="/work", text="done")
        return self.log.record(**{**base, **kw})

    def test_a_turn_carries_its_branch_commit_and_commits(self):
        self.record(git={"branch": "work", "commit": "a" * 40,
                         "commits": [{"sha": "b" * 40, "subject": "second"}]})
        row = self.wire()[0]
        self.assertEqual(row["branch"], "work")
        self.assertEqual(row["commit"], "a" * 40)
        self.assertEqual(row["commits"], [{"sha": "b" * 40, "subject": "second"}])

    def test_a_turn_with_no_repository_reads_back_as_no_repository(self):
        self.record()
        row = self.wire()[0]
        self.assertEqual((row["branch"], row["commit"], row["commits"]), ("", "", []))

    def test_last_commit_is_the_other_end_of_the_next_range(self):
        self.record(git={"branch": "work", "commit": "a" * 40})
        self.record(git={"branch": "work", "commit": "c" * 40}, at=None)
        self.assertEqual(self.log.last_commit("local", "/work"), "c" * 40)

    def test_last_commit_is_per_directory_and_per_host(self):
        self.record(cwd="/work", git={"branch": "work", "commit": "a" * 40})
        self.assertEqual(self.log.last_commit("local", "/other"), "")
        self.assertEqual(self.log.last_commit("box", "/work"), "")

    def test_a_turn_recorded_outside_a_checkout_does_not_become_the_other_end(self):
        # Rows with no commit are skipped, so a pane that wandered out of the repository for one
        # turn does not erase the range for the next one.
        self.record(git={"branch": "work", "commit": "a" * 40})
        self.record()
        self.assertEqual(self.log.last_commit("local", "/work"), "a" * 40)

    def test_a_record_written_before_these_columns_existed_still_opens(self):
        # The ordinary case: this file has been accumulating since before the feature existed.
        old = os.path.join(self.dir.name, "old.sqlite3")
        import sqlite3
        conn = sqlite3.connect(old)
        conn.executescript("""
          CREATE TABLE turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL DEFAULT 'local',
            agent TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '', pane_id TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
            origin TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', tail TEXT NOT NULL DEFAULT '',
            range_start INTEGER, range_end INTEGER, status_from TEXT, status_to TEXT,
            at INTEGER NOT NULL, at_src TEXT NOT NULL, decision_id INTEGER);
        """)
        conn.execute("INSERT INTO turns (agent, pane_id, kind, origin, text, at, at_src)"
                     " VALUES ('claude','w1:p1','agent_final','agent','before',1,'poll')")
        conn.commit()
        conn.close()

        migrated = ConversationLog(old)
        self.addCleanup(migrated.close)
        migrated.record(agent="claude", pane_id="w1:p1", kind="agent_final", origin="agent",
                        at_src="poll", text="after", at=2,
                        git={"branch": "work", "commit": "a" * 40})
        with closing(open_ro(old)) as conn:
            rows = [as_wire(r) for r in query(conn)[0]]
        self.assertEqual([r["text"] for r in rows], ["before", "after"])
        self.assertEqual([r["branch"] for r in rows], ["", "work"])

    def test_a_record_this_relay_never_migrated_is_read_without_the_columns(self):
        # conv_query opens the file read-only and never migrates it, so it has to survive a schema
        # it does not have rather than raising on every row.
        old = os.path.join(self.dir.name, "unmigrated.sqlite3")
        import sqlite3
        conn = sqlite3.connect(old)
        conn.executescript("""
          CREATE TABLE turns (
            id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL DEFAULT 'local',
            agent TEXT NOT NULL, cwd TEXT NOT NULL DEFAULT '', pane_id TEXT NOT NULL,
            label TEXT NOT NULL DEFAULT '', project TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL,
            origin TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', tail TEXT NOT NULL DEFAULT '',
            range_start INTEGER, range_end INTEGER, status_from TEXT, status_to TEXT,
            at INTEGER NOT NULL, at_src TEXT NOT NULL, decision_id INTEGER);
        """)
        conn.execute("INSERT INTO turns (agent, pane_id, kind, origin, text, at, at_src)"
                     " VALUES ('claude','w1:p1','agent_final','agent','before',1,'poll')")
        conn.commit()
        conn.close()
        with closing(open_ro(old)) as conn:
            row = as_wire(query(conn)[0][0])
        self.assertEqual((row["branch"], row["commit"], row["commits"]), ("", "", []))

    def test_a_commits_column_that_is_not_json_does_not_break_a_read(self):
        self.record()
        self.log.conn.execute("UPDATE turns SET commits='{ not json'")
        self.log.conn.commit()
        self.assertEqual(self.wire()[0]["commits"], [])

    def test_the_range_is_written_on_the_last_row_of_a_turn_only(self):
        # One turn end writes several rows out of one screen. They share the commit they were read
        # at; the work that came before the turn is listed once, on the row the turn ends on.
        pane = {"pane_id": "w1:p1", "agent": "claude", "host": "local", "cwd": "/work"}
        with open(os.path.join(FIXTURES, "pane_claude_done.txt"), encoding="utf-8") as fh:
            screen = fh.read()
        ids = self.log.record_turn_end(
            pane, screen, "working", "idle",
            git={"branch": "work", "commit": "a" * 40,
                 "commits": [{"sha": "b" * 40, "subject": "second"}]})
        self.assertGreater(len(ids), 1, "this screen holds more than one message")
        rows = self.wire()
        self.assertTrue(all(r["branch"] == "work" for r in rows))
        self.assertTrue(all(r["commit"] == "a" * 40 for r in rows))
        self.assertEqual([len(r["commits"]) for r in rows], [0] * (len(rows) - 1) + [1])

    def test_a_turn_end_with_no_probe_at_all(self):
        pane = {"pane_id": "w1:p1", "agent": "claude", "host": "local", "cwd": "/work"}
        self.log.record_turn_end(pane, "I did the thing.\n", "working", "idle")
        for row in self.wire():
            self.assertEqual(row["branch"], "")

    def test_the_stored_commits_column_is_json_a_client_can_read(self):
        self.record(git={"branch": "work", "commit": "a" * 40,
                         "commits": [{"sha": "b" * 40, "subject": "second"}]})
        raw = self.log.conn.execute("SELECT commits FROM turns").fetchone()["commits"]
        self.assertEqual(json.loads(raw)[0]["subject"], "second")


if __name__ == "__main__":
    unittest.main()


class RelayWiringTest(unittest.TestCase):
    """The seam: what the relay hands the probe, and when it does not call it at all.

    The two write sites take their fields off a pane dict. A probe pointed at the wrong key looks
    exactly like a pane that is not in a checkout — nothing is recorded and nothing complains —
    which is why this is asserted rather than eyeballed.
    """

    def setUp(self):
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "relay"))
        import herdr_relay
        self.relay = herdr_relay
        self.calls = []
        self.addCleanup(setattr, herdr_relay, "GIT_TRACK", herdr_relay.GIT_TRACK)
        self.addCleanup(setattr, herdr_relay, "conv_log", herdr_relay.conv_log)
        self.addCleanup(setattr, herdr_relay, "git_cache", herdr_relay.git_cache)

        class FakeCache:
            def probe(inner, cwd, remote=None, since_sha=None, with_commits=False):  # noqa: N805
                self.calls.append((cwd, remote, since_sha, with_commits))
                return {"branch": "work", "commit": "a" * 40, "commits": []}

        class FakeLog:
            def last_commit(inner, host, cwd):                     # noqa: N805
                return "prev" if (host, cwd) == ("box", "/srv/relay") else ""

        herdr_relay.git_cache = FakeCache()
        herdr_relay.conv_log = FakeLog()
        herdr_relay.GIT_TRACK = True

    def probe(self, pane):
        import asyncio
        return asyncio.run(self.relay.probe_git(pane))

    def test_the_probe_is_given_the_pane_cwd_and_its_host(self):
        got = self.probe({"cwd": "/srv/relay", "host": "box", "remote": "box"})
        self.assertEqual(self.calls, [("/srv/relay", "box", "prev", False)])
        self.assertEqual(got["branch"], "work")

    def test_a_local_pane_is_probed_with_no_remote(self):
        self.probe({"cwd": "/work", "host": "local"})
        self.assertEqual(self.calls, [("/work", None, "", False)])

    def test_a_pane_with_no_cwd_is_never_probed(self):
        self.assertIsNone(self.probe({"host": "local"}))
        self.assertEqual(self.calls, [])

    def test_the_commit_list_is_asked_for_only_when_it_is_switched_on(self):
        # It is the one part of this that can be recomputed and the largest part of what it stores.
        self.addCleanup(setattr, self.relay, "GIT_COMMITS", self.relay.GIT_COMMITS)
        self.relay.GIT_COMMITS = True
        self.probe({"cwd": "/work", "host": "local"})
        self.assertEqual(self.calls, [("/work", None, "", True)])

    def test_the_switch_turns_it_off_entirely(self):
        self.relay.GIT_TRACK = False
        self.assertIsNone(self.probe({"cwd": "/work", "host": "local"}))
        self.assertEqual(self.calls, [], "a switched-off feature runs no subprocesses")


class TextOutputTest(unittest.TestCase):
    """What an agent reads in its own terminal, via relay/conv_query.py."""

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.db = os.path.join(self.dir.name, "rec.sqlite3")
        self.log = ConversationLog(self.db)
        self.addCleanup(self.log.close)

    def text(self):
        from conv_query import format_text
        rows, truncated = self.log.query()
        return format_text(rows, truncated)

    def turn(self, text, at, **git):
        self.log.record(agent="claude", pane_id="%1", kind="agent_final", origin="agent",
                        at_src="poll", cwd="/work", text=text, at=at, git=git or None)

    def test_the_branch_and_the_commits_are_printed(self):
        self.turn("done", 1, branch="feat/parser", commit="a" * 40,
                  commits=[{"sha": "b" * 40, "subject": "split the tokenizer out"}])
        out = self.text()
        self.assertIn("branch: feat/parser", out)
        self.assertIn("bbbbbbbb  split the tokenizer out", out)
        self.assertNotIn("b" * 12, out, "the whole sha belongs in the record, not on the screen")

    def test_a_branch_is_printed_when_it_changes_and_not_on_every_turn(self):
        # The same shape the thread draws: an orchestrator reading this is reading for changes, and
        # twenty turns each labelled `main` say nothing.
        self.turn("one", 1, branch="main", commit="a" * 40)
        self.turn("two", 2, branch="main", commit="b" * 40)
        self.turn("three", 3, branch="feat/x", commit="c" * 40)
        out = self.text()
        self.assertEqual(out.count("branch"), 2, out)
        self.assertIn("branch: main", out)
        self.assertIn("branch changed to feat/x", out)

    def test_a_turn_outside_the_checkout_does_not_repeat_the_branch_afterwards(self):
        self.turn("one", 1, branch="main", commit="a" * 40)
        self.turn("two", 2)
        self.turn("three", 3, branch="main", commit="b" * 40)
        self.assertEqual(self.text().count("branch"), 1)

    def test_a_turn_outside_a_checkout_prints_no_git_lines(self):
        self.log.record(agent="claude", pane_id="%1", kind="agent_final", origin="agent",
                        at_src="poll", text="done")
        self.assertNotIn("branch:", self.text())


class CommitRangeTest(unittest.TestCase):
    """Conversations between two commits, resolved rather than stored.

    This is the query the record is meant to answer from the other end, and the reason a turn needs
    to keep no list of commits to be searchable by one: git knows when a commit happened, the record
    knows when a turn did.
    """

    def setUp(self):
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "relay"))
        import herdr_relay
        self.relay = herdr_relay
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.repo = GitRepo(self.dir.name)
        self.addCleanup(self.relay.agent_cache.clear)

    def test_a_commit_range_becomes_a_time_window(self):
        first = self.repo.commit("first")
        last = self.repo.commit("second", "2")
        since, until = self.relay.conv_log_window(
            {"cwd": self.dir.name, "since_commit": first, "until_commit": last})
        self.assertIsNotNone(since)
        self.assertLessEqual(since, until)
        # Milliseconds, like every other stamp in the record — a window in seconds would silently
        # drop every turn recorded in the same second as the commit.
        self.assertGreater(since, 1_000_000_000_000)

    def test_a_question_with_no_commits_in_it_is_left_alone(self):
        self.assertEqual(self.relay.conv_log_window({"since": 5, "until": 9}), (5, 9))
        self.assertEqual(self.relay.conv_log_window({}), (None, None))

    def test_a_commit_range_narrows_a_time_window_rather_than_replacing_it(self):
        # Both are selectors and selectors are AND-ed. A client asking for "today, between these
        # two commits" must not be handed everything since the first of them.
        first = self.repo.commit("first")
        got_since, _ = self.relay.conv_log_window(
            {"cwd": self.dir.name, "since_commit": first, "since": 9_000_000_000_000})
        self.assertEqual(got_since, 9_000_000_000_000, "the later of the two bounds wins")

    def test_a_commit_range_needs_somewhere_to_resolve_it(self):
        with self.assertRaises(ValueError) as caught:
            self.relay.conv_log_window({"since_commit": "abc"})
        self.assertIn("cwd", str(caught.exception))

    def test_a_commit_from_another_checkout_says_so(self):
        # The ordinary mistake, and a silent empty answer would read as "nothing was said then".
        with self.assertRaises(ValueError) as caught:
            self.relay.conv_log_window({"cwd": self.dir.name, "since_commit": "0" * 40})
        self.assertIn("not a commit", str(caught.exception))

    def test_a_host_is_resolved_to_the_ssh_target_its_panes_are_reached_through(self):
        self.relay.agent_cache["w1:p1"] = {"host": "box", "remote": "user@box"}
        self.assertEqual(self.relay.remote_for_host("box"), "user@box")
        self.assertIsNone(self.relay.remote_for_host("local"))
        self.assertIsNone(self.relay.remote_for_host("unknown-host"))

    def test_the_cli_answers_the_same_question(self):
        import io
        import contextlib
        from conv_query import main

        db = os.path.join(self.dir.name, "rec.sqlite3")
        log = ConversationLog(db)
        self.addCleanup(log.close)
        first = self.repo.commit("first")
        first_at = git_probe.commit_time(self.dir.name, first)
        log.record(agent="claude", pane_id="%1", kind="agent_final", origin="agent",
                   at_src="poll", text="said before the commit", at=first_at - 60_000)
        log.record(agent="claude", pane_id="%1", kind="agent_final", origin="agent",
                   at_src="poll", text="said after the commit", at=first_at + 60_000)

        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = main(["--db", db, "--repo", self.dir.name, "--since-commit", first])
        self.assertEqual(code, 0)
        self.assertIn("said after the commit", out.getvalue())
        self.assertNotIn("said before the commit", out.getvalue())

    def test_the_cli_refuses_a_commit_it_cannot_find(self):
        import io
        import contextlib
        from conv_query import main

        db = os.path.join(self.dir.name, "rec.sqlite3")
        empty = ConversationLog(db)          # the file has to exist for the CLI to open it
        empty.close()
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code = main(["--db", db, "--repo", self.dir.name, "--until-commit", "0" * 40])
        self.assertEqual(code, 2)
        self.assertIn("not a commit", err.getvalue())


class GitCommitsRequestTest(unittest.TestCase):
    """The on-demand list: what a client may ask for, and what it may not.

    `from`, `to` and `cwd` come off a socket and end up in a git argv — and in an ssh command line
    for a remote pane. This is the boundary that keeps them data.
    """

    def setUp(self):
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "relay"))
        import herdr_relay
        self.relay = herdr_relay
        self.addCleanup(self.relay.agent_cache.clear)
        self.relay.agent_cache.clear()
        self.relay.agent_cache["w1:p1"] = {"cwd": "/work", "host": "local", "remote": None}
        self.relay.agent_cache["w2:p1"] = {"cwd": "/srv", "host": "box", "remote": "user@box"}

    def target(self, **msg):
        return self.relay.git_range_target(msg)

    def test_a_directory_a_pane_is_open_in_resolves(self):
        self.assertEqual(self.target(cwd="/work", **{"from": "a" * 40, "to": "b" * 40}),
                         ("/work", None, "a" * 40, "b" * 40))

    def test_a_remote_directory_carries_the_ssh_target(self):
        got = self.target(cwd="/srv", host="box", **{"from": "a" * 40, "to": "b" * 40})
        self.assertEqual(got[1], "user@box")

    def test_a_path_no_pane_is_open_in_is_refused(self):
        # Otherwise a client names any directory and the relay reads a repository the user never
        # pointed it at.
        with self.assertRaises(ValueError):
            self.target(cwd="/etc", **{"from": "a" * 40, "to": "b" * 40})
        with self.assertRaises(ValueError):
            self.target(cwd="/work", host="box", **{"from": "a" * 40, "to": "b" * 40})

    def test_only_shas_are_accepted_as_ends(self):
        # `--output=x` and `HEAD~3` both reach git's argument parser, and the first is an option.
        for bad in ("--output=/tmp/x", "HEAD~3", "main", "", "a" * 41, "zzzz123", "a" * 6):
            with self.assertRaises(ValueError, msg=bad):
                self.target(cwd="/work", **{"from": bad, "to": "b" * 40})
            with self.assertRaises(ValueError, msg=bad):
                self.target(cwd="/work", **{"from": "a" * 40, "to": bad})

    def test_a_short_sha_is_still_a_sha(self):
        self.assertEqual(self.target(cwd="/work", **{"from": "abc1234", "to": "b" * 40})[2],
                         "abc1234")
