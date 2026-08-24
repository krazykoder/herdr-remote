#!/usr/bin/env python3
"""Agent configs decide which credential reaches which endpoint, so this is where they are tested.

One rule under all of it: nothing a client can edit may change where a key goes. An alias names a
provider the file already authorised and a key that provider already offered — and the tests push
the shapes that would break that (a key the provider never listed, a provider that does not exist,
a model string carrying shell metacharacters, a kind that does not match) and assert each one is
refused rather than quietly defaulted.

The export line is the other half: it is typed into a real shell, so every value in it goes through
`shlex.quote`, and a key the relay does not hold is left unset rather than exported empty.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "relay"))

from agent_configs import (  # noqa: E402
    Alias, ConfigError, export_line, parse_aliases, parse_providers, preview_command,
    public_configs, public_providers, resolve,
)

PROVIDERS = """
{"version": 1, "providers": [
  {"id": "agentrouter", "label": "AgentRouter", "kind": "claude",
   "env": {"CLAUDE_CONFIG_DIR": "~/.claude-agentrouter",
           "ANTHROPIC_BASE_URL": "https://cc.example.dev"},
   "secrets": {"ANTHROPIC_API_KEY": ["ROUTER_KEY", "ROUTER_KEY2"]},
   "unset": ["ANTHROPIC_API_TOKEN"],
   "model_var": "ANTHROPIC_MODEL",
   "model_option_var": "ANTHROPIC_CUSTOM_MODEL_OPTION",
   "models": ["claude-opus-5", "claude-opus-4-6[1m]"]},
  {"id": "stockcodex", "label": "Codex", "kind": "codex",
   "secrets": {"OPENAI_API_KEY": "OPENAI_KEY"}}
]}
"""

ENV = {"ROUTER_KEY": "sk-one", "ROUTER_KEY2": "sk-two"}


def providers():
    return parse_providers(PROVIDERS)


def aliases(*items):
    return parse_aliases({"aliases": list(items)}, providers())


def oclaude(**over):
    return {"id": "oclaude1", "provider": "agentrouter", "model": "claude-opus-5", **over}


class ProviderFile(unittest.TestCase):
    def test_reads_the_shape_the_docs_describe(self):
        p = providers()[0]
        self.assertEqual(p.kind, "claude")
        self.assertEqual(p.keys(), ["ROUTER_KEY", "ROUTER_KEY2"])
        self.assertEqual(p.unset, ("ANTHROPIC_API_TOKEN",))

    def test_a_single_secret_name_needs_no_list(self):
        self.assertEqual(providers()[1].keys(), ["OPENAI_KEY"])

    def test_model_suggestions_are_a_shortcut_not_an_allowlist(self):
        # Offered in the editor; an alias naming something else is still accepted, because model
        # names move faster than any file here.
        self.assertEqual(providers()[0].models, ("claude-opus-5", "claude-opus-4-6[1m]"))
        self.assertEqual(aliases(oclaude(model="something-new-2027"))[0].model, "something-new-2027")

    def test_a_bad_file_is_fatal_and_says_where(self):
        for raw, where in [
            ('{"providers": [{"id": "A!", "kind": "claude"}]}', "providers[0].id"),
            ('{"providers": [{"id": "a", "kind": "claude", "secrets": {"K": []}}]}',
             "providers.a.secrets.K"),
            ('{"providers": [{"id": "a", "kind": "claude", "env": {"2BAD": "x"}}]}',
             "providers.a.env key"),
            ('{"providers": [{"id": "a"}]}', "providers.a.kind"),
            ('{"providers": "x"}', "providers"),
            ('{"providers": [{"id": "a", "kind": "claude", "models": ["$(id)"]}]}',
             "providers.a.models[0]"),
        ]:
            with self.assertRaises(ConfigError) as caught:
                parse_providers(raw)
            self.assertEqual(caught.exception.path, where)

    def test_two_providers_cannot_share_an_id(self):
        with self.assertRaises(ConfigError):
            parse_providers('{"providers": [{"id": "a", "kind": "claude"},'
                            ' {"id": "a", "kind": "claude"}]}')

    def test_no_file_means_the_feature_is_off_not_broken(self):
        self.assertEqual(parse_providers(""), [])


class AliasDocument(unittest.TestCase):
    def test_an_ordinary_alias_survives(self):
        got = aliases(oclaude(key="ROUTER_KEY2"))
        self.assertEqual([(a.id, a.provider, a.key) for a in got],
                         [("oclaude1", "agentrouter", "ROUTER_KEY2")])

    def test_a_key_the_provider_never_offered_is_dropped(self):
        # The whole point. Naming ROUTER_KEY3 must not fall back to ROUTER_KEY — a session started
        # on a key the user did not choose is worse than one that does not start.
        self.assertEqual(aliases(oclaude(key="ROUTER_KEY3")), [])
        self.assertEqual(aliases(oclaude(key="OPENAI_KEY")), [])

    def test_an_unknown_provider_is_dropped(self):
        self.assertEqual(aliases(oclaude(provider="nope")), [])

    def test_a_model_carrying_shell_metacharacters_is_dropped(self):
        for bad in ["$(id)", "a; rm -rf ~", "a`id`", "a\nb"]:
            self.assertEqual(aliases(oclaude(model=bad)), [], bad)
            self.assertEqual(aliases(oclaude(model_option=bad)), [], bad)

    def test_a_bracketed_model_option_is_a_real_one(self):
        self.assertEqual(aliases(oclaude(model_option="claude-opus-4-6[1m]"))[0].model_option,
                         "claude-opus-4-6[1m]")

    def test_one_bad_row_does_not_cost_the_others(self):
        got = aliases(oclaude(id="bad", provider="nope"), oclaude(id="good"))
        self.assertEqual([a.id for a in got], ["good"])

    def test_junk_is_an_empty_list_never_an_exception(self):
        # Written by browsers of any age, unlike the provider file.
        for raw in ["", "not json", "[]", {"aliases": "x"}, None]:
            self.assertEqual(parse_aliases(raw, providers()), [])


class ExportLine(unittest.TestCase):
    def line(self, **over):
        alias = aliases(oclaude(**over))[0]
        return export_line(alias, providers()[0], ENV)

    def test_it_carries_the_environment_and_the_chosen_key(self):
        line = self.line(key="ROUTER_KEY2")
        self.assertIn("ANTHROPIC_BASE_URL=https://cc.example.dev", line)
        self.assertIn("ANTHROPIC_API_KEY=sk-two", line)
        self.assertIn("ANTHROPIC_MODEL=claude-opus-5", line)
        self.assertIn("unset ANTHROPIC_API_TOKEN", line)

    def test_no_key_named_means_the_providers_first(self):
        self.assertIn("ANTHROPIC_API_KEY=sk-one", self.line())

    def test_a_key_the_relay_does_not_hold_is_left_unset(self):
        alias = aliases(oclaude())[0]
        line = export_line(alias, providers()[0], {})
        self.assertNotIn("ANTHROPIC_API_KEY", line)
        self.assertIn("ANTHROPIC_BASE_URL", line)

    def test_it_hides_from_history_and_clears_the_screen(self):
        line = self.line()
        self.assertTrue(line.startswith(" "), line)
        self.assertTrue(line.endswith("; clear"), line)

    def test_every_value_is_quoted(self):
        # The values here are all well-formed, so the guard has to be checked on one that is not:
        # an Alias built directly, bypassing the document's charset check.
        line = export_line(Alias(id="x", label="x", provider="agentrouter", model="a b; id"),
                           providers()[0], ENV)
        self.assertIn("ANTHROPIC_MODEL='a b; id'", line)

    def test_a_home_relative_config_dir_still_expands(self):
        # Quoting the whole of `~/.claude-agentrouter` hands the CLI a directory called `~`.
        self.assertIn("CLAUDE_CONFIG_DIR=~/.claude-agentrouter", self.line())

    def test_an_empty_model_writes_no_model_variable(self):
        self.assertNotIn("ANTHROPIC_MODEL", self.line(model=""))

    def test_a_provider_with_nothing_to_say_writes_nothing(self):
        bare = parse_providers('{"providers": [{"id": "p", "kind": "claude"}]}')[0]
        self.assertEqual(export_line(Alias(id="x", label="x", provider="p"), bare, ENV), "")


class Preview(unittest.TestCase):
    """The row's command line: the same session, pasteable, with no credential in it."""

    def command(self, **over):
        return preview_command(aliases(oclaude(**over))[0], providers()[0])

    def test_it_names_the_key_variable_and_never_its_value(self):
        line = self.command(key="ROUTER_KEY2")
        self.assertIn('ANTHROPIC_API_KEY="$ROUTER_KEY2"', line)
        self.assertNotIn("sk-", line)

    def test_it_ends_at_the_harness_the_user_would_type(self):
        self.assertTrue(self.command().endswith("; claude"), self.command())

    def test_it_carries_the_model_and_the_endpoint(self):
        line = self.command(model_option="claude-opus-4-6[1m]")
        self.assertIn("ANTHROPIC_MODEL=claude-opus-5", line)
        self.assertIn("ANTHROPIC_BASE_URL=https://cc.example.dev", line)
        self.assertIn("ANTHROPIC_CUSTOM_MODEL_OPTION='claude-opus-4-6[1m]'", line)

    def test_it_is_shown_whether_or_not_the_relay_holds_the_key(self):
        # Unlike the typed line, which leaves an absent key unset — this is the line to paste to
        # find out *why* nothing is set.
        alias = aliases(oclaude())[0]
        self.assertIn("ANTHROPIC_API_KEY", preview_command(alias, providers()[0]))


class Wire(unittest.TestCase):
    def test_start_agent_refuses_rather_than_silently_dropping(self):
        provs, als = providers(), aliases(oclaude())
        self.assertEqual(resolve("", "claude", als, provs), (None, ""))
        self.assertIn("Unknown", resolve("nope", "claude", als, provs)[1])
        self.assertIn("not codex", resolve("oclaude1", "codex", als, provs)[1])
        pair, why = resolve("oclaude1", "claude", als, provs)
        self.assertEqual((pair[0].id, pair[1].id, why), ("oclaude1", "agentrouter", ""))

    def test_what_crosses_the_socket_is_names_and_never_values(self):
        rows = public_configs(aliases(oclaude(key="ROUTER_KEY2")), providers(), ENV)
        self.assertEqual(rows[0]["key"], "ROUTER_KEY2")
        self.assertTrue(rows[0]["key_set"])
        self.assertEqual(rows[0]["kind"], "claude")
        self.assertNotIn("sk-two", repr(rows))
        self.assertIn("; claude", rows[0]["command"])

    def test_it_says_which_model_fields_a_provider_can_carry(self):
        # codex takes its model from CODEX_HOME/config.toml, so the editor must not draw a box
        # that silently goes nowhere.
        rows = public_providers(providers(), ENV)
        self.assertEqual([(r["id"], r["has_model"], r["has_model_option"]) for r in rows],
                         [("agentrouter", True, True), ("stockcodex", False, False)])
        self.assertEqual(rows[0]["models"], ["claude-opus-5", "claude-opus-4-6[1m]"])

    def test_a_key_the_relay_does_not_hold_says_so(self):
        rows = public_configs(aliases(oclaude()), providers(), {})
        self.assertFalse(rows[0]["key_set"])


if __name__ == "__main__":
    unittest.main()
