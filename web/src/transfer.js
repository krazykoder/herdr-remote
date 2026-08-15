    // --- Transfer ---

    let transferSource = '';

    // Who is being quoted, and what. Shared by the sheet and by the chips so that a chip and the
    // sheet behind it can never disagree about either — and because `transferSelection` is what
    // doTransfer reads, so anything that reaches it has to come through here.
    //
    // Returns the source pane, or null with the reason already on screen.
    function claimTransfer() {
      const picked = convThreadOn() ? Array.from(document.querySelectorAll('#convThread .conv-msg.picked')) : [];
      const keys = new Set(picked.map(el => el.dataset.key));
      if (keys.size > 1) { showToast('Select messages from one agent to transfer.'); return null; }
      const source = keys.size ? agents.find(a => convMemberKey(a) === keys.values().next().value) : paneOf(activePane);
      const pair = source && pairFor(pairs, source.pane_id);
      if (!pair || pairHealth(pair, agents).state !== 'healthy') return null;
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
    // context, so it must never end in a send.
    function doTransfer(shortcutIndex) {
      const source = paneOf(transferSource || activePane);
      const pair = source && pairFor(pairs, source.pane_id);
      if (!pair || pairHealth(pair, agents).state !== 'healthy') {
        document.getElementById('transferPreview').textContent = 'Pair is no longer live; reopen it after choosing a live partner.';
        return;
      }
      const mine = memberOf(pair, source.pane_id), partner = partnerOf(pair, source.pane_id);
      // The partner's agent, not this pane's: the instruction is about to be typed over there.
      const instruction = shortcutIndex >= 0
        ? agentSlash(SHORTCUTS[shortcutIndex].text, agentOf(partner.pane_id)) : '';
      // The role when the pair sheet was given one, the pane's live label when it was not. A pair
      // built by the Start dialog carries a bare fingerprint with no role at all (recentFingerprint),
      // and the receiving agent was being told the text came from "undefined".
      const out = composeTransfer(instruction, mine.role || paneLabel(source) || source.pane_id,
        transferSelection);
      if (out.error) { document.getElementById('transferPreview').textContent = out.error; return; }
      // What the next send will be measured against. Captured here because this is the last moment
      // the source pane is the open one — openTerminal below moves to the partner — and because
      // this function prefills and stops, so the send that classifies against it has not happened.
      const src = source;
      pendingTransfer = {
        key: convMemberKey(src), label: (src && paneLabel(src)) || mine.role || '',
        body: transferSelection, payload: out.text,
        hash: convHash(transferSelection), at: Date.now(),
      };
      // Before openTerminal moves activePane to the partner: the range being transferred belongs
      // to this pane, and this is the point at which the user has committed to it.
      learnFromSelection();
      closeTransfer();
      openTerminal(partner.pane_id);
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
    // one needs a message picked first, and the pick is the deliberate act the arm would be
    // duplicating. The toast names where it went, because a mis-tap is otherwise silent.
    function transferNow(shortcutIndex) {
      if (!convThreadOn()) return;
      const source = claimTransfer();
      if (!source) return;
      if (!transferSelection) { showToast('Pick a message first.'); return; }
      const partner = partnerOf(pairFor(pairs, source.pane_id), source.pane_id);
      const live = agents.find(a => a.pane_id === partner.pane_id);
      // Captured before doTransfer: it moves the open pane to the partner, and the selection this
      // reports on belonged to the pane being left.
      const picked = document.getElementById('selCount').textContent;
      // doTransfer opens the partner, and opening a stale pane starts a *loud* catch-up whose toast
      // would land on top of this send's. That trigger is loud because someone tapped a pane to
      // read it; nobody tapped this one, and the confirmation of an irreversible send outranks a
      // report on a read they did not ask for.
      convQuietPane = partner.pane_id;
      if (!doTransfer(shortcutIndex)) { convQuietPane = ''; return; }
      sendText();
      clearSel();
      showToast(`Sent ${picked} to ${(live && paneLabel(live)) || partner.role || 'the partner'}`);
    }

    // The chips, from the same list the sheet draws. An instruction the user can reach in one tap
    // is the same instruction the sheet offers — there is no second list to keep in step, and a
    // shortcut added to SHORTCUTS is a chip without anything else being edited.
    function transferChipsHtml() {
      return SHORTCUTS.map((s, i) =>
        `<button class="xfer-chip" onclick="transferNow(${i})" ` +
        `title="Send the picked messages with: ${escapeHtml(s.label)}" ` +
        `aria-label="Send the picked messages with ${escapeHtml(s.label)}">` +
        `@${escapeHtml(s.at || s.label.toLowerCase().split(' ')[0])}</button>`).join('') +
        // The payload with nothing added. It is the plainest thing this row can do, so it is not
        // hidden behind the sheet with the rest.
        `<button class="xfer-chip plain" onclick="transferNow(-1)" ` +
        `title="Send the picked messages with no instruction" ` +
        `aria-label="Send the picked messages with no instruction">@as-is</button>` +
        // Everything the chips are not: the preview, the target's badge, and the prefill-and-stop
        // path. A row of chips is a shortcut for the common case, not a replacement for reading.
        `<button class="xfer-chip more" onclick="openTransfer()" ` +
        `title="Transfer with a preview instead" aria-label="Transfer with a preview instead">⋯</button>`;
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
