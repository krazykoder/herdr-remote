    // --- Transfer ---

    let transferSource = '';

    // Who is being quoted, and what. Shared by the sheet and by the chips so that a chip and the
    // sheet behind it can never disagree about either — and because `transferSelection` is what
    // doTransfer reads, so anything that reaches it has to come through here.
    //
    // Returns the source pane, or null with the reason already on screen.
    //
    function claimTransfer() {
      const picked = convThreadOn() ? Array.from(document.querySelectorAll('#convThread .conv-msg.picked')) : [];
      const keys = new Set(picked.map(el => el.dataset.key));
      if (keys.size > 1) { showToast('Select messages from one agent to transfer.'); return null; }
      const source = keys.size ? agents.find(a => convMemberKey(a) === keys.values().next().value) : paneOf(activePane);
      if (!source) return null;
      const pair = pairFor(pairs, source.pane_id);
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
      box.innerHTML = promptChips().map(({s, i}) =>
        `<button class="nav-key" style="width:100%;justify-content:flex-start" onclick="doTransfer(${i})">@${escapeHtml(s.at)} — ${escapeHtml(s.label)}</button>`).join('') +
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
      // Whatever was already typed is kept, under the quote: a transfer that overwrote it would
      // throw away a message someone was in the middle of writing, and a payload with a note of
      // your own on the end is what `classifyVia` already calls `mixed`.
      const kept = input.value.trim();
      input.value = kept ? out.text + '\n\n' + kept : out.text;
      autoGrow(input);
      input.focus();
      // Show the top of the payload, not its tail — reading it is the checkpoint.
      input.setSelectionRange(0, 0);
      input.scrollTop = 0;
      if (window.cue) cue('page');
      return true;
    }

    function insertShortcut(i) {
      const input = document.getElementById('termInput');
      const text = agentSlash(SHORTCUTS[i].text, agentOf(activePane));
      // A prompt is a new instruction, never an edit to the sentence under the caret.
      input.value += input.value && !input.value.endsWith('\n') ? '\n' + text : text;
      input.selectionStart = input.selectionEnd = input.value.length;
      autoGrow(input);
      // Close the sheet: the text is in the composer now and the user needs to see it.
      closePalette();
      input.focus();
    }
