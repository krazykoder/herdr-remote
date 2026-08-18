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

    // Who a message may be sent to is the whole membership, the author of the picked bubble
    // included. Handing an agent its own words back is a real move — "redo this", "you said this,
    // now check it" — and the row is not the place to decide it is a mistake.
    //
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

    // Kept honest against the row it is drawn from: a target that has exited falls back — to the
    // source's partner if it is here, and to the first member if it is not — rather than silently
    // sending somewhere else. A target the reader chose always wins, including one chosen before
    // the pick was made.
    function dockTargetOf(list, source) {
      if (list.some(a => a.pane_id === dockTarget)) return dockTarget;
      return dockPairTarget(source, list) || ((list[0] || {}).pane_id || '');
    }

    // Who the composer is talking to: the row's lit member.
    function dockAddressed() {
      return dockTargetOf(dockMembers(), dockSource());
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
      if (optMenuOpen()) openOptMenu();
      if (window.cue) cue('tick');
    }

    // The keyboard's own correction — Settings' switch, reached from the composer it is about. One
    // setting and not two: it is already applied to both composers from one key, and a second copy
    // living beside this box would disagree with the one in Settings the moment either was used.
    function toggleDockAutocorrect() {
      setAutocorrect(!autocorrectOn());
      if (optMenuOpen()) openOptMenu();
      if (window.cue) cue('tick');
    }

    // Everything about how the composer behaves, in one list. Both are switches rather than one
    // being a button and the other a menu item: they are the same kind of thing — a standing
    // preference about this box — and a row of lone toggles says nothing about what each one is.
    function openOptMenu() {
      const box = document.getElementById('optMenu');
      const opts = [
        ['Show inline prompt', dockFill(), 'toggleDockFill()',
          'Write an instruction into the message box instead of attaching it at the send'],
        ['Autocorrect', autocorrectOn(), 'toggleDockAutocorrect()',
          "Let the keyboard correct what you type. Off by default — this box types filenames and flags"],
      ];
      box.innerHTML = opts.map(([label, on, call, why]) =>
        `<button class="menu-item" role="menuitemcheckbox" aria-checked="${on}" ` +
        `onclick="${call}" title="${escapeHtml(why)}">` +
        `<span class="tick">${on ? '✓' : ''}</span>${escapeHtml(label)}</button>`).join('') +
        `<button class="menu-item" role="menuitem" onclick="closeDockMenu('optMenu')">Done</button>`;
      closeDockMenu('chipMenu');
      closeDockMenu('whoMenu');
      box.hidden = false;
      syncDockHeight();
    }

    function optMenuOpen() {
      const box = document.getElementById('optMenu');
      return !!box && !box.hidden;
    }

    function toggleOptMenu() {
      if (optMenuOpen()) closeDockMenu('optMenu'); else openOptMenu();
    }

    // The instruction is appended as its own line. A prompt is a new instruction, not an edit to
    // whatever sentence happens to hold the caret.
    function insertDockShortcut(i) {
      const input = document.getElementById('convInput');
      const text = agentSlash(SHORTCUTS[i].text, agentOf(dockAddressed()));
      input.value += input.value && !input.value.endsWith('\n') ? '\n' + text : text;
      input.selectionStart = input.selectionEnd = input.value.length;
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
    // it, and neither means anything in the next one — so the picks go, and the half-written
    // message goes with the conversation it was being written to rather than into the next one's
    // box.
    function clearConvDock() {
      dockTarget = ''; dockPicks = []; dockPicked.clear(); dockPickedOf = 0;
      closeDockMenu();
      const input = document.getElementById('convInput');
      if (input) { input.value = ''; autoGrow(input); syncConvCursor(); }
    }

    // Half-written messages, one per conversation, for as long as the page is open. Switching tabs
    // to read what somebody else said is part of writing a reply, and losing the reply to it made
    // the strip something to avoid mid-sentence. Deliberately in memory and not in storage: a
    // draft is a thing in flight, and a reload is a session ending — see D4's tiering for the same
    // line drawn between what is asserted and what is passing.
    const convComposerDrafts = new Map();

    // Called before convViewId moves, so what is in the box is filed under the conversation it was
    // written to. An empty box drops the entry rather than storing '': "nothing written" and
    // "nothing kept" are the same state, and a stale empty draft would survive a Send.
    function stashConvDraft() {
      const input = document.getElementById('convInput');
      if (!input || !convViewId) return;
      if (input.value.trim()) convComposerDrafts.set(convViewId, input.value);
      else convComposerDrafts.delete(convViewId);
    }

    function restoreConvDraft() {
      const input = document.getElementById('convInput');
      const text = convViewId ? convComposerDrafts.get(convViewId) : '';
      if (!input || !text) return;
      input.value = text;
      autoGrow(input);
      syncConvCursor();
    }

    function renderConvDock() {
      const dock = document.getElementById('convDock');
      const row = document.getElementById('xferRow');
      if (!dock || !row) return;
      const all = dockMembers();
      // Always the whole membership. A pick decides what is being sent, never who is in the
      // conversation or who may have it.
      const html = all.length ? dockRowHtml(all) : '';
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
      stickConvLatest();
    }

    // The composer grows upward under the thread. Keep its newest bubble in view while writing;
    // reading history still wins because this only runs after the writer explicitly focuses it.
    function stickConvLatest() {
      const box = document.getElementById('convViewThread');
      if (!box || !box.offsetParent) return;
      requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
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

    // The caret, kept on screen inside the field.
    //
    // Past its max height the field scrolls itself, and a browser scrolls a textarea to its own
    // caret on input — but `autoGrow` re-measures by setting the height to `auto` first, and that
    // reflow puts `scrollTop` back to the top on every keystroke. So writing past the fold left
    // the caret below the visible band: the line being typed was off screen, and it came back only
    // by scrolling down by hand to find it.
    //
    // Measured off the ghost, which already mirrors the text exactly and already marks the caret —
    // there is nothing else in a textarea that says which pixel row the caret is on. Only from the
    // events that move the caret, never from the field's own scroll: scrolling up to reread what
    // you wrote must not be undone by the thing that follows the caret.
    function keepConvCaret() {
      const input = document.getElementById('convInput');
      const ghost = document.getElementById('convGhost');
      syncConvCursor();
      if (!input || !ghost) return;
      const cur = ghost.querySelector('.cur');
      if (!cur) return;
      const top = cur.offsetTop, bottom = top + cur.offsetHeight, view = input.clientHeight;
      if (bottom > input.scrollTop + view) input.scrollTop = bottom - view;
      else if (top < input.scrollTop) input.scrollTop = top;
      ghost.scrollTop = input.scrollTop;
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
      const sync = () => { if (document.activeElement === input) keepConvCaret(); };
      document.addEventListener('selectionchange', sync);
      input.addEventListener('selectionchange', sync);
      // The fallback, for a browser that fires neither: a key that moves the caret is read after
      // the browser has moved it, not while it is still where it was.
      input.addEventListener('keydown', () => requestAnimationFrame(keepConvCaret));
    }

    function dockRowHtml(list) {
      const target = dockAddressed();
      // One lit, the rest dimmed rather than hidden: which agents are in this conversation is
      // information, and a row that showed only the chosen one would answer a different question.
      // Named the way the pane header names one: the live dot, the label, and the harness badge.
      // Which agent is about to receive another agent's output is the fact worth being sure of, and
      // "scratch" alone does not say whether that is a codex or a claude.
      //
      // Every member is choosable, the author of the picked bubble included: sending an agent its
      // own words back is a thing people do on purpose.
      // Addressed first. Only in the row that is drawn — dockMembers stays roster order, because
      // the fallback target is read off its first entry and a list that reordered itself around
      // the current choice could never fall back to anything else. Stable, so the rest keep the
      // order they joined in.
      const who = list.slice()
        .sort((a, b) => (b.pane_id === target) - (a.pane_id === target))
        .map(a => {
        const name = escapeHtml(paneLabel(a));
        return `<button class="xfer-who${a.pane_id === target ? ' on' : ''}" ` +
          `style="--who-accent:${agentColor(a.agent) || 'var(--text)'}" ` +
          `onclick="setDockTarget('${a.pane_id}')" ` +
          `aria-pressed="${a.pane_id === target}" ` +
          `title="Talk to ${name}" aria-label="Talk to ${name}">` +
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
      // What a chip does is one of the composer's settings, not a mode of its own, so it is behind
      // the settings list with the rest of them rather than beside the chips as a lone toggle.
      const fillBtn = `<button class="xfer-chip opts" onclick="toggleOptMenu()" ` +
        `aria-expanded="${optMenuOpen()}" ` +
        `title="How the composer behaves" aria-label="How the composer behaves">⚙</button>`;
      const n = dockPicked.size;
      // Send belongs to the bubbles. With nothing picked there is nothing for it to carry and the
      // composer's own send is what fires, so the row would be offering a second button for a
      // message it does not hold.
      const send = n
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
        // asked twice. A screen rather than an arrow: what it opens is the pane's terminal, and an
        // arrow says only that something moves.
        (target ? `<button class="xfer-who-more open" onclick="openDockPane()" ` +
          `title="Open ${to}'s terminal" aria-label="Open ${to}'s terminal">🖥</button>` : '') +
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
      closeDockMenu('optMenu');
      box.hidden = false;
      syncDockHeight();
    }

    // The same members as a list, for a row that has scrolled past the edge of a phone and for
    // reading a name that the pill cut off. It chooses the same target the pills do — the lit one is
    // ticked, and everyone in the row is choosable here too.
    function openWhoMenu() {
      const box = document.getElementById('whoMenu');
      const target = dockAddressed();
      box.innerHTML = dockMembers().map(a => {
        const on = a.pane_id === target;
        const name = escapeHtml(paneLabel(a));
        return `<button class="menu-item" role="menuitemradio" aria-checked="${on}" ` +
          `onclick="pickDockTarget('${a.pane_id}')" aria-label="Talk to ${name}">` +
          `<span class="tick">${on ? '✓' : ''}</span>` +
          `<span class="dot" style="background:${statusColor(a)}" aria-hidden="true"></span>` +
          `${name}${agentBadge(a.agent)}</button>`;
      }).join('') +
        // Last, under the membership: another agent in this conversation is one more of the same
        // list, and the place that answers "who is in this" is the place to add to it.
        (canStartFromConv()
          ? `<button class="menu-item" role="menuitem" onclick="openNewAgent()">` +
            `<span class="tick">+</span>New agent</button>`
          : '');
      closeDockMenu('chipMenu');   // one list open at a time; two would cover the thread twice over
      closeDockMenu('optMenu');
      box.hidden = false;
      syncDockHeight();
    }

    // --- New agent, from inside the conversation ---
    //
    // The membership list is where "who is in this conversation" is answered, so it is also where
    // another one is added. The full Start session sheet asks where the session goes; from here that
    // is already answered — beside what this conversation is running — and what is left is four
    // choices, three of them made by tapping a badge: harness, role, name, Project.
    let newAgentKind = '';
    let newAgentRole = 0;
    let newAgentProject = '';

    // The relay must be willing to start, and there must be a Project to start into.
    function canStartFromConv() {
      return !!(startOptions && (startOptions.agents || []).length && projects.length);
    }

    function openNewAgent() {
      closeDockMenu();
      if (!canStartFromConv()) { showToast('This relay does not start sessions.'); return; }
      const conv = loadConvIndex().find(c => c.id === convViewId);
      const from = paneOf(dockAddressed());
      document.getElementById('newAgentConv').textContent = conv ? conv.name : '';
      // The harness the conversation is already being had in, because a second opinion on the same
      // work is what this is usually for. Falls back to the first the relay will start.
      const kinds = startOptions.agents || [];
      newAgentKind = from && kinds.includes(from.agent) ? from.agent : kinds[0];
      newAgentRole = 0;
      // Spawned where the conversation lives. Not a rule — the row is right there — but a Project
      // chosen for you is one fewer question in a dialog that exists to be quick.
      newAgentProject = from && projects.some(p => p.id === from.project_id)
        ? from.project_id : (projects[0] || {}).id || '';
      document.getElementById('newAgentName').value = '';
      setNewAgentError('');
      closeDockMenu('newAgentProjMenu');
      renderNewAgent();
      document.getElementById('newAgentModal').style.display = 'block';
    }

    function closeNewAgent() {
      document.getElementById('newAgentModal').style.display = 'none';
      closeDockMenu('newAgentProjMenu');
    }

    function setNewAgentError(text) {
      const el = document.getElementById('newAgentError');
      el.textContent = text || '';
      el.style.display = text ? 'block' : 'none';
    }

    // Three rows of badges, in the order the decision is made. The Project row is one line that
    // scrolls: there is usually one Project in play, and the rest are behind @+ beside it.
    function renderNewAgent() {
      document.getElementById('newAgentKinds').innerHTML = (startOptions.agents || [])
        .map(k => badgeHtml(k, k === newAgentKind, `pickNewAgentKind('${k}')`, {agent: k})).join('');
      document.getElementById('newAgentRoles').innerHTML = startRoles().map((r, i) =>
        badgeHtml(`# ${r.name}`, i === newAgentRole, `pickNewAgentRole(${i})`,
          {proj: true, title: roleStarter(r) ? `Opens with @${r.at}` : 'No opening prompt yet'}))
        .join('');
      document.getElementById('newAgentProjects').innerHTML = projects.map(p =>
        badgeHtml(`@${p.label}`, p.id === newAgentProject, `pickNewAgentProject('${p.id}')`,
          {proj: true})).join('');
      // Kept on screen when the row is longer than the line, so the chosen Project is never the one
      // that scrolled off.
      const on = document.querySelector('#newAgentProjects .badge.pick.on');
      if (on && on.scrollIntoView) on.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }

    function pickNewAgentKind(kind) {
      newAgentKind = kind;
      renderNewAgent();
      if (window.cue) cue('tick');
    }

    function pickNewAgentRole(i) {
      newAgentRole = i;
      renderNewAgent();
      if (window.cue) cue('tick');
    }

    function pickNewAgentProject(id) {
      newAgentProject = id;
      closeDockMenu('newAgentProjMenu');
      renderNewAgent();
      if (window.cue) cue('tick');
    }

    // Every Project as a list, for the ones the line could not hold — the same @+ the instruction
    // row uses, doing the same job.
    function toggleNewAgentProjects() {
      const box = document.getElementById('newAgentProjMenu');
      if (!box.hidden) { box.hidden = true; return; }
      box.innerHTML = projects.map(p =>
        `<button class="menu-item" role="menuitemradio" aria-checked="${p.id === newAgentProject}" ` +
        `onclick="pickNewAgentProject('${p.id}')">` +
        `<span class="tick">${p.id === newAgentProject ? '✓' : ''}</span>` +
        `@${escapeHtml(p.label)}</button>`).join('');
      box.hidden = false;
    }

    function submitNewAgent() {
      if (!ws) return;
      const role = startRoles()[newAgentRole];
      if (!newAgentProject || !newAgentKind || !role) { setNewAgentError('Pick a project first'); return; }
      // Omitted, not empty: the relay derives "Role N" from an absent label and refuses a blank one.
      // A badge the relay has no role for is named here instead, or the pane would come up called
      // "Agent 1" when what was asked for was an Arbitrator. Same rule the Start sheet follows.
      const typed = document.getElementById('newAgentName').value.trim();
      const msg = Object.assign({
        type: 'start_agent', name: newAgentKind,
        project_id: newAgentProject, slot: slotFor(),
      }, startRoleFields(role, typed));
      // Where is not asked: beside what this Project is already running, which is what a new member
      // of an ongoing conversation wants. A Project with nothing live has nowhere to be beside, and
      // gets a workspace of its own.
      const beside = agents.find(a => a.project_id === newAgentProject && a.workspace_id);
      msg.placement = beside ? 'new_tab' : 'new_workspace';
      if (beside) msg.workspace_id = beside.workspace_id;
      // Joins this conversation when it comes up, and is opened with the role's prompt — the same
      // pair a respawn sets, which is what makes the new pane open on the thread and speak into it.
      startIntent = {conv: convViewId};
      startPrompt = roleStarter(role);
      showSpawnStatus(`Starting ${msg.label || newAgentKind}…`, 'busy');
      ws.send(JSON.stringify(msg));
      closeNewAgent();
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
      if (!key) return;
      let parsed = null;
      try { parsed = JSON.parse(key); } catch (e) {}
      const targetPane = Array.isArray(parsed) && parsed[1] ? parsed[1] : null;
      const live = dockMembers().find(a => {
        if (convMemberKey(a) === key) return true;
        if (targetPane && a.pane_id === targetPane) return true;
        if (Array.isArray(parsed)) {
          const aHost = (a.host === 'local' || !a.host) ? 'local' : a.host;
          const kHost = (parsed[0] === 'local' || !parsed[0]) ? 'local' : parsed[0];
          return aHost === kHost && a.pane_id === parsed[1];
        }
        return false;
      });
      // No target: the author has exited or is folded out of the thread.
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
      // On the conversation it was reached from, the same as every other way out of this view.
      // It used to clear the pane's view instead, which dropped the one thing the reader had
      // chosen: a pane in three conversations then opened on whichever the fallback picked, and a
      // two-member thread arrived as somebody else's five-member one.
      openConvMemberPane(convMemberKey(live));
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
      const ids = id ? [id] : ['chipMenu', 'whoMenu', 'optMenu'];
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
      if (dockPicked.size && dockMembers().length) return convDockSend();
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
      const targets = dockMembers();
      if (!targets.length) { showToast('Nobody in this conversation to send it to.'); return; }
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
        if (optMenuOpen() && !e.target.closest('#optMenu, .xfer-chip.opts')) closeDockMenu('optMenu');
        // The New agent dialog's own list, by the same rule — including a tap on the badge row it
        // covers, which is a choice being made rather than the list being dismissed.
        const projMenu = document.getElementById('newAgentProjMenu');
        if (projMenu && !projMenu.hidden && !e.target.closest('#newAgentProjMenu, .chip-line'))
          projMenu.hidden = true;
      }, true);
      const thread = document.getElementById('convViewThread');
      if (thread) {
        function onBubbleDouble(e) {
          const msg = e.target.closest && e.target.closest('.conv-msg');
          if (!msg || (e.target.closest && e.target.closest('.conv-pick'))) return;
          addressConvAuthor(msg.dataset.key);
        }
        thread.addEventListener('dblclick', onBubbleDouble);

        let lastTap = 0, lastMsg = null;
        thread.addEventListener('touchend', e => {
          const msg = e.target.closest && e.target.closest('.conv-msg');
          if (!msg || (e.target.closest && e.target.closest('.conv-pick'))) return;
          const now = Date.now();
          if (now - lastTap < 350 && lastMsg === msg) {
            e.preventDefault();
            onBubbleDouble(e);
            lastTap = 0;
            lastMsg = null;
          } else {
            lastTap = now;
            lastMsg = msg;
          }
        });
      }
      if (!dock || !window.ResizeObserver) return;
      new ResizeObserver(syncDockHeight).observe(dock);
      syncDockHeight();
    }
