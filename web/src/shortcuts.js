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
      // The same question — is this pane a shell — decides whether the history floats over it, and
      // this is the one path every snapshot and every pane switch already goes through.
      renderTermHistory();
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
      if (!submitText(activePane, s.text)) return;
      if (window.cue) cue('success');
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

    // --- The terminal's own history, floating over the pane ---
    //
    // A disclosure in the pane's floating row, not the $ palette, because the two answer
    // different questions. The palette is a decision — which of my saved commands do I want — and
    // it covers the screen to ask it. This is a glance at what was just run, and covering the
    // terminal to see what was typed into it defeats the reason for looking.
    //
    // Open or shut is remembered globally rather than per pane: it is a preference about how much
    // of the terminal the reader wants covered, and it does not change because they switched
    // panes. Same store as the list, so one write keeps both.
    let termHistory = [], termHistoryOpen = false;

    function loadTermHistory() {
      const raw = localStorage.getItem(TERM_HIST_KEY);
      termHistory = parseTermHistory(raw);
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { /* corrupt: shut, same as a first run */ }
      termHistoryOpen = !!(data && data.open);
    }

    function saveTermHistory() {
      try {
        localStorage.setItem(TERM_HIST_KEY, JSON.stringify(
          { version: TERM_HIST_VERSION, items: termHistory, open: termHistoryOpen }));
      } catch (e) { /* private mode: session-only */ }
    }

    // Called once the wire has taken the text, for the same reason noteSent is: a history that
    // records a send the socket dropped is a list of commands that never ran.
    function noteTermCommand(text) {
      const next = pushTermHistory(termHistory, text);
      if (next.length === termHistory.length && next.every((t, i) => t === termHistory[i])) return;
      termHistory = next;
      saveTermHistory();
      renderTermHistory();
    }

    function toggleTermHistory() {
      termHistoryOpen = !termHistoryOpen;
      saveTermHistory();
      renderTermHistory();
    }

    function deleteTermCommand(i) {
      if (i < 0 || i >= termHistory.length) return;
      termHistory.splice(i, 1);
      saveTermHistory();
      renderTermHistory();
    }

    // Runs it, the same as picking from the $ palette: this is a list of commands that already
    // ran at this prompt, and the reader who opened it opened it to run one again.
    //
    // The composer is filled as well, and that is not a fallback — it is what makes the run
    // reviewable. What was sent stays visible in the field afterwards, so a command that turned
    // out to be the wrong one is edited and sent again rather than retyped.
    //
    // Filled but never focused. On a phone a focus summons the keyboard over the terminal the
    // reader is watching the command run in, which is the one thing they wanted to see. Same
    // reason the command palette stopped autofocusing its search on touch.
    function useTermCommand(i) {
      const text = termHistory[i];
      if (!text || !ws || !activePane) return;
      const input = document.getElementById('termInput');
      if (input) { input.value = text; autoGrow(input); }
      if (!submitText(activePane, text)) return;
      // Straight to the end of the list rather than staying where it was, for the same reason a
      // typed repeat does: the list is ordered by when a command was last useful.
      noteTermCommand(text);
      if (window.cue) cue('success');
      burstPoll();
    }

    function renderTermHistory() {
      const wrap = document.getElementById('paneHistWrap');
      if (!wrap) return;
      // Terminals only, and over every one of them — including a browser that has not typed
      // anything yet. Waiting for a first command hid the control from the reader most likely to
      // be looking for it: history is this browser's own, so a second device starts empty and had
      // no way to learn the button existed. Over an agent it stays hidden, where it would be a
      // list of shell commands that pane cannot run.
      const offered = !!activePane && isShell(activePane);
      wrap.hidden = !offered;
      if (!offered) return;
      const btn = document.getElementById('paneHistBtn');
      wrap.classList.toggle('open', termHistoryOpen);
      btn.setAttribute('aria-expanded', String(termHistoryOpen));
      btn.title = termHistoryOpen ? 'Hide recent commands' : `Recent commands (${termHistory.length})`;
      btn.setAttribute('aria-label', `Recent commands (${termHistory.length})`);
      const list = document.getElementById('paneHistList');
      list.hidden = !termHistoryOpen;
      if (!termHistoryOpen) { list.innerHTML = ''; return; }
      if (!termHistory.length) {
        list.innerHTML = '<div class="hist-empty">Commands you run here appear here.</div>';
        return;
      }
      list.innerHTML = termHistory.map((t, i) => `
        <div class="hist-item">
          <button class="hist-run" onclick="useTermCommand(${i})"
            title="${escapeHtml(t)}">${escapeHtml(t)}</button>
          <button class="hist-x" onclick="deleteTermCommand(${i})"
            aria-label="Forget this command">&times;</button>
        </div>`).join('');
      // Newest is at the bottom, so a list long enough to scroll opens on the end of itself: the
      // command most likely to be wanted again is the one just run, and a scrollTop of 0 would
      // open on the oldest thing in it.
      list.scrollTop = list.scrollHeight;
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
    // `kind` is 'error' unless something says otherwise. A notice that nothing went wrong — a
    // message queued behind a working pane, and the pane later taking it — must not wear the red
    // border or make the sound that means a refusal, or the two stop being distinguishable.
    function showToast(text, kind) {
      const el = document.getElementById('toast');
      el.textContent = text;
      // Three kinds, and the default is the loud one: a toast with no kind is something that went
      // wrong, which is what most of them are. `ok` is the other end — a send that landed — and it
      // is a colour rather than only a ✓ because the tick is 8px of a line read at arm's length.
      el.style.borderColor = kind === 'ok' ? 'var(--green)'
        : kind === 'info' ? 'var(--border)' : 'var(--red)';
      el.style.display = 'block';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { el.style.display = 'none'; }, 5000);
      if (window.cue && kind !== 'info' && kind !== 'ok') cue('error');
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
    <div class="info"><div class="project">${paneChrome(a, false)}${host}</div><div class="meta">${paneBadge(a).trimStart()} ${cwd}</div></div>
    ${endBtnHtml({cls: 'end-btn', key: 'end-pane:' + a.pane_id, pane: a.pane_id, stop: true,
                  aria: 'End ' + label, fire: `endPane('${a.pane_id}')`})}
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
      if (!header) return;
      const filter = agentKindsHtml(agents);
      if (filter) header.insertAdjacentHTML('beforeend', filter);
      header.insertAdjacentHTML('beforeend',
        '<button class="section-action" onclick="openOrder()" aria-label="Reorder tabs">Reorder</button>');
      // Reorder, then +. The same right-hand order the Launcher header uses: + is always last,
      // because it is the one that makes something rather than rearranging what is there.
      // Starting a session is what this section is a list of, so this is where it belongs — and
      // with no Project selected the sheet asks for one rather than guessing.
      if (startOptions) {
        header.insertAdjacentHTML('beforeend',
          sectionNewHtml('openStartDialog(activeProject, event)',
            'Start a session — it asks which Project', 'Start a new session'));
      }
    }

    function terminalCard(s) {
      const host = s.host && s.host !== 'local' ? ` <span style="color:var(--orange);font-size:0.6rem">@${s.host}</span>` : '';
      const cwd = s.cwd ? `<span style="font-family:monospace;opacity:0.7">${s.cwd.split('/').slice(-2).join('/')}</span>` : '';

      // No status dot and no Pair button, and both absences are the point: a shell has no status,
      // and a pair is agent-to-agent.
      return `<div class="agent" role="button" tabindex="0" aria-label="Terminal ${escapeHtml(paneLabel(s))}" onclick="openTerminal('${s.pane_id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openTerminal('${s.pane_id}')}">
    <span class="term-glyph" aria-hidden="true">$</span>
    <div class="info"><div class="project">${paneChrome(s)}${host}</div><div class="meta">${cwd}</div></div>
    ${endBtnHtml({cls: 'end-btn', key: 'end-pane:' + s.pane_id, pane: s.pane_id, stop: true,
                  aria: 'End ' + paneLabel(s), fire: `endPane('${s.pane_id}')`})}
    <span style="color:var(--muted);font-size:1.2rem" aria-hidden="true">›</span>
  </div>`;
    }

    // Not section(): that maps agentCard over its list. Same header markup, different card, and a
    // colour that is none of the three carrying agent status.
    // The + on a section header, in the one spelling Conversations already uses. Drawn only where
    // the relay will actually take it: opening a shell needs both of open_terminal's gates, and
    // `terminal` in start_options is how the relay reports the pair of them as one answer.
    function sectionNewHtml(call, title, label) {
      return `<button class="section-action" onclick="${call}"` +
        ` title="${escapeHtml(title)}" aria-label="${escapeHtml(label)}">+ New</button>`;
    }

    function terminalsHtml() {
      const list = activeProject ? shells.filter(s => s.project_id === activeProject) : shells;
      // The + is drawn whether or not there is anything under it, the same exception Conversations
      // and the Launcher make: an entry point that only appears once you already have a terminal
      // cannot be how the first one is opened. A relay with terminal mode off still shows nothing,
      // because applySections takes a section outside the order off screen regardless.
      const plus = startOptions && startOptions.terminal
        ? sectionNewHtml(`openStartDialog(activeProject, event, 'terminal')`,
            'Open a terminal — it asks which Project', 'Open a new terminal') : '';
      if (!list.length && !plus) return '';
      return `<div class="section-header">Terminals${plus}</div>`
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
      const archived = all.filter(c => c.archived);
      const active = all.filter(c => !c.archived);
      const autos = active.filter(c => c.auto);
      return { all: all, archived: archived, autos: autos,
        shown: active.filter(c => !c.auto)
          .concat(convLandingAutoOn() ? autos.slice(0, CONV_LANDING_AUTO_MAX) : []).sort(by) };
    }

    function setConversationArchived(id, archived) {
      const items = loadConvIndex().map(c => {
        if (c.id !== id) return c;
        const next = Object.assign({}, c);
        if (archived) next.archived = true; else delete next.archived;
        return next;
      });
      saveConvIndex(items);
      renderConversations();
    }

    function archiveConversation(id) { setConversationArchived(id, true); }
    function unarchiveConversation(id) { setConversationArchived(id, false); }

    // One End button, wherever it is drawn — four cards and two rows, all of them redrawn by the
    // poll under whoever is aiming at them. Four states in one place:
    //
    //   resting    the word, and a first tap that arms it
    //   armed      the question, with the drain, and a second tap that fires
    //   in flight  Ending…, greyed and taking no taps — the send is out and nothing else to say
    //   back       the word again, because the send was given up on. See endWatch.
    //
    // `key` is what carries the arm and the flight across a redraw: the element changes between
    // the two taps, its action does not.
    function endBtnHtml(o) {
      const key = o.key;
      // Any of them: a conversation is drawn Ending… while one member is still on its way out,
      // because the conversation is the thing being ended and the rest is not a second question.
      const pending = typeof endPending === 'function'
        && (o.panes || [o.pane]).filter(Boolean).some(endPending);
      const armed = typeof armButtonArmed === 'function' && armButtonArmed(key);
      const rest = o.rest || 'End';
      const ask = o.ask || 'End?';
      if (pending) {
        return `<button class="${o.cls} end-going" disabled` +
          ` data-arm-key="${escapeHtml(key)}"` +
          ` aria-label="${escapeHtml(o.aria)} — ending">Ending…</button>`;
      }
      return `<button class="${o.cls} arm-btn" data-arm-key="${escapeHtml(key)}"` +
        (armed ? ` data-armed="1" data-arm-label="${escapeHtml(rest)}"` : '') +
        (o.data || '') +
        ` aria-label="${escapeHtml(o.aria)}"` +
        ` onclick="${o.stop ? 'event.stopPropagation();' : ''}armButton(this, '${ask}', ` +
        `() => ${o.fire}, this.dataset.armKey)">${escapeHtml(armed ? ask : rest)}</button>`;
    }

    function renderConversations() {
      const el = document.getElementById('conversations');
      if (!el) return;
      const now = Date.now();
      const list = convLandingList();
      // Both lists, because the archive is drawn from the same rows: building only the shown ones
      // left `archivedRows` matching nothing, so the Archive button counted cards it could never
      // draw and an archived conversation could not be got back at.
      const rows = list.shown.concat(list.archived).map(c => {
        const members = c.members || [];
        const count = members.reduce((n, m) => n + (Number(m.messages) || 0), 0);
        const seen = Math.max(0, ...members.map(m => Number(m.seen) || 0));
        const live = members.map(m => agents.find(a => convMemberKey(a) === m.key)).filter(Boolean);
        const names = members.map(m => escapeHtml(m.label || (agents.find(a => convMemberKey(a) === m.key) || {}).label || 'Former pane'));
        // What each member is and where it is working, in the order of how much each source knows.
        // The member record, written when it joined; then the live pane, which is right for a
        // member that has come back under a new name; then the key itself, which carries the
        // harness and the directory of every member ever recorded, including the ones that predate
        // the fields above. The directory's last segment is a guess at the Project and is the last
        // resort for exactly that reason — a member filed before this existed still shows where it
        // was working, and one filed since shows what the relay calls it.
        const badgeValues = members.map(m => {
          const pane = agents.find(a => convMemberKey(a) === m.key) || {};
          let key = [];
          try { key = JSON.parse(m.key || '[]'); } catch (e) { /* a member key from before this */ }
          const cwd = key[3] || '';
          return { agent: m.agent || pane.agent || key[2] || '',
            project: m.project || pane.project || cwd.split('/').filter(Boolean).pop() || '' };
        });
        // Unique, because a conversation of four claudes in one Project is one badge and one
        // Project — the card says what is in it, not how many.
        const unique = (field) => Array.from(new Set(badgeValues.map(x => x[field]).filter(Boolean)));
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
          // A conversation with live panes keeps the filled dot its lead pane's status paints —
          // grey included, because an idle agent is still an agent. With none, there is no status
          // to paint and the dot is drawn hollow: ended is not a state, it is the absence of one.
          ended: live.length ? '' : ' ended',
          // Carried out of the row builder: the card's End is drawn below, where `live` is not.
          livePanes: live.map(a => a.pane_id),
          badges: unique('agent').map(a => agentBadge(a)).join('') +
            unique('project').map(p => ` <span class="badge proj">@${escapeHtml(p)}</span>`).join(''),
        };
      });
      const autos = list.autos, showAuto = convLandingAutoOn();
      const autoControl = autos.length
        ? `<button class="section-action conv-auto-toggle" onclick="toggleConvLandingAuto()" aria-pressed="${showAuto}" ` +
          `title="Shows up to ${CONV_LANDING_AUTO_MAX} latest automatic conversations">` +
          `${showAuto ? 'Hide auto' : 'Show auto'} (${autos.length})</button>` : '';
      const archiveControl = list.archived.length
        ? `<button class="section-action" onclick="toggleConvLandingArchive()" aria-pressed="${convLandingArchiveOn()}">` +
          `${convLandingArchiveOn() ? 'Hide archive' : 'Archive'} (${list.archived.length})</button>` : '';
      // The + is drawn whether or not there is anything under it, which is the one place this
      // section differs from the others: an entry point that only appears once you already have a
      // conversation cannot be how the first one is made.
      const newControl = `<button class="section-action conv-new" onclick="newConversation()"` +
        ` title="Start an empty conversation and add panes to it"` +
        ` aria-label="Start a new conversation">+ New</button>`;
      const card = (r, archived) =>
        `<div class="conversation-card" role="button" tabindex="0" data-conv-id="${escapeHtml(r.c.id)}"` +
        ` onclick="openConversation(this.dataset.convId)"` +
        ` onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openConversation(this.dataset.convId); }">` +
        // Dot, mark, name — the dot is the row's live state and reads first on every card in the
        // list; the mark says what kind of thing the name belongs to. The dot alone was doing both
        // jobs, which is why a conversation card and an agent card opened the same way but did not
        // read as different things.
        `<div class="conversation-title"><span class="dot${r.pulse}${r.ended}" style="background:${r.dot}"` +
        ` aria-hidden="true"></span><span class="conv-kind">${convGlyph()}</span>` +
        `<span class="name">${escapeHtml(r.c.name)}</span>` +
        // Nothing running, said in words beside the hollow dot. The dot is the glance; this is
        // for the reader who has not learned yet that a hollow one means the panes are gone.
        `${r.liveNames.length ? '' : '<span class="conversation-tier idle" title="Nothing in '
          + 'this conversation is running. Open it to start a member again.">inactive</span>'}` +
        // The tier, on the card rather than in the name: promotion is a rename the user makes,
        // not a marker the app writes into what they typed (D4).
        `${r.c.auto ? '<span class="conversation-tier" title="Filed automatically, and dropped ' +
          'first when space runs out. Open it and rename it to keep it for good.">auto</span>' : ''}` +
        `<span class="conversation-count">${r.count} ` +
        `${r.count === 1 ? 'message' : 'messages'}</span>` +
        // Archiving is the reader saying "not now" about a conversation they mean to keep — the
        // one thing the auto tier cannot express, since that is about how a conversation was made
        // rather than whether anyone wants to look at it. Recorded on the conversation and not in
        // this browser, so a card put away on a phone is away on the desktop too.
        `<button class="archive-btn" data-conv-id="${escapeHtml(r.c.id)}"` +
        ` onclick="event.stopPropagation(); ${archived ? 'unarchiveConversation' : 'archiveConversation'}(this.dataset.convId)"` +
        ` aria-label="${archived ? 'Unarchive' : 'Archive'} ${escapeHtml(r.c.name)}">` +
        `${archived ? 'Unarchive' : 'Archive'}</button>` +
        // The same control the roster panel calls End all, on the card, for the same reason the
        // agent cards carry one: the list is where a session is recognised as finished, and going
        // into a conversation to close it is a trip taken only to press one button. Drawn only
        // where there is something running — an ended conversation is already where this leads.
        (r.liveNames.length
          // Ending… as soon as any member of it has a send in flight: the conversation is the
          // thing being ended, and one pane still on its way out is not a second question.
          ? endBtnHtml({cls: 'end-btn', key: 'end-conversation:' + r.c.id, ask: 'End all?',
              panes: r.livePanes,
              stop: true, data: ` data-conv-id="${escapeHtml(r.c.id)}"`,
              aria: `End every session in ${r.c.name}, keeping the transcripts`,
              fire: 'endConversation(this.dataset.convId)'})
          : '') +
        `</div>` +
        // What is in it, before what was said in it: which harnesses, and which Projects they are
        // working in. A conversation is recognised by its members long before its newest line is
        // read, and on a phone that line is the only other thing on the card.
        (r.badges ? `<div class="conversation-meta">${r.badges}</div>` : '') +
        (r.last ? `<div class="conversation-last">${escapeHtml(r.last)}</div>` : '') +
        `<div class="conversation-meta">${r.names.join(' · ')}</div>` +
        `<div class="conversation-meta">${r.liveNames.length ? 'Live: ' + r.liveNames.join(', ') : 'No live members'}` +
        `${r.seen ? ' · Last activity ' + fmtAgo(new Date(Math.min(r.seen, now))) : ''}</div></div>`;
      const archivedRows = list.archived.map(c => rows.find(r => r.c.id === c.id)).filter(Boolean);
      const activeRows = list.shown.map(c => rows.find(r => r.c.id === c.id)).filter(Boolean);
      el.innerHTML = `<div class="section-header">Conversations${autoControl}${archiveControl}${newControl}</div>` +
        (activeRows.length ? activeRows.map(r => card(r, false)).join('')
        : '<p class="pair-empty">No conversations yet. Start one here, or record a pane into one '
          + 'from its own menu.</p>') +
        (convLandingArchiveOn() && archivedRows.length
          ? `<div class="section-header">Archived conversations</div>${archivedRows.map(r => card(r, true)).join('')}` : '');
      applySections();
    }

    // An empty conversation, opened on its roster with the picker already down: the thing the
    // reader came to do is add the first pane, and a view of nothing with a panel closed over the
    // one control that matters is a dead end. Named rather than asked for — a name is a rename
    // away, and a dialog between the tap and the picker is the dialog this button exists to skip.
    async function newConversation() {
      const items = loadConvIndex();
      if (items.length >= CONV_CONV_MAX) {
        showToast(`Already at ${CONV_CONV_MAX} conversations — leave one first.`);
        return;
      }
      const conv = {
        // Not crypto.randomUUID(), for the reason newPairId() gives: no secure context on a LAN.
        id: 'c_' + Math.random().toString(36).slice(2, 10),
        name: newConvName(items), created: Date.now(), members: [],
      };
      saveConvIndex([conv].concat(items));
      renderConversations();
      openConversation(conv.id);
      convRosterOpen = true;
      await convToggleAdd();   // straight to the picker: an empty conversation has one thing to do
    }

    // "New conversation", then the first number that is free. Numbered and not stamped: two of
    // these are told apart by which was made first, and a date is a worse answer to that than a 2.
    function newConvName(items) {
      const taken = new Set(items.map(c => c.name));
      const base = 'New conversation';
      if (!taken.has(base)) return base;
      for (let n = 2; n < 100; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
      return base;
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

    let convStandaloneToken = 0, convStandaloneHtml = '';
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
      if (typeof stateSyncMark === 'function') stateSyncMark('conv_hidden');
      convStandaloneHtml = '';
      renderConvManage();
    }

    // Reading one member of a conversation and nothing else. Not a mode with storage of its own:
    // it is the hide list with everyone but one in it, which is what it would have had to write
    // anyway — and it means the roster panel, the composer's target row and the thread all already
    // agree about it, because all three read the hide list. A conversation of one has no solo to
    // be in, so it never reports one.
    function convSoloKey(id) {
      const conv = loadConvIndex().find(c => c.id === id);
      const members = (conv && conv.members) || [];
      if (members.length < 2) return '';
      const hidden = convHidden(id);
      const shown = members.filter(m => !hidden.has(m.key));
      return shown.length === 1 ? shown[0].key : '';
    }

    function convSetSolo(id, key) {
      const conv = loadConvIndex().find(c => c.id === id);
      const members = (conv && conv.members) || [];
      // A key nobody here holds is not a solo, it is every member hidden — `rest` would be the
      // whole roster, and the view would come up saying "Every member is hidden" with nothing
      // named to bring back. The composer can be addressing a pane outside this conversation, so
      // this is reachable by pressing the solo switch at the wrong moment. Guarded here rather
      // than at the switch because this is what every caller routes through.
      const solo = members.some(m => m.key === key) ? key : '';
      const rest = members.filter(m => m.key !== solo).map(m => m.key);
      const all = convHiddenAll();
      // Off is the empty list and not a shorter one: leaving whatever was hidden before solo began
      // would make the X put the reader somewhere they never chose.
      if (solo && rest.length) all[id] = rest; else delete all[id];
      try { localStorage.setItem(CONV_HIDDEN_KEY, JSON.stringify(all)); }
      catch (e) { /* private mode: this session only */ }
      if (typeof stateSyncMark === 'function') stateSyncMark('conv_hidden');
      convStandaloneHtml = '';
      renderConvManage();
    }

    // The composer's switch and the banner's X are the same one: on, it solos whoever the composer
    // is addressing, because that is the member the reader has already named.
    function toggleConvSolo() {
      if (convSoloKey(convViewId)) { convSetSolo(convViewId, ''); return; }
      const live = agents.find(a => a.pane_id === dockAddressed());
      const conv = loadConvIndex().find(c => c.id === convViewId);
      const members = (conv || {}).members || [];
      // The addressed pane only when it is one of these members — the composer is free to be
      // pointed at a pane this conversation has never heard of, and soloing that is soloing
      // nobody. First member then, which is what an unaddressed composer already gets.
      const addressed = live ? convMemberKey(live) : '';
      const key = members.some(m => m.key === addressed)
        ? addressed : ((members[0] || {}).key || '');
      convSetSolo(convViewId, key);
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
      // The live pane behind each member, not merely whether there is one: a conversation assembled
      // out of panes this browser did not start has no spawn to read the harness off, and the pane
      // itself is still saying what it runs.
      const live = new Map(agents.map(x => [convMemberKey(x), x]));
      const off = hidden || new Set();
      const rows = (conv.members || []).map(m => {
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
          `<span class="who">${escapeHtml(rec.label || m.label || 'Former pane')}</span>` +
          kindBadge((rec.spawn || {}).agent || (live.get(m.key) || {}).agent || '',
                    live.get(m.key), (rec.spawn || {}).config) +
          `<span class="tag">${out ? 'hidden' : (on ? 'recording' : 'no longer live')}</span>` +
          // End first, then Remove, and only then the way in. The two that take something away sit
          // together; Open is not one of them. End is offered only where there is something running
          // to end — an ended row carries Start again in the same place, which is the other half of
          // the same control: this row is where a member is sent away and brought back.
          (on ? endBtnHtml({cls: 'conv-end', key: 'end-member:' + m.key,
            pane: (live.get(m.key) || {}).pane_id, data: ` data-key="${escapeHtml(m.key)}"`,
            aria: "End this member's session",
            fire: 'endConvMember(this.dataset.key)'}) : '') +
          `<button class="conv-drop arm-btn" data-key="${escapeHtml(m.key)}"` +
          ` onclick="armButton(this, 'Remove?', () => convRemoveMember(this.dataset.key))"` +
          ` aria-label="Remove this member from the conversation">Remove</button>` +
          // Every live member, not only whichever one the header's button would pick: the header
          // opens the first, and a conversation of four is exactly where that is the wrong one.
          (on ? `<button class="conv-open" data-key="${escapeHtml(m.key)}"` +
            ` onclick="openConvMemberPane(this.dataset.key)"` +
            ` aria-label="Open this member's pane">Open</button>` : '') +
          // Swapping the agent is a start whose destination happens to be a member that already
          // exists, so it asks the Start dialog like every other start does — one place harnesses,
          // roles and agent configs are listed, rather than a second smaller picker that would
          // drift out of step with it. Offered on both halves of a row's life: an ended member is
          // picked up by whatever is started next, and a live one is ended first, because a pane
          // runs one CLI and there is no changing it underneath.
          (canStartFromConv()
            ? (on
              ? `<button class="conv-swap arm-btn" data-key="${escapeHtml(m.key)}"` +
                ` onclick="armButton(this, 'End and swap?', () => convSwapLive(this.dataset.key))"` +
                ` aria-label="End this member and start a different agent in its place">Swap</button>`
              : `<button class="conv-swap" data-key="${escapeHtml(m.key)}"` +
                ` onclick="convSwapMember(this.dataset.key)"` +
                ` aria-label="Start a different agent as this member">Start as\u2026</button>`)
            : '') +
          (!on && canRespawn(rec.spawn) ? `<button class="conv-again arm-btn" data-key="${escapeHtml(m.key)}"` +
            ` onclick="convArmRespawn(this, this.dataset.key)"` +
            ` aria-label="Start a new session and continue this conversation">Start again</button>` : '') +
          `</div>`;
      }).join('');
      // The tier, said where the button that changes it is. "How do I make this one mine" is the
      // question an auto record raises, and the answer is one word on the button below it.
      const tier = conv.auto
        ? '<p class="conv-tier-note">Filed automatically, and dropped first when space runs out. ' +
          'Rename it to keep it for good.</p>' : '';
      return `<div class="conv-roster">${rows}<div class="conv-roster-actions">` +
        // Destructive action first, followed by the two ways to preserve the grouping, then edits.
        `<button class="conv-del arm-btn" onclick="armButton(this, 'Delete?', deleteConversation)"` +
        ` aria-label="Delete this conversation, keeping the transcripts">Delete</button>` +
        // Beside Delete because both end something, and apart from it in colour because they end
        // very different things: Delete destroys the record, End stops the sessions and leaves it.
        endBtnHtml({cls: 'conv-end', key: 'end-conversation:' + conv.id, ask: 'End all?',
          rest: 'End all',
          panes: Array.from(live.values()).map(a => a.pane_id),
          aria: 'End every session in this conversation, keeping the transcripts',
          fire: 'endConversation(convViewId)'}) +
        `<button id="convCopyBtn" onclick="convCopy()">Copy</button>` +
        `<button class="arm-btn" onclick="armButton(this, 'Duplicate?', duplicateConversation)"` +
        ` aria-label="Copy this conversation so panes can be added without changing this one">` +
        `Duplicate</button>` +
        `<button onclick="renameConversation()">Rename</button>` +
        `<button onclick="convToggleAdd()">Add pane</button>` +
        // Starting one is offered next to adding one, not only inside the picker: from a pane's
        // roster the picker is two taps away, and "there is nobody to add yet" is exactly the
        // moment the answer is a new agent.
        (canStartFromConv()
          ? `<button onclick="openNewAgent()" aria-label="Start a new agent in this conversation">` +
            `New agent</button>` : '') +
        `</div>${tier}</div>`;
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

    // A restart replaces the member it was asked for rather than joining beside it: same name,
    // same row, and the dead session's transcript copied under the new pane's key so the thread
    // reads on across the seam. D3 said a respawn is always a new member — that rule was about a
    // *recycled pane id* silently inheriting a dead session's words, which this is not: the reader
    // picked the member and asked for it. Where the two do meet — a replacement landing on a key
    // some other conversation still records under — convContinueTranscript refuses the copy and
    // this falls back to D3's new member.
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
      // Named by what it will actually come up as. A session started under `oclaude1` restarted as
      // "a new claude session" would be true about the harness and wrong about the endpoint.
      const row = spawn.config && typeof agentConfigRow === 'function'
        ? agentConfigRow(spawn.config) : null;
      const what = (row && row.label) || spawn.agent;
      if (spawn.config && !row) {
        return `Agent config "${spawn.config}" is gone. Tap again to pick what to start instead.`;
      }
      return `Tap again to start a new ${what} session in ${project.label || 'this Project'}.${moved}`;
    }

    function convArmRespawn(btn, key) {
      // Said on the arm, not on the fire: by the second tap the session is already starting.
      if (armedEl !== btn) { const note = respawnNote(key); if (note) showToast(note); }
      armButton(btn, 'Start again?', () => convRespawn(key));
    }

    // A member is named by its fingerprint and not by a pane — the roster outlives the panes in it,
    // which is the whole reason the key has no pane id doing the identifying.
    function endConvMember(key) {
      const live = agents.concat(shells).find(x => convMemberKey(x) === key);
      if (live) endPane(live.pane_id);
    }

    // Start something else into an existing member's slot. The dialog is opened on that member's
    // Project and handed the replace intent, so whatever lands continues this member rather than
    // joining beside it: same row, same name, the transcript carried across the seam and the pair
    // repointed — the machinery a restart already uses, with the harness left open to be chosen.
    //
    // Nothing is sent here. This ends at a dialog on purpose: the one thing a swap must not do is
    // decide for the reader what the replacement is.
    function convSwapMember(key, opts) {
      const o = opts || {};
      const conv = loadConvIndex().find(c => c.id === convViewId);
      if (!conv || !startOptions) return false;
      const rec = (convViewRecs || []).find(r => r.key === key) || {};
      const spawn = rec.spawn || {};
      const live = agents.find(x => convMemberKey(x) === key);
      // The live pane's Project first: a record's is what it was started under, and a member that
      // has been swapped once already may have moved since.
      openStartDialog((live && live.project_id) || spawn.project_id || '');
      // After the open, which clears it — the same order reorder.js starts a pair with.
      startIntent = { conv: conv.id, replace: key };
      if (o.kind) {
        startAgentPick = o.kind;
        startCustomOpen = true;
        renderStartAgents();
      }
      // The name it is known by in the thread, so the replacement comes up as the colleague it
      // continues rather than as "Architect 2". Only where the relay will take it.
      const name = String(rec.label || spawn.label || '').trim();
      const field = document.getElementById('startName');
      if (field && name && name.length <= 32) field.value = name;
      if (o.note) showToast(o.note);
      return true;
    }

    // The same thing for a member still running. A pane runs one CLI, so there is no changing the
    // agent in it — the session is ended and the dialog opened over the space it leaves. Asked
    // twice by the button that calls this, because ending a live agent loses whatever it had not
    // said yet.
    function convSwapLive(key) {
      const live = agents.find(x => convMemberKey(x) === key);
      if (live) endPane(live.pane_id);
      return convSwapMember(key, live
        ? { note: 'Session ended. Pick what to start in its place.' } : null);
    }

    // A restart names itself, so the pane it makes can be found again by equality rather than by
    // resemblance. The relay stamps this on the pane and carries it on every snapshot; the note
    // here is what survives the reload that threw away the relay's answer.
    //
    // sessionStorage, not localStorage: this is one tab coming back, and a second tab must not act
    // on a start it never made. Two minutes, because a start that has not produced a pane by then
    // failed, and the pane running an hour later is somebody else's.
    //
    // ponytail: only the respawn path names itself. A swap begun from the Start dialog loses its
    // binding to a reload the same way — same treatment, when someone hits it.
    const CONV_RESPAWN_KEY = 'herdr_conv_respawn';
    const CONV_RESPAWN_MS = 120000;
    let convRespawnResuming = '';

    function convRespawnRef() {
      return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    function rememberConvRespawn(conv, key, ref) {
      try {
        sessionStorage.setItem(CONV_RESPAWN_KEY,
                               JSON.stringify({conv: conv, key: key, ref: ref, at: Date.now()}));
      } catch (e) { /* private mode: this tab only, which is all this was for */ }
    }

    function heldConvRespawn() {
      let held = null;
      try { held = JSON.parse(sessionStorage.getItem(CONV_RESPAWN_KEY) || 'null'); }
      catch (e) { return null; }
      if (!held || !held.ref) return null;
      if (Date.now() - (held.at || 0) > CONV_RESPAWN_MS) { forgetConvRespawn(); return null; }
      return held;
    }

    function forgetConvRespawn() {
      try { sessionStorage.removeItem(CONV_RESPAWN_KEY); } catch (e) { /* nothing to forget */ }
    }

    // The pane a start in flight will land on, so nothing else claims it first. The recorder files
    // every unreferenced pane into an auto conversation on the next snapshot, and a pane filed
    // there is a pane some conversation already names — which is exactly what stops the succession
    // below continuing the thread onto it.
    function convStartClaimed(a) {
      if (!a) return false;
      if (typeof pendingStart !== 'undefined' && pendingStart && a.pane_id === pendingStart) return true;
      const held = heldConvRespawn();
      return !!(held && a.ref && a.ref === held.ref);
    }

    // The pane this restart made, once herdr has it. Equality on the id the client itself chose —
    // no name, no directory, nothing two colleagues in one checkout could share.
    function convRespawnPane(ref) {
      return (ref && agents.find(a => a.ref === ref)) || null;
    }

    // Continue the conversation onto a pane that is already running: the same succession Start
    // again performs when the relay's answer arrives, run from a note on disk instead.
    function convAdoptRespawn(conv, key, pane, starter) {
      startIntent = { conv: conv.id, replace: key };
      // No opening prompt. It would reach an agent that has been working for however long the
      // reload took, as an instruction nobody typed just now.
      startPrompt = '';
      startStarter = starter || '';
      pendingStart = pane.pane_id;
      forgetConvRespawn();
      openPendingStart();
    }

    // Called on every snapshot, and does nothing on almost all of them — there is a note only in
    // the couple of minutes after Start again was pressed.
    async function convResumeRespawn() {
      if (!agents.length || typeof convGet !== 'function') return;
      const held = heldConvRespawn();
      if (!held) return;
      const pane = convRespawnPane(held.ref);
      // Not there yet is not a failure: herdr may still be bringing the agent up. Left for the
      // next snapshot, and dropped by the deadline when it never arrives.
      if (!pane) return;
      const conv = loadConvIndex().find(c => c.id === held.conv);
      if (!conv) { forgetConvRespawn(); return; }
      if (convRespawnResuming === held.ref) return;
      convRespawnResuming = held.ref;
      try {
        const rec = (await convGet([held.key]).catch(() => []))[0];
        // A later Start may have replaced this tab's one pending note while the record was read.
        // That new start owns the pane now; never continue an older member over it.
        if ((heldConvRespawn() || {}).ref !== held.ref) return;
        convAdoptRespawn(conv, held.key, pane, ((rec || {}).spawn || {}).starter || '');
        showSpawnStatus(`"${paneLabel(pane)}" was already running — continued in "${conv.name}".`,
                        'success');
      } finally {
        if (convRespawnResuming === held.ref) convRespawnResuming = '';
      }
    }

    function convRespawn(key) {
      const conv = loadConvIndex().find(c => c.id === convViewId);
      const rec = convViewRecs.find(r => r.key === key);
      const spawn = rec && rec.spawn;
      if (!ws || !conv || !canRespawn(spawn)) return;
      // This member's own restart, already landed — the press before this one, whose answer went
      // down with the tab. Continued onto that pane rather than starting a second agent beside it.
      const held = heldConvRespawn();
      const back = held && held.key === key && held.conv === conv.id
        ? convRespawnPane(held.ref) : null;
      if (back) {
        if (convRespawnResuming === held.ref) return;
        showSpawnStatus(`"${paneLabel(back)}" is already running — continuing "${conv.name}".`,
                        'busy');
        convAdoptRespawn(conv, key, back, (spawn || {}).starter || '');
        return;
      }
      // herdr recycles workspace IDs, so a stale one cannot be trusted to name the workspace the
      // session was in. New tab only where that workspace is live on that host right now.
      const tab = !!spawn.workspace_id && agents.some(x => x.workspace_id === spawn.workspace_id
        && (x.host || 'local') === (spawn.host || 'local'));
      // The starter role it was begun as, from the record or — for a record that predates it — from
      // the name it was given, which is derived from the same badge. A session started as an
      // Architect is started again as one, opening prompt and all; one that matches no badge keeps
      // the old behaviour of its bare wire role.
      // A recorded `at` that is not one of the four badges is still a starter: a launcher tile's
      // members carry any chip the composer offers. Wrapped as a role with nothing but its name,
      // which is all roleStarter reads — and on the wire it is `agent`, which is what it was.
      //
      // And a record that says nothing at all is a record written before any of this was kept, not
      // a session that asked for silence — those say NO_STARTER. So it falls to the default rather
      // than coming up bare, which is what every other way of starting a session already does.
      const was = canonAt(spawn.starter);
      const starter = spawn.starter === NO_STARTER ? null
        : startRoleOf(was)
          || (was && roleStarter({at: was}) ? {at: was} : null)
          || startRoleFromLabel(spawn.label)
          || startRoleOf(START_DEFAULT_AT);
      const msg = Object.assign({
        type: 'start_agent', name: spawn.agent, project_id: spawn.project_id,
        placement: tab ? 'new_tab' : 'new_workspace', slot: slotFor(),
      }, starter ? startRoleFields(starter, '') : {role: respawnRole(spawn)});
      // The alias is carried by id and resolved here, not at the time it was recorded: a config
      // whose provider or model has been edited since restarts on what it says now.
      //
      // Gone is a question, never a fallback. Coming back on the stock endpoint under the name the
      // reader recognises is the one outcome worth refusing outright — so the Start dialog opens
      // on that Project with the custom row unfolded, and this restart continues from whatever is
      // picked there. startIntent is set after the open, which clears it.
      if (spawn.config && !agentConfigLive(spawn.config, spawn.agent)) {
        convSwapMember(key, {
          kind: spawn.agent,
          note: `Agent config "${spawn.config}" is gone. Pick what to start instead.`,
        });
        return;
      }
      if (spawn.config) msg.config = spawn.config;
      // This is continuation, not duplicate: keep the exact name the user recognises in the thread.
      // Only where the relay will take it — a label over 32 characters is refused outright, and a
      // restart that fails over the name is worse than one that comes up as "Architect 2".
      const same = String(rec.label || spawn.label || '').trim();
      if (same && same.length <= 32) msg.label = same;
      if (tab) msg.workspace_id = spawn.workspace_id;
      startIntent = { conv: conv.id, replace: key };
      startPrompt = roleStarter(starter, spawn.agent);
      // And the new pane records the same starter, so the session can be ended and started again
      // any number of times without the answer wearing away.
      startStarter = (starter || {}).at || NO_STARTER;
      showSpawnStatus(`Continuing "${conv.name}"…`, 'busy');
      // Named and written down before the send, not after: the answer is what a reload loses, so
      // the note has to be on disk by the time there is anything to lose.
      msg.ref = convRespawnRef();
      rememberConvRespawn(conv.id, key, msg.ref);
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

    // "Which other pane" is the pair sheet's question too, so it is asked in the pair sheet — with
    // the tick left on, because adding four panes to a conversation used to be four trips through a
    // dialog that closed itself after each one.
    async function convToggleAdd() {
      const conv = loadConvIndex().find(c => c.id === convViewId);
      if (!conv) return;
      convPickRecs = await convAll();
      const taken = new Set((conv.members || []).map(m => m.key));
      const live = new Set(agents.map(convMemberKey));
      // The live panes this conversation does not already name — including panes already recording
      // elsewhere, which bring their own transcript with them (D3). And the sessions that have
      // already ended, which is what a conversation assembled after the fact is made of. Newest
      // first: a picker is ordered by what you are most likely to want.
      const now = Date.now();
      const free = () => agents.filter(x => convMemberKey(x) && !taken.has(convMemberKey(x)));
      const past = convPickRecs
        .filter(r => !taken.has(r.key) && !live.has(r.key) && (r.entries || []).length)
        .sort((a, b) => (b.touched || 0) - (a.touched || 0))
        .slice(0, CONV_PICK_MAX);
      openPanePicker({
        title: `Add to · ${conv.name}`,
        multi: true,
        empty: 'Every live pane is already in this conversation.',
        // Both groups are the same kind of choice — a session, by name, with the harness it runs —
        // so they are the same row. What differs is the heading above it and, for one that has
        // ended, how long ago it last said anything. A pane is chosen by its member key rather than
        // its pane id: a record has no pane behind it to name.
        groups: () => [
          {head: 'Running', rows: free().map(x =>
            pickPaneRow(x, {id: convMemberKey(x)}))},
          {head: 'Recorded', rows: past.map(r => ({
            id: r.key,
            name: r.label || 'Former pane',
            agent: (r.spawn || {}).agent || '',
            project: r.project || (r.spawn || {}).project || (r.spawn || {}).project_id || '',
            meta: configBadge((r.spawn || {}).agent || '', (r.spawn || {}).config),
            note: convSpan(now - (r.touched || now)),
            color: 'var(--muted)',
            glyph: agentGlyph(),
            dim: true,
          }))},
        ],
        // The pane that does not exist yet, under the ones that do. Answering "add a pane" by
        // sending the reader out to Projects to start a session and back in here to join it is the
        // same answer in three steps.
        extra: () => canStartFromConv()
          ? `<button class="pair-pick pair-add" onclick="closePicker(); openNewAgent()">
      <span class="kind" aria-hidden="true">＋</span>
      <span class="info"><span class="name">Start a session and add it</span><span class="meta">A new agent in this conversation, recording from the moment it lands</span></span>
    </button>` : '',
        label: chosen => chosen.length > 1 ? `Add ${chosen.length} panes` : 'Add pane',
        submit: keys => { closePicker(); convJoinKeys(keys); },
      });
    }

    // Every chosen member in one edit. One at a time would save, re-render and re-file the
    // conversation once per pane, and the ceiling would be counted against a roster that the
    // previous save had already grown.
    function convJoinKeys(keys) {
      const recs = convPickRecs;
      convPickRecs = [];
      if (!keys.length) return;
      convEdit(conv => {
        let recording = convRecordingMembers(conv).length;
        const add = [];
        for (const key of keys) {
          const pane = agents.find(x => convMemberKey(x) === key);
          if (pane) {
            // The cap is on panes *recording* at once, which is why a record is never counted
            // against it: that session has stopped.
            if (recording >= CONV_MEMBER_MAX) {
              showToast(`"${conv.name}" already has ${CONV_MEMBER_MAX} live panes.`);
              continue;
            }
            recording++;
            add.push(convMemberOf(pane));
            continue;
          }
          // A member built from a record instead of from a pane: the session has ended, so there is
          // no paneLabel to ask and the record's own label is the only name it has left.
          const rec = recs.find(r => r.key === key);
          if (rec) add.push({key: key, added: Date.now(), label: rec.label || ''});
        }
        if (!add.length) return false;
        conv.members = (conv.members || []).concat(add);
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
      if (typeof stateSyncMark === 'function') stateSyncMark('conv_hidden');
      const views = convViews();
      for (const key in views) if (views[key] === conv.id) delete views[key];
      try { localStorage.setItem(CONV_VIEW_KEY, JSON.stringify(views)); }
      catch (e) { /* private mode: this session only */ }
      if (typeof stateSyncMark === 'function') stateSyncMark('conv_view');
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

    // Bottom tabs are destinations, not a pane-thread selector. From any screen they open the
    // conversation itself, so a tab never changes the reader's current pane behind their back.
    function convTabPick(id) {
      openConversation(id);
    }

    // The whole record, every member, from the store alone. `bottom` scrolls to the newest on the
    // way in; a redraw from the snapshot leaves the reader where they were.
    async function renderConvStandalone(bottom) {
      const view = document.getElementById('convView');
      if (!view || view.style.display === 'none') return;
      const box = document.getElementById('convViewThread');
      const stick = bottom || box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
      const conv = loadConvIndex().find(c => c.id === convViewId);
      if (!conv) { closePanel(); return; }
      document.getElementById('convViewTitle').textContent = conv.name;
      // Redrawn rather than written once: renaming an auto conversation is what promotes it, so
      // this is a fact about the conversation that changes while the window is open.
      const tier = document.getElementById('convViewTier');
      if (tier) tier.hidden = !conv.auto;
      // And whether anything in it is still running, which changes under the reader while the
      // window is open — a member ending is exactly when this has to appear.
      const idle = document.getElementById('convViewIdle');
      if (idle) {
        const live = new Set(agents.concat(shells).map(x => convMemberKey(x)));
        idle.hidden = (conv.members || []).some(m => live.has(m.key));
      }
      const head = view.querySelector('.conv-view-head');
      if (head) head.classList.toggle('auto', !!conv.auto);
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
      const composed = await convCompose(conv, keys);
      if (token !== convStandaloneToken || convViewId !== conv.id) return;
      // Composed over every member and filtered after, never composed over the visible ones: the
      // member index is what picks a bubble's colour, so hiding the first member must not repaint
      // the second one in its tint.
      // A single-member thread is read straight off its one record and its entries carry no key —
      // there was never another member to tell them from. That member is keys[0].
      // Same rule as the pane's own thread: one member on screen is one speaker, and a bubble that
      // stops at 86% is leaving room for a column nothing is drawn in.
      box.classList.toggle('conv-solo', shown.length <= 1);
      // A pair reads as two columns here as well: one agent's words down the left, the other's
      // indented to the right, which is the shape the pane's own thread has always drawn a pair in.
      // The right side is the pane the reader has open when that is one of the two — the same rule
      // the pane thread follows — and the second member otherwise, so the columns are stable for a
      // reader who has no pane open at all.
      const shownKeys = shown.map(m => m.key);
      const openKey = activePane ? convMemberKey(paneOf(activePane)) : '';
      const twoCol = shownKeys.length === 2 && !!(conv.pair_id ||
        agents.some(x => shownKeys.includes(convMemberKey(x)) && pairFor(pairs, x.pane_id)));
      const rightKey = shownKeys.includes(openKey) ? openKey : shownKeys[1];
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
      // Deduped by what each member was *started as* and not by its harness: a thread of `claude`
      // and `oclaude-1` is two different things to talk to, and collapsing them to one claude
      // badge is the header saying the opposite of what the roster says.
      const live = new Map(agents.map(x => [convMemberKey(x), x]));
      const kinds = [];
      const seen = new Set();
      for (const m of members) {
        const rec = composed.recs.find(r => r.key === m.key);
        const spawn = (rec && rec.spawn) || {};
        const pane = live.get(m.key);
        const kind = spawn.agent || (pane && pane.agent) || '';
        const config = (pane && pane.config) || spawn.config || '';
        if (kind && !seen.has(config || kind)) {
          seen.add(config || kind);
          kinds.push([kind, config]);
        }
      }
      // Not `kinds.map(configBadge)`: map hands the callback an index too, and the second argument
      // is the config to name it by — so every badge after the first was named by a number, and
      // the whole render threw.
      // And where those agents are working. Same question the landing card answers with the same
      // badge, asked of the thread that is open: a conversation whose members sit in two Projects
      // is one whose header has to say so, because nothing else on this screen does.
      const projects = [];
      for (const m of members) {
        const rec = composed.recs.find(r => r.key === m.key);
        const pane = live.get(m.key);
        const project = ((rec && rec.spawn) || {}).project || (pane && pane.project) || m.project || '';
        if (project && !projects.includes(project)) projects.push(project);
      }
      document.getElementById('convViewAgents').innerHTML =
        kinds.map(k => configBadge(k[0], k[1])).join('') +
        projects.map(p => ` <span class="badge proj">@${escapeHtml(p)}</span>`).join('');
      convViewRecs = composed.recs;
      convViewEntries = entries;
      // The panel is its own element and diffed on its own: a message arriving must not rewrite the
      // roster under a reader who has just opened it.
      // The session strip, above the thread it is about. Diffed on its own inside arbRender for
      // the same reason the panel below is: this runs on every poll.
      arbRender();
      const panel = document.getElementById('convViewRoster');
      const rosterHtml = convRosterOpen ? convRosterHtml(conv, composed.recs, hidden) : '';
      if (rosterHtml !== convRosterHtmlLast) { convRosterHtmlLast = rosterHtml; panel.innerHTML = rosterHtml; }
      panel.hidden = !convRosterOpen;
      const html = (typeof convOlderHtml === 'function' ? convOlderHtml(shownKeys) : '') +
        (entries.length
        // Same fallback the visibility filter above uses: a single-member thread's entries carry no
        // key, and the dock reads a bubble's key to know who wrote it — an unkeyed bubble has no
        // source and so no target to exclude.
        ? convEntriesHtml(entries, {key: twoCol ? rightKey : keys[0]}, twoCol, 'toggleConvDockPick')
        : (all.length
          ? '<p class="conv-empty">Everything recorded here is still provisional. Turn "final ' +
            'messages only" off in the pane menu to see it.</p>'
          : hidden.size && composed.all.length
            ? '<p class="conv-empty">Every member is hidden. Open the panel above to bring one ' +
              'back.</p>'
            : '<p class="conv-empty">Nothing recorded here yet.</p>')) +
        // What the members are saying right now, under the record of what they have said. Only the
        // shown ones: a member hidden out of this thread is hidden out of its live stream too.
        convSlotsHtml(shownKeys, twoCol ? rightKey : '');
      // The snapshot redraws this view every three seconds, and rewriting innerHTML would take the
      // reader's text selection with it mid-copy. Only a thread that actually changed is written.
      if (html !== convStandaloneHtml) { convStandaloneHtml = html; box.innerHTML = html; }
      // After the thread is on screen: the picks are painted onto its bubbles, and the dock's row
      // says who is live and what is picked.
      // What each member is doing right now, on that member's newest bubble — several at once in a
      // conversation of several, which is the whole point of reading them together.
      syncConvBadge('convViewThread');
      syncDockPicks();
      renderConvDock();
      renderConvStrip();
      const workingEl = document.getElementById('convViewWorking');
      if (workingEl) {
        const workingList = (members || []).map(m => {
          const liveAgent = agents.find(x => convMemberKey(x) === m.key);
          return (liveAgent && (liveAgent.status === 'working' || liveAgent.agent_status === 'working')) ? liveAgent : null;
        }).filter(Boolean);
        workingEl.innerHTML = typeof convWorkingBadgesHtml === 'function'
          ? convWorkingBadgesHtml(workingList, 'convViewThread') : '';
        // Same reservation the pane's thread makes: the chips hang over the top of the box, and a
        // bubble drawn under one cannot be picked.
        box.classList.toggle('has-working', !!workingEl.innerHTML);
      }
      renderConvSoloBanner(conv, members);
      if (stick) box.scrollTop = box.scrollHeight;
    }

    // Solo is a thread that is deliberately missing most of itself, so it says so where the reader
    // is looking — over the thread, between the two floating corners — and carries the way out.
    // Hidden the rest of the time: a banner that is always there is chrome, not an answer.
    function renderConvSoloBanner(conv, members) {
      const bar = document.getElementById('convViewSolo');
      if (!bar) return;
      const key = convSoloKey(conv.id);
      bar.hidden = !key;
      if (!key) { bar.innerHTML = ''; return; }
      const m = (members || []).find(x => x.key === key) || {};
      const live = agents.find(a => convMemberKey(a) === key);
      const name = (live && paneLabel(live)) || m.label || 'one member';
      bar.innerHTML = `<span class="solo-name">Solo · ${escapeHtml(name)}</span>` +
        `<button class="solo-x" onclick="convSetSolo('${escapeHtml(conv.id)}', '')" ` +
        `title="Show every member again" aria-label="Leave solo mode">✕</button>`;
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
      // Which branch this pane's work is landing on — the snapshot carries it, and this is the
      // one path every snapshot and every pane switch goes through.
      if (typeof syncBranchBadges === 'function') syncBranchBadges();
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
