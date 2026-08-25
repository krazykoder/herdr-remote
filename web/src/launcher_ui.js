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
      // Two bubbles, because what a multi-agent tile makes is not several sessions — it is the
      // conversation they land in. The same speech-bubble outline convGlyph draws, doubled and at
      // this file's 24-unit scale, so a tile and the conversation card it becomes read as one
      // thing rather than two features that happen to be related.
      conv: '<path d="M17 12a6 6 0 0 1-6.4 6 6.5 6.5 0 0 1-2.9-.7L4 18.5l1-3.2A5.8 5.8 0 0 1 4 12'
        + 'a6 6 0 0 1 6.5-6A6 6 0 0 1 17 12z"/><path d="M14.5 19.4A6 6 0 0 0 20 15.5"/>',
    };

    // A terminal is a terminal whether or not a line is typed at it.
    LAUNCHER_GLYPHS.term = LAUNCHER_GLYPHS.run;

    function launcherIcon(action) {
      const glyph = LAUNCHER_GLYPHS[action];
      if (!glyph) return '';
      return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
        + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + glyph + '</svg>';
    }

    // What the tile calls the thing it will make.
    function launcherKindLine(tile) {
      const many = (tile.members || []).length > 1;
      const kind = launcherIsTerm(tile) ? 'Terminal'
        : launcherWantsArb(tile) ? 'Arbitrated' : many ? 'Conversation' : 'Session';
      // The bubbles rather than the robot as soon as there is more than one agent on the tile:
      // what this press makes is a room with them in it, and that is what the reader wants to
      // know before reading which kinds are in the payload line below.
      return `${launcherIcon(many ? 'conv' : tile.action)}<span>${escapeHtml(kind)}</span>`;
    }

    // Which tree it runs in, beside the name and in the app's one nomenclature for it — `@project`,
    // the same badge paneChrome puts after a pane's name. It used to sit up on the kind line, where
    // it was the only place in the app a Project was drawn without its @.
    //
    // A tile with no Project is a template — the same roster pressed into whichever tree wants it
    // — and the badge says so rather than being left off. The press is where that is answered, so
    // this is the reader's warning that pressing it asks one more question.
    function launcherProjectBadge(tile) {
      const project = tile.project_id
        ? (projects.find(p => p.id === tile.project_id) || {}).label || tile.project_id
        : null;
      return project
        ? ` <span class="badge proj">@${escapeHtml(project)}</span>`
        : ' <span class="badge proj">@ask</span>';
    }

    // The roster, as the badges every other list wears. `+` between them and not a comma: two of
    // the same kind are two panes, and the badges are what says which kinds without the reader
    // parsing a line of lowercase words. A command has no badges — it is quoted verbatim.
    function launcherPayloadHtml(tile) {
      if (!tile || launcherIsTerm(tile)) {
        return escapeHtml(launcherPreview(tile));
      }
      const members = (tile.members || []).map(m => m || {});
      const badges = members.map(m => typeof configBadge === 'function'
        ? configBadge(m.name || '?', m.config)
        : ` <span class="badge">${escapeHtml(m.name || '?')}</span>`);
      // The arbitrator is named apart from the two rather than joined into them: it is not a third
      // participant, it is the one deciding between the other two.
      return badges.join(' <span class="launcher-plus">+</span>')
        + (launcherWantsArb(tile)
          ? ` <span class="launcher-plus">\u2696</span>`
            + (typeof configBadge === 'function'
               ? configBadge(tile.arbitrator.name, tile.arbitrator.config)
               : ` <span class="badge">${escapeHtml(tile.arbitrator.name)}</span>`)
          : '');
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
      // On the tile as well as over the band. A tile is dragged between bands by editing it, and
      // the one thing that must never be true of this mark is that it can be missed.
      const insecure = launcherInsecure(tile)
        ? '<span class="launcher-badge insecure" title="The providers behind this tile do not'
          + ' protect what is sent to them">insecure</span>'
        : '';
      // The other thing a tile can be that its name does not say. Beside the insecure mark and in
      // the same shape: both are facts about what pressing it does, and neither is a gate.
      const solo = launcherSolo(tile)
        ? '<span class="launcher-badge solo" title="Starts without approval prompts — it runs'
          + ' tools without asking">skips approvals</span>'
        : '';
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
        + `<span class="launcher-name">${escapeHtml(tile.label)}`
        + `${launcherProjectBadge(tile)}</span>`
        + (payload ? `<span class="launcher-payload">${launcherPayloadHtml(tile)}</span>` : '')
        + insecure + solo + badge
        + '</button>';
    }

    // The tiles, in bands. Manual order inside a band, Project order between them: the user
    // arranges tiles, and which tree a tile belongs to is not something they should have to
    // arrange around — a template and a Project tile next to each other is the ordering problem
    // this section had once tiles stopped naming a Project.
    //
    // Templates first. They are the ones pressable anywhere, so they are the ones a reader is
    // looking for when they do not already know which tree they want.
    function launcherGroups(tiles) {
      const out = [];
      const band = (label, list) => { if (list.length) out.push({label: label, tiles: list}); };
      // Insecure first, and out of every other band: the whole point of the mark is that it is
      // read before the tile is pressed, and a warning mixed in among the Project it happens to
      // belong to is one more badge in a grid of badges.
      const safe = tiles.filter(t => !launcherInsecure(t));
      band('[insecure]', tiles.filter(launcherInsecure));
      band('Templates', safe.filter(t => !t.project_id));
      projects.forEach(p => band(p.label || p.id, safe.filter(t => t.project_id === p.id)));
      // Tiles pointing at a Project this relay does not have. Last, and still drawn: they are the
      // broken ones, each already wearing its own badge, and a band that hid them would be the one
      // place the problem is fixable and the last place it is mentioned.
      const known = new Set(projects.map(p => p.id));
      band('Missing Project', safe.filter(t => t.project_id && !known.has(t.project_id)));
      return out;
    }

    function renderLauncher() {
      const el = document.getElementById('launcher');
      if (!el) return;
      const tiles = loadLauncher();
      const groups = launcherGroups(tiles);
      // The header is drawn whether or not there is anything under it — the one place this
      // section differs from Recents, and the same exception Conversations makes for its own +:
      // an entry point that only appears once you already have a tile cannot be how the first one
      // is made. An install that never switched the launcher on still sees nothing, because
      // applySections takes a section outside the order off screen regardless of its content.
      // Two controls, and + is always the right-hand one. Adding a tile used to be reachable only
      // through Edit once the first tile existed — an entry point that moves as soon as it has
      // been used once, which is the shape of a button people stop finding.
      el.innerHTML = '<div class="section-header">Launcher'
        + (tiles.length
          ? '<button class="section-action" onclick="openLauncherEdit()"'
            + ' title="Edit, reorder and delete tiles" aria-label="Edit the launcher">Edit</button>'
          : '')
        + '<button class="section-action" onclick="openLauncherNew()"'
        + ' title="Add a tile" aria-label="Add a launcher tile">+ New</button></div>'
        // One band is every tile in it, so a heading over the lot says nothing. Two or more and the
        // heading is what tells a template from a tile that already knows where it runs.
        + (groups.length > 1
          ? groups.map(g => `<div class="launcher-band">${escapeHtml(g.label)}</div>`
            + g.tiles.map(launcherTileHtml).join('')).join('')
          : tiles.map(launcherTileHtml).join(''))
        // Under the tiles and inside the same section, because it is the launcher's own answer to
        // "what can this press start" — not a seventh section with a tab of its own.
        + (typeof agentConfigsHtml === 'function' ? agentConfigsHtml() : '');
      applySections();
    }
