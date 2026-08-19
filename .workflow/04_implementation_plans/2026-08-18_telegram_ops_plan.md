# Implementation Plan — `herdr-ops` Telegram operations server

**Spec:** `.workflow/03_specs/2026-08-18_telegram_ops_spec.md` (behaviour is defined there; this
plan does not restate it). **Decision:** `decision_log/2026-08-18_telegram_ops_server.md`.
**Branch:** `feat/telegram-ops`.

## Goal

A second Telegram bot process that controls this machine's long-running services and a fixed set of
CLI utilities, with no dependency on the relay, so a dead tunnel or a dead relay can be diagnosed
and fixed from a phone.

---

## File-by-file

| Marker | Path | Size |
|---|---|---|
| `[NEW]` | `relay/ops_config.py` | ~180 L — config load + validation + argv building. Pure, no I/O beyond reading the file. |
| `[NEW]` | `relay/ops_supervisor.py` | ~200 L — process control, state files, health probes. No Telegram. |
| `[NEW]` | `relay/herdr_ops.py` | ~400 L — PTB handlers, streaming, health watcher, entry point. |
| `[NEW]` | `relay/ops.example.json` | ~40 L |
| `[NEW]` | `relay/tg_util.py` | ~40 L — `scrub()`, `chunks()`, `confirm_keyboard()`, `new_token()` |
| `[MODIFY]` | `relay/herdr_telegram.py` | `scrub()` body delegates to `tg_util.scrub`. Nothing else. |
| `[MODIFY]` | `relay/start.sh` | Persist / remove `$CONFIG_DIR/tunnel.url`. ~6 lines. |
| `[MODIFY]` | `relay/requirements.txt` | No change expected — PTB is already there for `herdr_telegram.py`. Verify. |
| `[NEW]` | `tests/test_ops_allowlist.py` | Spec §10. |
| `[MODIFY]` | `CLAUDE.md` | New component row, new env vars, run command. |
| `[MODIFY]` | `README.md` | Setup section for the second bot, if the file documents the first. |

**Deferred, not in this plan:** the `com.herdr-remote.ops` launchd/systemd unit in
`install-service.sh`. Ship the bot runnable by hand first; supervising it is a separate, testable
change. Track it as the follow-up.

---

## 1. `relay/ops_config.py` [NEW]

Three dataclasses and two functions. Everything the spec's §2 validation table says, raising
`ConfigError(path, message)` where `path` is dotted (`services.relay.health`).

```python
@dataclass(frozen=True)
class Command:
    name: str; argv: list[str]; params: dict[str, dict]
    cwd: str | None; timeout: int; tier: str; stream: bool

@dataclass(frozen=True)
class Service:
    name: str; start: list[str]; root: str; env: dict[str, str]
    unit: dict[str, str] | None; health: dict; log: str | None; stream: bool

@dataclass(frozen=True)
class OpsConfig:
    chat_ids: set[int]; services: dict[str, Service]
    commands: dict[str, Command]; limits: dict[str, int]

def load(path: str) -> OpsConfig: ...
def build_argv(cmd: Command, args: list[str]) -> list[str]: ...   # raises ValueError with the
                                                                  # user-facing message
```

`build_argv` is the security boundary. Exact shape required:

```python
PLACEHOLDER = re.compile(r"^\{([a-z][a-z0-9_]*)\}$")   # whole element only, anchored

def build_argv(cmd, args):
    names = list(cmd.params)                       # declaration order
    if len(args) != len(names):
        raise ValueError(f"{cmd.name} takes {len(names)} parameter(s) "
                         f"({', '.join(names)}); got {len(args)}")
    bound = {n: _validate(cmd, n, v) for n, v in zip(names, args)}
    out = []
    for element in cmd.argv:
        m = PLACEHOLDER.match(element)
        out.append(bound[m.group(1)] if m else element)   # never str.format, never % , never +
    return out
```

`_validate` dispatches on the single key of the param spec:

```python
if "enum" in spec:  value in spec["enum"]                       else reject naming the choices
if "int"  in spec:  value.lstrip("-").isdigit() and lo <= int(value) <= hi   else reject with range
if "re"   in spec:  len(value) <= 128 and re.fullmatch(spec["re"], value)    else reject
```

Rejection text names the parameter and the constraint and **quotes nothing back** beyond a
`repr()`-truncated 32 chars.

Load-time placeholder audit (spec §2, the rule that makes concatenation impossible):

```python
for element in argv:
    for m in re.finditer(r"\{([a-z][a-z0-9_]*)\}", element):
        if not PLACEHOLDER.match(element):
            raise ConfigError(f"commands.{name}.argv",
                              f"placeholder {{{m.group(1)}}} must be a whole argv element, "
                              f"got {element!r}")
        used.add(m.group(1))
```

`shutil.which(argv[0]) or os.access(expanded, os.X_OK)` — otherwise `ConfigError` naming the binary.

## 2. `relay/ops_supervisor.py` [NEW]

No Telegram imports. Functions, not a class — there is one registry per process.

```python
def state_path(name) -> Path                      # $HERDR_OPS_STATE_DIR or ~/.config/herdr-remote/run
def read_state(name) -> dict | None
def alive(svc, state) -> bool                     # os.kill(pid,0) + identity re-check
def identity_ok(pid, argv) -> bool                # ps -o command= -p PID contains basename(argv[0])
def reconcile(cfg) -> list[str]                   # deletes stale files, returns names cleared
def start(svc) -> dict                            # spec §4.1, start_new_session=True
def stop(svc) -> str                              # spec §4.2, killpg TERM -> KILL, returns outcome
def restart(svc) -> str                           # spec §4.4
def probe(svc) -> tuple[bool, str]                # spec §4.3 table, (ok, human reason)
def uptime(state) -> str
```

Non-negotiables, called out because they are the parts that go wrong:

- `start`: `stdin=DEVNULL`, log opened `"ab"`, `stderr=STDOUT`, `start_new_session=True`, state file
  written **before** returning.
- `stop`: `identity_ok` **before** any signal. `os.killpg(pgid, …)`, never `os.kill(pid, …)` —
  signalling the pid alone leaves `cloudflared` orphaned, which is the bug this design exists to
  avoid.
- `probe` never raises; it returns `(False, reason)` on any exception.

## 3. `relay/herdr_ops.py` [NEW]

Structure mirrors `herdr_telegram.py` so the two read alike: module docstring, PEP 723 header,
env constants, `scrub` wrapper, handlers, `main()` with `add_handler` calls, `if __name__`.

```python
# /// script
# requires-python = ">=3.10"
# dependencies = ["python-telegram-bot>=21.0"]
# ///
```

- Constants: `TOKEN = os.environ["HERDR_OPS_TG_TOKEN"]`, `CONFIG_PATH`, allowlist = config
  `chat_ids` ∪ `HERDR_OPS_TG_CHAT_ID`.
- `logging.getLogger("httpx").setLevel(WARNING)` — the URL contains the token.
- One `asyncio.Lock` per service, in a dict, for spec §9's concurrent-restart row.
- `Stream` class: `start_file_tail(path)` / `start_process(argv, …)`, a 3 s edit loop, byte/time
  caps, `stop(reason)`. One instance per chat in a dict.
- Confirmations: `dict[token] = (callback, expires_at)`, `secrets.token_hex(8)`, popped on use.
- `health_watcher()` — `asyncio.create_task` from `main()`, 60 s, transition-only alerts.
- Every reply goes through `send(chat, text)` which applies `scrub` then `chunks`.

Handler registration, all behind `filters.Chat(chat_id=…)` when the allowlist is non-empty:

```
start help whoami health svc relay logs tail run stop ps  +  CallbackQueryHandler
```

`/svc` and `/relay` take a subcommand as `ctx.args[0]`; do not register nine separate handlers.

## 4. `relay/ops.example.json` [NEW]

Exactly the spec §2 shape. Ships `relay` (tcp 8375) and `tunnel` (pgrep on the argv `start.sh`
actually uses) as services; a `tests` service with `stream: true`; and `df`, `git-log`, `uptime` as
commands. A comment header saying this file is an example and the live one lives in
`~/.config/herdr-remote/ops.json`.

## 5. `relay/tg_util.py` [NEW] + `relay/herdr_telegram.py` [MODIFY]

```python
def scrub(value, *secrets) -> str:
    s = str(value)
    for secret in secrets:
        if secret:
            s = s.replace(secret, "<redacted>")
    return s
```

`herdr_telegram.py`'s existing `scrub` keeps its name, signature, docstring and module-level
secrets; only its body becomes `return tg_util.scrub(value, _RELAY_TOKEN, TOKEN)`. **No other change
to that file** — it is working, and this is a shared-security-code move, not a refactor.

## 6. `relay/start.sh` [MODIFY]

Two edits. In `cleanup()`, next to the existing kills:

```bash
rm -f "$CONFIG_DIR/tunnel.url"
```

In the temp-tunnel branch, immediately after `WSS_URL="${TUNNEL_URL/https:\/\//wss://}"`:

```bash
# The ops bot answers /relay url out of this file. A temp tunnel mints a new hostname on every
# start, so the phone's stored URL is dead until someone reads the new one — this is how it gets
# read without walking to the machine.
mkdir -p "$CONFIG_DIR" && printf '%s\n' "$TUNNEL_URL" > "$CONFIG_DIR/tunnel.url"
```

Nothing else in that script moves. The webhook POST and the printed link stay exactly as they are.

## 7. `tests/test_ops_allowlist.py` [NEW]

`unittest`, `sys.path.insert(0, ROOT / "relay")` like `tests/test_slot_exec.py`. Cases are spec §10,
one test method each, config built as a dict written to a `tempfile` so `load()` is exercised for
real. No PTB import, no network, no process spawning except the `reconcile` case which uses
`os.getpid()`.

---

## Verification

```bash
source .venv313/bin/activate

# 1. New tests, then the whole suite — nothing else may move.
.venv313/bin/python -m unittest discover -s tests -t tests

# 2. The bot boots, validates, and exits 1 on a bad config.
HERDR_OPS_TG_TOKEN=x HERDR_OPS_CONFIG=relay/ops.example.json uv run relay/herdr_ops.py --check
echo '{"services":{"a":{"start":["/bin/sh"],"health":{"tcp":1,"pgrep":"x"}}}}' > /tmp/bad.json
HERDR_OPS_TG_TOKEN=x HERDR_OPS_CONFIG=/tmp/bad.json uv run relay/herdr_ops.py --check ; echo "exit=$?"
# expect: exit=1, message names services.a.health

# 3. The relay bot is untouched by the scrub move.
.venv313/bin/python -m unittest discover -s tests -t tests -p 'test_telegram.py'

# 4. start.sh still starts, and now records the URL.
relay/start.sh   # in another shell: cat ~/.config/herdr-remote/tunnel.url
```

`--check` is a flag on `herdr_ops.py` that loads the config, prints a one-line summary, and exits —
so config errors are diagnosable without a bot token that works.

### Manual E2E — the reason this exists

Run against a real bot and a real chat. Each step is a pass/fail:

1. `/health` with everything up → every service `up`, tunnel URL present and reachable.
2. Kill the relay by hand (`pkill -f herdr_relay.py`). Within 60 s the ops chat receives
   `⚠️ relay is down`. `/health` agrees.
3. `/relay restart` → Confirm → relay up, and the reply carries a **new** `wss://` URL and an
   `Open:` link that actually opens the app on the phone. This is the acceptance test for the whole
   feature.
4. `/tail relay` → live log; `/stop` ends it with `— ended: /stop`.
5. `/run git-log ~/code/python/herdr-remote 5` → five commits. `/run git-log /etc 5` → rejected by
   the `enum`. `/run rm -rf ~` → `'rm' is not in the allowlist.`
6. `/svc stop relay` → confirm → **both** the relay and `cloudflared` are gone (`pgrep -f
   cloudflared` empty). This is the process-group behaviour; a pid-only kill fails here.
7. Restart the ops bot while the relay runs → `/svc` still shows the relay up with the same pid, and
   no second relay was started.
8. Message the bot from a non-allowlisted account → refusal naming that chat's id, and nothing runs.

---

## Acceptance criteria

- [ ] `grep -c websockets relay/herdr_ops.py` is `0`. The ops bot never talks to the relay.
- [ ] `grep -n 'shell=True' relay/ops_*.py relay/herdr_ops.py` finds nothing.
- [ ] An empty `chat_ids` with no `HERDR_OPS_TG_CHAT_ID` refuses every command, `/help` included.
- [ ] A placeholder that is not a whole argv element fails at config load, not at run time.
- [ ] `stop` sends to the process group and is preceded by the pid identity re-check.
- [ ] Restarting the bot adopts running services; it never double-starts and never orphans.
- [ ] `/relay restart` returns a working `wss://` link and app deep link.
- [ ] Full `unittest discover` suite green; `test_telegram.py` unchanged in behaviour.
- [ ] `CLAUDE.md` documents `relay/herdr_ops.py`, `HERDR_OPS_TG_TOKEN`, `HERDR_OPS_TG_CHAT_ID`,
      `HERDR_OPS_CONFIG`, and the run command.

## Follow-ups (not this plan)

1. `com.herdr-remote.ops` unit in `install-service.sh` with `KeepAlive`.
2. Opt-in auto-restart in the health watcher, with a backoff and a cap.
3. `unit` backend exercised for real, once a launchd unit exists to exercise it against.
