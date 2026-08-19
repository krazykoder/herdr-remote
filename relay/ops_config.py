"""The `ops.json` contract: what herdr-ops is allowed to run, and nothing else.

This module is the security boundary of the ops bot. Everything the bot can do to the machine is
a row in one of two tables here — `services` (things it can start and stop) and `commands` (argv
templates it can execute). There is no escape hatch: no `/exec`, no shell, no way to name a binary
the config does not.

The rule that makes that hold is in `build_argv`: a `{placeholder}` must be a *whole* argv element.
`["git", "-C", "{repo}"]` is legal; `["git", "-C{repo}"]` is not, and is rejected at load time
rather than at run time. Because substitution replaces whole list elements and never concatenates
strings, a validated parameter cannot grow into a second argument, an option, or a shell fragment.

Pure by design — reading a file is the only I/O. Process control lives in ops_supervisor.
"""
import json
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = "~/.config/herdr-remote/ops.json"

# Anchored, and that anchoring is the whole point: a placeholder is an entire argv element or it is
# a config error. UNANCHORED is used only to *find* the ones that broke that rule, for the message.
PLACEHOLDER = re.compile(r"^\{([a-z][a-z0-9_]*)\}$")
UNANCHORED = re.compile(r"\{([a-z][a-z0-9_]*)\}")
NAME = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")

PROBES = ("tcp", "pgrep", "http", "unit")
MAX_PARAM_LEN = 128

DEFAULT_LIMITS = {"stream_seconds": 600, "stream_bytes": 262144, "rate_per_min": 20}


class ConfigError(Exception):
    """A bad config is fatal — the bot exits rather than run a partially understood registry.

    `path` is dotted (`services.relay.health`) so the message points at the line to fix.
    """

    def __init__(self, path: str, message: str):
        super().__init__(f"{path}: {message}")
        self.path = path
        self.message = message


@dataclass(frozen=True)
class Command:
    name: str
    argv: list[str]
    params: dict[str, dict]
    cwd: str | None = None
    timeout: int = 60
    tier: str = "R"
    stream: bool = False


@dataclass(frozen=True)
class Service:
    name: str
    start: list[str]
    root: str
    health: dict
    env: dict[str, str] = field(default_factory=dict)
    unit: dict[str, str] | None = None
    log: str | None = None
    stream: bool = False


@dataclass(frozen=True)
class OpsConfig:
    chat_ids: set[int]
    services: dict[str, Service]
    commands: dict[str, Command]
    limits: dict[str, int]
    path: str = ""


def resolve(value: str, base: Path = REPO_ROOT) -> str:
    """`~` expands; a relative path is relative to the repo, not to the bot's cwd.

    The bot may be started from anywhere (a launchd unit has no meaningful cwd), so a registry that
    said `relay/start.sh` would otherwise mean something different depending on who launched it.
    """
    expanded = os.path.expanduser(value)
    return expanded if os.path.isabs(expanded) else str(base / expanded)


def _short(value: str) -> str:
    return repr(value)[:32]


def _require(cond, path: str, message: str):
    if not cond:
        raise ConfigError(path, message)


def _check_name(name, path: str):
    _require(isinstance(name, str) and NAME.match(name), path,
             f"name must match {NAME.pattern}, got {_short(str(name))}")


def _load_param_spec(spec, path: str) -> dict:
    _require(isinstance(spec, dict), path, "must be an object")
    kinds = [k for k in ("enum", "int", "re") if k in spec]
    _require(len(kinds) == 1, path,
             f"needs exactly one of enum/int/re, got {sorted(spec) or 'nothing'}")
    kind = kinds[0]
    if kind == "enum":
        _require(isinstance(spec["enum"], list) and spec["enum"]
                 and all(isinstance(v, str) for v in spec["enum"]),
                 f"{path}.enum", "must be a non-empty list of strings")
    elif kind == "int":
        bounds = spec["int"]
        _require(isinstance(bounds, list) and len(bounds) == 2
                 and all(isinstance(v, int) and not isinstance(v, bool) for v in bounds)
                 and bounds[0] <= bounds[1],
                 f"{path}.int", "must be [lo, hi] with lo <= hi")
    else:
        _require(isinstance(spec["re"], str), f"{path}.re", "must be a string")
        try:
            re.compile(spec["re"])
        except re.error as exc:
            raise ConfigError(f"{path}.re", f"not a valid regex: {exc}") from None
    return {kind: spec[kind]}


def _load_command(name, raw, path: str) -> Command:
    _check_name(name, f"{path}")
    _require(isinstance(raw, dict), path, "must be an object")

    argv = raw.get("argv")
    _require(isinstance(argv, list) and argv and all(isinstance(a, str) for a in argv),
             f"{path}.argv", "must be a non-empty list of strings")

    params_raw = raw.get("params", {})
    _require(isinstance(params_raw, dict), f"{path}.params", "must be an object")
    params = {}
    for pname, spec in params_raw.items():
        _require(isinstance(pname, str) and re.fullmatch(r"[a-z][a-z0-9_]*", pname),
                 f"{path}.params", f"bad parameter name {_short(str(pname))}")
        params[pname] = _load_param_spec(spec, f"{path}.params.{pname}")

    # The audit that makes concatenation impossible. Run over every element, not only the ones that
    # happen to look like a placeholder — the failure being caught is exactly an element that
    # *contains* one without *being* one.
    used = set()
    for element in argv:
        for match in UNANCHORED.finditer(element):
            _require(PLACEHOLDER.match(element), f"{path}.argv",
                     f"placeholder {{{match.group(1)}}} must be a whole argv element, "
                     f"got {_short(element)}")
            used.add(match.group(1))
    unknown = used - set(params)
    _require(not unknown, f"{path}.argv", f"placeholders with no params entry: {sorted(unknown)}")
    unused = set(params) - used
    _require(not unused, f"{path}.params", f"declared but never used in argv: {sorted(unused)}")

    binary = argv[0]
    _require(shutil.which(binary) or os.access(resolve(binary), os.X_OK), f"{path}.argv",
             f"binary not found or not executable: {binary}")

    tier = raw.get("tier", "R")
    _require(tier in ("R", "W"), f"{path}.tier", f"must be 'R' or 'W', got {_short(str(tier))}")
    timeout = raw.get("timeout", 60)
    _require(isinstance(timeout, int) and not isinstance(timeout, bool) and 1 <= timeout <= 3600,
             f"{path}.timeout", "must be an int in 1..3600")

    cwd = raw.get("cwd")
    _require(cwd is None or isinstance(cwd, str), f"{path}.cwd", "must be a string")

    return Command(name=name, argv=list(argv), params=params,
                   cwd=resolve(cwd) if cwd else None, timeout=timeout, tier=tier,
                   stream=bool(raw.get("stream", False)))


def _load_health(raw, path: str) -> dict:
    _require(isinstance(raw, dict), path, "must be an object")
    present = [k for k in PROBES if k in raw]
    _require(len(present) == 1, path,
             f"needs exactly one of {'/'.join(PROBES)}, got {sorted(raw) or 'nothing'}")
    kind = present[0]
    value = raw[kind]
    if kind == "tcp":
        _require(isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65535,
                 f"{path}.tcp", "must be a port in 1..65535")
    elif kind == "pgrep":
        _require(isinstance(value, str) and value, f"{path}.pgrep", "must be a non-empty string")
    elif kind == "http":
        _require(isinstance(value, str) and value.startswith(("http://", "https://")),
                 f"{path}.http", "must be an http:// or https:// URL")
    else:
        _require(value is True, f"{path}.unit", "must be true")
    return {kind: value}


def _load_service(name, raw, path: str) -> Service:
    _check_name(name, path)
    _require(isinstance(raw, dict), path, "must be an object")

    start = raw.get("start", [])
    unit = raw.get("unit")
    _require(isinstance(start, list) and all(isinstance(a, str) for a in start),
             f"{path}.start", "must be a list of strings")
    if unit is not None:
        _require(isinstance(unit, dict) and all(isinstance(v, str) for v in unit.values()),
                 f"{path}.unit", "must be an object of platform -> unit name")
    # Neither is legal: a monitor-only entry. `cloudflared` is the case that needs it — start.sh
    # owns its lifecycle, but /health still has to be able to say whether it is up.

    env = raw.get("env", {})
    _require(isinstance(env, dict) and all(isinstance(k, str) and isinstance(v, str)
                                           for k, v in env.items()),
             f"{path}.env", "must be an object of string -> string")

    root = raw.get("root")
    _require(root is None or isinstance(root, str), f"{path}.root", "must be a string")
    log = raw.get("log")
    _require(log is None or isinstance(log, str), f"{path}.log", "must be a string")

    return Service(
        name=name,
        start=[resolve(start[0])] + list(start[1:]) if start else [],
        root=resolve(root) if root else str(REPO_ROOT),
        health=_load_health(raw.get("health", {}), f"{path}.health"),
        env=dict(env),
        unit=dict(unit) if unit else None,
        log=resolve(log) if log else None,
        stream=bool(raw.get("stream", False)),
    )


def load(path: str | None = None) -> OpsConfig:
    """Read and fully validate the registry. Raises ConfigError; never returns a partial config."""
    path = os.path.expanduser(path or os.environ.get("HERDR_OPS_CONFIG") or DEFAULT_CONFIG)
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
    except FileNotFoundError:
        raise ConfigError(path, "not found — copy relay/ops.example.json there") from None
    except json.JSONDecodeError as exc:
        raise ConfigError(path, f"not valid JSON: {exc}") from None
    _require(isinstance(raw, dict), path, "top level must be an object")

    chat_raw = raw.get("chat_ids", [])
    _require(isinstance(chat_raw, list)
             and all(isinstance(c, int) and not isinstance(c, bool) for c in chat_raw),
             "chat_ids", "must be a list of integers")

    services_raw = raw.get("services", {})
    _require(isinstance(services_raw, dict), "services", "must be an object")
    services = {name: _load_service(name, entry, f"services.{name}")
                for name, entry in services_raw.items()}

    commands_raw = raw.get("commands", {})
    _require(isinstance(commands_raw, dict), "commands", "must be an object")
    commands = {name: _load_command(name, entry, f"commands.{name}")
                for name, entry in commands_raw.items()}

    limits = dict(DEFAULT_LIMITS)
    limits_raw = raw.get("limits", {})
    _require(isinstance(limits_raw, dict), "limits", "must be an object")
    for key, value in limits_raw.items():
        _require(key in DEFAULT_LIMITS, "limits", f"unknown limit {_short(str(key))}")
        _require(isinstance(value, int) and not isinstance(value, bool) and value > 0,
                 f"limits.{key}", "must be a positive integer")
        limits[key] = value

    return OpsConfig(chat_ids=set(chat_raw), services=services, commands=commands,
                     limits=limits, path=path)


# --- The boundary ---

def validate_param(name: str, spec: dict, value: str) -> str:
    """Check one user-supplied argument against its declared spec. Raises ValueError to the user.

    The message names the parameter and the constraint. The value itself is only ever echoed back
    `repr`-truncated, so a hostile argument cannot use the error path to get its own text rendered.
    """
    if len(value) > MAX_PARAM_LEN:
        raise ValueError(f"{name}: at most {MAX_PARAM_LEN} characters")
    if "enum" in spec:
        if value not in spec["enum"]:
            raise ValueError(f"{name}: must be one of {', '.join(spec['enum'])}")
    elif "int" in spec:
        low, high = spec["int"]
        if not value.lstrip("-").isdigit() or not low <= int(value) <= high:
            raise ValueError(f"{name}: must be a whole number in {low}..{high}")
    else:
        if not re.fullmatch(spec["re"], value):
            raise ValueError(f"{name}: must match {spec['re']}")
    return value


def build_argv(cmd: Command, args: list[str]) -> list[str]:
    """Bind user arguments to the template. The only path from a Telegram message to a process.

    Substitution replaces whole list elements. Nothing here formats, concatenates, or joins — so a
    parameter cannot become two arguments, an option, or anything a shell would see. There is no
    shell: the result goes to subprocess with shell=False.
    """
    names = list(cmd.params)
    if len(args) != len(names):
        raise ValueError(f"{cmd.name} takes {len(names)} parameter(s) "
                         f"({', '.join(names) or 'none'}); got {len(args)}")
    bound = {}
    for name, value in zip(names, args):
        spec = cmd.params[name]
        checked = validate_param(name, spec, value)
        # `~` is expanded only for enum parameters. There is no shell to do it, and an enum value
        # was authored in the config — so expanding it honours what the config meant. A `re` or
        # `int` parameter is user text and is passed through byte for byte.
        bound[name] = os.path.expanduser(checked) if "enum" in spec else checked
    out = []
    for element in cmd.argv:
        match = PLACEHOLDER.match(element)
        out.append(bound[match.group(1)] if match else element)
    out[0] = resolve(out[0]) if os.sep in out[0] else out[0]
    return out
