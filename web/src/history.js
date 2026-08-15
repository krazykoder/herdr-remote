    // --- Session history ---
    // Back and forward across the panes this device has opened, the way a browser does it: a
    // list plus a cursor, not a most-recently-used order. The Recents list already holds MRU,
    // and stepping through something that reorders itself as you step is not navigation.
    const NAV_MAX = 20;
    let navHistory = [], navIndex = -1, navigating = false;

    // The browser's session history is the same walk, not a mirror of it: one cursor, held by the
    // browser, so the phone's Back gesture and the `‹` button cannot end up pointing at different
    // entries. Each of our entries carries a serial rather than an index, because the list drops
    // its oldest entry at NAV_MAX and every index below it would shift under a state already
    // written into the browser's stack.
    let navSerials = [], navSerial = 0, navDetached = false;
    function navBrowserHistory() {
      return typeof window === 'object' && window && window.history &&
        typeof window.history.pushState === 'function' ? window.history : null;
    }

    function navPushState() {
      const api = navBrowserHistory();
      if (!api) return;
      const state = {herdrNav: navSerials[navIndex]};
      // The first entry replaces rather than pushes, so Back off the landing page leaves the app
      // the way Back off any first page does, instead of landing on a state we put there.
      if (navHistory.length === 1) api.replaceState(state, '');
      else api.pushState(state, '');
      navDetached = false;   // whatever we had drifted past, this entry is ours again
    }

    // The gesture, the mouse button and the browser's own chrome all arrive here. Moving the cursor
    // *to* the entry named in the state — rather than stepping — is what keeps one cursor: the
    // browser has already moved, and this follows it.
    //
    // Guarded because these modules are also run as slices in a vm context, which has no window.
    if (typeof addEventListener === 'function') addEventListener('popstate', e => {
      const at = e.state && e.state.herdrNav;
      const i = at == null ? -1 : navSerials.indexOf(at);
      // A state older than NAV_MAX entries, or one another page wrote. We cannot show it, and we
      // must not keep computing deltas against a cursor the browser has already moved off — so the
      // walk stops driving the browser until the next visit re-anchors it.
      if (i < 0) { navDetached = true; return; }
      navShow(i);
    });

    // A conversation window is a stop on this walk, not a place outside it. Reading a conversation,
    // opening a member's pane from it and then wanting the record back is the ordinary way round a
    // multi-agent thread, and until this the only way back was the pane's own Back — which lands on
    // the agent list, from where the conversation has to be found again.
    //
    // Held in the same list, prefixed, rather than in a second one: back and forward are one order,
    // and two lists would have to be interleaved by a timestamp to answer "where was I" — which is
    // the list this already is.
    // Everything you can be looking at is an entry, so one walk covers all of it rather than each
    // destination growing its own one-deep memory of where it came from. Strings, not objects: the
    // list is compared with `===` in three places and the entry never needs a payload — which view
    // a pane is read in is a stored per-pane preference, so putting it in the entry would let a
    // step back override a choice made after the entry was made.
    //
    //   'w1:p1'             a pane
    //   'conv:<id>'         a conversation window
    //   'panel:settingsView' a panel
    //   'landing'           screen marker only; never a history entry
    const NAV_CONV = 'conv:', NAV_PANEL = 'panel:', NAV_LANDING = 'landing';
    function navIsConv(id) { return typeof id === 'string' && id.startsWith(NAV_CONV); }
    function navConvId(id) { return id.slice(NAV_CONV.length); }
    function navIsPanel(id) { return typeof id === 'string' && id.startsWith(NAV_PANEL); }
    function navPanelId(id) { return id.slice(NAV_PANEL.length); }

    function noteVisit(id) {
      if (navigating || navHistory[navIndex] === id) return;
      navHistory = navPush(navHistory, navIndex, id, NAV_MAX);
      // The same push, on the same cursor and cap, so the two arrays stay index-for-index: the
      // serial is what a browser history entry carries, because an index shifts under it every
      // time the list drops its oldest entry.
      navSerials = navPush(navSerials, navIndex, ++navSerial, NAV_MAX);
      navIndex = navHistory.length - 1;
      navPushState();
      syncNavBtns();
    }

    function noteConvNav(id) { noteVisit(NAV_CONV + id); }
    function notePanelNav(id) { noteVisit(NAV_PANEL + id); }

    // A conversation is alive while its record exists; a pane is alive while herdr reports it. Both
    // are skipped when they are not, so a step never lands on a record that was deleted or a pane
    // that has exited. Panels are always reachable.
    function navAlive(id) {
      if (navIsConv(id)) return loadConvIndex().some(c => c.id === navConvId(id));
      if (navIsPanel(id) || id === NAV_LANDING) return true;
      return !!paneOf(id);
    }

    function navTarget(step) {
      // Both lists, or the history silently steps over every terminal ever visited.
      return navStep(navHistory, navIndex, step, navAlive, navHere());
    }

    // Where the walk currently stands, read off the screen rather than remembered. Passed to
    // navStep so a step never re-opens what is already open.
    function navHere() {
      if (activePane) return activePane;
      const panel = openPanelId();
      if (panel === 'convView') return convViewId ? NAV_CONV + convViewId : NAV_LANDING;
      return panel ? NAV_PANEL + panel : NAV_LANDING;
    }

    // Returns whether there was anywhere to go, so a caller with its own fallback — the Back
    // chevrons, which must always leave — can tell "stepped" from "nowhere to step".
    function navGo(step) {
      const i = navTarget(step);
      if (i < 0) return false;
      // The browser's own stack holds the cursor where it can, so `‹`, the phone's Back gesture and
      // a mouse's back button are one action rather than two that can disagree. go() is
      // asynchronous: popstate below is what actually opens the destination.
      const api = navBrowserHistory();
      if (api && !navDetached) api.go(i - navIndex);
      else navShow(i);
      return true;
    }

    function navShow(i) {
      navIndex = i;
      navigating = true;
      const id = navHistory[i];
      try {
        if (navIsConv(id)) openConversation(navConvId(id));
        else if (navIsPanel(id)) openPanel(navPanelId(id));
        else if (id === NAV_LANDING) showLanding();
        else openTerminal(id);
      } finally { navigating = false; }
      syncNavBtns();
      if (window.cue) cue('page');
    }

    // Panels use the walk. Pane and conversation header chevrons deliberately return to the list.
    function goBack() { if (!navGo(-1)) showLanding(); }

    // The walk's own controls live in the status bar, which is the one row on screen in every view —
    // the pane had arrows and the conversation window had none, and a walk that crosses both needs
    // a control that does too. Enabled state is recomputed rather than remembered: a pane exiting
    // can empty the walk without anybody navigating.
    function syncNavBtns() {
      [[-1, 'navBack'], [1, 'navFwd']].forEach(([step, id]) => {
        const btn = document.getElementById(id);
        if (!btn) return;
        const label = navLabel(step);
        btn.disabled = navTarget(step) < 0;
        btn.title = btn.disabled ? '' : label;
        btn.setAttribute('aria-label', btn.disabled ? (step < 0 ? 'Back' : 'Forward') : label);
      });
      syncBackLabel();
    }

    // The pane header always exits to the list; only the status-bar arrows walk history.
    function syncBackLabel() {
      const back = document.getElementById('termBack');
      if (!back) return;
      back.setAttribute('aria-label', 'Back to the agent list');
    }

    // What a destination is called in a label. The panel names are the words on the buttons that
    // open them, not the element IDs.
    const NAV_NAMES = { settingsView: 'Settings', timelineView: 'Activity' };
    function navName(id) {
      if (id === NAV_LANDING) return 'the agent list';
      if (navIsPanel(id)) return NAV_NAMES[navPanelId(id)] || navPanelId(id);
      if (!navIsConv(id)) return paneLabel(paneOf(id)) || id;
      const conv = loadConvIndex().find(c => c.id === navConvId(id));
      return (conv && conv.name) || 'the conversation';
    }

    // What the arrow will land on, so the button says where it goes rather than "Previous session"
    // over a conversation. Falls back to the generic word where there is nowhere to step, which is
    // where the button is disabled anyway.
    function navLabel(step) {
      const i = navTarget(step);
      if (i < 0) return step < 0 ? 'Back' : 'Forward';
      return `${step < 0 ? 'Back to' : 'Forward to'} ${navName(navHistory[i])}`;
    }


    const QA_KEY = 'herdr_quick_actions';
    function quickActionsOn() { return localStorage.getItem(QA_KEY) !== 'off'; }

    // On by default, and it only ever applies to a shell — see enterAction. A terminal line ends
    // at Enter everywhere else in computing, and making that the thing you had to go and switch on
    // was the setting getting the common case backwards. One preference, not one per pane — the
    // pane a setting was made on is rarely the pane the next command is typed into.
    const ENTER_SEND_KEY = 'herdr_term_enter';
    function enterSendsOn() { return localStorage.getItem(ENTER_SEND_KEY) !== 'off'; }
    function toggleEnterSends() {
      try { localStorage.setItem(ENTER_SEND_KEY, enterSendsOn() ? 'off' : 'on'); }
      catch (e) { /* private mode: session-only */ }
      syncComposerMode();
    }

    // Everything about the composer that depends on the kind of pane it is aimed at, or on the
    // Enter setting: the placeholder, which is the only place it says what Enter does, and the
    // keyboard's own corrections.
    //
    // A shell wants none of them. `git commit` capitalised to `Git commit` is a command not found,
    // and autocorrect on a path or a flag is worse — it fails silently and looks like the shell
    // misbehaved. An agent's composer carries the same paths and flags, so it starts with none of
    // them either and the setting is what turns them on for prose.
    function syncComposerMode() {
      const input = document.getElementById('termInput');
      const shell = !!activePane && isShell(activePane);
      input.placeholder = enterSendsOn() && shell ? 'Type…  ⏎ sends' : 'Type…  ⌘/Ctrl+Enter sends';
      // A shell is a command line and never gets soft input, whatever the setting says: a rewritten
      // command is a wrong command, and there is no prose case over a terminal to weigh against it.
      applyAutocorrect(input, autocorrectOn() && !shell);
    }

    // Whether the composer stack is folded away. Open by default, and remembered: someone reading
    // long panes on a phone folds it once, not once per pane.
    const DOCK_KEY = 'herdr_bottom_dock';
    function bottomDockOpen() { return localStorage.getItem(DOCK_KEY) !== 'folded'; }

    function toggleBottomDock() {
      try { localStorage.setItem(DOCK_KEY, bottomDockOpen() ? 'folded' : 'open'); }
      catch (e) { /* private mode: session-only */ }
      syncBottomDock();
      renderQuickActions();  // the v has to become a ^, and vice versa
      // The strip names the pane the composer types into, so it is only true while there is a
      // composer. Without this the name outlives the fold by up to one poll.
      renderPairStrip();
    }

    // Jump to the newest line. It also puts the pane back to following the tail: the scroll
    // handler recomputes userScrolledUp from where this lands, so one assignment does both.
    // Reading backscroll is what pins the pane, and thumbing back down a long one is real work.
    function scrollPaneToBottom() {
      const box = document.getElementById('convThread');
      const el = box && !box.hidden ? box : document.getElementById('termContent');
      el.scrollTop = el.scrollHeight;
    }

    // paneTextPrimed is already exactly "this pane has not delivered its own text yet" — it exists
    // so the first read does not overwrite the opening timestamp — so the wait needs no second flag.
    function syncPaneLoading() {
      const waiting = !!activePane && !paneTextPrimed;
      document.getElementById('termLoading').hidden = !waiting;
      document.getElementById('termWrap').classList.toggle('loading', waiting);
    }

    function syncBottomDock() {
      document.getElementById('terminalView').classList.toggle('dock-folded', !bottomDockOpen());
    }

    function toggleQuickActions() {
      try { localStorage.setItem(QA_KEY, quickActionsOn() ? 'off' : 'on'); }
      catch (e) { /* private mode: session-only */ }
      renderQuickActions();
      renderTermMenuState();
      syncQaBtn();
    }

    // On is the accent, off is muted — the button carries the bar's state because the bar it
    // switches may be scrolled out of view when it is pressed.
    function syncQaBtn() {
      const on = quickActionsOn();
      const btn = document.getElementById('qaBtn');
      btn.style.color = on ? 'var(--orange)' : 'var(--muted)';
      btn.style.borderColor = on ? 'var(--orange)' : 'var(--border)';
      btn.setAttribute('aria-pressed', String(on));
      btn.title = on ? 'Hide the quick actions bar' : 'Show the quick actions bar';
    }

    function renderQuickActions() {
      const qa = document.getElementById('quickActions');
      if (!activePane) { qa.innerHTML = ''; return; }
      syncResend();
      const a = agents.find(x => x.pane_id === activePane);
      const blocked = a && a.status === 'blocked';
      // The nav row carries the fold control, so it also has to survive the bar being switched
      // off — folded with an empty bar would leave no way back to the composer.
      const showNav = quickActionsOn() || !bottomDockOpen();
      // An approval prompt is not a quick action the user chose to hide. Turning the bar off
      // leaves the phone able to approve — otherwise the setting would quietly cost it the one
      // thing this app exists to do.
      if (!blocked && !showNav) { qa.innerHTML = ''; return; }
      const open = bottomDockOpen();
      // Offered only when there is one to select. A button that does nothing on most panes would
      // teach people to stop pressing it on the panes where it works.
      // In the thread the same button picks the newest agent bubble; on the pane it draws the
      // band across its lines. One control, because it is one claim about one message.
      const threadOn = convThreadOn();
      const hasFinal = threadOn ? convLastAgent >= 0 : !!finalAt;
      const summary = hasFinal
        ? `<button class="qa-summary" onclick="${threadOn ? 'selectFinalConvMessage()' : 'selectFinalMessage(true)'}" ` +
        `title="Select the agent's closing message" ` +
        `aria-label="Select the agent's closing message">Summary</button>`
        : '';
      // Source order is the column order now that the edges are grid tracks rather than absolute:
      // left switches, arrows, right group.
      // Offered only on a pane that is in a conversation, for the reason Summary is conditional:
      // a button that does nothing on most panes teaches people to stop pressing it.
      const inConv = a && convsForPane(a).length;
      const threaded = inConv && convViewOn(a);
      const conv = inConv
        ? `<button class="qa-conv${threaded ? ' on' : ''}" onclick="toggleConvView()" ` +
        `aria-pressed="${threaded}" ` +
        `title="${threaded ? 'Read this pane as a terminal' : 'Read this pane as a conversation'}" ` +
        `aria-label="${threaded ? 'Read this pane as a terminal' : 'Read this pane as a conversation'}"><span class="conv-kind">💬︎</span></button>`
        : '';
      const navRow = `<div class="qa-nav"><div class="qa-left">` +
        `<button class="qa-fold" onclick="toggleBottomDock()" aria-expanded="${open}" ` +
        `title="${open ? 'Fold the composer away' : 'Bring the composer back'}" ` +
        `aria-label="${open ? 'Fold the composer away' : 'Bring the composer back'}">` +
        `${open ? 'v' : '^'}</button>${conv}</div>` +
        // The walk used to sit in a middle column here, where only a pane could reach it. It is in
        // the status bar now, one row down and on screen in every view, so the middle is empty
        // track rather than a second pair of arrows disagreeing with the first.
        `<div class="qa-right">${summary}` +
        `<button class="qa-last" onclick="scrollPaneToBottom()" title="Jump to the newest line" ` +
        `aria-label="Jump to the newest line">Last</button></div></div>`;
      let middle = '';
      if (blocked) {
        const opts = a.options || ['yes, single permission', 'trust, always allow', 'no (tab to edit)'];
        middle = opts.map(o => {
          const cls = o.includes('yes') || o.includes('approve') ? 'btn-yes' : o.includes('trust') ? 'btn-trust' : 'btn-no';
          const icon = o.includes('yes') ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>' : o.includes('trust') ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
          const label = o.includes('yes') ? 'Yes' : o.includes('trust') ? 'Yes All' : 'No';
          return `<button class="${cls}" onclick="respond('${o.replace(/'/g, "\\'")}')">${icon} ${label}</button>`;
        }).join('');
      }
      // Approvals first and on their own line, nav underneath: the row order is what puts the
      // thing that needs answering closest to the terminal it is about.
      qa.innerHTML = middle + (showNav ? navRow : '');
    }

    let paneLines = 200;
    // Which end of the pane is being read. 'visible' is the live frame and nothing behind it,
    // which is what Clear screen leaves behind; anything that asks for more history puts it back.
    let paneSource = 'recent-unwrapped';

    // How deep Load more is allowed to go. Not how much a pane opens on — that stays 200, because
    // it is paid on every pane switch. Only the ceiling moves, because the depth reached is then
    // re-read every 3 seconds for as long as the pane is open: this is a standing cost, not a
    // one-off fetch, and the browser keeps no history of its own to fall back on. The relay
    // clamps it again at READ_LINES_MAX regardless of what is stored here.
    const HISTORY_KEY = 'herdr_pane_history';
    const HISTORY_MAX = [2000, 5000, 20000, 50000], HISTORY_DEFAULT = 5000;
    function paneHistoryMax() {
      const v = parseInt(localStorage.getItem(HISTORY_KEY), 10);
      return HISTORY_MAX.includes(v) ? v : HISTORY_DEFAULT;
    }
    // "As deep as you allow." The relay clamps every request at its own `READ_LINES_MAX`, so asking
    // for more than any ceiling is answered with the ceiling — which is how the app tracks an
    // operator raising or lowering it without being edited, and why no constant here may name a
    // maximum. `HISTORY_MAX`'s top entry equalling today's is a coincidence, not a contract.
    // Recovery is the only caller: a standing read is a repeated cost and is bounded by the picker.
    const READ_LINES_ASK = 1e9;
    // A tenth of the ceiling, so reaching a deep one does not take fifty taps. 500 at the default,
    // which is the step this had before the ceiling was adjustable.
    function historyStep() { return Math.max(500, Math.round(paneHistoryMax() / 10)); }

    function setPaneHistoryMax(v) {
      const n = parseInt(v, 10);
      try { localStorage.setItem(HISTORY_KEY, HISTORY_MAX.includes(n) ? n : HISTORY_DEFAULT); }
      catch (e) { /* private mode: session-only */ }
      document.getElementById('historyPick').value = String(paneHistoryMax());
      // Lowering it while a deeper read is on screen: the next poll comes back at the new ceiling
      // rather than holding the old depth until the pane is closed.
      if (paneLines > paneHistoryMax()) { paneLines = paneHistoryMax(); refreshPane(); }
    }
    // Above this depth the 3s poll stops, and only reads the user asks for are sent. Scrollback
    // does not change — a deep read is a picture of the past, and re-fetching tens of thousands
    // of lines every three seconds to redraw the same text is a standing cost on the relay, on
    // any SSH hop, and on a phone's radio. Coming back to the tail turns it live again.
    const POLL_MAX_LINES = 1000;
    // How often the open pane is re-read, by what it is doing. A working agent's pane changes
    // between one tick and the next; an idle one does not change at all until something is sent
    // to it, and reading it twenty times a minute was most of what the relay did at rest. Safe to
    // back off because the status itself does not come from here — the snapshot broadcast carries
    // it on its own poll, so the tick after an agent starts working is already the fast one.
    // Anything that is not plainly idle keeps the fast cadence: blocked is about to be answered,
    // unknown means the status is not to be trusted, and a terminal has none at all.
    const POLL_MS = 3000, IDLE_POLL_MS = 12000;
    let lastPaneRead = 0;
    function paneIsIdle() {
      const a = activePane ? agents.find(x => x.pane_id === activePane) : null;
      return !!a && a.status === 'idle';
    }
    // auto=true is the interval. Every other caller — the refresh button, Load more, a key that
    // was just sent — is a read someone asked for and is never skipped.
    function refreshPane(auto) {
      if (auto) {
        if (paneLines > POLL_MAX_LINES) return;
        // Slack, because the tick that lands 4ms early is the same tick: without it an idle pane
        // on a 12s gap and a 3s timer waits 15.
        if (Date.now() - lastPaneRead < (paneIsIdle() ? IDLE_POLL_MS : POLL_MS) - 250) return;
      }
      if (ws && activePane) {
        lastPaneRead = Date.now();
        ws.send(JSON.stringify(
          { type: 'read_pane', pane_id: activePane, lines: paneLines, source: paneSource }));
      }
    }
