# Implementation Plan — Phase 2: Fullscreen & PWA Installability

**Spec:** `.workflow/03_specs/2026-08-09_ui_density_spec.md` §§S6, S7, S8
**Architecture:** `.workflow/02_architecture/2026-08-09_ui_shell_layout.md` §§5–6
**Depends on:** `.workflow/04_implementation_plans/2026-08-09_ui_density_plan.md` (Phase 1) — must be
merged and verified first
**Classification:** Class A — feature-only. One additive relay static route; no protocol change.
**Status:** Ready for implementation after Phase 1

## Goal

Reclaim the browser chrome itself. Phase 1 makes the document stop scrolling, which is correct but
means a mobile browser will never collapse its URL bar. Two answers, both wanted:

- **Fullscreen API** — Android only, feature-detected, one gesture. Hides the URL bar *and* the system
  nav bar.
- **PWA install** — iOS and Android, no app store involved. Launches with no browser chrome at all.

### Why this depends on Phase 1

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

### `[MODIFY] web/index.html` — term header (Phase 1 leaves this at back · dot · title · refresh)

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
  <link rel="manifest" href="/manifest.webmanifest">
```

The `data:` URL manifest at line 9 is **replaced**, not kept: a relative `start_url` cannot resolve
against a `data:` base, which is what blocks Chrome installability today.

### `[MODIFY] web/index.html` — `body` safe area

Added to the Phase 1 `body` rule. `box-sizing: border-box` (line 48) keeps the total at exactly one
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
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#e1e2e7",
  "theme_color": "#e1e2e7",
  "icons": [
    { "src": "/logo.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any" }
  ]
}
```

Colours match the previous inline manifest so the splash screen does not change. Cloudflare Pages
serves this from `web/` with no further work.

### `[MODIFY] relay/herdr_relay.py` — manifest route

Appended **below** the `logo.svg` route (ends line 672) and above the 404 fallback, per the ordering
rule at line 611.

```python
    # Serve web app manifest — a real file, not a data: URL, so start_url resolves and
    # Chrome treats the app as installable.
    if path == "/manifest.webmanifest":
        web_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
        manifest_path = os.path.join(web_dir, "manifest.webmanifest")
        if os.path.isfile(manifest_path):
            with open(manifest_path, "rb") as f:
                body = f.read()
            headers = Headers([
                ("Content-Type", "application/manifest+json"),
                ("Cache-Control", "no-cache"),
            ])
            return Response(200, "OK", headers, body)
```

### `[OPTIONAL] web/apple-touch-icon.png` — decide before implementing

iOS ignores manifest icons and accepts PNG only for `apple-touch-icon`; without one the home-screen
icon is a page screenshot. Adding it introduces the repo's first binary web asset plus a third relay
route, so it is called out rather than assumed. To adopt:

```bash
# 180x180 is the current iOS home-screen size
rsvg-convert -w 180 -h 180 web/logo.svg -o web/apple-touch-icon.png
```

then `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` and a route mirroring `/logo.svg`
with `Content-Type: image/png`.

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
curl -si localhost:8375/sw.js      | head -3             # 200 application/javascript
curl -si localhost:8375/           | head -3             # 200 text/html
curl -si localhost:8375/nope       | head -3             # 404

# 3. The data: manifest is gone
grep -n "application/json,{&quot;name" web/index.html    # expect nothing

# 4. Relay suite
.venv313/bin/python -m unittest discover -s tests -t tests
```

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
| M11 | PWA launch, then Phase 1's M1–M8 spot checks | Shell behaves identically to the tab |
| M12 | Load over plain `http://` LAN address | App works; install simply not offered — no error surfaced |

## Acceptance criteria

1. The fullscreen control appears only where `document.documentElement.requestFullscreen` exists,
   toggles both ways, and tracks externally-triggered exits (M1–M5, S6.1–S6.3).
2. Chrome reports the app installable with no manifest errors, and offers *Install app* over HTTPS
   (M6, M7, S7.3).
3. `/manifest.webmanifest` returns 200 with `application/manifest+json` from the relay; `/`, `/sw.js`,
   and `/logo.svg` are unaffected (S7.1, S7.5).
4. iOS standalone launch is chrome-free with no content obscured by the status bar or home indicator,
   in both orientations (M8–M10, S7.4).
5. No document scroll is reintroduced in fullscreen or standalone (M11).
6. `node --test tests/test_pairs.js` and the unittest suite pass unchanged (S8).
7. The `apple-touch-icon` gap is either closed or explicitly deferred in writing.
