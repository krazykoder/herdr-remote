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

# Frontend logic, against the modules in web/src/*.js in a vm context.
node --test tests/*.js

# The app in a real browser, against a relay backed by the fake herdr in tests/e2e/bin. Covers
# what a vm slice cannot see: the page booting at all, state clearing between panes, layout.
npm ci && npx playwright install chromium        # first run only
npx playwright test
```

The app still **ships** as one file with no runtime dependencies, but it is no longer **written**
as one: `web/index.html` holds the markup and CSS and loads `web/src/*.js` as plain scripts, and
`scripts/build.py` inlines them into `web/dist/index.html` for deploy. Use the vm-slice suites for
pure logic; reach for Playwright when the failure you care about is "the page is broken".

Editing `web/` needs only a browser reload — the relay reads `index.html` and `src/*.js` from disk
on every GET and serves them `no-cache`, so there is no build in the edit loop. `make build` is for
deploy, and `/dist/` in a browser is how you look at what it produced. Editing `relay/` needs a
relay restart.

**The scripts are plain, not modules, so the order of the `<script src>` tags in `index.html` is
the program.** Nothing enforces it — a module that reads another's binding at load time breaks at
boot if the tags are reordered. The `app_smoke.spec.js` boot tests are the guard.

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
| `relay/conversation_log.py` | Durable record of what agents said — SQLite, one global `turns` table | Python (stdlib) |
| `relay/conv_query.py` | Read-only query over that record. Also a CLI, so an agent can read it from its own shell | Python (stdlib) |
| `relay/herdr_telegram.py` | Telegram bot client | Python (python-telegram-bot) |
| `relay/herdr_tui.py` | Terminal TUI client | Python (textual) |
| `web/index.html` + `web/src/*.js` | Mobile/desktop web app (markup and CSS in one file, 29 script modules) | HTML/CSS/JS |
| `scripts/build.py` | Inlines the modules into the single-file `web/dist/index.html` | Python (stdlib) |
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
| `HERDR_EXTERNAL_PORT` | Loopback-only second listener for a tunnel to terminate on. Always requires a token; unset = no external listener. **Serves the API only** — the WebSocket, the push endpoint and the VAPID key. `index.html`, `src/*.js`, `dist/` and the icons are answered by the LAN listener alone, so the page comes from where it is hosted and the tunnel carries the socket |
| `HERDR_REMOTES` | Comma-separated SSH targets to poll |
| `HERDR_PROJECTS_FILE` | Absolute path to the Projects config JSON (unset = Projects disabled) |
| `HERDR_ENABLE_WRITE_EXT` | `1` enables remote Start session. Needs `HERDR_RELAY_TOKEN`, or `HERDR_LAN_OPEN=1` to run without one |
| `HERDR_START_AGENTS` | Comma-separated allowlist of herdr agent *kinds* for Start session (default: `codex,claude,pi,agy`) |
| `HERDR_ENABLE_TERMINAL` | `1` lists shell panes (panes with no agent) as Terminals and makes them readable and writable. Off means they are never parsed, so the wire is unchanged. Creating one also needs `HERDR_ENABLE_WRITE_EXT` |
| `HERDR_VAPID_PUBLIC` / `HERDR_VAPID_PRIVATE` | Web Push keypair, from `relay/make-vapid.py`. Unset = no push is ever sent |
| `HERDR_VAPID_SUBJECT` | Contact URI in the VAPID claim (default: `mailto:herdr@localhost`) |
| `HERDR_PUSH_SUMMARY` | `1` makes a "finished" push carry the agent's closing message, read out of the pane by `relay/pane_summary.py`. Off by default: unset sends the last few lines of the pane, which is also what any pane with no readable message gets |
| `HERDR_CONV_LOG` | `1` keeps a durable record of what agents said: one row per turn end, plus every prompt this relay delivered. Off by default — it puts agent output on disk, which is the user's call. Read back with `conv_log` or `relay/conv_query.py` |
| `HERDR_ARBITER_DB` | Where the durable conversation record lives (default: `.herdr-remote/arbitration.sqlite3`) |
| `HERDR_CONV_LOG_MAX` | Rows kept before the oldest are pruned (default: 50000). Arbitrated sends and decisions are never pruned |
| `HERDR_BIN` | Path to herdr binary (default: `/opt/homebrew/bin/herdr`) |
| `HERDR_RELAY` | Relay URL used by clients (default: `ws://127.0.0.1:8375`) |
| `HERDR_TUNNEL_MODE` | Whether `start.sh` launches a tunnel: `temp` (trycloudflare), `named`, `none` (you run cloudflared yourself) |
| `WEBHOOK_URL` | Optional. `start.sh` posts the new `wss://` URL here on startup, fenced as a code block and nothing else. Never carries the token. `HERDR_NOTIFY_WEBHOOK` overrides |
| `HERDR_APP_URL` | App URL used in the printed/posted link (default: the GitHub Pages deploy) |

## Web App

The web app ships as a single self-contained HTML file — `web/dist/index.html`, built from `web/index.html` (markup and CSS) plus `web/src/*.js` by `scripts/build.py`. No runtime dependencies and no framework; the build is one stdlib script that concatenates and escapes `</script`. It includes 11 color themes, a mobile terminal keyboard, PWA support, agent-icon detection, and a
line ruler for picking a range of pane lines with a finger.

## WebSocket Protocol

Messages are JSON with a `type` field:

**Server → Client:** `agents` (complete state snapshot; carries `shells` when terminal mode is on), `agent_update` (single-pane state merge), `blocked` (approval prompt), `pane_content` (terminal read, carries the pane's width in cells as `cols` and the `source` it was read from), `conv_log` (turns from the durable record — answered to the client that asked and never broadcast, because it is the message carrying agent prose; echoes back the `fingerprints` it was asked for, so a client can tell an empty answer from a question never asked)

**Client → Server:** `respond` (send text to agent), `read_pane` (request terminal content; optional `source` — `recent-unwrapped` by default, or `visible` for the live frame with no backlog), `send_keys` (send key sequences), `send_text` (raw text without newline; optional `submit` hands the Enter to the relay, which presses it and then watches the pane's `agent_status` until the pane says it took it — retrying while it is still `idle`, waiting while its TUI is still starting, and never pressing at a `blocked` pane, whose box is a permission prompt. See [the decision log](.workflow/02_architecture/decision_log/2026-08-17_submitting_a_paste.md) for the two designs this replaced and why each failed), `rename_pane` (relabel a pane, 1–32 chars, no control characters), `start_agent` (gated on `HERDR_ENABLE_WRITE_EXT`, takes an optional `slot`), `set_slot` (put a pane in the `wide` or `narrow` slot; same gate), `open_terminal` (create a shell pane at a Project's cwd; needs `HERDR_ENABLE_TERMINAL` **and** `HERDR_ENABLE_WRITE_EXT`), `conv_log` (read the durable record; selectors `pane`, `host`, `agent`, `cwd`, `kind`, `grep`, `since`, `until`, `since_id` — turns strictly after that row id, which is how the live thread asks for a delta rather than the window — `last`, and `fingerprints` — a list of `[host, agent, cwd]` triples, which is how a client asks for a whole roster in one query since pane ids change on every restart; needs `HERDR_CONV_LOG`)

## Deployment

- Web app → GitHub Pages: `make deploy-web` (or `./web/deploy.sh`) builds and publishes
  `web/dist/` to `https://eagerkoder.github.io/mini/`. Manual, using your own git credentials — no token lives in
  this repo. The script owns `mini/` and only `mini/`; the target repo's root is never touched.
  Override with `HERDR_PAGES_REPO`, `HERDR_PAGES_BRANCH`, `HERDR_PAGES_SUBDIR`.
- Web app → Cloudflare Pages: push to main deploys `web/`. Still wired up, and since the split it
  publishes the *modular* form — `index.html` plus `src/*.js`, which works on a static host but is
  not the single file GitHub Pages gets. Point it at `web/dist` with a `python3 scripts/build.py`
  build command to make the two agree.
- macOS app: `herdi-mac/build.sh` produces `dist/Herdi.app`

**A page served over HTTPS cannot open a `ws://` socket.** From `eagerkoder.github.io` the relay
must be reached over `wss://` — the Cloudflare tunnel. A LAN relay at `ws://192.168.x.x:8375` is
blocked as mixed content by every browser. That is also why the app does not auto-connect on
`github.io`: `isSelfRelay` excludes it, so the setup screen asks for the URL.
