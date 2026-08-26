    // --- Landing search ---
    //
    // One box at the foot of the main page for "where is that pane". A machine running twenty
    // panes across four projects turns the landing into a scroll, and the sections it is split
    // into are the wrong axis for the question actually being asked, which is a name.
    //
    // The matching is the pane picker's, borrowed rather than rewritten: same fields, same
    // substring-then-subsequence rule per field, so what "cdx" finds here is what it finds there.
    // At the bottom because that is where a thumb is, and fixed rather than a section because a
    // search control you have to scroll to is one nobody uses.
    const LANDING_SEARCH_KEY = 'herdr_landing_search';
    // Enough to answer the question, short enough that the list never covers the page it is a
    // way into. Past this, type another letter.
    const LANDING_SEARCH_MAX = 8;

    function landingSearchOn() {
      try { return localStorage.getItem(LANDING_SEARCH_KEY) !== 'off'; }
      catch (e) { return true; }
    }

    function setLandingSearch(on) {
      try { localStorage.setItem(LANDING_SEARCH_KEY, on ? 'on' : 'off'); }
      catch (e) { /* private mode: session-only */ }
      const box = document.getElementById('landingSearchOn');
      if (box) box.checked = !!on;
      syncLandingSearch();
    }

    // Only the landing page has a landing page to search. The bar is fixed, so without this it
    // would sit over an open pane's composer — see renderSectionTabs, which asks the same question
    // of the same node for the same reason.
    function syncLandingSearch() {
      const bar = document.getElementById('landingSearch');
      if (!bar) return;
      const list = document.getElementById('agentListView');
      const show = landingSearchOn() && !!list && list.style.display !== 'none';
      bar.hidden = !show;
      // The bar it has to sit above. Measured on every view change rather than guessed: the status
      // bar carries the safe-area inset and grows with the text in it.
      const status = document.querySelector('.status-bar');
      if (status) {
        document.documentElement.style.setProperty(
          '--status-h', Math.round(status.getBoundingClientRect().height) + 'px');
      }
      // Not 'landing-search': that is the bar's own class, and a body wearing it turns every
      // `.landing-search input` rule in the sheet into a rule about every input in the app —
      // which is exactly what it did, and what stretched a toggle in the tile editor to 137px.
      document.body.classList.toggle('landing-search-on', show);
      if (!show) clearLandingSearch();
    }

    // Open is a class on the frame and nothing else — no second element, no stored flag to fall
    // out of step with what is on screen.
    function openLandingSearch() {
      const bar = document.getElementById('landingSearch');
      if (bar) bar.classList.add('open');
    }

    function closeLandingSearch() {
      const bar = document.getElementById('landingSearch');
      if (bar) bar.classList.remove('open');
    }

    // A tap on a result blurs the field before it fires, so this waits a beat and then asks where
    // the focus actually went. Text that was typed keeps it open: closing over a live query would
    // throw away the thing the reader is in the middle of.
    function landingSearchBlur() {
      setTimeout(() => {
        const bar = document.getElementById('landingSearch');
        const input = document.getElementById('landingSearchInput');
        if (!bar || !input || input.value.trim()) return;
        if (bar.contains(document.activeElement)) return;
        closeLandingSearch();
      }, 180);
    }

    function clearLandingSearch() {
      const input = document.getElementById('landingSearchInput');
      if (input) input.value = '';
      const out = document.getElementById('landingSearchResults');
      if (out) { out.innerHTML = ''; out.hidden = true; }
      closeLandingSearch();
    }

    // Every section of the landing page, as one list of things that can be gone *to*. Not a
    // filter over what is on screen: the conversations behind the Auto and Archive modes are in
    // here, and so is a tile whose section is switched off. Read on every keystroke, so anything
    // that arrived while the box was open is findable.
    //
    // Each group carries the words its section is *called*, and those words are searched with the
    // row's own — so "terminal" lists the terminals, "tile" the launcher, "pair" the pairs, and
    // nobody has to remember what a thing was named to find out what there is.
    function landingSearchGroups() {
      const groups = [];
      const add = (head, words, rows, go) => { if (rows.length) groups.push({head, words, rows, go}); };

      add('Agents', 'agent agents pane panes session sessions',
        agents.map(a => pickPaneRow(a)), id => jumpToPane(id));

      add('Terminals', 'terminal terminals shell shells console command line',
        shells.map(a => pickPaneRow(a)), id => jumpToPane(id));

      // A pair is not a pane, so it opens the first half of itself — the two are side by side in
      // the strip from there, which is the whole point of having paired them.
      const healthy = (typeof pairs === 'undefined' ? [] : pairs)
        .filter(p => typeof pairHealth !== 'function' || pairHealth(p, agents).state === 'healthy');
      add('Pairs', 'pair pairs paired partner', healthy.map(p => {
        const live = (p.members || []).map(m => agents.find(a => memberMatches(m, a))).filter(Boolean);
        return {id: p.id || p.name, name: p.name || 'Pair', glyph: '⇄',
          meta: live.map(a => escapeHtml(paneLabel(a))).join(' ⇄ '),
          color: live.length ? statusColor(live[0]) : ''};
      }), id => {
        const pair = healthy.find(p => (p.id || p.name) === id);
        const first = ((pair || {}).members || []).map(m => agents.find(a => memberMatches(m, a)))
          .filter(Boolean)[0];
        if (first) jumpToPane(first.pane_id);
      });

      // What a tile *is* rather than only what it was called: the command it runs or the roster it
      // starts, which is the same evidence the tile itself carries under its name. A tile found
      // here is pressed the way a tile is pressed — through the confirm sheet, never straight into
      // a start.
      const tiles = typeof loadLauncher === 'function' ? loadLauncher() : [];
      add('Launcher', 'tile tiles launcher launch template templates shortcut',
        tiles.map(t => ({id: t.id, name: t.label || 'Tile', glyph: '▤',
          project: t.project || t.project_id || '',
          meta: escapeHtml(typeof launcherPreview === 'function' ? launcherPreview(t) : (t.command || '')),
          note: t.action === 'run' ? 'Command' : t.action === 'terminal' ? 'Terminal' : 'Agents'})),
        id => launcherPress(id));

      add('Conversations', 'conversation conversations thread threads chat auto archive archived',
        (typeof convLandingList === 'function' ? convLandingList().all : []).map(c => ({
          id: c.id,
          name: c.name || 'Conversation',
          glyph: typeof convGlyph === 'function' ? convGlyph(c) : '#',
          note: c.archived ? 'Archived' : (c.auto ? 'Auto' : ''),
          meta: (c.members || []).map(m => escapeHtml(m.label || '')).filter(Boolean).join(', '),
        })), id => openConversation(id));

      return groups;
    }

    // The row's own words, plus what its section is called. One extra field rather than one long
    // string, because pickMatch requires each typed word to be found inside a single field —
    // which is what stops a three-letter subsequence wandering across two of them and matching
    // everything. "terminal build" therefore means the terminal called build, not either.
    function landingHay(row, group) {
      return pickHay(row).concat(group.words || []);
    }

    function landingRowHtml(group, row) {
      return `<button class="pair-pick" data-group="${escapeHtml(group)}" data-id="${escapeHtml(row.id)}" ` +
        `onclick="landingSearchGo(this.dataset.group, this.dataset.id)">` +
        `<span class="dot" style="background:${row.color || 'var(--muted)'}" aria-hidden="true"></span>` +
        `<span class="kind" aria-hidden="true">${row.glyph || '⬛'}</span>` +
        `<span class="info"><span class="name">${escapeHtml(row.name || '')}</span>` +
        `<span class="meta">${row.meta || ''}</span></span>` +
        (row.note ? `<span class="pair-note">${escapeHtml(row.note)}</span>` : '') + `</button>`;
    }

    function renderLandingSearch() {
      const input = document.getElementById('landingSearchInput');
      const out = document.getElementById('landingSearchResults');
      if (!input || !out) return;
      const q = input.value.trim().toLowerCase();
      if (!q) { out.innerHTML = ''; out.hidden = true; return; }
      let shown = 0, html = '';
      landingSearchGroups().forEach(g => {
        const rows = g.rows.filter(r => pickMatch(landingHay(r, g), q))
          .slice(0, LANDING_SEARCH_MAX - shown);
        if (!rows.length) return;
        shown += rows.length;
        html += `<div class="pair-head">${escapeHtml(g.head)}</div>` +
          rows.map(r => landingRowHtml(g.head, r)).join('');
      });
      out.innerHTML = html || `<p class="pair-empty">Nothing here matches "${escapeHtml(q)}".</p>`;
      out.hidden = false;
    }

    // The groups are rebuilt rather than held: a row tapped a minute after it was drawn should go
    // where that pane is now, and an id that has since gone is a no-op rather than a stale jump.
    // Addressed by the section's name and not by its place in the list — a group with nothing in
    // it is not drawn, so the numbering moves whenever a section empties.
    function landingSearchGo(group, id) {
      const g = landingSearchGroups().find(x => x.head === group);
      if (!g || !g.rows.some(r => r.id === id)) return;
      clearLandingSearch();
      const input = document.getElementById('landingSearchInput');
      if (input) input.blur();
      g.go(id);
    }

    function landingSearchKey(e) {
      if (e.key === 'Escape') { clearLandingSearch(); e.target.blur(); }
    }
