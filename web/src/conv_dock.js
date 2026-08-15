    // --- The conversation window's dock ---
    //
    // The standalone conversation view is a record of several agents talking, and this is the half
    // that talks back: who you are addressing, what is added to what you send, and the composer it
    // all modifies. It floats over the thread rather than sitting under it, so the conversation
    // runs behind the message being written.
    //
    // Deliberately not the pane's thread. There the composer already knows where it is typing —
    // into the pane on screen — and a range dragged across pane rows is a guess at where a message
    // starts, which is why the pane view keeps the prefilled composer as its checkpoint. Here every
    // payload is a whole recorded bubble and there is no open pane to default to, so addressing is
    // something the reader does explicitly and one tap is enough to send.

    // Who you are talking to, and what is being added to it. The target is sticky — it is not a
    // property of a selection, it is who you are talking to, and having chosen an agent you go on
    // talking to it. The picks are not: an instruction is attached to one message, so it is spent
    // by the send that carries it.
    let dockTarget = '', dockPicks = [], dockPicked = new Set(), dockPickedOf = 0;

    // Both rows scroll, and a phone shows their left end — so what was used last is put back there,
    // because the thing used last is overwhelmingly the thing used next. Only use moves anything:
    // everything else keeps the order it had, roster order for members and the shortcut list's
    // order for chips, so the row is never reshuffled by a poll or by a message arriving.
    //
    // Off is a real preference and not a fallback. A row that holds still is a row you can reach
    // for without looking, and someone who has learned where their agents sit has a better index
    // than recency is.
    const MRU_KEYS = {who: 'herdr_dock_who_mru', chip: 'herdr_dock_chip_mru'};
    const DOCK_MRU_KEY = 'herdr_dock_mru';

    function dockMruOn() {
      try { return localStorage.getItem(DOCK_MRU_KEY) !== 'off'; } catch (e) { return true; }
    }

    function setDockMru(on) {
      try { localStorage.setItem(DOCK_MRU_KEY, on ? 'on' : 'off'); }
      catch (e) { /* private mode: this session only */ }
      const pick = document.getElementById('mruPick');
      if (pick) pick.value = on ? 'on' : 'off';
      if (convDockOn()) renderConvDock();
    }

    function dockMru(kind) {
      try {
        const d = JSON.parse(localStorage.getItem(MRU_KEYS[kind]) || '[]');
        return Array.isArray(d) ? d : [];
      } catch (e) { return []; }
    }

    // Recorded whatever the setting says. Turning the sort back on should pick up where the reader
    // left off rather than starting from a row that has forgotten every agent they ever used.
    function noteDockUse(kind, id) {
      if (!id) return;
      const list = dockMru(kind).filter(x => x !== id);
      list.unshift(id);
      try { localStorage.setItem(MRU_KEYS[kind], JSON.stringify(list.slice(0, 32))); }
      catch (e) { /* private mode: this session only */ }
    }

    // Stable: two entries neither of which has ever been used keep the order they came in. A sort
    // that reordered the untouched ones would be shuffling a row nobody has taught anything.
    function byDockMru(kind, list, idOf) {
      if (!dockMruOn()) return list;
      const mru = dockMru(kind);
      const rank = x => { const i = mru.indexOf(idOf(x)); return i < 0 ? mru.length : i; };
      return list.map((x, i) => [x, i])
        .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
        .map(pair => pair[0]);
    }

    function convDockOn() {
      const view = document.getElementById('convView');
      return !!view && view.style.display !== 'none';
    }

    // Every member of this conversation that is a live pane, in roster order — which is the order
    // they joined. A member that has exited is still in the record and still in the roster panel;
    // it is not here, because there is nothing to send to.
    function dockMembers() {
      const conv = loadConvIndex().find(c => c.id === convViewId);
      if (!conv) return [];
      const hidden = convHidden(conv.id);
      const live = (conv.members || []).filter(m => !hidden.has(m.key))
        .map(m => agents.find(a => convMemberKey(a) === m.key)).filter(Boolean);
      // Sorted here rather than in the row, so the row, the list behind ▾ and the fallback target
      // all read the membership in the same order — three places disagreeing about who is first is
      // three answers to "who am I talking to".
      return byDockMru('who', live, convMemberKey);
    }

    // Whoever wrote the picked messages. Two agents' messages are two conversations being quoted as
    // one, which is what the transfer sheet has always refused, so the row stands down rather than
    // guessing which of them the payload belongs to.
    function dockSource() {
      if (!dockPicked.size) return null;
      const keys = new Set(Array.from(document.querySelectorAll('#convViewThread .conv-msg.picked'))
        .map(el => el.dataset.key));
      if (keys.size !== 1) return null;
      return agents.find(a => convMemberKey(a) === keys.values().next().value) || null;
    }

    // Who a message may be sent to. With a bubble picked that is everyone but the pane that said it
    // — a message cannot be transferred back into its own session. The row still *draws* the whole
    // membership (see dockRowHtml): a pick is a passing state, and a conversation that shed its
    // members every time one was quoted would keep answering "who is in this" differently.
    function dockTargets() {
      const source = dockSource();
      const all = dockMembers();
      return source ? all.filter(a => a.pane_id !== source.pane_id) : all;
    }

    // The pane this one is paired with, when it is in the conversation. A default, never a rule:
    // membership is still what makes an agent a target (4.2), and a conversation with no pair
    // recorded anywhere is served exactly as before. But when a message has been picked and nobody
    // has said where it is going, the pair is the right answer nearly every time, and the row was
    // otherwise defaulting to whichever member happened to sort first — which is a fact about the
    // row, not about the message.
    function dockPairTarget(source, list) {
      const pair = source && pairFor(pairs, source.pane_id);
      const partner = pair && partnerOf(pair, source.pane_id);
      return partner && list.some(a => a.pane_id === partner.pane_id) ? partner.pane_id : '';
    }

    // Kept honest against the row it is drawn from: a target that has exited, or that turns out to
    // be the source of what is being transferred, falls back — to the source's partner if it is
    // here, and to the first member if it is not — rather than silently sending somewhere else.
    // A target the reader chose always wins, including one chosen before the pick was made.
    function dockTargetOf(list, source) {
      if (list.some(a => a.pane_id === dockTarget)) return dockTarget;
      return dockPairTarget(source, list) || ((list[0] || {}).pane_id || '');
    }

    // Who the composer is talking to: the row's lit member. Falls back to the whole membership when
    // a pick has excluded everyone, so that typing still has somewhere to go — the same list the row
    // draws in that case.
    function dockAddressed() {
      const list = dockTargets();
      return list.length ? dockTargetOf(list, dockSource()) : dockTargetOf(dockMembers());
    }

    function setDockTarget(paneId) {
      dockTarget = paneId;
      renderConvDock();
      if (window.cue) cue('tick');
    }

    // What a chip does with its instruction: write it into the box, or attach it to the send.
    //
    // Writing it in is the default because it is the honest one — the instruction is on screen,
    // editable, and what you see is what the agent gets. Attaching it keeps the box clear for a
    // long prompt that a wall of boilerplate above it would bury, which is why the other mode
    // exists rather than being an argument nobody won.
    const DOCK_FILL_KEY = 'herdr_dock_fill';

    function dockFill() { return localStorage.getItem(DOCK_FILL_KEY) !== 'off'; }

    function toggleDockFill() {
      try { localStorage.setItem(DOCK_FILL_KEY, dockFill() ? 'off' : 'on'); }
      catch (e) { /* private mode: this session only */ }
      // Switching modes leaves nothing armed behind: an instruction attached in the other mode is
      // invisible in this one, and an invisible instruction on a send is the thing to avoid.
      dockPicks = [];
      renderConvDock();
      if (dockMenuOpen()) openDockMenu();
      if (window.cue) cue('tick');
    }

    // The instruction, rewritten for the agent about to read it, at the caret. The composer keeps
    // whatever is already in it — a chip tapped mid-sentence is someone adding to what they wrote.
    function insertDockShortcut(i) {
      const input = document.getElementById('convInput');
      const text = agentSlash(SHORTCUTS[i].text, agentOf(dockAddressed()));
      const at = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? at;
      input.value = input.value.slice(0, at) + text + input.value.slice(end);
      input.selectionStart = input.selectionEnd = at + text.length;
      autoGrow(input);
      syncConvCursor();
      input.focus();
      if (window.cue) cue('tick');
    }

    // Additive. Two chips are two instructions, in the order they were tapped, and tapping one
    // again takes it back out — so the row is the sentence being built rather than a menu of
    // mutually exclusive ones.
    function toggleDockChip(i) {
      noteDockUse('chip', SHORTCUTS[i].at);
      if (dockFill()) { insertDockShortcut(i); renderConvDock(); return; }
      const at = dockPicks.indexOf(i);
      if (at >= 0) dockPicks.splice(at, 1); else dockPicks.push(i);
      renderConvDock();
      // The list is the same picks drawn twice, so a tap in either place has to reach both. Left
      // open, it would keep showing the ticks it had when it opened.
      if (dockMenuOpen()) openDockMenu();
      if (window.cue) cue('tick');
    }

    function toggleConvDockPick(i) {
      if (dockPicked.has(i)) dockPicked.delete(i); else dockPicked.add(i);
      drawDockPicks();
      renderConvDock();
    }

    // Painted in place rather than by re-rendering the thread: the snapshot redraws this view every
    // three seconds and a rebuild would take the reader's text selection with it mid-copy.
    function drawDockPicks() {
      for (const el of document.querySelectorAll('#convViewThread .conv-msg')) {
        const on = dockPicked.has(Number(el.dataset.i));
        el.classList.toggle('picked', on);
        const tick = el.querySelector('.conv-pick');
        if (tick) tick.setAttribute('aria-pressed', String(on));
      }
    }

    // A render that only appended leaves the picks where they are; anything else moved them, and a
    // pick on the wrong message is worse than none. Same rule the pane's thread follows.
    function syncDockPicks(count) {
      if (count < dockPickedOf) dockPicked.clear();
      dockPickedOf = count;
      drawDockPicks();
    }

    function clearDockPicks() {
      if (!dockPicked.size) return;
      dockPicked.clear();
      drawDockPicks();
      renderConvDock();
    }

    // Leaving the conversation. Who you were talking to and what you were about to say belong to
    // it, and neither means anything in the next one.
    function clearConvDock() {
      dockTarget = ''; dockPicks = []; dockPicked.clear(); dockPickedOf = 0;
      closeDockMenu();
      const input = document.getElementById('convInput');
      if (input) { input.value = ''; autoGrow(input); syncConvCursor(); }
    }

    function renderConvDock() {
      const dock = document.getElementById('convDock');
      const row = document.getElementById('xferRow');
      if (!dock || !row) return;
      const all = dockMembers();
      // Always the whole membership. A pick narrows who may *receive* the message, never who is in
      // the conversation, and a row that dropped the others while a bubble was picked took the
      // reader's other choices away over a state one tap undoes. With every candidate excluded — a
      // bubble picked in a conversation of one — there is simply nothing left to send it to.
      const html = all.length ? dockRowHtml(all, !dockTargets().length) : '';
      row.hidden = !html;
      if (!html) { closeDockMenu(); row.dataset.sig = ''; }
      // Rebuilt only when what it says changed. This runs on every snapshot, and replacing the row
      // wholesale three times a minute would take a chip out from under a finger already on it.
      else if (row.dataset.sig !== html) { row.innerHTML = html; row.dataset.sig = html; }
      // Nobody live to send to is the ordinary end state of a record, not a failure: the thread is
      // still readable, and a composer that could only fail is worse than none.
      dock.hidden = !all.length;
      paintDockAccent();
      syncDockHeight();
    }

    // The bubble wears the colour of the agent it is addressed to. The row says who in words; this
    // says it on the thing being written, which is where the eye already is while typing — and it
    // is the same colour that agent's bubbles carry in the thread above.
    function paintDockAccent() {
      const bubble = document.getElementById('convBubble');
      if (!bubble) return;
      const c = agentColor((paneOf(dockAddressed()) || {}).agent);
      bubble.style.setProperty('--dock-accent', c || 'var(--border)');
      bubble.style.setProperty('--dock-wash',
        c ? `color-mix(in srgb, ${c} 6%, transparent)` : 'transparent');
      // The cursor takes the accent when there is one and the text colour when there is not: a
      // harness the app has no colour for must not leave the caret drawn in the border's grey.
      bubble.style.setProperty('--dock-cursor', c || 'var(--text)');
    }

    // A tap anywhere in the composer is a tap in the field. The send button and anything else with
    // its own action keep theirs — this is only for the padding around the text.
    function focusConvInput(e) {
      if (e.target.closest && e.target.closest('button')) return;
      const input = document.getElementById('convInput');
      if (!input) return;
      input.focus();
      syncConvCursor();
    }

    // The block cursor. A textarea's own caret is a hairline that disappears with focus, and this
    // is a box that types into terminals — so the caret is painted instead, on a ghost copy of the
    // text sitting exactly under the field. The character at the caret goes inside the block, and a
    // caret at the end of the text gets a space to sit on, so the block has a width either way.
    function syncConvCursor() {
      const input = document.getElementById('convInput');
      const ghost = document.getElementById('convGhost');
      if (!input || !ghost) return;
      const at = input.selectionStart ?? input.value.length;
      const head = input.value.slice(0, at), tail = input.value.slice(at);
      ghost.innerHTML = escapeHtml(head) +
        `<span class="cur">${escapeHtml(tail.slice(0, 1) || ' ')}</span>` +
        escapeHtml(tail.slice(1));
      // Follows the field rather than being scrolled on its own: past 40vh the textarea scrolls,
      // and a ghost that stayed at the top would paint the block on the wrong line.
      ghost.scrollTop = input.scrollTop;
      input.parentElement.classList.toggle('on', document.activeElement === input);
    }

    // The caret moves for more reasons than a key going down: a held arrow repeats without ever
    // firing keyup, a drag selects while the mouse moves, and undo, autocorrect and dictation move
    // it with no key at all. So the block follows the *selection* rather than the events that might
    // have changed it — one listener, and every one of those cases is covered.
    //
    // Bound to the document as well as the field: browsers disagree about which of the two fires
    // for a textarea, and a caret that lags a held arrow key is exactly the case this is for.
    function watchConvCursor() {
      const input = document.getElementById('convInput');
      if (!input) return;
      const sync = () => { if (document.activeElement === input) syncConvCursor(); };
      document.addEventListener('selectionchange', sync);
      input.addEventListener('selectionchange', sync);
      // The fallback, for a browser that fires neither: a key that moves the caret is read after
      // the browser has moved it, not while it is still where it was.
      input.addEventListener('keydown', () => requestAnimationFrame(syncConvCursor));
    }

    function dockRowHtml(list, noSend) {
      const target = dockAddressed();
      const source = dockSource();
      // One lit, the rest dimmed rather than hidden: which agents are in this conversation is
      // information, and a row that showed only the chosen one would answer a different question.
      // Named the way the pane header names one: the live dot, the label, and the harness badge.
      // Which agent is about to receive another agent's output is the fact worth being sure of, and
      // "scratch" alone does not say whether that is a codex or a claude.
      //
      // The member whose message is picked stays in the row, marked as the one it came from rather
      // than removed: it is still in the conversation, it is still who you were reading, and a row
      // that lost a pill on every pick would flicker its own membership.
      const who = list.map(a => {
        // Not marked when it is the only member there is: a conversation of one still types into
        // the pane it is reading, and a pill drawn dead beside a composer that works would be lying.
        const from = !!source && a.pane_id === source.pane_id && !noSend;
        const name = escapeHtml(paneLabel(a));
        return `<button class="xfer-who${a.pane_id === target ? ' on' : ''}${from ? ' from' : ''}" ` +
          `style="--who-accent:${agentColor(a.agent) || 'var(--text)'}" ` +
          (from ? 'disabled ' : `onclick="setDockTarget('${a.pane_id}')" `) +
          `aria-pressed="${a.pane_id === target}" ` +
          `title="${from ? `${name} wrote the picked message` : `Talk to ${name}`}" ` +
          `aria-label="${from ? `${name}, who wrote the picked message` : `Talk to ${name}`}">` +
          `<span class="dot" style="background:${statusColor(a)}" aria-hidden="true"></span>` +
          `${name}${agentBadge(a.agent)}</button>`;
      }).join('');
      // Numbered by the order they were chosen, because that order is what will be written and two
      // lit chips otherwise say nothing about which comes first. In fill mode nothing is lit at
      // all: the instruction is in the box where it can be read, so a second place saying it is on
      // would be saying it twice.
      const fill = dockFill();
      const chips = byDockMru('chip', SHORTCUTS.map((s, i) => ({s, i})), x => x.s.at).map(({s, i}) => {
        const at = fill ? -1 : dockPicks.indexOf(i);
        return `<button class="xfer-chip${at >= 0 ? ' on' : ''}" onclick="toggleDockChip(${i})" ` +
          `aria-pressed="${at >= 0}" title="${escapeHtml(s.label)}" ` +
          `aria-label="${fill ? 'Write' : 'Add'} the instruction ${escapeHtml(s.label)}">` +
          `@${escapeHtml(s.at)}${at >= 0 && dockPicks.length > 1 ? `<sub>${at + 1}</sub>` : ''}` +
          `</button>`;
      }).join('');
      // Which of the two a chip does, said by the control that changes it. Pressed is "into the
      // box", because that is the mode where the instruction is visible.
      const fillBtn = `<button class="xfer-chip fill${fill ? ' on' : ''}" onclick="toggleDockFill()" ` +
        `aria-pressed="${fill}" title="${fill ? 'Instructions are written into the message' :
          'Instructions are added to the message when it is sent'}" ` +
        `aria-label="Write instructions into the message box">⤵</button>`;
      const n = dockPicked.size;
      // Send belongs to the bubbles. With nothing picked there is nothing for it to carry and the
      // composer's own send is what fires, so the row would be offering a second button for a
      // message it does not hold.
      const send = n && !noSend
        ? `<button class="xfer-send" onclick="convDockSend()" ` +
          `title="Send the picked message${n === 1 ? '' : 's'} to ` +
          `${escapeHtml(paneLabel(paneOf(target)) || target)}" ` +
          `aria-label="Send the picked messages">Send (${n}) ›</button>`
        : '';
      // Only the lists scroll. The buttons on the right are pinned, because a row long enough to
      // push them off a phone would hide the controls the row is for — and each is the way back to
      // what scrolled away, so neither can scroll away itself. The same shape on both lines: the
      // things you choose from on the left, the way to see all of them on the right.
      const to = escapeHtml(paneLabel(paneOf(target)) || target);
      return `<div class="xfer-act"><div class="xfer-who-row">${who}</div>` +
        // The same icon a pane wears in its header and on its card, so what the list holds is said
        // by the button that opens it rather than by a caret that could open anything.
        `<button class="xfer-who-more list" onclick="toggleWhoMenu()" ` +
        `aria-expanded="${whoMenuOpen()}" ` +
        `title="Every agent, as a list" aria-label="Every agent, as a list">` +
        `${(paneOf(target) || {}).agent ? '🤖' : '⬛'}</button>` +
        // The way out of the reading window and into the addressed pane itself. Beside the list it
        // is chosen from, because "who am I talking to" and "take me there" are the same question
        // asked twice.
        (target ? `<button class="xfer-who-more open" onclick="openDockPane()" ` +
          `title="Open ${to}'s terminal" aria-label="Open ${to}'s terminal">⇱</button>` : '') +
        `</div>` +
        `<div class="xfer-act"><div class="xfer-chip-row">${chips}</div>` +
        `<button class="xfer-chip more" onclick="toggleDockMenu()" ` +
        `aria-expanded="${dockMenuOpen()}" ` +
        `title="Every instruction, as a list" aria-label="Every instruction, as a list">@+</button>` +
        fillBtn + send + `</div>`;
    }

    // The same instructions as a list, for a row that has scrolled past the edge of a phone and for
    // reading the full label rather than its @name. It writes the same picks the chips do.
    function openDockMenu() {
      const box = document.getElementById('chipMenu');
      const fill = dockFill();
      box.innerHTML = SHORTCUTS.map((s, i) =>
        `<button class="menu-item" role="${fill ? 'menuitem' : 'menuitemcheckbox'}" ` +
        (fill ? '' : `aria-checked="${dockPicks.includes(i)}" `) +
        `onclick="toggleDockChip(${i})">` +
        `<span class="tick">${!fill && dockPicks.includes(i) ? '✓' : ''}</span>` +
        `@${escapeHtml(s.at)} — ${escapeHtml(s.label)}</button>`).join('') +
        `<button class="menu-item" role="menuitem" onclick="closeDockMenu()">Done</button>`;
      box.hidden = false;
      syncDockHeight();
    }

    // The same members as a list, for a row that has scrolled past the edge of a phone and for
    // reading a name that the pill cut off. It chooses the same target the pills do — the lit one is
    // ticked, and the member whose message is picked is named but not choosable, exactly as in the
    // row.
    function openWhoMenu() {
      const box = document.getElementById('whoMenu');
      const target = dockAddressed();
      const source = dockSource();
      const noSend = !dockTargets().length;
      box.innerHTML = dockMembers().map(a => {
        const from = !!source && a.pane_id === source.pane_id && !noSend;
        const on = a.pane_id === target;
        const name = escapeHtml(paneLabel(a));
        return `<button class="menu-item" role="menuitemradio" aria-checked="${on}" ` +
          (from ? 'disabled ' : `onclick="pickDockTarget('${a.pane_id}')" `) +
          `aria-label="${from ? `${name}, who wrote the picked message` : `Talk to ${name}`}">` +
          `<span class="tick">${on ? '✓' : ''}</span>` +
          `<span class="dot" style="background:${statusColor(a)}" aria-hidden="true"></span>` +
          `${name}${agentBadge(a.agent)}</button>`;
      }).join('');
      closeDockMenu('chipMenu');   // one list open at a time; two would cover the thread twice over
      box.hidden = false;
      syncDockHeight();
    }

    // Chosen from the list rather than the row, so the list has said what it was opened to say and
    // closes behind the choice. The pills stay where they are — they are the row, not a menu.
    function pickDockTarget(paneId) {
      closeDockMenu('whoMenu');
      setDockTarget(paneId);
    }

    // A bubble double-tapped is that agent addressed. Double rather than single: a single tap in a
    // thread is already how text is selected and how a bubble is picked for transfer, and a gesture
    // that has to share with those two would fire on both of them.
    //
    // Only the conversation window's thread, because it is the only one with a target to change —
    // the pane's own composer types into the pane on screen.
    function addressConvAuthor(key) {
      const live = dockTargets().find(a => convMemberKey(a) === key);
      // No target: the author has exited, is folded out of the thread, or is the source of what is
      // picked — a message cannot be transferred back into its own session.
      if (!live) return;
      // The word the double-click selected is not a selection anybody asked for.
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
      setDockTarget(live.pane_id);
      showToast(`Talking to ${paneLabel(live) || live.pane_id}`);
    }

    // Into the addressed pane's terminal, not into its thread. The thread is what this window
    // already is, and a reader leaving it is leaving it for the rows — the live frame, the
    // keyboard, the approval buttons — so the pane's thread panel is turned off on the way.
    function openDockPane() {
      const live = agents.find(a => a.pane_id === dockAddressed());
      if (!live) { showToast('That agent is no longer running.'); return; }
      convSetView(live, '');
      jumpToPane(live.pane_id);
    }

    // Each list's button is its own toggle: a second tap on the control that opened it closes it,
    // which is also what keeps it out of the tap-outside-to-close rule below.
    function toggleDockMenu() {
      if (dockMenuOpen()) closeDockMenu('chipMenu'); else openDockMenu();
    }

    function toggleWhoMenu() {
      if (whoMenuOpen()) closeDockMenu('whoMenu'); else openWhoMenu();
    }

    function dockMenuOpen() {
      const box = document.getElementById('chipMenu');
      return !!box && !box.hidden;
    }

    function whoMenuOpen() {
      const box = document.getElementById('whoMenu');
      return !!box && !box.hidden;
    }

    // Named for one list or, with nothing named, for both — the callers that are leaving the
    // conversation or have just sent something mean every list, not one of them.
    function closeDockMenu(id) {
      const ids = id ? [id] : ['chipMenu', 'whoMenu'];
      for (const one of ids) {
        const box = document.getElementById(one);
        if (box && !box.hidden) { box.hidden = true; syncDockHeight(); }
      }
    }

    // What the lit chips say, rewritten for the agent about to read them, in the order they were
    // tapped. The order is the user's sentence: "@review @test" is review then test, and sorting it
    // back into the shortcut list's order would be the app rewriting what they said.
    function dockInstruction(targetPaneId) {
      return transferInstruction(dockPicks, targetPaneId);
    }

    // Typed text, to whoever the row has lit. No checkpoint and no prefill: there is no pane on
    // screen to prefill *into*, and what is being sent is what the composer already shows.
    function convSend() {
      // With bubbles picked there is one message being written, and the row's Send is a labelled
      // second view of this button rather than a different one. Sending only the typed half here
      // would quietly drop the quote the pick put on the message.
      if (dockPicked.size && dockTargets().length) return convDockSend();
      const input = document.getElementById('convInput');
      const body = input.value.trim();
      if (!body) return;
      const target = dockAddressed();
      const live = agents.find(a => a.pane_id === target);
      if (!live) { showToast('That agent is no longer running.'); return; }
      const lead = dockInstruction(target);
      if (!sendTextTo(target, lead ? lead + '\n\n' + body : body)) return;
      noteDockUse('who', convMemberKey(live));
      input.value = ''; autoGrow(input); syncConvCursor();
      // The instruction was attached to this message, so it goes with it. Who you are talking to
      // stays — that is the point of having chosen them.
      dockPicks = [];
      closeDockMenu();
      renderConvDock();
      showToast(`Sent to ${paneLabel(live) || target}`);
      burstPoll(target);
    }

    // Ctrl/Cmd+Enter sends, Enter writes a newline. Never a bare Enter: there is no shell behind
    // this composer to make a line end at one, and the message being written is a paragraph.
    function convInputKey(e) {
      if (enterAction(e, {enterSends: false, shell: false}) !== 'send') return;
      e.preventDefault();
      convSend();
    }

    // The picked bubbles into another member's session, in one tap.
    //
    // This is the app's one send with no checkpoint behind it, and it is scoped here for a reason:
    // in the pane view a payload is a *selection* — a guess at where a message starts and ends,
    // which is why the ruler exists and why the prefilled composer is where you find out you took
    // the prompt as well as the answer. Here the payload is a bubble, which *is* the message. There
    // is no boundary to get wrong, and the checkpoint would be re-reading something just read.
    //
    // Not armed like CLS and Esc either. Those fire on one tap of a button that sits under the
    // thumb; this needs a message picked and a target standing, and the pick is the deliberate act
    // the arm would be duplicating. The toast names where it went, because a mis-tap is otherwise
    // silent.
    function convDockSend() {
      const source = dockSource();
      if (!source) { showToast('Select messages from one agent to transfer.'); return; }
      const picked = Array.from(document.querySelectorAll('#convViewThread .conv-msg.picked'))
        .map(el => el.dataset.text || '').filter(Boolean);
      if (!picked.length) return;
      const targets = dockTargets();
      if (!targets.length) { showToast('Nobody else in this conversation to send it to.'); return; }
      const target = dockTargetOf(targets, source);
      const live = agents.find(a => a.pane_id === target);
      if (!live) { showToast('That agent is no longer running.'); return; }
      // Read in thread order rather than in the order they were tapped: a pair of messages that
      // arrives out of order is not the conversation the reader saw.
      const quoted = picked.join('\n\n');
      const out = composeTransfer(dockInstruction(target), paneLabel(source) || source.pane_id, quoted);
      if (out.error) { showToast(out.error); return; }
      // Whatever was already typed goes under the quote. The composer here is always open, so a
      // send that dropped it would throw away a message someone was in the middle of writing — and
      // a payload with a note of your own on the end is what `classifyVia` already calls `mixed`.
      const input = document.getElementById('convInput');
      const kept = input.value.trim();
      // What the send is measured against, so the target's transcript records where the text came
      // from rather than claiming the reader typed another agent's words.
      pendingTransfer = {
        key: convMemberKey(source), label: paneLabel(source) || source.pane_id,
        body: quoted, payload: out.text, hash: convHash(quoted), at: Date.now(),
      };
      if (!sendTextTo(target, kept ? out.text + '\n\n' + kept : out.text)) return;
      noteDockUse('who', convMemberKey(live));
      input.value = ''; autoGrow(input); syncConvCursor();
      dockPicks = [];
      dockPicked.clear();
      drawDockPicks();
      closeDockMenu();
      renderConvDock();
      showToast(`Sent ${picked.length} message${picked.length === 1 ? '' : 's'} ` +
        `to ${paneLabel(live) || target}`);
      burstPoll(target);
    }

    // How much of the thread the floating dock covers. It changes with the address row, the chip
    // list and a composer being typed into, so it is measured rather than guessed — a guessed
    // number is either a gap under the last bubble or a bubble that cannot be scrolled to.
    function syncDockHeight() {
      const dock = document.getElementById('convDock');
      const view = document.getElementById('convView');
      if (!dock || !view) return;
      view.style.setProperty('--dock-h', (dock.hidden ? 0 : dock.offsetHeight) + 'px');
    }

    function initConvDock() {
      const dock = document.getElementById('convDock');
      // The cursor is drawn before anything is typed, because it is what says the box is a place to
      // type — that is the whole reason it is always on.
      syncConvCursor();
      watchConvCursor();
      // A menu opened by mistake closes by tapping past it, the way every other menu on a phone
      // does. One listener for the life of the page rather than one per open, so nothing has to be
      // taken back off again. `@+` itself is excluded: it is the menu's own toggle.
      // Capture, because a chip's own handler rebuilds the list it was tapped in: by the time a
      // bubbled click reached here the target would be detached from the document and `closest`
      // would say it came from nowhere, closing the menu on its own taps.
      document.addEventListener('click', e => {
        if (!e.target.closest) return;
        if (dockMenuOpen() && !e.target.closest('#chipMenu, .xfer-chip')) closeDockMenu('chipMenu');
        if (whoMenuOpen() && !e.target.closest('#whoMenu, .xfer-who-more')) closeDockMenu('whoMenu');
      }, true);
      const thread = document.getElementById('convViewThread');
      if (thread) thread.addEventListener('dblclick', e => {
        const msg = e.target.closest && e.target.closest('.conv-msg');
        if (msg) addressConvAuthor(msg.dataset.key);
      });
      if (!dock || !window.ResizeObserver) return;
      new ResizeObserver(syncDockHeight).observe(dock);
      syncDockHeight();
    }
