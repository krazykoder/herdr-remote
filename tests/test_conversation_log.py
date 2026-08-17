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

from conv_query import open_ro, query
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
    def test_a_finished_pane_records_its_closing_message(self):
        content = fixture("pane_claude_done.txt")
        rowid = self.log.record_turn_end(PANE, content, "working", "idle")
        self.assertIsNotNone(rowid)
        rows, _ = self.log.query()
        row = rows[0]
        self.assertEqual(row["kind"], "agent_final")
        self.assertEqual(row["origin"], "agent")
        self.assertEqual(row["at_src"], "poll")
        self.assertEqual(row["status_to"], "idle")
        self.assertIn("Ready. Name the change.", row["text"])
        # The line breaks the agent wrote are kept — this is a record, not a push body.
        self.assertIn("\n", row["text"])
        self.assertIsNotNone(row["range_start"])

    def test_a_blocked_pane_is_recorded_as_blocked(self):
        content = fixture("pane_claude_done.txt")
        self.log.record_turn_end(PANE, content, "working", "blocked")
        rows, _ = self.log.query()
        self.assertEqual(rows[0]["kind"], "agent_blocked")

    def test_the_same_message_twice_is_recorded_once(self):
        # blocked, answered, finished — with nothing new written in between, both transitions read
        # back the same closing message.
        content = fixture("pane_claude_done.txt")
        self.assertIsNotNone(self.log.record_turn_end(PANE, content, "working", "blocked"))
        self.assertIsNone(self.log.record_turn_end(PANE, content, "blocked", "done"))
        rows, _ = self.log.query()
        self.assertEqual(len(rows), 1)

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

    def test_a_missing_record_is_a_different_answer_from_an_empty_one(self):
        with self.assertRaises(FileNotFoundError):
            open_ro(str(Path(self.dir.name) / "not-there.sqlite3"))


if __name__ == "__main__":
    unittest.main()
