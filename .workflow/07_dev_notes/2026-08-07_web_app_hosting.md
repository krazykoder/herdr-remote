# Web App Hosting — Options, Risks, Decision

**Date:** 2026-08-07
**Status:** Decided — Option B (GitHub Pages + Cloudflare tunnel)
**Scope:** `web/index.html` delivery and relay connectivity. macOS/iOS apps (`herdi-mac/`, `herdi-ios/`) are out of scope and will not be worked on.

---

## Background

`herdr-remote` splits into two things that can live at different origins:

1. **The page** — `web/index.html`, a single self-contained file (inline CSS/JS, no build step, no third-party scripts).
2. **The relay** — `relay/herdr_relay.py`, which the page talks to over a WebSocket.

The relay already does both jobs. It serves the web app over HTTP (`herdr_relay.py:385-430`, routes for `/`, `/index.html`, `/sw.js`, `/logo.svg`, `/api/vapid-public-key`) and binds `0.0.0.0` (`:596`), so it is reachable across the LAN with no changes.

Because the relay can serve the page itself, "where do I host the web app" is genuinely optional. The choice is really: **same origin or split origin**, and if split, **whose domain**.

### Why this is a security question and not a preference

The relay is not a read-only dashboard. Clients send `respond`, `send_keys`, and `send_text` — these type directly into terminal panes running AI agents. Whoever controls the JavaScript on the page controls:

- the `HERDR_RELAY_TOKEN` stored in `localStorage` (`index.html:326`)
- a live authenticated WebSocket that can drive your shell
- a service worker using `skipWaiting()` + `clients.claim()` (`sw.js:2-3`), which activates new versions immediately and persists after the tab closes

So "who serves the HTML" is equivalent to "who can execute code against my terminal." That framing drove the decision.

---

## The three options

### Option A — Relay serves the page (same origin)

```bash
cd relay && uv run herdr_relay.py
cloudflared tunnel --url http://localhost:8375
```

One origin serves the HTML *and* upgrades to WebSocket.

**Pros**

- No third party in the page-delivery path at all. Nothing to trust beyond code already on disk.
- Auto-detect works with zero configuration. `index.html:276` builds the relay URL from `location.host`, so the page always points at the origin that served it.
- Token stays on an origin only this relay uses.
- Works on plain LAN HTTP (`http://192.168.86.41:8375/`) and through a tunnel, unchanged.

**Cons**

- The page is only reachable when the relay is running.
- With a temp tunnel, the app URL itself changes on every restart, so bookmarks go stale (though you simply visit the new URL — nothing to re-paste).
- No CDN, no stable public bookmark.

**Security:** best available. Rejected only for ergonomics, not for risk.

---

### Option B — GitHub Pages hosts the page, Cloudflare tunnel exposes the relay *(CHOSEN)*

Page at `https://<user>.github.io/<repo>/`. Relay at `wss://<tunnel-hostname>`. Two origins.

**Pros**

- Stable, bookmarkable app URL that never changes.
- The page loads even when the relay is down (shows the setup screen rather than a connection error).
- You control every byte deployed and can review diffs before publishing — the supply-chain concern that rules out Option C does not apply.
- Secure context, so service worker / PWA install / Web Push all work.
- CDN delivery.

**Cons**

- **Manual relay-URL entry.** Split origin means auto-detect cannot work. With a *temp* tunnel the hostname changes on every relay restart, so you re-paste into ⚙ on every device each time. This is the accepted inconvenience — mitigated by using a **named tunnel** (see below), which makes it a one-time paste.
- **No plain-LAN access through this URL.** `https://<user>.github.io` cannot open `ws://192.168.86.41:8375` — browsers block insecure WebSockets from a secure page, and no flag or header changes this. LAN use must go through `http://192.168.86.41:8375/` (Option A's path) instead. Two entry points for the same app.
- **Shared origin across your GitHub Pages sites.** Everything under `<user>.github.io/*` is one origin, so the relay token in `localStorage` is readable by any other page hosted on that account.
- GitHub still serves the bytes — the same *class* of third party as Cloudflare. The meaningful difference is that you author the content.

**Compatibility — verified against the source, not assumed:**

| Concern | Finding |
|---|---|
| Cross-origin WebSocket | Accepted. `serve()` (`herdr_relay.py:596`) passes no `origins=` argument; `handle_client` only *logs* the Origin header (`:441`, `:460`), never validates it. |
| VAPID key fetch | CORS is configured (`Access-Control-Allow-Origin: *`, `:418`), but a configured relay token currently protects this route before it is reached. Defer that token-flow fix with the wider authentication work. |
| Push subscription | Works. Travels over the WebSocket as `push_subscribe` (`index.html:868`), so CORS is not involved. |
| Secure context | Yes — `https://` on github.io, so service worker and Web Push are available. |
| Token transport | The app appends `?token=` to the WebSocket URL itself (`index.html:339-341`). Enter it in the ⚙ token field, not in the URL. |

**GitHub Pages compatibility fixes implemented:**

`index.html:279`

```js
const isSelfRelay = !isDemo && !location.hostname.includes('pages.dev') && !location.hostname.includes('github.io') && !location.hostname.includes('localhost');
```

`<user>.github.io` now reaches the setup screen instead of auto-filling `wss://<user>.github.io` and retrying a dead socket every three seconds.

GitHub project pages also live below `/<repo>/`. Service-worker registration, icons, and notification links now resolve from `document.baseURI` / the service-worker scope, so PWA and push work under the repository path.

---

### Option C — Author's hosted page (`herdr-demo.pages.dev`) *(REJECTED)*

The upstream-recommended path: open the author's page, paste your own `wss://` tunnel URL.

**Data flow is fine.** Reviewed `web/index.html` and `web/sw.js` in this checkout: the page is fully self-contained — no third-party `<script src>`, no analytics, no beacons. Exactly one outbound `fetch` (`index.html:857`), to `/api/vapid-public-key` on *your* relay. Cloudflare Pages serves bytes and does not proxy the WebSocket. Agent data goes browser → your tunnel, not to the author.

**So why reject it:**

1. **Unpinned third-party code with terminal access.** You are not trusting the current version of that page; you are trusting every future version. One commit upstream — no notice, no version pin, no subresource integrity — and the JavaScript holding your relay token and a live `send_keys` socket becomes hostile. The data-flow analysis above describes today only.
2. **Unverified deployment.** The audit above covers the source in this checkout. The live `herdr-demo.pages.dev` was never fetched and compared; it deploys from a repo we do not control.
3. **Silent fallback to the author's relay.** `index.html:278` sets `isDemo` true on `herdr-demo.pages.dev`, making the *default* relay `wss://herdr-remote-demo.yyrzrh5wfg.workers.dev` — the author's Cloudflare Worker. A pasted URL overrides it via `localStorage`, but clearing site data or using a private window silently reverts to the author's Worker. It only serves fake demo agents, but it is a default we did not choose.
4. **Token on someone else's origin.** Any XSS on that domain, or any script added upstream, reads `HERDR_RELAY_TOKEN`.

Documentation note: README references `herdr-demo.pages.dev` (demo default), QUICKSTART references `herdr-remote.pages.dev` (no demo default, blank setup screen). Different behavior, easy to confuse.

---

## Decision

**Option B — GitHub Pages + Cloudflare tunnel.**

Rationale: it removes the only unacceptable risk (third-party JavaScript with terminal access) while delivering a stable URL and offline-loading page. The cost is a copy-paste of the relay URL into settings, which a named tunnel reduces to once per device.

Option A remains strictly simpler and marginally safer, and stays in use as the **LAN entry point** — GitHub Pages cannot reach a plain-HTTP LAN relay, so `http://192.168.86.41:8375/` covers that case. The two options coexist rather than compete.

### Resulting topology

| Context | URL | Origin | Notes |
|---|---|---|---|
| Local dev | `http://localhost:8375/` | relay | Paste `ws://localhost:8375` once — `isSelfRelay` excludes `localhost` by design |
| LAN | `http://192.168.86.41:8375/` | relay | Auto-detects. No PWA/push — plain HTTP on a LAN IP is not a secure context |
| Remote | `https://<user>.github.io/<repo>/` | GitHub | Paste relay `wss://` URL + token once (with a named tunnel) |

---

## Security requirements — not optional

- **Set `HERDR_RELAY_TOKEN` before the first tunnel, not after.** It defaults to empty (`herdr_relay.py:47`), and with no Origin validation the token is the only thing preventing an arbitrary web page from opening a socket to your tunnel hostname and issuing `send_keys`.

  ```bash
  export HERDR_RELAY_TOKEN="$(openssl rand -hex 32)"
  ```

- **The token is also accepted as a `?token=` query parameter** (`herdr_relay.py:340-344`), so it can land in proxy logs and browser history. See the deferred token note below.

## Token handling — deferred

The relay token is **not committed or deployed**. Each browser user enters it locally; the page stores it in that browser's `localStorage` and opens a direct `wss://<tunnel-host>` connection to the relay.

TLS protects the token from the local network and ISP, but Cloudflare terminates TLS for the public tunnel. Because the current client puts the token in the WebSocket query string, Cloudflare and any debug/request logging around the tunnel can see it. Do not enable `cloudflared` debug logging; it records request URLs and headers.

This is accepted for the initial personal-dashboard setup: use a high-entropy token, trust Cloudflare as the tunnel provider, and rotate the token if it is exposed. It is not appropriate when Cloudflare must not be able to read agent output or credentials; use Tailscale/WireGuard in that case. A later protocol change can authenticate in the first WebSocket message to remove query-string/log leakage, but it does not hide session traffic from Cloudflare.

- **Cloudflare terminates TLS on the tunnel.** Cloudflare (the company) can see plaintext agent output and approval prompts. This is true of *every* tunnel option here, including Option A — it is not author-specific. If agent panes display credentials or private source, this is the larger exposure, and the argument for Tailscale/WireGuard over a public tunnel.

- **`herdr-remote.pages.dev` / `herdr-demo.pages.dev` should not be used** with a live relay, per the Option C analysis.

---

## Environment state (verified 2026-08-08)

- `.venv313` — CPython 3.13.7, deps installed from `relay/requirements.txt`. 44/44 tests pass (`.venv313/bin/python -m unittest discover -s tests -t tests`).
- Relay boots and serves: `http://localhost:8375/` → 200, `http://192.168.86.41:8375/` → 200, `/sw.js` → 200.
- `cloudflared` — installed, version `2026.7.3`; no Cloudflare origin certificate or named-tunnel configuration exists yet.
- `herdr` — present at `/opt/homebrew/bin/herdr`.
- Web Push — **inert**. `HERDR_VAPID_PUBLIC` / `HERDR_VAPID_PRIVATE` unset, so `/api/vapid-public-key` returns `{"publicKey": ""}` and the UI reports "VAPID key not configured on relay".

---

## Implementation checklist

1. [x] Exclude `github.io` in `isSelfRelay`, so GitHub Pages shows the setup screen.
2. [x] Resolve service-worker assets from the GitHub Pages project path rather than `/`.
3. [x] Add a GitHub Actions workflow publishing `web/` to GitHub Pages; select **GitHub Actions** as the repository's Pages source after pushing it.
4. [x] Install `cloudflared`.
5. Generate and export `HERDR_RELAY_TOKEN`.
6. Create a **named** tunnel so the relay hostname is stable and the URL is pasted once, not once per restart:
   ```bash
   cloudflared tunnel create herdr
   cloudflared tunnel route dns herdr relay.example.com
   # Create ~/.cloudflared/config-herdr.yml with the generated credential path:
   # tunnel: herdr
   # credentials-file: ~/.cloudflared/<tunnel-id>.json
   # ingress:
   #   - hostname: relay.example.com
   #     service: http://localhost:8375
   #   - service: http_status:404
   HERDR_TUNNEL_MODE=named HERDR_TUNNEL_NAME=herdr relay/start.sh
   ```
   `relay/start.sh:47-60` already supports this and reads `~/.cloudflared/config-herdr.yml`.
7. Generate VAPID keys and export `HERDR_VAPID_PUBLIC` / `HERDR_VAPID_PRIVATE` to enable Web Push.
8. Optional hardening: put Cloudflare Access in front of the named tunnel, replacing the shared secret with real SSO.

## Deferred

- Fix stale `Makefile` targets — `relay-run` points at `relay/herdi_relay.py`; the actual file is `relay/herdr_relay.py`.
- Consider Origin validation in `handle_client` (`herdr_relay.py:441`) as defense in depth alongside the token.
