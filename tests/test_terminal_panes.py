#!/usr/bin/env python3
"""split_panes sorts one `herdr pane list` into agents and shells, and drops the spacers.

The agent half of this is a regression test, not a feature test: with terminal mode off the wire
has to stay byte-identical to what it was before shells existed, and `json.dumps` preserves key
insertion order — so the agent literal is asserted key for key, not just field by field.

The shell half is the feature. A spacer is the one pane this application closes on its own, so it
must never be offered as a terminal, and a shell must never carry a status: the client groups on
status, and a shell that has one lands in an agent group.

Collisions are checked here too. Shell pane IDs are per-server counters exactly as agent IDs are,
so a shell on one host and an agent on another can share an ID — and every message for that ID
has to be refused rather than routed to whichever host was polled last.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay  # noqa: E402
from projects import ambiguous_pane_ids  # noqa: E402
from start_agent import SPACER_LABEL  # noqa: E402


def pane(pane_id, **kw):
    base = {"pane_id": pane_id, "cwd": "/w", "workspace_id": "w8", "tab_id": "t1"}
    base.update(kw)
    return base


AGENT_PANE = pane("w8:p1", agent="claude", agent_status="working", label="Architect 1",
                  cwd="/Users/t/code/herdr-remote")
SHELL_PANE = pane("w8:p2", label="build watch", cwd="/Users/t/code/web")
SPACER_PANE = pane("w8:p3", label=SPACER_LABEL)
BARE_SHELL = pane("w8:p4", label="")


class SplitPanes(unittest.TestCase):
    def split(self, panes, include_shells=True, host="local", remote=None):
        return herdr_relay.split_panes(panes, host, remote, include_shells=include_shells)

    def test_agent_record_is_unchanged_key_for_key(self):
        """The pre-change literal, in the pre-change order. Terminal mode off must not move a byte."""
        agents, _ = self.split([AGENT_PANE], include_shells=False)
        self.assertEqual(list(agents[0].keys()), [
            "pane_id", "agent", "label", "status", "cwd", "project",
            "host", "remote", "workspace_id", "tab_id"])
        self.assertEqual(agents[0], {
            "pane_id": "w8:p1", "agent": "claude", "label": "Architect 1", "status": "working",
            "cwd": "/Users/t/code/herdr-remote", "project": "herdr-remote", "host": "local",
            "remote": None, "workspace_id": "w8", "tab_id": "t1"})

    def test_agent_without_status_falls_back_to_unknown(self):
        agents, _ = self.split([pane("w8:p9", agent="codex")])
        self.assertEqual(agents[0]["status"], "unknown")

    def test_shell_is_listed_with_no_status_and_no_agent(self):
        _, shells = self.split([SHELL_PANE])
        self.assertEqual(len(shells), 1)
        self.assertNotIn("status", shells[0])
        self.assertNotIn("agent", shells[0])
        self.assertEqual(shells[0]["label"], "build watch")
        self.assertEqual(shells[0]["project"], "web")

    def test_spacer_is_in_neither_list(self):
        agents, shells = self.split([SPACER_PANE])
        self.assertEqual(agents, [])
        self.assertEqual(shells, [])

    def test_unlabelled_shell_is_still_a_shell(self):
        """is_spacer needs both halves — no agent *and* the spacer label. An empty label is a
        pane the user split and never named, which is theirs and must be listed."""
        _, shells = self.split([BARE_SHELL])
        self.assertEqual([s["pane_id"] for s in shells], ["w8:p4"])
        self.assertEqual(shells[0]["label"], "")

    def test_include_shells_false_drops_shells_and_leaves_agents_identical(self):
        with_shells = self.split([AGENT_PANE, SHELL_PANE, SPACER_PANE], include_shells=True)
        without = self.split([AGENT_PANE, SHELL_PANE, SPACER_PANE], include_shells=False)
        self.assertEqual(without[1], [])
        self.assertEqual(without[0], with_shells[0])

    def test_remote_host_label_travels_on_both_lists(self):
        agents, shells = self.split([AGENT_PANE, SHELL_PANE], host="box", remote="box")
        self.assertEqual(agents[0]["host"], "box")
        self.assertEqual(shells[0]["host"], "box")
        self.assertEqual(shells[0]["remote"], "box")

    def test_mixed_list_keeps_order_within_each_kind(self):
        agents, shells = self.split([SHELL_PANE, AGENT_PANE, SPACER_PANE, BARE_SHELL])
        self.assertEqual([a["pane_id"] for a in agents], ["w8:p1"])
        self.assertEqual([s["pane_id"] for s in shells], ["w8:p2", "w8:p4"])


class Ambiguity(unittest.TestCase):
    def test_same_id_as_an_agent_here_and_a_shell_there_is_ambiguous(self):
        """The reason the ambiguity set is fed from both lists. Without this the relay routes
        w8:p1 to whichever host it polled last, which is the D6 bug with a shell on one end."""
        agents, _ = herdr_relay.split_panes([AGENT_PANE], "alpha", "alpha", include_shells=True)
        _, shells = herdr_relay.split_panes([pane("w8:p1", label="build")], "beta", "beta",
                                            include_shells=True)
        self.assertEqual(ambiguous_pane_ids(agents + shells), {"w8:p1"})

    def test_distinct_ids_across_hosts_are_not_ambiguous(self):
        agents, _ = herdr_relay.split_panes([AGENT_PANE], "alpha", "alpha", include_shells=True)
        _, shells = herdr_relay.split_panes([SHELL_PANE], "beta", "beta", include_shells=True)
        self.assertEqual(ambiguous_pane_ids(agents + shells), set())


class SnapshotMessage(unittest.TestCase):
    """`shells` present or absent is the client's feature gate, so its presence is the assertion."""

    def setUp(self):
        self.agents, self.shells = herdr_relay.latest_agents, herdr_relay.latest_shells
        self.terminal = herdr_relay.TERMINAL
        herdr_relay.latest_agents = [{"pane_id": "w8:p1"}]

    def tearDown(self):
        herdr_relay.latest_agents, herdr_relay.latest_shells = self.agents, self.shells
        herdr_relay.TERMINAL = self.terminal

    def test_off_has_no_shells_key_at_all(self):
        herdr_relay.TERMINAL = False
        herdr_relay.latest_shells = [{"pane_id": "w8:p2"}]
        msg = herdr_relay.snapshot_message()
        self.assertNotIn("shells", msg)
        self.assertEqual(msg, {"type": "agents", "agents": [{"pane_id": "w8:p1"}]})

    def test_on_with_no_shells_still_carries_the_key(self):
        herdr_relay.TERMINAL = True
        herdr_relay.latest_shells = []
        self.assertEqual(herdr_relay.snapshot_message()["shells"], [])

    def test_on_carries_the_shells(self):
        herdr_relay.TERMINAL = True
        herdr_relay.latest_shells = [{"pane_id": "w8:p2"}]
        self.assertEqual(herdr_relay.snapshot_message()["shells"], [{"pane_id": "w8:p2"}])


if __name__ == "__main__":
    unittest.main()
