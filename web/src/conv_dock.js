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
      return (conv.members || []).filter(m => !hidden.has(m.key))
        .map(m => agents.find(a => convMemberKey(a) === m.key)).filter(Boolean);
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

    // With a bubble picked the source is excluded — a message cannot be transferred to the pane that
    // said it. Otherwise everyone is a candidate: the composer is addressing the conversation, and
    // any member of it is someone you might be talking to.
    function dockTargets() {
      const source = dockSource();
      const all = dockMembers();
      return source ? all.filter(a => a.pane_id !== source.pane_id) : all;
    }

    // Kept honest against the row it is drawn from: a target that has exited, or that turns out to
    // be the source of what is being transferred, falls back to the first member rather than
    // silently sending somewhere else.
    function dockTargetOf(list) {
      return list.some(a => a.pane_id === dockTarget) ? dockTarget : ((list[0] || {}).pane_id || '');
    }

    // Who the composer is talking to: the row's lit member. Falls back to the whole membership when
    // a pick has excluded everyone, so that typing still has somewhere to go — the same list the row
    // draws in that case.
    function dockAddressed() {
      const list = dockTargets();
      return dockTargetOf(list.length ? list : dockMembers());
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
      if (dockFill()) return insertDockShortcut(i);
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
      const list = dockTargets();
      // Every candidate excluded — a bubble picked in a conversation of one — leaves the row still
      // addressing the conversation, with nothing to transfer the pick to. Dropping it instead would
      // take the composer's target away over a pick that is about to be undone.
      const html = all.length ? dockRowHtml(list.length ? list : all, !list.length) : '';
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

    function dockRowHtml(list, noSend) {
      const target = dockTargetOf(list);
      // One lit, the rest dimmed rather than hidden: which agents are in this conversation is
      // information, and a row that showed only the chosen one would answer a different question.
      // Named the way the pane header names one: the live dot, the label, and the harness badge.
      // Which agent is about to receive another agent's output is the fact worth being sure of, and
      // "scratch" alone does not say whether that is a codex or a claude.
      const who = list.map(a =>
        `<button class="xfer-who${a.pane_id === target ? ' on' : ''}" ` +
        `style="--who-accent:${agentColor(a.agent) || 'var(--text)'}" ` +
        `onclick="setDockTarget('${a.pane_id}')" aria-pressed="${a.pane_id === target}" ` +
        `title="Talk to ${escapeHtml(paneLabel(a))}" aria-label="Talk to ${escapeHtml(paneLabel(a))}">` +
        `<span class="dot" style="background:${statusColor(a)}" aria-hidden="true"></span>` +
        `${escapeHtml(paneLabel(a))}${agentBadge(a.agent)}</button>`).join('');
      // Numbered by the order they were chosen, because that order is what will be written and two
      // lit chips otherwise say nothing about which comes first. In fill mode nothing is lit at
      // all: the instruction is in the box where it can be read, so a second place saying it is on
      // would be saying it twice.
      const fill = dockFill();
      const chips = SHORTCUTS.map((s, i) => {
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
      // Only the chips scroll. @+ and Send are pinned, because a row of instructions long enough to
      // push the send button off a phone would hide the one control the row is for — and @+ is the
      // way back to the instructions that scrolled away, so it cannot scroll away itself.
      return `<div class="xfer-who-row">${who}</div>` +
        `<div class="xfer-act"><div class="xfer-chip-row">${chips}</div>` +
        `<button class="xfer-chip more" onclick="toggleDockMenu()" ` +
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

    // `@+` is the menu's own toggle: a second tap on the control that opened it closes it, which
    // is also what keeps it out of the tap-outside-to-close rule below.
    function toggleDockMenu() {
      if (dockMenuOpen()) closeDockMenu(); else openDockMenu();
    }

    function dockMenuOpen() {
      const box = document.getElementById('chipMenu');
      return !!box && !box.hidden;
    }

    function closeDockMenu() {
      const box = document.getElementById('chipMenu');
      if (box && !box.hidden) { box.hidden = true; syncDockHeight(); }
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
      const target = dockTargetOf(targets);
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
      // A menu opened by mistake closes by tapping past it, the way every other menu on a phone
      // does. One listener for the life of the page rather than one per open, so nothing has to be
      // taken back off again. `@+` itself is excluded: it is the menu's own toggle.
      // Capture, because a chip's own handler rebuilds the list it was tapped in: by the time a
      // bubbled click reached here the target would be detached from the document and `closest`
      // would say it came from nowhere, closing the menu on its own taps.
      document.addEventListener('click', e => {
        if (!dockMenuOpen()) return;
        if (e.target.closest && e.target.closest('#chipMenu, .xfer-chip')) return;
        closeDockMenu();
      }, true);
      if (!dock || !window.ResizeObserver) return;
      new ResizeObserver(syncDockHeight).observe(dock);
      syncDockHeight();
    }
