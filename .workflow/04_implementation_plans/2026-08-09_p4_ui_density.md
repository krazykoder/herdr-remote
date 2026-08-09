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
└──────────────────────────────────────┘ │ [/][P] [ Type…       ] [⚡][⌨][➤]    │  50px
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
│ [/][P] [ Type…  ⌘/Ctrl+Enter sends ] [⚡] [⌨] [➤]         │  50px  ← on the fold
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
covering the composer — part of the height model, not of P5.

```html
  <meta name="viewport" content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content">
```

No pre-paint script is needed: the text size scopes to the terminal content (S5.3), which is not
rendered until the user opens a pane, long after the boot script has applied it.

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
- The `pickShortcut` function — `shortcutPick` was its sole caller.

### `[NEW]` prompts dock, opened from the composer

`#shortcutRow` stays the single render path from the one `SHORTCUTS` array (S4.3), but it moves out of
the quick-actions dock into a dock of its own so it has a direct entry point. A `P` button sits in the
composer immediately right of the `/` command button:

```html
      <button onclick="toggleDock('promptDock')" aria-label="Prompts"
        style="padding:10px 12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--muted);font-weight:700;font-size:14px;flex-shrink:0">P</button>
```

The dock is a third `.term-keys` sibling inside `.terminal-view`, after `#quickDock`, holding the
relocated `#shortcutRow`. The `Instructions` heading and `#shortcutRow` are removed from `#quickDock`
so no second copy exists.

`toggleKeysDock` and `toggleQuickDock` each hid exactly one sibling; with three docks that pairwise
logic no longer holds, so both collapse onto one helper (S4.5):

```js
    // The three docks share the space above the composer, so only one is ever open.
    const DOCKS = ['termKeys', 'quickDock', 'promptDock'];

    function toggleDock(id) {
      const el = document.getElementById(id);
      const show = el.style.display === 'none';
      DOCKS.forEach(d => { document.getElementById(d).style.display = 'none'; });
      el.style.display = show ? '' : 'none';
      if (window.cue) cue(show ? 'page' : 'tick');
    }

    function toggleKeysDock() { toggleDock('termKeys'); }

    function toggleQuickDock() { toggleDock('quickDock'); }
```

`insertShortcut` closes the dock after inserting, so the composer and its new text are visible (S4.4).

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

### `[NEW]` text size control, in a pane gear menu

The control lives with the text it resizes: a gear button in `.term-header` right of the refresh
button, opening a small menu (S5.1). Nothing is added to app Settings.

The size is scoped to the terminal content through a custom property, so nothing else in the app can
follow it by accident (S5.3). `.term-content` swaps its `font-size: 0.8rem` for:

```css
      /* px, not rem: this is the one thing the pane's text-size control resizes. 13px is what
         the old 0.8rem resolved to at the default root size. */
      font-size: var(--term-font, 13px);
```

The menu is absolutely positioned against a `.term-menu-wrap` of its own rather than against
`.term-header`, whose other children must stay in normal flow:

```css
    .term-menu-wrap {
      position: relative;
      display: flex;
      flex-shrink: 0;
    }

    .term-menu {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 20;
      min-width: 180px;
      /* surface, border, radius, shadow */
    }
```

Markup, appended inside `.term-header` after the refresh button — the gear reuses `.refresh-btn` and
the app header's own gear path, so no new icon vocabulary appears:

```html
      <div class="term-menu-wrap">
        <button class="refresh-btn" id="termMenuBtn" onclick="toggleTermMenu()" aria-label="Pane settings"
          aria-haspopup="true" aria-expanded="false"><!-- gear svg --></button>
        <div class="term-menu" id="termMenu" style="display:none" role="menu">
          <button class="menu-item" role="menuitem" onclick="closeTermMenu(); renamePane()">Rename pane</button>
          <div class="menu-sep"></div>
          <div class="menu-label">Text size</div>
          <div style="display:flex;align-items:center;gap:8px">
            <button id="fontDec" onclick="bumpFont(-1)" aria-label="Smaller text">A−</button>
            <span id="fontValue" style="flex:1;text-align:center;font-size:0.75rem"></span>
            <button id="fontInc" onclick="bumpFont(1)" aria-label="Larger text">A+</button>
          </div>
        </div>
      </div>
```

Logic, placed beside the other `localStorage` helpers:

```js
    const FONT_KEY = 'herdr_font_size', FONT_MIN = 9, FONT_MAX = 24, FONT_DEFAULT = 13;

    function currentFont() {
      const v = parseInt(localStorage.getItem(FONT_KEY), 10);
      return Number.isFinite(v) ? Math.min(FONT_MAX, Math.max(FONT_MIN, v)) : FONT_DEFAULT;
    }

    // Scoped to the pane's own text via --term-font. Deliberately not the root font size: chrome,
    // keys and inputs must keep their sizes and their 44px hit areas at the small end.
    function setFont(px) {
      const v = Math.min(FONT_MAX, Math.max(FONT_MIN, px));
      document.documentElement.style.setProperty('--term-font', v + 'px');
      try { localStorage.setItem(FONT_KEY, v); } catch (e) { /* private mode: session-only */ }
      document.getElementById('fontValue').textContent = v + 'px';
      document.getElementById('fontDec').disabled = v <= FONT_MIN;
      document.getElementById('fontInc').disabled = v >= FONT_MAX;
    }

    function bumpFont(d) { setFont(currentFont() + d); }

    function toggleTermMenu() { /* flips #termMenu display and aria-expanded */ }
    function closeTermMenu() { /* hides it and resets aria-expanded */ }

    // Dismiss on any click outside the menu and its button, and on Escape.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.term-menu-wrap')) closeTermMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTermMenu(); });
```

The outside-click listener is safe against the gear's own handler: the button is inside
`.term-menu-wrap`, so the bubbled document click does not immediately re-close what it just opened.
`closeTerminal` also calls `closeTermMenu`, so the menu can never outlive its pane (S5.7).

Boot call next to `loadPairs()`: `setFont(currentFont());`

### `[MODIFY]` rename moves into the gear menu

`Rename pane` becomes the first item in the same menu, and `#termTitle` loses the `role="button"`,
`tabindex`, `title`, `onclick`, `onkeydown` and `cursor:pointer` that made it a hidden control
(S5.8). It reduces to `<span class="title" id="termTitle"></span>`. `renamePane` itself is untouched.

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
| M11 | Pane gear → A− to 9px, reload, reopen the pane | 9px persists; no flash of 13px |
| M12 | A− at 9px, A+ at 24px | Respective button disabled |
| M13 | 9px, then check headers, nav keys, composer, agent list | Only the terminal text changed; hit areas ≥44px |
| M14 | 380px-wide viewport | No control clipped or overlapping |
| M15 | Desktop terminal open → click Settings, then Timeline | Terminal closes before selected panel appears; views never stack |
| M16 | Tap `P`, pick a prompt; then open keys dock and tap `P` | Text inserted at cursor, dock closes; opening one dock closes the other two |
| M17 | Open the gear menu, then click the terminal body; then reopen and press Escape; then reopen and close the pane | Menu dismisses in all three cases |
| M18 | Tap the pane title | Nothing happens — it is plain text; rename lives in the gear menu |

## Acceptance criteria

1. `grep -n "49px" web/index.html` returns nothing.
2. No page scrollbar in any view at any viewport size; the composer is always reachable without
   scrolling (M1–M4, M7, M8).
3. Opening a pane hides the agent list, settings, and timeline; closing restores the agent list only
   (M5, M6).
4. Mobile terminal view gains ≈130px of content height; desktop keeps its app header (M7).
5. The instruction `<select>` and its CSS are gone; the `P` button opens the prompts dock, entries
   insert at the cursor without sending, and the dock closes on selection (M7, M16, S4.1–S4.5).
6. Text size lives in the pane gear menu, persists across reloads, clamps to 9–24, disables at the
   bounds, and resizes the terminal content and nothing else (M11–M13).
7. Rename is a gear-menu item; the pane title is inert text; the menu dismisses on outside click,
   Escape, and pane close (M17, M18).
8. `node --test tests/test_pairs.js` and the unittest suite pass unchanged.

Spec items S6 (fullscreen) and S7 (PWA installability) are **not** in scope here and are not
acceptance criteria for this phase.
