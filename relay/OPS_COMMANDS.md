# herdr-ops — slash command reference

How to put a script behind a Telegram command, and which of Telegram's three UI mechanisms to
reach for. Everything here is `ops.json` — no Python is written to add a command.

Setup lives in [OPS_SETUP.md](OPS_SETUP.md). The behavioural contract is
[the spec](../.workflow/03_specs/2026-08-18_telegram_ops_spec.md) §5. A copyable starting point is
[`ops.example.json`](ops.example.json).

---

## 1. The three mechanisms

Telegram gives three ways to put something in front of a thumb. They are not alternatives — each
solves a different problem, and a well-shaped registry uses all three.

| Mechanism | What the user sees | Use it for | How you get it |
|---|---|---|---|
| **Command menu** (`setMyCommands`) | The `/` autocomplete list | Everything reachable at all. Flat — Telegram has no nested slash commands | Automatic: every registry entry becomes `/name` |
| **Inline keyboard, group** | Tap `/git`, get a column of buttons | Collapsing related entries into one menu row | `"menu": "git"` on each member |
| **Inline keyboard, picker** | Tap a command, get a button per allowed value | Arguments, so a phone never types a path or a number | Automatic when every `params` entry is enumerable |

A fourth exists — a *reply keyboard*, buttons pinned above the text field permanently. Not built:
it costs screen space on every message forever, and the `/` menu already answers "what can I do".
Worth revisiting only if two or three commands turn out to be hit constantly.

### Which one, in practice

- **One-off, no arguments** → nothing to decide. `/uptime` is enough.
- **Three or more related entries** → group them. Five git rows in the `/` list is five rows you
  scroll past to reach `/relay_restart`.
- **Takes a path, a target, a count** → declare it as `enum` or `int` and the picker is free.
- **Takes something open-ended** (a URL, a search string) → `re`, and accept that it gets typed.

---

## 2. Command or service?

The most common mistake. Two different tables, two different lifecycles.

| | `commands` | `services` |
|---|---|---|
| Lifecycle | Runs, finishes, replies | Starts, stays up, is monitored |
| Invoked by | `/name`, `/run name` | `/svc start\|stop\|restart <name>` |
| Timeout | Yes — killed at `timeout` | None; it is supposed to keep running |
| Health | Exit status | A `tcp` / `pgrep` / `http` / `unit` probe, checked every 60 s |
| Down alerts | No | Yes — `⚠️ name is down` to every allowlisted chat |
| Survives a bot restart | N/A | Yes — pid/pgid state is reconciled at boot |

**Rule of thumb:** if you would want to know it *stopped*, it is a service.

A stock downloader that runs for 90 seconds and exits → command. A reverse SSH tunnel that must
stay up → service. A downloader daemon that polls all day → service.

---

## 3. Anatomy of a command entry

```jsonc
"stock-pull": {
  "argv": ["~/bin/stock_pull.sh", "{market}", "{days}"],   // argv[0] must exist and be executable
  "params": {                                              // in argv order — positional
    "market": { "enum": ["nasdaq", "nyse", "tsx"] },
    "days":   { "int": [1, 30] }
  },
  "cwd": "~/data/stocks",        // optional; default is the bot's cwd
  "tier": "W",                   // "R" runs immediately, "W" asks Confirm first
  "timeout": 900,                // seconds, 1..3600, default 60
  "stream": true,                // live output instead of one reply at the end
  "menu": "stocks",              // group it behind /stocks
  "label": "Pull daily bars"     // button text in that group
}
```

Every field except `argv` is optional.

### Anatomy of a service entry

```jsonc
"revssh": {
  "start": ["~/bin/revssh.sh"],                  // argv, run detached in its own session
  "root": "~/bin",                               // cwd for that argv
  "env": { "REMOTE_HOST": "vps.example.com" },   // merged over the bot's environment
  "health": { "pgrep": "ssh -N -R 2222:" },      // exactly one of tcp / pgrep / http / unit
  "log": "~/Library/Logs/revssh.log",            // where /logs and /tail read
  "stream": true                                 // allow /tail on that log
}
```

A service with neither `start` nor `unit` is **monitor-only**: it appears in `/health` and cannot be
started. That is how the tunnel is registered — `start.sh` owns it, the bot only watches.

---

## 4. Parameters

Exactly one of `enum`, `int`, or `re` per parameter. Unvalidated input never reaches argv.

| Kind | Declaration | Validation | Picker |
|---|---|---|---|
| `enum` | `{ "enum": ["a", "b"] }` | Exact match against the list. `~` expanded | Yes — one button per value, up to 8 |
| `int` | `{ "int": [1, 30] }` | Decimal, within bounds | Yes — every value if the range is under 8 wide, otherwise the bounds plus round numbers between |
| `re` | `{ "re": "^https://[\\w./%-]{1,200}$" }` | `fullmatch`, and ≤128 characters | No — a regex is a shape, not a list. Typed |

Rules that are not negotiable:

- **A placeholder is a whole argv element.** `"{repo}"` yes. `"--dir={repo}"` is rejected when the
  config loads, not when the command runs. This is what makes `; rm -rf ~` a single inert argument.
- **`shell=False`, always.** No pipes, no globbing, no `&&`. If a recipe needs those, they belong
  inside your script, where you wrote them on purpose.
- **Positional, in declaration order.** `params` order is argv order.
- **All or nothing on pickers.** One `re` parameter and the whole command is typed, because a wizard
  that stops halfway to ask for typing is worse than never starting.

---

## 5. Recipes

### 5.1 A script with no arguments

The simplest useful thing.

```jsonc
"disk-report": {
  "argv": ["~/bin/disk_report.sh"],
  "tier": "R"
}
```

`/disk_report` runs it, replies with stdout + stderr + exit status.

### 5.2 A long job, watched live

```jsonc
"stock-pull": {
  "argv": ["~/bin/stock_pull.sh", "{market}", "{days}"],
  "params": {
    "market": { "enum": ["nasdaq", "nyse", "tsx"] },
    "days":   { "int": [1, 30] }
  },
  "cwd": "~/data/stocks",
  "tier": "R",
  "timeout": 1800,
  "stream": true
}
```

`/stock_pull` → **nasdaq** → **10** → live output, one message edited every 3 s, `/stop` to stop
watching. Two taps, no typing.

`stream: true` matters for anything over ~30 s: without it the chat shows nothing until the process
exits, and a job that hangs looks identical to a job that is working.

> `/stop` ends the **view**, not the process. A stream that is stopped, times out, or hits the byte
> cap leaves the command running. If you need to kill it, it should be a service.

### 5.3 A daemon you start and stop — reverse SSH

This one is a service, because the question you will ask at 11pm is "is it still up".

```jsonc
"services": {
  "revssh": {
    "start": ["~/bin/revssh.sh"],
    "root": "~/bin",
    "health": { "pgrep": "ssh -N -R 2222:" },
    "log": "~/Library/Logs/revssh.log",
    "stream": true
  }
}
```

`/svc start revssh` (Confirm), `/svc status revssh`, `/tail revssh`, `/svc stop revssh`. It appears
in `/health`, and if it dies you get `⚠️ revssh is down (pgrep: no match)` unprompted.

Two things to get right:

- **The `pgrep` pattern must match the real argv.** Check with `pgrep -fl ssh` while it is up. A
  pattern that never matches reports a healthy service as dead, forever.
- **Your script should `exec` the long-running process**, not background it and exit. The bot
  signals the process *group*, so a wrapper that execs is stopped cleanly along with its child.

### 5.4 Something open-ended — download a link

The case where a picker cannot help, and that is the correct outcome.

```jsonc
"grab": {
  "argv": ["curl", "-fsSL", "--max-time", "120", "-o", "{dest}", "{url}"],
  "params": {
    "dest": { "enum": ["~/Downloads/grab.bin", "/tmp/grab.bin"] },
    "url":  { "re": "^https://[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{1,120}$" }
  },
  "tier": "W",
  "timeout": 150
}
```

`/grab ~/Downloads/grab.bin https://example.com/file.zip` — typed, because the URL could be
anything. Note what the shape of this entry buys:

- The destination is an `enum`, so nothing can be written outside the two paths you named. A `re`
  there would let a typo overwrite something.
- `https` only, and length-capped, so the argument stays an argument.
- `W` tier, so a fat-fingered paste asks before it fetches.
- Still: **this fetches any https URL you send it**, from your machine, on your network. That is
  the feature. Keep the chat private and the allowlist to yourself.

### 5.5 Grouping a pile of personal scripts

Once there are more than a handful, the `/` menu is the thing that degrades.

```jsonc
"stock-pull":   { "argv": [...], "menu": "stocks", "label": "Pull daily bars" },
"stock-verify": { "argv": [...], "menu": "stocks", "label": "Verify yesterday" },
"stock-export": { "argv": [...], "menu": "stocks", "label": "Export to CSV" }
```

The `/` list gets **one** row, `/stocks`, described as `3 command(s)`. Tapping it gives three
buttons. The members still work typed — `/stock_export` — and `/help` lists them marked
`(in /stocks)`. Grouping hides things from the menu; it never makes them unreachable.

Group names share the command namespace: a group called `stocks` and an entry called `stocks`
collide, and the group wins (the entry would otherwise be stranded inside a submenu that no longer
exists). `--check` names any collision.

### 5.6 A deploy, guarded

```jsonc
"deploy-web": {
  "argv": ["web/deploy.sh"],
  "cwd": "~/code/python/herdr-remote",
  "tier": "W",
  "timeout": 600,
  "stream": true
}
```

`W` + `stream` is the shape for anything that changes the world and takes a while: one Confirm, then
you watch it happen.

---

## 6. Naming

- Registry names: `[a-z0-9][a-z0-9_-]{0,31}`. Hyphens are fine.
- Telegram commands: `[a-z0-9_]{1,32}` — so `git-log` is offered as `/git_log`. Both spellings work
  in `/run`.
- **Do not shadow a built-in**: `health`, `svc`, `relay`, `relay_restart`, `relay_url`, `logs`,
  `tail`, `run`, `stop`, `ps`, `whoami`, `help`, `start`. An entry that collides is skipped with a
  reason and stays reachable only as `/run <name>`.
- Telegram caps a scope at 100 commands. Past that, entries keep their handlers and lose their menu
  row.

---

## 7. Adding one — the checklist

```bash
# 1. Edit the registry
$EDITOR ~/.config/herdr-remote/ops.json

# 2. Validate. No token needed, so a config error is diagnosable on its own.
uv run relay/herdr_ops.py --check
```

`--check` prints the resulting menu, the members of each group, and every entry it had to skip and
why. Read that line before restarting anything.

```bash
# 3. Restart the bot — setMyCommands only republishes at boot
```

Then in Telegram: type `/`, confirm the new command is offered, and run it once.

Common `--check` failures:

| Message | Meaning |
|---|---|
| `binary not found or not executable` | `argv[0]` is wrong, or the script is missing its `+x` bit. Validated at load, not at use |
| `placeholder {x} must be a whole argv element` | You wrote `"--flag={x}"`. Split it into two elements, or move the flag into your script |
| `declared but never used in argv` | A `params` entry with no matching placeholder |
| `/name is already taken` | Shadows a built-in, another entry, or a group |
| `needs exactly one of enum/int/re` | A parameter declared zero or two validators |

---

## 8. What this cannot do, by design

No `/exec`. No free-form binary path. No shell. No arguments that were not declared. Those are not
missing features — they are the reason a Telegram bot is allowed to run anything on this machine at
all. A new capability is a new row in `ops.json`, written deliberately, and everything a row can do
is visible in that row.
