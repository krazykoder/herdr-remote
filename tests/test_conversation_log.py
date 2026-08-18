#!/usr/bin/env python3
"""The relay's durable conversation record.

Three things are worth proving here and nothing else is:

  * the record is **global** — it is written and read with no session anywhere, which is the whole
    claim that makes it shippable before arbitration exists;
  * a turn ends on any move into an ending state, and the list of those states is the *same* list
    the browser holds, read out of web/src/state.js rather than copied into this file;
  * authorship and time are recorded rather than inferred, and the bounds actually bind.
"""
import json
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from conv_query import FINGERPRINTS_MAX, fingerprints_from, open_ro, query
from conversation_log import TAIL_MAX, TEXT_MAX, ConversationLog
from pane_summary import TURN_END_STATES, ends_turn


def fixture(name):
    return (ROOT / "tests" / "fixtures" / name).read_text(encoding="utf-8")


PANE = {"pane_id": "%1", "agent": "claude", "host": "local",
        "cwd": "/tmp/proj", "label": "Architect 1", "project": "proj"}


class Log(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = str(Path(self.dir.name) / "arbitration.sqlite3")
        self.log = ConversationLog(self.path)

    def tearDown(self):
        self.log.close()
        self.dir.cleanup()

    def add(self, **kw):
        base = dict(agent="claude", pane_id="%1", kind="agent_final", origin="agent",
                    at_src="poll", text="hello", cwd="/tmp/proj")
        base.update(kw)
        return self.log.record(**base)


class Global(Log):
    """The record belongs to no session. This is the property S0 is built on."""

    def test_written_and_read_with_no_session_in_existence(self):
        self.add(text="one")
        self.add(text="two")
        rows, truncated = self.log.query()
        self.assertEqual([r["text"] for r in rows], ["one", "two"])
        self.assertFalse(truncated)
        # Nothing in the schema names a session at all.
        tables = {r[0] for r in self.log.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'")}
        self.assertNotIn("sessions", tables)

    def test_a_roster_is_a_fingerprint_query_over_the_same_rows(self):
        self.add(agent="claude", cwd="/tmp/a", text="from a")
        self.add(agent="codex", cwd="/tmp/b", pane_id="%2", text="from b")
        self.add(agent="claude", cwd="/tmp/c", pane_id="%3", text="not in the roster")
        rows, _ = self.log.query(fingerprints=[("local", "claude", "/tmp/a"),
                                               ("local", "codex", "/tmp/b")])
        self.assertEqual([r["text"] for r in rows], ["from a", "from b"])

    def test_one_participants_log_is_the_same_rows_filtered(self):
        self.add(agent="claude", cwd="/tmp/a", text="mine")
        self.add(agent="codex", cwd="/tmp/b", pane_id="%2", text="theirs")
        rows, _ = self.log.query(agent="claude", cwd="/tmp/a")
        self.assertEqual([r["text"] for r in rows], ["mine"])


class Ordering(Log):
    def test_id_breaks_a_tie_in_at(self):
        # Two panes that stop inside one poll share a timestamp; without the tiebreak their order
        # is whatever the query planner felt like.
        first = self.add(text="first", at=1000)
        second = self.add(text="second", at=1000, pane_id="%2")
        rows, _ = self.log.query()
        self.assertEqual([r["id"] for r in rows], [first, second])

    def test_reading_order_is_oldest_first_but_the_window_is_the_newest(self):
        for i in range(5):
            self.add(text=f"m{i}", at=1000 + i)
        rows, truncated = self.log.query(last=2)
        self.assertEqual([r["text"] for r in rows], ["m3", "m4"])
        self.assertTrue(truncated)


class TurnEnds(unittest.TestCase):
    """The one list, held in two languages."""

    def test_the_states_match_the_browsers(self):
        js = (ROOT / "web" / "src" / "state.js").read_text(encoding="utf-8")
        at = re.search(r"const TURN_END_STATES = (\[[^\]]*\])", js)
        self.assertIsNotNone(at, "TURN_END_STATES has moved or been renamed in state.js")
        self.assertEqual(sorted(json.loads(at.group(1).replace("'", '"'))),
                         sorted(TURN_END_STATES))

    def test_idle_ends_a_turn(self):
        # The reason this file exists: watching `done` alone loses every turn that ends this way.
        self.assertTrue(ends_turn("idle"))
        self.assertTrue(ends_turn("done"))
        self.assertTrue(ends_turn("blocked"))
        self.assertFalse(ends_turn("working"))
        self.assertFalse(ends_turn(""))


class Capture(Log):
    # A pane whose record already holds this window's history, so the next call is an ordinary turn
    # rather than a first sight. First sight is its own case and is asserted below.
    def seen(self, content, pane=PANE):
        self.log.record_turn_end(pane, content, "working", "idle")

    def test_a_finished_pane_records_its_closing_message(self):
        content = fixture("pane_claude_done.txt")
        written = self.log.record_turn_end(PANE, content, "working", "idle")
        self.assertTrue(written)
        rows, _ = self.log.query()
        row = next(r for r in rows if r["origin"] == "agent")
        self.assertEqual(row["kind"], "agent_final")
        self.assertEqual(row["status_to"], "idle")
        self.assertIn("Ready. Name the change.", row["text"])
        # The line breaks the agent wrote are kept — this is a record, not a push body.
        self.assertIn("\n", row["text"])
        self.assertIsNotNone(row["range_start"])

    def test_first_sight_of_a_pane_is_history_and_says_so(self):
        # Everything on screen the first time the relay looks was said before it was watching. Its
        # order is all that can honestly be claimed about it, which is what `backfill` means — and
        # the stamps have to sort under the read that found them, or a run dated `now` would land
        # after history another pane records later in the same conversation.
        content = fixture("pane_claude_done.txt")
        self.log.record_turn_end(PANE, content, "working", "idle", at=1_000_000)
        rows, _ = self.log.query()
        self.assertEqual({r["at_src"] for r in rows}, {"backfill"})
        self.assertTrue(all(r["at"] < 1_000_000 for r in rows))
        self.assertEqual([r["at"] for r in rows], sorted(r["at"] for r in rows))

    def test_a_turn_after_that_is_stamped_by_the_poll_that_caught_it(self):
        content = fixture("pane_claude_done.txt")
        self.seen(content)
        # A new closing message, so there is something past the anchor to write.
        rows = content.split("\n")
        rows[9] = "⏺ And now it is finished."
        self.log.record_turn_end(PANE, "\n".join(rows), "working", "idle")
        latest, _ = self.log.query()
        self.assertEqual(latest[-1]["at_src"], "poll")

    def test_a_blocked_pane_is_recorded_as_blocked(self):
        content = fixture("pane_claude_done.txt")
        self.log.record_turn_end(PANE, content, "working", "blocked")
        rows, _ = self.log.query()
        # only the agent's closing block is the prompt — a line typed under it does not move the
        # state, and the narration above it stays agent_final
        agent = [r for r in rows if r["origin"] == "agent"]
        self.assertEqual(agent[-1]["kind"], "agent_blocked")
        self.assertNotIn("agent_blocked", [r["kind"] for r in agent[:-1]])

    def test_the_same_message_twice_is_recorded_once(self):
        # blocked, answered, finished — with nothing new written in between, both transitions read
        # back the same closing message, and it is in the record once. What matters is that the
        # window is never re-read as new: by the third transition there is nothing left in it.
        content = fixture("pane_claude_done.txt")
        self.assertTrue(self.log.record_turn_end(PANE, content, "working", "blocked"))
        self.log.record_turn_end(PANE, content, "blocked", "done")
        self.assertEqual(self.log.record_turn_end(PANE, content, "done", "idle"), [])
        rows, _ = self.log.query()
        said = [r["text"] for r in rows if r["origin"] == "agent"]
        self.assertEqual(len(said), 1)
        self.assertIn("Ready. Name the change.", said[0])

    def test_a_prompt_typed_into_the_terminal_is_recorded_and_never_claims_a_person(self):
        # N4. The relay knows a person put those words in the pane and does not know which person;
        # only a send it performed itself may say more than that.
        content = fixture("pane_claude_done.txt")
        self.log.record_turn_end(PANE, content, "working", "idle")
        rows, _ = self.log.query()
        typed = [r for r in rows if r["kind"] == "human_prompt"]
        self.assertEqual(len(typed), 1)
        self.assertEqual(typed[0]["origin"], "human_terminal")
        self.assertEqual(typed[0]["text"], "allow the test commands without prompting")

    def test_the_narration_of_a_turn_is_recorded_and_not_only_its_conclusion(self):
        # A turn is minutes of work and the agent narrates it. The browser's recorder keeps all of
        # it; a record holding only closing lines is a record of conclusions with the reasoning cut
        # out. agy, because its blocks are found positionally — the case most easily got wrong.
        content = fixture("pane_agy_done.txt")
        self.log.record_turn_end(dict(PANE, agent="agy"), content, "working", "idle")
        rows, _ = self.log.query()
        self.assertGreater(len([r for r in rows if r["origin"] == "agent"]), 1)
        self.assertEqual(rows[-1]["text"], "OK")

    def test_a_second_read_of_an_unchanged_pane_adds_nothing(self):
        content = fixture("pane_agy_done.txt")
        pane = dict(PANE, agent="agy")
        first = self.log.record_turn_end(pane, content, "working", "idle")
        self.assertTrue(first)
        self.assertEqual(self.log.record_turn_end(pane, content, "idle", "done"), [])

    def test_a_restarted_pane_keeps_its_fingerprint_anchor(self):
        # pane_id belongs to herdr and changes on restart. The record's identity is the stable
        # (host, agent, cwd, label) fingerprint, otherwise unchanged scrollback is backfilled.
        content = fixture("pane_claude_done.txt")
        self.assertTrue(self.log.record_turn_end(PANE, content, "working", "idle"))
        restarted = dict(PANE, pane_id="%99")
        self.assertEqual(self.log.record_turn_end(restarted, content, "working", "idle"), [])

    def test_two_panes_sharing_a_fingerprint_do_not_answer_for_each_other(self):
        # A pair of claudes in one project is an ordinary thing to run, and they are one
        # base fingerprint. Their labels separate their restart fallbacks; otherwise the second
        # pane's first turn is dropped as already held.
        content = fixture("pane_claude_done.txt")
        one, two = PANE, dict(PANE, pane_id="%2", label="Architect 2")
        self.assertTrue(self.log.record_turn_end(one, content, "working", "idle"))
        self.assertTrue(self.log.record_turn_end(two, content, "working", "idle"))
        rows, _ = self.log.query(last=20)
        self.assertEqual({r["pane_id"] for r in rows}, {"%1", "%2"})
        said = content.split("\n")
        said[9] = "⏺ Both of us said this."
        for pane in (one, two):
            self.assertTrue(self.log.record_turn_end(pane, "\n".join(said), "working", "idle"),
                            f"{pane['pane_id']} lost its turn to the other pane's record")

    def test_a_pane_with_no_detectable_message_keeps_its_tail(self):
        rowid = self.log.record_turn_end(
            dict(PANE, agent="nosuchharness"), "line one\nline two\n", "working", "idle")
        rows, _ = self.log.query()
        self.assertIsNotNone(rowid)
        self.assertEqual(rows[0]["text"], "")
        self.assertIn("line two", rows[0]["tail"])


class Origins(Log):
    def test_only_a_relay_send_may_claim_human_web(self):
        self.add(kind="human_prompt", origin="human_web", at_src="sent", text="do the thing")
        rows, _ = self.log.query(kind="human_prompt")
        self.assertEqual(rows[0]["origin"], "human_web")
        self.assertEqual(rows[0]["at_src"], "sent")

    def test_an_unknown_origin_is_refused_rather_than_guessed(self):
        with self.assertRaises(ValueError):
            self.add(origin="probably_a_human")
        with self.assertRaises(ValueError):
            self.add(kind="chat")
        with self.assertRaises(ValueError):
            self.add(at_src="roughly")


class Bounds(Log):
    def test_a_long_message_is_kept_up_to_the_cap(self):
        self.add(text="x" * (TEXT_MAX + 500))
        rows, _ = self.log.query()
        self.assertEqual(len(rows[0]["text"]), TEXT_MAX)

    def test_a_tail_is_trimmed_from_the_front(self):
        self.add(text="", tail="a" * 100 + "b" * (TAIL_MAX + 100))
        rows, _ = self.log.query()
        self.assertEqual(len(rows[0]["tail"]), TAIL_MAX)
        self.assertTrue(rows[0]["tail"].endswith("b"))

    def test_pruning_drops_the_oldest_and_never_an_automated_one(self):
        log = ConversationLog(str(Path(self.dir.name) / "small.sqlite3"), max_rows=3)
        log.record(agent="claude", pane_id="%1", kind="arbitrated", origin="arbitrator",
                   at_src="sent", text="machine said this", at=1)
        for i in range(6):
            log.record(agent="claude", pane_id="%1", kind="agent_final", origin="agent",
                       at_src="poll", text=f"m{i}", at=10 + i)
        rows, _ = log.query(last=50)
        kinds = [r["kind"] for r in rows]
        self.assertIn("arbitrated", kinds)
        self.assertEqual(len(rows), 3)
        self.assertEqual([r["text"] for r in rows if r["kind"] == "agent_final"], ["m4", "m5"])
        log.close()


class ReadOnly(Log):
    def test_the_query_handle_cannot_write(self):
        self.add(text="on the record")
        conn = open_ro(self.path)
        rows, _ = query(conn)
        self.assertEqual(rows[0]["text"], "on the record")
        with self.assertRaises(sqlite3.OperationalError):
            conn.execute("DELETE FROM turns")
        conn.close()

    def test_grep_is_case_insensitive_and_bounded(self):
        self.add(text="The Footer is compact")
        self.add(text="unrelated")
        conn = open_ro(self.path)
        rows, _ = query(conn, grep="footer")
        self.assertEqual(len(rows), 1)
        conn.close()

    def test_since_id_returns_strictly_newer_turns(self):
        id1 = self.add(text="first")
        id2 = self.add(text="second")
        id3 = self.add(text="third")
        conn = open_ro(self.path)
        rows, _ = query(conn, since_id=id1)
        self.assertEqual([r["id"] for r in rows], [id2, id3])
        rows_none, _ = query(conn, since_id=id3)
        self.assertEqual(rows_none, [])
        conn.close()

    def test_a_missing_record_is_a_different_answer_from_an_empty_one(self):
        with self.assertRaises(FileNotFoundError):
            open_ro(str(Path(self.dir.name) / "not-there.sqlite3"))


class Fingerprints(unittest.TestCase):
    """What a client is allowed to ask for by fingerprint. The values in a query are always
    parameterised; this is what keeps the *shape* of the WHERE clause off the wire as well."""

    def test_a_local_pane_has_no_host_and_the_record_calls_that_local(self):
        # The browser's member key carries '' for a local pane and the column defaults to 'local'.
        # Folded here rather than at either end, or a local roster matches nothing.
        self.assertEqual(fingerprints_from([["", "claude", "/tmp/a"]]),
                         [("local", "claude", "/tmp/a")])

    def test_a_malformed_triple_is_dropped_rather_than_trusted(self):
        got = fingerprints_from(
            [["local", "claude", "/a"], "nope", [1, 2, 3], ["h", "a"], ["h", "a", "c", "d"]])
        self.assertEqual(got, [("local", "claude", "/a")])

    def test_nothing_to_filter_by_is_none_and_not_an_empty_clause(self):
        # None means "no fingerprint filter". An empty list reaching the query builder would put an
        # empty OR group in the WHERE clause, which is a syntax error rather than a wide answer.
        for raw in (None, "claude", [], ["x"], [[1, 2, 3]]):
            self.assertIsNone(fingerprints_from(raw))

    def test_the_roster_a_client_may_name_is_bounded(self):
        self.assertEqual(len(fingerprints_from([["h", "a", "c"]] * (FINGERPRINTS_MAX + 20))),
                         FINGERPRINTS_MAX)


if __name__ == "__main__":
    unittest.main()
