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
    let dockTarget = '', dockPicks = [], dockPicked = new Set();

    // A picked bubble is written into the composer as a token — `[#1 the first words of it…]` —
    // and the token is the pick. It sits in the text with everything else being written, so the
    // caret goes after it, a note can follow it on the same line, and it is deleted by deleting it.
    // Nothing mirrors the pick anywhere else: the box is the message, and what the box says is
    // what goes out.
    //
    // Keyed by a number that only ever climbs, never by position: the reader can move a token,
    // delete an earlier one or type between two, and the token still has to name the same bubble.
    // The quoted text is kept here rather than read back off the thread, so a bubble that has
    // scrolled out of the window — or out of the record — still sends what it said when it was
    // picked.
    let dockTokens = new Map(), dockTokenSeq = 0;
    const DOCK_TOKEN = /\[#(\d+)[^\]\n]*\]/g;
    const convComposerDrafts = new Map();
    const convComposerTargets = new Map();
    // What the draft's tokens stand for. The text alone would restore as `[#4 …]` with nothing
    // behind it, so the quotes travel with the draft they are written into.
    const convComposerTokens = new Map();

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
      const quoted = dockQuoted();
      if (!quoted.length) return null;
      const keys = new Set(quoted.map(q => q.key));
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

    // The row reorders around whoever is addressed, so the chip under the pointer for the second
    // half of a double-click is no longer the one the first half hit. Which is a defect on its own
    // — a reader tapping twice to be sure lands on a stranger — and it is what the solo gesture is
    // read against: the pane the gesture is about is the one the *first* click named, recorded
    // here, and a second click inside the double window extends that gesture rather than starting
    // a new one.
    let dockLastPick = {pane: '', at: 0};
    const DOCK_DOUBLE_MS = 500;

    function setDockTarget(paneId) {
      const now = Date.now();
      if (now - dockLastPick.at > DOCK_DOUBLE_MS) dockLastPick = {pane: paneId, at: now};
      else dockLastPick.at = now;
      dockTarget = paneId;
      if (convViewId) {
        if (paneId) convComposerTargets.set(convViewId, paneId);
        else convComposerTargets.delete(convViewId);
      }
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

    // The list's copy of the row's double-click. `toggleConvSolo` redraws the thread, the roster
    // and this row; the list is the one thing that redraw does not reach, so it is reopened here
    // for the same reason every other switch in it is.
    function toggleDockSolo() {
      toggleConvSolo();
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
      // Only where there is more than one member to be alone among. Same switch the chips' own
      // double-click throws, listed here because it is a standing preference about this thread and
      // a gesture nobody has been told about is not a feature.
      if (convSoloKey(convViewId) || dockMembers().length > 1) {
        opts.push(['Solo mode', !!convSoloKey(convViewId), 'toggleDockSolo()',
          'Read only the agent this box is talking to, and hide the rest of the conversation']);
      }
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

    // Written in at the caret, always as its own line. Where the caret is is where the writer is
    // working, and a prompt tapped mid-message belongs there rather than at an end they are not
    // looking at — but it is a new instruction and never an edit to the sentence holding the
    // caret, so it never splices into one.
    //
    // With nothing written it goes on top instead, above the picked messages. Tokens are not
    // writing — they are what the instruction is about — so a box holding only tokens is an empty
    // box with a quote in it, and an instruction about a quote is read before it, not after.
    function insertDockShortcut(i) {
      const input = document.getElementById('convInput');
      const text = agentSlash(SHORTCUTS[i].text, agentOf(dockAddressed()));
      const written = input.value.replace(DOCK_TOKEN, '').trim();
      const at = !written ? 0
        : input.selectionStart == null ? input.value.length : input.selectionStart;
      const before = input.value.slice(0, at), after = input.value.slice(at);
      const block = (before && !before.endsWith('\n') ? '\n' : '') + text +
        (after && !after.startsWith('\n') ? '\n' : '');
      input.value = before + block + after;
      // After what was written, so the next thing typed follows the instruction rather than
      // landing in front of it — and when the instruction went on top of the quotes, at the end of
      // them, because that is where the message carries on rather than between the two.
      input.selectionStart = input.selectionEnd = written ? (before + block).length : input.value.length;
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

    // Every attached instruction at once, from the one line that draws them all as one sentence.
    function clearDockChips() {
      if (!dockPicks.length) return;
      dockPicks = [];
      renderConvDock();
      if (dockMenuOpen()) openDockMenu();
      if (window.cue) cue('tick');
    }

    // The attached instruction is the one part of the load that is not in the box, so it is the one
    // part backspace cannot reach on its own: with the caret at the very start of the text, a
    // backspace takes it. Tokens need nothing here — they are text, and backspace already deletes
    // text.
    function dropLastDockLoad() {
      if (dockFill() || !dockPicks.length) return false;
      dockPicks.pop();
      renderConvDock();
      if (dockMenuOpen()) openDockMenu();
      return true;
    }

    // What a token says on the face of it: enough of the message to know which one it is, on one
    // line, with the brackets it lives inside taken out of the text so it cannot be split in two.
    function dockTokenText(seq, text) {
      const flat = String(text).replace(/\s+/g, ' ').replace(/[\[\]]/g, '').trim();
      return `[#${seq} ${flat.length > 40 ? flat.slice(0, 40) + '…' : flat}]`;
    }

    // Written in at the caret, on its own line, with the caret left after it — the sketch is
    // `[#1 …] - what I want done with it`, so the note the reader is about to type follows the
    // token rather than being pushed onto another line by the app.
    function toggleConvDockPick(i) {
      const el = document.querySelector(`#convViewThread .conv-msg[data-i="${i}"]`);
      const thread = document.getElementById('convViewThread');
      const wasAt = thread ? thread.scrollTop : 0;
      const input = document.getElementById('convInput');
      if (!el || !input) return;
      const text = el.dataset.text || '';
      if (!text) return;
      // Tapped again, a bubble takes its token back out of the box, wherever the reader moved it to.
      const had = Array.from(dockTokens).find(([, q]) => q.text === text);
      if (had) {
        dockTokens.delete(had[0]);
        input.value = input.value.replace(
          new RegExp(`[ \\t]*\\[#${had[0]}[^\\]\\n]*\\][ \\t]*\\n?`), '');
      } else {
        const seq = ++dockTokenSeq;
        dockTokens.set(seq, {text, key: el.dataset.key || ''});
        const at = input.selectionStart == null ? input.value.length : input.selectionStart;
        const before = input.value.slice(0, at), after = input.value.slice(at);
        const token = (before && !before.endsWith('\n') ? '\n' : '') + dockTokenText(seq, text);
        input.value = before + token + after;
        input.selectionStart = input.selectionEnd = (before + token).length;
      }
      autoGrow(input);
      syncConvCursor();
      syncDockTokens();
      // The box takes the caret, because a note is what usually follows a pick — but `preventScroll`,
      // or the browser brings the composer into view and the reader loses the place they were
      // reading. The thread is put back where it was as well: `autoGrow` changes the composer's
      // height, and a taller composer moves the thread under a scrollTop that no longer means the
      // same line.
      input.focus({preventScroll: true});
      if (thread) thread.scrollTop = wasAt;
    }

    // The box is the record of what is picked, so this reads it rather than being told: every token
    // still standing is a pick, in the order it sits in the text, and a token that was edited past
    // recognition or deleted is a pick that is gone. Called from the field's own `input`, so
    // deleting a token by hand is the same act as tapping its bubble again.
    function syncDockTokens() {
      const input = document.getElementById('convInput');
      const live = new Set();
      if (input) for (const m of input.value.matchAll(DOCK_TOKEN)) live.add(Number(m[1]));
      let lost = false;
      for (const seq of dockTokens.keys()) if (!live.has(seq)) { dockTokens.delete(seq); lost = true; }
      const was = dockPicked;
      dockPicked = new Set(Array.from(dockTokens.values(), q => q.text));
      if (lost || was.size !== dockPicked.size) { drawDockPicks(); renderConvDock(); }
    }

    // What the send is quoting, in the order the box holds it. Thread order was the rule while the
    // picks lived on the bubbles; now the reader can move a token, so the text is the order.
    function dockQuoted() {
      const input = document.getElementById('convInput');
      if (!input) return [];
      return Array.from(input.value.matchAll(DOCK_TOKEN))
        .map(m => dockTokens.get(Number(m[1]))).filter(Boolean);
    }

    // Painted in place rather than by re-rendering the thread: the snapshot redraws this view every
    // three seconds and a rebuild would take the reader's text selection with it mid-copy.
    //
    // Matched on what the bubble says rather than on its index: the thread is rebuilt from the
    // record on every snapshot, and an index is only true until a row lands above the one it names.
    function drawDockPicks() {
      for (const el of document.querySelectorAll('#convViewThread .conv-msg')) {
        const on = !!el.dataset.text && dockPicked.has(el.dataset.text);
        el.classList.toggle('picked', on);
        const tick = el.querySelector('.conv-pick');
        if (tick) tick.setAttribute('aria-pressed', String(on));
      }
    }

    // The thread was redrawn. The picks live in the box and are unaffected; the highlight is on the
    // new rows, and it is painted here rather than in the render so the two cannot disagree.
    function syncDockPicks() {
      drawDockPicks();
    }

    function clearDockPicks() {
      if (!dockTokens.size) return;
      const input = document.getElementById('convInput');
      dockTokens.clear();
      if (input) {
        input.value = input.value.replace(DOCK_TOKEN, '').replace(/[ \t]+\n/g, '\n').trim();
        autoGrow(input);
        syncConvCursor();
      }
      syncDockTokens();
    }

    // Leaving the conversation. Who you were talking to and what you were about to say belong to
    // it, and neither means anything in the next one — so the picks go, and the half-written
    // message goes with the conversation it was being written to rather than into the next one's
    // box.
    function clearConvDock() {
      dockTarget = ''; dockPicks = []; dockPicked.clear(); dockTokens.clear();
      closeDockMenu();
      const input = document.getElementById('convInput');
      if (input) { input.value = ''; autoGrow(input); syncConvCursor(); }
    }

    // Half-written messages and selected targets, one per conversation, for as long as the page is
    // open. Switching tabs to read what somebody else said is part of writing a reply, and losing
    // the reply or the chosen agent made the strip something to avoid mid-sentence. Deliberately
    // in memory and not in storage: a draft is a thing in flight, and a reload is a session ending.
    //
    // Called before convViewId moves, so the box's contents are filed under the conversation they
    // were written to. Only the draft: the addressed agent is written by setDockTarget, at the
    // moment it is chosen and under the conversation that was open then. Filing it here as well
    // would file whatever dockTarget happens to hold under whatever convViewId happens to be, and
    // convViewId is reassigned without a stash in at least two places.
    function stashConvDraft() {
      const input = document.getElementById('convInput');
      if (!input || !convViewId) return;
      if (input.value.trim()) {
        convComposerDrafts.set(convViewId, input.value);
        convComposerTokens.set(convViewId, Array.from(dockTokens));
      } else {
        convComposerDrafts.delete(convViewId);
        convComposerTokens.delete(convViewId);
      }
    }

    // Called by saveConvIndex with the conversations that survived the write. Anything else held
    // here is addressed to a conversation that no longer exists, and a recycled id would otherwise
    // hand a stranger's draft to whoever creates the next one.
    function forgetConvComposers(kept) {
      const live = new Set((kept || []).map(c => c.id));
      for (const id of convComposerDrafts.keys()) if (!live.has(id)) convComposerDrafts.delete(id);
      for (const id of convComposerTargets.keys()) if (!live.has(id)) convComposerTargets.delete(id);
      for (const id of convComposerTokens.keys()) if (!live.has(id)) convComposerTokens.delete(id);
    }

    function restoreConvDraft() {
      const input = document.getElementById('convInput');
      const text = convViewId ? convComposerDrafts.get(convViewId) : '';
      if (input && text) {
        input.value = text;
        dockTokens = new Map(convViewId ? convComposerTokens.get(convViewId) || [] : []);
        autoGrow(input);
        syncConvCursor();
        syncDockTokens();
      }
      dockTarget = (convViewId && convComposerTargets.get(convViewId)) || '';
    }

    // The one part of the payload that is not in the box: an instruction riding on the send rather
    // than written into it. A lit chip says a thing is armed; it does not say what the agent will
    // receive, so the words it expands to are shown above the box that the rest of the message is
    // written in — with the way out at the start of the line, where it is the same control every
    // time rather than one that moves with the length of the text beside it.
    //
    // Only in attach mode. Filling writes the instruction into the box already, and a strip
    // repeating what is on screen an inch below is the app telling the reader something twice.
    // Picked messages are never here either: they are tokens in the box, which is the whole point
    // of them being tokens.
    function dockLoadHtml() {
      const lead = dockFill() ? '' : dockInstruction(dockAddressed());
      if (!lead) return '';
      return `<div class="xfer-load-line at" title="${escapeHtml(lead)}">` +
        `<button class="xfer-load-drop" onclick="clearDockChips()" ` +
        `title="Leave this out" aria-label="Leave the instruction out">×</button>` +
        `<span class="xfer-load-tag">@</span>` +
        `<span class="xfer-load-text">${escapeHtml(lead.replace(/\s*\n\s*/g, ' · '))}</span></div>`;
    }

    function renderConvDock() {
      const dock = document.getElementById('convDock');
      const row = document.getElementById('xferRow');
      if (!dock || !row) return;
      const load = document.getElementById('xferLoad');
      if (load) {
        const html = dockLoadHtml();
        if (load.dataset.sig !== html) { load.innerHTML = html; load.dataset.sig = html; }
        load.hidden = !html;
      }
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

    // The composer grows upward under the thread. Keep its newest bubble in view while writing —
    // but only for a reader who was already at the newest. Focusing the box is not on its own a
    // request to leave where you were reading: picking a bubble halfway up a long thread focuses
    // the composer so a note can follow the token, and this used to answer that by scrolling the
    // thread out from under the reader. Same 24px rule the render's own `stick` uses.
    function stickConvLatest() {
      const box = document.getElementById('convViewThread');
      if (!box || !box.offsetParent) return;
      if (box.scrollTop + box.clientHeight < box.scrollHeight - 24) return;
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
          `data-pane="${escapeHtml(a.pane_id)}" ` +
          `onclick="setDockTarget('${a.pane_id}')" ` +
          `aria-pressed="${a.pane_id === target}" ` +
          `title="Talk to ${name}. Double-click to read only ${name}" ` +
          `aria-label="Talk to ${name}">` +
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
      const n = dockTokens.size;
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
      // Double rather than single, and for the same reason a bubble's is: a single tap here already
      // means "talk to this one", and reading only this one is a second thing to want from the same
      // chip. On the row and not on each chip: the row is redrawn between the two clicks, so the
      // element the browser hands the second one is not the chip the gesture began on.
      return `<div class="xfer-act"><div class="xfer-who-row" ondblclick="soloDockTarget(event)">` +
        `${who}</div>` +
        // The same icon a pane wears in its header and on its card, so what the list holds is said
        // by the button that opens it rather than by a caret that could open anything.
        `<button class="xfer-who-more list" onclick="toggleWhoMenu()" ` +
        `aria-expanded="${whoMenuOpen()}" ` +
        `title="Every agent, as a list" aria-label="Every agent, as a list">` +
        `${(paneOf(target) || {}).agent ? agentGlyph() : '⬛'}</button>` +
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

    // Read only this one. A second double-click is the way back out — the row cannot offer another,
    // because in solo it holds one chip.
    //
    // The pane comes from the first click of the gesture and not from the event's target: by the
    // time this fires the row has reordered twice under the pointer. Restoring the target undoes
    // what the stray second click addressed.
    function soloDockTarget(e) {
      if (e && e.preventDefault) e.preventDefault();
      const paneId = dockLastPick.pane;
      const live = agents.find(a => a.pane_id === paneId);
      if (!live) return;
      dockTarget = paneId;
      // The word the double-click selected is not a selection anybody asked for.
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.removeAllRanges) sel.removeAllRanges();
      const key = convMemberKey(live);
      const on = convSoloKey(convViewId) === key;
      convSetSolo(convViewId, on ? '' : key);
      showToast(on ? 'Showing every member' : `Reading only ${paneLabel(live) || live.pane_id}`);
      if (window.cue) cue('tick');
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
      // The key first. Failing that, the same key with the local host spelled the one way — a live
      // row is keyed under whichever spelling its record carried (see `convLiveKey`), and the two
      // must land on the same member. The host is part of that comparison and never dropped from
      // it: pane ids are unique per host and collide across them, so matching on a bare pane id
      // would address a stranger on another machine.
      const live = dockMembers().find(a => {
        if (convMemberKey(a) === key) return true;
        if (!Array.isArray(parsed)) return false;
        const norm = h => (!h || h === 'local') ? 'local' : h;
        return norm(a.host) === norm(parsed[0]) && a.pane_id === parsed[1];
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
      if (dockTokens.size && dockMembers().length) return convDockSend();
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
      const bare = e.key === 'Backspace' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey
        && e.target.selectionStart === e.target.selectionEnd;
      // A token is one thing, so it deletes as one: a backspace with the caret just past its
      // closing bracket takes the whole token rather than shortening the quote to `[#1 the other…`
      // — text that still reads like a pick and no longer is one.
      const at = e.target.selectionStart;
      const eats = bare && /\[#\d+[^\]\n]*\]$/.exec(e.target.value.slice(0, at));
      if (eats) {
        e.preventDefault();
        e.target.value = e.target.value.slice(0, at - eats[0].length) + e.target.value.slice(at);
        e.target.selectionStart = e.target.selectionEnd = at - eats[0].length;
        autoGrow(e.target);
        syncConvCursor();
        syncDockTokens();
        return;
      }
      // Held down, a backspace that ran off the end of the text would eat the whole load in a
      // second. One per press, and only with nothing selected — a selection is text to delete.
      if (bare && at === 0 && dropLastDockLoad()) {
        e.preventDefault();
        return;
      }
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
      const picked = dockQuoted().map(q => q.text);
      if (!picked.length) return;
      const targets = dockMembers();
      if (!targets.length) { showToast('Nobody in this conversation to send it to.'); return; }
      const target = dockTargetOf(targets, source);
      const live = agents.find(a => a.pane_id === target);
      if (!live) { showToast('That agent is no longer running.'); return; }
      const quoted = picked.join('\n\n');
      // The box is sent as written, with each token standing up into the message it names. So a
      // note typed after a token goes out after that message and a note before it goes out before
      // it: the order the reader arranged is the order the agent reads, which is what putting the
      // quotes in the text was for.
      //
      // An @ prompt filled into the box is the exception, because it is an instruction rather than
      // a note: it is peeled off the front and joins the attached ones above the quote.
      const input = document.getElementById('convInput');
      const from = paneLabel(source) || source.pane_id;
      const [filled, kept] = peelDockLead(input.value, agentOf(target));
      const lead = [dockInstruction(target), filled].filter(Boolean).join('\n');
      // Who said it goes immediately above what they said, once per token, rather than once at the
      // top of the message. The header is a label on a quote, and with the reader's own notes
      // between the quotes a single one at the top would be labelling their sentences too — and
      // would sit above the instruction that frames the whole send.
      const body = kept.replace(DOCK_TOKEN, (m, seq) => {
        const q = dockTokens.get(Number(seq));
        return q ? `feedback from ${from}:\n${q.text}` : m;
      });
      const out = {text: (lead ? lead + '\n\n' : '') + body};
      // What the send is measured against, so the target's transcript records where the text came
      // from rather than claiming the reader typed another agent's words.
      //
      // Matched on one quoted message rather than on all of them joined: the reader can put their
      // own words between two tokens, so there is no one string holding both.
      //
      // A payload that matches what went out is a clean transfer; anything else is `mixed`. So the
      // whole payload is offered only when the box held nothing but tokens — with a note of the
      // reader's own in it, the send is theirs as much as the quoted agent's, and the quote alone
      // is what the record can honestly attribute.
      const bare = !kept.replace(DOCK_TOKEN, '').trim();
      pendingTransfer = {
        key: convMemberKey(source), label: from,
        body: picked[0], payload: bare ? out.text : quoted, hash: convHash(quoted), at: Date.now(),
      };
      if (!sendTextTo(target, out.text)) return;
      noteDockUse('who', convMemberKey(live));
      input.value = ''; autoGrow(input); syncConvCursor();
      dockPicks = [];
      dockPicked.clear();
      dockTokens.clear();
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
      // The member chips need the same, and for the same reason: a phone browser fires `dblclick`
      // only when it decides two taps were a double-click, and on a control it has already treated
      // as a tap-to-address it mostly does not. So the gesture is read here — on the row, which
      // survives the redraw between the two taps, and by pane id, because the chip element does
      // not.
      const row = document.getElementById('xferRow');
      if (row) {
        let whoTap = 0, whoPane = '';
        row.addEventListener('touchend', e => {
          const who = e.target.closest && e.target.closest('.xfer-who');
          if (!who) return;
          const now = Date.now();
          if (now - whoTap < 350 && whoPane === who.dataset.pane) {
            // Before the browser's own click, which would address the chip a second time and, in
            // solo, address whichever chip the redraw put under the finger.
            e.preventDefault();
            // Named from the gesture rather than from the tap-to-address that normally records it:
            // a fast double tap can land before the first tap's click has been dispatched at all.
            dockLastPick = {pane: whoPane, at: now};
            soloDockTarget(e);
            whoTap = 0;
            whoPane = '';
          } else {
            whoTap = now;
            whoPane = who.dataset.pane || '';
          }
        });
      }
      if (!dock || !window.ResizeObserver) return;
      new ResizeObserver(syncDockHeight).observe(dock);
      syncDockHeight();
    }
