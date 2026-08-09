# Decision — How the PWA shell is served over the external listener

**Date:** 2026-08-09
**Status:** **Proposed — needs sign-off before P5 is implemented**
**Class:** **B** — architectural extension. It amends an access-control invariant frozen four commits
ago (`301df19`, "dual listeners for token-free LAN and token-required tunnel") and recorded in
`relay/herdr_relay.py:564` — `require_token` "gates the whole HTTP surface — the WebSocket upgrade,
GET / serving the web app, and the event-push endpoint". Audit required. This is **not** the Class A
change the P5 plan header claimed.

## Problem

Browsers issue sub-resource requests themselves, against the resolved URL, and those requests do not
inherit the document's query string. Over the tunnel the app is reached as
`https://<tunnel>/?token=…`, so:

- `<link rel="manifest" href="manifest.webmanifest">` → `GET /manifest.webmanifest`, no token → 401.
- `navigator.serviceWorker.register('sw.js')` → `GET /sw.js`, no token → 401. **This is already
  broken today**, which means service-worker registration and therefore push notifications do not
  work over the external listener. P5 surfaces the bug; it does not create it.
- `<link rel="apple-touch-icon">` and the manifest icons → same, 401.
- A standalone launch navigates to the manifest's `start_url` (`./` → `/`) with no token at all, so
  even the document 401s and the installed app opens to "Invalid token".

Storing the token in `localStorage` does not help: the app's JavaScript never issues these requests.

## Options

**A — Serve the app from Cloudflare Pages; the tunnel carries data only.** The web app is already
deployed to Pages on push to `main`, and clients already point at a *different* origin's `wss://`
relay, so cross-origin is the normal mode. Install the PWA from the Pages origin, where every asset
is genuinely static and public by design. The relay's HTTP surface stays fully token-gated, and the
only thing that must cross the tunnel is the WebSocket, which already carries `?token=`.
*Relay change: none.*

**B — Allowlist the static shell as unauthenticated on every listener.** `/`, `/index.html`,
`/manifest.webmanifest`, `/sw.js`, `/logo.svg`, `/icons/*` served without a token; WebSocket
upgrades, event push, `/api/*`, and all other paths stay gated. Straightforward and it fixes the
`sw.js` bug for relay-origin use. Cost: an unauthenticated visitor to the tunnel URL receives the
app shell instead of an opaque 401, which turns the endpoint from indistinguishable-from-nothing
into a discoverable herdr relay. No agent state and no control capability leak — the shell is public
source already — but discoverability is the thing the blanket gate was buying.

**C — Propagate the token into sub-resource URLs.** `manifest.webmanifest?token=…`,
`register('sw.js?token=…')`, `start_url: "./?token=…"`. Keeps the gate absolute, but the manifest
must then be generated per-token by the relay rather than served as a file, and the token ends up
baked into the installed home-screen shortcut. Most moving parts, worst secret hygiene.

## Recommendation

**A.** It is the only option that changes no access control at all, it needs no relay code, and it
uses the deployment path that already exists. B is the fallback if installing directly from the
tunnel origin turns out to be a requirement — in which case this entry gets re-opened, accepted
explicitly, and the discoverability cost is accepted in writing rather than inherited from a plan
header. C is rejected.

Under A, P5 keeps everything else — fullscreen, the real manifest file, the PNG icons, `viewport-fit`
and safe-area handling — and drops only the relay auth exception. The relay still needs its
allowlisted static-asset routes so the LAN listener (which runs token-free under `HERDR_LAN_OPEN=1`)
and local use serve the manifest and icons.

## Consequence if left unresolved

P5 cannot be implemented as written: spec S7.7 and the P5 plan's "external static-shell
authentication" section both assume option B was accepted.
