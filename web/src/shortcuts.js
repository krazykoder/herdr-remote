    // --- Terminal shortcuts (T2) ---
    // The same dock as the agent prompts, because they occupy the same place, the same toggle,
    // and the same "only one dock is open" rule. What differs is the verb: a prompt is inserted
    // for the user to read before sending, a command is sent.
    let termShortcuts = [];

    function loadTermShortcuts() {
      const raw = localStorage.getItem(TERM_KEY);
      // No key at all is a first run, not a corrupt one — seed the defaults. A key that parses to
      // nothing is either corrupt or a user who deleted every entry, and both mean an empty grid.
      termShortcuts = raw === null ? DEFAULT_TERM_SHORTCUTS.slice() : parseTermShortcuts(raw);
    }

    function saveTermShortcuts() {
      try { localStorage.setItem(TERM_KEY, JSON.stringify({ version: TERM_VERSION, items: termShortcuts })); }
      catch (e) { /* private mode: session-only */ }
    }

    // The button says what it opens: @ prompts, $ a command line. Both open the palette.
    function syncPromptsBtn() {
      const shell = !!activePane && isShell(activePane);
      const btn = document.getElementById('promptsBtn');
      btn.textContent = shell ? '$' : '@';
      btn.setAttribute('aria-label', shell ? 'Commands' : 'Prompts');
    }

    // herdr reports no process lifetime, so "has it finished" can only be answered by looking.
    // Three reads across the first few seconds cover a command that prints and exits, without
    // raising the 3s interval every open pane pays for.
    function burstPoll(paneId = activePane) {
      [400, 1200, 2500].forEach(ms => setTimeout(() => {
        if (activePane === paneId) refreshPane();
      }, ms));
    }

    let shortcutArmed = -1, shortcutArmedAt = 0;

    function runShortcut(i) {
      const s = termShortcuts[i];
      if (!s || !ws || !activePane) return;
      // Arm and fire, the same two taps the Clear control takes, rather than a modal — the arm is
      // visible in the button that will run, which a dialog covering the grid would not be.
      if (s.danger && !(shortcutArmed === i && Date.now() - shortcutArmedAt < SHORTCUT_ARM_MS)) {
        shortcutArmed = i; shortcutArmedAt = Date.now();
        refreshPalette();
        if (window.cue) cue('error');
        setTimeout(() => {
          if (shortcutArmed === i && Date.now() - shortcutArmedAt >= SHORTCUT_ARM_MS) disarmShortcut();
        }, SHORTCUT_ARM_MS);
        return;
      }
      disarmShortcut();
      if (window.cue) cue('success');
      submitText(activePane, s.text);
      closePalette();
      burstPoll();
    }

    function disarmShortcut() {
      if (shortcutArmed === -1) return;
      shortcutArmed = -1; shortcutArmedAt = 0;
      refreshPalette();
    }

    function addShortcut() {
      if (termShortcuts.length >= MAX_TERM_SHORTCUTS) {
        showToast(`Keep it to ${MAX_TERM_SHORTCUTS} commands.`); return;
      }
      const text = (prompt('Command to run in this terminal') || '').trim();
      if (!text) return;
      // Checked at save, not at send: the relay refuses over 4000, and a shortcut that can never
      // run should never make it into the grid.
      if (text.length > SEND_TEXT_MAX) { showToast(`Command must be ${SEND_TEXT_MAX} characters or fewer.`); return; }
      const label = (prompt('Button label', text.slice(0, 24)) || '').trim();
      if (!label) return;
      termShortcuts.push({ label: label.slice(0, 24), text: text, danger: confirm('Ask twice before running this one?') });
      saveTermShortcuts();
      refreshPalette();
    }

    function deleteShortcut(i) {
      const s = termShortcuts[i];
      if (!s) return;
      termShortcuts.splice(i, 1);
      saveTermShortcuts();
      refreshPalette();
    }

    // The ceiling lives in CSS (max-height) and the floor in min-height, so this only has to
    // report the content height — a px cap here would drift the moment the font size changes.
    function autoGrow(el) {
      el.style.height = 'auto';
      // A field in a view that is not on screen measures 0, and pinning that 0 shut is a composer
      // that opens as a sliver — the conversation window's is cleared while its view is hidden.
      // Left at auto it is one row, which is what it grows from anyway.
      if (!el.offsetParent) return;
      el.style.height = el.scrollHeight + 'px';
    }

    let toastTimer = null;
    function showToast(text) {
      const el = document.getElementById('toast');
      el.textContent = text;
      el.style.display = 'block';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
      if (window.cue) cue('error');
    }

    function agentCard(a) {
      const color = statusColor(a);
      const pulseClass = a.status === 'working' ? ' pulse' : '';
      const host = a.host && a.host !== 'local' ? ` <span style="color:var(--orange);font-size:0.6rem">@${a.host}</span>` : '';
      const cwd = a.cwd ? `<span style="font-family:monospace;opacity:0.7">${a.cwd.split('/').slice(-2).join('/')}</span>` : '';
      // Escaped once here rather than at each aria-label: a pane can be renamed to anything with a
      // quote in it, and an attribute that breaks out of itself is not a cosmetic bug.
      const label = escapeHtml(paneLabel(a));
      // Line 1 is the name and never wraps into two; the agent badge rides down to line 2 with
      // the path, where it is the same width every time and the list reads as a column. The dot
      // to the left is untouched — it is the live status, and the emoji only says what kind of
      // pane this is, which is why the two do not share a column.
      const kind = attentionKind(a);
      // Said apart to a screen reader too: "needs you" on a finished pane is a false alarm that
      // costs more when the colour and the blink are not there to correct it.
      const note = kind === 'blocked' ? ', needs you' : kind === 'done' ? ', finished' : '';
      const paired = pairFor(pairs, a.pane_id);
      return `<div class="agent${kind ? ' attention' : ''}${kind === 'done' ? ' alert-done' : ''}" role="button" tabindex="0" aria-label="${label}, ${a.status}${note}" onclick="openTerminal('${a.pane_id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTerminal('${a.pane_id}')}">
    <span class="dot${pulseClass}" style="background:${color}" aria-hidden="true"></span>
    <div class="info"><div class="project">${paneChrome(a, false)}${host}</div><div class="meta">${agentBadge(a.agent).trimStart()} ${cwd}</div></div>
    <button class="pair-btn${paired ? ' paired' : ''}" aria-label="Pair ${label}" onclick="openPairDialog('${a.pane_id}',event)">${paired ? 'Paired' : 'Pair'}</button>
    <span class="chev" aria-hidden="true">›</span>
  </div>`;
    }

    // The one place the user's order is applied to cards. Every list on the main page — the hoist,
    // each status section, a Project's panes — ends here, so ordering once at the bottom covers
    // all of them and cannot fall out of step between two of them.
    function agentCards(list) {
      return orderedAgents(list).map(agentCard).join('');
    }

    // `note` rides in the header at reduced weight, the same way the blocked count does. A section
    // kept on screen with nothing under it has to say why in the only row it has.
    function section(title, list, note) {
      return `<div class="section-header">${title}` +
        (note ? ` <span style="opacity:0.6">${note}</span>` : '') + `</div>` +
        agentCards(list);
    }

    // This action belongs with the live-pane list, not Settings. First heading is whichever agent
    // group is currently on top, so it stays visible without a second heading above status groups.
    // Appended after the list is written rather than built into section(), which has no way of
    // knowing which of its calls came first.
    function addOrderButton() {
      const header = document.querySelector('#agents .section-header');
      if (header) header.insertAdjacentHTML('beforeend',
        '<button class="section-action" onclick="openOrder()" aria-label="Reorder tabs">Reorder</button>');
    }

    function terminalCard(s) {
      const host = s.host && s.host !== 'local' ? ` <span style="color:var(--orange);font-size:0.6rem">@${s.host}</span>` : '';
      const cwd = s.cwd ? `<span style="font-family:monospace;opacity:0.7">${s.cwd.split('/').slice(-2).join('/')}</span>` : '';

      // No status dot and no Pair button, and both absences are the point: a shell has no status,
      // and a pair is agent-to-agent.
      return `<div class="agent" role="button" tabindex="0" aria-label="Terminal ${escapeHtml(paneLabel(s))}" onclick="openTerminal('${s.pane_id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTerminal('${s.pane_id}')}">
    <span class="term-glyph" aria-hidden="true">$</span>
    <div class="info"><div class="project">${paneChrome(s)}${host}</div><div class="meta">${cwd}</div></div>
    <span style="color:var(--muted);font-size:1.2rem" aria-hidden="true">›</span>
  </div>`;
    }

    // Not section(): that maps agentCard over its list. Same header markup, different card, and a
    // colour that is none of the three carrying agent status.
    function terminalsHtml() {
      const list = activeProject ? shells.filter(s => s.project_id === activeProject) : shells;
      if (!list.length) return '';
      return `<div class="section-header">Terminals</div>`
        + orderedAgents(list).map(terminalCard).join('');
    }

    function pairsHtml() {
      const rows = pairs.map(pair => {
        if (pairHealth(pair, agents).state !== 'healthy') return '';
        const [left, right] = pair.members.map(member => agents.find(a => memberMatches(member, a)));
        return `<div class="pair-row" role="group" aria-label="${escapeHtml(pair.name)}">` +
          agentCard(left) + `<span class="pair-link" aria-label="paired with">↔</span>` + agentCard(right) + `</div>`;
      }).filter(Boolean);
      return rows.length ? `<div class="section-header">Pairs</div>` + rows.join('') : '';
    }

    // The index already carries the only landing-page facts that do not require opening every
    // transcript: each member's count and newest message time. Live-ness comes from this snapshot.
    // Which conversations the landing list shows, and in what order: newest message first, and the
    // auto ones only when the reader has them switched on and only the newest CONV_LANDING_AUTO_MAX
    // of those. The strip in the conversation view draws from this too — a tab bar that disagreed
    // with the list it was opened from would be a second answer to the same question.
    function convLandingList() {
      const seenOf = convSeenAt;
      const countOf = c => (c.members || []).reduce((n, m) => n + (Number(m.messages) || 0), 0);
      // A conversation the user made outranks one the app filed for itself, however lively the auto
      // one is: the named ones are the reader's own list, and an auto record that happens to be
      // busy pushing them down the page is the app rearranging their shelf. Within each tier it is
      // the work that decides — newest message first, then the fuller record.
      const by = (a, b) => (!!a.auto - !!b.auto) || seenOf(b) - seenOf(a) || countOf(b) - countOf(a);
      const all = loadConvIndex().sort(by);
      const autos = all.filter(c => c.auto);
      return { all: all, autos: autos,
        shown: all.filter(c => !c.auto)
          .concat(convLandingAutoOn() ? autos.slice(0, CONV_LANDING_AUTO_MAX) : []).sort(by) };
    }

    function renderConversations() {
      const el = document.getElementById('conversations');
      if (!el) return;
      const now = Date.now();
      const list = convLandingList();
      const rows = list.shown.map(c => {
        const members = c.members || [];
        const count = members.reduce((n, m) => n + (Number(m.messages) || 0), 0);
        const seen = Math.max(0, ...members.map(m => Number(m.seen) || 0));
        const live = members.map(m => agents.find(a => convMemberKey(a) === m.key)).filter(Boolean);
        const names = members.map(m => escapeHtml(m.label || (agents.find(a => convMemberKey(a) === m.key) || {}).label || 'Former pane'));
        const liveNames = live.map(a => escapeHtml(paneLabel(a)));
        // The newest message across the members, which is the one line that says whether this
        // conversation is worth opening. Written by convNoteCounts as each member records.
        const newest = members.reduce((w, m) =>
          (Number(m.seen) || 0) >= (Number(w.seen) || 0) ? m : w, members[0] || {});
        // The agent card's dot, not a second dialect of it: this card stands in for the panes in
        // it, and a conversation whose agent is working should read exactly as that agent's own
        // card does — pulse included. One member speaks for the card, and it is the one whose
        // state the reader would have gone looking for.
        const lead = live.find(a => a.status === 'blocked') || live.find(a => a.status === 'working')
          || live.find(a => attentionKind(a) === 'done') || live[0];
        return {
          c, count, seen, names, liveNames, last: newest.last || '',
          dot: lead ? statusColor(lead) : 'var(--muted)',
          pulse: lead && lead.status === 'working' ? ' pulse' : '',
        };
      });
      const autos = list.autos, showAuto = convLandingAutoOn(), shown = rows;
      const autoControl = autos.length
        ? `<button class="section-action" onclick="toggleConvLandingAuto()" aria-pressed="${showAuto}" ` +
          `title="Shows up to ${CONV_LANDING_AUTO_MAX} latest automatic conversations">` +
          `${showAuto ? 'Hide auto' : 'Show auto'} (${autos.length})</button>` : '';
      el.innerHTML = list.all.length ? `<div class="section-header">Conversations${autoControl}</div>` + shown.map(r =>
        `<div class="conversation-card" role="button" tabindex="0" data-conv-id="${escapeHtml(r.c.id)}"` +
        ` onclick="openConversation(this.dataset.convId)"` +
        ` onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openConversation(this.dataset.convId); }">` +
        // The mark, then the live dot: what this card is, then how its panes are doing. The dot
        // alone was doing both jobs, which is why a conversation card and an agent card opened the
        // same way but did not read as different things.
        // Dot, mark, name — the dot is the row's live state and reads first on every card in the
        // list; the mark says what kind of thing the name belongs to.
        `<div class="conversation-title"><span class="dot${r.pulse}" style="background:${r.dot}"` +
        ` aria-hidden="true"></span><span class="conv-kind">${convGlyph()}</span>` +
        `<span class="name">${escapeHtml(r.c.name)}</span>` +
        // The tier, on the card rather than in the name: promotion is a rename the user makes,
        // not a marker the app writes into what they typed (D4).
        `${r.c.auto ? '<span class="conversation-tier" title="Filed automatically, and dropped ' +
          'first when space runs out. Open it and rename it to keep it for good.">auto</span>' : ''}` +
        `<span class="conversation-count">${r.count} ` +
        `${r.count === 1 ? 'message' : 'messages'}</span></div>` +
        (r.last ? `<div class="conversation-last">${escapeHtml(r.last)}</div>` : '') +
        `<div class="conversation-meta">${r.names.join(' · ')}</div>` +
        `<div class="conversation-meta">${r.liveNames.length ? 'Live: ' + r.liveNames.join(', ') : 'No live members'}` +
        `${r.seen ? ' · Last activity ' + fmtAgo(new Date(Math.min(r.seen, now))) : ''}</div></div>`
      ).join('') : '';
      applySections();
    }

    // The conversation the standalone view is showing, or null. Held rather than passed, because
    // the snapshot redraws it: live-ness is the one thing on that view that changes under it.
    let convViewId = null;

    // A card opens the conversation itself, and not a pane: the record is what the card names, and
    // it outlives every pane that wrote it. Read-only — the pane is one tap further on, for the
    // members that still have one.
    function openConversation(id) {
      const conv = loadConvIndex().find(c => c.id === id);
      if (!conv) return;
      stashConvDraft();   // before the id moves, or the draft is filed under where it is going
      convViewId = id;
      noteConvVisit(id);   // the Recent switcher's log, which is MRU
      noteConvNav(id);     // and the ‹ › walk, which is order of visit
      clearConvDock();
      restoreConvDraft();   // whatever was left half-written to *this* conversation earlier
      convStandaloneHtml = '';
      convRosterHtmlLast = '';
      convStripSig = '';
      convRosterOpen = false;
      convAdding = false;
      openPanel('convView');
      syncNavBtns();   // the walk is standing somewhere new, and its arrows are on screen here too
      // Tabs come from the index and live snapshot, not transcript storage. Draw them before the
      // IndexedDB read below so first open has navigation while its messages load.
      renderConvStrip();
      renderConvStandalone(true);
    }

    // The only action the read-only view offers: the first live member's pane, opened as the list
    // would open it. Absent — not disabled — when the conversation has no live member, because
    // that is the ordinary end state of a record and not a failure to explain.
    // The header button's choice: the first member of the roster that is both live and not folded
    // out of the thread. Roster order is when each member joined, so this is the conversation's
    // oldest running session — there is no "primary", and a pair partner is something the pane's
    // own thread adds once it is open, not something this picks.
    function convVisibleLive(conv) {
      const hidden = convHidden(conv.id);
      return (conv.members || []).filter(m => !hidden.has(m.key))
        .map(m => agents.find(a => convMemberKey(a) === m.key)).find(Boolean) || null;
    }

    function openConvPane() {
      const conv = loadConvIndex().find(c => c.id === convViewId);
      const live = conv && convVisibleLive(conv);
      if (live) openConvMemberPane(convMemberKey(live));
    }

    function openConvMemberPane(key) {
      const conv = loadConvIndex().find(c => c.id === convViewId);
      const live = conv && agents.find(a => convMemberKey(a) === key);
      if (!live) return;
      // The thread panel, on, and showing *this* conversation: a pane in several would otherwise
      // open on whichever one it was last read under.
      convSetView(live, conv.id);
      // No "return to this conversation" carried along: the conversation is the entry behind this
      // one on the walk, and Back is that entry.
      jumpToPane(live.pane_id);
    }

    let convStandaloneToken = 0, convStandaloneHtml = '', convAdding = false;
    // The roster panel's disclosure state, and which members the reader has folded out of the
    // thread. Both are about looking, not about the record: hiding a member changes no membership,
    // deletes no words, and stops no recording — it is the reading equivalent of turning a page
    // sideways, and unhiding puts everything back.
    let convRosterOpen = false, convRosterHtmlLast = '';
    const CONV_HIDDEN_KEY = 'herdr_conv_hidden';

    function convHiddenAll() {
      try {
        const d = JSON.parse(localStorage.getItem(CONV_HIDDEN_KEY) || '');
        return d && typeof d === 'object' ? d : {};
      } catch (e) { return {}; }
    }

    // Per conversation, because the same pane can be worth reading in one grouping and noise in
    // another — which is the whole reason a pane may be in several.
    function convHidden(id) { return new Set(convHiddenAll()[id] || []); }

    function toggleConvHidden(key) {
      const all = convHiddenAll(), have = new Set(all[convViewId] || []);
      if (have.has(key)) have.delete(key); else have.add(key);
      if (have.size) all[convViewId] = Array.from(have); else delete all[convViewId];
      try { localStorage.setItem(CONV_HIDDEN_KEY, JSON.stringify(all)); }
      catch (e) { /* private mode: this session only */ }
      convStandaloneHtml = '';
      renderConvManage();
    }

    // Whichever of the two views is on screen. Same roster, same actions; only the frame differs,
    // and each of these returns immediately when its own view is not up.
    function renderConvManage() {
      renderConvStandalone(false);
      renderConvView();
    }

    function toggleConvRoster() {
      convRosterOpen = !convRosterOpen;
      renderConvStandalone(false);
    }

    // The pane's own copy of that disclosure. Separate state: closing the panel in one view must
    // not close it in the other, and the two are never on screen together.
    let convPaneRoster = false;

    function toggleConvPaneRoster() {
      convPaneRoster = !convPaneRoster;
      renderConvView();
    }

    // The button and its panel, which live in the pane header rather than in the thread. The panel
    // is diffed on its own: renderConvView runs on every poll, and rebuilding open rows three times
    // a minute would take a reader's tap target out from under their finger.
    let convPaneRosterHtml = '';

    function renderConvPaneChrome(conv, recs, hidden, key, entries) {
      const who = document.getElementById('paneConvWho'), panel = document.getElementById('convPaneRoster');
      const n = (conv.members || []).length;
      // The panel's actions read the thread that was drawn — Copy writes it out, Start again reads
      // a member's spawn from it. Same variables as the standalone view's, for the same reason
      // convViewId is: the two are never on screen together.
      convViewRecs = recs;
      convViewEntries = entries;
      who.hidden = false;
      who.textContent = `${n} pane${n === 1 ? '' : 's'} ▾`;
      who.setAttribute('aria-expanded', convPaneRoster ? 'true' : 'false');
      panel.hidden = !convPaneRoster;
      const html = convPaneRoster ? convRosterHtml(conv, recs, hidden, key) : '';
      if (html !== convPaneRosterHtml) { panel.innerHTML = html; convPaneRosterHtml = html; }
    }

    // Leaving the thread takes the panel with it — it acts on a conversation the pane is no longer
    // showing, and the header behind it belongs to the rows.
    function hideConvPaneRoster() {
      const who = document.getElementById('paneConvWho'), panel = document.getElementById('convPaneRoster');
      who.hidden = true;
      panel.hidden = true;
      panel.innerHTML = '';
      convPaneRosterHtml = '';
      convPaneRoster = false;
    }
    // What the standalone view last drew, so Copy and Start again read the same thread the reader
    // is looking at rather than fetching it a second time and getting a different one.
    let convViewRecs = [], convViewEntries = [];

    // Who is in this conversation, and the three edits that are the conversation's own rather than
    // a pane's. Only in the standalone view: this is where a conversation is owned, and the pane's
    // thread panel is a pane reading itself.
    //
    // Removing a member is deliberately not what a pane exiting does. An exit removes nothing — a
    // member is recording or ended, and that is derived (D1). This pulls what that member said out
    // of the thread and stops its transcript being referenced, so it is worded as what it does and
    // asked twice.
    function convRosterHtml(conv, recs, hidden, reading) {
      const live = new Set(agents.map(x => convMemberKey(x)));
      const off = hidden || new Set();
      const rows = (conv.members || []).map((m, i) => {
        const rec = recs.find(r => r.key === m.key) || {};
        const on = live.has(m.key);
        const out = off.has(m.key);
        return `<div class="conv-roster-row${on ? '' : ' gone'}${out ? ' hidden-member' : ''}">` +
          // Folding a member out of the thread, and nothing more. Beside the name because that is
          // what it acts on, and pressed rather than checked because the row already says which
          // state it is in by how it is drawn.
          // Not on the pane whose thread this is: hiding it would leave the reader on an empty
          // screen with the way back on the thing they just hid.
          (m.key === reading ? '<span class="conv-eye reading" aria-hidden="true">◉</span>'
            : `<button class="conv-eye" data-key="${escapeHtml(m.key)}" aria-pressed="${out ? 'true' : 'false'}"` +
              ` onclick="toggleConvHidden(this.dataset.key)"` +
              ` aria-label="${out ? 'Show' : 'Hide'} this member in the thread">${out ? '◌' : '◉'}</button>`) +
          `<span class="dot" style="background:${convTint(i)}"></span>` +
          `<span class="who">${escapeHtml(rec.label || m.label || 'Former pane')}</span>` +
          agentBadge((rec.spawn || {}).agent || '') +
          `<span class="tag">${out ? 'hidden' : (on ? 'recording' : 'no longer live')}</span>` +
          // Every live member, not only whichever one the header's button would pick: the header
          // opens the first, and a conversation of four is exactly where that is the wrong one.
          (on ? `<button class="conv-open" data-key="${escapeHtml(m.key)}"` +
            ` onclick="openConvMemberPane(this.dataset.key)"` +
            ` aria-label="Open this member's pane">Open</button>` : '') +
          (!on && canRespawn(rec.spawn) ? `<button class="conv-again arm-btn" data-key="${escapeHtml(m.key)}"` +
            ` onclick="convArmRespawn(this, this.dataset.key)"` +
            ` aria-label="Start a new session and continue this conversation">Start again</button>` : '') +
          `<button class="conv-drop arm-btn" data-key="${escapeHtml(m.key)}"` +
          ` onclick="armButton(this, 'Remove?', () => convRemoveMember(this.dataset.key))"` +
          ` aria-label="Remove this member from the conversation">Remove</button></div>`;
      }).join('');
      // Candidates are the live panes this conversation does not already name — including panes
      // already recording elsewhere, which bring their own transcript with them (D3).
      const taken = new Set((conv.members || []).map(m => m.key));
      const free = agents.filter(x => convMemberKey(x) && !taken.has(convMemberKey(x)));
      // And the sessions that have already ended, which is what a conversation assembled after the
      // fact is made of. Newest first: a picker is ordered by what you are most likely to want.
      const now = Date.now();
      const past = convPickRecs
        .filter(r => !taken.has(r.key) && !live.has(r.key) && (r.entries || []).length)
        .sort((a, b) => (b.touched || 0) - (a.touched || 0))
        .slice(0, CONV_PICK_MAX);
      // Both groups are the same kind of choice — a session, by name, with the harness it runs —
      // so they are the same chip. What differs is the heading above them and, for one that has
      // ended, how long ago it last said anything.
      const chips = !convAdding ? '' : `<div class="conv-roster-add">` +
        `<span class="conv-pick-head">Running</span>` + (free.length
        ? free.map(x => `<button class="conv-chip" data-key="${escapeHtml(convMemberKey(x))}"` +
            ` onclick="convJoinPane(this.dataset.key)">${escapeHtml(paneLabel(x))}` +
            agentBadge(x.agent || '') + '</button>').join('')
        : '<span class="conv-none">Every live pane is already in this conversation.</span>') +
        (past.length ? `<span class="conv-pick-head">Recorded</span>` + past.map(r =>
          `<button class="conv-chip past" data-key="${escapeHtml(r.key)}"` +
          ` onclick="convJoinRecord(this.dataset.key)">${escapeHtml(r.label || 'Former pane')}` +
          agentBadge((r.spawn || {}).agent || '') +
          `<span class="ago">${escapeHtml(convSpan(now - (r.touched || now)))}</span></button>`
        ).join('') : '') + '</div>';
      // The tier, said where the button that changes it is. "How do I make this one mine" is the
      // question an auto record raises, and the answer is one word on the button below it.
      const tier = conv.auto
        ? '<p class="conv-tier-note">Filed automatically, and dropped first when space runs out. ' +
          'Rename it to keep it for good.</p>' : '';
      return `<div class="conv-roster">${rows}<div class="conv-roster-actions">` +
        // Destructive action first, followed by the two ways to preserve the grouping, then edits.
        `<button class="conv-del arm-btn" onclick="armButton(this, 'Delete?', deleteConversation)"` +
        ` aria-label="Delete this conversation, keeping the transcripts">Delete</button>` +
        `<button id="convCopyBtn" onclick="convCopy()">Copy</button>` +
        `<button class="arm-btn" onclick="armButton(this, 'Duplicate?', duplicateConversation)"` +
        ` aria-label="Copy this conversation so panes can be added without changing this one">` +
        `Duplicate</button>` +
        `<button onclick="renameConversation()">Rename</button>` +
        `<button aria-pressed="${convAdding ? 'true' : 'false'}"` +
        ` onclick="convToggleAdd()">Add pane</button>` +
        `</div>${chips}${tier}</div>`;
    }

    // A pane does not carry the role it was started with, and neither does a record that predates
    // convSpawn. The fallback is the one the Start dialog would have opened on, exactly as roleOf's.
    function respawnRole(spawn) {
      const roles = (startOptions && startOptions.roles) || [];
      return roles.includes(spawn.role) ? spawn.role : roles[0];
    }

    // canDuplicate's predicate, read off a record rather than off a pane: the relay willing to
    // start, a Project it still knows, and a harness inside the allowlist. Everything it refuses
    // gets no button rather than a refusal after the tap.
    function canRespawn(spawn) {
      return !!(spawn && spawn.agent && spawn.project_id && startOptions
        && (startOptions.agents || []).includes(spawn.agent)
        && projects.some(p => p.id === spawn.project_id) && respawnRole(spawn));
    }

    // Continuing is adding a member, and a respawn is a **new** one — a new pane means a new
    // convMemberKey, which means a new transcript (D3). That is what stops a recycled pane id
    // inheriting a dead session's words, and the joint view's time merge is what makes the two
    // read as one thread across the seam.
    // What the first tap says, because the second one starts a real session on a real host and a
    // drain cannot carry a sentence. The relay takes a new session's cwd from the Project and
    // never from the client, so the recorded cwd is *shown* rather than sent: if the Project has
    // been repointed since, the two disagree, and pretending they agree is the one thing this
    // must not do.
    function respawnNote(key) {
      const rec = convViewRecs.find(r => r.key === key), spawn = rec && rec.spawn;
      if (!canRespawn(spawn)) return '';
      const project = projects.find(p => p.id === spawn.project_id) || {};
      const where = agents.find(x => x.project_id === spawn.project_id && x.cwd);
      const moved = where && spawn.cwd && where.cwd !== spawn.cwd
        ? ` It ran in ${spawn.cwd}; that Project now points at ${where.cwd}.` : '';
      return `Tap again to start a new ${spawn.agent} session in ${project.label || 'this Project'}.${moved}`;
    }

    function convArmRespawn(btn, key) {
      // Said on the arm, not on the fire: by the second tap the session is already starting.
      if (armedEl !== btn) { const note = respawnNote(key); if (note) showToast(note); }
      armButton(btn, 'Start again?', () => convRespawn(key));
    }

    function convRespawn(key) {
      const conv = loadConvIndex().find(c => c.id === convViewId);
      const rec = convViewRecs.find(r => r.key === key);
      const spawn = rec && rec.spawn;
      if (!ws || !conv || !canRespawn(spawn)) return;
      // herdr recycles workspace IDs, so a stale one cannot be trusted to name the workspace the
      // session was in. New tab only where that workspace is live on that host right now.
      const tab = !!spawn.workspace_id && agents.some(x => x.workspace_id === spawn.workspace_id
        && (x.host || 'local') === (spawn.host || 'local'));
      const msg = {
        type: 'start_agent', name: spawn.agent, role: respawnRole(spawn),
        project_id: spawn.project_id,
        placement: tab ? 'new_tab' : 'new_workspace', slot: slotFor(),
      };
      if (tab) msg.workspace_id = spawn.workspace_id;
      startIntent = { conv: conv.id };
      showSpawnStatus(`Continuing "${conv.name}"…`, 'busy');
      ws.send(JSON.stringify(msg));
    }

    // The whole thread as Markdown, members and what they were included: a conversation is a
    // record of what happened in a repo, and the place that record is wanted is usually somewhere
    // that is not this app. The roster doubles as the start details — every field is one the
    // transcript already carries, so there is no second button for it.
    function convMarkdown(conv, recs, entries) {
      const live = new Set(agents.map(x => convMemberKey(x)));
      const who = (conv.members || []).map(m => {
        const rec = recs.find(r => r.key === m.key) || {}, spawn = rec.spawn || {};
        const facts = [spawn.agent, spawn.role, spawn.project || spawn.cwd].filter(Boolean);
        return `- ${rec.label || m.label || 'Former pane'}` +
          (facts.length ? ` — ${facts.join(' · ')}` : '') +
          ` (${live.has(m.key) ? 'recording' : 'no longer live'})`;
      }).join('\n');
      const body = entries.map(e => {
        const at = convAt(e);
        // The tilde the thread draws, in words: a stamp that is an ordering rather than a reading
        // must not be pasted somewhere else as if it were a reading.
        const when = at ? new Date(at).toLocaleString() + (convAtRank(e) ? '' : ' (approx)') : '';
        return `### ${e.label || 'unknown'}${when ? ` — ${when}` : ''}\n\n${e.text || ''}`;
      }).join('\n\n');
      return `# ${conv.name}\n\n${who}\n\n${body}\n`;
    }

    function convCopy() {
      const conv = loadConvIndex().find(c => c.id === convViewId);
      if (!conv || !convViewEntries.length) return;
      const btn = document.getElementById('convCopyBtn');
      writeClipboard(convMarkdown(conv, convViewRecs, convViewEntries), () => {
        if (!btn) return;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      });
    }

    function convEdit(fn) {
      const items = loadConvIndex();
      const conv = items.find(c => c.id === convViewId);
      if (!conv || fn(conv, items) === false) return;
      saveConvIndex(items);
      renderConversations();
      renderTermMenuState();
      renderConvBar();
      renderConvStandalone(false);
    }

    // Naming is the whole of promotion (D4): what the user named is permanent, what the app named
    // for them is not, and there is no second concept to learn.
    function renameConversation() {
      const conv = loadConvIndex().find(c => c.id === convViewId);
      if (!conv) return;
      const next = prompt('Name for this conversation', conv.name || '');
      if (next === null) return;
      const name = next.trim().slice(0, 64);
      if (!name || name === conv.name) return;
      convEdit(c => { c.name = name; delete c.auto; });
    }

    // A grouping is a view over transcripts, so a copy of one costs a row in the index and not a
    // word in the database. That is what makes "A and B, then A, B and C, and compare" a thing the
    // user can do at all: editing the original would destroy the reading being compared against.
    //
    // The copy is named, never auto. Making one is an assertion that this grouping matters, which is
    // exactly what D4 defines the named tier to be — and it stops the copy being evicted out from
    // under the comparison it was made for.
    function duplicateConversation() {
      const items = loadConvIndex(), conv = items.find(c => c.id === convViewId);
      if (!conv) return;
      const copy = {
        id: 'c_' + Math.random().toString(36).slice(2, 10),
        name: convCopyName(conv.name, items.map(c => c.name)),
        created: Date.now(),
        members: (conv.members || []).map(m => Object.assign({}, m)),
      };
      items.unshift(copy);
      saveConvIndex(items);
      renderConversations();
      // Straight into the copy: the next thing the user does is add the member they made it for.
      // From a pane that means switching that pane's thread to it rather than leaving the pane —
      // the copy holds this pane, so it is a grouping the pane can be read under.
      const a = document.getElementById('convView').style.display === 'none' && activePane
        ? paneOf(activePane) : null;
      if (a && (copy.members || []).some(m => m.key === convMemberKey(a))) {
        convViewId = copy.id;
        convSetView(a, copy.id);
        renderConvBar();
      } else {
        openConversation(copy.id);
      }
      showToast(`Copied to "${copy.name}".`);
    }

    // What the picker offers besides the live panes, read once when it opens. Held rather than
    // re-read on every redraw: the standalone view repaints on every snapshot, and a store scan on
    // the poll path is what this deliberately is not.
    let convPickRecs = [];
    const CONV_PICK_MAX = 60;

    async function convToggleAdd() {
      convAdding = !convAdding;
      if (!convAdding) { convPickRecs = []; renderConvManage(); return; }
      renderConvManage();
      convPickRecs = await convAll();
      if (convAdding) renderConvManage();
    }

    // A member built from a record instead of from a pane: the session has ended, so there is no
    // paneLabel to ask and the record's own label is the only name it has left.
    function convJoinRecord(key) {
      const rec = convPickRecs.find(r => r.key === key);
      if (!rec) return;
      convAdding = false;
      convPickRecs = [];
      // No CONV_MEMBER_MAX check: that caps panes *recording* at once, and this one has stopped.
      convEdit(conv => {
        conv.members = (conv.members || []).concat(
          { key: key, added: Date.now(), label: rec.label || '' });
      });
    }

    function convJoinPane(key) {
      const pane = agents.find(x => convMemberKey(x) === key);
      if (!pane) return;
      convAdding = false;
      convPickRecs = [];
      convEdit(conv => {
        if (convRecordingMembers(conv).length >= CONV_MEMBER_MAX) {
          showToast(`"${conv.name}" already has ${CONV_MEMBER_MAX} live panes.`);
          return false;
        }
        conv.members = (conv.members || []).concat(convMemberOf(pane));
      });
    }

    // A conversation is a roster and a name, so this ends the grouping and nothing else: every
    // member's transcript stays in the store, unreferenced, and takes its turn under the eviction
    // rules like any other. Said in the toast, because "delete" reads as "the words are gone".
    function deleteConversation() {
      const items = loadConvIndex(), conv = items.find(c => c.id === convViewId);
      if (!conv) return;
      saveConvIndex(items.filter(c => c.id !== conv.id));
      // The reading state goes with it, or a conversation created later on a recycled id would
      // inherit a stranger's folded-out members.
      const hidden = convHiddenAll();
      delete hidden[conv.id];
      try { localStorage.setItem(CONV_HIDDEN_KEY, JSON.stringify(hidden)); }
      catch (e) { /* private mode: this session only */ }
      const views = convViews();
      for (const key in views) if (views[key] === conv.id) delete views[key];
      try { localStorage.setItem(CONV_VIEW_KEY, JSON.stringify(views)); }
      catch (e) { /* private mode: this session only */ }
      convStandaloneHtml = '';
      renderConversations();
      if (document.body.classList.contains('conversation-open')) {
        closePanel();
      } else {
        // In a pane: fall back to another of its conversations, or to the rows if that was the
        // last one. The panel it was deleted from goes too — it acts on something that is gone.
        const a = activePane ? paneOf(activePane) : null;
        if (convPaneRoster) toggleConvPaneRoster();
        if (a) {
          const next = convsForPane(a)[0];
          convSetView(a, next ? next.id : '');
          renderConvBar();
        }
      }
      showToast(`Deleted "${conv.name}". What its panes said stays on this device, ` +
        'unreferenced, until space runs out.');
    }

    function convRemoveMember(key) {
      const conv = loadConvIndex().find(c => c.id === convViewId);
      const m = conv && (conv.members || []).find(x => x.key === key);
      if (!m) return;
      convEdit(c => { c.members = (c.members || []).filter(x => x.key !== key); });
      // The modal that used to ask said what leaving costs. The drain asks instead, and cannot
      // carry a sentence, so the sentence lands after — it is the part the user has to know, and
      // the tap it would have interrupted has already happened.
      showToast(`Removed "${m.label || 'this member'}" — its words leave the thread, ` +
        'and its transcript stops being kept.');
    }

    // The tab bar at the foot of the conversation view. Rebuilt only when what it says changed:
    // it is on the poll path, and rewriting it every three seconds would throw away the reader's
    // sideways scroll and the tab they were about to press.
    let convStripSig = '';

    // Returns how many tabs it is holding. The caller in the pane-tabs slot needs that: an empty
    // strip there hides itself and would leave the header with no tabs at all — see renderAgentTabs.
    function renderConvStrip() {
      const el = document.getElementById('convStrip');
      if (!el) return 0;
      const shown = convLandingList().shown;
      // The open conversation is always a tab, even when the reader has the auto ones hidden — a
      // strip that cannot show what is on screen is worse than one carrying an extra tab, which is
      // the rule the pane strip already follows for the open pane.
      const here = convCurrentId();
      const list = shown.some(c => c.id === here)
        ? shown : shown.concat(loadConvIndex().filter(c => c.id === here));
      const live = new Set(agents.map(x => convMemberKey(x)));
      const rows = list.map(c => {
        const on = (c.members || []).map(m => agents.find(a => live.has(m.key) && convMemberKey(a) === m.key))
          .filter(Boolean);
        const lead = on.find(a => a.status === 'blocked') || on.find(a => a.status === 'working')
          || on.find(a => attentionKind(a) === 'done') || on[0];
        return { c: c, dot: lead ? statusColor(lead) : 'var(--muted)',
          pulse: lead && lead.status === 'working' ? ' pulse' : '' };
      });
      const now = convCurrentId();
      const sig = rows.map(r => `${r.c.id}|${r.c.name}|${r.c.auto ? 'a' : '-'}|${r.dot}|${r.pulse}`)
        .join(' /// ') + ` @@ ${now}`;
      if (sig === convStripSig) return rows.length;
      convStripSig = sig;
      el.innerHTML = rows.map(r =>
        `<button class="conv-tab" data-conv-id="${escapeHtml(r.c.id)}"` +
        ` aria-current="${r.c.id === now ? 'true' : 'false'}"` +
        ` onclick="convTabPick(this.dataset.convId)">` +
        `<span class="pill"><span class="dot${r.pulse}" style="background:${r.dot}" aria-hidden="true"></span>` +
        `<span class="name">${escapeHtml(r.c.name)}</span>` +
        (r.c.auto ? '<span class="tier">auto</span>' : '') + '</span></button>').join('');
      const open = el.querySelector('[aria-current="true"]');
      if (open) open.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return rows.length;
    }

    // Which tab is the one you are looking at. Two views ask it: the standalone one is showing a
    // conversation outright, and a pane is showing whichever of its own it last read.
    function convCurrentId() {
      if (document.body.classList.contains('conversation-open')) return convViewId;
      const a = activePane ? paneOf(activePane) : null;
      const conv = a && convViewOn(a) ? convViewConv(a) : null;
      return conv ? conv.id : '';
    }

    // A tab is a conversation, and where it opens depends on whether the pane on screen is in it.
    // Switching the pane's own thread beats leaving the pane: the composer, the rows and the
    // ruler are all still there, and the reader asked for a different grouping, not a different
    // screen.
    function convTabPick(id) {
      const a = document.body.classList.contains('conversation-open') || !activePane
        ? null : paneOf(activePane);
      const conv = loadConvIndex().find(c => c.id === id);
      if (a && conv && (conv.members || []).some(m => m.key === convMemberKey(a))) {
        convSetView(a, id);
        renderConvBar();
        return;
      }
      openConversation(id);
    }

    // The whole record, every member, from the store alone. `bottom` scrolls to the newest on the
    // way in; a redraw from the snapshot leaves the reader where they were.
    async function renderConvStandalone(bottom) {
      const view = document.getElementById('convView');
      if (!view || view.style.display === 'none') return;
      const box = document.getElementById('convViewThread');
      const stick = bottom || view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
      const conv = loadConvIndex().find(c => c.id === convViewId);
      if (!conv) { closePanel(); return; }
      document.getElementById('convViewTitle').textContent = conv.name;
      // Written once per open rather than on every redraw: it never changes, and this runs on every
      // recorded read of every member.
      const mark = document.getElementById('convViewMark');
      if (mark && !mark.firstChild) mark.innerHTML = convGlyph();
      const members = conv.members || [], hidden = convHidden(conv.id);
      const shown = members.filter(m => !hidden.has(m.key));
      const open = document.getElementById('convViewOpen');
      open.hidden = !convVisibleLive(conv);
      const who = document.getElementById('convViewWho');
      who.textContent = (hidden.size ? `${shown.length}/${members.length}` : `${members.length}`) +
        ` pane${members.length === 1 ? '' : 's'} ▾`;
      who.setAttribute('aria-expanded', convRosterOpen ? 'true' : 'false');
      const token = ++convStandaloneToken;
      const keys = members.map(m => m.key);
      // No drafts: a draft belongs to a pane being watched, and this view watches none.
      const composed = await convCompose(conv, keys, []);
      if (token !== convStandaloneToken || convViewId !== conv.id) return;
      // Composed over every member and filtered after, never composed over the visible ones: the
      // member index is what picks a bubble's colour, so hiding the first member must not repaint
      // the second one in its tint.
      // A single-member thread is read straight off its one record and its entries carry no key —
      // there was never another member to tell them from. That member is keys[0].
      const visible = e => !hidden.has(e.key || keys[0]);
      const entries = hidden.size ? composed.entries.filter(visible) : composed.entries;
      const all = hidden.size ? composed.all.filter(visible) : composed.all;
      // The count goes in the header beside the name rather than in a conv-head above the thread:
      // the name is already up there, and printing it twice is the panel's only line of chrome
      // saying nothing.
      document.getElementById('convViewCount').textContent =
        `${entries.length} message${entries.length === 1 ? '' : 's'}`;
      // What kinds of agent are in this record, beside the count. Kinds and not names: who is in it
      // is the roster panel's question and it answers it with labels — this says whether the thread
      // is a claude on its own or a claude and a codex, which is the fact a reader wants before
      // opening anything. Read off the recorded spawn first, so a member that has exited still
      // counts; deduped, because two claudes are still "claude".
      const live = new Map(agents.map(x => [convMemberKey(x), x.agent]));
      const kinds = [];
      for (const m of members) {
        const rec = composed.recs.find(r => r.key === m.key);
        const kind = ((rec && rec.spawn) || {}).agent || live.get(m.key);
        if (kind && !kinds.includes(kind)) kinds.push(kind);
      }
      document.getElementById('convViewAgents').innerHTML = kinds.map(agentBadge).join('');
      convViewRecs = composed.recs;
      convViewEntries = entries;
      // The panel is its own element and diffed on its own: a message arriving must not rewrite the
      // roster under a reader who has just opened it.
      const panel = document.getElementById('convViewRoster');
      const rosterHtml = convRosterOpen ? convRosterHtml(conv, composed.recs, hidden) : '';
      if (rosterHtml !== convRosterHtmlLast) { convRosterHtmlLast = rosterHtml; panel.innerHTML = rosterHtml; }
      panel.hidden = !convRosterOpen;
      const html = (entries.length
        // Same fallback the visibility filter above uses: a single-member thread's entries carry no
        // key, and the dock reads a bubble's key to know who wrote it — an unkeyed bubble has no
        // source and so no target to exclude.
        ? convEntriesHtml(entries, {key: keys[0]}, false, 'toggleConvDockPick')
        : (all.length
          ? '<p class="conv-empty">Everything recorded here is still provisional. Turn "final ' +
            'messages only" off in the pane menu to see it.</p>'
          : hidden.size && composed.all.length
            ? '<p class="conv-empty">Every member is hidden. Open the panel above to bring one ' +
              'back.</p>'
            : '<p class="conv-empty">Nothing recorded here yet.</p>'));
      // The snapshot redraws this view every three seconds, and rewriting innerHTML would take the
      // reader's text selection with it mid-copy. Only a thread that actually changed is written.
      if (html !== convStandaloneHtml) { convStandaloneHtml = html; box.innerHTML = html; }
      // After the thread is on screen: the picks are painted onto its bubbles, and the dock's row
      // says who is live and what is picked.
      // What each member is doing right now, on that member's newest bubble — several at once in a
      // conversation of several, which is the whole point of reading them together.
      syncConvBadge('convViewThread');
      syncDockPicks(entries.length);
      renderConvDock();
      renderConvStrip();
      if (stick) view.scrollTop = view.scrollHeight;
    }

    // Title and terminal-only chrome for whatever is open. Called on open and again after every
    // full snapshot, so a shell that herdr hands an agent sheds its $ and its hidden controls
    // without needing the pane reopened.
    function syncOpenPaneChrome() {
      const pane = activePane ? paneOf(activePane) : null;
      const shell = !!activePane && isShell(activePane);
      document.getElementById('terminalView').classList.toggle('is-terminal', shell);
      // Named exactly like the card that opens it.
      const title = document.getElementById('termTitle');
      if (!pane) title.textContent = activePane || '';
      else title.innerHTML = paneChrome(pane);
      // Here as well as in renderStatusBar: a snapshot that only changes status arrives through
      // this path, and the recency bands cross on the timer that drives the other one.
      paintPaneDot();
      // The palette holds prompts over an agent and commands over a shell, and a pane can change
      // kind under a live snapshot — so the button is relabelled here, not only on open.
      syncPromptsBtn();
      syncComposerMode();
      // The mic button is hidden over a terminal, and a live recogniser with no way to stop it
      // would keep writing into the composer.
      if (shell && dictation) dictation.stop();
    }

    function openTerminal(paneId) {
      // Opening over an already-open pane leaves the old poller running otherwise, and every
      // switch adds another read_pane every 3s. Cleared here rather than in each caller, because
      // switchToPartner and the header chips both land straight on this without closing first.
      clearInterval(refreshInterval);
      activePane = paneId; paneLines = 200; userScrolledUp = false;
      paneSource = 'recent-unwrapped';  // a clear belongs to the pane it was made on
      noteRecent(paneId);
      noteVisit(paneId);
      syncOpenPaneChrome();
      document.getElementById('agentListView').style.display = 'none';
      hidePanels();
      document.body.classList.remove('conversation-open');
      document.body.classList.add('terminal-open');
      // After the class, never before: the strip is display:none outside a pane, and a hidden
      // element measures zero — the edge fades and the scroll-into-view would both no-op.
      renderAgentTabs();  // the tab for this pane has to read as active straight away
      // Looking at a pane is what clears its badge — see needsAttention — and that badge is on the
      // list, the chips, the strip and the browser tab, so clearing it is a full render. After the
      // strip has been laid out and not before: a render while it is still display:none would
      // claim the active tab without being able to centre it, and the call above would then have
      // nothing left to do.
      ackPane(paneId);
      render();
      // Seeded from lastSeen rather than blanked: that map is stamped for *every* pane on a status
      // transition, not only the open one, so a pane that blocked twenty minutes ago while you were
      // elsewhere can say so the moment it opens. Blank only for a pane this device has never seen
      // move. The first content read must not overwrite it — see paneTextPrimed.
      paneStampAt = lastSeen[paneId] ? new Date(lastSeen[paneId]) : null;
      paneTextPrimed = false;
      syncPaneLoading();   // after the flag, which is the thing it reads
      paneCols = null;     // and its column count is not this one's either
      paneText = ''; paneRows = [];  // nor are its lines, which a stale selection would re-anchor into
      clearSel();
      applyWrapMode();
      renderStatusBar();
      document.getElementById('terminalView').classList.add('active');
      document.getElementById('actionKeys').innerHTML = '';
      renderQuickActions();
      renderPairStrip();
      // The view this pane was last read in, restored with it — after activePane is set, which is
      // what it reads. At its end, whatever the thread being left was doing: the rows already land
      // there by way of `userScrolledUp`, and a thread that did not would be the only half of a
      // pane switch that remembered somewhere else.
      convStickNext = true;
      renderConvView();
      closeFireMenu();
      disarmClear();  // an arm belongs to the pane it was made on, not to the next one opened
      disarmQuit();
      disarmShortcut();
      disarmCtrl();
      refreshPane();
      // A pane whose record went stale while nobody was looking at it catches up now, on the one
      // event that makes the read worth paying for: someone is about to read it. Asynchronous and
      // deliberately after the ordinary 200-line read — that one is what puts the pane on screen.
      convRecoverPane(paneId);
      refreshInterval = setInterval(() => refreshPane(true), 3000);
    }

    function closeTerminal() {
      activePane = null; clearInterval(refreshInterval);
      syncPaneLoading();  // after activePane, so a pane closed mid-wait takes the pill with it
      closeFireMenu();
      disarmClear();
      disarmQuit();
      disarmShortcut();
      disarmCtrl();
      renderQuickActions();  // reads activePane, so it empties the bar now that there is none
      renderConvView();      // and takes the thread with it, for the same reason
      clearSel();  // after activePane, so rulerOn() is already false and the ruler goes with it
      document.getElementById('pairStrip').style.display = 'none';
      renderRecents();  // the pane just visited belongs at the front before the next poll, not after
      renderAgentTabs();
      document.getElementById('terminalView').classList.remove('active');
      // Cleared on the way out, not only on the way into an agent: the next thing opened may be
      // the Settings view, and a stale is-terminal would leave its hiding rules armed.
      document.getElementById('terminalView').classList.remove('is-terminal');
      closeTermMenu();
      document.body.classList.remove('terminal-open');
      document.getElementById('agentListView').style.display = '';
      paneStampAt = null;
      renderStatusBar();
    }
