#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from start_agent import (
    AGENT_START_TIMEOUT_MS,
    DEFAULT_START_AGENTS,
    HERDR_AGENT_NAME_RE,
    SUFFIX_ALPHABET,
    StartAgentConfigError,
    agent_name_from_label,
    agent_start_args,
    dig,
    SPACER_LABEL,
    load_start_agents,
    next_role_label,
    pane_split_args,
    plan_slot,
    tab_create_args,
    unique_agent_name,
    validate_pane_label,
    validate_start_request,
)

PROJECTS = [
    {"id": "charts", "label": "Charts", "cwd": "/work/charts", "host": "local"},
    {"id": "relay", "label": "Relay", "cwd": "/work/relay", "host": "box"},
]

ALLOWED = ["codex", "claude", "pi"]


def agent(pane_id, **kw):
    a = {
        "pane_id": pane_id,
        "workspace_id": kw.get("workspace_id", "w1"),
        "tab_id": kw.get("tab_id", "t1"),
        "host": kw.get("host", "local"),
        "remote": kw.get("remote"),
        "label": kw.get("label", ""),
    }
    if "project_id" in kw:
        a["project_id"] = kw["project_id"]
    return a


LIVE = [
    agent("w1:p1", workspace_id="w1", tab_id="t1", project_id="charts", label="Architect 1"),
    agent("w1:p2", workspace_id="w1", tab_id="t1", project_id="charts", label="Reviewer 1"),
    agent("w5:p1", workspace_id="w5", tab_id="t9", host="box", remote="box", project_id="relay"),
    agent("w7:p1", workspace_id="w7", tab_id="t7"),  # unmatched — no project_id
]


def start(**kw):
    msg = {"type": "start_agent", "name": "claude", "role": "architect",
           "project_id": "charts", "placement": "new_workspace"}
    msg.update(kw)
    return msg


class LoadStartAgentsTests(unittest.TestCase):
    def test_unset_uses_default(self):
        self.assertEqual(load_start_agents(""), DEFAULT_START_AGENTS)
        self.assertEqual(load_start_agents(None), DEFAULT_START_AGENTS)
        self.assertEqual(load_start_agents("   "), DEFAULT_START_AGENTS)

    def test_order_preserved_and_deduplicated(self):
        self.assertEqual(load_start_agents("pi, claude ,codex,claude"), ["pi", "claude", "codex"])

    def test_malformed_name_refused(self):
        for raw in ("cl aude", "Claude", "claude;rm -rf /", "../claude", "a" * 33):
            with self.assertRaises(StartAgentConfigError):
                load_start_agents(raw)

    def test_only_separators_refused(self):
        with self.assertRaises(StartAgentConfigError):
            load_start_agents(",,,")


class RoleLabelTests(unittest.TestCase):
    def test_first_unused_number(self):
        self.assertEqual(next_role_label("architect", "charts", LIVE), "Architect 2")
        self.assertEqual(next_role_label("reviewer", "charts", LIVE), "Reviewer 2")
        self.assertEqual(next_role_label("agent", "charts", LIVE), "Agent 1")

    def test_gaps_are_filled(self):
        agents = [agent("p", project_id="charts", label="Architect 2")]
        self.assertEqual(next_role_label("architect", "charts", agents), "Architect 1")

    def test_scoped_per_project(self):
        self.assertEqual(next_role_label("architect", "relay", LIVE), "Architect 1")

    def test_ignores_user_renamed_labels(self):
        agents = [agent("p", project_id="charts", label="Architect 1 (mine)")]
        self.assertEqual(next_role_label("architect", "charts", agents), "Architect 1")


class ValidateBasicsTests(unittest.TestCase):
    def test_valid_new_workspace_plan(self):
        plan, err = validate_start_request(start(), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["cwd"], "/work/charts")
        self.assertIsNone(plan["remote"])
        self.assertEqual(plan["label"], "Architect 2")
        self.assertEqual(plan["project_label"], "Charts")

    def test_remote_project_resolves_ssh_target(self):
        plan, err = validate_start_request(
            start(project_id="relay", role="agent"), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["remote"], "box")
        self.assertEqual(plan["cwd"], "/work/relay")

    def test_agent_not_in_allowlist(self):
        _, err = validate_start_request(start(name="bash"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "agent not in allowlist")

    def test_missing_name(self):
        msg = start()
        del msg["name"]
        _, err = validate_start_request(msg, PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "agent not in allowlist")

    def test_unknown_role(self):
        _, err = validate_start_request(start(role="root"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown role")

    def test_unknown_project(self):
        _, err = validate_start_request(start(project_id="nope"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown project_id")

    def test_unknown_placement(self):
        _, err = validate_start_request(start(placement="anywhere"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown placement")

    def test_client_cannot_smuggle_cwd_host_env_or_argv(self):
        for field, value in (("cwd", "/etc"), ("host", "box"), ("env", {"X": "1"}),
                             ("argv", ["sh"]), ("tab_id", "t1"), ("prompt", "hi")):
            _, err = validate_start_request(start(**{field: value}), PROJECTS, LIVE, ALLOWED)
            self.assertIn("unexpected field", err, field)

    def test_placement_field_for_the_wrong_placement(self):
        _, err = validate_start_request(start(split_from="w1:p1"), PROJECTS, LIVE, ALLOWED)
        self.assertIn("unexpected field", err)


class NewTabTests(unittest.TestCase):
    def test_valid(self):
        plan, err = validate_start_request(
            start(placement="new_tab", workspace_id="w1"), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["workspace_id"], "w1")

    def test_missing_workspace_id(self):
        _, err = validate_start_request(start(placement="new_tab"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "workspace_id required for new_tab")

    def test_unknown_workspace(self):
        _, err = validate_start_request(
            start(placement="new_tab", workspace_id="w99"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown workspace_id")

    def test_workspace_on_two_hosts_refused(self):
        """A11 — the collision the one-distinct-host test exists to catch."""
        agents = LIVE + [agent("w1:p9", workspace_id="w1", host="box", remote="box")]
        _, err = validate_start_request(
            start(placement="new_tab", workspace_id="w1"), PROJECTS, agents, ALLOWED)
        self.assertIn("ambiguous workspace_id", err)

    def test_cross_host_workspace_refused(self):
        _, err = validate_start_request(
            start(placement="new_tab", workspace_id="w5"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "workspace is not on this project's host")

    def test_foreign_project_workspace_refused(self):
        """Same host, but nothing in that workspace belongs to the Project."""
        _, err = validate_start_request(
            start(placement="new_tab", workspace_id="w7"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "workspace does not belong to this project")


class SplitTests(unittest.TestCase):
    def test_valid(self):
        plan, err = validate_start_request(
            start(placement="split", split_from="w1:p2"), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["split_from"], "w1:p2")

    def test_missing_split_from(self):
        _, err = validate_start_request(start(placement="split"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "split_from required for split")

    def test_unknown_pane(self):
        _, err = validate_start_request(
            start(placement="split", split_from="w9:p9"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown pane_id")

    def test_ambiguous_pane_refused(self):
        agents = LIVE + [agent("w1:p1", workspace_id="w4", host="box", remote="box",
                               project_id="charts")]
        _, err = validate_start_request(
            start(placement="split", split_from="w1:p1"), PROJECTS, agents, ALLOWED)
        self.assertIn("ambiguous pane_id", err)

    def test_cross_host_split_refused(self):
        _, err = validate_start_request(
            start(placement="split", split_from="w5:p1"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "pane is not on this project's host")

    def test_foreign_project_pane_refused(self):
        _, err = validate_start_request(
            start(placement="split", split_from="w7:p1"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "pane does not belong to this project")


class ArgsTests(unittest.TestCase):
    def test_new_tab_uses_the_role_label(self):
        args = tab_create_args("w3", "/work/charts", "Architect 1")
        self.assertEqual(args, ("tab", "create", "--workspace", "w3", "--cwd", "/work/charts",
                                "--label", "Architect 1", "--focus"))

    def test_kind_is_the_allowlisted_name(self):
        args = agent_start_args("claude", "Architect 1", "w3:p1")
        self.assertEqual(args[args.index("--kind") + 1], "claude")
        self.assertEqual(args[args.index("--pane") + 1], "w3:p1")

    def test_herdr_agent_name_is_the_label_not_the_kind(self):
        # The kind there is what made every start after the first fail agent_name_taken.
        args = agent_start_args("claude", "Architect 1", "w3:p1")
        self.assertEqual(args[:3], ("agent", "start", "Architect 1"))

    def test_start_waits_for_interactive_readiness(self):
        # herdr blocks until the agent is ready; the relay's subprocess timeout is sized off this.
        args = agent_start_args("claude", "Architect 1", "w3:p1")
        self.assertEqual(args[args.index("--timeout") + 1], str(AGENT_START_TIMEOUT_MS))

    def test_pane_split_goes_right_at_the_project_cwd(self):
        args = pane_split_args("w1:p2", "/work/charts")
        self.assertEqual(args[:3], ("pane", "split", "w1:p2"))
        self.assertEqual(args[args.index("--direction") + 1], "right")
        self.assertEqual(args[args.index("--cwd") + 1], "/work/charts")


class AgentNameFromLabelTests(unittest.TestCase):
    """herdr refuses an agent name that is not ^[a-z][a-z0-9_-]{0,31}$, and every label the
    relay derives ("Architect 1") violates it. The slug is what makes a start possible at all."""

    def test_role_labels_become_legal_names(self):
        for label in ("Architect 1", "Reviewer 12", "Agent 3"):
            got = agent_name_from_label(label, "claude")
            self.assertRegex(got, HERDR_AGENT_NAME_RE.pattern, label)

    def test_spaces_and_case_are_folded(self):
        self.assertEqual(agent_name_from_label("Architect 1", "claude"), "architect-1")

    def test_punctuation_collapses_to_one_dash(self):
        self.assertEqual(agent_name_from_label("Web // API!!", "claude"), "web-api")

    def test_leading_digits_are_dropped_so_the_name_starts_with_a_letter(self):
        self.assertEqual(agent_name_from_label("2nd Backend", "claude"), "nd-backend")

    def test_label_that_slugs_away_falls_back_to_the_kind(self):
        for label in ("___", "!!!", "42", "   "):
            self.assertEqual(agent_name_from_label(label, "claude"), "claude", label)

    def test_result_is_bounded_to_32(self):
        out = agent_name_from_label("Very Long " * 10, "claude")
        self.assertLessEqual(len(out), 32)
        self.assertRegex(out, HERDR_AGENT_NAME_RE.pattern)


class UniqueAgentNameTests(unittest.TestCase):
    def test_free_name_is_returned_unchanged(self):
        self.assertEqual(unique_agent_name("architect-1", {"codex", "claude"}), "architect-1")

    def test_taken_name_gets_a_random_suffix(self):
        out = unique_agent_name("architect-1", {"architect-1"})
        self.assertNotEqual(out, "architect-1")
        self.assertRegex(out, r"^architect-1-[a-km-z2-9]{5}$")

    def test_suffix_keeps_the_name_legal_for_herdr(self):
        out = unique_agent_name("x" * 32, {"x" * 32})
        self.assertLessEqual(len(out), 32)
        self.assertRegex(out, HERDR_AGENT_NAME_RE.pattern)

    def test_a_trailing_dash_never_survives_truncation(self):
        # "aaaa…-" truncated at the suffix boundary would otherwise yield "base--suffix".
        out = unique_agent_name("a" * 25 + "-" + "b" * 6, {"a" * 25 + "-" + "b" * 6})
        self.assertNotIn("--", out)
        self.assertRegex(out, HERDR_AGENT_NAME_RE.pattern)

    def test_retries_past_a_taken_suffix(self):
        # Every 5-char suffix but one is taken, so the loop must keep drawing rather than
        # return a colliding name.
        import itertools
        taken = {"a"} | {"a-" + "".join(c) for c in itertools.product(SUFFIX_ALPHABET, repeat=2)}
        out = unique_agent_name("a", taken)
        self.assertNotIn(out, taken)


class ClientLabelTests(unittest.TestCase):
    def test_client_label_overrides_the_derived_one(self):
        plan, err = validate_start_request(start(label="Backend"), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["label"], "Backend")

    def test_absent_label_is_derived(self):
        plan, err = validate_start_request(start(), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["label"], "Architect 2")

    def test_empty_label_is_refused_rather_than_silently_derived(self):
        _, err = validate_start_request(start(label="  "), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "label is empty")

    def test_label_starting_with_a_dash_is_refused(self):
        # It reaches herdr as a positional; a leading dash would parse as a flag.
        _, err = validate_start_request(start(label="--focus"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "label cannot start with '-'")

    def test_control_characters_are_refused(self):
        _, err = validate_start_request(start(label="a\nb"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "label contains control characters")


class DigTests(unittest.TestCase):
    def test_reads_nested_ids(self):
        self.assertEqual(dig({"result": {"agent": {"pane_id": "w1:p3"}}},
                             "result", "agent", "pane_id"), "w1:p3")

    def test_missing_hops_read_as_absent(self):
        self.assertEqual(dig({}, "result", "agent", "pane_id"), "")
        self.assertEqual(dig({"result": None}, "result", "agent", "pane_id"), "")
        self.assertEqual(dig({"result": {"agent": {"pane_id": 7}}},
                             "result", "agent", "pane_id"), "")


def pane(pane_id, tab_id="t1", agent="codex", cwd="/work/charts", label=""):
    return {"pane_id": pane_id, "tab_id": tab_id, "agent": agent, "cwd": cwd, "label": label}


def spacer(pane_id, tab_id="t1"):
    """A pane this feature created: a shell holding columns, carrying the label that says so."""
    return pane(pane_id, tab_id=tab_id, agent="", label=SPACER_LABEL)


class PlanSlotTests(unittest.TestCase):
    def test_rejects_unknown_slot_and_pane(self):
        panes = [pane("w1:p1")]
        self.assertEqual(plan_slot(panes, "w1:p1", "half")[0], None)
        self.assertEqual(plan_slot(panes, "w1:p9", "wide")[0], None)

    def test_already_in_slot_is_no_work(self):
        self.assertEqual(plan_slot([pane("w1:p1")], "w1:p1", "wide"), ([], None))
        two = [pane("w1:p1"), pane("w1:p2")]
        self.assertEqual(plan_slot(two, "w1:p1", "narrow"), ([], None))

    def test_wide_closes_spacers_rather_than_moving(self):
        # Moving out would widen this pane too, but leave a tab holding an idle shell.
        panes = [pane("w1:p1"), spacer("w1:p2")]
        steps, err = plan_slot(panes, "w1:p1", "wide")
        self.assertIsNone(err)
        self.assertEqual(steps, [("pane", "close", "w1:p2")])

    def test_wide_never_closes_a_sibling_running_a_session(self):
        panes = [pane("w1:p1"), pane("w1:p2", agent="claude")]
        steps, _ = plan_slot(panes, "w1:p1", "wide")
        self.assertEqual(steps, [("pane", "move", "w1:p1", "--new-tab")])

    def test_a_bare_shell_is_not_a_spacer(self):
        # A pane the user split themselves has no agent either. Closing it to reclaim columns
        # would kill whatever they were running in it, so this moves out instead.
        panes = [pane("w1:p1"), pane("w1:p2", agent="", label="build")]
        steps, _ = plan_slot(panes, "w1:p1", "wide")
        self.assertEqual(steps, [("pane", "move", "w1:p1", "--new-tab")])

    def test_the_spacer_label_alone_does_not_make_a_pane_closable(self):
        # Otherwise renaming a live session to the spacer label would make it disposable.
        panes = [pane("w1:p1"), pane("w1:p2", agent="claude", label=SPACER_LABEL)]
        steps, _ = plan_slot(panes, "w1:p1", "wide")
        self.assertEqual(steps, [("pane", "move", "w1:p1", "--new-tab")])

    def test_narrow_from_alone_splits_in_place(self):
        steps, err = plan_slot([pane("w1:p1")], "w1:p1", "narrow")
        self.assertIsNone(err)
        self.assertEqual(steps, [("pane", "split", "w1:p1", "--direction", "right",
                                  "--cwd", "/work/charts")])
        # Focus stays with the session, not the shell that was just made to sit beside it.
        self.assertNotIn("--focus", steps[0])

    def test_narrow_from_a_crowded_tab_leaves_first(self):
        panes = [pane("w1:p1"), pane("w1:p2", agent="claude"), pane("w1:p3", agent="pi")]
        steps, _ = plan_slot(panes, "w1:p1", "narrow")
        self.assertEqual(steps[0], ("pane", "move", "w1:p1", "--new-tab"))
        self.assertEqual(steps[-1][:2], ("pane", "split"))
        # The siblings are live sessions; nothing of theirs is touched.
        self.assertEqual(len(steps), 2)

    def test_narrow_from_a_tab_of_spacers_clears_them(self):
        panes = [pane("w1:p1"), spacer("w1:p2"), spacer("w1:p3")]
        steps, _ = plan_slot(panes, "w1:p1", "narrow")
        self.assertEqual(steps[0], ("pane", "move", "w1:p1", "--new-tab"))
        self.assertIn(("pane", "close", "w1:p2"), steps)
        self.assertIn(("pane", "close", "w1:p3"), steps)

    def test_other_tabs_are_not_siblings(self):
        panes = [pane("w1:p1", tab_id="t1"), spacer("w1:p2", tab_id="t2")]
        self.assertEqual(plan_slot(panes, "w1:p1", "wide"), ([], None))
        steps, _ = plan_slot(panes, "w1:p1", "narrow")
        self.assertEqual(steps, [("pane", "split", "w1:p1", "--direction", "right",
                                  "--cwd", "/work/charts")])

    def test_missing_cwd_still_yields_a_runnable_split(self):
        steps, _ = plan_slot([{"pane_id": "w1:p1", "tab_id": "t1", "agent": "codex"}],
                             "w1:p1", "narrow")
        self.assertEqual(steps[0][-1], ".")


class SlotOnStartTests(unittest.TestCase):
    def test_slot_is_optional_and_absent_reads_as_none(self):
        plan, err = validate_start_request(start(), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertIsNone(plan["slot"])

    def test_slot_is_carried_into_the_plan(self):
        plan, err = validate_start_request(start(slot="narrow"), PROJECTS, LIVE, ALLOWED)
        self.assertIsNone(err)
        self.assertEqual(plan["slot"], "narrow")

    def test_unknown_slot_is_refused(self):
        _, err = validate_start_request(start(slot="tiny"), PROJECTS, LIVE, ALLOWED)
        self.assertEqual(err, "unknown slot")


class PaneLabelTests(unittest.TestCase):
    def test_accepts_and_strips(self):
        self.assertEqual(validate_pane_label("  Architect 1  "), ("Architect 1", ""))

    def test_rejects_empty_and_whitespace_only(self):
        for raw in ("", "   ", "\t"):
            label, err = validate_pane_label(raw)
            self.assertEqual(label, "")
            self.assertTrue(err)

    def test_rejects_non_string(self):
        self.assertEqual(validate_pane_label(None)[0], "")
        self.assertEqual(validate_pane_label(7)[0], "")

    def test_length_boundary(self):
        self.assertEqual(validate_pane_label("x" * 32), ("x" * 32, ""))
        self.assertEqual(validate_pane_label("x" * 33)[0], "")

    def test_rejects_control_characters(self):
        # A newline or escape in a pane label corrupts the herdr status line and pane list.
        for raw in ("bad\nname", "bad\tname", "bad\x1b[31mname", "bad\x7fname"):
            label, err = validate_pane_label(raw)
            self.assertEqual(label, "", raw)
            self.assertIn("control", err)

    def test_allows_punctuation_and_non_ascii(self):
        for raw in ("charts.TS · api", "Reviewer #2", "Wörker"):
            self.assertEqual(validate_pane_label(raw), (raw, ""))


if __name__ == "__main__":
    unittest.main()
