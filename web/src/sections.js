    // --- Main page sections ---
    // Which main-page sections show, and in what order. Stored as the order itself rather
    // than as booleans plus a separate ranking: switching one on means "put it after what is
    // already there", so the list *is* the setting and there is no second thing to keep in step.
    //
    // Order is applied with CSS `order` and never by moving nodes. renderBody, renderRecents and
    // the terminals write rewrites each section's innerHTML on their own schedule, and a reorder
    // that moved DOM nodes would race all three.
    const SECTIONS_KEY = 'herdr_sections';
    const SECTION_IDS = {agents: 'agents', terminals: 'terminals', pairs: 'pairs', recents: 'recents', conversations: 'conversations'};
    const SECTION_KEYS = Object.keys(SECTION_IDS);
    // Today's layout, so an install that never opens Settings sees no change at all.
    const SECTION_DEFAULT = ['agents', 'terminals', 'pairs', 'recents', 'conversations'];
    let sectionOrder = SECTION_DEFAULT.slice();

    // Anything unrecognised, duplicated or empty falls back to the default. This is a display
    // preference read from storage a user can edit, and a bad value must not blank the page.
    function loadSections() {
      let v = null;
      try { v = JSON.parse(localStorage.getItem(SECTIONS_KEY)); } catch (e) { v = null; }
      if (!Array.isArray(v)) return SECTION_DEFAULT.slice();
      const seen = v.filter((k, i) => SECTION_KEYS.includes(k) && v.indexOf(k) === i);
      return seen.length ? seen : SECTION_DEFAULT.slice();
    }

    function saveSections() {
      try { localStorage.setItem(SECTIONS_KEY, JSON.stringify(sectionOrder)); }
      catch (e) { /* private mode: session-only */ }
    }

    // Narrowing the page to one section is a *view*, not a preference: it is how you get to the
    // conversations without scrolling past the agents, and it is meant to be dropped on the way
    // out. So it is held here and never stored — a reload comes back to the layout Settings owns.
    let sectionFilter = '';

    function sectionHasContent(key) {
      const el = document.getElementById(SECTION_IDS[key]);
      return !!(el && el.innerHTML);
    }

    // A section is on screen only if it is switched on *and* has something to say. Emptiness is
    // still each renderer's own business — this reads what they wrote rather than second-guessing
    // it, so a section that renders nothing does not leave a bare separator behind.
    function applySections() {
      // A filter outlives the thing it named — the last pair closes, the last terminal exits — and
      // holding it then leaves a blank page with no way back. Dropped here rather than guarded at
      // every reader, because every renderer already ends up in this function.
      if (sectionFilter && !sectionHasContent(sectionFilter)) sectionFilter = '';
      SECTION_KEYS.forEach(key => {
        const el = document.getElementById(SECTION_IDS[key]);
        if (!el) return;
        const at = sectionOrder.indexOf(key);
        // A filter overrides Settings outright, both halves of it: the named section is the only
        // one drawn, and it is drawn even if Settings has it switched off. The order is left on the
        // nodes untouched — one section has nothing to be ordered against, and dropping the filter
        // has to put the page back exactly as it was.
        const on = sectionFilter ? key === sectionFilter : at >= 0 && !!el.innerHTML;
        el.style.order = at >= 0 ? String(at) : '';
        el.style.display = on ? '' : 'none';
        // Whichever section is drawn first needs the gap the header margin alone does not give it,
        // and CSS cannot ask for it: :first-child follows source order, not flex order. A class and
        // not an inline padding, so the size stays in the stylesheet where the narrow-screen media
        // query can shrink it along with the sides.
        el.classList.toggle('section-first', on && (!!sectionFilter
          || !sectionOrder.some((k, i) => i < at && sectionHasContent(k))));
      });
      renderSectionTabs();
    }

    // --- Section shortcuts ---
    // One icon per section in the app header, so a phone can jump to the list it wants without
    // scrolling the four above it. Header-side and not a row of its own: "page layout does not
    // change" is the point — the landing page leaves the tab strip's space empty anyway.
    const SECTION_NAMES = {
      agents: 'Agents', terminals: 'Terminals', pairs: 'Pairs',
      recents: 'Recents', conversations: 'Conversations',
    };
    // Its own order, not the sections' and not Settings': this row is fixed so a button stays under
    // the same thumb whatever the page below is doing, and it leads with what is read most.
    const SECTION_TABS = ['conversations', 'agents', 'terminals', 'pairs', 'recents'];
    const SECTION_GLYPHS = {
      // Drawn to the same 18-unit span as the bubble and the terminal beside it: a 16-wide box
      // between two 18s reads as the odd one out even though all three are on an 18px canvas.
      // Circles and not lucide's zero-length `h.01` dots for the eyes — at this size the round cap
      // is a smudge, and a bot with no eyes is a plain box next to a terminal that is also one.
      agents: '<rect x="3" y="7" width="18" height="14" rx="2"/><path d="M12 3v4"/>'
        + '<circle cx="8.5" cy="13.5" r="1" fill="currentColor"/><circle cx="15.5" cy="13.5" r="1" fill="currentColor"/><path d="M8.5 17.5h7"/>',
      terminals: '<rect x="2" y="4" width="20" height="16" rx="2"/>'
        + '<polyline points="6 9 9 12 6 15"/><line x1="12" y1="15" x2="18" y2="15"/>',
      pairs: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 0 1 0 10h-2"/>'
        + '<line x1="8" y1="12" x2="16" y2="12"/>',
      recents: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/>'
        + '<polyline points="12 7 12 12 15 14"/>',
      conversations: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    };

    let sectionTabsHtml = '';

    function sectionIcon(key) {
      return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
        + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
        + SECTION_GLYPHS[key] + '</svg>';
    }

    function renderSectionTabs() {
      const bar = document.getElementById('sectionTabs');
      if (!bar) return;
      // Only the app's own landing page has sections to shortcut to. The header is shared with the
      // panels and with an open pane, and there the strip is not a control, it is a lie.
      const list = document.getElementById('agentListView');
      const landing = !!list && list.style.display !== 'none';
      // Buttons for what is actually there. Fewer than two lists is nothing to choose between —
      // except while a filter is on, where the one button left is the way to switch it off.
      const keys = SECTION_TABS.filter(sectionHasContent);
      // The markup says which buttons there are and nothing about which one is held down. Pressing
      // a filter must not rewrite the strip: replacing the node under the finger re-parses five
      // SVGs and drops the tap highlight mid-press, which is a phone's whole answer to "did that
      // register" — and it reads as a delay the mouse never sees, because a mouse had :hover.
      const html = !landing || (keys.length < 2 && !sectionFilter) ? '' : keys.map(key =>
        `<button class="sect-tab" data-section="${key}"`
        + ` onclick="toggleSectionFilter('${key}')" title="${SECTION_NAMES[key]}"`
        + `>${sectionIcon(key)}</button>`).join('');
      // Compared against what was last written rather than against the node: the browser gives
      // innerHTML back normalised, and a strip rebuilt a few times a second loses focus mid-press.
      if (sectionTabsHtml !== html) { bar.innerHTML = html; sectionTabsHtml = html; }
      bar.hidden = !html;
      keys.forEach(key => {
        const btn = bar.querySelector(`[data-section="${key}"]`);
        if (!btn) return;
        const on = sectionFilter === key;
        btn.setAttribute('aria-pressed', String(on));
        btn.setAttribute('aria-label', on ? 'Show every section again'
          : 'Show only ' + SECTION_NAMES[key]);
      });
    }

    function toggleSectionFilter(key) {
      if (!SECTION_KEYS.includes(key)) return;
      sectionFilter = sectionFilter === key ? '' : key;
      applySections();
      if (typeof cue === 'function') cue('tick');
    }

    function syncSectionBoxes() {
      SECTION_KEYS.forEach(key => {
        const box = document.getElementById('section' + key[0].toUpperCase() + key.slice(1));
        if (!box) return;
        box.checked = sectionOrder.includes(key);
        // The last one on cannot be switched off — an empty main page is not a state worth being
        // able to reach by accident, and the alternative is a screen whose only content explains
        // how to get its content back.
        box.disabled = box.checked && sectionOrder.length === 1;
      });
    }

    function toggleSection(key, on) {
      if (!SECTION_KEYS.includes(key)) return;
      if (on) {
        if (!sectionOrder.includes(key)) sectionOrder.push(key);
      } else {
        if (sectionOrder.length === 1) { syncSectionBoxes(); return; }
        sectionOrder = sectionOrder.filter(k => k !== key);
      }
      saveSections();
      syncSectionBoxes();
      applySections();
    }

    sectionOrder = loadSections();
    syncSectionBoxes();
