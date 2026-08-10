# Relay connection notes — how the phone reaches the agents

**Date:** 2026-08-09
**Applies to:** `relay/start.sh`, `relay/start-local.sh`, `web/index.html`
**Related:** `.workflow/02_architecture/2026-08-09_dual_listener_access.md` (why there are two listeners)

Operational notes for the connection path. Written after setting it up end to end, so the failure
modes named here are ones that actually occurred, not ones imagined.

---

## The two listeners

One relay process, two sockets, deliberately different policies.

| | LAN listener | External listener |
|---|---|---|
| Variable | `HERDR_RELAY_PORT` (8375) | `HERDR_EXTERNAL_PORT` (8377) |
| Bind | `HERDR_LAN_BIND`, default `0.0.0.0` | `127.0.0.1`, always |
| Token | only if `HERDR_RELAY_TOKEN` set **and** `HERDR_LAN_OPEN` unset | **always** |
| Reachable from | any network the laptop is attached to | loopback only — the tunnel |

Cloudflared forwards tunnel requests from a local process, so at the relay a tunnel request is
indistinguishable from a LAN one. A single listener cannot be token-free for the phone on the Wi-Fi
without also being token-free for the internet. Two sockets make that boundary structural instead of
a guess about the request.

**The tunnel must terminate on the external port. Never 8375.**

---

## `HERDR_TUNNEL_MODE` — what it actually controls

It controls **whether `start.sh` launches a tunnel itself**. Nothing else. This is the single
easiest thing to get backwards.

| Value | `start.sh` does | Requires | URL |
|---|---|---|---|
| `temp` | runs `cloudflared tunnel --url http://127.0.0.1:8377` | nothing | random `*.trycloudflare.com`, **new every start** |
| `named` | runs `cloudflared tunnel --config ~/.cloudflared/config-herdr.yml run <name>` | a domain on Cloudflare + `cloudflared tunnel login` (writes `cert.pem`) | stable hostname you choose |
| `none` | launches nothing | you run cloudflared yourself — e.g. the dashboard connector | whatever that connector serves |

`none` does **not** mean "no tunnel is in use". It means "start.sh is not the thing starting it".
Setting `none` while relying on `start.sh` for the tunnel leaves the phone with no route at all.

### Current setup: `temp`

```sh
# ~/.config/herdr-remote/config.env
export HERDR_PROJECTS_FILE="$HOME/.config/herdr-remote/projects.json"
export HERDR_LAN_OPEN=1          # LAN 8375, token-free
export HERDR_EXTERNAL_PORT=8377  # loopback, token always required
export HERDR_ENABLE_WRITE_EXT=1  # Start session; global, so the open LAN port gains it too
export HERDR_TUNNEL_MODE=temp    # start.sh runs the quick tunnel

# ~/.config/herdr-remote/secrets.env   (0600)
HERDR_RELAY_TOKEN=<64 hex chars>
```

`start.sh` sources **both** files — config first, then secrets. It did not always: it sourced only
`config.env`, while `install-service.sh` writes the token to `secrets.env` and the launchd service
sources both. A token created by the installer was therefore invisible to a foreground run, and with
`HERDR_EXTERNAL_PORT` set the relay refuses to boot without one. Fixed 2026-08-09.

---

## What actually happens when the phone connects

This is the part worth internalising, because it is not obvious.

```
Phone ── https://eagerkoder.github.io/mini/          (app, static, GitHub Pages)
   │
   └── wss://<random>.trycloudflare.com  ──> Cloudflare edge ──> cloudflared on the laptop
                                                                      │
                                                                      └─> 127.0.0.1:8377  (token)
```

**The app is served from one origin and the relay lives at another.** That is fine — WebSocket is
not subject to CORS — but it has three consequences that all showed up in practice:

1. **A page served over HTTPS cannot open a `ws://` socket.** From `github.io` the relay must be
   `wss://`. `ws://192.168.x.x:8375` is blocked as mixed content by every browser. **So even when
   you are sitting on your own Wi-Fi, traffic from the github.io app goes out to Cloudflare and back
   in.** That is the correct reading of "temp is used for both LAN and internet access".
2. **The token-free LAN listener is unreachable from the github.io app.** It is only usable from the
   copy of the app the relay serves itself, at `http://<lan-ip>:8375/` — plain HTTP, same origin,
   no mixed content. That is a *different browser origin*, so it has its own `localStorage`: its own
   pairs, recents, theme and token. Two entry points, two independent stores.
3. **HTTP fetches to the relay do need CORS**, unlike the socket. The relay sends
   `Access-Control-Allow-Origin: *` on its API routes — and, since 2026-08-09, on the 401 as well.
   Without it a rejected request is unreadable to the caller: the browser reports an opaque network
   failure and the app cannot tell "wrong token" from "relay is down".

### Consequence worth deciding on

If the github.io app is the only client you use, **port 8375 is serving nobody** and is a token-free
socket on every attached network — café Wi-Fi, guest VLANs, VPN peers, Docker bridges. Options, in
descending order of exposure:

```sh
export HERDR_LAN_BIND=192.168.1.20   # one interface, off VPNs and container bridges
export HERDR_LAN_BIND=127.0.0.1      # loopback only; the LAN app entry point goes away
unset HERDR_LAN_OPEN                 # keep the port, require the token on it too
```

Left as `0.0.0.0` + `HERDR_LAN_OPEN=1` by explicit decision — the LAN here is trusted, and
`start-local.sh` is the dev/LAN-only launcher.

---

## Each restart

```sh
relay/start.sh
```

Prints:

```
  Tunnel:  wss://weight-soldier-integrated-comfortable.trycloudflare.com
  Open:    https://eagerkoder.github.io/mini/?relay=wss%3A%2F%2F…&token=…
  Notified: webhook
```

Open the second line on the phone. The app reads `?relay=` and `?token=`, stores both, then strips
them from the URL with `history.replaceState` — they are credentials in a URL, and left in place they
persist in the address bar, in history, and in any screenshot.

`?relay=` is scheme-checked against `ws://` or `wss://`, since its value becomes the address the app
connects to.

### Restarting over a running instance

Both launchers reclaim their ports first, so `relay/start.sh` can be run again without stopping
anything by hand. `relay/lib-ports.sh` holds the logic for both.

What it will and will not do is the whole point:

- A listener held by **our own relay** is stopped — SIGTERM, then SIGKILL only if it has not gone
  in 5s, because SIGKILL leaves the port in `TIME_WAIT` and the next bind fails for reasons that
  look nothing like the actual cause.
- A listener held by **anything else** is a hard error naming the pid and command. "Restarting my
  relay" must never mean "terminate whatever is on 8375".
- A stale **tunnel** is matched on argv — `--url http://127.0.0.1:<external port>`, or `run <name>`
  for a named one. A dashboard-managed connector runs with `--token-file` and another project's
  tunnel has a different target, so neither matches and neither is touched.
- `start-local.sh` also stops a tunnel `start.sh` may have left running, since that would keep a
  public hostname alive while local mode deliberately drops the token.

`uv run` means two processes match `herdr_relay.py` — the wrapper and the Python child. Only the
child holds the listener; stopping it takes the wrapper with it.

### The URL rotates, the token does not

**Only the hostname changes on restart.** The token is stable and already in the phone's
`localStorage`. So after first setup, a restart needs only `?relay=` — no credential.

### Webhook notification

```sh
# in secrets.env, since a webhook URL is itself a credential — anyone holding it can post
WEBHOOK_URL=https://discord.com/api/webhooks/...
```

`start.sh` posts the new address on startup. Discord's JSON shape (`{"content": …}`); Slack wants
`text` instead. `HERDR_NOTIFY_WEBHOOK` takes precedence if both are set.

**The message is the `wss://` URL and nothing else**, fenced as a code block so it is one tap to copy
on a phone rather than a line of chat text to select by hand:

```json
{"content": "```\nwss://upc-retrieve-unnecessary-liberal.trycloudflare.com\n```"}
```

**It never carries the token.** Only the hostname rotates — the token is stable and already in the
phone's `localStorage` — so nothing is at risk if the channel leaks or its history is read later. For
a new device, read the token once out of `secrets.env`.

A failed post is never fatal: the relay and tunnel are already up, only the convenience failed. The
terminal still prints the full `Open:` link with both values for the first-time case.

---

## Moving to a permanent hostname later

Nothing above has to be rebuilt. The tunnel object already created in the Cloudflare dashboard costs
nothing to keep, and a public hostname can be attached to it at any time.

1. Get a domain onto Cloudflare — Registrar sells at cost and sets the nameservers for you, which
   skips the DNS migration.
2. **Zero Trust → Networks → Tunnels → your tunnel → Configure → Public Hostname → Add.**
   - Subdomain: anything (`relay`). Domain: the dropdown lists zones on your account.
   - Type: **HTTP**, not HTTPS. The relay is plaintext on loopback; TLS ends at Cloudflare's edge.
     Choosing HTTPS makes cloudflared attempt a TLS handshake against a plaintext port → 502.
   - URL: **`127.0.0.1:8377`**. Not `localhost` — that can resolve to `::1` first and fail. Not 8375.
3. Reinstall the connector (`cloudflared service install <token>`), set `HERDR_TUNNEL_MODE=none` so
   `start.sh` does not start a second tunnel, and enter `wss://relay.<domain>` in the app once.

Remotely-managed tunnels pull config from Cloudflare, so **local YAML is ignored** for them and the
change applies live — the log flips to `Updated to new configuration` with no restart.

### Do not put Cloudflare Access in front of it

Access works with WebSockets in general — the handshake carries the `CF_Authorization` cookie. It is
fragile *here* specifically: the app is served from `github.io` and connects to another host, so
that cookie is cross-site and iOS Safari's tracking prevention is likely to drop it. The relay token
is the auth. Revisit only if the app is ever served from the tunnel itself.

---

## Failure modes seen, and what they look like

| Symptom | Cause |
|---|---|
| `503` on every request through the tunnel | Connector is connected but has **no ingress rules**. The log says so outright: `No ingress rules were defined … cloudflared will return 503`. Attach a public hostname. |
| Relay exits at boot: `HERDR_EXTERNAL_PORT requires HERDR_RELAY_TOKEN` | Token not reaching the process. Check it is in `secrets.env` and that `start.sh` is current. |
| `502` through the tunnel | Relay not running, or the hostname points at a port nothing is listening on. |
| Push/VAPID fails only through the tunnel | The relay's token gate covers the **whole HTTP surface**, not just the upgrade. The app's VAPID fetch now carries the token; it did not before 2026-08-09. |
| Tunnel URL never printed on macOS | `start.sh` read `/proc/$PID/fd/1`, which does not exist on Darwin. Now polls a temp log. Fixed 2026-08-09. |
| **Start session control missing in the app** | `HERDR_ENABLE_WRITE_EXT` is not set. It is **global, not per listener** — off means off everywhere, tunnel and LAN alike. `start-local.sh` exports it itself, which is why dev appears to work while `start.sh` does not. `start.sh` takes it from `config.env` like everything else. Both listener log lines now print `agent-starts=on/off`. |
| Start session shown but every start errors | Projects config missing or the `project_id` is not in it — a start resolves its cwd from the Project, never from the wire. |
| Config change appears to be ignored | `start.sh` sources `config.env` **after** the environment, so the file wins over an exported variable. Edit the file. |

## Verifying the chain

```sh
curl -o /dev/null -w '%{http_code}\n' https://<host>/              # 401 — the gate is live
curl -o /dev/null -w '%{http_code}\n' "https://<host>/?token=$TOK" # 200 — end to end
```

401 then 200 proves edge → connector → 8377 → token check. Anything else, work backwards from the
table above.
