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

    // A section is on screen only if it is switched on *and* has something to say. Emptiness is
    // still each renderer's own business — this reads what they wrote rather than second-guessing
    // it, so a section that renders nothing does not leave a bare separator behind.
    function applySections() {
      SECTION_KEYS.forEach(key => {
        const el = document.getElementById(SECTION_IDS[key]);
        if (!el) return;
        const at = sectionOrder.indexOf(key);
        const on = at >= 0 && !!el.innerHTML;
        el.style.order = at >= 0 ? String(at) : '';
        el.style.display = on ? '' : 'none';
        // Whichever section is drawn first needs the gap the header margin alone does not give it,
        // and CSS cannot ask for it: :first-child follows source order, not flex order. A class and
        // not an inline padding, so the size stays in the stylesheet where the narrow-screen media
        // query can shrink it along with the sides.
        el.classList.toggle('section-first', on && !sectionOrder.some((k, i) => i < at
          && document.getElementById(SECTION_IDS[k])?.innerHTML));
      });
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
