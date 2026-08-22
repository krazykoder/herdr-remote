    // --- Launcher, on screen ---
    // The section reads the document and draws a tile per row. Pressing one is steps 4-6; this
    // file currently only says what is there and whether it could be pressed.
    //
    // Named `renderLauncher` and not something tidier because state_sync's STATE_RERENDER map
    // names it: a tile added on the phone repaints the desktop through that entry, and a rename
    // here without one there is a section that silently stops following the other browser.

    // The glyph on the tile says which kind it is at a glance, so a command and a roster are
    // told apart before either line of text is read. Both are drawn to the same 14-unit span as
    // each other rather than to their sources' — a terminal box beside a smaller robot reads as
    // one being more important.
    const LAUNCHER_GLYPHS = {
      run: '<rect x="2" y="3" width="20" height="18" rx="2"/>'
        + '<polyline points="7 9 10 12 7 15"/><line x1="13" y1="15" x2="17" y2="15"/>',
      spawn: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M12 3v4"/>'
        + '<circle cx="8.5" cy="13.5" r="1" fill="currentColor"/>'
        + '<circle cx="15.5" cy="13.5" r="1" fill="currentColor"/><path d="M8.5 17.5h7"/>',
    };

    function launcherIcon(action) {
      const glyph = LAUNCHER_GLYPHS[action];
      if (!glyph) return '';
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
        + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + glyph + '</svg>';
    }

    // What the tile calls the thing it will make. The Project is on it because two tiles that
    // differ only by which tree they run in are otherwise indistinguishable, and that is exactly
    // the pair a person most needs to tell apart before pressing.
    function launcherKindLine(tile) {
      const project = (projects.find(p => p.id === tile.project_id) || {}).label || tile.project_id;
      const kind = tile.action === 'run' ? 'Terminal'
        : launcherWantsArb(tile) ? 'Arbitrated'
        : (tile.members || []).length > 1 ? 'Conversation' : 'Session';
      return `${launcherIcon(tile.action)}<span>${escapeHtml(kind)}</span>`
        + `<span class="badge proj">${escapeHtml(project || '—')}</span>`;
    }

    function launcherTileHtml(tile) {
      // launcherEnv and not a second env built here: this one was missing `arb`, so every
      // arbitrated tile drew as permanently refused on a relay that in fact has arbitration on
      // — the press path said yes and the tile said no. One builder, one answer.
      const gate = launcherGate(tile, launcherEnv());
      // The payload, always, and never behind a hover: a tile's text may have been written by
      // another browser, so the name on it is a claim and this line is the evidence. The confirm
      // in step 4 shows the whole of it; two lines here is what fits without the grid going ragged.
      const payload = launcherPreview(tile);
      const badge = gate.badge ? `<span class="launcher-badge">${escapeHtml(gate.badge)}</span>` : '';
      // aria-disabled and not the `disabled` attribute: a disabled button is skipped by the
      // keyboard and reports nothing to a screen reader, and the reason this tile cannot be
      // pressed is the one thing its reader most needs. It is still not pressable — nothing is
      // wired to it yet, and step 4's handler returns on a closed gate.
      return `<button class="launcher-tile" data-action="${escapeHtml(tile.action)}"`
        + ` data-tile="${escapeHtml(tile.id)}" aria-disabled="${gate.ok ? 'false' : 'true'}"`
        // A gone Project is the one closed gate the presser can fix, so this tile is still worth
        // a pointer: the press opens it on that field rather than reporting a dead end.
        + (gate.badge === 'Missing Project' ? ' data-repoint="true"' : '')
        // Wired even when the gate is shut: launcherPress refuses and says why, which is the one
        // thing a reader of a dead button needs. See the aria-disabled note above.
        + ` onclick="launcherPress('${escapeHtml(tile.id)}')"`
        + ` title="${escapeHtml(gate.reason || payload)}">`
        + `<span class="launcher-kind">${launcherKindLine(tile)}</span>`
        + `<span class="launcher-name">${escapeHtml(tile.label)}</span>`
        + (payload ? `<span class="launcher-payload">${escapeHtml(payload)}</span>` : '')
        + badge
        + '</button>';
    }

    function renderLauncher() {
      const el = document.getElementById('launcher');
      if (!el) return;
      const tiles = loadLauncher();
      // The header is drawn whether or not there is anything under it — the one place this
      // section differs from Recents, and the same exception Conversations makes for its own +:
      // an entry point that only appears once you already have a tile cannot be how the first one
      // is made. An install that never switched the launcher on still sees nothing, because
      // applySections takes a section outside the order off screen regardless of its content.
      el.innerHTML = '<div class="section-header">Launcher'
        + '<button class="section-action" onclick="openLauncherEdit()"'
        + ' title="Add, edit and reorder tiles" aria-label="Edit the launcher">'
        + (tiles.length ? 'Edit' : '+ New') + '</button></div>'
        + tiles.map(launcherTileHtml).join('');
      applySections();
    }
