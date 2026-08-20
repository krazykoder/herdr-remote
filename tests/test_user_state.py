"""The shared-state store: revisions, the allowlist, and the guard that makes a race visible.

    .venv313/bin/python -m unittest discover -s tests -t tests
"""
import os
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "relay"))

from user_state import (Conflict, DOC_NAMES, HISTORY_KEEP, MAX_BODY,  # noqa: E402
                        UserState)


class UserStateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "state.sqlite3")
        self.s = UserState(self.path)
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(self.s.close)

    def test_absent_document_reads_as_rev_zero(self):
        # Not omitted: a client seeding the store has to tell "the relay has nothing" apart from
        # "you never asked", and only one of those means upload.
        self.assertEqual(self.s.get(["pairs"]), {"pairs": {"rev": 0, "body": None}})

    def test_get_with_no_names_returns_every_document(self):
        self.assertEqual(set(self.s.get()), set(DOC_NAMES))

    def test_unknown_names_are_dropped_from_a_get_not_raised(self):
        # A client newer than this relay asking for a document it has not heard of degrades.
        self.assertEqual(self.s.get(["pairs", "widgets"]), {"pairs": {"rev": 0, "body": None}})

    def test_first_write_lands_at_rev_one(self):
        self.assertEqual(self.s.put("pairs", 0, '{"a":1}'), 1)
        self.assertEqual(self.s.get(["pairs"])["pairs"], {"rev": 1, "body": '{"a":1}'})

    def test_revisions_advance_by_one(self):
        self.assertEqual(self.s.put("pairs", 0, "{}"), 1)
        self.assertEqual(self.s.put("pairs", 1, "{}"), 2)
        self.assertEqual(self.s.put("pairs", 2, "{}"), 3)

    def test_a_stale_write_conflicts_and_carries_the_current_document(self):
        self.s.put("pairs", 0, '{"mine":1}')
        with self.assertRaises(Conflict) as caught:
            self.s.put("pairs", 0, '{"theirs":1}')
        self.assertEqual((caught.exception.rev, caught.exception.body), (1, '{"mine":1}'))
        # And the write really did not land — the loser must not have overwritten the winner.
        self.assertEqual(self.s.get(["pairs"])["pairs"]["body"], '{"mine":1}')

    def test_a_rev_ahead_of_the_store_conflicts_too(self):
        # Not just stale: a client that invented a revision is as wrong as one that missed a write.
        with self.assertRaises(Conflict):
            self.s.put("pairs", 5, "{}")

    def test_documents_outside_the_allowlist_are_refused(self):
        # The allowlist is the security boundary — without it this is a blob store for anything a
        # client cares to name.
        for name in ("widgets", "herdr_relay_token", "", "../../etc/passwd"):
            with self.assertRaises(ValueError):
                self.s.put(name, 0, "{}")

    def test_a_body_must_be_a_string(self):
        for body in (123, None, {"a": 1}, ["a"]):
            with self.assertRaises(ValueError):
                self.s.put("pairs", 0, body)

    def test_an_oversized_body_is_refused_and_leaves_the_rev_alone(self):
        self.s.put("pairs", 0, "{}")
        with self.assertRaises(ValueError):
            self.s.put("pairs", 1, "x" * (MAX_BODY + 1))
        self.assertEqual(self.s.get(["pairs"])["pairs"]["rev"], 1)

    def test_the_cap_is_measured_in_bytes_not_characters(self):
        # A document of emoji is four times the string length on the wire, and the cap exists to
        # bound what crosses it.
        body = "🐑" * (MAX_BODY // 4)
        self.assertEqual(len(body), MAX_BODY // 4)
        self.s.put("pairs", 0, body)
        with self.assertRaises(ValueError):
            self.s.put("conversations", 0, body + "🐑" * 8)

    def test_a_bad_rev_is_refused(self):
        for rev in (-1, "1", None, 1.0, True):
            with self.assertRaises(ValueError):
                self.s.put("pairs", rev, "{}")

    def test_a_body_survives_reopening_the_file(self):
        self.s.put("conv_view", 0, '{"pane":"c1"}')
        self.s.close()
        again = UserState(self.path)
        self.addCleanup(again.close)
        self.assertEqual(again.get(["conv_view"])["conv_view"], {"rev": 1, "body": '{"pane":"c1"}'})

    def test_two_handles_on_one_file_cannot_both_advance_the_same_rev(self):
        # Two browsers is two client handlers, and this is what stops the second from silently
        # overwriting the first.
        other = UserState(self.path)
        self.addCleanup(other.close)
        self.assertEqual(self.s.put("pairs", 0, "a"), 1)
        with self.assertRaises(Conflict):
            other.put("pairs", 0, "b")
        self.assertEqual(other.put("pairs", 1, "b"), 2)

    def test_concurrent_writers_produce_no_duplicate_revisions(self):
        # The relay writes from asyncio.to_thread, so several client handlers really are in this
        # method at once. Every winner must get a revision of its own.
        self.s.put("pairs", 0, "seed")
        revs, errors = [], []
        lock = threading.Lock()

        def attempt(n):
            for _ in range(20):
                have = self.s.get(["pairs"])["pairs"]["rev"]
                try:
                    got = self.s.put("pairs", have, f"body-{n}")
                except Conflict:
                    continue
                except Exception as e:      # noqa: BLE001 — the test is what it is reporting
                    with lock:
                        errors.append(e)
                    return
                with lock:
                    revs.append(got)
                return

        threads = [threading.Thread(target=attempt, args=(n,)) for n in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(errors, [])
        self.assertEqual(len(revs), len(set(revs)), f"a revision was handed out twice: {revs}")
        self.assertEqual(self.s.get(["pairs"])["pairs"]["rev"], max(revs))


class HistoryTest(unittest.TestCase):
    """What makes an overwrite survivable.

    `docs` is one row per name, so a client that writes the wrong document destroys the right one.
    That happened: a browser filed its own conversation index over the shared one and took every
    name the user had typed with it. Nothing in this file existed to get them back.
    """

    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.s = UserState(os.path.join(self.dir.name, "state.sqlite3"))
        self.addCleanup(self.dir.cleanup)
        self.addCleanup(self.s.close)

    def test_every_revision_is_kept_newest_first(self):
        for i in range(3):
            self.s.put("conversations", i, f'{{"items":[{i}]}}')
        self.assertEqual([h["rev"] for h in self.s.history("conversations")], [3, 2, 1])
        self.assertEqual(self.s.body_at("conversations", 1), '{"items":[0]}')

    def test_an_overwrite_leaves_the_replaced_body_readable(self):
        self.s.put("conversations", 0, '{"items":["named"]}')
        self.s.put("conversations", 1, '{"items":["fabricated"]}')
        self.assertEqual(self.s.body_at("conversations", 1), '{"items":["named"]}')

    def test_restore_puts_an_old_body_back_as_a_new_revision(self):
        self.s.put("conversations", 0, "first")
        self.s.put("conversations", 1, "second")
        self.assertEqual(self.s.restore("conversations", 1), 3)
        doc = self.s.get(["conversations"])["conversations"]
        self.assertEqual((doc["rev"], doc["body"]), (3, "first"))

    def test_a_restore_is_itself_in_the_history(self):
        self.s.put("pairs", 0, "a")
        self.s.put("pairs", 1, "b")
        self.s.restore("pairs", 1)
        self.assertEqual([h["rev"] for h in self.s.history("pairs")], [3, 2, 1])

    def test_a_revision_that_never_existed_reads_as_none(self):
        self.s.put("pairs", 0, "a")
        self.assertIsNone(self.s.body_at("pairs", 99))
        with self.assertRaises(ValueError):
            self.s.restore("pairs", 99)

    def test_a_refused_write_records_nothing(self):
        self.s.put("pairs", 0, "a")
        with self.assertRaises(Conflict):
            self.s.put("pairs", 0, "b")
        self.assertEqual([h["rev"] for h in self.s.history("pairs")], [1])

    def test_history_is_bounded(self):
        for i in range(HISTORY_KEEP + 5):
            self.s.put("pairs", i, str(i))
        kept = self.s.history("pairs", HISTORY_KEEP * 2)
        self.assertEqual(len(kept), HISTORY_KEEP)
        self.assertEqual(kept[0]["rev"], HISTORY_KEEP + 5)
        self.assertIsNone(self.s.body_at("pairs", 1), "the oldest revisions are pruned")

    def test_the_history_is_per_document(self):
        self.s.put("pairs", 0, "p")
        self.s.put("conversations", 0, "c")
        self.assertEqual([h["rev"] for h in self.s.history("pairs")], [1])
        self.assertEqual(self.s.body_at("conversations", 1), "c")

    def test_an_unknown_name_is_refused_rather_than_read_as_empty(self):
        for call in (lambda: self.s.history("widgets"), lambda: self.s.body_at("widgets", 1)):
            with self.assertRaises(ValueError):
                call()

    def test_history_survives_reopening_the_file(self):
        self.s.put("pairs", 0, "a")
        self.s.put("pairs", 1, "b")
        self.s.close()
        reopened = UserState(self.s.path)
        self.addCleanup(reopened.close)
        self.assertEqual(reopened.body_at("pairs", 1), "a")


if __name__ == "__main__":
    unittest.main()
