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
        commands={name: ops_config.Command(name=name, argv=argv, params=params)
                  for name, (argv, params) in commands.items()})


def command(argv=("/bin/echo",), params=None):
    return (list(argv), params or {})


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

    def test_the_shipped_example_produces_a_clean_menu(self):
        cfg = ops_config.load(str(ROOT / "relay" / "ops.example.json"))
        entries, skipped = ops.menu_entries(cfg)
        self.assertEqual([], skipped)
        offered = {name for name, _ in entries}
        for name in cfg.commands:
            self.assertIn(ops.menu_name(name), offered)


if __name__ == "__main__":
    unittest.main()
