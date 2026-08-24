# Plan: The launch sheet says what it is launching

Class A, presentation only. No wire change, no storage change, no contract change — so no spec:
every fact drawn here is already computed by a pure helper, and the only new code is markup and CSS.

## Goal

Two changes to the sheet `launcherPress` opens (`launcherDrawLaunch`, `web/src/launcher_edit.js:132`):

1. The header names the action, not just the tile — **`Launch: <tile name>`**.
2. Under the quoted confirm line, a strip of the components this press will spawn: one chip per
   member with its icon, its name and its harness badge, and the arbitrator marked apart.

Today the header is the bare tile label, which reads identically to the tile *editor's* header, and
the roster is only present as prose inside `launcherConfirmLines` — "claude, codex" in a sentence.

## File-by-file

### `[MODIFY] web/src/launcher_edit.js`

**Header.** In `launcherDrawLaunch`, replace line 135-136:

```js
      const title = document.getElementById('launcherEditTitle');
      // Named for what this sheet does, because the same node is the tile *editor's* header and a
      // bare tile label reads the same in both. This one starts sessions.
      if (title) title.textContent = `Launch: ${tile.label}`;
```

`textContent`, so the tile label — which another browser may have written — cannot carry markup.

**Roster strip.** Add beside `launcherDrawLaunch`:

```js
    // What this press will actually spawn, drawn rather than described. launcherConfirmLines says
    // it in a sentence, which is the right form for a confirm and the wrong one for a roster: the
    // reader is checking a list, and a list is read as a list.
    //
    // Drawn whether or not a Project has been picked yet, unlike the confirm above it. The roster
    // is a fact about the tile; the confirm is a fact about the press, and there is no press to
    // describe until there is somewhere to press it.
    function launcherRosterHtml(tile) {
      const roster = tile.action === 'run' ? [] : launcherRoster(tile);
      if (!roster.length) return '';
      return '<div class="ql-roster">' + roster.map(m => {
        const starter = (SHORTCUTS.find(s => s.at === m.at) || {}).label || '';
        return `<span class="ql-part${m.arb ? ' arb' : ''}">`
          // The scales for the arbitrator and the robot for a member: it is not a third
          // participant, it is the one deciding between the other two, and a strip that drew all
          // three alike would be the same lie launcherPreview already refuses to tell.
          + (m.arb ? '<span class="ql-part-mark" aria-hidden="true">⚖</span>'
                   : `<span class="ql-part-mark">${launcherIcon('spawn')}</span>`)
          + `<span class="ql-part-name">${escapeHtml(m.label || m.name)}</span>`
          + agentBadge(m.name)
          + (starter ? `<span class="ql-part-role">${escapeHtml(starter)}</span>` : '')
          + '</span>';
      }).join('') + '</div>';
    }
```

A `run` tile gets none: its payload is one command, and `ql-launch-say` already quotes it verbatim.

**Insert it.** In `launcherDrawLaunch`, immediately after the `ql-launch-say` / `ql-none` ternary
(ends line 147) and before the Project field:

```js
          + launcherRosterHtml(tile)
```

`launcher_edit.js` loads after `launcher_pure.js`, `launcher_ui.js` and `terminal.js`, so
`launcherRoster`, `launcherIcon` and `agentBadge` all resolve. Nothing here runs at load.

### `[MODIFY] web/index.html` — CSS

After the `.ql-launch-say` rule (ends line 1450):

```css
    /* The roster as chips rather than a sentence. Wraps like .badge-strip because a tile may carry
       up to LAUNCHER_MEMBERS_MAX of them and a chip pushed off the edge is a chip that does not
       exist. */
    .ql-roster {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      padding: 2px 0;
    }

    .ql-part {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      padding: 4px 8px;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 0.7rem;
      color: var(--text);
    }

    .ql-part-mark {
      display: inline-flex;
      align-items: center;
      color: var(--muted);
      flex-shrink: 0;
    }

    /* The arbitrator is set apart the way launcherPreview sets it apart in text: it is not a third
       member, it is the one reading the other two. */
    .ql-part.arb {
      border-color: color-mix(in srgb, var(--orange) 55%, transparent);
    }

    .ql-part.arb .ql-part-mark {
      color: var(--orange);
    }

    .ql-part-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* The opening prompt this member gets, at the weight of a footnote — it is the last thing the
       reader checks and the first thing that should give up room when the chip is squeezed. */
    .ql-part-role {
      font-size: 0.62rem;
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
```

`.ql-part` deliberately reuses no `.badge` rule: `agentBadge` draws a real `.badge` *inside* each
chip, and a chip styled as a badge around a badge reads as two badges.

### `[MODIFY] tests/test_launcher_edit.js`

`launcherRosterHtml` is pure over a tile, so it tests in the existing vm slice:

| # | Tile | Assert |
|---|------|--------|
| 1 | two members, no arbitrator | two `ql-part`, no `arb` class, both harness badges present |
| 2 | two members + arbitrator | three chips, exactly one `arb`, the arbitrator's kind in it |
| 3 | member with `at: 'implement'` | the SHORTCUTS label "Implement" appears, not the raw `at` |
| 4 | `action: 'run'` | empty string |
| 5 | member `label` containing `<script>` | escaped in the output |
| 6 | tile with no `project_id` | strip still drawn (it is a fact about the tile) |

### `[MODIFY] tests/e2e/browser/launcher.spec.js`

One case: press a two-member tile, assert the sheet header reads `Launch: <name>` and that the strip
holds two chips before a Project has been chosen. This is the half a vm slice cannot see — that the
strip is inserted where `launcherDrawLaunch` writes its `innerHTML`, and survives the redraw that a
Project tap causes.

## Verification

```bash
node --test tests/test_launcher_edit.js
node --test tests/*.js
npx playwright test tests/e2e/browser/launcher.spec.js
npx playwright test
```

## Acceptance criteria

1. Pressing any tile opens a sheet headed `Launch: <tile name>`.
2. A multi-member tile shows one chip per member plus one for the arbitrator, the arbitrator
   visibly apart; a single-member tile shows one chip; a `run` tile shows none.
3. The strip is present before a Project is picked, and unchanged after picking one.
4. All six vm cases and the whole suite green; Playwright green.
5. No file under `relay/` changes.
