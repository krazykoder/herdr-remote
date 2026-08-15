    // The terminal is a flex sibling, not an overlay: leaving it open would stack two panes.
    // Settings and Activity are toggles onto wherever the user already was, not one-way doors.
    // The pane they came from is remembered so a second tap puts it back; without this, leaving
    // Settings always dumped them on the agent list and they had to find the pane again.
    let panelReturnPane = null;

    // Every panel that takes the list's place, against the display mode it wants — adding one is a
    // line here rather than a line in each of the four functions below. Settings is display:none in
    // its class, so an empty string would hide it; the conversation view is a flex column.
    const PANELS = { settingsView: 'block', timelineView: 'flex', convView: 'flex' };

    function hidePanels() {
      for (const id in PANELS) document.getElementById(id).style.display = 'none';
    }

    function panelIsOpen() {
      return Object.keys(PANELS).some(id => document.getElementById(id).style.display !== 'none');
    }

    function openPanel(id) {
      // Only capture on the way in. Switching Settings → Activity must not overwrite the pane
      // with the null that closing the terminal already left behind.
      if (!panelIsOpen()) {
        panelReturnPane = activePane;
        if (activePane) closeTerminal();
      }
      document.body.classList.toggle('conversation-open', id === 'convView');
      document.getElementById('agentListView').style.display = 'none';
      for (const p in PANELS) document.getElementById(p).style.display = p === id ? PANELS[p] : 'none';
    }

    function closePanel() {
      hidePanels();
      document.body.classList.remove('conversation-open');
      const back = panelReturnPane;
      panelReturnPane = null;
      // The pane may have died while the panel was open; openTerminal falls back to the ID, so
      // check the live snapshot first and land on the list rather than on a dead pane.
      if (back && agents.some(a => a.pane_id === back)) openTerminal(back);
      else document.getElementById('agentListView').style.display = '';
      // Leaving the conversation window moves where the walk stands, so its arrows are re-read.
      syncNavBtns();
    }

    // Jumping between panes is the most frequent move in the app, so every live agent gets a tab
    // in the bar that is always on screen. Snapshot order, deliberately not recency: selecting a
    // tab must not move it, or the next selection lands somewhere else.
    // Duplicate pane IDs are dropped rather than shown twice — same fail-closed rule as the list.
    // render() runs on every snapshot, so rewriting innerHTML unconditionally rebuilt the whole
    // strip a few times a second: the tabs flickered, hover was dropped mid-point, and
    // scrollIntoView re-fired. Rebuild only when the strip's own contents change, and apply the
    // selection separately — switching panes then never touches the markup.
    let tabsSig = '', tabsActive = null;

    // --- Agent order ---
    // Browser-local, like pins: the relay's snapshots own membership and status, while this only
    // says which live panes come first. The existing key keeps prior agent orders; terminals join
    // it when they appear. Landing cards read their agent subset from it, and tabs read every pane
    // from it, behind pins — a pin is "put this one at the front" and outranks it.
    const AGENT_ORDER_KEY = 'herdr_agent_order';
    let agentOrder = [];

    function loadAgentOrder() {
      try {
        const v = JSON.parse(localStorage.getItem(AGENT_ORDER_KEY) || '[]');
        agentOrder = Array.isArray(v) ? v.filter((id, i) => typeof id === 'string' && v.indexOf(id) === i) : [];
      } catch (e) { agentOrder = []; }
    }

    function saveAgentOrder() {
      try { localStorage.setItem(AGENT_ORDER_KEY, JSON.stringify(agentOrder)); }
      catch (e) { /* private mode: session-only */ }
    }

    // Ordered panes first, then everything the order has never heard of in the order it arrived.
    // A decorate-sort-undecorate rather than a plain comparator, because Array#sort is only
    // stable within equal keys and every unranked pane would otherwise share one key.
    function orderedAgents(list) {
      const rank = new Map(agentOrder.map((id, i) => [id, i]));
      return list.map((agent, index) => ({agent, index})).sort((a, b) =>
        (rank.get(a.agent.pane_id) ?? agentOrder.length + a.index)
        - (rank.get(b.agent.pane_id) ?? agentOrder.length + b.index))
        .map(x => x.agent);
    }

    // Pinned tabs, newest pin first: pinning is "put this one at the front", so a second pin has
    // to land ahead of the first. Order only, and local to this browser — a pane_id herdr later
    // reuses costs nothing worse than one tab sitting in the wrong place.
    const PIN_KEY = 'herdr_pinned_tabs';
    const MAX_PINS = 8;
    let pinnedTabs = [];

    function loadPins() {
      try {
        const v = JSON.parse(localStorage.getItem(PIN_KEY) || '[]');
        pinnedTabs = Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, MAX_PINS) : [];
      } catch (e) { pinnedTabs = []; }
    }

    function isPinned(id) { return pinnedTabs.includes(id); }

    // What the bottom strip lists. Scoped to the open pane's Project by default: the strip is for
    // moving between the panes of the thing being worked on, and a machine hosting four projects
    // turns it into a row to scroll rather than one to tap. 'all' is the old behaviour, kept.
    // 'pairs' is the third: the strip becomes the pairs themselves.
    const TAB_SCOPE_KEY = 'herdr_tab_scope';
    const TAB_SCOPES = ['project', 'all', 'pairs', 'convs'];
    function tabScope() {
      const v = localStorage.getItem(TAB_SCOPE_KEY);
      return TAB_SCOPES.includes(v) ? v : 'project';
    }

    // Two panes are in the same project when the relay resolved them to the same one. project_id
    // is the relay's answer and the label is only its display form, so the id wins where both
    // exist; panes the relay matched to nothing group together under ''.
    function projectKey(a) { return a.project_id || a.project || ''; }

    function setTabScope(v) {
      try { localStorage.setItem(TAB_SCOPE_KEY, TAB_SCOPES.includes(v) ? v : 'project'); }
      catch (e) { /* private mode: session-only */ }
      renderAgentTabs();
      renderTabScopeHint();
    }

    function savePins() {
      try { localStorage.setItem(PIN_KEY, JSON.stringify(pinnedTabs.slice(0, MAX_PINS))); }
      catch (e) { /* private mode: session-only */ }
      pinnedTabs = pinnedTabs.slice(0, MAX_PINS);
      // The order is part of the strip's signature, so this rebuild happens on its own.
      renderAgentTabs();
      if (window.cue) cue('tick');
    }

    // Double-click on a tab. Always front, never a toggle: the gesture means "put this here", and
    // one that unpinned on the second use would fight the user arranging three tabs together.
    function pinFirst(id) {
      if (!id || pinnedTabs[0] === id) return;
      pinnedTabs = [id].concat(pinnedTabs.filter(p => p !== id));
      savePins();
    }

    // The menu's item, which is the only way back out.
    function togglePin(id) {
      if (!id) return;
      const had = isPinned(id);
      pinnedTabs = pinnedTabs.filter(p => p !== id);
      if (!had) pinnedTabs.unshift(id);
      savePins();
    }

    // Hues, not colours. A pair's tint has to read as a tint against eleven themes and both
    // schemes, so it is mixed at low alpha over whatever the pill already sits on rather than
    // picked from one palette. Six is enough to tell neighbours apart; past that it wraps, which
    // is no worse than the strip today where every tab looks alike.
    //
    // Nothing near hue 220. That is --blue, which is the selected tab's fill in every theme — a
    // pair washed in it sitting beside the selection is two blues an arm's length apart.
    const PAIR_TINTS = [150, 35, 280, 350, 100, 15];

    // The live members of every healthy pair, each pair's two panes adjacent and in the order the
    // pair stores them. Adjacency and a shared tint are the whole of "side by side" — the strip
    // has no room for a link glyph between two tabs.
    function pairedTabs(list) {
      const out = [];
      pairs.forEach((pair, i) => {
        if (pairHealth(pair, agents).state !== 'healthy') return;
        const both = pair.members.map(m => list.find(a => memberMatches(m, a))).filter(Boolean);
        both.forEach((a, half) => out.push({...a, pairTint: PAIR_TINTS[i % PAIR_TINTS.length],
          pairEnd: half === both.length - 1}));
      });
      // The open pane, when it is in no pair. Same rule the project scope already follows: a strip
      // that cannot show the pane on screen is worse than one carrying an extra tab. Untinted, so
      // it reads as the exception it is.
      const openPane = activePane && !out.some(a => a.pane_id === activePane) ? paneOf(activePane) : null;
      if (openPane) out.push(openPane);
      return out;
    }

    function renderAgentTabs() {
      const el = document.getElementById('agentTabs');
      // Conversations in the pane tabs' slot, when that is the setting. Not two strips: the header
      // has one row for tabs, and a second saying the same kind of thing is how a bar stops being
      // read. On the landing page there is nothing to leave, so the pane strip is not drawn there
      // either and this changes nothing.
      const convTabs = tabScope() === 'convs' && !!activePane;
      document.body.classList.toggle('conv-tabs', convTabs);
      if (convTabs) { renderConvStrip(); return; }
      // Terminals belong here too: the strip is the live panes, and an open terminal with no tab
      // of its own reads as the strip having lost it.
      // One order for agents and terminals, not an agent block followed by a terminal block. The
      // pin sort below is stable, so this decides every unpinned tab's place.
      const all = orderedAgents(agents.concat(shells));
      let live = all.filter(a => all.filter(x => x.pane_id === a.pane_id).length === 1);
      // Scoped to the open pane's Project, when that is the setting and something is open. The
      // open pane is exempt from its own filter — a strip that cannot show the pane on screen is
      // worse than a long one. On the list screen nothing is open, so the strip stays complete.
      const scope = tabScope();
      // The conversation's members, while its thread is on screen. A thread makes you want the
      // other half of the conversation more than anything else on the machine — read what the
      // architect said, switch to the implementer, reply — and this row is where a pane switch
      // already lives. Not a second row: the same one, scoped, and read off the same members the
      // thread drew so the two can never name different panes.
      //
      // It replaces the Project scope rather than narrowing it. A conversation is free to span
      // projects — that is what makes it a conversation and not a directory — and a row that
      // dropped a member for living somewhere else would be a switch that cannot reach the pane
      // whose message is on screen.
      const reading = activePane ? paneOf(activePane) : null;
      const thread = reading && convViewOn(reading) ? convViewConv(reading) : null;
      if (thread) {
        const keys = new Set(pairedConvMembers(reading, thread).map(m => m.key));
        // The open pane is exempt from its own filter, for the reason the Project scope is: a row
        // that cannot show the pane on screen is worse than a long one.
        live = live.filter(a => keys.has(convMemberKey(a)) || a.pane_id === activePane);
      } else if (scope === 'project' && activePane) {
        const open = paneOf(activePane);
        if (open) live = live.filter(a =>
          projectKey(a) === projectKey(open) || a.pane_id === activePane);
      }
      if (scope === 'pairs') {
        live = pairedTabs(live);
      } else {
        // Pinned first, in pin order; everything else keeps snapshot order behind them, because
        // Array#sort is stable. That is the whole ordering rule — see togglePin. Not in pairs
        // mode: there, the two halves of a pair have to stay next to each other, and a pin that
        // pulled one of them to the front would split the thing the mode exists to show.
        const rank = a => { const i = pinnedTabs.indexOf(a.pane_id); return i === -1 ? MAX_PINS : i; };
        live.sort((x, y) => rank(x) - rank(y));
      }
      // Recency is in the signature too, or a tab whose colour has aged out keeps the one it was
      // built with until something else happens to rebuild the strip. The band and not a boolean:
      // there are two thresholds now, and a boolean would sit still across the first of them.
      // The badge is in the signature too, or acking a pane leaves its dot on the strip until
      // something else happens to rebuild it.
      // The tint is in the signature too, or editing a pair leaves the strip wearing the colours
      // it was built with until something else happens to rebuild it.
      const sig = live.map(a =>
        `${a.pane_id} | ${paneLabel(a)} | ${a.status || '$'} | ${activityBucket(a.pane_id)}` +
        ` | ${needsAttention(a) ? '!' : '-'} | ${a.pairTint ?? '-'}${a.pairEnd ? '.' : ''}`).join(' /// ');
      if (sig !== tabsSig) {
        tabsSig = sig;
        el.innerHTML = live.map(a => {
          // The strip pulses a working agent the same as the cards do. It was held solid on the
          // grounds that a bar which is always on screen should not carry motion — but the strip
          // is also the only place a backgrounded agent is visible at all, and a dot that is
          // merely green there says "recent" just as loudly as it says "running now".
          const color = a.agent ? statusColor(a) : shellColor(a.pane_id);
          const pulse = a.status === 'working' ? ' pulse' : '';
          const tinted = a.pairTint === undefined ? '' : ` tinted${a.pairEnd ? ' pair-end' : ''}`;
          const tint = a.pairTint === undefined ? '' : ` style="--tint:${a.pairTint}"`;
          return `<button class="agent-tab${isPinned(a.pane_id) ? ' pinned' : ''}${alertClass(attentionKind(a))}${tinted}"${tint} data-pane="${escapeHtml(a.pane_id)}" ` +
            `onclick="jumpToPane('${a.pane_id}')" ondblclick="pinFirst('${a.pane_id}')" ` +
            `title="${escapeHtml(paneTitle(a))} — double-click to pin it first">` +
            `<span class="pill">` +
            `<span class="dot${pulse}" style="background:${color}" aria-hidden="true"></span>` +
            `<span class="kind" aria-hidden="true">${a.agent ? '🤖' : '⬛'}</span>` +
            `<span class="label">${escapeHtml(paneLabel(a))}</span></span></button>`;
        }).join('');
        tabsActive = null;  // the buttons are new, so the class has to be applied again
      }
      syncTabFades();
      if (tabsActive === activePane) return;
      tabsActive = activePane;
      el.querySelectorAll('.agent-tab').forEach(b => {
        const on = b.dataset.pane === activePane;
        b.classList.toggle('active', on);
        if (!on) { b.removeAttribute('aria-current'); return; }
        b.setAttribute('aria-current', 'page');
        // Centred: landing the selection flush against an edge hides whichever neighbour you are
        // most likely to want next.
        //
        // The strip's own scrollLeft, never scrollIntoView. scrollIntoView walks every scrollable
        // ancestor, and `overflow: hidden` still makes a box programmatically scrollable — so on a
        // screen where the composer and the docks push the column past 100dvh it scrolled <body>
        // too, and the whole app stepped up and down on each tab switch. Nothing above this strip
        // has any business moving when a tab is selected. CSS scroll-behavior still smooths it,
        // and still stops smoothing under prefers-reduced-motion.
        const strip = el.getBoundingClientRect(), tab = b.getBoundingClientRect();
        el.scrollLeft += (tab.left - strip.left) - (strip.width - tab.width) / 2;
      });
    }
