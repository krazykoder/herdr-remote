# Implementation Plan — P5: Fullscreen & PWA Installability

**Spec:** `.workflow/03_specs/2026-08-09_ui_density_spec.md` §§S6, S7, S8
**Architecture:** `.workflow/02_architecture/2026-08-09_ui_shell_layout.md` §§5–6
**Depends on:** `.workflow/04_implementation_plans/2026-08-09_p4_ui_density.md` (P4) — must be
merged and verified first
**Classification:** Class A — feature-only. Additive allowlisted static-asset routes; no protocol
change. **Except** the external-listener auth exception below, which is Class B and unresolved:
`.workflow/02_architecture/decision_log/2026-08-09_external_listener_static_shell.md`.
**Status:** Ready for implementation after P4, **minus** the auth section, which is blocked on that
decision. Everything else here — fullscreen, manifest, icons, safe-area — is unblocked.

## Goal

Reclaim the browser chrome itself. P4 makes the document stop scrolling, which is correct but
means a mobile browser will never collapse its URL bar. Two answers, both wanted:

- **Fullscreen API** — Android, iPadOS, and desktop, feature-detected, one gesture. Hides the URL bar *and* the system
  nav bar.
- **PWA install** — iOS and Android, no app store involved. Launches with no browser chrome at all.

### Why this depends on P4

A standalone launch inherits the same layout. Shipping installability on top of a document that still
scrolls would reproduce the clipped composer with no URL bar left to blame it on. Fix the shell,
then remove the chrome.

### Coverage

| Platform | Fullscreen API | PWA standalone | Result |
|---|---|---|---|
| Android Chrome / Firefox | yes | yes | either path removes the URL bar |
| iPhone Safari | **no** — element fullscreen unimplemented, video only | yes | PWA is the only path; ⛶ is not rendered |
| iPadOS Safari 17+ | yes | yes | both |
| Desktop browsers | yes | yes (installable) | ⛶ useful for a focused terminal |

---

## Target

```
Mobile, tab                Mobile, ⛶ (Android)        Mobile, PWA (iOS + Android)
┌────────────────────────┐ ┌────────────────────────┐ ┌────────────────────────┐
│ [ url bar            ] │ │ ‹ ● claude       [⛶][↻]│ │  ●●●     9:41     ▮▮▮  │ status bar
├────────────────────────┤ ├────────────────────────┤ ├────────────────────────┤
│ ‹ ● claude       [⛶][↻]│ │                        │ │ ‹ ● claude       [⛶][↻]│
├────────────────────────┤ │  $ pytest tests/       │ ├────────────────────────┤
│  $ pytest tests/       │ │  10 passed in 2.1s     │ │  $ pytest tests/       │
│  10 passed in 2.1s     │ │  › _                   │ │  10 passed in 2.1s     │
│  › _                   │ │                        │ │  › _                   │
├────────────────────────┤ │                        │ │                        │
│ [/] [ Type… ] [⚡][⌨][➤]│ ├────────────────────────┤ ├────────────────────────┤
└────────────────────────┘ │ [/] [ Type… ] [⚡][⌨][➤]│ │ [/] [ Type… ] [⚡][⌨][➤]│
                           └────────────────────────┘ └──────── ▁▁▁▁▁ ─────────┘
                                                              home indicator,
                                                              cleared by safe-area
```

---

## Changes

### `[MODIFY] web/index.html` — term header (P4 leaves this at back · dot · title · refresh)

```html
      <span class="title" id="termTitle" …><!-- unchanged --></span>
      <button class="refresh-btn" id="fsBtn" onclick="toggleFullscreen()" aria-label="Toggle fullscreen">⛶</button>
      <button class="refresh-btn" onclick="refreshPane()" aria-label="Refresh pane"><!-- unchanged --></button>
```

### `[NEW] web/index.html` — fullscreen logic

```js
    function toggleFullscreen() {
      if (document.fullscreenElement) { document.exitFullscreen(); return; }
      const p = document.documentElement.requestFullscreen();
      if (p && p.catch) p.catch(() => { });   // user denial is not an error worth surfacing
    }
```

State must be reflected on the control, and the browser can leave fullscreen without going through
our handler (Esc, a system gesture), so listen rather than assume (S6.2):

```js
    document.addEventListener('fullscreenchange', () => {
      const b = document.getElementById('fsBtn');
      if (b) b.textContent = document.fullscreenElement ? '⛗' : '⛶';
    });
```

Boot, beside `setFont(currentFont())` — iPhone Safari implements fullscreen for `<video>` only, so
the control is removed rather than left dead (S6.1):

```js
    if (!document.documentElement.requestFullscreen) document.getElementById('fsBtn').remove();
```

### `[MODIFY] web/index.html` — head, PWA metas

`viewport-fit=cover` lets the composer reach the physical bottom edge; it is only safe alongside the
`padding-top` below, because the iOS status bar style is `black-translucent`.

```html
  <meta name="viewport"
    content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="manifest.webmanifest">
```

The `data:` URL manifest at line 9 is **replaced**, not kept: a relative `start_url` cannot resolve
against a `data:` base, which is what blocks Chrome installability today.

### `[MODIFY] web/index.html` — `body` safe area

Added to the P4 `body` rule. `box-sizing: border-box` (line 48) keeps the total at exactly one
viewport, so this does not reintroduce a document scroll.

```css
      padding-top: env(safe-area-inset-top, 0px);
```

The bottom docks already carry `padding-bottom: env(safe-area-inset-bottom, 8px)` (line 623) and need
no change.

### `[NEW] web/manifest.webmanifest`

```json
{
  "name": "herdr-remote",
  "short_name": "herdr",
  "start_url": "./",
  "scope": "./",
  "display": "standalone",
  "background_color": "#e1e2e7",
  "theme_color": "#e1e2e7",
  "icons": [
    { "src": "icons/herdr-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "icons/herdr-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" }
  ]
}
```

Colours match the previous inline manifest so the splash screen does not change. Cloudflare Pages
serves this from `web/` with no further work.

### `[MODIFY] relay/herdr_relay.py` — allowlisted static assets

Append the routes below the existing event-push handling and alongside the current static routes, above
the 404 fallback. Keep the existing route order intact. Use one small allowlisted asset map rather
than a filesystem path derived from the request URL; no traversal or arbitrary file serving.

```python
    STATIC_ASSETS = {
        "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
        "/icons/herdr-180.png": ("icons/herdr-180.png", "image/png"),
        "/icons/herdr-192.png": ("icons/herdr-192.png", "image/png"),
        "/icons/herdr-512.png": ("icons/herdr-512.png", "image/png"),
    }
    asset = STATIC_ASSETS.get(path)
    if asset:
        relative_path, content_type = asset
        web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
        asset_path = os.path.join(web_dir, relative_path)
        if os.path.isfile(asset_path):
            with open(asset_path, "rb") as f:
                body = f.read()
            headers = Headers([
                ("Content-Type", content_type),
                ("Cache-Control", "no-cache"),
            ])
            return Response(200, "OK", headers, body)
```

### `[NEW]` PNG icons

iOS ignores manifest icons and accepts PNG only for `apple-touch-icon`. Generate and commit three
PNG sizes from `web/logo.svg`:

```bash
# Use the available native converter (or an equivalent checked-in asset generation command).
sips -s format png --resampleHeightWidth 192 192 web/logo.svg --out web/icons/herdr-192.png
sips -s format png --resampleHeightWidth 512 512 web/logo.svg --out web/icons/herdr-512.png
sips -s format png --resampleHeightWidth 180 180 web/logo.svg --out web/icons/herdr-180.png
```

Verified on this machine: `sips` renders `web/logo.svg` (square, `viewBox="0 0 512 512"`) to a
192×192 PNG with an alpha channel, so no extra tooling is needed.

Add `<link rel="apple-touch-icon" href="icons/herdr-180.png">` beside the manifest link.

**Alpha caveat for the 180px icon.** iOS composites a transparent home-screen icon onto black, which
will not match the `#e1e2e7` splash. Check the rendered icon on a device; if it reads badly, generate
the 180px variant from a copy of the SVG with an opaque `#e1e2e7` background rect rather than
post-processing the PNG. Android is unaffected — `purpose: "any"` icons keep their transparency.

### `[BLOCKED]` external static-shell authentication — **do not implement without sign-off**

Tracked as Class B, Proposed:
`.workflow/02_architecture/decision_log/2026-08-09_external_listener_static_shell.md`. The
recommendation there is *not* to make this change: install the PWA from the Cloudflare Pages origin,
which is already the deployment target and already public, and leave the relay's HTTP surface fully
gated. What follows is the fallback implementation if the exception is accepted instead.

The external listener currently authenticates every HTTP request (`relay/herdr_relay.py:564` — the
docstring states the gate covers the whole HTTP surface). A PWA cannot launch that way: the manifest,
service worker and icon requests are issued **by the browser**, against a resolved URL that does not
inherit the document's `?token=` query string, and a standalone launch navigates to `start_url` with
no token at all. Reading the token from `localStorage` cannot help, because the app's JavaScript
never issues those requests. Note this already breaks `sw.js` registration — and therefore push — over
the tunnel today; it is a pre-existing bug, not one P5 introduces.

On the external listener, allow unauthenticated `GET`/`HEAD` only for this exact static allowlist:

```text
/, /index.html, /manifest.webmanifest, /sw.js, /logo.svg,
/icons/herdr-180.png, /icons/herdr-192.png, /icons/herdr-512.png
```

Keep the token requirement for WebSocket upgrades, event-push requests, VAPID/API requests, and
every other path. The LAN listener keeps its existing configured policy. Do not trust `Origin`,
`Host`, forwarded headers, or source IP to infer access.

The public shell contains no agent snapshot or control data. After launch, the browser uses the
token in `localStorage` for the authenticated WebSocket connection.

---

## Install instructions (for the README / Settings hint, not code)

A PWA is the site itself — no store, no signing, no review.

- **iPhone / iPad, Safari:** Share → *Add to Home Screen*. Launches chrome-free.
- **Android, Chrome:** ⋮ → *Install app*.
- **Requires HTTPS.** The Cloudflare tunnel URL qualifies; a bare `http://192.168.x.x` LAN address
  does not — Android will not offer installation, and iOS will add a shortcut that still shows chrome.

---

## Verification

```bash
# 1. Manifest is valid JSON
python3 -m json.tool web/manifest.webmanifest

# 2. Served correctly, and no existing route was shadowed or reordered
uv run relay/herdr_relay.py &
curl -si localhost:8375/manifest.webmanifest | head -5   # 200 + application/manifest+json
curl -si localhost:8375/logo.svg   | head -3             # 200 image/svg+xml
curl -si localhost:8375/icons/herdr-192.png | head -3   # 200 image/png
curl -si localhost:8375/icons/herdr-512.png | head -3   # 200 image/png
curl -si localhost:8375/icons/herdr-180.png | head -3   # 200 image/png
curl -si localhost:8375/sw.js      | head -3             # 200 application/javascript
curl -si localhost:8375/           | head -3             # 200 text/html
curl -si localhost:8375/nope       | head -3             # 404

# 3. The data: manifest is gone
grep -n "application/json,{&quot;name" web/index.html    # expect nothing

# 4. Relay suite
.venv313/bin/python -m unittest discover -s tests -t tests
```

**Only if the Class B auth exception is accepted**, verify the boundary separately with the external
listener enabled: static shell paths return 200 without a token; WebSocket upgrade,
`/api/vapid-public-key`, event-push, and unknown paths return 401 without one and succeed with the
correct token. If the recommendation stands instead, verify the opposite — every external path,
static assets included, still returns 401 without a token — and install the PWA from the Cloudflare
Pages origin.

Manual:

| # | Check | Expected |
|---|---|---|
| M1 | Android Chrome → ⛶ | True fullscreen; URL bar and system nav gone |
| M2 | Same, ⛶ again | Restores; icon reflects state |
| M3 | Same, leave fullscreen via system back/Esc | Icon reflects state — no stale ⛗ |
| M4 | iPhone Safari, open a pane | No ⛶ button rendered at all |
| M5 | Desktop Chrome → ⛶ | Fullscreen; composer still on the fold, no scrollbar |
| M6 | Chrome DevTools → Application → Manifest | Installable; no blocking errors |
| M7 | Android Chrome ⋮ | *Install app* offered (over HTTPS) |
| M8 | iOS Safari → Share → Add to Home Screen → launch | No browser chrome |
| M9 | Same, in the terminal view | Nothing under the status bar; composer clears the home indicator |
| M10 | Same, rotate to landscape | No content under the notch or home indicator |
| M11 | PWA launch, then P4's M1–M8 spot checks | Shell behaves identically to the tab |
| M12 | Load over plain `http://` LAN address | App works; install simply not offered — no error surfaced |

## Acceptance criteria

1. The fullscreen control appears only where `document.documentElement.requestFullscreen` exists,
   toggles both ways, and tracks externally-triggered exits (M1–M5, S6.1–S6.3).
2. Chrome reports the app installable with no manifest errors, and offers *Install app* over HTTPS
   (M6, M7, S7.3).
3. `/manifest.webmanifest` returns 200 with `application/manifest+json` from the relay; `/`, `/sw.js`,
   `/logo.svg`, and all PNG icons are unaffected (S7.1, S7.5).
4. iOS standalone launch is chrome-free with no content obscured by the status bar or home indicator,
   in both orientations (M8–M10, S7.4).
5. No document scroll is reintroduced in fullscreen or standalone (M11).
6. `node --test tests/test_pairs.js` and the unittest suite pass unchanged (S8).
7. The 192px, 512px, and 180px PNG icons exist, are served with `image/png`, and the 180px icon is
   referenced by `apple-touch-icon`.
