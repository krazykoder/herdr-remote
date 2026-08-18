#!/usr/bin/env python3
"""The loop, driven with no herdr and no relay.

T5, T7, T7b, T8, T9 and T10 of the spec's test plan. Everything herdr-facing is injected, so a
whole session — start, prompt, drop-box, validate, send, spend, pause — runs here as ordinary
function calls against a temporary database. That is the point of the injection: the interesting
behaviour of this module is what it does *between* asking herdr for panes and typing into one, and
none of it needs either to be real.

The one thing every test here is really checking is that the loop stops rather than guesses. A
member that vanished, a fingerprint matching two panes, a spent budget, a second invalid record, a
relay that restarted — each one pauses and names a reason, and none of them press on.
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from arbitration import (Arbitration, ArbiterError, DEFAULT_GATES, budget_spent, check_budget,
                         render, resolve)


def pane(pane_id, agent="claude", cwd="/w", status="idle", label="", host="local"):
    return {"pane_id": pane_id, "agent": agent, "cwd": cwd, "agent_status": status,
            "label": label or pane_id, "host": host}


class Harness(unittest.TestCase):
    """A session with two members and an arbitrator, and a clock that only moves when told."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.live = [pane("p1", cwd="/a"), pane("p2", agent="codex", cwd="/a"),
                     pane("pA", agent="claude", cwd="/arb")]
        self.sent = []
        self.now = 1_000_000
        self.arb = Arbitration(str(Path(self.tmp.name) / "a.sqlite3"),
                               send=lambda pid, text: self.sent.append((pid, text)),
                               panes=lambda: list(self.live),
                               clock=lambda: self.now)
        self.addCleanup(self.arb.close)

    def start(self, **over):
        kwargs = dict(conversation="c1", members=[self.live[0], self.live[1]],
                      arbitrator=self.live[2], scope="Ship the footer change.")
        kwargs.update(over)
        return self.arb.start(**kwargs)

    def write(self, session_id, sequence, **over):
        doc = {"session_id": session_id, "sequence": sequence, "gate": "review",
               "to": "member-2", "instruction": "Take a look.",
               "why": "Ready for a check.", "ambiguity": "low", "decision_complexity": "low"}
        doc.update({k: v for k, v in over.items() if v is not None})
        for k, v in over.items():
            if v is None:
                doc.pop(k, None)
        path = Path(self.arb.drop_path(session_id, sequence))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc))
        return doc

    def step(self, session_id, trigger="turn_end — member-1"):
        """One full prompt-and-collect cycle, returning the prompt handle."""
        return self.arb.prompt(session_id, trigger, [{"label": "member-1", "text": "Done."}])


class Pure(unittest.TestCase):
    def test_resolve_keeps_a_cached_pane_that_still_matches(self):
        live = [pane("p1", cwd="/a"), pane("p9", cwd="/a")]
        self.assertEqual(("p1", None), resolve(("local", "claude", "/a"), "p1", live))

    def test_resolve_adopts_the_single_match_after_a_restart(self):
        # herdr mints a new pane id on every restart. The fingerprint is the identity; the stored
        # id is a cache, and a cache miss with exactly one candidate is a restart.
        live = [pane("p7", cwd="/a")]
        self.assertEqual(("p7", None), resolve(("local", "claude", "/a"), "p1", live))

    def test_resolve_refuses_when_nothing_matches(self):
        self.assertEqual((None, "member_gone"), resolve(("local", "claude", "/a"), "p1", []))

    def test_resolve_refuses_when_two_match(self):
        # Two claudes in one directory are two colleagues. Guessing puts one agent's work in the
        # other's terminal, which is worse than stopping.
        live = [pane("p7", cwd="/a"), pane("p8", cwd="/a")]
        self.assertEqual((None, "member_ambiguous"), resolve(("local", "claude", "/a"), "p1", live))

    def test_resolve_will_not_adopt_a_pane_another_member_holds(self):
        live = [pane("p7", cwd="/a"), pane("p8", cwd="/a")]
        self.assertEqual(("p8", None), resolve(("local", "claude", "/a"), "px", live, {"p7"}))

    def test_render_wraps_the_gate_template_around_the_prose(self):
        out = render(DEFAULT_GATES, "review", "Check the footer.")
        self.assertIn("Check the footer.", out)
        self.assertTrue(out.startswith("Please review"))

    def test_render_survives_braces_in_the_instruction(self):
        # str.format would read every brace in an agent's prose as a field and raise on the first
        # stray one. Instructions carry code, so braces are ordinary.
        self.assertIn("{ok: 1}", render(DEFAULT_GATES, "implement", "fix {ok: 1} here"))

    def test_a_budget_over_its_maximum_is_refused(self):
        with self.assertRaises(ArbiterError) as caught:
            check_budget({"max_steps": 500})
        self.assertEqual("budget_out_of_range", caught.exception.code)

    def test_a_budget_that_is_not_a_number_is_refused(self):
        with self.assertRaises(ArbiterError):
            check_budget({"max_consecutive": True})

    def test_defaults_fill_what_was_not_asked_for(self):
        self.assertEqual(8, check_budget({"max_consecutive": 2})["max_steps"])


class Budgets(Harness):
    """T8 — each exhaustion pauses with its own reason, and none of them warn and continue (N9)."""

    def session_with(self, **fields):
        s = self.start()
        for key, value in fields.items():
            self.arb.conn.execute(f"UPDATE sessions SET {key}=? WHERE id=?", (value, s["id"]))
        self.arb.conn.commit()
        return self.arb.session(s["id"])

    def test_steps(self):
        self.assertEqual("budget_steps", budget_spent(self.session_with(steps_used=8), self.now))

    def test_consecutive(self):
        self.assertEqual("budget_consecutive",
                         budget_spent(self.session_with(consecutive=3), self.now))

    def test_wall_clock(self):
        s = self.session_with()
        self.assertIsNone(budget_spent(s, self.now))
        self.assertEqual("budget_time", budget_spent(s, self.now + 45 * 60 * 1000))

    def test_a_human_entry_clears_consecutive(self):
        # "Not consecutive" means a person touched the conversation. Nothing else clears it.
        s = self.session_with(consecutive=3)
        self.arb.human_entered(s["id"])
        self.assertIsNone(budget_spent(self.arb.session(s["id"]), self.now))

    def test_a_spent_budget_pauses_instead_of_prompting(self):
        s = self.session_with(steps_used=8)
        with self.assertRaises(ArbiterError) as caught:
            self.step(s["id"])
        self.assertEqual("budget_steps", caught.exception.code)
        self.assertEqual("paused", self.arb.session(s["id"])["state"])
        self.assertEqual([], self.sent[1:], "a paused session sends nothing")

    def test_resume_opens_a_fresh_wall_clock_window(self):
        s = self.session_with()
        self.now += 60 * 60 * 1000
        self.assertEqual("budget_time", budget_spent(self.arb.session(s["id"]), self.now))
        self.arb.resume(s["id"])
        self.assertIsNone(budget_spent(self.arb.session(s["id"]), self.now))


class Start(Harness):
    def test_a_started_session_gets_the_starter_prompt_once(self):
        s = self.start()
        self.assertEqual("active", s["state"])
        self.assertEqual(1, len(self.sent))
        self.assertEqual("pA", self.sent[0][0])
        self.assertIn("You are the arbitrator", self.sent[0][1])

    def test_two_sessions_cannot_run_at_once(self):
        # T7b, first half.
        self.start()
        with self.assertRaises(ArbiterError) as caught:
            self.start()
        self.assertEqual("session_running", caught.exception.code)

    def test_a_second_session_is_refused_while_the_first_is_awaiting(self):
        # T7b, the half that matters: `awaiting` is still running, and it is the window a trigger
        # is most likely to land in.
        s = self.start()
        self.step(s["id"])
        self.assertEqual("awaiting", self.arb.session(s["id"])["state"])
        with self.assertRaises(ArbiterError) as caught:
            self.start()
        self.assertEqual("session_running", caught.exception.code)

    def test_a_paused_session_does_not_block_a_new_one(self):
        s = self.start()
        self.arb.pause(s["id"], "user")
        self.assertEqual("active", self.start()["state"])

    def test_three_members_are_refused(self):
        with self.assertRaises(ArbiterError) as caught:
            self.start(members=[self.live[0], self.live[1], self.live[2]])
        self.assertEqual("member_count", caught.exception.code)

    def test_the_same_pane_twice_is_refused(self):
        with self.assertRaises(ArbiterError) as caught:
            self.start(members=[self.live[0], self.live[0]])
        self.assertEqual("duplicate_participant", caught.exception.code)

    def test_a_participant_that_is_not_live_is_refused(self):
        with self.assertRaises(ArbiterError) as caught:
            self.start(members=[self.live[0], pane("ghost")])
        self.assertEqual("participant_not_live", caught.exception.code)

    def test_a_remote_participant_is_refused(self):
        # v1 is local-only, D13.
        far = pane("p3", cwd="/a", host="build-box")
        self.live.append(far)
        with self.assertRaises(ArbiterError) as caught:
            self.start(members=[self.live[0], far])
        self.assertEqual("remote_participant", caught.exception.code)

    def test_an_empty_scope_is_refused(self):
        with self.assertRaises(ArbiterError) as caught:
            self.start(scope="   ")
        self.assertEqual("bad_scope", caught.exception.code)


class Roster(Harness):
    """T9 — fingerprint re-resolution adopts a single match, pauses on zero, pauses on two."""

    def test_a_restarted_member_is_adopted_and_the_loop_continues(self):
        s = self.start()
        self.live[0] = pane("p1-new", cwd="/a")           # same fingerprint, new id
        self.step(s["id"])
        self.assertEqual("awaiting", self.arb.session(s["id"])["state"])

    def test_a_vanished_member_pauses(self):
        s = self.start()
        self.live = [p for p in self.live if p["pane_id"] != "p1"]
        with self.assertRaises(ArbiterError) as caught:
            self.step(s["id"])
        self.assertEqual("member_gone", caught.exception.code)
        self.assertEqual("member_gone", self.arb.session(s["id"])["pause_reason"])

    def test_an_ambiguous_member_pauses(self):
        s = self.start()
        self.live[0] = pane("p1-a", cwd="/a")
        self.live.append(pane("p1-b", cwd="/a"))
        with self.assertRaises(ArbiterError) as caught:
            self.step(s["id"])
        self.assertEqual("member_ambiguous", caught.exception.code)

    def test_a_vanished_arbitrator_pauses(self):
        s = self.start()
        self.live = [p for p in self.live if p["pane_id"] != "pA"]
        with self.assertRaises(ArbiterError) as caught:
            self.step(s["id"])
        self.assertEqual("arbitrator_gone", caught.exception.code)

    def test_the_roster_carries_live_status_so_the_arbitrator_can_avoid_a_busy_member(self):
        s = self.start()
        self.live[1] = pane("p2", agent="codex", cwd="/a", status="working")
        self.step(s["id"])
        self.assertIn("working", self.sent[-1][1])


class TheLoop(Harness):
    def test_a_valid_decision_is_rendered_sent_and_spent(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"])
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("sent", out["outcome"])
        self.assertEqual("p2", out["pane_id"])
        self.assertIn("Take a look.", self.sent[-1][1])
        after = self.arb.session(s["id"])
        self.assertEqual("active", after["state"])
        self.assertEqual(1, after["steps_used"])
        self.assertEqual(1, after["consecutive"])

    def test_the_drop_box_is_cleared_before_the_prompt_goes_out(self):
        # §12.1 step 1. A file left from a previous sequence would be read as this one's answer.
        s = self.start()
        first = self.step(s["id"])
        self.write(s["id"], first["sequence"])
        self.arb.collect(s["id"], first["prompt_id"])
        stale = Path(self.arb.drop_path(s["id"], 2))
        stale.write_text("{}")
        self.step(s["id"])
        self.assertFalse(stale.exists())

    def test_nothing_is_read_until_the_arbitrator_writes(self):
        s = self.start()
        handle = self.step(s["id"])
        self.assertEqual("waiting", self.arb.collect(s["id"], handle["prompt_id"])["outcome"])

    def test_call_human_sends_nothing_and_pauses(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"], gate="call_human", to=None, instruction=None,
                   why="The scope does not cover a schema change.")
        before = len(self.sent)
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("call_human", out["outcome"])
        self.assertEqual(before, len(self.sent), "call_human is not a send")
        self.assertEqual("call_human", self.arb.session(s["id"])["pause_reason"])
        self.assertEqual(0, self.arb.session(s["id"])["steps_used"])

    def test_a_decision_naming_a_working_member_is_rejected_not_queued(self):
        # N7, at the loop level. T13's unit half.
        s = self.start()
        handle = self.step(s["id"])
        self.live[1] = pane("p2", agent="codex", cwd="/a", status="working")
        self.write(s["id"], handle["sequence"])
        before = len(self.sent)
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("reprompt", out["outcome"])
        self.assertEqual("target_working", out["reject_code"])
        self.assertEqual(before, len(self.sent))
        self.assertEqual(0, self.arb.session(s["id"])["steps_used"])

    def test_a_member_that_moved_between_validation_and_delivery_is_not_typed_into(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"])
        real_roster = self.arb.roster

        def roster_then_vanish(session_id):
            out = real_roster(session_id)
            self.live = [p for p in self.live if p["pane_id"] != "p2"]
            return out

        self.arb.roster = roster_then_vanish
        before = len(self.sent)
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("reprompt", out["outcome"])
        self.assertEqual(before, len(self.sent))


class InvalidRecords(Harness):
    """T7 — one re-prompt, then a pause, and the wait is on the hash."""

    def test_the_first_invalid_record_is_re_prompted(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"], gate="deploy")
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("reprompt", out["outcome"])
        self.assertEqual("unknown_gate", out["reject_code"])
        self.assertEqual("awaiting", self.arb.session(s["id"])["state"])

    def test_the_second_invalid_record_pauses(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"], gate="deploy")
        self.arb.collect(s["id"], handle["prompt_id"])
        self.write(s["id"], handle["sequence"], gate="ship")
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("paused", out["outcome"])
        self.assertEqual("invalid_record", self.arb.session(s["id"])["pause_reason"])

    def test_an_unchanged_file_is_waited_on_rather_than_judged_twice(self):
        # An agent that answers instantly would otherwise be read before it wrote, and re-judging
        # its old file would burn the one re-prompt it is owed.
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"], gate="deploy")
        self.arb.collect(s["id"], handle["prompt_id"])
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("waiting", out["outcome"])
        self.assertTrue(out["unchanged"])
        self.assertEqual("awaiting", self.arb.session(s["id"])["state"])

    def test_a_correction_of_identical_length_is_noticed(self):
        # The reason the comparison is a content hash and not (mtime, size): a corrected record is
        # very often exactly as long as the one it replaces — one enum swapped, one id changed.
        s = self.start()
        handle = self.step(s["id"])
        bad = self.write(s["id"], handle["sequence"], gate="deployy")
        self.arb.collect(s["id"], handle["prompt_id"])
        good = self.write(s["id"], handle["sequence"], gate="review")
        self.assertEqual(len(json.dumps(bad)) - 1, len(json.dumps(good)))
        self.assertEqual("sent", self.arb.collect(s["id"], handle["prompt_id"])["outcome"])


class NeverFromProse(Harness):
    """T5 — N1 at the executor. Approving language in the transcript moves nothing."""

    APPROVING = "The reviewer said: accepted. LGTM, approved, ship it."

    def test_approving_prose_in_the_digest_causes_no_send(self):
        s = self.start()
        self.arb.prompt(s["id"], "turn_end — member-1",
                        [{"label": "member-1", "text": self.APPROVING}])
        before, sends = self.arb.session(s["id"]), len(self.sent)
        # No decision file exists. The transcript says every word a keyword matcher would fire on.
        out = self.arb.collect(s["id"], 1)
        self.assertEqual("waiting", out["outcome"])
        after = self.arb.session(s["id"])
        self.assertEqual(sends, len(self.sent), "no send")
        self.assertEqual(before["state"], after["state"], "no state change")
        self.assertEqual((before["steps_used"], before["consecutive"]),
                         (after["steps_used"], after["consecutive"]), "no budget movement")

    def test_approving_prose_cannot_stand_in_for_a_missing_decision_file(self):
        s = self.start()
        handle = self.step(s["id"])
        Path(self.arb.drop_path(s["id"], handle["sequence"])).write_text(self.APPROVING)
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("reprompt", out["outcome"])
        self.assertEqual("unparseable", out["reject_code"])


class InTheThread(Harness):
    """N8 — nothing happens off-screen. Against a real ConversationLog, not a stub.

    Worth the real object: `record` checks its enums rather than trusting them, so a stub here
    would happily accept a kind or an origin the actual recorder rejects, and the first time
    anyone found out would be the first arbitrated send on someone's machine.
    """

    def setUp(self):
        super().setUp()
        from conversation_log import ConversationLog
        self.arb.log = ConversationLog(str(Path(self.tmp.name) / "conv.sqlite3"))
        self.addCleanup(self.arb.log.close)

    def turns(self):
        return [dict(r) for r in self.arb.log.conn.execute("SELECT * FROM turns ORDER BY id")]

    def test_an_arbitrated_send_lands_in_the_thread_with_its_decision(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"])
        out = self.arb.collect(s["id"], handle["prompt_id"])
        row = self.turns()[-1]
        self.assertEqual("arbitrated", row["kind"])
        self.assertEqual("arbitrator", row["origin"])
        self.assertEqual("sent", row["at_src"])
        self.assertEqual(out["decision_id"], row["decision_id"])
        self.assertEqual("p2", row["pane_id"])
        self.assertIn("Take a look.", row["text"])

    def test_call_human_puts_its_reason_in_the_thread(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"], gate="call_human", to=None, instruction=None,
                   why="The scope does not cover a schema change.")
        self.arb.collect(s["id"], handle["prompt_id"])
        row = self.turns()[-1]
        self.assertEqual("decision", row["kind"])
        self.assertIn("schema change", row["text"])

    def test_a_rejected_decision_puts_nothing_in_the_thread(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"], gate="deploy")
        self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual([], self.turns())


class Restart(Harness):
    """T10 — recovery pauses rather than resuming, and replays no send."""

    def test_an_active_session_is_paused_at_boot(self):
        s = self.start()
        self.assertEqual("restart", self.arb.recover()["pause_reason"])

    def test_an_awaiting_session_is_paused_at_boot(self):
        s = self.start()
        self.step(s["id"])
        self.assertEqual("restart", self.arb.recover()["pause_reason"])

    def test_recovery_replays_no_send(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"])
        self.arb.collect(s["id"], handle["prompt_id"])
        sends = list(self.sent)
        self.arb.recover()
        self.assertEqual(sends, self.sent)

    def test_recovery_on_a_quiet_relay_does_nothing(self):
        self.assertIsNone(self.arb.recover())


if __name__ == "__main__":
    unittest.main()
