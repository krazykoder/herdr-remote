# herdr-ops — setup and first run

Operator instructions for `relay/herdr_ops.py`: a second Telegram bot that controls this machine's
services and a fixed allowlist of CLI utilities, with **no relay connection**, so it still answers
when the relay or the tunnel is down.

Design: [proposal](../.workflow/02_architecture/2026-08-18_telegram_ops_server_proposal.md) ·
[spec](../.workflow/03_specs/2026-08-18_telegram_ops_spec.md) ·
[deferred work](../.workflow/03_specs/2026-08-18_telegram_ops_deferred.md)

> **Status: setup and the read-only commands confirmed working against a real bot (2026-08-18).**
> Not yet exercised end to end: `/relay_restart` against a live tunnel, and `/tail` over a long
> stream. §6 is that test.

Run from a checkout that has this branch — `main`'s `start.sh` does not record `tunnel.url`, which
is what `/relay_url` reads.

```bash
cd /Users/towshif/code/python/herdr-remote     # on feat/telegram-ops
```

---

# The short way

Get a token from `@BotFather` (§1 below, one minute), then:

```bash
./relay/ops-setup.sh
```

It validates the token against Telegram rather than a regex, refuses the agent bot's token (the
`409 Conflict` mistake), finds your chat id by watching for the message you send the bot, writes an
`ops.json` whose ports match what this machine actually runs, saves the token to `secrets.env` at
mode 0600, and validates the result. Re-running it is safe: an existing registry is backed up, and
`[k]` updates only the chat id, leaving your command allowlist alone.

Then start the bot by hand — there is no service unit, by choice
([deferred](../.workflow/03_specs/2026-08-18_telegram_ops_deferred.md) item 1):

```bash
set -a; source ~/.config/herdr-remote/config.env; source ~/.config/herdr-remote/secrets.env; set +a
uv run relay/herdr_ops.py
```

Skip to [§5 Verify](#5-verify). The sections below are the same thing done by hand — read them if
the script fails, or to know what it wrote.

---

# The long way

## 1. Create the bot

It must be a **second** bot, not the one `herdr_telegram.py` uses. Two processes long-polling one
token get `409 Conflict: terminated by other getUpdates request`, and machine control does not
belong in the chat where agents are approved.

In Telegram, message `@BotFather`:

1. `/newbot`
2. A display name — `herdr ops`
3. A username ending in `bot` — `yourname_herdr_ops_bot`

It replies with a token shaped `8123456789:AA…`. Treat it as a credential: it is full control of
the bot.

Use a **private one-on-one chat**, never a group. `/relay_url` prints a link containing
`HERDR_RELAY_TOKEN`.

## 2. Install the registry

`ops.json` is the whole permission model: the services the bot may start and probe, and the argv
templates it may run. It lives outside the repo because it names executable binaries.

The version below is tailored to this machine — LAN listener on **8375**, external listener and
tunnel on **8377** (from `~/.config/herdr-remote/config.env`). The shipped
`relay/ops.example.json` uses 8375 for both and would report your tunnel as down.

```bash
cat > ~/.config/herdr-remote/ops.json <<'JSON'
{
  "chat_ids": [],

  "services": {
    "relay": {
      "start": ["relay/start.sh"],
      "root": "~/code/python/herdr-remote",
      "health": { "tcp": 8375 },
      "log": "~/Library/Logs/herdr-remote/relay.log",
      "stream": true
    },
    "tunnel": {
      "health": { "pgrep": "cloudflared .*--url http://127.0.0.1:8377" }
    }
  },

  "commands": {
    "df": { "argv": ["df", "-h"], "tier": "R" },
    "uptime": { "argv": ["uptime"], "tier": "R" },
    "ports": { "argv": ["lsof", "-nP", "-iTCP:8375,8377", "-sTCP:LISTEN"], "tier": "R" },
    "git-log": {
      "argv": ["git", "-C", "{repo}", "log", "--oneline", "-n", "{n}"],
      "params": {
        "repo": { "enum": ["~/code/python/herdr-remote"] },
        "n": { "int": [1, 50] }
      },
      "tier": "R"
    },
    "git-status": {
      "argv": ["git", "-C", "{repo}", "status", "--short", "--branch"],
      "params": { "repo": { "enum": ["~/code/python/herdr-remote"] } },
      "tier": "R"
    }
  },

  "limits": { "stream_seconds": 600, "stream_bytes": 262144, "rate_per_min": 20 }
}
JSON

uv run relay/herdr_ops.py --check
```

Expected:

```
ok: /Users/towshif/.config/herdr-remote/ops.json — 2 service(s), 5 command(s), 0 allowlisted chat(s)
warning: no chat_ids — every command would be refused
```

`--check` validates and exits. It needs no bot token, so config errors are diagnosable on their own.

## 3. Find your chat id

The allowlist is empty, so every command is refused — except `/whoami`, whose entire job is to tell
a new chat its id. Start the bot:

```bash
HERDR_OPS_TG_TOKEN="<token from BotFather>" uv run relay/herdr_ops.py
```

Send your bot `/whoami`. It replies with a number. Ctrl-C the bot, and put that number in the
config:

```jsonc
"chat_ids": [123456789],
```

Re-run `--check`; it should now say `1 allowlisted chat(s)` and drop the warning.

## 4. Run it

```bash
set -a
source ~/.config/herdr-remote/config.env
source ~/.config/herdr-remote/secrets.env
set +a

HERDR_OPS_TG_TOKEN="<token>" uv run relay/herdr_ops.py
```

Sourcing `secrets.env` is what puts `HERDR_RELAY_TOKEN` in the bot's environment — not for the
link, which never carries it, but so `scrub()` can recognise the token and redact it out of any log
line or command output on its way to Telegram.

## 5. Verify

In order. Each row is pass/fail.

| Send | Expect |
|---|---|
| Type `/` in the chat | The native menu: `/health`, `/svc`, `/relay`… **and your registry entries** as real commands — `/df`, `/git_log`. Autocomplete, no typing |
| `/help` | The command list, generated from *your* registry |
| `/df` | Same as `/run df`. Registry entries are commands in their own right |
| `/whoami` | Your id, `allowlisted` |
| `/health` | `up   relay      tcp 8375 open`, a tunnel line, disk free, load average |
| `/relay_url` | `No tunnel URL recorded` until a restart under the new `start.sh` (§6). After one: a card with the `wss://` address as tap-to-copy text and an **Open in the app** link — no token in it |
| `/run uptime` | Load averages, `[exit 0]` |
| `/git_log ~/code/python/herdr-remote 5` | Five commits — the hyphen in `git-log` becomes an underscore, because Telegram command names cannot contain one |
| `/run git-log ~/code/python/herdr-remote 5` | The same thing, the long way |
| `/run git-log /etc 5` | `repo: must be one of ~/code/python/herdr-remote` |
| `/run git-log ~/code/python/herdr-remote 500` | `n: must be a whole number in 1..50` |
| `/run rm -rf ~` | `'rm' is not in the allowlist.` |
| `/ps` | `Nothing started by ops is running.` — correct until §6 |
| `/logs relay 20` | Last 20 lines, or `log not found` if ops has not started the relay yet |
| `/tail relay` then `/stop` | A message that updates every 3s, ending `— ended: /stop` |
| Message the bot from another Telegram account | `Not authorized. This chat id is …`, nothing runs |

## 6. The real test — restart from the phone

This is the feature. Two things to know **before** pressing Confirm:

- **The current relay is not owned by ops.** It was started from a terminal, so ops has no state
  file for it. The first `/relay_restart` takes ownership: `start.sh`'s own `reclaim_relay_port`
  stops the previous relay and `stop_stale_tunnel` stops the previous `cloudflared`. Your existing
  tunnel URL dies and the terminal running it exits. That is the designed path, not a surprise —
  but do it when you are not mid-session on the phone.
- **`tunnel.url` needs this branch.** `/relay_restart` runs `start.sh` out of the `root` in
  `ops.json` — whatever branch that checkout happens to be on. On `main` the restart succeeds and
  the reply then says `No tunnel URL recorded`, because only this branch's `start.sh` writes the
  file. Check before you press Confirm:

  ```bash
  git -C ~/code/python/herdr-remote branch --show-current
  ```

Then, from Telegram:

```
/relay_restart      → Confirm
```

Expect, within ~30s: `relay stopped (SIGTERM).`, `relay started (pid N).`, `health: tcp 8375 open`,
then a card with a **new** `wss://` hostname and an **Open in the app** link. Tap it on the phone —
the app should connect. The link carries no token: the phone already stored one on first setup, and
only the hostname rotates. A phone that has never connected still needs the token entered once.

Then confirm the process-group behaviour, which is the part a pid-only kill would get wrong:

```
/svc stop relay     → Confirm
```

On the machine, `pgrep -f cloudflared` must come back **empty**. The tunnel is not named anywhere in
the stop path; it dies because the signal goes to the process group and `start.sh`'s `trap cleanup`
runs.

Finally, restart the *bot* while the relay is running (Ctrl-C, start it again) and send `/ps`. The
same pid must still be listed, and no second relay started — the bot adopts what is running from
`~/.config/herdr-remote/run/`.

---

## Keeping it running

**Started by hand, on purpose.** No launchd plist, no systemd unit — a new user runs
`ops-setup.sh` once and then starts the bot themselves. A terminal or a tmux pane is the supported
way. Detached, if you want the terminal back:

```bash
nohup env HERDR_OPS_TG_TOKEN="<token>" uv run relay/herdr_ops.py \
  >> ~/Library/Logs/herdr-remote/ops.log 2>&1 &
```

The trade-off to know: nothing restarts the bot if it crashes or the machine reboots, so after a
reboot the recovery channel is only there once you start it. Revisit when that actually bites —
[deferred](../.workflow/03_specs/2026-08-18_telegram_ops_deferred.md) item 1.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `409 Conflict` in the log | The same token is polled elsewhere — the other bot, or a second copy of this one |
| Every command answers `Not authorized` | `chat_ids` is empty or holds the wrong id. `/whoami` still works; use it |
| `/health` shows the tunnel `DOWN` while it is up | The `pgrep` pattern does not match the running argv. Check `pgrep -fl cloudflared` and edit the pattern |
| `/relay_restart` says `started but health probe still failing` | `start.sh` exited early — bad relay config. `/logs relay 50` |
| `Config error — …` on boot | The path and the rule are named in the message. `--check` gives the same answer without a token |
| `/run` says `not found or not executable` at boot | A `commands.*.argv[0]` binary is missing on this machine; the registry is validated at load, not at use |
