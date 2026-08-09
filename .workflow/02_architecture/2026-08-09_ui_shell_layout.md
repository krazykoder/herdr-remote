# Architecture — Web App Shell Layout & Density

**Date:** 2026-08-09
**Scope:** `web/index.html`, `web/manifest.webmanifest` and `web/icons/` (new), `relay/herdr_relay.py` (allowlisted static assets)
**Classification:** **Class A** — feature-only. No WebSocket protocol change, no message type added or
altered, no relay state change. The relay edits are additive allowlisted static-asset routes.
**Spec:** `.workflow/03_specs/2026-08-09_ui_density_spec.md`
**Plans:**
- P4 — shell, density, text size: `.workflow/04_implementation_plans/2026-08-09_p4_ui_density.md`
- P5 — fullscreen, PWA installability: `.workflow/04_implementation_plans/2026-08-09_p5_fullscreen_pwa.md`

> **One carve-out, and it is not Class A.** Serving the shell *without a token on the external
> listener* amends a frozen access-control invariant and is tracked separately as **Class B,
> Proposed**: `.workflow/02_architecture/decision_log/2026-08-09_external_listener_static_shell.md`.
> P5 cannot ship its auth section until that entry is signed off. Everything else in this document is
> unaffected by the outcome.

§§5–6 below (browser chrome, PWA) are P5. They land on top of the P4 shell, not beside it:
a standalone or fullscreen launch inherits the same layout, so removing the chrome first would only
hide the clipped composer rather than fix it.

---

## 1. Problem

Four reported symptoms, one shared root: the page is built as a *document* that happens to fill the
screen, not as an *app shell* that owns the viewport.

1. Vertical spacing is loose; wasted band at the top on mobile.
2. Font size is fixed; no user control.
3. A second scrollbar exists outside the terminal's own scroller. On desktop the composer sits below
   the fold; on mobile the URL bar never collapses.
4. The instruction `<select>` consumes an entire row.

## 2. Proof of Discovery

Single file in scope for the UI work: `web/index.html` (2358 lines). `tests/test_pairs.js` extracts
only the block delimited by `// --- P3 pair logic (pure) ---`; nothing in this change touches it.

| Finding | Line | Consequence |
|---|---|---|
| `body { min-height: 100dvh; flex-column }` | 60–70 | body may grow past the viewport, so the **document** scrolls |
| `.view { flex:1; overflow-y:auto }` with no `min-height:0` | 129–132 | flex item's automatic minimum is content-based, so it refuses to shrink; the inner scroller never engages and the item pushes body taller |
| `.terminal-view { position:fixed; top:49px }` | 388–390 | 49px is wrong. Real header = 44px button + 24px padding + 1px border = **69px** |
| `.terminal-view.active { height: calc(100dvh - 49px) }` (≥768px) | 766 | 69px header + (100dvh − 49px) = 100dvh + **20px** → permanent desktop scrollbar, composer below the fold |
| `.term-shortcuts` wraps a single `<select>` | 487–504, 915–917 | ~34px row duplicating `#shortcutRow` in the quick dock (1011) — both render from the same `SHORTCUTS` array (2350–2354) and both insert-at-cursor without sending |
| `openTerminal` hides only `agentListView` | 1978 | `settingsView` / `timelineView` were merely *covered* by the fixed overlay, never hidden |
| `.settings.active` class never set by JS | 140–142 vs 1225 | dead rule; `toggleSettings` sets inline `style.display` |
| PWA metas + `sw.js` present, manifest is a `data:` URL with no icons | 7–9, 2281 | iOS install works; Android installability blocked |

**Invariants to preserve**

- Single self-contained file, no build step. All CSS/JS stays inline.
- 44px minimum touch targets on interactive controls.
- `env(safe-area-inset-*)` handling on bottom docks.
- The P3 pair-logic block markers.
- Relay static routes are appended **below** existing ones (`herdr_relay.py:611`).

## 3. Contract — the shell invariant

> **The document never scrolls. `html` and `body` are exactly one viewport tall, and every scrollable region is a
> flex child with `min-height: 0` and its own `overflow-y: auto`.**

This is now binding for `web/index.html`. Consequences that follow from it, and must not be
re-litigated per-feature:

- No layout may depend on a hardcoded pixel offset for the header. There is no `49px` anywhere.
- A new full-height pane is added as a flex sibling of `.view`, never as `position:fixed` with a
  magic `top`.
- Any new flex child that scrolls declares `min-height: 0`. Omitting it reintroduces symptom 3.
- Mobile and desktop share one layout rule set. The `@media (min-width:768px)` block adjusts
  *chrome visibility and widths only*, never the height model.

## 4. Target layout

### 4.1 Mobile — terminal view, before

```
┌──────────────────────────────────────┐ ← viewport top
│ ● herdr        3 agents   [◷]  [⚙]   │  69px  ← wasted: back+title already below
├──────────────────────────────────────┤
│ ‹  claude · herdr-remote        [↻]  │  44px
├──────────────────────────────────────┤
│                                      │
│  $ pytest tests/                     │
│  ..........                          │
│  10 passed in 2.1s                   │  flex
│                                      │
│  › _                                 │
│                                      │
├──────────────────────────────────────┤
│      [ Instructions          ▾ ]     │  34px  ← whole row, one <select>
├──────────────────────────────────────┤
│ [/] [ Type…            ] [⚡][⌨][➤]  │  54px
└──────────────────────────────────────┘ ← viewport bottom
┊ …composer clipped, doc scrolls 20px  ┊  20px  ← body min-height + no min-height:0
┊ [ chrome url bar — never collapses ] ┊
└╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
```

### 4.2 Mobile — terminal view, after

```
┌──────────────────────────────────────┐ ← viewport top
│ ‹ ● claude · herdr-remote     [⛶][↻] │  36px  ← dot moves here, app header hidden
├──────────────────────────────────────┤
│                                      │
│  $ pytest tests/                     │
│  ..........                          │
│  10 passed in 2.1s                   │
│                                      │
│  › _                                 │  flex  (+~130px vs before)
│                                      │
│                                      │
│                                      │
│                                      │
├──────────────────────────────────────┤
│ [/] [ Type…            ] [⚡][⌨][➤]  │  50px  ← ⚡ dock holds Instructions
└──────────────────────────────────────┘ ← viewport bottom, composer fully on screen
   no document scroll · url bar: see §5
```

Reclaimed: 69 (app header) + 34 (instruction row) + ~30 (padding trim) ≈ **130px**, roughly six extra
terminal lines at the default size. The ⛶ control is P5; after P4 the term-header reads
back · dot · title · refresh.

### 4.3 Mobile — agent list

```
┌──────────────────────────────────────┐
│ ● herdr      3 agents    [◷]  [⚙]    │  69→53px
├──────────────────────────────────────┤
│ RECENT  (claude) (codex) (+)         │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ ● claude · herdr-remote        │  │  scrolls INSIDE .view now,
│  │   waiting for approval         │  │  not the document
│  └────────────────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │ ● codex · api                  │  │
│  └────────────────────────────────┘  │
└──────────────────────────────────────┘
```

### 4.4 Desktop ≥768px

```
┌───────────────────────────────────────────────────────────┐ 100dvh, no outer scrollbar
│ ● herdr            3 agents           [◷]  [⚙]            │  53px  ← header KEPT on desktop
├───────────────────────────────────────────────────────────┤
│ ‹ ● claude · herdr-remote                          [↻]    │  36px
├───────────────────────────────────────────────────────────┤
│  $ pytest tests/                                          │
│  ..........                                               │
│  10 passed in 2.1s                                        │  flex, min-height:0
│  › _                                                      │
├───────────────────────────────────────────────────────────┤
│ [/] [ Type…  ⌘/Ctrl+Enter sends      ] [⚡] [⌨] [➤]       │  50px  ← sits ON the fold,
└───────────────────────────────────────────────────────────┘         no scroll to reach it
```

### 4.5 Text size control (Settings)

```
┌ Text size ────────────────────────────┐
│  [ A− ]   16px   [ A+ ]               │   12 … 22, persisted
│  Scales the terminal and chrome.      │   keys/inputs stay px = touch targets hold
└───────────────────────────────────────┘
```

```
   12px            16px (default)         20px
 ┌──────────┐    ┌──────────┐         ┌──────────┐
 │$ pytest  │    │$ pytest  │         │$ pytest  │
 │..........│    │......... │         │......    │
 │10 passed │    │10 passed │         │10 passed │
 │› _       │    │› _       │         │          │
 │(28 lines)│    │(21 lines)│         │(16 lines)│
 └──────────┘    └──────────┘         └──────────┘
```

One knob, applied as the **root font size**. Everything sized in `rem` follows (terminal content is
`0.8rem`, header title `1rem`). Everything sized in `px` — inputs, nav keys, digit keys — deliberately
does not, so touch targets never degrade at the small end.

## 5. Browser chrome: what is and is not achievable

The mobile URL bar collapses only when the **document** scrolls. §3 makes the document not scroll —
that is the correct app-shell model and the fix for every other symptom, but it also means the URL
bar stays put in a normal browser tab. Ranked options:

| Option | Platform | Verdict |
|---|---|---|
| Install as PWA (`display:standalone`) | iOS + Android | **Adopted.** No browser chrome at all. Manifest and metas mostly exist; §6 closes the gaps. |
| Fullscreen API on a user gesture | Android, iPadOS, desktop | **Adopted, feature-detected.** iPhone Safari does not implement element fullscreen; the button is not rendered there. |
| `100dvh` sizing | all | **Adopted.** Layout stays correct whether the bar is shown or hidden, so nothing is ever clipped either way. |
| Scroll-jacking (1px overscroll spacer to force a collapse) | — | **Rejected.** Fragile across iOS versions and it reintroduces the document scroll this contract forbids. |

## 6. PWA installability

A PWA is the site itself — no app store, no signing, no review. Install is a browser menu action:
iOS Safari *Share → Add to Home Screen*; Android Chrome *⋮ → Install app*. HTTPS required, so the
Cloudflare tunnel URL qualifies and a bare `http://` LAN address does not.

Present already: `apple-mobile-web-app-capable`, `apple-mobile-web-app-status-bar-style:
black-translucent`, `display:standalone`, registered `sw.js`.

Gaps closed by this change:

1. The manifest is a `data:` URL. A relative `start_url` cannot resolve against a `data:` base, so
   Chrome refuses installability and Android users get a plain shortcut that keeps the URL bar.
   → ship `web/manifest.webmanifest` as a real file. Use relative `manifest.webmanifest`, `./` start
   and scope URLs so relay-root and project-path hosting both work.
2. Android installability requires 192px and 512px icons. → ship PNGs under `web/icons/` and serve
   them through the relay's allowlisted static-asset map; Cloudflare Pages serves them directly.
3. iOS ignores manifest icons and wants `<link rel="apple-touch-icon">` as a **PNG**. → ship a
   180px PNG as part of P5; the iOS icon is not optional.

4. Over the external listener the shell's sub-resources 401. The browser — not the app's JavaScript —
   issues the manifest, service-worker, and icon requests, and they do not inherit the document's
   `?token=` query string; a standalone launch navigates to `start_url` with no token at all. Note
   this already breaks `sw.js` registration, and therefore push, over the tunnel today: P5 surfaces
   a pre-existing bug rather than introducing one. **Unresolved** — three options, recommendation,
   and cost are in
   `.workflow/02_architecture/decision_log/2026-08-09_external_listener_static_shell.md`. The
   recommendation is to install from the Cloudflare Pages origin and change no relay access control;
   the relay's allowlisted static routes are still needed for the token-free LAN listener.

`viewport-fit=cover` is added alongside these so the composer can hug the home indicator; it pairs
with `padding-top: env(safe-area-inset-top)` on `body`, required because the status bar style is
`black-translucent`.

## 7. Out of scope

Colour themes, the terminal renderer, the key pads' layout, the `esm.sh` runtime import, and every
non-web client (`herdi-mac`, `herdi-ios`, TUI, Telegram).
