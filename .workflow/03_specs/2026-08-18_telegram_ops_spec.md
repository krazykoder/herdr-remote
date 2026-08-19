# Spec — `herdr-ops` Telegram operations server

Obeys `.workflow/02_architecture/2026-08-18_telegram_ops_server_proposal.md` and
`decision_log/2026-08-18_telegram_ops_server.md`. Behaviour only; the plan owns file layout.

---

## 1. Process

| Item | Value |
|---|---|
| Entry point | `relay/herdr_ops.py`, PEP 723 header, `python-telegram-bot>=21` |
| Transport | Telegram long polling (`Application.updater.start_polling`). No listener, no inbound socket. |
| Relay coupling | **None.** The string `websockets` must not appear in the module. |
| Config | `HERDR_OPS_CONFIG`, default `~/.config/herdr-remote/ops.json` |
| Runtime state | `~/.config/herdr-remote/run/<service>.json` |
| Logs of managed services | Wherever the registry entry's `log` says; the bot only reads them |

### Boot sequence

1. Load config. Any schema error → **print the error and exit 1**. A partially valid registry is
   never used; fail-closed matches the relay's own behaviour on bad config.
2. Reconcile `run/*.json` against reality (§4.3) before the first update is served.
3. Start polling. Start the health watcher (§6).

Missing `HERDR_OPS_TG_TOKEN` → exit 1 with `Set HERDR_OPS_TG_TOKEN (from @BotFather)`.

---

## 2. Config contract (`ops.json`)

```jsonc
{
  "chat_ids": [123456789],
  "services": {
    "relay": {
      "start":  ["relay/start.sh"],
      "root":   "~/code/python/herdr-remote",
      "env":    { "HERDR_TUNNEL_MODE": "temp" },
      "unit":   { "macos": "gui/501/com.herdr-remote.relay", "linux": "herdr-relay.service" },
      "health": { "tcp": 8375 },
      "log":    "~/Library/Logs/herdr-remote/relay.log",
      "stream": true
    }
  },
  "commands": {
    "git-log": {
      "argv":   ["git", "-C", "{repo}", "log", "--oneline", "-n", "{n}"],
      "params": { "repo": { "enum": ["~/code/python/herdr-remote"] },
                  "n":    { "int": [1, 50] } },
      "tier":   "R",
      "timeout": 60
    }
  },
  "limits": { "stream_seconds": 600, "stream_bytes": 262144, "rate_per_min": 20 }
}
```

### Validation, at load time

| Rule | Violation |
|---|---|
| `chat_ids` is a list of ints. May be empty. | type error → exit 1 |
| Service `start` is a list of strings. Neither `start` nor `unit` is legal — a **monitor-only** entry, visible to `/health` and not startable. `cloudflared` is exactly that: `start.sh` owns its lifecycle. | error only on a malformed list |
| `health` has exactly one of `tcp` (int 1–65535), `pgrep` (string), `http` (http/https URL), `unit` (bool true). | error |
| Command `argv` non-empty; `argv[0]` resolves via `shutil.which` or is an existing executable path. | error naming the binary |
| Every `{name}` placeholder **is an entire argv element**. `"-C{repo}"` and `"{a}{b}"` are rejected. | error |
| Every placeholder has an entry in `params`; every `params` entry is used. | error |
| Each param spec has exactly one of `enum` (list of strings), `int` (`[lo, hi]`), `re` (pattern). | error |
| `tier` ∈ `{"R","W"}`, default `"R"`. `timeout` int 1–3600, default 60. | error |
| Service and command names match `^[a-z0-9][a-z0-9_-]{0,31}$`. | error |

`~` expands; relative `root`/`cwd`/`log` resolve against the repo root containing `herdr_ops.py`.

---

## 3. Authorization

- **Allowlist is `chat_ids` ∪ (`HERDR_OPS_TG_CHAT_ID` if set).**
- Empty allowlist → **every command is refused**, including `/help`, with:
  `Not authorized. This chat id is <id>. Add it to chat_ids in ops.json and restart.`
  There is no discovery mode. (Differs deliberately from `herdr_telegram.py`.)
- Unauthorized chat → the same refusal, and a `log.warning`.
- **One check, in one place.** `filters.Chat(chat_id=…)` was considered as a second layer and
  dropped: it makes an unauthorized chat get silence, which contradicts the refusal text above and
  would hide `/whoami` — the command whose whole job is to tell a new chat its id. Every handler
  calls the same `guard()` first, and the callback handler re-checks before redeeming a token.
- **Rate limit**: token bucket, `limits.rate_per_min` per chat. Over budget → `Rate limited, try
  again in Ns.` W-tier confirmations count against it too.

---

## 4. Service control

### 4.1 Start

`subprocess.Popen(argv, cwd=root, env={**os.environ, **entry.env}, stdin=DEVNULL,
stdout=<log fd, append>, stderr=STDOUT, start_new_session=True)`.

- `start_new_session=True` is the whole point: the child leads its own process group and session,
  so it outlives the bot and is not killed when the bot restarts.
- Write `run/<name>.json` = `{pid, pgid, argv, started_at, log}` **before replying**.
- Already running (§4.3 says alive) → `relay is already running (pid N, up 4m).` No second start.
- Binary missing / `Popen` raises → report the exception text, scrubbed, and write no state file.

### 4.2 Stop

1. Re-read `run/<name>.json`. No file, or §4.3 says dead → `relay is not running.`
2. **Identity re-check**: `ps -o command= -p <pid>` must still contain `argv[0]`'s basename.
   Mismatch → refuse: `pid N is no longer <name> (pid reuse). Cleared stale state.` and delete the
   file. Never signal on a mismatch.
3. `os.killpg(pgid, SIGTERM)` — the **group**, so `start.sh`'s `trap cleanup INT TERM EXIT` runs and
   takes `cloudflared` with it.
4. Poll every 250 ms up to 20 s for the group to be gone.
5. Still alive → `os.killpg(pgid, SIGKILL)`, poll 3 s more. Report which signal ended it.
6. Delete the state file.

### 4.3 Liveness and reconciliation

A service is **alive** iff its state file exists, `os.kill(pid, 0)` succeeds, and the identity
re-check of §4.2.2 passes. Liveness first **reaps** that pid (`Popen.poll`, falling back to
`waitpid(pid, WNOHANG)` for a service adopted across a bot restart): a service is our direct child
even though it leads its own session, and an unreaped zombie still answers `kill(pid, 0)` — so
without the reap the bot reports a dead service as running. The reap is targeted at one pid, never
`waitpid(-1)`, which would steal exit statuses from the `subprocess.run` calls the probes use. It
happens **after** the group-liveness check, not before: a group whose only member is an unreaped
zombie leader already answers `ESRCH`, so reaping first can leave the child unwaited forever. On boot and before every status read, a state file failing that is
deleted (adopting what is real rather than starting a duplicate).

Liveness is about *our process*; the **health probe** is about the service working:

| Probe | Pass condition | Timeout |
|---|---|---|
| `tcp` | `socket.create_connection(("127.0.0.1", port))` succeeds | 1 s |
| `pgrep` | `pgrep -f <pattern>` exits 0 | 2 s |
| `http` | GET returns status < 500 | 3 s |
| `unit` | `launchctl print <label>` / `systemctl --user is-active` reports running | 3 s |

`/svc status` reports both, because "our pid is gone but the port answers" and "pid alive but port
dead" are different problems and both happen.

### 4.4 Restart

Stop (tolerating "not running"), wait for the health probe to go *down* (max 10 s), start, then
poll the health probe up to 30 s for *up*. Reply names the outcome: `up`, or `started but health
probe still failing after 30s — /logs relay`.

### 4.5 `unit` backend

Present in the registry → `/svc start|stop|restart` uses `launchctl kickstart -k` /
`systemctl --user restart` instead of §4.1–4.2, and liveness comes from the unit. Everything else is
unchanged. Absent → detached `start.sh` path, which is the default and the tested one.

---

## 5. Commands

`R` runs immediately. `W` posts **Confirm / Cancel** inline buttons; `callback_data` carries a
16-hex single-use token expiring in 60 s. Expired or reused → `That confirmation expired.`

| Command | Tier | Reply |
|---|---|---|
| `/start`, `/help` | R | Commands generated from the registry, so it lists what *this* install allows. |
| `/whoami` | R | Chat id, allowlist status. Works even when unauthorized (it is the refusal text). |
| `/health` | R | One block: per-service liveness + probe, tunnel URL and reachability, disk free on `/`, load average, host uptime. |
| `/svc` | R | Table of services: name, up/down, pid, uptime. |
| `/svc status <name>` | R | Liveness, probe result, pid/pgid/uptime, argv, last 5 log lines. |
| `/svc start <name>` | W | §4.1 |
| `/svc stop <name>` | W | §4.2 |
| `/svc restart <name>` | W | §4.4 |
| `/relay_restart` | W | `/svc restart relay`, then §7's link block. **Its own menu item**, placed second so it is reachable in a hurry — a subcommand cannot be one, and this is the command the bot exists for. Still confirms: it is one tap, and it now sits in a scrollable list where a mis-tap drops the tunnel and any session on it. |
| `/relay_url` | R | §7's link block, no restart. Its own menu item for the same reason. |
| `/relay restart` / `/relay url` | W / R | The long form, kept for the docs and for muscle memory. Routes to the two above, and guards **once** — dispatching through their handlers would spend two rate-limit tokens on one command. |
| `/logs <name> [n]` | R | Last *n* lines of the entry's `log`, default 50, max 500. Missing/unreadable file is named as such. |
| `/tail <name>` | R | Live follow of the log (§6). Registry entry must have `stream: true`. |
| `/run <cmd> [args…]` | per entry | §5.1 |
| `/stop` | R | Ends this chat's active stream. Nothing active → `No active stream.` |
| `/ps` | R | Registry-owned processes only: name, pid, pgid, uptime, argv. Never a host process table. |

Unknown service or command name → `unknown service '<x>'. Known: a, b, c.` Never a shell error.

### 5.0 The native command menu

Every command above, **and every registry entry**, is published to Telegram with `setMyCommands`,
so the client offers autocomplete and a `/` button instead of requiring typed text. A registry entry
called `df` becomes `/df`; `/run df` keeps working and is no longer the only way.

- **Names.** Telegram allows `[a-z0-9_]{1,32}`; `ops.json` also allows `-`. A registry name is
  mapped by replacing `-` with `_` (`git-log` → `/git_log`). A name that cannot be mapped, that
  shadows a built-in, or that collides with another entry's mapped name, is **skipped with a
  reason** — reported by `--check`, logged at boot, and listed at the end of `/help`. It stays
  reachable as `/run <name>`.
- **One source.** The menu and the handlers are built from the same `menu_entries()` call. A menu
  entry nothing answers is a worse failure than a missing entry, so the two cannot be derived
  separately.
- **Scope.** Published per allowlisted chat (`BotCommandScopeChat`), and the default scope is
  explicitly cleared. A stranger who finds the bot gets no menu: they would be refused anyway, but
  the list itself describes this machine's controls and is not theirs to read.
- **Cap.** Telegram allows 100 commands per scope; beyond that, entries are skipped with a reason.
- **Failure is not fatal.** If `setMyCommands` fails, the bot logs it and runs on — every command
  still works as typed text; only autocomplete is lost.

### 5.1 `/run`

1. Look up `<cmd>` in `commands`. Absent → `'<cmd>' is not in the allowlist. /help lists what is.`
2. Bind positional args to `params` **in declaration order**. Wrong count → `git-log takes 2
   parameters (repo, n); got 1.`
3. Validate each: `enum` exact match; `int` decimal within `[lo, hi]`; `re` `fullmatch` and ≤128
   chars. Failure names the parameter and the constraint, never echoes the raw value back unescaped.
4. Build argv by whole-element substitution. **`shell=False` always.**
5. `W` tier → confirm first.
6. Run with `cwd`, the entry's `timeout`, output capped at `limits.stream_bytes`. Non-stream entries
   reply with the captured output plus exit status; `stream: true` entries stream (§6).
7. Timeout → kill the process group, reply `timed out after Ns (killed)` with output so far.

---

## 6. Streaming

One active stream per chat; starting a second replaces the first and says so.

- **Editing tail** (default): one message, `editMessageText` at most every 3 s, showing the last 30
  lines, ANSI stripped, HTML-escaped inside `<pre>`. No edit when the content did not change.
- **Chunk append** (`/run` of a `stream: true` command): a new message per 3500 chars.
- Bounded by `limits.stream_seconds`, `limits.stream_bytes`, and process exit. Whichever ends it,
  the final message says which: `— ended: process exited 0 / time limit / byte limit / /stop`.
- File tails start at the current end of file, not the beginning, and survive rotation by reopening
  on inode change.
- Telegram 429 → honour `retry_after`, drop the missed frame, never queue a backlog.

### 6.1 Health watcher

Every 60 s, probe each service. On an **up→down** transition, post to every allowlisted chat:
`⚠️ relay is down (tcp 8375 refused). /svc restart relay`. On **down→up**, post the recovery. No
auto-restart in v1 — the bot reports, the human decides. Transitions only; never a heartbeat.

---

## 7. Tunnel link block

`start.sh` writes `$CONFIG_DIR/tunnel.url` (single line, the `https://` form) whenever it learns
one, and removes it on exit. It is read two ways.

**`/relay_url`, and a successful `/relay_restart`** — an HTML card, so the address can be tapped
to copy and the app can be opened in one tap:

```
Tunnel — reachable, recorded 2m ago
<code>wss://<host>.trycloudflare.com</code>
<a href="https://…/mini/?relay=<enc>">Open in the app</a>
```

**`/health`** — one plain line inside the monospace table, no link: `Tunnel:  wss://…  (reachable)`.

- No file → `No tunnel URL recorded (named mode, or the tunnel is not up).`
- File older than the relay's start time → say it is stale rather than serve a dead hostname.
- Reachability is a `GET https://<host>/` with a 5 s timeout; **any** status < 500 counts,
  including the 404 the API-only external listener answers `/` with.
- **No token in the link.** It used to carry `HERDR_RELAY_TOKEN`, and §8's scrub redacted it on the
  way out — the link arrived broken. Sending it for real is the wrong trade regardless: only the
  hostname rotates, the token is stable and already in the phone's `localStorage`, and `?relay=`
  alone updates the address while leaving the stored token alone (`web/src/settings.js`). So
  nothing in this chat is a credential.
- Markup is only ever composed here, never interpolated from output. The `Html` marker type is the
  single way a caller declares "already escaped"; `send()` routes it to `send_html()` unchunked,
  and everything without it is escaped as before.

---

## 8. Secret handling

`scrub()` runs on **every** outbound message and every log record: bot token, `HERDR_RELAY_TOKEN`,
and any `HERDR_*_TOKEN` in the environment are replaced with `<redacted>`. `logging.getLogger
("httpx").setLevel(WARNING)` — its request URLs contain the bot token. Exception text is scrubbed
before it is sent or logged, never surfaced raw. The one deliberate exception is §7's `Open:` line,
which exists to carry the relay token to an allowlisted chat.

---

## 9. Failure modes

| Situation | Behaviour |
|---|---|
| `ops.json` missing | exit 1, naming the path and pointing at `relay/ops.example.json` |
| `ops.json` invalid | exit 1 with the first error, path-qualified (`services.relay.health`) |
| No Telegram connectivity | PTB retries; nothing else is affected; managed processes keep running |
| Bot restarts while services run | Adopts them via §4.3. Never double-starts, never orphans. |
| `start.sh` exits immediately (bad relay config) | Health probe never comes up; `/svc restart` says so and the reply points at `/logs relay` |
| Log file absent | `/logs` and `/tail` say `no log configured` or `log not found: <path>` |
| Two chats issue conflicting `/svc restart` | A per-service `asyncio.Lock`; the second reply is `relay is already restarting.` |
| Disk full while a service writes its log | Not the bot's problem to fix; `/health` reports disk free so it is visible |

---

## 10. Test surface

`tests/test_ops_allowlist.py` (stdlib `unittest`, no PTB, no network):

1. Placeholder-not-a-whole-element is rejected at load: `["-C{repo}"]`, `["{a}{b}"]`.
2. Unknown / unused params rejected; malformed `health` rejected; bad `tier` rejected.
3. `enum` rejects a near-miss; `int` rejects out-of-range, non-decimal, and `" 5"`; `re` rejects a
   partial match and a 129-char value.
4. `build_argv` substitutes whole elements and never concatenates.
5. Injection attempts survive as inert argv elements: `"; rm -rf ~"`, `"$(id)"`, `"--upload-pack=x"`
   are rejected by their validator, and where a validator allows them they appear as one argv
   element and never reach a shell.
6. Arg count mismatch produces the named error.
7. `reconcile()` deletes a state file whose pid is not running, and keeps one that is (using the
   test's own process with a matching recorded argv).

The stream, PTB handlers, and real process control are covered by the manual E2E in the plan.
