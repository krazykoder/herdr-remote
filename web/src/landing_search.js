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
      // Not 'landing-search': that is the bar's own class, and a body wearing it turns every
      // `.landing-search input` rule in the sheet into a rule about every input in the app —
      // which is exactly what it did, and what stretched a toggle in the tile editor to 137px.
      document.body.classList.toggle('landing-search-on', show);
      if (!show) clearLandingSearch();
    }

    function clearLandingSearch() {
      const input = document.getElementById('landingSearchInput');
      if (input) input.value = '';
      const out = document.getElementById('landingSearchResults');
      if (out) { out.innerHTML = ''; out.hidden = true; }
    }

    // Everything on the landing page that can be gone *to*: the live panes, and the conversations
    // — including the auto ones and the archived ones, which are the two the page itself keeps
    // behind a mode. A search that could only reach what is already on screen would be a filter.
    // Read on every keystroke, so a pane that arrived while the box was open is findable.
    function landingSearchGroups() {
      const groups = [];
      const panes = agents.concat(shells).map(a => pickPaneRow(a));
      if (panes.length) groups.push({head: 'Panes', rows: panes, go: id => jumpToPane(id)});
      const convs = (typeof convLandingList === 'function' ? convLandingList().all : []).map(c => ({
        id: c.id,
        name: c.name || 'Conversation',
        glyph: typeof convGlyph === 'function' ? convGlyph(c) : '#',
        note: c.archived ? 'Archived' : (c.auto ? 'Auto' : ''),
        meta: (c.members || []).map(m => escapeHtml(m.label || '')).filter(Boolean).join(', '),
      }));
      if (convs.length) groups.push({head: 'Conversations', rows: convs,
        go: id => openConversation(id)});
      return groups;
    }

    function landingRowHtml(group, row) {
      return `<button class="pair-pick" data-group="${group}" data-id="${escapeHtml(row.id)}" ` +
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
      landingSearchGroups().forEach((g, i) => {
        const rows = g.rows.filter(r => pickMatch(pickHay(r), q))
          .slice(0, LANDING_SEARCH_MAX - shown);
        if (!rows.length) return;
        shown += rows.length;
        html += `<div class="pair-head">${escapeHtml(g.head)}</div>` +
          rows.map(r => landingRowHtml(i, r)).join('');
      });
      out.innerHTML = html || `<p class="pair-empty">Nothing here matches "${escapeHtml(q)}".</p>`;
      out.hidden = false;
    }

    // The groups are rebuilt rather than held: a row tapped a minute after it was drawn should go
    // where that pane is now, and an id that has since gone is a no-op rather than a stale jump.
    function landingSearchGo(group, id) {
      const g = landingSearchGroups()[Number(group)];
      if (!g || !g.rows.some(r => r.id === id)) return;
      clearLandingSearch();
      const input = document.getElementById('landingSearchInput');
      if (input) input.blur();
      g.go(id);
    }

    function landingSearchKey(e) {
      if (e.key === 'Escape') { clearLandingSearch(); e.target.blur(); }
    }
