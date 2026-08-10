# Decision — How the PWA shell is served over the external listener

**Date:** 2026-08-09
**Status:** **Accepted — option A.** The relay's HTTP surface stays fully token-gated. The web app and
PWA are hosted from a static HTTPS origin (Cloudflare Pages today, GitHub Pages intended); the tunnel
carries relay traffic only.
**Class:** B — it was raised as an amendment to a frozen access-control invariant
(`301df19`, "dual listeners for token-free LAN and token-required tunnel";
`relay/herdr_relay.py:564` — `require_token` "gates the whole HTTP surface"). **Resolved by not
amending it.** No access control changes, so no audit is triggered.

## Problem

Browsers issue sub-resource requests themselves, against the resolved URL, and those requests do not
inherit the document's query string. Over the tunnel the app is reached as
`https://<tunnel>/?token=…`, so:

- `<link rel="manifest">`, `navigator.serviceWorker.register('sw.js')`, `apple-touch-icon` and the
  manifest icons all arrive with no token → 401. Service-worker registration, and therefore push,
  **already fail over the external listener today**.
- A standalone launch navigates to `start_url` with no token at all, so even the document 401s.

Storing the token in `localStorage` does not help: the app's JavaScript never issues these requests.

## Options considered

**A — Host the app on a static HTTPS origin; the tunnel carries data only.** *Adopted.*
**B — Allowlist the static shell as unauthenticated on every listener.** Rejected: it turns the tunnel
endpoint from indistinguishable-from-nothing into a discoverable herdr relay. No agent state or
control capability would leak, but discoverability is what the blanket gate buys, and the stated goal
is not to loosen security.
**C — Propagate the token into sub-resource URLs** (`manifest.webmanifest?token=`, `start_url:
"./?token="`). Rejected: the manifest would have to be generated per-token, and the token ends up
baked into the installed home-screen shortcut.

## Consequences

**1. Mixed content splits hosting into two non-overlapping modes.** A page served over HTTPS cannot
open a `ws://` connection. So:

| App served from | Can reach | Installable |
|---|---|---|
| Static HTTPS origin (Pages) | `wss://` tunnel only | yes — full PWA, service worker, push |
| Relay over `http://<lan-ip>:8375` | `ws://` LAN **and** `wss://` tunnel | no real install (see 2) |

LAN-direct use therefore keeps working exactly as today, in a browser tab served by the relay.

**2. "Install over LAN, then use it over the tunnel" does not work off-LAN.** Recorded because it was
proposed as a fallback. An app installed from `http://192.168.x.x:8375` loads its document from that
origin at every launch, and a plain-http LAN address is not a secure context, so no service worker
can cache the shell to make it launchable offline. Off the LAN the launch simply fails. Android
Chrome will not offer a real install there at all (no secure context, no service worker); iOS *Add to
Home Screen* does produce a standalone window, but only usable while on the LAN, and with no push. A
static HTTPS origin is the only path to an installable app usable from anywhere.

**3. The relay keeps its allowlisted manifest and icon routes.** Independent of this decision: the
LAN listener runs token-free under `HERDR_LAN_OPEN=1`, and a LAN browser tab or an iOS home-screen
shortcut should not 404 on them. Additive, Class A.

**4. The `sw.js`-over-tunnel 401 is resolved by architecture, not by code.** The service worker lives
on the Pages origin, where it registers normally and push works. Loading the app *directly* from the
tunnel origin remains a degraded mode — no service worker, no push, no install — and that is
documented rather than fixed, because fixing it means option B.

**5. Origin is not enforced, so cross-origin already works.** `handle_client` reads the `Origin`
header for the connection log only (`relay/herdr_relay.py:683, 706`). A Pages-hosted app connecting
to `wss://<tunnel>/?token=…` needs no relay change.

**6. Separate bug, found while resolving this — the VAPID fetch sends no token.**
`web/index.html:2316` does `fetch(httpUrl + '/api/vapid-public-key')` with no credentials, so
enabling push against the external listener 401s and surfaces as a JSON parse error. The relay
already accepts `?token=` (`herdr_relay.py:578–584`), so the fix appends the stored token and
loosens nothing. Tracked with P5's push work.

**7. Cloudflare Pages vs GitHub Pages is immaterial here.** Both are static HTTPS origins with no
secrets. Current deployment is Cloudflare Pages on push to `main`; the intent is to move to GitHub
Pages. This decision holds either way.
