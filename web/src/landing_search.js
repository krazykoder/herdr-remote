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

      // `seen` on every row that has a clock: two rows that answer the query equally well are
      // ordered by which one was last looked at, which is the same question the cards above are
      // sorted by. A row without one sorts last among its equals rather than being special-cased.
      const seenOf = a => lastSeen[a.pane_id] || 0;
      const paneRow = a => Object.assign(pickPaneRow(a), {seen: seenOf(a)});

      add('Agents', 'agent agents pane panes session sessions',
        agents.map(paneRow), id => jumpToPane(id));

      add('Terminals', 'terminal terminals shell shells console command line',
        shells.map(paneRow), id => jumpToPane(id));

      // A pair is not a pane, so it opens the first half of itself — the two are side by side in
      // the strip from there, which is the whole point of having paired them.
      const healthy = (typeof pairs === 'undefined' ? [] : pairs)
        .filter(p => typeof pairHealth !== 'function' || pairHealth(p, agents).state === 'healthy');
      add('Pairs', 'pair pairs paired partner', healthy.map(p => {
        const live = (p.members || []).map(m => agents.find(a => memberMatches(m, a))).filter(Boolean);
        return {id: p.id || p.name, name: p.name || 'Pair', glyph: '⇄',
          meta: live.map(a => escapeHtml(paneLabel(a))).join(' ⇄ '),
          // A pair is as recent as its liveliest half — the pane last read is the one the reader
          // was in, and the pair is how they get back to it.
          seen: live.reduce((n, a) => Math.max(n, seenOf(a)), 0),
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
          seen: typeof convSeenAt === 'function' ? convSeenAt(c) : 0,
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

    // How well a row answers what was typed, so the order is the answer's and not the section's.
    // Per typed word, the strongest thing that word did anywhere in the row: the start of a name
    // beats the middle of one, both beat a hit in the meta or in the section's own keywords, and
    // last is a subsequence — which is a match the reader did not ask for so much as allow.
    function landingScore(row, group, q) {
      const name = String(row.name || '').toLowerCase();
      const fields = landingHay(row, group);
      return q.split(/\s+/).filter(Boolean).reduce((n, w) => n + (
        name.startsWith(w) ? 8 : name.includes(w) ? 6
          : fields.some(f => f.includes(w)) ? 4
            : subsequence(name, w) ? 2 : 1), 0);
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
      // Every match in the app first, then the strongest few of them — and only then split back
      // into sections. Ranking inside a group and spending the budget group by group meant the
      // first section could eat all of it on weak subsequence hits: "ter" filled the page with
      // panes whose names merely contain those three letters in order, and the Terminals section
      // it plainly asks for never got a row. Nothing changes at "term" except that the weak
      // matches stop matching — which is the section order deciding, not the query.
      const groups = landingSearchGroups();
      const hits = [];
      groups.forEach(g => g.rows.forEach(r => {
        if (pickMatch(landingHay(r, g), q)) hits.push({g, row: r, score: landingScore(r, g, q)});
      }));
      // Best match first, and among equals the one last looked at — a name typed halfway is
      // usually the pane the reader has been in all morning.
      hits.sort((a, b) => b.score - a.score || (b.row.seen || 0) - (a.row.seen || 0));
      const keep = hits.slice(0, LANDING_SEARCH_MAX);
      // Drawn in section order, each section keeping the ranking above: a list that jumped between
      // sections row by row would be ordered by a score nobody can see.
      const html = groups.map(g => {
        const rows = keep.filter(h => h.g === g).map(h => h.row);
        if (!rows.length) return '';
        return `<div class="pair-head">${escapeHtml(g.head)}</div>` +
          rows.map(r => landingRowHtml(g.head, r)).join('');
      }).join('');
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

    // A tap on the frame and not on anything in it. Open, the frame takes pointer events on a
    // touch screen — see the CSS — so this is what that tap is for: it closes the search and goes
    // no further. Without it the tap fell through to whatever card was under the bar and opened a
    // pane the reader was only trying to dismiss a keyboard over.
    function landingSearchBackdrop(e) {
      const bar = document.getElementById('landingSearch');
      if (!bar || e.target !== bar) return;
      clearLandingSearch();
      const input = document.getElementById('landingSearchInput');
      if (input) input.blur();
    }

    function landingSearchKey(e) {
      if (e.key === 'Escape') { clearLandingSearch(); e.target.blur(); }
    }
