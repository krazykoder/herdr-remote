# Spec — Web UI Density, Shell Layout, Text Size

**Date:** 2026-08-09
**Architecture:** `.workflow/02_architecture/2026-08-09_ui_shell_layout.md`
**Classification:** Class A
**Status:** Draft — corrected and ready for implementation

Behaviour only. Selectors and line numbers live in the plans, not here.

**Delivered in two phases.** Both are wanted; the split exists because a standalone or fullscreen
launch inherits the shell, so shipping chrome removal on top of a document that still scrolls would
reproduce the clipped composer with nothing left to blame.

| Phase | Spec sections | Plan |
|---|---|---|
| 1 — Shell, density, text size | S1–S5, S8 | `.workflow/04_implementation_plans/2026-08-09_p4_ui_density.md` |
| 2 — Fullscreen, PWA installability | S6, S7, S8 | `.workflow/04_implementation_plans/2026-08-09_p5_fullscreen_pwa.md` |

---

## S1 — Shell height model

**S1.1** The document must not scroll at any viewport size, in any view, with any amount of content.
`body` occupies exactly one viewport height.

**S1.2** Exactly one scroller is reachable at a time, and it is the one belonging to the active view:
the agent list, the timeline, the settings panel, or the terminal content.

**S1.3** The composer (`.term-input`) is fully visible without scrolling whenever the terminal view is
active, on every supported viewport, both orientations.

**S1.4** No layout rule may encode the header's height as a literal pixel value.

**Edge cases**

| Case | Required behaviour |
|---|---|
| Terminal content shorter than the pane | No scrollbar; composer stays pinned to the bottom |
| 5000 lines loaded via `loadMore()` | Terminal content scrolls internally; shell height unchanged |
| Settings panel taller than the viewport (small phone, landscape) | Settings scrolls internally |
| Timeline with hundreds of entries | Timeline scrolls internally |
| Keys dock and quick dock open | Terminal content shrinks; composer and dock remain fully on screen |
| Pair strip visible (paired pane) plus a wrapped stale-reason line | Terminal content shrinks; nothing clips |
| On-screen keyboard raised | Shell resizes; composer sits directly above the keyboard |

**Failure modes**

- A scrolling flex child added without `min-height: 0` reintroduces the outer scrollbar. This is the
  regression to test for first.
- `100dvh` is unsupported below iOS 15.4 / Chrome 108; a `100vh` fallback must precede it. On those
  browsers the shell is one *large* viewport tall, so the composer may sit under the URL bar — an
  accepted degradation, not a correctness failure.

## S2 — View exclusivity

**S2.1** Opening a pane hides the agent list, the timeline, and the settings panel.

**S2.2** Closing a pane restores the agent list, and only the agent list.

**S2.3** Toggling settings or timeline while a pane is open is not reachable on mobile (the app header
is hidden per S3.1). On desktop, the action first closes the terminal, then opens the selected panel;
two flex panes are never simultaneously visible.

> Rationale: with the terminal as a flex sibling rather than a fixed overlay, two simultaneously
> visible panes would stack rather than overlay. Previously this was masked, not handled.

## S3 — Density

**S3.1** While a pane is open on a viewport narrower than 768px, the app header is not rendered. At
768px and wider it remains rendered.

**S3.2** Connection status stays visible in every state: while a pane is open the status indicator is
present in the terminal header, and it reflects the same three states as the app header's
(`connected` / `connecting` / `disconnected`) from a single update path.

**S3.3** Every interactive control retains a minimum 44×44px hit area at the default text size.

**S3.4** Chrome padding is reduced per the architecture doc §4; no control may become clipped or
overlap another at any supported width, including the 380px breakpoint.

## S4 — Prompt shortcuts

**S4.1** The dedicated instruction row is removed. The prompt list opens from a **`P` button in the
composer, immediately right of the `/` command button**, into its own dock above the composer. It
costs no vertical space while closed.

**S4.2** Prompt entries insert at the cursor position in the composer and never send. This existing
behaviour is unchanged.

**S4.3** The prompt list has exactly one render path and one source array. No second copy exists.

**S4.4** Choosing a prompt closes the dock, so the inserted text is visible in the composer.

**S4.5** The keys dock, quick-actions dock, and prompts dock share the space above the composer;
opening one closes the others. At most one is open at a time.

## S5 — Text size

**S5.1** Settings exposes a text-size control with decrement, current value, and increment.

**S5.2** Range 12–22px inclusive, step 1, default 16. Values outside the range are clamped, not
rejected. A stored non-numeric value falls back to the default.

**S5.3** The chosen size is the document root font size. Everything expressed in `rem` scales with it;
everything expressed in `px` does not, so touch targets hold at the small end.

**S5.4** The setting persists across reloads under `localStorage` key `herdr_font_size`, matching the
existing `herdr_*` key convention.

**S5.5** The stored size is applied before first paint. No flash of default-sized text.

**S5.6** At the increment/decrement bounds the corresponding control is disabled, not silently inert.

**Failure modes**

- `localStorage` unavailable (private mode, storage disabled): the control still works for the
  session; persistence is skipped without throwing.

## S6 — Fullscreen · *P5*

**S6.1** A fullscreen toggle is rendered in the terminal header **only** where the Fullscreen API is
available on the document element. It is absent, not disabled, elsewhere — notably iPhone Safari.

**S6.2** Activating it makes the app fill the screen; activating it again restores. The control
reflects the current state.

**S6.3** A rejected fullscreen request (user denial, unsupported context) leaves the UI unchanged and
raises nothing to the user.

## S7 — PWA installability · *P5*

**S7.1** The manifest is served as a real file at a same-origin path, from both the relay and the
static Pages origin, with `Content-Type: application/manifest+json`. Installability is only claimed
for the Pages origin; see S7.7 and S7.9.

**S7.2** The manifest declares `name`, `short_name`, relative `start_url: "./"`, relative
`scope: "./"`, `display: standalone`, `background_color`, `theme_color`, and 192px/512px PNG icons.

**S7.3** Chrome reports the app as installable (Lighthouse "Installable" / DevTools → Application →
Manifest shows no blocking errors).

**S7.4** Launched from the iOS home screen, the app renders with no browser chrome and no content
obscured by the status bar or home indicator.

**S7.5** Adding the manifest route must not shadow or reorder any existing relay route.

**S7.6** The iOS home-screen icon is a committed 180px PNG referenced by `apple-touch-icon`; it is
not deferred.

**S7.7** Relay access control is unchanged. The external listener continues to require a token for
every HTTP request, static assets included. The installable PWA is served from a static HTTPS origin
(Pages), not from the relay — decision:
`.workflow/02_architecture/decision_log/2026-08-09_external_listener_static_shell.md`.

**S7.8** The relay serves the manifest and icons from an allowlisted static-asset map, on whichever
listeners already serve `/index.html` and under the same authentication those listeners already
apply. The LAN listener runs token-free under `HERDR_LAN_OPEN=1`, so a LAN tab must not 404 on them.

**S7.9** Loading the app directly from the tunnel origin is a supported but degraded mode: no service
worker, no push, no install. It must not error or appear broken — the app works, those three features
are simply unavailable.

**S7.10** Enabling push against a token-gated listener must succeed. The VAPID key request carries the
stored token as `?token=`, which the relay already accepts.

**S7.11 — offline shell.** The installed app launches from device storage. Its service worker
precaches the document, manifest, logo and icons on install, so a launch succeeds with the origin
unreachable and does not wait on the network to render.

**S7.12** The document is fetched network-first with a cache fallback, so a redeploy is picked up on
the next online launch and a stale shell is never preferred to a reachable fresh one.

**S7.13** Exactly one shell cache exists after activation; superseded caches are deleted, so a
redeploy cannot leave unreachable stale entries behind.

**S7.14** Offline launch degrades honestly: the shell renders, connection status shows disconnected,
and no agent data is fabricated from cache. Only the shell is cached — never agent state, pane
content, or any relay response.

**S7.15** Third-party CDN assets are not required for the app to function. Their absence (offline, or
CDN down) may disable optional embellishment but must not block launch or raise a visible error.

## S8 — Non-regressions

- The pure pair-logic block and its markers are byte-identical; `node --test tests/test_pairs.js`
  passes unchanged.
- No WebSocket message type, field, or direction changes.
- The web app remains a single self-contained file with no build step; editing it still requires only
  a browser reload.
