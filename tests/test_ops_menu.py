#!/usr/bin/env python3
"""The native command menu, and the handlers registered from it.

Telegram's autocomplete is built from `menu_entries()`, and so is the set of `/df`-style handlers
`main()` installs — deliberately the same call, because a menu that offers a command nothing
answers is worse than no menu. These tests pin that agreement and the name rules Telegram enforces
but ops.json does not: a registry entry may be called `git-log`, and a Telegram command may not.
"""
import os
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))
os.environ.setdefault("HERDR_OPS_TG_TOKEN", "test-token")

import ops_config  # noqa: E402
import herdr_ops as ops  # noqa: E402


def config(**commands):
    return ops_config.OpsConfig(
        chat_ids={1}, services={}, limits={},
        commands={name: ops_config.Command(name=name, **spec) for name, spec in commands.items()})


def command(argv=("/bin/echo",), params=None, **extra):
    return dict(argv=list(argv), params=params or {}, **extra)


class MenuNames(unittest.TestCase):

    def test_a_hyphen_becomes_an_underscore(self):
        entries, skipped = ops.menu_entries(config(**{"git-log": command()}))
        self.assertIn("git_log", [name for name, _ in entries])
        self.assertEqual([], skipped)

    def test_every_entry_is_a_legal_telegram_command(self):
        entries, _ = ops.menu_entries(config(**{"git-log": command(), "df": command()}))
        for name, description in entries:
            with self.subTest(name=name):
                self.assertRegex(name, ops.TG_COMMAND)
                self.assertLessEqual(len(description), ops.TG_DESC_MAX)
                self.assertTrue(description)

    def test_a_registry_name_shadowing_a_builtin_is_skipped(self):
        # `run`, `health`, `stop`… belong to the bot. A registry entry must not silently replace
        # one — the handler for the builtin is registered first and would win, leaving a menu that
        # promises something else.
        entries, skipped = ops.menu_entries(config(health=command()))
        self.assertEqual(1, [name for name, _ in entries].count("health"))
        self.assertIn("already taken", skipped[0])

    def test_two_registry_names_collapsing_to_one_command_skip_the_second(self):
        entries, skipped = ops.menu_entries(config(**{"git-log": command(), "git_log": command()}))
        self.assertEqual(1, [name for name, _ in entries].count("git_log"))
        self.assertIn("already taken", skipped[0])

    def test_the_menu_stops_at_telegrams_cap(self):
        many = {f"cmd{i}": command() for i in range(ops.TG_MENU_MAX + 10)}
        entries, skipped = ops.menu_entries(config(**many))
        self.assertEqual(ops.TG_MENU_MAX, len(entries))
        self.assertTrue(all("menu is full" in reason for reason in skipped))

    def test_params_are_shown_in_the_description(self):
        entries, _ = ops.menu_entries(
            config(**{"git-log": command(["git", "log"], {"repo": {"enum": ["/tmp"]},
                                                          "n": {"int": [1, 5]}})}))
        description = dict(entries)["git_log"]
        self.assertIn("<repo>", description)
        self.assertIn("<n>", description)


class BuiltinsMatchHandlers(unittest.TestCase):
    """A menu row with no handler is a command the phone offers and the bot silently ignores."""

    def test_every_builtin_menu_row_has_a_handler(self):
        handled = {name for name, _ in ops.BUILTIN_HANDLERS}
        for name, _ in ops.BUILTIN_MENU:
            with self.subTest(command=name):
                self.assertIn(name, handled)

    def test_the_shortcut_pair_is_present_and_ordered_for_a_hurry(self):
        # /relay_restart is the command this bot exists for; Telegram renders the menu in the order
        # it is given, so it belongs above the general-purpose ones.
        names = [name for name, _ in ops.BUILTIN_MENU]
        self.assertIn("relay_restart", names)
        self.assertIn("relay_url", names)
        self.assertLess(names.index("relay_restart"), names.index("svc"))

    def test_start_is_handled_without_taking_a_menu_row(self):
        self.assertIn("start", {name for name, _ in ops.BUILTIN_HANDLERS})
        self.assertNotIn("start", {name for name, _ in ops.BUILTIN_MENU})


class MenuMatchesHandlers(unittest.TestCase):
    """`main()` resolves every non-builtin entry back to a registry command. If that lookup ever
    found nothing it would raise StopIteration at boot, before a single update is served."""

    def test_every_offered_command_resolves_to_a_registry_entry(self):
        cfg = config(**{"git-log": command(), "df": command(), "health": command()})
        entries, _ = ops.menu_entries(cfg)
        builtin = {name for name, _ in ops.BUILTIN_MENU}
        for tg_name, _ in entries:
            if tg_name in builtin:
                continue
            with self.subTest(command=tg_name):
                origin = [n for n in cfg.commands if ops.menu_name(n) == tg_name]
                self.assertEqual(1, len(origin), f"/{tg_name} maps to {origin}")

    def test_the_shipped_example_leaves_nothing_unreachable(self):
        # Not "every command is in the menu" — grouping deliberately takes members out of it. The
        # invariant that matters is that each one still has a handler behind it.
        cfg = ops_config.load(str(ROOT / "relay" / "ops.example.json"))
        plan = ops.menu_plan(cfg)
        self.assertEqual([], plan.skipped)
        for name in cfg.commands:
            with self.subTest(command=name):
                self.assertEqual(name, plan.handlers[ops.menu_name(name)])


class Submenus(unittest.TestCase):
    """`menu` groups entries behind one `/git`-style command. Telegram has no nested slash
    commands, so this is the only way related entries share a menu item."""

    def plan(self, **commands):
        return ops.menu_plan(config(**commands))

    def test_a_group_becomes_one_menu_entry_and_its_members_leave_the_top_level(self):
        plan = self.plan(**{"git-log": command(menu="git"), "git-status": command(menu="git"),
                            "df": command()})
        offered = [name for name, _ in plan.entries]
        self.assertIn("git", offered)
        self.assertIn("df", offered)
        self.assertNotIn("git_log", offered)
        self.assertNotIn("git_status", offered)
        self.assertEqual(("git-log", "git-status"), plan.groups["git"])

    def test_a_grouped_member_still_has_a_handler(self):
        # Off the menu is not unreachable: typing /git_log has to keep working, or grouping would
        # be a way to lose commands.
        plan = self.plan(**{"git-log": command(menu="git")})
        self.assertEqual("git-log", plan.handlers["git_log"])

    def test_the_group_entry_counts_its_members(self):
        plan = self.plan(**{"a": command(menu="g"), "b": command(menu="g")})
        self.assertEqual("2 command(s)", dict(plan.entries)["g"])

    def test_a_group_shadowing_a_builtin_leaves_its_members_at_the_top_level(self):
        plan = self.plan(**{"git-log": command(menu="health")})
        self.assertNotIn("health", plan.groups)
        self.assertIn("git_log", [name for name, _ in plan.entries])
        self.assertTrue(any("members stay at the top level" in r for r in plan.skipped))

    def test_a_group_wins_the_name_over_a_command_that_wants_it(self):
        # Dropping the group would strand its members inside a submenu that no longer exists; the
        # colliding command is still reachable as /run git.
        plan = self.plan(git=command(), **{"git-log": command(menu="git")})
        self.assertIn("git", plan.groups)
        self.assertNotIn("git", plan.handlers)
        self.assertTrue(any(r.startswith("git:") for r in plan.skipped))

    def test_an_empty_group_is_not_offered(self):
        plan = self.plan(health=command(menu="g"))
        self.assertEqual({}, plan.groups)
        self.assertNotIn("g", [name for name, _ in plan.entries])

    def test_callback_data_fits_telegrams_64_bytes(self):
        longest = "c" * 32
        plan = self.plan(**{longest: command(menu="g")})
        payload = f"{ops.MENU_TAP}{plan.groups['g'][0]}"
        self.assertLessEqual(len(payload.encode()), 64)

    def test_the_shipped_example_groups_git(self):
        cfg = ops_config.load(str(ROOT / "relay" / "ops.example.json"))
        plan = ops.menu_plan(cfg)
        self.assertEqual([], plan.skipped)
        self.assertIn("git", plan.groups)
        self.assertIn("git-log", plan.groups["git"])
        self.assertNotIn("git_log", [name for name, _ in plan.entries])
        self.assertIn("deploy_web", [name for name, _ in plan.entries])


if __name__ == "__main__":
    unittest.main()
