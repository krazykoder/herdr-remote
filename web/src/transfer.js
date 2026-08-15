    // --- Transfer ---

    let transferSource = '';

    // Who is being quoted, and what. Shared by the sheet and by the chips so that a chip and the
    // sheet behind it can never disagree about either — and because `transferSelection` is what
    // doTransfer reads, so anything that reaches it has to come through here.
    //
    // Returns the source pane, or null with the reason already on screen.
    //
    // `needPair` is what separates the two callers. The sheet transfers to *the partner*, so with no
    // healthy pair it has no destination and cannot open. The thread's row picks its own target out
    // of the conversation's members, and a conversation is not a pair — three agents talking with no
    // pair recorded between any two of them is an ordinary thread, and demanding one here would make
    // it unusable for exactly the case the row was added for.
    function claimTransfer(needPair) {
      const picked = convThreadOn() ? Array.from(document.querySelectorAll('#convThread .conv-msg.picked')) : [];
      const keys = new Set(picked.map(el => el.dataset.key));
      if (keys.size > 1) { showToast('Select messages from one agent to transfer.'); return null; }
      const source = keys.size ? agents.find(a => convMemberKey(a) === keys.values().next().value) : paneOf(activePane);
      if (!source) return null;
      const pair = pairFor(pairs, source.pane_id);
      if (needPair !== false && (!pair || pairHealth(pair, agents).state !== 'healthy')) return null;
      // The ruler's range wins when there is one: it is the deliberate selection, and on a phone
      // the native one is usually empty anyway. Capture before anything can steal it — switching
      // panes clears both.
      transferSelection = selText || String(window.getSelection() || '').trim();
      transferSource = source.pane_id;
      return source;
    }

    function openTransfer() {
      const source = claimTransfer();
      if (!source) return;
      const pair = pairFor(pairs, source.pane_id);
      const partner = partnerOf(pair, transferSource);
      const live = agents.find(a => a.pane_id === partner.pane_id);
      document.getElementById('transferTarget').textContent =
        (live ? paneLabel(live) : '') || partner.role || partner.pane_id;
      // The harness badge and the live dot, exactly as the agent list draws them: this sheet
      // prefills a composer in another pane, and a name alone is not enough to be sure which.
      document.getElementById('transferBadge').innerHTML =
        agentBadge((live && live.agent) || partner.agent || '');
      const dot = document.getElementById('transferDot');
      dot.style.background = live ? statusColor(live) : 'var(--muted)';
      dot.classList.toggle('pulse', !!live && live.status === 'working');
      const preview = document.getElementById('transferPreview');
      const box = document.getElementById('transferShortcuts');
      if (!transferSelection) {
        box.innerHTML = '';
        preview.textContent = 'Select some text in the pane first, then tap Transfer.';
        document.getElementById('transferSheet').style.display = 'block';
        return;
      }
      box.innerHTML = SHORTCUTS.map((s, i) =>
        `<button class="nav-key" style="width:100%;justify-content:flex-start" onclick="doTransfer(${i})">${escapeHtml(s.label)}</button>`).join('') +
        `<button class="nav-key" style="width:100%;justify-content:flex-start;color:var(--muted)" onclick="doTransfer(-1)">No instruction</button>`;
      preview.textContent = transferSelection.length > 600
        ? transferSelection.slice(0, 600) + '\n…'
        : transferSelection;
      document.getElementById('transferSheet').style.display = 'block';
    }

    function closeTransfer() {
      transferSource = '';
      document.getElementById('transferSheet').style.display = 'none';
    }

    // Prefill and stop. This is the last checkpoint before one agent's output enters another's
    // context, so it must never end in a send. The sheet's path, and the pane view's.
    function doTransfer(shortcutIndex) {
      const source = paneOf(transferSource || activePane);
      const pair = source && pairFor(pairs, source.pane_id);
      if (!pair || pairHealth(pair, agents).state !== 'healthy') {
        document.getElementById('transferPreview').textContent = 'Pair is no longer live; reopen it after choosing a live partner.';
        return;
      }
      const partner = partnerOf(pair, source.pane_id);
      return prefillTransfer(source, partner.pane_id,
        transferInstruction(shortcutIndex >= 0 ? [shortcutIndex] : [], partner.pane_id),
        err => { document.getElementById('transferPreview').textContent = err; });
    }

    // The instructions, in the order they were chosen, each rewritten for the agent about to read
    // them. The order is the user's sentence: "@review @test" is review then test, and sorting it
    // back into the shortcut list's order would be the app rewriting what they said.
    function transferInstruction(picks, targetPaneId) {
      return picks.map(i => agentSlash(SHORTCUTS[i].text, agentOf(targetPaneId))).join('\n');
    }

    // Everything both paths share, and the only place that writes the composer. `onError` is how
    // the two differ: the sheet has a preview to put the reason in, a chip has a toast.
    function prefillTransfer(source, targetPaneId, instruction, onError) {
      const pair = pairFor(pairs, source.pane_id);
      const mine = pair ? memberOf(pair, source.pane_id) : null;
      // The role when the pair sheet was given one, the pane's live label when it was not. A pair
      // built by the Start dialog carries a bare fingerprint with no role at all
      // (recentFingerprint), and the receiving agent was being told the text came from "undefined".
      const from = (mine && mine.role) || paneLabel(source) || source.pane_id;
      const out = composeTransfer(instruction, from, transferSelection);
      if (out.error) { onError(out.error); return; }
      // What the next send will be measured against. Captured here because this is the last moment
      // the source pane is the open one — openTerminal below moves to the target — and because the
      // sheet's path prefills and stops, so the send that classifies against it has not happened.
      pendingTransfer = {
        key: convMemberKey(source), label: paneLabel(source) || from,
        body: transferSelection, payload: out.text,
        hash: convHash(transferSelection), at: Date.now(),
      };
      // Before openTerminal moves activePane to the target: the range being transferred belongs to
      // this pane, and this is the point at which the user has committed to it.
      learnFromSelection();
      closeTransfer();
      openTerminal(targetPaneId);
      const input = document.getElementById('termInput');
      input.value = out.text;
      autoGrow(input);
      input.focus();
      // Show the top of the payload, not its tail — reading it is the checkpoint.
      input.setSelectionRange(0, 0);
      input.scrollTop = 0;
      if (window.cue) cue('page');
      return true;
    }

    // --- The thread's own transfer row ---

    // Who it goes to, and what is added to it. Both live only as long as a selection does: the next
    // pick may be a different agent's message, and an instruction left armed across that would be
    // attached to something nobody chose it for.
    let transferTarget = '', transferPicks = [];

    // Every other member of this conversation that is a live pane. Not "the pair partner": a
    // conversation of three is a conversation of three, and the pair is only what the default is
    // read from. The source is excluded — a message cannot be transferred to the pane that said it.
    function transferTargets(source) {
      const conv = source && convViewConv(source);
      if (!conv) return [];
      const keys = new Set(pairedConvMembers(source, conv).map(m => m.key));
      return agents.filter(a => a.pane_id !== source.pane_id && keys.has(convMemberKey(a)));
    }

    // The pair partner when there is one, and otherwise the first other member. A default and not a
    // rule: the row is there so it can be overridden, and a conversation with no pair still has an
    // obvious answer when it has exactly one other member.
    function defaultTarget(source, list) {
      const pair = pairFor(pairs, source.pane_id);
      const partner = pair && pairHealth(pair, agents).state === 'healthy'
        ? partnerOf(pair, source.pane_id) : null;
      const paired = partner && list.find(a => a.pane_id === partner.pane_id);
      return (paired || list[0] || {}).pane_id || '';
    }

    // Kept honest against the row it is drawn from: a target that has gone away since the last pick
    // is replaced by the default rather than silently sending somewhere else.
    function transferTargetOf(source, list) {
      return list.some(a => a.pane_id === transferTarget) ? transferTarget : defaultTarget(source, list);
    }

    function setTransferTarget(paneId) {
      transferTarget = paneId;
      drawConvSel();
      if (window.cue) cue('tick');
    }

    // Additive. Two chips are two instructions, in the order they were tapped, and tapping one
    // again takes it back out — so the row is the sentence being built rather than a menu of
    // mutually exclusive ones.
    function toggleTransferChip(i) {
      const at = transferPicks.indexOf(i);
      if (at >= 0) transferPicks.splice(at, 1); else transferPicks.push(i);
      drawConvSel();
      // The list is the same picks drawn twice, so a tap in either place has to reach both. Left
      // open, it would keep showing the ticks it had when it opened.
      if (chipMenuOpen()) openChipMenu();
      if (window.cue) cue('tick');
    }

    function clearTransferRow() {
      transferPicks = [];
      transferTarget = '';
      closeChipMenu();
    }

    function transferRowHtml(source) {
      const list = transferTargets(source);
      if (!list.length) return '';
      const target = transferTargetOf(source, list);
      // One live, the rest dimmed rather than hidden: which agents are in this conversation is
      // information, and a row that showed only the chosen one would answer a different question.
      const who = list.map(a =>
        `<button class="xfer-who${a.pane_id === target ? ' on' : ''}" ` +
        `onclick="setTransferTarget('${a.pane_id}')" aria-pressed="${a.pane_id === target}" ` +
        `title="Send to ${escapeHtml(paneLabel(a))}" aria-label="Send to ${escapeHtml(paneLabel(a))}">` +
        `<span class="dot" style="background:${statusColor(a)}" aria-hidden="true"></span>` +
        `${escapeHtml(paneLabel(a))}</button>`).join('');
      // Numbered by the order they were chosen, because that order is what will be written and two
      // lit chips otherwise say nothing about which comes first.
      const chips = SHORTCUTS.map((s, i) => {
        const at = transferPicks.indexOf(i);
        return `<button class="xfer-chip${at >= 0 ? ' on' : ''}" onclick="toggleTransferChip(${i})" ` +
          `aria-pressed="${at >= 0}" title="${escapeHtml(s.label)}" ` +
          `aria-label="Add the instruction ${escapeHtml(s.label)}">` +
          `@${escapeHtml(s.at)}${at >= 0 && transferPicks.length > 1 ? `<sub>${at + 1}</sub>` : ''}` +
          `</button>`;
      }).join('');
      const n = transferPicks.length;
      // Only the chips scroll. @+ and Send are pinned, because a row of instructions long enough to
      // push the send button off a phone would hide the one control the row is for — and @+ is the
      // way back to the instructions that scrolled away, so it cannot scroll away itself.
      return `<div class="xfer-who-row">${who}</div>` +
        `<div class="xfer-act"><div class="xfer-chip-row">${chips}</div>` +
        `<button class="xfer-chip more" onclick="openChipMenu()" ` +
        `title="Every instruction, as a list" aria-label="Every instruction, as a list">@+</button>` +
        `<button class="xfer-send" onclick="transferNow()" ` +
        `title="Send the picked messages to ${escapeHtml(paneLabel(paneOf(target)) || target)}" ` +
        `aria-label="Send the picked messages">` +
        `Send${n ? ` (${n})` : ''} ›</button></div>`;
    }

    // The same instructions as a list, for a row that has scrolled past the edge of a phone and for
    // reading the full label rather than its @name. It writes the same picks the chips do.
    function openChipMenu() {
      const box = document.getElementById('chipMenu');
      box.innerHTML = SHORTCUTS.map((s, i) =>
        `<button class="menu-item" role="menuitemcheckbox" ` +
        `aria-checked="${transferPicks.includes(i)}" onclick="toggleTransferChip(${i})">` +
        `<span class="tick">${transferPicks.includes(i) ? '✓' : ''}</span>` +
        `@${escapeHtml(s.at)} — ${escapeHtml(s.label)}</button>`).join('') +
        `<button class="menu-item" role="menuitem" onclick="closeChipMenu()">Done</button>`;
      box.hidden = false;
    }

    function chipMenuOpen() {
      const box = document.getElementById('chipMenu');
      return !!box && !box.hidden;
    }

    function closeChipMenu() {
      const box = document.getElementById('chipMenu');
      if (box) box.hidden = true;
    }

    // The bypass, and the whole of it. `doTransfer` above still prefills and stops — the rule it
    // carries is intact and is what the pane view still gets — and this is the one function in the
    // app that follows it with a send.
    //
    // Scoped to the thread because the two views are not the same act. In the pane view the
    // payload is a *selection*: a guess at where a message starts and ends, which is why the ruler
    // exists and why the prefilled composer is where you find out you took the prompt as well as
    // the answer. In the thread the payload is a bubble, which *is* the message — there is no
    // boundary to get wrong, and the checkpoint would be re-reading something just read.
    //
    // Not armed like CLS and Esc. Those fire on one tap of a button that sits under the thumb; this
    // one needs a message picked and a target standing, and the pick is the deliberate act the arm
    // would be duplicating. The toast names where it went, because a mis-tap is otherwise silent.
    function transferNow() {
      if (!convThreadOn()) return;
      const source = claimTransfer(false);
      if (!source) return;
      if (!transferSelection) { showToast('Pick a message first.'); return; }
      const list = transferTargets(source);
      const target = transferTargetOf(source, list);
      const live = agents.find(a => a.pane_id === target);
      if (!live) { showToast('That agent is no longer running.'); return; }
      // Captured before the prefill: it moves the open pane to the target, and the selection this
      // reports on belonged to the pane being left.
      const picked = document.getElementById('selCount').textContent;
      // Opening the target starts a *loud* catch-up if its record went stale, and that toast would
      // land on top of this send's. The trigger is loud because someone tapped a pane to read it;
      // nobody tapped this one, and the confirmation of an irreversible send outranks a report on a
      // read they did not ask for.
      convQuietPane = target;
      const ok = prefillTransfer(source, target,
        transferInstruction(transferPicks, target), showToast);
      if (!ok) { convQuietPane = ''; return; }
      sendText();
      clearTransferRow();
      closeChipMenu();
      clearSel();
      showToast(`Sent ${picked} to ${paneLabel(live) || target}`);
    }

    function insertShortcut(i) {
      const input = document.getElementById('termInput');
      const text = agentSlash(SHORTCUTS[i].text, agentOf(activePane));
      const at = input.selectionStart ?? input.value.length;
      input.value = input.value.slice(0, at) + text + input.value.slice(input.selectionEnd ?? at);
      input.selectionStart = input.selectionEnd = at + text.length;
      autoGrow(input);
      // Close the sheet: the text is in the composer now and the user needs to see it.
      closePalette();
      input.focus();
    }
