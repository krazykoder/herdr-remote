    // --- Pairs (storage and UI) ---

    function loadPairs() { pairs = parsePairs(localStorage.getItem(PAIRS_KEY) || ''); }
    function savePairs() {
      localStorage.setItem(PAIRS_KEY, JSON.stringify({ version: PAIRS_VERSION, pairs: pairs }));
      // Outside any catch a quota error would land in: a browser that cannot store the pairs
      // locally is still a browser whose pairs the rest of the fleet should see.
      if (typeof stateSyncMark === 'function') stateSyncMark('pairs');
    }

    // A restart is the same colleague in a new pane, so the pair that named the dead one follows it
    // across. Members are pinned by pane_id (memberMatches), which a restart always changes — so a
    // pair went stale the moment its member was restarted, which is what took the switch button,
    // the partner's name and its badge off the strip and left a "no longer running" line instead.
    //
    // The same repair, for every way a pane can come back that this browser did not ask for: herdr
    // restarted, the workspace was reopened, the agent was launched again from the terminal. A
    // pane_id is herdr's and not ours, and a pair pinned to one that no longer exists simply stops
    // being found — the strip vanishes from both panes with nothing said about why, which is what
    // "some panes show it and others do not" looks like from the outside.
    //
    // A dead member is re-pointed at the pane that is unmistakably the same seat: same host, same
    // harness, same cwd, and exactly one such pane not already spoken for. Ambiguity is left alone
    // — two claude panes in one directory are two colleagues, and guessing between them would put
    // one agent's work in the other's terminal.
    function healPairs() {
      const claimed = new Set();
      for (const p of pairs) for (const m of p.members) {
        const live = agents.find(a => memberMatches(m, a));
        if (live) claimed.add(live.pane_id);
      }
      let moved = false;
      for (const pair of pairs) {
        pair.members = pair.members.map(m => {
          const live = agents.find(a => memberMatches(m, a));
          if (live) {
            // Found — but not necessarily where it is recorded. memberMatches pins the *agent*, and
            // an agent moves between panes; everything else here finds a member by pane id, so a
            // member matched on its id alone is one pairFor, memberOf and the strip cannot look up.
            // The pair reads healthy and draws on nothing. Re-stamped instead, which is also how an
            // id gets into a pair written before the relay minted any.
            // Compared as whole fingerprints, not pane id alone: an agent that moved *hosts* can
            // keep its pane id, since those are per-server counters. Left as it was, the member
            // still names the old host and every lookup goes to the wrong machine.
            const fp = recentFingerprint(live), was = recentFingerprint(m);
            if (Object.keys(fp).every(k => fp[k] === was[k])) return m;
            moved = true;
            return Object.assign({}, m, fp);
          }
          const same = agents.filter(a => !claimed.has(a.pane_id) &&
            (a.host || 'local') === (m.host || 'local') &&
            a.agent === m.agent && (a.cwd || '') === (m.cwd || ''));
          if (same.length !== 1) return m;
          claimed.add(same[0].pane_id);
          moved = true;
          return Object.assign({}, m, recentFingerprint(same[0]));
        });
      }
      if (moved) savePairs();
      return moved;
    }

    // How long a pair whose partner never came back is kept. A pair is two panes on one job; once
    // one of them has been gone a week the pinned fingerprint names no colleague — herdr has
    // handed that pane id to somebody else several times over by then. Until the week is up it is
    // left exactly as it is: a partner can be down for a day and still be the pair, and healPairs
    // above is what brings it back when it returns.
    const PAIR_STALE_MS = 7 * 24 * 3600 * 1000;

    // Judged only against a roster. An empty `agents` is "the relay has not answered yet", not
    // "every pane is gone", and reading it as the latter would stamp every pair stale on a
    // reconnect and delete the lot a week later. The clock is wall time and not uptime on purpose
    // — a laptop shut for a fortnight has genuinely lost those panes.
    function agePairs() {
      if (!agents.length) return false;
      const now = Date.now();
      const kept = [];
      let changed = false;
      for (const p of pairs) {
        if (pairHealth(p, agents).state === 'healthy') {
          if (p.stale) { delete p.stale; changed = true; }
          kept.push(p);
          continue;
        }
        if (!p.stale) { p.stale = now; changed = true; }
        if (now - p.stale > PAIR_STALE_MS) { changed = true; continue; }
        kept.push(p);
      }
      if (!changed) return false;
      pairs = kept;
      savePairs();
      return true;
    }

    // Never over a pane that is already in a pair of its own: that is a pairing the user made, and
    // a restart elsewhere is not a reason to rewrite it.
    function repointPair(oldPaneId, next) {
      if (!oldPaneId || !next || oldPaneId === next.pane_id) return false;
      // By pane id: `oldPaneId` names a pane that has gone, so there is no live agent for pairFor
      // to match it with. This is the pre-`aid` repair.
      const pair = pairNaming(pairs, oldPaneId);
      if (!pair || pairNaming(pairs, next.pane_id)) return false;
      pair.members = pair.members.map(m => m.pane_id === oldPaneId
        ? Object.assign({}, m, recentFingerprint(next)) : m);
      savePairs();
      return true;
    }

    // --- Line width ---
    // herdr hands back scrollback already hard-wrapped at the pane's column count, so every long
    // line the browser wraps again is wrapped twice and no break can be attributed to the agent
    // rather than to the phone. `cols` from the relay is what closes that gap.
    //
    // The arithmetic is unforgiving and worth stating: an 87-column pane in ~370 usable points is
    // 4.2 points per column. There is no font size that is both readable and fits. Hence three
    // modes rather than one behaviour — True size keeps the agent's breaks and pans; Fit width
    // shrinks to the pane, which is comfortable on a tablet and unreadable on a phone; Reflow is
    // the old behaviour, kept, and marked so a viewport wrap looks like one.
    const WRAP_KEY = 'herdr_wrap_mode', WRAP_MODES = ['true', 'fit', 'reflow'], WRAP_DEFAULT = 'true';
    let paneCols = null;   // the open pane's width in cells; null until the relay says

    function currentWrapMode() {
      const v = localStorage.getItem(WRAP_KEY);
      return WRAP_MODES.includes(v) ? v : WRAP_DEFAULT;
    }

    // Advance width of one cell, as a fraction of the font size. Measured, never assumed: the
    // stack is 'SF Mono', 'Menlo', monospace and which one resolves depends on the platform.
    let cellRatio = 0;

    function measureCellRatio() {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:100px;' +
        "font-family:'SF Mono','Menlo',monospace";
      probe.textContent = '0'.repeat(100);
      document.body.appendChild(probe);
      const ratio = probe.getBoundingClientRect().width / 100 / 100;
      probe.remove();
      // A zero would divide by zero downstream; fall back to the usual monospace advance.
      cellRatio = ratio > 0 ? ratio : 0.6;
    }

    function applyWrapMode() {
      const mode = currentWrapMode();
      const el = document.getElementById('termContent');
      el.classList.toggle('wrap-reflow', mode === 'reflow');
      el.classList.toggle('wrap-pre', mode !== 'reflow');
      document.getElementById('wrapMode').value = mode;

      // Fit width overrides the chosen text size; the other two use it as-is.
      if (mode === 'fit' && paneCols && cellRatio) {
        const avail = el.clientWidth - 20;  // the padding the text cannot use
        const px = avail / (paneCols * cellRatio);
        // Never below 4px: past that the text is a texture, and silently rendering it would
        // look like a bug rather than like the pane being too wide for the screen.
        el.style.fontSize = Math.max(4, Math.floor(px * 10) / 10) + 'px';
      } else if (mode !== 'fit') {
        el.style.fontSize = '';
      }
      // Fit width with no column count yet keeps whatever size is already on the element. Opening
      // a pane clears paneCols and lays out before the relay has reported the new width, so
      // clearing here snapped the text to full size for the frame or two until the read landed,
      // then shrank it again — one switch, two resizes.
      renderWrapHint();
      syncFontButtons();
      // Width and wrapping both just moved, so every measured row is stale.
      invalidateRows();
      drawSel();
    }

    function renderWrapHint() {
      const mode = currentWrapMode();
      const el = document.getElementById('wrapHint');
      if (!paneCols) { el.textContent = 'Pane width unknown — the relay did not report it.'; return; }
      if (mode === 'reflow') { el.textContent = `Pane is ${paneCols} cols; lines re-wrap to the screen.`; return; }
      const size = document.getElementById('termContent').style.fontSize;
      el.textContent = mode === 'fit' && size
        ? `${paneCols} cols at ${size}` : `Pane is ${paneCols} cols.`;
    }

    function setWrapMode(mode) {
      if (!WRAP_MODES.includes(mode)) return;
      try { localStorage.setItem(WRAP_KEY, mode); } catch (e) { /* private mode: session-only */ }
      applyWrapMode();
    }
