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
        self.pushed = []
        self.now = 1_000_000
        self.arb = Arbitration(str(Path(self.tmp.name) / "a.sqlite3"),
                               send=lambda pid, text: self.sent.append((pid, text)),
                               panes=lambda: list(self.live),
                               notify=lambda s, reason: self.pushed.append(reason),
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

    def test_client_metadata_cannot_rewrite_a_live_participant_identity(self):
        forged = {**self.live[0], "agent": "codex", "cwd": "/not-the-live-pane",
                  "label": "Forged"}
        s = self.start(members=[forged, self.live[1]])
        member = self.arb.members(s["id"])[0]
        self.assertEqual(("claude", "/a", "p1"),
                         (member["agent"], member["cwd"], member["pane_id"]))

    def test_a_remote_participant_is_refused(self):
        # v1 is local-only, D13.
        far = pane("p3", cwd="/a", host="build-box")
        self.live.append(far)
        with self.assertRaises(ArbiterError) as caught:
            self.start(members=[self.live[0], far])
        self.assertEqual("remote_participant", caught.exception.code)

    def test_a_working_arbitrator_is_refused_before_its_starter_prompt_is_sent(self):
        self.live[2]["agent_status"] = "working"
        with self.assertRaises(ArbiterError) as caught:
            self.start()
        self.assertEqual("arbitrator_busy", caught.exception.code)
        self.assertEqual([], self.sent)

    def test_a_remote_pane_whose_id_collides_with_a_live_local_one_is_refused(self):
        # The reason the *claimed* host is still checked after everything else stopped being
        # trusted. Pane ids are per-host counters, so `box`'s p1 and this machine's p1 are two
        # different agents wearing one id — and `panes()` only lists this machine's, so a claim of
        # `box` matched against the snapshot alone would resolve to the local pane and start typing
        # into it. Nothing about the participant is taken from the claim; the claim is only ever a
        # reason to say no.
        with self.assertRaises(ArbiterError) as caught:
            self.start(members=[{"pane_id": "p1", "host": "box"}, self.live[1]])
        self.assertEqual("remote_participant", caught.exception.code)

    def test_a_starter_prompt_that_cannot_be_confirmed_fails_the_start(self):
        # Ended and raised, not paused. The starter prompt is the only thing telling the arbitrator
        # what it is and where to write, and it is never re-sent — so a session resumed without it
        # has an agent that will never produce a decision file. It would re-prompt once and pause
        # on `invalid_record`: a dead end wearing a Resume button.
        self.arb.send = lambda *_: False
        with self.assertRaises(ArbiterError) as caught:
            self.start()
        self.assertEqual("send_unconfirmed", caught.exception.code)
        self.assertIsNone(self.arb.running(), "a failed start leaves nothing running")

    def test_a_failed_start_does_not_block_the_next_one(self):
        self.arb.send = lambda *_: False
        with self.assertRaises(ArbiterError):
            self.start()
        self.arb.send = lambda pid, text: self.sent.append((pid, text))
        self.assertEqual("active", self.start()["state"])

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
        self.assertEqual(before + 1, len(self.sent))
        self.assertEqual("pA", self.sent[-1][0])
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
        self.assertEqual(before + 1, len(self.sent))
        self.assertEqual("pA", self.sent[-1][0])

    def test_an_unconfirmed_delivery_pauses_without_spending_or_recording_a_send(self):
        # submit_paste says False when it could not *prove* the pane took the text. `sends` is the
        # relay's record of deliveries it stands behind, so a row there would turn a maybe into a
        # yes; a budget counts what certainly happened, so no step goes either.
        s = self.start()
        handle = self.step(s["id"])
        self.arb.send = lambda *_: False
        self.write(s["id"], handle["sequence"])
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("paused", out["outcome"])
        self.assertEqual("send_unconfirmed", out["reason"])
        self.assertEqual(0, self.arb.session(s["id"])["steps_used"])
        self.assertEqual(0, self.arb.conn.execute("SELECT COUNT(*) FROM sends").fetchone()[0])

    def test_an_unconfirmed_delivery_still_says_what_was_sent(self):
        # Unconfirmed is not "not delivered" — submit_paste's commonest False is a pane already
        # working, where the text very probably landed and queued. The person now has to go and
        # look, and the outcome has to tell them where and at what.
        s = self.start()
        handle = self.step(s["id"])
        self.arb.send = lambda *_: False
        self.write(s["id"], handle["sequence"])
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("p2", out["pane_id"])
        self.assertEqual("member-2", out["to"])
        self.assertIn("Take a look.", out["text"])

    def test_a_sender_that_reports_nothing_is_not_treated_as_a_failure(self):
        # `is not False`, not a truth test. A sender returning None does not report; reading that
        # as "unproven" would pause every session running against one.
        s = self.start()
        handle = self.step(s["id"])
        self.arb.send = lambda *_: None
        self.write(s["id"], handle["sequence"])
        self.assertEqual("sent", self.arb.collect(s["id"], handle["prompt_id"])["outcome"])

    def test_a_sender_that_raises_pauses_rather_than_escaping(self):
        s = self.start()
        handle = self.step(s["id"])
        self.arb.send = lambda *_: (_ for _ in ()).throw(RuntimeError("herdr gone"))
        self.write(s["id"], handle["sequence"])
        self.assertEqual("send_unconfirmed",
                         self.arb.collect(s["id"], handle["prompt_id"])["reason"])


class InvalidRecords(Harness):
    """T7 — one re-prompt, then a pause, and the wait is on the hash."""

    def test_the_first_invalid_record_is_re_prompted(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"], gate="deploy")
        before = len(self.sent)
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("reprompt", out["outcome"])
        self.assertEqual("unknown_gate", out["reject_code"])
        self.assertEqual(before + 1, len(self.sent))
        self.assertEqual("pA", self.sent[-1][0])
        self.assertIn("unknown_gate", self.sent[-1][1])
        self.assertEqual("awaiting", self.arb.session(s["id"])["state"])

    def race(self):
        """Make every target vanish *after* validation has looked at it.

        A target that is already busy is caught by `validate`, so it never reaches delivery — the
        only way to exercise the race is to move the pane in the window between the two, which is
        precisely the window §13.2's re-resolution exists for.
        """
        real = self.arb.roster
        seen = []

        def roster(session_id):
            out = real(session_id)
            seen.append(1)
            if len(seen) % 2 == 0:          # the delivery-time look, not the validating one
                for m in out.values():
                    m["panes"], m["pane_id"] = 0, None
            return out

        self.arb.roster = roster

    def test_a_race_is_recorded_as_a_rejection_not_as_a_valid_decision(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"])
        self.race()
        self.assertEqual("reprompt", self.arb.collect(s["id"], handle["prompt_id"])["outcome"])
        row = self.arb.conn.execute(
            "SELECT valid, reject_code FROM decisions ORDER BY id DESC LIMIT 1").fetchone()
        self.assertEqual(0, row["valid"], "a record that failed at delivery is still a rejection")
        self.assertEqual("target_not_live", row["reject_code"])

    def test_a_target_that_keeps_racing_is_bounded_like_any_other_rejection(self):
        # The re-prompt for a target that moved between validation and delivery runs on a record
        # that *validated*. Unless the race is written down as a rejection the bound never sees it,
        # and a member that keeps moving re-prompts forever — spending no step and tripping no
        # budget. N9 says budgets are hard stops; a free path around them is not one.
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"])
        self.race()
        self.assertEqual("reprompt", self.arb.collect(s["id"], handle["prompt_id"])["outcome"])
        self.write(s["id"], handle["sequence"], why="Second attempt, target still moving.")
        out = self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual("paused", out["outcome"])
        self.assertEqual("invalid_record", self.arb.session(s["id"])["pause_reason"])
        self.assertEqual(0, self.arb.session(s["id"])["steps_used"])
        self.assertEqual([], [t for p, t in self.sent if "Take a look." in t])

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

    def test_an_unconfirmed_send_is_in_the_thread_too(self):
        # N8, at its most load-bearing. The text may well have landed, the session has stopped, and
        # the thread is where the person looks to find out what went out before going to the pane.
        s = self.start()
        handle = self.step(s["id"])
        self.arb.send = lambda *_: False
        self.write(s["id"], handle["sequence"])
        self.arb.collect(s["id"], handle["prompt_id"])
        row = self.turns()[-1]
        self.assertEqual("arbitrated", row["kind"])
        self.assertEqual("p2", row["pane_id"])
        self.assertIn("Take a look.", row["text"])

    def test_a_rejected_decision_puts_nothing_in_the_thread(self):
        s = self.start()
        handle = self.step(s["id"])
        self.write(s["id"], handle["sequence"], gate="deploy")
        self.arb.collect(s["id"], handle["prompt_id"])
        self.assertEqual([], self.turns())


class Triggers(Harness):
    """§10 — who wakes the loop, who does not, and what a second one in flight does.

    These are the entry points the relay's poll loop calls on every pane transition, so the first
    thing each has to be is a no-op. A relay with no session running calls both of these hundreds
    of times an hour.
    """

    def test_a_member_finishing_prompts_the_arbitrator(self):
        s = self.start()
        out = self.arb.turn_ended("p1", [{"label": "member-1", "text": "Done."}])
        self.assertEqual(1, out["sequence"])
        self.assertEqual("pA", self.sent[-1][0])
        self.assertIn("member-1", self.sent[-1][1])
        self.assertEqual("awaiting", self.arb.session(s["id"])["state"])

    def test_a_restarted_member_still_triggers(self):
        # The poll loop knows a pane id; the session knows a fingerprint. After a herdr restart
        # those disagree, and the trigger has to resolve rather than match.
        s = self.start()
        self.live[0] = pane("p1-new", cwd="/a")
        self.assertIsNotNone(self.arb.turn_ended("p1-new", []))

    def test_the_arbitrators_own_turn_end_is_not_a_trigger(self):
        # It is the signal to read the drop-box, which is the opposite of asking it a question.
        s = self.start()
        before = len(self.sent)
        self.assertIsNone(self.arb.turn_ended("pA", []))
        self.assertEqual(before, len(self.sent))

    def test_a_pane_that_is_not_on_the_roster_is_ignored(self):
        self.start()
        self.live.append(pane("p9", cwd="/elsewhere"))
        self.assertIsNone(self.arb.turn_ended("p9", []))

    def test_nothing_happens_with_no_session(self):
        self.assertIsNone(self.arb.turn_ended("p1", []))
        self.assertIsNone(self.arb.arbitrator_finished("pA"))
        self.assertEqual([], self.sent)

    def test_nothing_happens_while_paused(self):
        s = self.start()
        self.arb.pause(s["id"], "user")
        before = len(self.sent)
        self.assertIsNone(self.arb.turn_ended("p1", []))
        self.assertEqual(before, len(self.sent))

    def test_a_second_member_finishing_is_coalesced_not_queued(self):
        # One prompt outstanding at a time. The other member's news folds into the next prompt's
        # roster; queueing it would have the arbitrator answering about a conversation that moved.
        s = self.start()
        self.arb.turn_ended("p1", [])
        before = len(self.sent)
        self.assertIsNone(self.arb.turn_ended("p2", []))
        self.assertEqual(before, len(self.sent))
        self.assertEqual(1, self.arb.session(s["id"])["sequence"])

    def test_the_arbitrator_finishing_reads_the_drop_box(self):
        s = self.start()
        handle = self.arb.turn_ended("p1", [])
        self.write(s["id"], handle["sequence"])
        out = self.arb.arbitrator_finished("pA")
        self.assertEqual("sent", out["outcome"])
        self.assertEqual("p2", out["pane_id"])

    def test_a_member_finishing_does_not_read_the_drop_box(self):
        s = self.start()
        handle = self.arb.turn_ended("p1", [])
        self.write(s["id"], handle["sequence"])
        self.assertIsNone(self.arb.arbitrator_finished("p1"))
        self.assertEqual("awaiting", self.arb.session(s["id"])["state"])

    def test_the_arbitrator_finishing_before_it_wrote_is_not_an_error(self):
        # An agent that ends its turn without writing is ordinary — it thought, it did not answer.
        s = self.start()
        self.arb.turn_ended("p1", [])
        self.assertEqual("waiting", self.arb.arbitrator_finished("pA")["outcome"])

    def test_a_trigger_that_cannot_proceed_pauses_instead_of_raising(self):
        # The poll loop calls this for every pane on the machine. A session that cannot go on is
        # its own problem to report, not a reason to stop telling everyone else about their agents.
        s = self.start()
        self.live = [p for p in self.live if p["pane_id"] != "p2"]
        self.assertIsNone(self.arb.turn_ended("p1", []))
        self.assertEqual("member_gone", self.arb.session(s["id"])["pause_reason"])


class Announced(Harness):
    """§9.3 — every pause reaches a person. An unattended loop that stops is not news in six hours."""

    def test_a_pause_is_announced(self):
        s = self.start()
        self.arb.pause(s["id"], "user")
        self.assertEqual(["user"], self.pushed)

    def test_a_budget_pause_is_announced_with_its_own_reason(self):
        s = self.start()
        self.arb.conn.execute("UPDATE sessions SET steps_used=8 WHERE id=?", (s["id"],))
        self.arb.conn.commit()
        self.arb.turn_ended("p1", [])
        self.assertEqual(["budget_steps"], self.pushed)

    def test_a_push_that_fails_does_not_break_the_pause(self):
        # The pause is committed before anyone is told. The worst case is a stopped session nobody
        # was pinged about, which is the state the push improves on — not one it can make worse.
        s = self.start()
        self.arb.notify = lambda *a: (_ for _ in ()).throw(RuntimeError("no subscriptions"))
        self.assertEqual("paused", self.arb.pause(s["id"], "user")["state"])


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
