"""The id that outlives the pane.

    .venv313/bin/python -m unittest discover -s tests -t tests -k agent_ids

A pane id is a slot herdr assigns and reuses. What matters is the agent in it, which occupies a
succession of slots over its life. These pin the four rules that decide which agent a pane holds,
and above all the two places where the answer is refused rather than guessed.
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "relay"))

from agent_ids import AgentIds, new_aid  # noqa: E402


def pane(pid, **kw):
    return dict({"pane_id": pid, "host": "local", "agent": "claude", "cwd": "/w",
                 "workspace_id": "w1"}, **kw)


def run(ids, panes, **kw):
    """Resolve, and read the stamps back by pane id.

    `resolve` is keyed by the whole slot because a pane id alone is ambiguous across hosts; every
    test but one is on a single host, where reading by pane id says what it means.
    """
    ids.resolve(panes, **kw)
    return {p["pane_id"]: p.get("aid") for p in panes}


class AgentIdsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.n = 0

    def store(self):
        self.n += 1
        return AgentIds(os.path.join(self.dir.name, f"ids{self.n}.sqlite3"))

    # --- minting ---

    def test_a_new_pane_gets_an_id(self):
        got = run(self.store(), [pane("p1")])
        self.assertTrue(got["p1"].startswith("a_"))
        self.assertEqual(len(got["p1"]), 14)

    def test_ids_are_not_guessable_from_the_pane(self):
        # Minted here and never by a client: an id a client could choose is an id a client could
        # claim, and this is what says whose transcript a pane may continue.
        self.assertNotEqual(new_aid(), new_aid())

    def test_two_panes_are_two_agents(self):
        got = run(self.store(), [pane("p1"), pane("p2", cwd="/other")])
        self.assertEqual(len(set(got.values())), 2)

    # --- rule 1: the same slot ---

    def test_the_same_pane_keeps_its_id_across_polls(self):
        ids = self.store()
        first = run(ids, [pane("p1")])["p1"]
        self.assertEqual(run(ids, [pane("p1")])["p1"], first)
        self.assertEqual(len(ids.all_rows()), 1, "and is not written twice")

    def test_a_recycled_slot_under_a_different_harness_is_a_different_agent(self):
        # herdr hands a pane id back out after a pane closes. The seat has to agree or the new
        # session would inherit the dead one's transcript, which is D3's whole subject.
        ids = self.store()
        first = run(ids, [pane("p1")])["p1"]
        self.assertNotEqual(run(ids, [pane("p1", agent="codex")])["p1"], first)

    def test_a_recycled_slot_in_a_different_directory_is_a_different_agent(self):
        ids = self.store()
        first = run(ids, [pane("p1")])["p1"]
        self.assertNotEqual(run(ids, [pane("p1", cwd="/elsewhere")])["p1"], first)

    def test_one_pane_id_on_two_hosts_is_two_agents(self):
        # A herdr pane id is a per-server counter, so the same string on two machines names two
        # panes. The relay's own collision guards exist for this; identity must not undo them —
        # which is also why `resolve` is keyed by the slot and not by the pane id.
        panes = [pane("p1"), pane("p1", host="box")]
        self.store().resolve(panes)
        self.assertNotEqual(panes[0]["aid"], panes[1]["aid"])

    # --- rule 3: adoption ---

    def test_a_herdr_restart_moves_the_agent_to_its_new_slot(self):
        # The processes come back in new slots and the seat is unchanged. This is the case the
        # whole design is for: the agent keeps its id, and therefore its conversation, its
        # transcript and its pair.
        ids = self.store()
        first = run(ids, [pane("p1")])["p1"]
        self.assertEqual(run(ids, [pane("p9")])["p9"], first)
        self.assertEqual(len(ids.all_rows()), 1, "one agent, not a corpse and a stranger")

    def test_two_panes_for_one_retired_seat_adopt_nothing(self):
        # Two claude panes in one directory are two colleagues. Guessing between them puts one
        # agent's work in the other's terminal, which is the worst failure available here.
        ids = self.store()
        first = run(ids, [pane("p1")])["p1"]
        got = run(ids, [pane("p4"), pane("p5")])
        self.assertNotIn(first, got.values())
        self.assertEqual(len({first, *got.values()}), 3)

    def test_two_retired_agents_for_one_returning_pane_adopt_nothing(self):
        ids = self.store()
        made = set(run(ids, [pane("p1"), pane("p2")]).values())
        ids.resolve([])
        self.assertNotIn(run(ids, [pane("p3")])["p3"], made)

    def test_a_live_agent_is_never_adopted_from(self):
        # The seat matches, but that agent is still sitting in it.
        ids = self.store()
        first = run(ids, [pane("p1")])["p1"]
        got = run(ids, [pane("p1"), pane("p2")])
        self.assertEqual(got["p1"], first)
        self.assertNotEqual(got["p2"], first)

    # --- rule 2: a start that named itself ---

    def test_a_named_start_is_the_agent_it_says_it_is(self):
        # The explicit path. The client said which agent this start continues, so the harness and
        # the directory are free to have changed and nothing is inferred from them.
        ids = self.store()
        aid = run(ids, [pane("p1")])["p1"]
        ids.resolve([])
        self.assertTrue(ids.bind_ref(aid, "rABC"))
        got = run(ids, [pane("p7", agent="codex", cwd="/elsewhere", ref="rABC")])
        self.assertEqual(got["p7"], aid)

    def test_a_ref_bound_to_nothing_mints_a_new_agent(self):
        got = run(self.store(), [pane("p1", ref="rNOPE")])
        self.assertTrue(got["p1"].startswith("a_"))

    # --- retirement ---

    def test_an_agent_whose_pane_is_gone_is_retired_and_kept(self):
        ids = self.store()
        aid = run(ids, [pane("p1", label="ARCH")])["p1"]
        ids.resolve([])
        self.assertEqual([r["aid"] for r in ids.retired()], [aid])
        self.assertEqual(ids.get(aid)["label"], "ARCH", "the spawn details are what a restart needs")

    def test_a_live_agent_is_not_retired(self):
        ids = self.store()
        run(ids, [pane("p1")])
        self.assertEqual(ids.retired(), [])

    def test_retired_is_newest_first_and_capped(self):
        ids = self.store()
        for i in range(5):
            run(ids, [pane(f"p{i}", cwd=f"/w{i}")])
        rows = ids.retired(limit=3)
        self.assertEqual(len(rows), 3)
        self.assertEqual([r["last_seen"] for r in rows], sorted((r["last_seen"] for r in rows),
                                                                reverse=True))

    def test_a_readopted_agent_is_no_longer_retired(self):
        ids = self.store()
        run(ids, [pane("p1")])
        ids.resolve([])
        run(ids, [pane("p9")])
        self.assertEqual(ids.retired(), [])

    # --- the spawn details ---

    def test_a_detail_the_snapshot_stopped_carrying_is_kept(self):
        # `config` lives in the relay's memory, so a relay restart drops it off the snapshot while
        # the pane it describes runs on. The registry already knew, and goes on knowing.
        ids = self.store()
        aid = run(ids, [pane("p1", config="oclaude1", project_id="charts")])["p1"]
        run(ids, [pane("p1")])
        row = ids.get(aid)
        self.assertEqual(row["config"], "oclaude1")
        self.assertEqual(row["project_id"], "charts")

    def test_a_detail_the_snapshot_changed_is_taken(self):
        ids = self.store()
        aid = run(ids, [pane("p1", label="ARCH")])["p1"]
        run(ids, [pane("p1", label="Reviewer")])
        self.assertEqual(ids.get(aid)["label"], "Reviewer")

    def test_first_seen_is_when_the_agent_started_not_when_it_moved(self):
        ids = self.store()
        aid = run(ids, [pane("p1")], now=1000)["p1"]
        run(ids, [pane("p9")], now=9000)
        row = ids.get(aid)
        self.assertEqual(row["first_seen"], 1000)
        self.assertEqual(row["last_seen"], 9000)

    # --- durability ---

    def test_the_registry_survives_a_relay_restart(self):
        path = os.path.join(self.dir.name, "restart.sqlite3")
        first = AgentIds(path)
        aid = run(first, [pane("p1")])["p1"]
        first.close()
        self.assertEqual(run(AgentIds(path), [pane("p1")])["p1"], aid)

    def test_a_pane_with_no_id_is_skipped_rather_than_crashing(self):
        panes = [{"pane_id": "", "host": "local", "agent": "claude"}]
        self.assertEqual(self.store().resolve(panes), {})
        self.assertNotIn("aid", panes[0])


if __name__ == "__main__":
    unittest.main()
