    // --- Reorder sheet ---
    // A sheet rather than handles on the cards themselves. The card is the one thing on this page
    // read on a phone all day and it has no room to spare; more to the point, #agents has its
    // innerHTML rewritten on every poll, and a drag on those nodes would be destroyed mid-gesture
    // by a snapshot arriving. These rows are built once on open and nothing rewrites them, so the
    // only thing that can move one is a finger.
    function openOrder() {
      const box = document.getElementById('orderRows');
      // Live and unambiguous only. A pane_id that two hosts both claim cannot be ordered — there
      // is no one pane to order — and it is the same guard the tab strip already applies.
      const all = agents.concat(shells);
      const live = orderedAgents(all.filter(a =>
        all.filter(x => x.pane_id === a.pane_id).length === 1));
      box.innerHTML = live.length
        ? live.map(a => {
          const cwd = a.cwd ? escapeHtml(a.cwd.split('/').slice(-2).join('/')) : '';
          const meta = a.agent ? `${agentBadge(a.agent)} ${cwd}` : cwd;
          return `<div class="order-row" role="option" tabindex="0" aria-selected="false" data-pane="${escapeHtml(a.pane_id)}">
      <span class="dot" style="background:${a.agent ? statusColor(a) : shellColor(a.pane_id)}" aria-hidden="true"></span>
      <span class="kind" aria-hidden="true">${a.agent ? '🤖' : '⬛'}</span>
      <span class="info"><span class="name">${escapeHtml(paneLabel(a))}</span><span class="meta">${meta}</span></span>
      <span class="grip" aria-hidden="true">⠿</span>
    </div>`;
        }).join('')
        : '<div class="empty">No panes to order.</div>';
      document.getElementById('orderSheet').style.display = 'block';
    }

    function closeOrder() {
      document.getElementById('orderSheet').style.display = 'none';
    }

    // The DOM is the model while the sheet is open: a drag moves nodes, and this reads back what
    // they now say. One source of truth, rather than an array kept in step with what is on screen.
    function commitOrder() {
      agentOrder = [...document.querySelectorAll('#orderRows .order-row')].map(r => r.dataset.pane);
      saveAgentOrder();
      render();
    }

    // Empty is the default, not a separate flag: orderedAgents falls through to snapshot order the
    // moment nothing is ranked. Reopened so the rows show what was just restored.
    function resetOrder() {
      agentOrder = [];
      saveAgentOrder();
      render();
      openOrder();
    }

    // Drag, mirroring the line ruler: pointer events so one path serves finger and mouse alike,
    // setPointerCapture so the gesture survives leaving the row, and pointercancel treated as an
    // end so an interrupted drag cannot leave a row stuck to the pointer.
    (function () {
      const box = document.getElementById('orderRows');
      const panel = document.getElementById('orderPanel');
      let row = null, rowH = 0, lastY = 0, autoTimer = null;

      // Which slot the pointer is over. The rows are one fixed height, so this is a division
      // rather than a hit test — the same arithmetic as the ruler's lineAt. getBoundingClientRect
      // is read live, so a scrolled sheet needs no separate term.
      function slotAt(clientY) {
        const top = box.getBoundingClientRect().top;
        return Math.max(0, Math.min(box.children.length - 1, Math.floor((clientY - top) / rowH)));
      }

      // Moved as the finger passes, not on release. The gap the row leaves behind is the preview —
      // which is why the dragged row stays put and fades rather than following the pointer.
      function moveTo(clientY) {
        const at = slotAt(clientY);
        const kids = [...box.children];
        if (kids[at] === row) return;
        box.insertBefore(row, at < kids.indexOf(row) ? kids[at] : kids[at].nextSibling);
      }

      // A drag held at the edge of a scrolled sheet keeps going, or a row cannot be moved past the
      // last one that happens to be on screen. Straight off the ruler's edgeScroll, including the
      // reason for the interval: a finger parked at the edge sends no more pointermoves.
      function edgeScroll() {
        const r = panel.getBoundingClientRect();
        const d = lastY < r.top + rowH ? -rowH : lastY > r.bottom - rowH ? rowH : 0;
        if (!d) return;
        const was = panel.scrollTop;
        panel.scrollTop += d;
        if (panel.scrollTop !== was) moveTo(lastY);
      }

      box.addEventListener('pointerdown', e => {
        // A mouse has no sheet-scroll conflict, so the whole row drags. Touch needs the grip: a
        // finger on the rest of the row must still scroll a long sheet.
        if ((e.pointerType !== 'mouse' && !e.target.closest('.grip')) || box.children.length < 2) return;
        // Or the page pans out from under the drag, and the row keeps a text selection with it.
        e.preventDefault();
        row = e.target.closest('.order-row');
        rowH = row.offsetHeight;
        lastY = e.clientY;
        row.setPointerCapture(e.pointerId);
        row.classList.add('dragging');
        // preventDefault took the focus a click would have given it. Put it back, or a row moved
        // with the mouse cannot then be nudged with the arrow keys.
        row.focus();
        autoTimer = setInterval(edgeScroll, 60);
      });

      box.addEventListener('pointermove', e => {
        if (!row) return;
        lastY = e.clientY;
        moveTo(e.clientY);
      });

      function end() {
        if (!row) return;
        clearInterval(autoTimer);
        row.classList.remove('dragging');
        row = null;
        commitOrder();
      }
      box.addEventListener('pointerup', end);
      box.addEventListener('pointercancel', end);

      // The same reorder without a pointer. A drag-only control is unusable by keyboard, and the
      // rows are already focusable for it.
      box.addEventListener('keydown', e => {
        const up = e.key === 'ArrowUp';
        if (!up && e.key !== 'ArrowDown') return;
        const target = e.target.closest('.order-row');
        const swap = target && (up ? target.previousElementSibling : target.nextElementSibling);
        if (!swap) return;
        e.preventDefault();
        box.insertBefore(target, up ? swap : swap.nextSibling);
        target.focus();   // insertBefore moves the node, and a moved node loses focus
        commitOrder();
      });
    })();

    // warn=true for "this will replace X" — it is a caution, not a refusal, and colouring it like
    // a failure teaches the user to ignore the colour.
    function setPairError(text, warn) {
      const el = document.getElementById('pairError');
      el.textContent = text || '';
      el.style.color = warn ? 'var(--orange)' : 'var(--red)';
      el.style.display = text ? 'block' : 'none';
    }

    function openPairDialog(paneId, ev) {
      if (ev) ev.stopPropagation();
      pairSource = agents.find(a => a.pane_id === paneId);
      if (!pairSource) return;
      pairPartner = null;
      document.getElementById('pairSource').textContent = paneTitle(pairSource);
      document.getElementById('pairFields').style.display = 'none';
      setPairError('');
      renderPairCandidates();
      document.getElementById('pairSheet').style.display = 'block';
    }

    function closePair() {
      document.getElementById('pairSheet').style.display = 'none';
      pairSource = null; pairPartner = null;
    }

    function renderPairCandidates() {
      const box = document.getElementById('pairCandidates');
      const submit = document.getElementById('pairSubmit');
      const candidates = pairCandidates(agents, pairSource);
      // The way out of "there is nobody to pair with": start the partner from here. Offered
      // alongside a full list too — the partner wanted is often one that does not exist yet.
      // Gated on the dialog being usable at all, not on this pane's agent: which agent the new
      // session runs is answered in that dialog, not inherited from here.
      const spawn = (startOptions && pairSource.project_id)
        ? `<button class="pair-pick pair-add" onclick="startAndPair()">
      <span class="kind" aria-hidden="true">＋</span>
      <span class="info"><span class="name">Start a session and pair with it</span><span class="meta">A new session in this project, paired the moment it lands</span></span>
    </button>`
        : '';
      if (!candidates.length) {
        box.innerHTML = `<p class="pair-empty">No other live session on ${escapeHtml(pairSource.host || 'local')}. A pair needs two live panes on one host.</p>` + spawn;
        submit.disabled = true;
        return;
      }
      // The reorder sheet's row, without the handle: same dot, same kind glyph, same name over a
      // badge and a short path. The right edge carries what only matters here — the pair this pane
      // is already in, which is what makes choosing it a replacement rather than an addition.
      box.innerHTML = '<div class="pair-head">Partner</div>' +
        candidates.map(a => {
          const existing = pairFor(pairs, a.pane_id);
          const note = existing ? `<span class="pair-note">in "${escapeHtml(existing.name)}"</span>` : '';
          const on = pairPartner && pairPartner.pane_id === a.pane_id;
          const cwd = a.cwd ? escapeHtml(a.cwd.split('/').slice(-2).join('/')) : '';
          const meta = a.agent ? `${agentBadge(a.agent)} ${cwd}` : cwd;
          return `<button class="pair-pick${on ? ' on' : ''}" aria-pressed="${on ? 'true' : 'false'}" onclick="choosePartner('${escapeHtml(a.pane_id)}')">
      <span class="dot" style="background:${a.agent ? statusColor(a) : shellColor(a.pane_id)}" aria-hidden="true"></span>
      <span class="kind" aria-hidden="true">${a.agent ? '🤖' : '⬛'}</span>
      <span class="info"><span class="name">${escapeHtml(paneLabel(a))}</span><span class="meta">${meta}</span></span>
      ${note}<span class="pair-tick" aria-hidden="true">${on ? '✓' : ''}</span>
    </button>`;
        }).join('') + spawn;
      submit.disabled = !pairPartner;
    }

    // A pair needs a second live pane and there is not always one. Hands off to the start dialog —
    // same fields, same validation — and comes back here with the new session chosen as the
    // partner once the poll has seen it, so the pair is two taps rather than a round trip through
    // the Projects list.
    function startAndPair() {
      if (!pairSource || !startOptions || !pairSource.project_id) return;
      const source = pairSource.pane_id, project = pairSource.project_id;
      closePair();
      openStartDialog(project);   // clears startIntent, so it is set after
      startIntent = { pair: source };
    }

    function choosePartner(paneId) {
      pairPartner = agents.find(a => a.pane_id === paneId);
      if (!pairPartner) return;
      document.getElementById('pairName').value =
        `${paneLabel(pairSource)} ↔ ${paneLabel(pairPartner)}`.slice(0, 64);
      // Default to the pane's own name — "Architect 1", "Reviewer 2" — which is what the
      // receiving agent is shown. The agent name is a poor default: two panes both called
      // "claude" tell the reader nothing about which colleague sent the text.
      document.getElementById('pairRoleA').value = paneLabel(pairSource);
      document.getElementById('pairRoleB').value = paneLabel(pairPartner);
      document.getElementById('pairFields').style.display = 'flex';
      // Name what is being replaced — a silent replacement is how a user loses a pair they meant to keep.
      const clashes = [pairSource, pairPartner].map(p => pairFor(pairs, p.pane_id)).filter(Boolean);
      const names = [...new Set(clashes.map(p => p.name))];
      setPairError(names.length ? `Saving replaces the existing pair ${names.map(n => `"${n}"`).join(' and ')}.` : '', true);
      renderPairCandidates();
    }

    function savePair() {
      if (!pairSource || !pairPartner) return;
      const name = document.getElementById('pairName').value.trim();
      if (!name) { setPairError('Pair name is required'); return; }
      const roleA = document.getElementById('pairRoleA').value.trim() || paneLabel(pairSource);
      const roleB = document.getElementById('pairRoleB').value.trim() || paneLabel(pairPartner);
      const ids = [pairSource.pane_id, pairPartner.pane_id];
      const kept = pairs.filter(p => !p.members.some(m => ids.includes(m.pane_id)));
      if (kept.length >= MAX_PAIRS) { setPairError(`Already at ${MAX_PAIRS} pairs — remove one first`); return; }
      pairs = kept.concat([{
        id: newPairId(), name: name.slice(0, 64),
        members: [fingerprint(pairSource, roleA), fingerprint(pairPartner, roleB)]
      }]);
      savePairs();
      closePair();
      render();
      renderPairStrip();
    }

    function unpair() {
      const pair = pairFor(pairs, activePane);
      if (!pair) return;
      // The arm is what asked; the menu it was armed in is still open behind it.
      closeTermMenu();
      pairs = pairs.filter(p => p.id !== pair.id);
      savePairs();
      render();
      renderPairStrip();
    }

    // The strip is absent, not disabled, when there is no pair — and the transfer control is
    // absent whenever the pair is stale, so the UI can never offer an unverified target.
    function renderPairStrip() {
      const strip = document.getElementById('pairStrip');
      const menu = document.getElementById('termMenuPair');
      // Before the lookup: a pair whose panes have been restarted is found by this and by nothing
      // else, and being asked "is this pane paired" is the moment to answer it honestly.
      healPairs();
      const pair = activePane ? pairFor(pairs, activePane) : null;
      if (!pair) {
        strip.style.display = 'none';
        strip.innerHTML = '';
        // No strip without a pair — but the menu still has to offer making one, or an unpaired
        // pane has no route to pairing from inside the pane at all.
        menu.innerHTML = activePane
          ? `<button class="menu-item" role="menuitem" onclick="closeTermMenu(); openPairDialog(activePane)">Pair with…</button>`
          : '';
        return;
      }
      const health = pairHealth(pair, agents);
      const partner = partnerOf(pair, activePane);
      const ok = health.state === 'healthy';
      // Read the partner's name from the live snapshot, not from the pair record: the record holds
      // the name captured at pin time, so renaming a pane would leave a stale name on this button.
      // Falls back to the pinned name, then the pane ID, so the button is never blank.
      const live = agents.find(a => a.pane_id === partner.pane_id);
      const partnerName = (live ? paneLabel(live) : '') || partner.role || partner.pane_id;
      const mineLive = agents.find(a => a.pane_id === activePane);
      // Which pane you are in, by name and harness, whenever there is a live pane to name. It used
      // to appear only with the composer unfolded, on the reading that it named the typing target —
      // but it is the same answer either way, and hiding it behind a fold is why the strip looked
      // like it named some panes and not others. The pair's own name moves to the title, where a
      // reader who wants it can still find it.
      const center = mineLive
        ? `<span class="pair-target" title="${escapeHtml(pair.name)}` +
          `${bottomDockOpen() ? ` — typing to ${escapeHtml(paneLabel(mineLive))}` : ''}">` +
          `<span class="dot${mineLive.status === 'working' ? ' pulse' : ''}" ` +
          `style="background:${statusColor(mineLive)}" aria-hidden="true"></span>` +
          `<span class="label">${escapeHtml(paneLabel(mineLive))}</span>${agentBadge(mineLive.agent)}</span>`
        : `<span class="pair-name">${escapeHtml(pair.name)}</span>`;
      // Rebuilt wholesale, so the placement class has to be reapplied with it.
      strip.className = 'pair-strip' + (ok ? '' : ' stale') +
        (currentPairPlace() === 'bottom' ? ' at-bottom' : '');
      strip.innerHTML =
        // Switch sits first, on the left: it is the control reached most often, and the thumb
        // is already there from the back button above it.
        (ok ? `<button class="switch" title="Switch to ${escapeHtml(partnerName)} (⌘/Ctrl+Shift+P)" ` +
          `onpointerdown="if(document.activeElement===document.getElementById('termInput'))event.preventDefault()" ` +
          `onclick="switchToPartner()">⇄ ${escapeHtml(partnerName)}</button>` : '') +
        center +
        (ok ? `<button class="transfer" onclick="openTransfer()">Transfer ›</button>` : '') +
        (ok ? '' : `<span class="pair-reason">${escapeHtml(health.reason)}</span>`);
      strip.style.display = 'flex';
      // Edit and Unpair live in the gear menu: the strip is for the two controls used while
      // working, and pair management is neither frequent nor something to hit by accident.
      menu.innerHTML =
        `<button class="menu-item" role="menuitem" onclick="closeTermMenu(); openPairDialog(activePane)">Edit pair</button>` +
        `<button class="menu-item danger arm-btn" role="menuitem"` +
        ` onclick="armButton(this, 'Unpair?', unpair)">Unpair…</button>`;
    }

    // Renames the pane in herdr itself, not just in this browser. A frontend-only alias would
    // disagree with the herdr pane list and with the Architect N labels a started session gets,
    // leaving one pane with three names.
    function renamePane() {
      const a = activePane ? paneOf(activePane) : null;
      if (!a || !ws) return;
      const next = prompt('Name for this pane', a.label || a.project || a.agent || '');
      if (next === null) return;
      const label = next.trim();
      // Cleared or unchanged means keep what it had — the relay refuses an empty label, and
      // nagging about it is worse than treating a blank field as "leave it alone".
      if (!label || label === a.label) return;
      if (label.length > 32) { showToast('Name must be 32 characters or fewer.'); return; }
      ws.send(JSON.stringify({ type: 'rename_pane', pane_id: activePane, label: label }));
      // Nothing is applied here — the command_result branch does it once herdr has accepted the
      // rename, and an `error` reply surfaces instead if the relay is too old to know the message.
    }

    // Jump to the other half of the pair without going back through the agent list. Refuses on a
    // stale pair for the same reason transfer does — the target has not been verified.
    function switchToPartner() {
      const pair = activePane ? pairFor(pairs, activePane) : null;
      if (!pair || pairHealth(pair, agents).state !== 'healthy') return;
      const keepComposer = document.activeElement === document.getElementById('termInput');
      const to = partnerOf(pair, activePane).pane_id;
      // Before the switch, because the thread the partner opens on is read during it.
      carryConvToPane(paneOf(activePane), paneOf(to));
      openTerminal(to);
      if (keepComposer) document.getElementById('termInput').focus();
      if (window.cue) cue('page');
    }
