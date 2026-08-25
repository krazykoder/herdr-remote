"""The `agent-configs.json` contract: which environments a session may be started under.

This module is the security boundary of agent configs, and the rule it exists to hold is one
sentence: **a client can never cause a credential to reach an endpoint the file did not name.**

Two layers make that true.

A *provider* is file-owned. It names the base URL, the config directory, which of the relay's own
environment variables may supply the key, and which variable the model is written into. Nothing
outside `~/.config/herdr-remote/agent-configs.json` can add one or change one, and the relay never
writes that file.

An *alias* is user-owned — it lives in shared state and the app may edit it freely. It is a name, a
provider that the file already authorised, a free-text model, and a key chosen *from that
provider's own list*. There is no field in it that names a host, a variable, or a secret value, so
adding one cannot widen what the relay will do. That asymmetry is the whole design.

Secret *values* never appear here. `secrets` maps the variable the agent wants to the names of
variables in the relay's environment; the value is read at spawn time and goes straight into the
line typed at the pane. It is never stored, never logged, and never sent to a client.

Pure by design — reading a file and reading `os.environ` are the only I/O.
"""
import json
import os
import re
import shlex
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_CONFIG = "~/.config/herdr-remote/agent-configs.json"

# Ids are the names that end up on disk in launcher tiles and conversation records, so they are
# held to the same shape as everything else this project stores under a name.
ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
# An environment variable name, as the shell defines one. Anchored: this is the set of names the
# relay is willing to write into a pane's shell.
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# A model is free text — the names move faster than any list here could — but it is also the one
# field a client's edit reaches, so it is held to what a model name has ever looked like. Brackets
# are in because `claude-opus-4-8[1m]` is a real one.
MODEL = re.compile(r"^[A-Za-z0-9 ._:@/+\[\]-]{1,120}$")

# A CLI flag, for a provider whose model is argv rather than an environment variable. Anchored for
# the same reason ENV_NAME is: this ends up in the argv of a process the relay spawns.
FLAG = re.compile(r"^--?[A-Za-z][A-Za-z0-9-]{0,31}$")

MAX_ALIASES = 64
MAX_LABEL = 32


class ConfigError(Exception):
    """A bad provider file is fatal — the relay refuses to boot rather than half-understand it.

    `path` is dotted (`providers.agentrouter.secrets`) so the message points at the line to fix.
    """

    def __init__(self, path: str, message: str):
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    kind: str
    env: dict[str, str] = field(default_factory=dict)
    # variable the agent wants -> the relay's own variable names that may supply it, in order.
    # A list because one endpoint with two keys is the ordinary case: `f1claude` and `f2claude`
    # differ by nothing else.
    secrets: dict[str, list[str]] = field(default_factory=dict)
    unset: tuple[str, ...] = ()
    model_var: str = ""
    model_option_var: str = ""
    # The other way a model reaches the agent: on argv, as `--model <name>`, appended after the
    # `--` in `herdr agent start`. Stock harnesses take it this way and have no variable for it.
    model_flag: str = ""
    # Suggestions for the alias editor's model field, nothing more. The field stays free text —
    # model names move faster than any file — so this is a shortcut, not an allowlist.
    models: tuple[str, ...] = ()

    def keys(self) -> list[str]:
        """Every relay variable this provider may read, in the order it offers them."""
        out: list[str] = []
        for names in self.secrets.values():
            out.extend(n for n in names if n not in out)
        return out


@dataclass(frozen=True)
class Alias:
    id: str
    label: str
    provider: str
    model: str = ""
    model_option: str = ""
    key: str = ""       # '' means the provider's first offered key


# The harnesses this relay can start, as providers in their own right.
#
# A stock provider names no endpoint, no configuration directory and no secret — it is the CLI the
# user already has, with `--model` on argv. That is why these are built in rather than left to the
# file: the file exists so that a client can never cause a credential to reach an endpoint it did
# not name, and a provider with neither a credential nor an endpoint has nothing to guard. What it
# buys is the thing the badge needs — a session on a non-default model is an *alias*, so it has a
# name, and `oclaude1` and `claude-sonnet` are drawn the same way.
#
# The model lists are suggestions for the editor, not an allowlist; the field stays free text. A
# file entry reusing one of these ids replaces it, which is how a machine whose models have moved
# on says so without waiting for a release.
STOCK_PROVIDERS = (
    Provider(id="stock-agy", label="Stock", kind="agy", model_flag="--model", models=(
        "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
        "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
        "gemini-3.5-flash-high", "gemini-3.5-flash-medium", "gemini-3.5-flash-low",
        "gemini-3.1-pro-high", "gemini-3.1-pro-low",
        "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium")),
    Provider(id="stock-claude", label="Stock", kind="claude", model_flag="--model", models=(
        "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-8[1m]",
        "claude-opus-4-6[1m]", "claude-sonnet-4-6", "claude-haiku-4-5")),
    Provider(id="stock-codex", label="Stock", kind="codex", model_flag="--model", models=(
        "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4")),
)


def _obj(raw, path):
    if not isinstance(raw, dict):
        raise ConfigError(path, "must be an object")
    return raw


def _str(raw, path, *, required=True, pattern=None, max_len=256):
    value = raw if isinstance(raw, str) else ""
    if not value:
        if required:
            raise ConfigError(path, "must be a non-empty string")
        return ""
    if len(value) > max_len:
        raise ConfigError(path, f"is longer than {max_len} characters")
    if pattern and not pattern.match(value):
        raise ConfigError(path, f"is not a valid {path.rsplit('.', 1)[-1]}")
    return value


def parse_providers(raw: str) -> list[Provider]:
    """The file's contents as providers, or ConfigError naming the field that is wrong.

    Every check here is about the same thing: after this returns, the only endpoints in existence
    and the only secret names readable are the ones this file wrote down.
    """
    try:
        doc = json.loads(raw or "{}")
    except json.JSONDecodeError as exc:
        raise ConfigError("", f"is not valid JSON ({exc})") from exc
    doc = _obj(doc, "")
    items = doc.get("providers") or []
    if not isinstance(items, list):
        raise ConfigError("providers", "must be a list")
    out: list[Provider] = []
    seen: set[str] = set()
    for i, item in enumerate(items):
        at = f"providers[{i}]"
        item = _obj(item, at)
        pid = _str(item.get("id"), f"{at}.id", pattern=ID)
        if pid in seen:
            raise ConfigError(f"{at}.id", f"is a duplicate of an earlier provider ({pid})")
        seen.add(pid)
        at = f"providers.{pid}"
        env = _obj(item.get("env") or {}, f"{at}.env")
        for name, value in env.items():
            _str(name, f"{at}.env key", pattern=ENV_NAME, max_len=64)
            _str(value, f"{at}.env.{name}", max_len=512)
        secrets_raw = _obj(item.get("secrets") or {}, f"{at}.secrets")
        secrets: dict[str, list[str]] = {}
        for name, names in secrets_raw.items():
            _str(name, f"{at}.secrets key", pattern=ENV_NAME, max_len=64)
            # One name or several: a provider with a single key should not have to write a list to
            # say so, and a provider with two should not need a second provider to hold it.
            listed = [names] if isinstance(names, str) else names
            if not isinstance(listed, list) or not listed:
                raise ConfigError(f"{at}.secrets.{name}", "must be a name or a list of names")
            secrets[name] = [
                _str(n, f"{at}.secrets.{name}[{j}]", pattern=ENV_NAME, max_len=64)
                for j, n in enumerate(listed)
            ]
        unset = item.get("unset") or []
        if not isinstance(unset, list):
            raise ConfigError(f"{at}.unset", "must be a list")
        models = item.get("models") or []
        if not isinstance(models, list):
            raise ConfigError(f"{at}.models", "must be a list")
        out.append(Provider(
            id=pid,
            label=_str(item.get("label") or pid, f"{at}.label", max_len=MAX_LABEL),
            kind=_str(item.get("kind"), f"{at}.kind", pattern=ID),
            env=env,
            secrets=secrets,
            unset=tuple(_str(n, f"{at}.unset[{j}]", pattern=ENV_NAME, max_len=64)
                        for j, n in enumerate(unset)),
            model_var=_str(item.get("model_var"), f"{at}.model_var",
                           required=False, pattern=ENV_NAME, max_len=64),
            model_option_var=_str(item.get("model_option_var"), f"{at}.model_option_var",
                                  required=False, pattern=ENV_NAME, max_len=64),
            model_flag=_str(item.get("model_flag"), f"{at}.model_flag",
                            required=False, pattern=FLAG, max_len=32),
            models=tuple(_str(m, f"{at}.models[{j}]", pattern=MODEL, max_len=120)
                         for j, m in enumerate(models)),
        ))
    return out


def load_providers(path: str = "") -> list[Provider]:
    """The file's providers, followed by the stock ones the file did not already claim.

    Absent is not an error — it means no *custom* providers, which is the default state. The stock
    entries are offered either way: see STOCK_PROVIDERS for why that does not widen the boundary
    this module exists to hold.
    """
    target = Path(os.path.expanduser(path or DEFAULT_CONFIG))
    from_file = parse_providers(target.read_text(encoding="utf-8")) if target.is_file() else []
    named = {p.id for p in from_file}
    return from_file + [p for p in STOCK_PROVIDERS if p.id not in named]


def parse_aliases(raw, providers: list[Provider]) -> list[Alias]:
    """Aliases from the shared-state document, dropping the ones no provider backs.

    Dropping and not refusing, unlike the provider file: this document is written by browsers, it
    can be older or newer than the relay, and one unusable row must not cost the user the rest of
    their list. Every survivor names a provider that exists and a key that provider offers, so
    nothing downstream has to check again.
    """
    try:
        doc = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except json.JSONDecodeError:
        return []
    items = (doc or {}).get("aliases") if isinstance(doc, dict) else None
    if not isinstance(items, list):
        return []
    by_id = {p.id: p for p in providers}
    out: list[Alias] = []
    seen: set[str] = set()
    for item in items[:MAX_ALIASES]:
        if not isinstance(item, dict):
            continue
        aid = item.get("id")
        provider = by_id.get(item.get("provider"))
        if not isinstance(aid, str) or not ID.match(aid) or aid in seen or not provider:
            continue
        model = item.get("model") or ""
        option = item.get("model_option") or ""
        if (model and not MODEL.match(model)) or (option and not MODEL.match(option)):
            continue
        key = item.get("key") or ""
        # The one rule that makes an alias safe: a key it names must be one this provider already
        # offered. Anything else and the alias is discarded rather than quietly rebound to the
        # default, because a session started on the wrong key is worse than one that will not start.
        if key and key not in provider.keys():
            continue
        label = item.get("label") or aid
        if not isinstance(label, str) or len(label) > MAX_LABEL:
            continue
        seen.add(aid)
        out.append(Alias(id=aid, label=label, provider=provider.id,
                         model=model, model_option=option, key=key))
    return out


def alias_key(alias: Alias, provider: Provider) -> str:
    """Which relay variable supplies this alias's key. The provider's first when it named none."""
    if alias.key:
        return alias.key
    offered = provider.keys()
    return offered[0] if offered else ""


def public_configs(aliases: list[Alias], providers: list[Provider], environ=None) -> list[dict]:
    """What `start_options` carries: names and nothing else.

    `key` is the *variable's* name and `key_set` says whether the relay holds it — the one fact a
    reader needs about a credential, and the most that can be said without saying the credential.
    """
    env = os.environ if environ is None else environ
    by_id = {p.id: p for p in providers}
    out = []
    for a in aliases:
        p = by_id.get(a.provider)
        if not p:
            continue
        key = alias_key(a, p)
        out.append({
            "id": a.id, "label": a.label, "kind": p.kind,
            "provider": p.id, "provider_label": p.label,
            "model": a.model, "model_option": a.model_option,
            "key": key, "key_set": bool(key and env.get(key)),
            "command": preview_command(a, p),
        })
    return out


def public_providers(providers: list[Provider], environ=None) -> list[dict]:
    """The file's contents, for the screen that says why a row cannot be edited.

    Safe to send: a base URL and a config directory are settings, not secrets — and the reason an
    alias is misbehaving is usually which endpoint it is pointed at.
    """
    env = os.environ if environ is None else environ
    return [{
        "id": p.id, "label": p.label, "kind": p.kind,
        "base_url": p.env.get("ANTHROPIC_BASE_URL", ""),
        "keys": [{"name": n, "set": bool(env.get(n))} for n in p.keys()],
        # Which of the two model fields this provider can actually carry, so the editor draws the
        # ones that do something and says so about the ones it does not. codex takes its model
        # from CODEX_HOME/config.toml rather than the environment, and a field that silently goes
        # nowhere is worse than no field.
        "has_model": bool(p.model_var or p.model_flag),
        "has_model_option": bool(p.model_option_var),
        "models": list(p.models),
    } for p in providers]


def _quote_env(value: str) -> str:
    """`shlex.quote`, except that a leading `~` is left where the shell can still see it.

    `CLAUDE_CONFIG_DIR=~/.claude-router` is the ordinary way one of these is written, and quoting
    the whole of it hands the CLI a directory literally called `~`. Only the tilde is exposed —
    everything after it is quoted as usual, so this is no weaker than the plain call.
    """
    if value == "~":
        return "~"
    if value.startswith("~/"):
        return "~" + shlex.quote(value[1:])
    return shlex.quote(value)


def _statements(alias: Alias, provider: Provider, environ, refs: bool) -> list[str]:
    """The shell statements a session under this alias runs, in order.

    `refs` is the difference between the line that is typed at the pane and the line that is shown
    on screen: typed, a secret is its value; shown, it is `"$ROUTER_KEY"` — the name of the
    variable, which is the most that can be said about a credential in a message a client receives.
    """
    env = os.environ if environ is None else environ
    out: list[str] = []
    if provider.unset:
        out.append("unset " + " ".join(provider.unset))
    assignments = [f"{name}={_quote_env(value)}" for name, value in provider.env.items()]
    chosen = alias_key(alias, provider)
    for wants, names in provider.secrets.items():
        # The alias's choice when this is the variable it chose from, the provider's first
        # otherwise. A provider with two different secrets — a key and a token, say — keeps both.
        name = chosen if chosen in names else (names[0] if names else "")
        if not name:
            continue
        if refs:
            assignments.append(f'{wants}="${name}"')
            continue
        value = env.get(name)
        if value:
            assignments.append(f"{wants}={shlex.quote(value)}")
    if provider.model_var and alias.model:
        assignments.append(f"{provider.model_var}={shlex.quote(alias.model)}")
    if provider.model_option_var and alias.model_option:
        assignments.append(f"{provider.model_option_var}={shlex.quote(alias.model_option)}")
    if assignments:
        out.append("export " + " ".join(assignments))
    return out


def export_line(alias: Alias, provider: Provider, environ=None) -> str:
    """The one line typed at the pane's shell before `herdr agent start` attaches to it.

    Every value is quoted with `shlex.quote`, and every value's *origin* is either the provider
    file or the relay's own environment — a client's edit reaches the model strings and the choice
    of key name, and nothing else. A key whose variable the relay does not hold is left unset
    rather than exported empty: an empty key fails at the API with a clear message, and an unset
    one lets the CLI fall back to whatever the user's own login already had.

    The leading space keeps the line out of the shell's history under HIST_IGNORE_SPACE; the
    trailing `clear` takes it off the screen the agent is about to draw on.
    """
    parts = _statements(alias, provider, environ, refs=False)
    return " " + "; ".join(parts) + "; clear" if parts else ""


def model_args(alias: Alias, provider: Provider) -> tuple[str, ...]:
    """The model, when this provider carries it on argv rather than in the environment.

    Appended after the `--` in `herdr agent start`, so it reaches the harness's own CLI. Data, not
    a shell word: locally it is one element of an argv, and a remote start quotes every element
    before ssh hands the line to a login shell.
    """
    if provider.model_flag and alias.model:
        return (provider.model_flag, alias.model)
    return ()


def preview_command(alias: Alias, provider: Provider) -> str:
    """The same session, as a line the user can paste into their own terminal.

    Shown on the config's row so the thing the relay will do is readable before it does it, and
    testable without it — which is how a wrong base URL or a key that was never exported gets
    found in one paste instead of one spawn. Carries variable *references*, never values.

    ponytail: the harness kind doubles as the binary name, which is true for claude, codex and pi.
    A provider whose CLI is called something else gets a `command` field here.
    """
    run = shlex.join((provider.kind,) + model_args(alias, provider))
    return "; ".join(_statements(alias, provider, {}, refs=True) + [run])


def resolve(config_id: str, kind: str, aliases: list[Alias], providers: list[Provider]):
    """The alias a `start_agent` named, or (None, reason).

    Refused rather than ignored on every failure. A spawn that silently dropped the config the user
    picked would come up on the stock provider wearing the name of the custom one, which is the one
    outcome worse than not starting.
    """
    if not config_id:
        return None, ""
    alias = next((a for a in aliases if a.id == config_id), None)
    if not alias:
        return None, f"Unknown agent config: {config_id}"
    provider = next((p for p in providers if p.id == alias.provider), None)
    if not provider:
        return None, f"Agent config {config_id} has no provider on this relay"
    # The kind is checked here and not only in the UI: a config is an environment for one CLI, and
    # pointing codex at claude's base URL would start a session that fails in a way nothing on
    # screen explains.
    if kind and provider.kind != kind:
        return None, f"Agent config {config_id} is for {provider.kind}, not {kind}"
    return (alias, provider), ""
