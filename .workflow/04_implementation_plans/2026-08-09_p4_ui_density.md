# Implementation Plan — P4: Web UI Density & Shell Layout

**Spec:** `.workflow/03_specs/2026-08-09_ui_density_spec.md` §§S1–S5, S8
**Architecture:** `.workflow/02_architecture/2026-08-09_ui_shell_layout.md`
**Decision:** `.workflow/02_architecture/decision_log/2026-08-09_app_shell_no_document_scroll.md`
**Followed by:** `.workflow/04_implementation_plans/2026-08-09_p5_fullscreen_pwa.md` (P5 —
fullscreen + PWA; both are wanted, and both land on top of this shell)
**Classification:** Class A — feature-only. `web/index.html` only; no relay change in this phase.
**Status:** Ready for implementation

## Goal

Make `web/index.html` an app shell that owns exactly one viewport, delete the two hardcoded header
offsets that put the desktop composer below the fold, reclaim ~130px of vertical space on mobile, and
add a persisted text-size control.

P5 (fullscreen, PWA installability) depends on this shell being correct first: a standalone
launch with a document that still scrolls would ship the same bug without a URL bar to blame.

Line numbers below refer to the pre-change file. Apply edits **bottom-up** within a file so earlier
numbers stay valid, or match on the quoted text.

---

## Target layout

### Mobile — terminal view, before → after

```
BEFORE                                   AFTER
┌──────────────────────────────────────┐ ┌──────────────────────────────────────┐
│ ● herdr        3 agents   [◷]  [⚙]   │ │ ‹ ● claude · herdr-remote        [↻]  │  36px
├──────────────────────────────────────┤ ├──────────────────────────────────────┤
│ ‹  claude · herdr-remote        [↻]  │ │                                      │
├──────────────────────────────────────┤ │  $ pytest tests/                     │
│  $ pytest tests/                     │ │  ..........                          │
│  ..........                          │ │  10 passed in 2.1s                   │
│  10 passed in 2.1s                   │ │                                      │
│  › _                                 │ │  › _                                 │  flex
├──────────────────────────────────────┤ │                                      │  (+~130px)
│      [ Instructions          ▾ ]     │ │                                      │
├──────────────────────────────────────┤ │                                      │
│ [/] [ Type…            ] [⚡][⌨][➤]  │ ├──────────────────────────────────────┤
└──────────────────────────────────────┘ │ [/] [ Type…            ] [⚡][⌨][➤]  │  50px
┊ composer clipped, doc scrolls 20px   ┊ └──────────────────────────────────────┘
┊ [ chrome url bar — never collapses ] ┊    no document scroll
└╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘    (url bar addressed in P5)
```

The ⛶ fullscreen control shown in the architecture doc's mockup arrives in P5; the term-header
in this phase is back · dot · title · refresh.

### Desktop ≥768px, after

```
┌───────────────────────────────────────────────────────────┐ 100dvh, no outer scrollbar
│ ● herdr            3 agents           [◷]  [⚙]            │  53px  ← header KEPT on desktop
├───────────────────────────────────────────────────────────┤
│ ‹ ● claude · herdr-remote                          [↻]    │  36px
├───────────────────────────────────────────────────────────┤
│  $ pytest tests/                                          │
│  ..........                                               │  flex, min-height:0
│  10 passed in 2.1s                                        │
│  › _                                                      │
├───────────────────────────────────────────────────────────┤
│ [/] [ Type…  ⌘/Ctrl+Enter sends      ] [⚡] [⌨] [➤]       │  50px  ← on the fold
└───────────────────────────────────────────────────────────┘
```

### Settings — text size

```
┌ Text size ────────────────────────────┐      12px         16px        20px
│  [ A− ]   16px   [ A+ ]               │    ┌────────┐  ┌────────┐  ┌────────┐
│  Scales the terminal and chrome.      │    │28 lines│  │21 lines│  │16 lines│
└───────────────────────────────────────┘    └────────┘  └────────┘  └────────┘
```

---

## Changes — all in `web/index.html`

### `[MODIFY]` head (lines 6–9)

`interactive-widget=resizes-content` makes the on-screen keyboard resize the shell instead of
covering the composer — part of the height model, not of P5. The pre-paint script satisfies
S5.5; a deferred one flashes default-sized text.

```html
  <meta name="viewport" content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content">
  <!-- Applied before first paint: a deferred script would flash default-sized text. -->
  <script>try{var f=parseInt(localStorage.getItem('herdr_font_size'),10);if(f>=12&&f<=22)document.documentElement.style.fontSize=f+'px'}catch(e){}</script>
```

`viewport-fit=cover` is deliberately **not** added here — it only pays off with the standalone
status-bar handling in P5, and adding it alone puts content under the iOS status bar.

### `[MODIFY]` `html` and `body` (lines 60–70)

`min-height` → `height`, plus `overflow:hidden`. `100vh` precedes `100dvh` as the pre-iOS-15.4
fallback.

`html` carries `overflow: hidden` because the document-level rubber-band scroll on iOS originates
there, not on `body`; `height: 100%` gives `body` a definite containing block on browsers that
predate `dvh`.

```css
    html {
      height: 100%;
      overflow: hidden;
    }

    body {
      font-family: -apple-system, system-ui, -webkit-system-font, sans-serif;
      background: var(--bg);
      color: var(--text);
      height: 100vh;
      height: 100dvh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      width: 100%;
    }
```

`overflow-x: hidden` is dropped — `overflow: hidden` covers both axes.

### `[MODIFY]` header density (lines 72–78, 86–99)

```css
    .header {
      padding: 8px 12px;      /* was 12px 16px */
      ...
    }

    .header button {
      ...
      padding: 4px;           /* was 8px — min-width/min-height 44px keeps the hit area */
      ...
    }
```

Add, immediately after the `.header` rule — the terminal header already carries back, title and
status, so on mobile the app header is pure loss (S3.1):

```css
    body.terminal-open > .header {
      display: none;
    }
```

### `[MODIFY]` scrollers (lines 129–142)

Every scrolling flex child needs `min-height: 0`, or its content-based automatic minimum stops it
shrinking and pushes `body` past one viewport. `.settings.active` is dead — `toggleSettings` (1225)
sets inline `style.display` — so the flex properties go on the base rule.

```css
    .view {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }

    /* Settings */
    .settings {
      display: none;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 16px;
    }
```

Delete the `.settings.active` rule (lines 140–142).

### `[MODIFY]` terminal view (lines 385–397)

A flex sibling, not a fixed overlay. No `top`, no `inset`, no `z-index`, no `49px`.

```css
    .terminal-view {
      display: none;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      background: var(--bg);
    }

    .terminal-view.active {
      display: flex;
    }
```

### `[MODIFY]` term header and content (lines 399–446)

```css
    .term-header {
      padding: 6px 12px;      /* was 10px 16px */
      ...
    }

    .term-content {
      flex: 1;
      min-height: 0;          /* NEW */
      overflow-y: auto;
      overflow-x: hidden;
      padding: 8px 10px;      /* was 10px 12px */
      ...
    }
```

### `[MODIFY]` quick actions (lines 448–455)

```css
    .quick-actions {
      padding: 6px 10px;      /* was 8px 12px */
      ...
    }
```

### `[DELETE]` instruction row

- CSS lines 487–504: the whole `.term-shortcuts` and `.term-shortcuts select` rules.
- Markup lines 913–917: the comment, the `<div class="term-shortcuts">`, and its `<select id="shortcutPick">`.
- Boot lines 2352–2354: the `shortcutPick.innerHTML = …` assignment.
- The `pickShortcut` function, **only if** `shortcutPick` was its sole caller — grep before deleting.

`#shortcutRow` in the quick dock (line 1011, rendered at 2350–2351 from the same `SHORTCUTS` array)
remains the single instruction path, satisfying S4.1–S4.3.

### `[MODIFY]` desktop media block (lines 759–767)

Delete both `.terminal-view` rules; the base rules now cover desktop unchanged. Add the header
exemption in their place:

```css
      /* Desktop has room: keep the app header while a pane is open. */
      body.terminal-open > .header {
        display: flex;
      }
```

`.term-content { min-height: 400px }` at lines 783–785 must go — it fights `min-height: 0` and can
re-inflate the shell on a short window.

### `[MODIFY]` status dot markup (line 838) and term header (lines 892–908)

Line 838 — the `id` had exactly one reader, which this change replaces:

```html
    <span class="dot status-dot"></span>
```

Terminal header gains the status dot:

```html
    <div class="term-header">
      <button class="back" onclick="closeTerminal()" aria-label="Back to agent list"><!-- unchanged --></button>
      <span class="dot status-dot"></span>
      <span class="title" id="termTitle" …><!-- unchanged --></span>
      <button class="refresh-btn" onclick="refreshPane()" aria-label="Refresh pane"><!-- unchanged --></button>
    </div>
```

### `[MODIFY]` `setStatus` (lines 1286–1292)

One update path feeding both dots (S3.2):

```js
    function setStatus(s) {
      const color = s === 'connected' ? 'var(--green)' : s === 'connecting' ? 'var(--orange)' : 'var(--red)';
      document.querySelectorAll('.status-dot').forEach(d => { d.style.background = color; });
      const label = document.getElementById('connLabel');
      label.textContent = s === 'connected' ? 'live' : s === 'connecting' ? 'connecting…' : 'offline';
      label.style.color = color;
    }
```

### `[MODIFY]` `openTerminal` / `closeTerminal` (lines 1978, 2004–2005)

The fixed overlay used to *cover* settings and timeline. As a flex sibling it would stack with them,
so they must be hidden explicitly (S2.1).

```js
      // openTerminal, replacing line 1978
      document.getElementById('agentListView').style.display = 'none';
      document.getElementById('settingsView').style.display = 'none';
      document.getElementById('timelineView').style.display = 'none';
      document.body.classList.add('terminal-open');
      document.getElementById('terminalView').classList.add('active');
```

```js
      // closeTerminal, replacing lines 2004–2005
      document.getElementById('terminalView').classList.remove('active');
      document.body.classList.remove('terminal-open');
      document.getElementById('agentListView').style.display = '';
```

### `[MODIFY]` desktop navigation while terminal is open

The desktop app header remains visible, so its Settings and Timeline buttons remain clickable. Their
handlers must close the terminal before showing the selected panel; otherwise the new flex siblings
stack and violate S2.3.

```js
function toggleSettings() {
  if (activePane) closeTerminal();
  // existing settings toggle logic
}

function toggleTimeline() {
  if (activePane) closeTerminal();
  // existing timeline toggle logic
}
```

The terminal is exclusive on every viewport. A subsequent pane selection opens it again.

### `[NEW]` text size control

Markup, as a new `.setting-group` after the Push Notifications group (line 873):

```html
    <div class="setting-group">
      <label>Text size</label>
      <div style="display:flex;align-items:center;gap:12px">
        <button id="fontDec" onclick="bumpFont(-1)" aria-label="Smaller text"
          style="margin:0;min-width:44px;min-height:44px;background:var(--border);color:var(--text)">A−</button>
        <span id="fontValue" style="font-size:0.8rem;min-width:44px;text-align:center"></span>
        <button id="fontInc" onclick="bumpFont(1)" aria-label="Larger text"
          style="margin:0;min-width:44px;min-height:44px;background:var(--border);color:var(--text)">A+</button>
      </div>
      <div class="hint">Scales the terminal and chrome. Keys and inputs keep their size.</div>
    </div>
```

Logic, placed beside the other `localStorage` helpers:

```js
    const FONT_KEY = 'herdr_font_size', FONT_MIN = 12, FONT_MAX = 22, FONT_DEFAULT = 16;

    function currentFont() {
      const v = parseInt(localStorage.getItem(FONT_KEY), 10);
      return Number.isFinite(v) ? Math.min(FONT_MAX, Math.max(FONT_MIN, v)) : FONT_DEFAULT;
    }

    // Root font size, so every rem-sized element follows and every px-sized one — inputs, nav keys,
    // digit keys — deliberately does not: touch targets must hold at the small end.
    function setFont(px) {
      const v = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
      document.documentElement.style.fontSize = v + 'px';
      try { localStorage.setItem(FONT_KEY, v); } catch (e) { /* private mode: session-only */ }
      document.getElementById('fontValue').textContent = v + 'px';
      document.getElementById('fontDec').disabled = v <= FONT_MIN;
      document.getElementById('fontInc').disabled = v >= FONT_MAX;
    }

    function bumpFont(d) { setFont(currentFont() + d); }
```

Boot call next to `loadPairs()` (line 2349): `setFont(currentFont());`

---

## Verification

```bash
# 1. Pair logic untouched — the extracted block must still parse and pass
node --test tests/test_pairs.js

# 2. Relay unit tests (nothing should move, but this phase edits a served asset)
.venv313/bin/python -m unittest discover -s tests -t tests

# 3. No pixel offset and no instruction row survive — all three must return nothing
grep -n "49px" web/index.html
grep -n "term-shortcuts" web/index.html
grep -n "shortcutPick" web/index.html

# 4. Every flex:1 scroller declares min-height:0
grep -c "min-height: 0" web/index.html    # expect 4: .view, .settings, .terminal-view, .term-content
```

Manual, with the relay running:

| # | Check | Expected |
|---|---|---|
| M1 | Desktop 1440×900, open a pane | No page scrollbar; composer fully visible without scrolling |
| M2 | Desktop, shrink window to 700×500 | Still no page scrollbar; terminal content scrolls internally |
| M3 | Open a pane, `loadMore()` to 5000 lines | Terminal scrolls; shell height unchanged |
| M4 | Open Settings with a long panel at 375×600 | Settings scrolls internally, page does not |
| M5 | Open Settings, then open a pane | Settings hidden, terminal shown, nothing stacked |
| M6 | Open Timeline, then open a pane, then close it | Agent list returns; no residual timeline |
| M7 | Mobile 390×844, open a pane | App header gone; status dot visible in term header; ~130px more terminal |
| M8 | Same, open keys dock and quick dock | Composer and dock fully on screen, nothing clipped |
| M9 | Same, raise the on-screen keyboard | Composer sits directly above the keyboard |
| M10 | Paired pane with a stale reason wrapping to a second line | Nothing clips |
| M11 | Settings → A− to 12px, reload | 12px persists, no flash of 16px on load |
| M12 | A− at 12px, A+ at 22px | Respective button disabled |
| M13 | 12px, then check nav keys and composer | Key and input sizes unchanged; hit areas ≥44px |
| M14 | 380px-wide viewport | No control clipped or overlapping |
| M15 | Desktop terminal open → click Settings, then Timeline | Terminal closes before selected panel appears; views never stack |

## Acceptance criteria

1. `grep -n "49px" web/index.html` returns nothing.
2. No page scrollbar in any view at any viewport size; the composer is always reachable without
   scrolling (M1–M4, M7, M8).
3. Opening a pane hides the agent list, settings, and timeline; closing restores the agent list only
   (M5, M6).
4. Mobile terminal view gains ≈130px of content height; desktop keeps its app header (M7).
5. The instruction `<select>` and its CSS are gone; the quick dock's instruction list still inserts
   at the cursor without sending (M7, S4.2).
6. Text size persists across reloads, clamps to 12–22, applies before first paint, disables at the
   bounds, and leaves px-sized controls alone (M11–M13).
7. `node --test tests/test_pairs.js` and the unittest suite pass unchanged.

Spec items S6 (fullscreen) and S7 (PWA installability) are **not** in scope here and are not
acceptance criteria for this phase.
