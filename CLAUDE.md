# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## global agent instructions

- Never manually modify CHANGELOG.md files or any files that are marked as auto-generated
- When making technical decisions, do not give much weight to development cost.
  Instead, prefer quality, simplicity, robustness, scalability, and long term maintainability.
- When doing bug fixes, always start with reproducing the bug in an E2E setting as closely aligned with how an end user would experience it as possible.
  This makes sure you find the real problem so your fix will actually solve it.
- When end-to-end testing a product, be picky about the UI you see and be obsessed with pixel perfection.
  If something clearly looks off, even if it is not directly related to what you are doing, try to get it fixed along the way.
- Apply that same high standard to engineering excellence: lint, test failures, and test flakiness.
  If you see one, even if it is not caused by what you are working on right now, still get it fixed.

## Workflow Structure

Development artifacts live in `.workflow/`, organized by phase. The phase manuals in
`.agent/manuals/phases/` (`01_Concepts.md` … `06_Reviews.md`) define what belongs in each.

| Directory | Contents |
|-----------|----------|
| `01_concepts/` | Ideas, requirements, mental models, synthesis |
| `01_discovery/` | Exploration and research notes |
| `02_architecture/` | Architecture docs, `decision_log/`, `feature_log/`, `frontend/` |
| `03_specs/` | Specifications |
| `04_implementation_plans/` | Plans handed to implementer agents |
| `05_implementation/` | Implementation walkthroughs |
| `05_tickets/` | Tickets |
| `06_reviews/` | Reviews |
| `07_dev_notes/` | Working notes, `FAQ/`, `data/`, `drafts/` |

`_archive/` and `archive/` subdirectories hold superseded documents — do not delete, move.

## Environment Setup

Python 3.13 with a venv at `.venv313/` in the repo root.

```bash
source .venv313/bin/activate
# or, to recreate:
uv venv --python 3.13 .venv313
uv pip install -r relay/requirements.txt
```

`relay/requirements.txt` is the union of the PEP 723 dependency headers across `relay/*.py`.
It exists for a shared venv, editor/LSP, and tests — `uv run relay/<script>.py` does not need it.

```bash
# Run tests (tests/ has no __init__.py, so -t must point at it)
.venv313/bin/python -m unittest discover -s tests -t tests

# End-to-end: spawns real relays against a fake herdr on two simulated hosts.
# Not picked up by discover — it binds a port, so run it deliberately.
.venv313/bin/python tests/e2e/e2e_start_agent.py

# Pane slots against the REAL herdr, in a throwaway workspace. Covers herdr's geometry
# contract — run it after a herdr upgrade.
.venv313/bin/python tests/e2e/e2e_pane_slots.py

# Frontend logic. Each extracts a block from web/index.html and runs it in a vm context,
# so the single-file app keeps its no-build-step property.
node --test tests/test_pairs.js tests/test_ctrl_keys.js tests/test_relay_url.js tests/test_stamp.js tests/test_bottom_dock.js
```

Editing `web/` needs only a browser reload — the relay reads `index.html` from disk on every
GET and serves it `no-cache`. Editing `relay/` needs a relay restart.

`tests/e2e/bin/` holds a fake `herdr` and a fake `ssh`. The fake ssh sets `HERDR_FAKE_HOST`
and execs locally, which is what lets one machine present two hosts — the only way to
reproduce the pane-ID and workspace-ID collisions the relay's guards exist for.

External binaries: `herdr` 0.8.0 or newer (required, polled by the relay), `cloudflared` (optional, tunnel only).

## Project Overview

herdr-remote is a multi-client system for monitoring and approving [herdr](https://herdr.dev) AI agents remotely. It provides a WebSocket relay that bridges the herdr CLI with phone, desktop, Telegram, and terminal clients.

## Architecture

```
Clients (web/mac/ios/telegram/tui)
        │ WebSocket
        ▼
   relay (:8375)  ←── Cloudflare tunnel (public wss://)
        │
        ▼
   herdr CLI (local or SSH to HERDR_REMOTES)
```

The relay (`relay/herdr_relay.py`) is the central hub: it polls herdr for agent state, accepts push events via HTTP POST and UDP, and broadcasts to connected WebSocket clients. Clients send `respond`, `read_pane`, `send_keys`, and `send_text` messages back through the relay to control agents.

## Components

| Path | What | Language |
|------|------|----------|
| `relay/herdr_relay.py` | WebSocket+HTTP relay server | Python (websockets, zeroconf) |
| `relay/herdr_telegram.py` | Telegram bot client | Python (python-telegram-bot) |
| `relay/herdr_tui.py` | Terminal TUI client | Python (textual) |
| `web/index.html` | Mobile/desktop web app (single file) | HTML/CSS/JS |
| `herdi-mac/` | macOS menu bar app | Swift (SPM) |
| `herdi-ios/` | iOS app with widgets + Live Activities | Swift (XcodeGen) |

## Running Components

All Python scripts use [PEP 723 inline metadata](https://peps.python.org/pep-0723/) — `uv run` handles dependency installation automatically.

```bash
# Relay (main server)
uv run relay/herdr_relay.py

# Full setup with Cloudflare tunnel
relay/start.sh

# Telegram bot
HERDI_TG_TOKEN="..." HERDI_TG_CHAT_ID="..." uv run relay/herdr_telegram.py

# Terminal TUI
uv run relay/herdr_tui.py

# macOS app
cd herdi-mac && ./build.sh

# iOS app (generate Xcode project)
cd herdi-ios && xcodegen generate
```

## Key Environment Variables

| Variable | Purpose |
|----------|---------|
| `HERDR_RELAY_PORT` | LAN listener port (default: 8375) |
| `HERDR_RELAY_TOKEN` | Shared secret. Guards every listener unless `HERDR_LAN_OPEN=1` exempts the LAN one |
| `HERDR_LAN_BIND` | LAN listener bind address (default: `0.0.0.0`). Set to one interface to stay off VPNs and container bridges |
| `HERDR_LAN_OPEN` | `1` runs the LAN listener with no token — local mode. Explicit by design |
| `HERDR_EXTERNAL_PORT` | Loopback-only second listener for a tunnel to terminate on. Always requires a token; unset = no external listener |
| `HERDR_REMOTES` | Comma-separated SSH targets to poll |
| `HERDR_PROJECTS_FILE` | Absolute path to the Projects config JSON (unset = Projects disabled) |
| `HERDR_ENABLE_WRITE_EXT` | `1` enables remote Start session. Needs `HERDR_RELAY_TOKEN`, or `HERDR_LAN_OPEN=1` to run without one |
| `HERDR_START_AGENTS` | Comma-separated allowlist of herdr agent *kinds* for Start session (default: `codex,claude,pi`) |
| `HERDR_ENABLE_TERMINAL` | `1` lists shell panes (panes with no agent) as Terminals and makes them readable and writable. Off means they are never parsed, so the wire is unchanged. Creating one also needs `HERDR_ENABLE_WRITE_EXT` |
| `HERDR_BIN` | Path to herdr binary (default: `/opt/homebrew/bin/herdr`) |
| `HERDR_RELAY` | Relay URL used by clients (default: `ws://127.0.0.1:8375`) |
| `HERDR_TUNNEL_MODE` | Whether `start.sh` launches a tunnel: `temp` (trycloudflare), `named`, `none` (you run cloudflared yourself) |
| `WEBHOOK_URL` | Optional. `start.sh` posts the new `wss://` URL here on startup, fenced as a code block and nothing else. Never carries the token. `HERDR_NOTIFY_WEBHOOK` overrides |
| `HERDR_APP_URL` | App URL used in the printed/posted link (default: the GitHub Pages deploy) |

## Web App

The web app is a single self-contained HTML file (`web/index.html`) with inline CSS and JS — no build step. It's deployed to Cloudflare Pages. It includes 11 color themes, a mobile terminal keyboard, PWA support, agent-icon detection, and a
line ruler for picking a range of pane lines with a finger.

## WebSocket Protocol

Messages are JSON with a `type` field:

**Server → Client:** `agents` (complete state snapshot; carries `shells` when terminal mode is on), `agent_update` (single-pane state merge), `blocked` (approval prompt), `pane_content` (terminal read, carries the pane's width in cells as `cols` and the `source` it was read from)

**Client → Server:** `respond` (send text to agent), `read_pane` (request terminal content; optional `source` — `recent-unwrapped` by default, or `visible` for the live frame with no backlog), `send_keys` (send key sequences), `send_text` (raw text without newline), `rename_pane` (relabel a pane, 1–32 chars, no control characters), `start_agent` (gated on `HERDR_ENABLE_WRITE_EXT`, takes an optional `slot`), `set_slot` (put a pane in the `wide` or `narrow` slot; same gate), `open_terminal` (create a shell pane at a Project's cwd; needs `HERDR_ENABLE_TERMINAL` **and** `HERDR_ENABLE_WRITE_EXT`)

## Deployment

- Web app → GitHub Pages: `make deploy-web` (or `./web/deploy.sh`) publishes `web/` to
  `https://eagerkoder.github.io/mini/`. Manual, using your own git credentials — no token lives in
  this repo. The script owns `mini/` and only `mini/`; the target repo's root is never touched.
  Override with `HERDR_PAGES_REPO`, `HERDR_PAGES_BRANCH`, `HERDR_PAGES_SUBDIR`.
- Web app → Cloudflare Pages: push to main deploys `web/`. Still wired up; the two are independent.
- macOS app: `herdi-mac/build.sh` produces `dist/Herdi.app`

**A page served over HTTPS cannot open a `ws://` socket.** From `eagerkoder.github.io` the relay
must be reached over `wss://` — the Cloudflare tunnel. A LAN relay at `ws://192.168.x.x:8375` is
blocked as mixed content by every browser. That is also why the app does not auto-connect on
`github.io`: `isSelfRelay` excludes it, so the setup screen asks for the URL.
