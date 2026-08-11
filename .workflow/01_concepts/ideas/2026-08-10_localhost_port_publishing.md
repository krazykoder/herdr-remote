# Concept: publishing a localhost port to the remote browser — DEFERRED (no code)

**Status: deferred, and resolved without code.** The chosen direction is **Tailscale Serve — see
§8**, which solves both halves of the problem (reaching the relay, and reaching a dev server) as
pure configuration. Nothing in this repository changes. §§1–7 are the analysis that led there and
are kept so the reasoning is not re-derived; the proxy options in §3 and §4 remain rejected.

**Problem.** An agent is working in a Project and starts a dev server on `127.0.0.1:3000`. From a
phone on the other side of the tunnel, that server is invisible. The wanted experience: open the
app from the same place the panes are supervised, and have it look and behave like the real thing —
not a screenshot, not a scraped copy.

**Related:** [2026-08-10_rejected_concepts.md](../../07_dev_notes/2026-08-10_rejected_concepts.md)
records the two ideas turned down the same day (liveness dots, live shell).

---

## 1. The constraint everything else follows from

A browser rendering a web app is not fetching bytes, it is instantiating an **origin**. The origin
(`scheme://host:port`) is the unit for cookies, `localStorage`, `IndexedDB`, CORS, service-worker
scope, and — the one that kills every clever scheme — **absolute path resolution**.

Any real dev server emits `<script src="/assets/index.js">`. Serve its HTML from
`https://relay.example/proxy/3000/` and the browser resolves that to
`https://relay.example/assets/index.js`, which is the relay's 404 handler. Every workaround for
this is either "rewrite all URLs" (never complete — see §4) or "configure the app with a base path"
(requires touching every app you ever want to view).

**One hostname per published port is the only arrangement that needs nothing from the app.**

This reframes the original question. *"Why can't the same tunnel serve other things?"* — **it can,
and that is Option A.** One `cloudflared` process already multiplexes many hostnames. What a single
tunnel cannot do is serve many apps on **one hostname under different paths**, which is what
`/proxy/<url>/` implies. The limit is not the tunnel; it is the origin.

---

## 2. Option A — cloudflared multi-ingress (the deferred future path)

`cloudflared` is already a dependency and already does this. A named tunnel takes an ingress list:

```yaml
ingress:
  - hostname: relay.example.com
    service: http://127.0.0.1:8376      # HERDR_EXTERNAL_PORT, as today
  - hostname: dev.example.com
    service: http://127.0.0.1:3000      # the app
  - service: http_status:404
```

Real origin. Real HTTPS. WebSocket upgrade passes through, so HMR and the app's own sockets work.
Streaming and SSE work. Large assets stream instead of buffering. **Zero relay code.**

Wildcard DNS extends it without a config edit per port: point `*.dev.example.com` at the tunnel and
map `3000.dev.example.com` → `127.0.0.1:3000`. That is "one tunnel, many apps", properly.

On a temp `trycloudflare` tunnel there is one hostname per `cloudflared --url` process, so a second
port means a second process — still zero code, just an extra child in `start.sh`.

Cost: named ingress needs a domain on Cloudflare. Quick tunnels have **no authentication at all**,
so publishing a dev server through one puts it on the open internet — see §5.

**Why deferred rather than done:** it is configuration, not product. Nothing in this repo has to
change for someone to do it today. What the repo could add later is discovery and hand-off (§6),
which is only worth building once the config path is actually in use.

---

## 3. Option B — relay as a reverse proxy under a path

Add `/proxy/<port>/…` to `process_request` and forward to loopback.

- `process_request` returns a **complete** `Response` with a `bytes` body. No streaming, no chunked
  transfer: a large asset buffers in relay memory, and SSE / long-poll never terminate.
- WebSocket upgrades cannot be proxied there — it returns `None` to hand the handshake to the single
  `handle_client`. Supporting a second WS endpoint means path dispatch inside `handle_client`.
- The §1 absolute-path problem, in full.
- Adds an HTTP client dependency to a module that currently shells out and nothing else.

More work than Option A, strictly worse result. Kept here only so it is not re-proposed.

---

## 4. Option C — `github.io/proxy/<url>/` fetching and rendering in the front end

The idea: the Pages app hosts a proxy route, fetches the target through the relay, and renders it
client-side. Two variants, and the second is a real thing that real products do.

### C1 — fetch and inject, no service worker

Page `fetch`es the HTML through the relay and injects it into an iframe `srcdoc` or a blob URL.

Works for exactly one class of target: a **single self-contained HTML file with no subresources**.
For anything else, every `<script src>`, `<link href>`, CSS `url()`, `@import`, `import()`, and
`new Worker()` resolves against `github.io` and 404s. Rewriting the HTML catches the static ones;
nothing catches a URL a bundle computes at runtime.

### C2 — service worker + URL rewriting (the Ultraviolet / Corrosion pattern)

This is how public web-proxy sites work, so it is proven possible. Encode the target into the path
(`/mini/proxy/<b64url>/…`), register a service worker, intercept every `fetch` under its scope,
decode, and forward through the relay. Then patch the runtime — `fetch`, `XMLHttpRequest`,
`WebSocket`, `location`, `history`, `document.cookie`, `import()` — so computed URLs get rewritten
too. Those projects are thousands of lines for exactly this reason.

Blockers specific to this deployment:

- **Service-worker scope.** Pages serves the app at `/mini/`, and GitHub Pages will not let you set
  the `Service-Worker-Allowed` header, so the maximum scope is `/mini/`. An app requesting
  `/assets/app.js` resolves to `eagerkoder.github.io/assets/app.js` — **outside the scope**, never
  intercepted, served as a GitHub 404.
- **Origin collapse — decisive.** The proxied app executes on the `github.io` origin. That is the
  same origin holding `herdr_relay_url` and `herdr_relay_token` in `localStorage`. Any script in
  any proxied page can read the relay token and then drive the relay: `send_keys` to any pane, on
  any host, including the LAN listener. This is not a hardening gap, it is the design being wrong.
- **WebSocket is not interceptable by a service worker.** It has to be patched in-page, which misses
  workers and anything that captured a reference first.
- The relay would have to inject `Access-Control-Allow-Origin: *` and strip the target's
  `X-Frame-Options` / CSP `frame-ancestors` — deliberately disabling the protections the target
  chose.

**Verdict: rejected within this deferred concept.** Most code, most fragile, and it trades away the
relay's credential isolation. If the Pages app is to be involved at all, it should **link out** to
the per-port hostname from Option A — origin stays separate, nothing is rewritten.

### C3 — "isn't this just encoding and decoding messages over the WSS?"

The natural objection, and the transport half of it is correct: framing an HTTP request and response
into WebSocket messages is a solved ~100-line problem. Request line, headers, body out; stream id
for multiplexing; relay opens a socket to loopback and frames the reply back. The relay already
speaks typed JSON over this exact socket. **Nothing is lost in transport — the bytes arrive
perfect.**

The difficulty is one step later, and it is not an encoding problem:

> There is no browser API that means *"here are the bytes of an HTTP response — treat them as a
> navigation to origin `http://localhost:3000`."*

A browser mints an origin only from a fetch **it performed itself**, against a real URL, over a real
connection. Bytes handed over afterwards must re-enter through a JS-visible door — a service
worker's `respondWith`, a blob URL, an iframe `srcdoc` — and every one of those stamps the bytes
with **the origin of the page that opened the door**. Everything in §1 and §4 (absolute paths,
cookies, `localStorage`, SW scope, token theft) is downstream of that single missing API.

```
encode → WSS → decode        ← easy; the objection is right about this part
        ↓
  hand to the browser        ← no API preserves the target's origin
```

### C4 — the same idea in a native shell, where it *does* reduce to encoding

`herdi-ios` and `herdi-mac` are in this repo, and `WKWebView` supplies the API the browser lacks:
`WKURLSchemeHandler` registers a custom scheme and serves arbitrary bytes as a **synthetic origin**.

There, "just encode and decode over the WSS" really is the whole implementation. The app owns the
WebView, tunnels requests over the relay socket it already holds open, and serves the decoded
response under something like `herdr-app://3000/`. Consequences:

- Correct, isolated origin per port. Relative and absolute paths resolve inside it.
- No credential sharing — the app's own token never sits in the proxied origin's `localStorage`.
- No URL rewriting, no runtime patching, no service worker.
- Still outstanding: the page's own `WebSocket` needs a separate tunnelled channel, and the relay
  still needs the §7 gate, port allowlist, and audit line — a forwarder is a forwarder regardless of
  who renders the bytes.

**This is the most promising path after Option A**, and the only version of "tunnel it over the
existing WSS" that is structurally sound. It buys nothing for the web app, which is where most usage
is today — hence deferred, not scheduled.

---

## 5. Ready-made products, ranked by security posture

None of these need to be built. Ranked by how much identity is proven before bytes flow. Pricing and
free-tier limits move — verify before committing.

| # | Product | Model | Why it rates here |
|---|---|---|---|
| 1 | **Tailscale Serve** | Publishes `http://127.0.0.1:3000` at an HTTPS MagicDNS name **inside the tailnet only** | Nothing is exposed publicly. Access is device identity on a WireGuard mesh — closest thing to "only my phone can see it". One command: `tailscale serve https / http://127.0.0.1:3000` |
| 2 | **Cloudflare Tunnel + Cloudflare Access** | Option A plus a Zero Trust policy in front | Reuses the existing `cloudflared`. Access enforces SSO / OTP / email-domain rules **at Cloudflare's edge**, so unauthenticated traffic never reaches the host. Free tier has historically covered small teams. Best fit given what is already installed |
| 3 | **Tailscale Funnel** | Same as Serve, but public | Real public URL when someone outside the tailnet must see it. Loses Serve's identity guarantee — treat as public |
| 4 | **Microsoft Dev Tunnels** (`devtunnel`, the thing VS Code's port forwarding uses) | Tunnel with Entra/GitHub identity gating, private by default | Purpose-built for exactly this — publishing a dev server from a workstation. Private-by-default is the right posture. Ties into the Microsoft identity stack |
| 5 | **ngrok** with OAuth / Traffic Policy | Public tunnel plus an auth layer | Mature, good policy engine. Custom domains and most auth features are paid |
| 6 | **Self-hosted: `frp`, `sish`, `rathole`, `bore`** | You run the relay server | Full control, no third party. You own the TLS, the authentication, and the abuse surface. Only sensible if a server already exists |
| 7 | **`trycloudflare` quick tunnels, `localtunnel`** | Public URL, **no authentication** | What `start.sh` uses today for the relay — which is safe only because the relay demands a token itself. A dev server has no such check. Do not publish an app this way |

**Shortlist if this is ever picked up:** Tailscale Serve when the audience is your own devices;
Cloudflare Tunnel + Access when it must be a real public hostname. Both are configuration, not code.

---

## 6. What this repo could add later (small, read-only)

Deliberately **not** a forwarder. The relay never proxies traffic; it only tells you what is
listening and where it is published.

- Relay enumerates listening ports per host (`lsof -iTCP -sTCP:LISTEN -P -n`), routed through the
  same `run_herdr(remote=)` SSH path that already reaches `HERDR_REMOTES`, so remote hosts are
  covered for free.
- Snapshot carries a `ports` list per host: port, process name, Project (matched by cwd).
- Web app grows a Ports panel per Project — port, process, and a link to its published hostname.
- Unpublished ports render as "not published", with the exact `cloudflared` ingress line to add.

Read-only, no new attack surface, and it delivers "open my dev server on my phone in two taps"
without the relay ever becoming a proxy.

---

## 7. Security notes to carry forward

Stated plainly, because this is the part that changes the relay's threat model.

The relay today exposes a **curated** surface: a 24-entry key allowlist, validated Project IDs,
bounded text, per-command audit lines. A generic port proxy (Option B or C) replaces that with an
open forwarder to **any port on the host's loopback**. Everything bound to `127.0.0.1` is written
assuming loopback implies trust — unauthenticated admin UIs, debug endpoints, database ports, other
tools' local APIs. A proxy hands all of it to whoever can reach the relay.

With `HERDR_LAN_OPEN=1` — the current local-mode configuration — that means **any device on the
LAN, with no token.**

If a proxy is ever built despite the above, it needs all of:

1. Its own env gate. Do not fold it into `HERDR_ENABLE_WRITE_EXT`.
2. An explicit **enumerated port allowlist**. Never a range, never "any".
3. A token required on every listener, including the LAN one, regardless of `HERDR_LAN_OPEN`.
4. A per-request audit line, matching what `send_keys` already writes.
5. No credential sharing between the proxied origin and the app's origin (see §4).

Option A satisfies 1–5 by construction: the ingress list *is* the allowlist, Access supplies the
identity check, each app gets its own origin, and the relay never becomes a forwarder at all.
Option D (§8) satisfies them the same way, and additionally removes the public listener entirely.

---

## 8. Option D — Tailscale Serve — **the chosen direction**

Configuration only. No relay change, no web-app change, no new dependency in this repository.

Verified against `tailscale` **1.96.2**, installed on this machine (`/usr/local/bin/tailscale`).

### 8.1 Why it is the answer and not just another option

Options A–C were all reasoning about how to publish something to the *public* internet safely. Serve
sidesteps the question: it never publishes anything publicly. The listener exists only on the
WireGuard mesh, so identity is enforced at layer 3, before a packet reaches the relay at all.

It also happens to solve a second problem this repo has always had. Today the web app is hosted on
`eagerkoder.github.io`, which forces the whole `wss://`-only, mixed-content, `?relay=…&token=…`
hand-off dance documented in `CLAUDE.md`. Under Serve, the relay serves the app **and** the socket on
one real HTTPS origin, and all of that disappears.

### 8.2 Setup

```bash
tailscale up                       # it is currently stopped on this machine
tailscale serve --bg 8375          # publish the relay's LAN listener; see §8.5 on port choice
tailscale serve status             # confirm the mapping
```

Result: `https://<machine>.<tailnet>.ts.net/`

Prerequisite: **MagicDNS** and **HTTPS Certificates** enabled in the tailnet admin console (DNS
settings). Without them Serve has no certificate to issue and the command fails.

Undo: `tailscale serve reset`. The `--bg` config persists across reboots until reset.

### 8.3 What happens on the wire

Two connections, same hostname, same reverse proxy.

**Page load**

1. Browser resolves `<machine>.<tailnet>.ts.net` — MagicDNS, answered by the local `tailscaled`,
   returning the `100.x.y.z` tailnet address.
2. Packets travel over WireGuard straight to the host, or via a DERP relay if no direct path exists.
   Either way they never traverse the public internet in cleartext, and there is no public listener.
3. `tailscaled` on the host listens on `:443` on the tailnet address and terminates TLS with the
   `ts.net` certificate.
4. Serve's reverse proxy forwards plain HTTP to `127.0.0.1:8375`.
5. `process_request` (`relay/herdr_relay.py:817`) matches `GET /` and returns `web/index.html`.

**The WebSocket**

6. `autoRelayUrl` (`web/index.html:2327`) computes
   `(location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host`.
7. `isSelfRelay` (`web/index.html:2328`) excludes only `pages.dev` and `github.io`, so on a `ts.net`
   hostname it is **true** and that URL is used with no configuration at all.
8. `connect()` (`web/index.html:2653`) appends `?token=…` if a token is stored — a browser cannot set
   an `Authorization` header on a `WebSocket`, which is exactly why `process_request` also accepts
   the token as a query parameter.
9. The browser opens a second TLS connection to `tailscaled:443` carrying `Upgrade: websocket`.
10. Serve's proxy passes `Upgrade`/`Connection` through, then hijacks the connection for a
    bidirectional byte copy. It does not parse frames, so ping/pong, binary, and close pass through
    untouched.
11. `process_request` runs its token check **first**, then reaches the `upgrade == "websocket"`
    branch and returns `None`, handing off to the `websockets` handshake and then `handle_client`.

Serve is transparent to the socket. Nothing in the relay or the app is aware of it.

### 8.4 What this removes

| Today (GitHub Pages + Cloudflare quick tunnel) | Under Serve |
|---|---|
| App on `github.io`, relay on `*.trycloudflare.com` — two origins | One origin, `https://<machine>.<tailnet>.ts.net` |
| Mixed content blocks any `ws://` LAN relay | Real certificate, `wss://` throughout |
| Temp tunnel mints a new hostname on every restart | Stable name tied to the machine |
| Relay URL retyped, or handed over as `?relay=…&token=…` | Auto-detected by `isSelfRelay`; nothing to type |
| Token lands in the address bar, history, and screenshots | Token never needs to enter a URL |
| Public listener, reachable by anyone with the hostname | No public listener at all |
| `cloudflared` child process managed by `start.sh` | `HERDR_TUNNEL_MODE=none` |
| CORS paths in `process_request` exercised on every request | Same origin; CORS never used |

### 8.5 Which port to point Serve at — the one real decision

`tailscale serve --bg 8375` targets the **LAN listener**. Under the current local-mode configuration
(`HERDR_LAN_OPEN=1`) that listener requires **no token** by design. Serving it makes it reachable by
every device *and every user account* on the tailnet.

- **Solo tailnet:** acceptable. The mesh is the authentication.
- **Shared tailnet:** this is unauthenticated relay access — including `send_keys` to any pane — for
  everyone on it. Do not do this without a Tailscale ACL restricting the port, or a token.

The tighter arrangement points Serve at the port the design already reserves for exactly this:

```bash
# with HERDR_EXTERNAL_PORT=8376 in the environment
tailscale serve --bg 8376
```

That listener is loopback-bound and **always** demands a token (`require_token=True`, unconditional,
`herdr_relay.py:1322`). The result is tailnet identity *and* the relay token, while 8375 stays purely
local. The only cost is entering the token once per device — the URL is still auto-detected.

**Recommended:** Serve on `HERDR_EXTERNAL_PORT`, leave 8375 to the LAN, keep `HERDR_LAN_OPEN` as-is.

### 8.6 Publishing a dev server too — the original problem

Serve handles the `127.0.0.1:3000` case as well, and it obeys §1's rule: **give each app its own
origin.** Two ways, only one of which is correct.

**Correct — a distinct port, therefore a distinct origin:**

```bash
tailscale serve --bg --https=8443 3000
# https://<machine>.<tailnet>.ts.net:8443
```

Different port means a different origin, so cookies, `localStorage`, and absolute paths are all the
app's own. Nothing is rewritten. Confirm which HTTPS ports your tailnet permits with
`tailscale serve status` — the set is small and fixed (Funnel is limited to 443, 8443 and 10000;
verify Serve's own list locally rather than assuming it matches).

**Wrong — mounting under a path:**

```bash
tailscale serve --bg --set-path=/app3000 3000     # do not do this for a real app
```

This reintroduces §1 in full: the app emits `/assets/index.js`, the browser resolves it against the
origin root, and it misses the mounted path entirely. Fine for a single self-contained page,
broken for anything with subresources.

**Identity headers.** Serve injects `Tailscale-User-Login` / `Tailscale-User-Name` headers on proxied
HTTP requests, identifying the tailnet user behind them. Worth confirming on an actual request rather
than taking on trust — but if present it is a free upgrade for `audit()`, which currently records
only IP and User-Agent. On a tailnet the source IP is already a stable per-device identity.

### 8.7 Costs and caveats — stated honestly

- **Every viewing device must run Tailscale and be logged in.** This is the real trade against a
  public tunnel: there is no longer a link you can send someone. That is the same property that
  makes it secure.
- **Different origin from the Pages deployment.** A PWA installed from `github.io` and one installed
  from `ts.net` are separate installs with separate `localStorage`. Themes, pins, pairs, shortcuts,
  and the stored token do **not** carry over. Expect to set preferences again once.
- **Offline means offline.** With the tailnet down, the app will not load at all — it is served by
  the relay, not by a CDN. The service worker covers a reload, not a cold start.
- **Certificate transparency.** `ts.net` certificates are issued through Let's Encrypt, so the
  machine name and tailnet name appear in public CT logs. The service is not reachable, but the name
  is public. Choose machine names accordingly.
- **DERP fallback.** Without a direct path, traffic relays through Tailscale's DERP servers — still
  end-to-end encrypted, but with added latency. Noticeable on pane reads, not fatal.
- **`serve` is not `funnel`.** `tailscale funnel` publishes to the open internet.
  **Never funnel this relay while `HERDR_LAN_OPEN=1`** — that listener has no token, and with
  `HERDR_ENABLE_TERMINAL=1` also set it would let anyone on the internet send keys to a shell on
  this machine.
- **Not a replacement for the Pages deployment** if you ever want to hand someone a link. The two
  can coexist: Serve for daily personal use, the Cloudflare tunnel spun up only when sharing.

### 8.8 Status

Documented, not adopted. No code, no configuration committed to this repository — the change is
entirely on the machine running the relay. Revisit §6 (the read-only Ports panel) only if publishing
dev servers becomes routine; Serve makes each one a one-line command, which may be enough on its own.
