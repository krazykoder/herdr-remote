# herdr-remote

Agent dashboard for [herdr](https://herdr.dev) -- menu bar, phone, Telegram. Zero config locally, free tunnel for remote.

## Install (10 seconds)

Download [Herdi.app](https://github.com/dcolinmorgan/herdr-remote/releases/latest) and drag to Applications.

Monitors all your local herdr agents automatically -- no relay, no config, no account.

```bash
curl -sL https://github.com/dcolinmorgan/herdr-remote/releases/latest/download/Herdi-0.7.0.dmg -o /tmp/Herdi.dmg && open /tmp/Herdi.dmg
```

## What you get

- **Live agent timeline** -- who worked when, who blocked, who finished
- **One-tap approvals** from phone, menu bar, or Telegram
- **Daily activity digest** -- `/digest` in Telegram shows working time + block count
- **Terminal interaction** -- read output, send commands, interrupt agents remotely
- **Notifications** -- know instantly when agents need you or finish
- **11 themes** -- dark, herdr, light, sand, clay, dune, nord, rose, dracula, kanagawa, midnight

## Screenshots

| Menu Bar App | Settings |
|:--:|:--:|
| ![Menu bar](public/mac_main.png) | ![Settings](public/mac_settings.png) |

| Agent List | Terminal View |
|:--:|:--:|
| ![Agent list](public/herdr-remote-menu.png) | ![Terminal](public/herdr-remote-quick-menu.png) |

## Remote monitoring (phone/Telegram)

For monitoring agents across machines or from your phone:

```bash
herdr plugin install dcolinmorgan/herdr-push
cd herdr-remote/relay && ./start.sh
```

Open your relay's tunnel URL on your phone.

## Telegram Bot

For an automatically restarting relay and Telegram bot:

```bash
cd relay
./install-service.sh
```

Choose Telegram setup when prompted. Create the bot with `@BotFather` using `/newbot`, send `/start` to the bot (or `/start@your_bot` in a private group), and select the discovered chat. Telegram connects to the relay over localhost, so this setup does **not** require Cloudflare Tunnel; the Mac only needs outbound internet access to Telegram.

The installer creates user services on macOS or Linux, enables relay authentication for new installs, and stores credentials in `~/.config/herdr-remote/secrets.env` with mode `0600`. On macOS:

```bash
launchctl print "gui/$(id -u)/com.herdr-remote.relay"
launchctl print "gui/$(id -u)/com.herdr-remote.telegram"
```

Manual foreground setup remains available:

```bash
export HERDR_TG_TOKEN="your-token"
export HERDR_TG_CHAT_ID="your-chat-id"
uv run relay/herdr_telegram.py
```

| Command | Action |
|---------|--------|
| `/start` | Show the clickable agent dashboard |
| `/agents` | List all with status |
| `/read` | Read agent output |
| `/reply` | Read + respond in one flow |
| `/send` | Send text to an agent |
| `/trust` | Trust all tools for blocked agent |
| `/interrupt` | Send Ctrl+C |
| `/digest` | Today's activity summary |

The `/start`, `/read`, `/reply`, `/send`, `/interrupt`, and `/trust` pickers keep every eligible agent reachable. Normal herds appear in one list; larger herds include Previous and Next buttons. Selecting an agent opens a reply prompt containing its recent output; reply to that prompt to send text safely to the pane.

Finished and blocked notifications include **Open output & reply**. You can also reply directly to the notification to send a follow-up without returning to the agent list. Blocked notifications retain their one-tap approval controls.

## Architecture

```
                    ┌──────────────────────────────┐
                    │  macOS Menu Bar (Herdi.app)   │ <- zero config
                    └──────────────────────────────┘

┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│  Web App     │  │  Telegram    │  │  TUI         │
│  (phone)     │  │  Bot         │  │  (terminal)  │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                  │                  │
       └───── WebSocket ──┴──────────────────┘
                   │
        ┌──────────┴──────────┐
        │   relay (:8375)     │  <- Cloudflare tunnel
        └──────────┬──────────┘
                   │
     ┌─────────────┼─────────────┐
     │ local poll  │ herdr-push  │
     │ (herdr CLI) │ (HTTP POST) │
     └──────┬──────┘──────┬──────┘
         ┌──┴──┐     ┌────┴────┐
         │herdr│     │herdr    │
         │local│     │remote   │
         └─────┘     └─────────┘
```

## Terminal TUI

```bash
uv run relay/herdr_tui.py
```

## Token Auth

`install-service.sh` generates and persists a relay token for new managed installs. For foreground use:

```bash
export HERDR_RELAY_TOKEN="$(openssl rand -hex 32)"
uv run relay/herdr_relay.py
```

## Local Mode and Tunnel Mode

cloudflared forwards tunnel requests from a local process, so at the relay a tunnel request looks
exactly like a LAN one. A single listener therefore cannot be token-free for the phone on your
Wi-Fi without also being token-free for the internet. Two listeners in one process make the
boundary structural:

| Listener | Bind | Token | For |
|---|---|---|---|
| LAN | `HERDR_LAN_BIND`, default `0.0.0.0`, port 8375 | unless `HERDR_LAN_OPEN=1` | Phone on your network |
| External | `127.0.0.1:HERDR_EXTERNAL_PORT` | always | What the tunnel terminates on |

**Local only** — no token, no tunnel:

```bash
relay/start-local.sh
```

**Both** — token-free on the LAN, token-required through the tunnel:

```bash
export HERDR_RELAY_TOKEN="$(openssl rand -hex 32)"
export HERDR_LAN_OPEN=1
export HERDR_EXTERNAL_PORT=8377
relay/start.sh
```

The tunnel must terminate on the external port:

```yaml
ingress:
  - hostname: relay.example.com
    service: http://127.0.0.1:8377
```

`start.sh` refuses to start a tunnel when the LAN listener is open and no external port exists,
because that combination publishes an unauthenticated relay to the internet.

> `HERDR_LAN_OPEN=1` means any peer that can reach this machine can read panes, type into agents,
> and start sessions — and a pane in auto-approve mode will act on what it is sent. With
> `0.0.0.0` that includes café and hotel Wi-Fi, guest VLANs, container bridges, and VPN peers.
> `HERDR_LAN_BIND=192.168.1.20` narrows it to one interface.

Full rationale: `.workflow/02_architecture/2026-08-09_dual_listener_access.md`

## Remote Start Session

Off by default. Starting an agent from a phone spawns a process on the relay's machine or on a
configured SSH target, so it is opt-in and needs a token — the relay **refuses to start** with the
flag set and no `HERDR_RELAY_TOKEN`, unless `HERDR_LAN_OPEN=1` says the LAN listener is
deliberately open.

```bash
export HERDR_PROJECTS_FILE="$HOME/.config/herdr-remote/projects.json"
export HERDR_RELAY_TOKEN="$(openssl rand -hex 32)"
export HERDR_ENABLE_WRITE_EXT=1
export HERDR_START_AGENTS="claude,codex"   # optional; default codex,claude,pi
```

A Project is a trusted launch target from the Projects config:

```json
[{"id":"charts","label":"Charts","cwd":"~/code/js/charts.TS","host":"local"}]
```

The client sends only an agent name, a role, a Project ID, and where to place the session. The
relay resolves cwd and host from the config — never from the client — and runs the agent with a
fixed argv. `HERDR_START_AGENTS` limits **what** can be launched; the write flag plus the token
limit **who** can launch it. Without the flag the browser is never told the feature exists and
shows no Start session control.

## Requirements

- macOS 14+ (menu bar app)
- Python 3.10+ with [uv](https://docs.astral.sh/uv/) (relay/TUI/bot)
- `cloudflared` (for remote access)
- herdr 0.7+
- Zero-dep plugin: [`herdr-push`](https://github.com/dcolinmorgan/herdr-push)

## Changelog

### v0.7.0

- **Notch panel** — Dynamic Island-style agent status in the MacBook notch; see working/waiting/blocked at a glance without switching windows

### v0.6.0

- **Workspace drill-down** — agents grouped by workspace/space; blocked "Needs you" agents hoisted to top of dashboard before workspace cards
- **Prettier cards** — shadcn-style: 12px radius, subtle borders, hover lift/shadow, `active:scale(0.99)`, cwd display, chevron navigation
- **Web Push (VAPID)** — subscribe in Settings; get notified when agents block even with tab closed; auto-clears when agent unblocks
- **Structured audit log** — all write actions (respond, send_text, send_keys) logged as JSONL to `~/Library/Logs/herdr-remote/audit.log`
- **Push collapse + TTL** — offline devices get only the latest notification (Topic: `herdr-herd`, TTL: 6h), not a burst of stale alerts
- **Count pills** — workspace cards show pane/tab counts at a glance

### v0.5.0

Telegram bot (`/agents /read /send /reply /trust /interrupt`) and Linux setup script.
