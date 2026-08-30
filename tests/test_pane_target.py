#!/usr/bin/env python3
"""How a client's pane address is resolved.

A pane id is a per-server counter, so two hosts polled by one relay both report w1:p1 and the
relay refuses it rather than routing to whichever was polled last. An `aid` is minted by this
relay and is unique by construction, so it names one pane on one host and that refusal never
applies to it. These are the cases in
`.workflow/03_specs/2026-08-30_addressing_a_pane_by_its_agent_spec.md` §3.2, one for one.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay as R  # noqa: E402


class PaneTargetTest(unittest.TestCase):
    def setUp(self):
        # The state one poll leaves behind: two hosts, both reporting w1:p1, plus a pane whose id
        # only one host uses. The remote of None is the local host, which is what the relay stores.
        R.known_panes.clear()
        R.known_panes.update({"w1:p1", "w1:p2"})
        R.ambiguous_panes.clear()
        R.ambiguous_panes.add("w1:p1")
        R.pane_remote_map.clear()
        R.pane_remote_map.update({"w1:p1": "box", "w1:p2": None})
        R.pane_by_aid.clear()
        R.pane_by_aid.update({
            "a_local1111111": {"pane_id": "w1:p1", "remote": None, "aid": "a_local1111111"},
            "a_box22222222": {"pane_id": "w1:p1", "remote": "box", "aid": "a_box22222222"},
            "a_solo333333": {"pane_id": "w1:p2", "remote": None, "aid": "a_solo333333"},
        })

    def test_an_aid_names_one_pane_on_one_host(self):
        self.assertEqual(R.pane_target({"aid": "a_local1111111"}), ("w1:p1", None, None))
        self.assertEqual(R.pane_target({"aid": "a_box22222222"}), ("w1:p1", "box", None))

    def test_an_aid_reaches_a_pane_id_two_hosts_share(self):
        # The whole point. The same id refused outright when named bare.
        self.assertIsNone(R.pane_target({"aid": "a_box22222222"})[2])
        self.assertEqual(R.pane_target({"pane_id": "w1:p1"})[2],
                         "ambiguous pane_id (same id on multiple hosts)")

    def test_an_aid_wins_over_the_pane_id_beside_it(self):
        # A client sends both out of one snapshot. If the agent has since moved, the pane_id in
        # that pair is where it was and the aid is where it is.
        self.assertEqual(
            R.pane_target({"aid": "a_solo333333", "pane_id": "w1:p9"}), ("w1:p2", None, None))

    def test_an_aid_with_no_live_pane_is_unknown(self):
        # Not looked up in the registry: this addresses panes that exist, not agents that once did.
        self.assertEqual(R.pane_target({"aid": "a_retired00000"}), (None, None, "unknown aid"))

    def test_a_bare_pane_id_is_guarded_exactly_as_before(self):
        self.assertEqual(R.pane_target({"pane_id": "w1:p2"}), ("w1:p2", None, None))
        self.assertEqual(R.pane_target({"pane_id": "w9:p9"}), (None, None, "unknown pane_id"))
        self.assertEqual(R.pane_target({"pane_id": "w1:p1"})[0], None)

    def test_a_message_naming_no_pane_at_all_is_unknown(self):
        self.assertEqual(R.pane_target({}), (None, None, "unknown pane_id"))

    def test_an_empty_aid_falls_through_to_the_pane_id(self):
        # A client that carries the field unconditionally sends '' for a pane the relay minted no
        # id for — against an older relay, or before the identity pass has run once.
        self.assertEqual(R.pane_target({"aid": "", "pane_id": "w1:p2"}), ("w1:p2", None, None))


if __name__ == "__main__":
    unittest.main()
