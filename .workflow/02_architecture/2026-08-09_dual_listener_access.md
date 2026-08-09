# Proposal — Dual-listener local and external access

**Date:** 2026-08-09  
**Status:** Approved — implementing  
**Scope:** Relay access control for existing remote Start session capability (P2)  
**Repeals:** the P2 rule that `HERDR_ENABLE_WRITE_EXT=1` requires `HERDR_RELAY_TOKEN` — see
[What this repeals](#what-this-repeals)

## Outcome

One relay process serves two deliberately different access paths:

| Path | Listener | Bind | Token | Intended user |
|---|---:|---|---|---|
| Local / LAN | `HERDR_RELAY_PORT` (default `8375`) | `HERDR_LAN_BIND`, default `0.0.0.0` | Only when `HERDR_RELAY_TOKEN` is set **and** `HERDR_LAN_OPEN` is not | Browser on the same machine or trusted LAN |
| External | `HERDR_EXTERNAL_PORT` (default disabled) | `127.0.0.1` | Always | Browser arriving through Cloudflare Tunnel |

The external tunnel must target `http://127.0.0.1:<HERDR_EXTERNAL_PORT>`, never the LAN
listener. Both listeners use the same relay state, Projects config, poll loop, and start-agent
allowlist. They do **not** run separate relay processes.

## Why two listeners

Cloudflared forwards tunnel requests from a local process. At the relay, tunnel traffic therefore
looks local; one `0.0.0.0` listener cannot safely distinguish it from a LAN browser. Making that
listener token-free would also make the tunnel token-free.

Separate listeners make the boundary structural:

```
LAN browser ───────────────> 0.0.0.0:8375       no token

Internet browser ─> Cloudflare Tunnel ─> 127.0.0.1:8377  token required
```

The external listener is loopback-only, so it cannot be reached directly from the LAN. The tunnel
is the only intended ingress. Any process already running on the host can still reach it; loopback
binding defends against the network, not against local code.

## What this repeals

This proposal removes a security invariant that P2 set deliberately, so it is named here rather
than absorbed. Three places assert it today and all three must change together:

1. `relay/herdr_relay.py:90` — the relay **refuses to boot** when `HERDR_ENABLE_WRITE_EXT=1` and
   `HERDR_RELAY_TOKEN` is empty. The LAN-only recipe below sets exactly that combination, so as
   written the proposal does not start.
2. `relay/herdr_relay.py:729-731` — the `start_agent` handler carries a comment reading *"the
   connection itself is already authenticated when a token is set … and the relay refuses to boot
   with WRITE_EXT and no token — so reaching here means both hold."* That reasoning becomes false
   the moment an open LAN listener can reach this branch. The comment must be rewritten, not left
   to mislead the next reader.
3. `.workflow/03_specs/2026-08-08_start_agent_spec.md` and the P2 report both record the rule as a
   posture decision. Both need an amendment pointing here.

**The replacement rule, which stays fail-closed:**

| Configuration | Boot |
|---|---|
| `HERDR_EXTERNAL_PORT` set, no token | **Refuse** — an externally reachable listener is never token-free |
| `HERDR_ENABLE_WRITE_EXT=1`, no token, `HERDR_LAN_OPEN` unset | **Refuse** — unchanged from today |
| `HERDR_ENABLE_WRITE_EXT=1`, no token, `HERDR_LAN_OPEN=1` | Boot, with the banner in safety rule 4 |

`HERDR_LAN_OPEN` exists so the dangerous state has to be typed out. Deriving "the LAN is open" from
the presence of an external listener would mean a user who added a tunnel silently dropped
authentication from the port their whole LAN can reach.

## Configuration

### LAN-only mode

No external listener and no tunnel:

```sh
HERDR_ENABLE_WRITE_EXT=1
HERDR_LAN_OPEN=1
HERDR_PROJECTS_FILE="$HOME/.config/herdr-remote/projects.json"
relay/start-local.sh
```

This starts only `0.0.0.0:8375`; browsers use `http://<LAN-IP>:8375`. It is intentionally
token-free.

**"LAN" here means every network the host is attached to**, not a trusted home subnet: café and
hotel Wi-Fi, a guest VLAN, a Docker bridge, and every VPN peer are all included by `0.0.0.0`. With
`HERDR_ENABLE_WRITE_EXT=1` an unauthenticated peer can start an allowlisted agent and type into
any pane — and panes running in auto-approve mode will act on that text. Treat this as remote code
execution granted to the network, because that is what it is.

`HERDR_LAN_BIND` narrows it without giving up the mode: set it to one interface address
(`192.168.1.20`) to stay off a VPN or container bridge, or to `127.0.0.1` for a single-machine
setup where the browser is on the host. It defaults to `0.0.0.0`, so nothing changes for anyone
who does not set it.

### LAN plus external mode

```sh
HERDR_ENABLE_WRITE_EXT=1
HERDR_LAN_OPEN=1
HERDR_PROJECTS_FILE="$HOME/.config/herdr-remote/projects.json"
HERDR_EXTERNAL_PORT=8377
HERDR_RELAY_TOKEN="$(openssl rand -hex 32)"
relay/start.sh
```

Cloudflared configuration:

```yaml
ingress:
  - hostname: relay.example.com
    service: http://127.0.0.1:8377
```

- LAN browsers use `http://<LAN-IP>:8375` without a token.
- Tunnel browsers use `https://relay.example.com/?token=<token>`.
- The existing browser query-token storage flow is unchanged.

`HERDR_EXTERNAL_PORT` is unset by default. An external listener without `HERDR_RELAY_TOKEN` is a
boot error. `HERDR_RELAY_TOKEN` by itself does **not** turn on the external listener, and it does
**not** stop applying to the LAN listener — that takes `HERDR_LAN_OPEN=1`.

Note the two listeners are separate browser **origins**. The web app stores its token in
`localStorage`, which is per-origin, so a phone that has used the tunnel and then switches to the
LAN address has two independent stores — and two independent sets of pairs, recents, and themes.
That is existing behaviour, not something this change introduces, but the dual-listener setup is
the first configuration that makes it routine.

## Design

### Per-listener authentication

Replace the current global assumption, “a token means every socket requires it,” with a per-listener
policy passed into the WebSocket server callbacks:

- LAN listener: `require_token = bool(AUTH_TOKEN) and not LAN_OPEN`
- External listener: `require_token = True`, unconditionally

Derived rather than hardcoded `False`, so an existing token-protected deployment that adds no new
variables keeps behaving exactly as it does today — which is what safety rule 5 promises, and what
a flat `require_token=False` would have quietly broken.

`process_request` validates the token only when its listener requires one. It is currently a
module-level function reading the global `AUTH_TOKEN`; it becomes a per-listener closure or
`functools.partial`. The WebSocket handler receives the same policy so that start-agent
availability remains consistent with the handshake.

**The policy covers the whole HTTP surface, not just the WebSocket upgrade.** `process_request`
gates every request on the port: `GET /` serving `web/index.html`, and the HTTP POST push
endpoint. Opening the LAN listener therefore also opens event injection over POST. That is
acceptable — a forged `blocked` event is strictly weaker than the `send_text` the same listener
already grants — but it must be stated, because "token-free LAN listener" reads as being about
the browser socket alone.

The WebSocket protocol remains unchanged: no new client message, no client-selected mode, no
browser-origin checks, and no proxy-header trust.

### Start-agent gate

`HERDR_ENABLE_WRITE_EXT=1` still controls whether the feature exists. `start_options` is sent:

- to LAN clients when write extensions are enabled;
- to external clients only after the external listener authenticated them.

The authenticated external listener and token-free LAN listener both use the existing strict
Project, placement, allowlist, workspace, and pane ambiguity validation.

### Listener lifecycle

`main()` starts the poll loop, UDP push endpoint, mDNS registration, and event push once. It then
starts the LAN WebSocket/HTTP server and, when configured, the external loopback WebSocket/HTTP
server. Shutdown closes both servers.

Logs identify each listener by bind address and port, and say for each whether it requires a
token — a one-line startup record of the access posture, so a misconfiguration is visible without
reasoning about which variables were set.

mDNS advertises only the LAN listener; advertising a loopback port to the LAN would be pointless.
Note the consequence: with `HERDR_LAN_OPEN=1`, `start_mdns` is actively broadcasting an
unauthenticated write-capable relay to every device on the network. That is the intended
convenience — it is how the phone finds the relay — but it means "nobody knows the port" is not
part of the threat model. `HERDR_LAN_BIND` is the control that actually narrows exposure.

## `start-local.sh`

Add `relay/start-local.sh` as the low-friction LAN launcher. It:

1. Loads the normal config file for Projects/agent allowlist.
2. Forces `HERDR_ENABLE_WRITE_EXT=1` and `HERDR_LAN_OPEN=1`.
3. Unsets `HERDR_EXTERNAL_PORT` and `HERDR_RELAY_TOKEN` **after** sourcing the config, so a token
   set there for tunnel use does not leak into a mode that has no tunnel.
4. Runs the same port preflight `start.sh` does — refusing to start on a port already in use,
   rather than failing obscurely inside `serve()`.
5. Starts the relay without Cloudflared.
6. Prints the actual bind address, the detected LAN URLs, and the safety rule 4 banner.

It must not call `start.sh`, because `start.sh` may launch Cloudflared and may source an external
token after `start-local.sh` tries to unset it. Shared port-preflight logic may be extracted only if
it stays smaller and clearer than the duplicate few lines.

## Safety rules

1. **No token-free external listener.** Configuring `HERDR_EXTERNAL_PORT` without a token refuses
   startup before binding either listener.
2. **No tunnel to the LAN listener.** Document and validate the Cloudflared target as loopback
   external port. The relay cannot verify Cloudflare configuration itself.
3. **No automatic tunnel.** `start-local.sh` never starts cloudflared.
4. **LAN is an explicit trust decision.** It takes `HERDR_LAN_OPEN=1` — a variable that exists
   only to be typed on purpose — and the startup banner names the bind address and warns that the
   port permits writes and agent starts to every peer that can reach it.
5. **Existing single-listener token deployments stay safe.** Without `HERDR_LAN_OPEN`, a set
   `HERDR_RELAY_TOKEN` still guards the LAN listener, with or without an external listener. Adding
   a tunnel must never be the thing that drops authentication from the LAN port.
6. **The `start_agent` reasoning is rewritten, not left stale.** The handler's comment currently
   argues that reaching that branch proves the connection was authenticated. Under an open LAN
   listener it proves only that write extensions are on. The audit line at `:744` becomes the
   record that matters, and `ip`/`device` on it are the only attribution an unauthenticated
   listener can offer.

## Implementation outline

1. Add `HERDR_EXTERNAL_PORT`, `HERDR_LAN_OPEN`, and `HERDR_LAN_BIND` parsing, and replace the
   boot check at `:90` with the three-row table above.
2. Make HTTP token validation and `handle_client` accept a `require_token` policy from each
   server; rewrite the `start_agent` comment at `:729`.
3. Start/stop an optional loopback external server alongside the existing LAN server; preserve
   current defaults exactly when the variables are unset.
4. Add `relay/start-local.sh` and document LAN-only plus external setup in `README.md` and
   `CLAUDE.md`'s environment table.
5. Amend `03_specs/2026-08-08_start_agent_spec.md` and the P2 report to point at this document
   for the repealed invariant.
6. Extend `tests/e2e/e2e_start_agent.py`:
   - LAN open client with no token sees `start_options` and can start an allowed agent.
   - External listener rejects missing and wrong tokens, accepts the correct one.
   - External-port-without-token refuses boot, before binding anything.
   - `HERDR_ENABLE_WRITE_EXT=1` with no token and no `HERDR_LAN_OPEN` still refuses boot.
   - Legacy single-listener token mode remains authenticated **while an external listener is also
     configured** — the regression safety rule 5 exists to prevent.
   - One poll loop: the fake herdr log shows the same `pane list` rate with two listeners as with
     one, and two connected clients do not double it.

## Acceptance

- `start-local.sh` exposes a token-free LAN UI, does not launch cloudflared, and starts an
  allowlisted agent successfully.
- A token-free connection to the external port returns HTTP 401; a correct token succeeds.
- The external listener binds only `127.0.0.1`, never `0.0.0.0`, and does not appear in mDNS.
- Both listeners observe the same live sessions and Projects without duplicate poll loops.
- With `HERDR_EXTERNAL_PORT` unset, current deployments retain their existing behavior.
- With `HERDR_EXTERNAL_PORT` set and no token, startup exits non-zero before binding.
- With `HERDR_RELAY_TOKEN` set, `HERDR_LAN_OPEN` unset, and an external listener configured, the
  LAN listener still returns 401 without a token.
- `HERDR_LAN_BIND=127.0.0.1` makes the LAN listener unreachable from another host on the network.
- The startup log states, for each listener, its bind address, port, and whether it requires a
  token.

## Out of scope

- Treating arbitrary LAN addresses as authenticated.
- Inferring tunnel traffic from `Origin`, `Host`, `X-Forwarded-For`, or source IP.
- Cloudflare Access integration.
- A second relay process, duplicate polling, or frontend protocol changes.
- IPv6 on the external listener. Cloudflared is configured to `http://127.0.0.1:<port>`, so `::1`
  buys nothing until that changes.
- Per-listener capability differences beyond authentication. Both listeners expose the same
  message types; an open LAN listener is not a read-only one, and pretending otherwise would
  invite the assumption that it is safer than it is.

