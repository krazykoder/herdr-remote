    // --- Transfer ---

    let transferSource = '';

    function openTransfer() {
      const picked = convThreadOn() ? Array.from(document.querySelectorAll('#convThread .conv-msg.picked')) : [];
      const keys = new Set(picked.map(el => el.dataset.key));
      if (keys.size > 1) { showToast('Select messages from one agent to transfer.'); return; }
      const source = keys.size ? agents.find(a => convMemberKey(a) === keys.values().next().value) : paneOf(activePane);
      const pair = source && pairFor(pairs, source.pane_id);
      if (!pair || pairHealth(pair, agents).state !== 'healthy') return;
      // The ruler's range wins when there is one: it is the deliberate selection, and on a phone
      // the native one is usually empty anyway. Capture before anything can steal it — switching
      // panes clears both.
      transferSelection = selText || String(window.getSelection() || '').trim();
      transferSource = source.pane_id;
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
      const out = composeTransfer(instruction, mine.role, transferSelection);
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
