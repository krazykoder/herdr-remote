# 2026-08-18 — A second Telegram bot that owns the machine, not the agents

**Class B.** New process, no change to the relay's wire protocol. Proposal:
`.workflow/02_architecture/2026-08-18_telegram_ops_server_proposal.md`.

**A second bot process, not more commands on the existing one.** `herdr_telegram.py` is a *client*
of the relay — `relay_listener()` holds a WebSocket and every command is a round trip — so when the
relay dies, the only remote control surface dies with it. Ops commands added there would inherit
that. `herdr_ops.py` never opens the relay socket; it reaches Telegram by outbound long poll, which
needs no tunnel, no inbound port, and no public hostname. Two processes cannot poll one bot token
(`409 Conflict: terminated by other getUpdates request`), so ops gets its own `@BotFather` token
and its own chat — which is also the right trust boundary, because this process runs binaries and
restarts services while the other one reads panes.

**Everything it can do is a row in `ops.json`, outside the repo.** Two tables: `services` (start
argv, health probe, log path) and `commands` (argv template with per-parameter `enum` / `int` / `re`
validators). There is no `/exec`, no `shell=True`, and no way to name a binary the config does not.
A placeholder must be a whole argv element, checked at config load, so no argument can be smuggled
in by concatenation. An empty chat allowlist refuses every command rather than falling back to the
agent bot's discovery mode — open-by-default is wrong for a process that executes things.

**Restart goes through `start.sh`, detached, and is signalled by process group.** `setsid`
(`start_new_session=True`) with pid+pgid recorded in `$CONFIG_DIR/run/<service>.json`; stop is
`SIGTERM` to the **group**, which is what fires `start.sh`'s existing `trap cleanup INT TERM EXIT`
and takes `cloudflared` down with the relay instead of orphaning a tunnel that now 502s. Because
the restart runs `start.sh` itself, `lib-ports.sh`'s rule — only ever stop a process this project
started, a foreign port holder is a hard error — is inherited rather than reimplemented. Before any
signal, the recorded argv is re-checked against the live pid to defeat pid reuse. launchd/systemd
remain an optional backend via the registry's `unit` key, never a prerequisite.

**`start.sh` persists the tunnel URL.** With `HERDR_TUNNEL_MODE=temp` each restart mints a new
hostname, and today it is only echoed and webhooked. Writing `$CONFIG_DIR/tunnel.url` is what lets
`/relay restart` answer with a working `wss://` link — the single reason this server exists.

**Ops knows nothing about agents.** No relay connection at all, which is precisely what makes it
survive a relay outage. `/health` reports the relay as a service: port listening, pid, uptime, log
tail. Agent state stays the other bot's job. Same machine only; no SSH fan-out.
