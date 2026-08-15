    // --- Line ruler ---
    // Two integers and one band element — the selection itself is never per-line DOM, and nothing
    // here is rebuilt on the 3s poll. The rows it measures against are spans (renderPaneRows), so
    // the reflow mode reads geometry off a box rather than measuring a Range.
    let selA = null, selB = null, selText = '', paneText = '', paneRows = [];

    // Not while the thread is on: the band, the handles and the block nav are all positioned
    // against pane rows, and there are none on screen to position against.
    function rulerOn() { return !!activePane && !convThreadOn(); }

    function convThreadOn() {
      const box = document.getElementById('convThread');
      return !!box && !box.hidden;
    }

    function clearSel() {
      selA = selB = null; selText = ''; selSuggested = false;
      convPicked.clear();
      drawSel();
      drawConvSel();
    }

    function lineGeom() {
      const el = document.getElementById('termContent'), cs = getComputedStyle(el);
      return { el, lh: parseFloat(cs.lineHeight) || 16, pad: parseFloat(cs.paddingTop) || 0 };
    }

    // Where each line sits, in content coordinates — measured from the top of the text and
    // independent of scrollTop, so the cache below survives scrolling.
    //
    // In the non-wrapping modes one logical line is one visual row of known height, so this is
    // arithmetic. Reflow breaks that: a line spans however many rows the screen width and the
    // break rules give it, and `word-break: break-all` plus a hanging indent plus double-width
    // glyphs put that beyond any formula worth trusting. So it is measured with a Range over the
    // text node, which is exact under every one of those.
    let rowCache = null;

    function invalidateRows() { rowCache = null; }

    function rowGeom(i) {
      const { el, lh, pad } = lineGeom();
      if (currentWrapMode() !== 'reflow') return { top: pad + i * lh, height: lh };
      const row = el.children[i];
      if (!row) return { top: pad + i * lh, height: lh };
      if (!rowCache) rowCache = new Map();
      const hit = rowCache.get(i);
      if (hit) return hit;
      const base = el.getBoundingClientRect().top - el.scrollTop;
      const box = row.getBoundingClientRect();
      const geom = { top: box.top - base, height: box.height || lh };
      rowCache.set(i, geom);
      return geom;
    }

    function lineAt(clientY) {
      const { el, lh, pad } = lineGeom();
      const y = clientY - el.getBoundingClientRect().top + el.scrollTop - pad;
      const last = paneRows.length - 1;
      if (currentWrapMode() !== 'reflow') return Math.min(last, Math.max(0, Math.floor(y / lh)));
      // Rows are ordered top to bottom, so the line under a point is a binary search — about
      // eleven measurements on a 2000-line pane, rather than one per line.
      let lo = 0, hi = last;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (rowGeom(mid).top - pad <= y) lo = mid; else hi = mid - 1;
      }
      return Math.min(last, Math.max(0, lo));
    }

    // Bring a line into view with a couple of rows of room above it, so a range that was jumped to
    // reads as a block in its context rather than as something pinned to the top edge.
    function scrollPaneToLine(i) {
      const { el, lh } = lineGeom();
      el.scrollTop = Math.max(0, rowGeom(i).top - lh * 2);
      drawSel();   // the band lives outside the scroller, so it is re-placed by hand
    }

    function drawSel() {
      const ruler = document.getElementById('ruler');
      const band = document.getElementById('selBand');
      const top = document.getElementById('rulerTop'), bot = document.getElementById('rulerBot');
      const bar = document.getElementById('selBar');
      ruler.hidden = !rulerOn();
      // Nothing to step through without a profile, and an unknown harness gets one by the user
      // selecting a message by hand and pressing Learn — so the pill appears once that has
      // happened. A learned marker has no result gutter, so stepping on one can land on a tool
      // block; pressing again passes it, which is a smaller cost than having no pill at all.
      //
      // `messages: false` is the other case: a profile that reads the pane but cannot mark where
      // one message ends. Left in, the pill is two dead buttons, and ↑ on a dead pill asks for
      // more history every press — it reads a null step as having run off the top of the read.
      document.getElementById('blockNav').hidden =
        !rulerOn() || !paneProfile || paneProfile.messages === false || !paneRows.length;
      const on = rulerOn() && selA !== null && paneRows.length > 0;
      band.hidden = top.hidden = bot.hidden = bar.hidden = !on;
      if (!on) return;
      const { el } = lineGeom();
      const a = Math.min(selA, selB), b = Math.max(selA, selB);
      selText = paneRows.slice(a, b + 1).join('\n');
      const first = rowGeom(a), last = rowGeom(b);
      const y0 = first.top - el.scrollTop, y1 = last.top + last.height - el.scrollTop;
      band.style.top = y0 + 'px';
      band.style.height = (y1 - y0) + 'px';
      const h = document.getElementById('termWrap').clientHeight;
      park(top, y0, h);
      park(bot, y1, h);
      band.classList.toggle('auto', selSuggested);
      top.classList.toggle('auto', selSuggested);
      bot.classList.toggle('auto', selSuggested);
      // "final message" is a claim about *which* message, so it is only made about the last one.
      // Stepping back through the conversation lands on earlier ones, still found rather than
      // drawn, and they are named for what they are.
      const found = !selSuggested ? ''
        : (finalAt && a === finalAt[0] && b === finalAt[1]) ? ' · final message' : ' · agent message';
      document.getElementById('selCount').textContent =
        (b - a + 1) + (b === a ? ' line' : ' lines') + found;
      // Learn is only meaningful where there is something to teach: a harness with no profile yet,
      // or a range sitting inside a block whose trim it can record.
      document.getElementById('selLearn').hidden =
        !!paneProfile && !blockContaining(paneRows, agentOf(activePane), a);
      // Transfer is the reason this feature exists, but the button only means something while
      // this pane is half of a live pair.
      document.getElementById('selTransfer').hidden = !pairFor(pairs, activePane);
    }

    // A handle whose end scrolled out of view stops at the edge rather than leaving with it.
    function park(el, y, h) {
      const c = Math.min(h - 12, Math.max(12, y));
      el.style.top = c + 'px';
      el.classList.toggle('parked', Math.abs(c - y) > 0.5);
    }

    // Called with every read. The selection follows its text; reanchorSel decides whether it
    // survived at all.
    function setPaneText(next) {
      const same = next === paneText;
      paneText = next;
      paneRows = next.split('\n');
      scanFinalMessage();   // rows below need the current summary range; parse once per read
      // Rebuilt only when the text actually changed. The pane is re-read every 3s and is usually
      // identical; rebuilding thousands of rows on each of those reads is the one thing per-line
      // DOM could plausibly cost, and this is what keeps it off the poll.
      if (!same || document.getElementById('termContent').childElementCount !== paneRows.length) {
        renderPaneRows();
        invalidateRows();
      }
      const had = selA !== null;
      if (had) {
        const at = reanchorSel(next, selText, Math.min(selA, selB), Math.max(selA, selB));
        if (at) [selA, selB] = at;
        else clearSel();   // the text it was anchored to is gone, so the range is meaningless
      }
      drawSel();
      // Only ever fills a ruler that was already empty when the read arrived. A read that just
      // destroyed someone's range is the last moment to replace it with a guess.
      if (!had) suggestFinalMessage();
      renderQuickActions();   // Summary appears and goes with the message it selects
    }

    // One row per line. Costs a span per line and buys the prompt rule staying attached to its
    // text in every wrap mode — and row geometry the ruler can read off the box instead of
    // measuring a Range through a single text node.
    function renderPaneRows() {
      const a = activePane ? paneOf(activePane) : null;
      const userLines = a && highlightOn(USER_HIGHLIGHT_KEY) ? userInputLines(paneRows, a.agent) : new Set();
      const summaryLines = a && highlightOn(SUMMARY_HIGHLIGHT_KEY) ? summaryRows(paneRows, a.agent) : new Set();
      const frag = document.createDocumentFragment();
      paneRows.forEach((row, i) => {
        const line = document.createElement('span');
        line.className = 'term-line' + (userLines.has(i) ? ' user-prompt' : '') +
          (summaryLines.has(i) ? ' summary-highlight' : '');
        line.textContent = row;
        frag.append(line);
      });
      document.getElementById('termContent').replaceChildren(frag);
    }

    // navigator.clipboard is undefined on a plain-http LAN origin, which is the ordinary way this
    // app is reached. The textarea path is the one that actually runs at home.
    function writeClipboard(text, done) {
      if (!text) return;
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done, () => { });
        return;
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { if (document.execCommand('copy')) done(); } catch (e) { /* nothing else to offer */ }
      ta.remove();
    }

    function copySel() {
      const btn = document.getElementById('selCopy');
      if (!selText) return;
      // Copying is a commit too. Without a pair configured the Transfer button never appears
      // (:4095), so this is the only thing most panes will ever teach from.
      learnFromSelection();
      writeClipboard(selText, () => {
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      });
    }

    {
      const ruler = document.getElementById('ruler');
      const bubble = document.getElementById('selBubble');
      let drag = null, autoTimer = null, lastY = 0;

      function moveTo(clientY) {
        const i = lineAt(clientY);
        if (drag === 'top') selA = i; else selB = i;
        selSuggested = false;   // touched by hand, so it is the user's range now
        drawSel();
        const wrapTop = document.getElementById('termWrap').getBoundingClientRect().top;
        bubble.textContent = (paneRows[i] || '').trim().slice(0, 40) || '(blank)';
        bubble.style.top = Math.max(0, clientY - wrapTop - 12) + 'px';
        bubble.hidden = false;
      }

      // Dragging a handle past the viewport edge has to keep growing the range, or a selection
      // can never be larger than one screen.
      function edgeScroll() {
        const { el, lh } = lineGeom(), r = el.getBoundingClientRect();
        const d = lastY < r.top + 40 ? -lh : lastY > r.bottom - 40 ? lh : 0;
        if (!d) return;
        el.scrollTop += d;
        moveTo(lastY);
      }

      ruler.addEventListener('pointerdown', e => {
        if (!rulerOn() || !paneRows.length) return;
        e.preventDefault();
        ruler.setPointerCapture(e.pointerId);
        const id = e.target.id;
        if (id === 'rulerTop' || id === 'rulerBot') drag = id === 'rulerTop' ? 'top' : 'bot';
        else { selA = selB = lineAt(e.clientY); drag = 'bot'; }
        lastY = e.clientY;
        moveTo(e.clientY);
        autoTimer = setInterval(edgeScroll, 60);
      });

      ruler.addEventListener('pointermove', e => {
        if (!drag) return;
        lastY = e.clientY;
        moveTo(e.clientY);
      });

      function end() {
        if (!drag) return;
        drag = null;
        clearInterval(autoTimer);
        bubble.hidden = true;
        // Ends swap once dragged past each other, as every selection UI does.
        if (selA > selB) { const t = selA; selA = selB; selB = t; }
        drawSel();
      }
      ruler.addEventListener('pointerup', end);
      ruler.addEventListener('pointercancel', end);

      // Tapping the text clears the range — but not when the tap was really a native drag-select,
      // which desktop users still have and which this must not fight.
      document.getElementById('termContent').addEventListener('click', () => {
        const s = window.getSelection();
        if (selA !== null && (!s || s.isCollapsed)) clearSel();
      });
    }

    const FONT_KEY = 'herdr_font_size', FONT_MIN = 6, FONT_MAX = 24, FONT_DEFAULT = 13;
    const CONV_FONT_KEY = 'herdr_conv_font_size', CONV_FONT_MIN = 6, CONV_FONT_MAX = 24, CONV_FONT_DEFAULT = 9;

    function currentConvFont() {
      const v = parseInt(localStorage.getItem(CONV_FONT_KEY), 10);
      return Number.isFinite(v) ? Math.min(CONV_FONT_MAX, Math.max(CONV_FONT_MIN, v)) : CONV_FONT_DEFAULT;
    }

    function setConvFont(px) {
      const v = Math.min(CONV_FONT_MAX, Math.max(CONV_FONT_MIN, px));
      document.documentElement.style.setProperty('--conv-font', v + 'px');
      try { localStorage.setItem(CONV_FONT_KEY, v); } catch (e) { /* private mode: session-only */ }
      document.getElementById('convFontValue').textContent = v + 'px';
      document.getElementById('convFontDec').disabled = v <= CONV_FONT_MIN;
      document.getElementById('convFontInc').disabled = v >= CONV_FONT_MAX;
    }

    function bumpConvFont(d) { setConvFont(currentConvFont() + d); }

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
      syncFontButtons();
      invalidateRows();
      drawSel();  // the line height just changed, so the band no longer covers those lines
    }

    // Fit width solves the size from the pane's column count, so A-/A+ cannot also own it.
    function fontFixedByFit() {
      return currentWrapMode() === 'fit' && !!paneCols && !!cellRatio;
    }

    function syncFontButtons() {
      const v = currentFont(), fixed = fontFixedByFit();
      document.getElementById('fontDec').disabled = fixed || v <= FONT_MIN;
      document.getElementById('fontInc').disabled = fixed || v >= FONT_MAX;
    }

    function bumpFont(d) { setFont(currentFont() + d); }

    // Floor is 8, below iOS Safari's 16px focus-zoom threshold, at the user's explicit direction.
    // Under 16 the composer will zoom the layout viewport when focused on iPhone; that is the
    // documented cost of the setting (S5.9), not an oversight. Default stays at 16, so the zoom
    // is opt-in rather than something a fresh install walks into.
    const INPUT_FONT_KEY = 'herdr_input_font_size', INPUT_MIN = 8, INPUT_MAX = 24, INPUT_DEFAULT = 16;

    function currentInputFont() {
      const v = parseInt(localStorage.getItem(INPUT_FONT_KEY), 10);
      return Number.isFinite(v) ? Math.min(INPUT_MAX, Math.max(INPUT_MIN, v)) : INPUT_DEFAULT;
    }

    function setInputFont(px) {
      const v = Math.min(INPUT_MAX, Math.max(INPUT_MIN, px));
      document.documentElement.style.setProperty('--input-font', v + 'px');
      try { localStorage.setItem(INPUT_FONT_KEY, v); } catch (e) { /* private mode: session-only */ }
      document.getElementById('inputFontValue').textContent = v + 'px';
      document.getElementById('inputFontDec').disabled = v <= INPUT_MIN;
      document.getElementById('inputFontInc').disabled = v >= INPUT_MAX;
      autoGrow(document.getElementById('termInput'));
    }

    function bumpInputFont(d) { setInputFont(currentInputFont() + d); }

    // Where the pair bar sits in the pane. Default 'above': on a phone the switch and transfer
    // controls are wanted next to the thumb that is already on the composer, not a pane away.
    const PAIR_PLACE_KEY = 'herdr_pair_place', PAIR_PLACES = ['top', 'above', 'bottom'];

    function currentPairPlace() {
      const v = localStorage.getItem(PAIR_PLACE_KEY);
      return PAIR_PLACES.includes(v) ? v : 'above';
    }

    function placePairStrip() {
      const place = currentPairPlace();
      const view = document.getElementById('terminalView');
      const strip = document.getElementById('pairStrip');
      if (place === 'top') view.insertBefore(strip, document.getElementById('termWrap'));
      else if (place === 'bottom') view.appendChild(strip);
      else view.insertBefore(strip, view.querySelector('.term-input'));
      strip.classList.toggle('at-bottom', place === 'bottom');
      document.getElementById('pairPlace').value = place;
    }

    function setPairPlace(v) {
      try { localStorage.setItem(PAIR_PLACE_KEY, PAIR_PLACES.includes(v) ? v : 'above'); }
      catch (e) { /* private mode: session-only */ }
      placePairStrip();
    }

    function toggleTermMenu() {
      const el = document.getElementById('termMenu');
      const show = el.style.display === 'none';
      if (show) renderTermMenuState();
      el.style.display = show ? '' : 'none';
      document.getElementById('termMenuBtn').setAttribute('aria-expanded', String(show));
    }

    // The two items whose text depends on live state, refreshed when the menu opens rather than
    // kept in sync from everywhere that could change it.
    function renderTermMenuState() {
      // "bar", because the composer already has a button whose label is Quick actions and which
      // opens something else entirely.
      document.getElementById('qaToggle').textContent =
        quickActionsOn() ? 'Hide quick actions bar' : 'Show quick actions bar';
      document.getElementById('menuPinTab').textContent =
        isPinned(activePane) ? 'Unpin tab' : 'Pin tab to front';
      const enter = document.getElementById('menuEnterSends');
      enter.hidden = !(activePane && isShell(activePane));
      enter.textContent = enterSendsOn() ? 'Enter inserts a newline' : 'Enter sends the line';
      document.getElementById('tabScope').value = tabScope();
      renderTabScopeHint();
      const a = agents.find(x => x.pane_id === activePane);
      const start = document.getElementById('menuStart');
      // Absent, not disabled, when the pane's Project is unknown or Projects are off: a start
      // needs a project_id, and there is nothing useful to open the dialog on without one.
      const can = !!(a && a.project_id && startOptions);
      start.hidden = !can;
      if (can) start.textContent = `New session in ${a.project || a.project_id}`;
      const dup = document.getElementById('menuDuplicate');
      // Names the harness, because "Duplicate" alone reads as copying the pane's text.
      dup.hidden = !canDuplicate(a);
      if (!dup.hidden) dup.textContent = `Duplicate this ${a.agent}`;
      const conv = document.getElementById('menuConv');
      // Only a pane an agent is running in has messages to record, so a shell is not offered one.
      conv.hidden = !(a && profileFor(a.agent));
      document.getElementById('menuConvAuto').textContent = convAutoOn()
        ? 'Stop recording new sessions' : 'Record every session';
      const joint = document.getElementById('menuConvJoint');
      const convFont = document.getElementById('menuConvFont');
      const dedupe = document.getElementById('menuConvDedupe');
      const recover = document.getElementById('menuConvRecover');
      const final = document.getElementById('menuConvFinal');
      joint.hidden = true;
      convFont.hidden = true;
      dedupe.hidden = true;
      recover.hidden = true;
      final.hidden = true;
      if (!conv.hidden) {
        const mine = convsForPane(a);
        dedupe.hidden = !mine.length;
        // Same test: both repair a transcript, and neither means anything on a pane that has none.
        recover.hidden = !mine.length;
        conv.textContent = mine.length ? `In "${mine[0].name}"…`
          : (loadConvIndex().length ? 'Add to a conversation…' : 'Start conversation…');
        // A conversation of one has no joint thread to show, so the preference is not offered.
        joint.hidden = !(mine.length && pairedConvMembers(a, mine[0]).length > 1);
        joint.textContent = convJointOn()
          ? 'Show this pane alone' : 'Show paired conversation';
        convFont.hidden = !(mine.length && convViewOn(a));
        if (!convFont.hidden) setConvFont(currentConvFont());
        // Same condition as the text size: both are about reading a thread, and neither means
        // anything while the rows are what is on screen.
        final.hidden = convFont.hidden;
        final.textContent = convFinalOnly()
          ? 'Show drafts and backfill' : 'Show final messages only';
      }
    }

    // Says what the strip is currently hiding, because a tab bar that is missing a pane and does
    // not say why reads as the pane having gone.
    function renderTabScopeHint() {
      const el = document.getElementById('tabScopeHint');
      const scope = tabScope();
      if (scope === 'all') { el.textContent = 'Every live agent and terminal.'; return; }
      if (scope === 'convs') {
        el.textContent = 'Conversations instead of panes. A tab this pane is in switches its ' +
          'thread; any other opens the conversation on its own.';
        return;
      }
      if (scope === 'pairs') {
        const n = pairs.filter(p => pairHealth(p, agents).state === 'healthy').length;
        el.textContent = n
          ? `Paired panes only, two to a colour. ${n} pair${n > 1 ? 's' : ''} running.`
          : 'Paired panes only — nothing is paired right now, so the strip holds just this pane.';
        return;
      }
      const open = activePane ? paneOf(activePane) : null;
      const name = open ? (open.project || open.project_id) : '';
      el.textContent = name
        ? `Only panes in ${name}.`
        : 'This pane has no Project, so the strip shows the others that have none either.';
    }

    // f() — the fold QUIT and CLS live behind on a narrow header. Open state is the class, so the
    // media query alone decides whether the fold exists at all.
    function toggleFireMenu() { setFireMenu(!document.getElementById('fireMenu').classList.contains('open')); }

    function setFireMenu(open) {
      document.getElementById('fireMenu').classList.toggle('open', open);
      document.getElementById('fireBtn').setAttribute('aria-expanded', String(open));
      // An arm is a promise about the next tap, and the button carrying it is about to be hidden.
      if (!open) { disarmQuit(); disarmClear(); }
    }

    function closeFireMenu() { if (document.getElementById('fireMenu').classList.contains('open')) setFireMenu(false); }

    function closeTermMenu() {
      document.getElementById('termMenu').style.display = 'none';
      document.getElementById('termMenuBtn').setAttribute('aria-expanded', 'false');
    }

    // Dismiss on any click outside the menu and its button, and on Escape.
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.term-menu-wrap')) closeTermMenu();
      if (!e.target.closest('.fire-wrap')) closeFireMenu();
      // The pane's roster panel is a disclosure hung off the header, and a tap on the thread
      // behind it is a tap on the thing it is covering.
      if (convPaneRoster && !e.target.closest('#convPaneRoster') && !e.target.closest('#paneConvWho')) {
        toggleConvPaneRoster();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeTermMenu();
        closeFireMenu();
        disarmButton();
        if (convPaneRoster) toggleConvPaneRoster();
      }
    });

    function fingerprint(a, role) {
      return {
        pane_id: a.pane_id, host: a.host || 'local', role: role,
        agent: a.agent, cwd: a.cwd || ''
      };
    }

    // Every existing lookup is agents.find(...), which returns undefined for a terminal and takes
    // the whole terminal view down to a bare pane_id title. One helper, used by everything that
    // opens or titles a pane. Pairs deliberately keep looking only at `agents`.
    function paneOf(id) {
      return agents.find(a => a.pane_id === id) || shells.find(s => s.pane_id === id) || null;
    }

    function openNotificationPane() {
      if (!notificationPane || !paneOf(notificationPane)) return;
      openTerminal(notificationPane);
      notificationPane = '';
      const url = new URL(location.href);
      url.searchParams.delete('pane');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    }

    // A service worker focuses an existing app before posting this message; a fresh app receives
    // the same pane through its URL above.
    //
    // On navigator.serviceWorker and not on window: Client.postMessage() delivers to the
    // ServiceWorkerContainer, which is a different EventTarget. A window listener hears iframes
    // and other windows — everything except the one sender this is for.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type !== 'navigate') return;
        try {
          const url = new URL(event.data.url, location.href);
          if (url.origin !== location.origin) return;
          notificationPane = url.searchParams.get('pane') || '';
          openNotificationPane();
        } catch (e) { /* malformed service-worker message */ }
      });
    }
    function isShell(id) { return shells.some(s => s.pane_id === id); }

    function paneLabel(a) { return a.label || a.project || a.agent || a.pane_id; }

    // Kind at a glance, on the same prefixes getAgentCommands matches — "claude-sonnet" and
    // "claude" have to colour alike or the colour stops meaning the kind. Anything unrecognised
    // keeps the muted default rather than borrowing a colour that already means something.
    function agentColor(agent) {
      const k = (agent || '').toLowerCase();
      if (k.startsWith('claude')) return 'var(--agent-claude)';
      if (k.startsWith('codex')) return 'var(--blue)';
      if (k.startsWith('pi') || k === 'kiro') return 'var(--green)';
      if (k.startsWith('agy')) return 'var(--agent-agy)';
      return '';
    }

    function agentBadge(agent) {
      if (!agent) return '';
      const c = agentColor(agent);
      // Text and border carry the colour; the fill stays the neutral one every badge shares.
      // A 16% wash of the accent under its own text cost ~0.8 of contrast ratio and was what
      // made the light theme's badges unreadable at this size.
      const tint = c ? `color:${c};border-color:color-mix(in srgb, ${c} 55%, transparent)` : '';
      return ` <span class="badge" style="${tint}">${escapeHtml(agent)}</span>`;
    }

    // One nomenclature wherever a pane is named — card, terminal header, both kinds of pane:
    //
    //     [emoji] name @project [agent]
    //
    // The name is what this pane is called; the Project and the agent are badges because they are
    // facts *about* it rather than parts of its name, and a badge wraps to the next line under a
    // narrow screen where a longer title would have to truncate. The @project is dropped when it
    // is also the name — an unnamed pane falls back to its Project, and printing it twice reads
    // as a pane belonging to itself.
    // withAgent=false leaves the agent badge off for a caller that puts it somewhere else — the
    // cards drop it to the second line so the first is always one line of name.
    function paneChrome(a, withAgent = true) {
      const name = paneLabel(a);
      const proj = a.project && a.project !== name
        ? ` <span class="badge proj">@${escapeHtml(a.project)}</span>` : '';
      return `<span aria-hidden="true">${a.agent ? '🤖' : '⬛'}</span> ` +
        escapeHtml(name) + proj + (withAgent ? agentBadge(a.agent) : '');
    }

    // From the live snapshot, never a pinned record: a pane's agent is what herdr reports now.
    function agentOf(paneId) { return (agents.find(a => a.pane_id === paneId) || {}).agent; }

    // One display form everywhere: project · agent · name, e.g. "charts.TS · claude · Architect 1".
    // Each part is dropped when absent, so an unnamed pane degrades to "charts.TS · claude" rather
    // than showing an empty segment or repeating the project as its own name.
    function paneTitle(a) {
      // A shell has no agent to name, and its label is its whole identity — the cwd is already on
      // the card's second line. Titled the same way here as on the card, so the header a terminal
      // opens into reads as the row that was tapped.
      if (!a.agent) return a.label || a.project || a.pane_id;
      const parts = [];
      if (a.project) parts.push(a.project);
      parts.push(a.agent);
      if (a.label && a.label !== a.project) parts.push(a.label);
      return parts.join(' · ') || a.pane_id;
    }
