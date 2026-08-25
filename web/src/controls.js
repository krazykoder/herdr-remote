    // --- Slots ---
    // A pane is either alone in its tab (~139 cols) or sharing it with one sibling (~69). Which
    // of the two this screen wants is the only thing the browser gets to decide; the relay owns
    // how it is reached. 768px is the same breakpoint the rest of the layout uses.
    function slotFor() { return window.innerWidth < 768 ? 'narrow' : 'wide'; }
    function adjustPane() {
      if (!ws || !activePane) return;
      showToast('Adjusting pane…');
      ws.send(JSON.stringify({ type: 'set_slot', pane_id: activePane, slot: slotFor() }));
    }
    // --- Clear screen, and Quit ---
    // Both send a line to whatever is running in the pane, and which line depends on the kind:
    // a shell clears and exits with `clear` and `exit`, an agent with `/clear` and `/quit`.
    // Neither is undoable — /clear throws away the agent's context — so both take two
    // taps, the same as they always did. The first tap only arms.
    // The second tap has to be quick: 1.5s is short enough that a stray tap in a pocket never
    // lands the pair, and long enough to be deliberate. The armed button drains its fill over
    // exactly that window, so the deadline is visible rather than guessed at.
    const FIRE_ARM_MS = 1500;
    // The danger shortcuts in the palette keep the longer window — those are picked off a list
    // that has to be read first, not aimed at a button already under the thumb.
    const SHORTCUT_ARM_MS = 8000;
    const ARM_LABELS = { clsBtn: 'CLS', quitBtn: 'QUIT' };
    const armedAt = { clsBtn: 0, quitBtn: 0 };

    // The two-tap arm, once. The label says what the second tap will do, because a button that
    // only changes colour when armed does not say what it is armed to send.
    function armFire(id, fire) {
      if (!ws || !activePane) return;
      const btn = document.getElementById(id);
      if (Date.now() - armedAt[id] < FIRE_ARM_MS) {
        disarmFire(id);
        fire();
        return;
      }
      armedAt[id] = Date.now();
      btn.dataset.armed = '1';
      btn.textContent = ARM_LABELS[id] + '?';
      // Disarms itself rather than waiting to be pressed again: a button left armed across a
      // pocket is the accident this exists to stop.
      setTimeout(() => { if (Date.now() - armedAt[id] >= FIRE_ARM_MS) disarmFire(id); }, FIRE_ARM_MS);
    }

    function disarmFire(id) {
      armedAt[id] = 0;
      const btn = document.getElementById(id);
      delete btn.dataset.armed;
      btn.textContent = ARM_LABELS[id];
    }

    // The same two taps, for a button a render drew. armFire cannot serve these: it is keyed by
    // element id against a table of labels, and these buttons are rebuilt from innerHTML with no
    // id worth having. So the arm hangs off the element, and only one is ever armed — a second
    // arm disarms the first, because two buttons both claiming the next tap is not a promise.
    //
    // 2.5s rather than the header's 1.5s. That window is short because QUIT sits under the thumb
    // for as long as a pane is open; these are reached by opening a panel and aiming, and a
    // deadline that expires while you are still moving teaches people to double-tap blind.
    const ARM_MS = 2500;
    let armedEl = null, armedKey = '', armedTimer = 0;

    // `key` is for a control whose enclosing card is redrawn by the poll. Its element changes,
    // but its action does not; matching that action lets the second tap reach the same arm.
    function armButton(btn, label, run, key) {
      if ((key && armedKey === key) || (!key && armedEl === btn)) { disarmButton(); run(); return; }
      disarmButton();
      armedEl = btn;
      armedKey = key || '';
      btn.dataset.armLabel = btn.textContent;
      btn.dataset.armed = '1';
      btn.textContent = label;
      // Disarms itself rather than waiting to be pressed again — the same reason the header's does.
      armedTimer = setTimeout(disarmButton, ARM_MS);
    }

    function disarmButton() {
      clearTimeout(armedTimer);
      const btn = armedEl;
      const key = armedKey;
      armedEl = null; armedKey = '';
      // The element that was armed, and — for a keyed arm — whatever is standing in its place now.
      // A poll redraw replaces the node between the two taps, so by the time the arm expires the
      // one on screen is not the one this holds, and clearing only `armedEl` leaves a detached
      // node tidied and a live button still saying "End all?" with nothing behind it.
      const live = key && typeof document !== 'undefined' && document.querySelector
        ? document.querySelector(`[data-arm-key="${key}"]`) : null;
      for (const el of new Set([btn, live])) {
        if (!el || !el.dataset || !el.dataset.armLabel) continue;
        el.textContent = el.dataset.armLabel;
        delete el.dataset.armed;
        delete el.dataset.armLabel;
      }
    }

    function armButtonArmed(key) { return !!key && armedKey === key; }

    // Anywhere else, and the arm is off: a tap that lands somewhere else is a tap that was not
    // the second half of this pair.
    document.addEventListener('click', (e) => {
      const keyed = e.target.closest && e.target.closest('[data-arm-key]');
      if (e.target !== armedEl && (!keyed || keyed.dataset.armKey !== armedKey)) disarmButton();
    }, true);

    function disarmClear() { disarmFire('clsBtn'); }
    function disarmQuit() { disarmFire('quitBtn'); }

    // Sent as a line, not as keys: this is the pane's own command in both cases. No agentSlash
    // here — the $ form is codex's way of reaching a *prompt or skill*, and its built-in commands
    // are slash commands like everyone else's.
    function sendLine(text) {
      if (!submitText(activePane, text)) return false;
      burstPoll();
      return true;
    }

    function armClear() {
      armFire('clsBtn', () => {
        closeFireMenu();
        const line = isShell(activePane) ? 'clear' : '/clear';
        if (!sendLine(line)) return;
        // The screen the pane repaints after a clear is the live frame; the backlog behind it is
        // history the user did not ask to keep looking at. Undone by Load more or reopening it.
        paneSource = 'visible';
        showToast(`Sending ${line} — Load more or reopen for history`, 'info');
      });
    }

    function armQuit() {
      armFire('quitBtn', () => {
        closeFireMenu();
        const line = isShell(activePane) ? 'exit' : '/quit';
        if (!sendLine(line)) return;
        showToast(`Sending ${line}`, 'info');
      });
    }

    // --- Ending a session ---
    // End is QUIT carried one line further. `/quit` exits an agent's TUI and herdr keeps the pane:
    // it survives as a bare shell still wearing the name the session was started under, which is
    // how the Terminals section fills up with the remains of agents nobody is running, each still
    // holding the slot it was given. So the shell is exited too, on the snapshot that shows the
    // agent has gone.
    //
    // Two sends rather than one message because there is no relay verb for this and these are the
    // two lines a person types. Through submitText and not sendTextTo, so noteSent is never called:
    // these are control keystrokes, and a transcript claiming the user said "/quit" to an agent is
    // a transcript that is wrong. The same path, and the same reason, as armQuit above.
    const END_TIMEOUT_MS = 30000;

    // pane_id -> {at, label, quiet}: the panes with an end in flight. `quiet` marks the ones whose
    // last line has already gone out — a shell sent `exit`, or an agent on a relay that lists no
    // shells — so the tick stops sending at them and only waits for them to disappear. It is also
    // what keeps the timeout from reporting "did not quit" about a pane that quit immediately and
    // simply cannot be observed doing it.
    //
    // Never persisted: a reload has no send in flight to finish. What reads it is the render — a
    // button whose pane is in here says Ending… and takes no more taps, and gets its word back by
    // the entry leaving, whether that is the pane going or the deadline passing.
    const endWatch = new Map();

    function endPending(paneId) { return endWatch.has(paneId); }

    function endPane(paneId) {
      const pane = paneOf(paneId);
      if (!pane) return false;                    // already where this was trying to get to
      // The relay refuses send_text at a blocked pane: its box is a permission prompt, not a
      // composer. Saying so is the whole answer — the user is one tap from unblocking it.
      // ponytail: no way to end a wedged pane; `herdr pane close` is the upgrade if this bites.
      if (pane.status === 'blocked') {
        showToast('That pane is waiting on a prompt — answer it, then end it.');
        return false;
      }
      if (isShell(paneId)) return endShell(paneId);
      if (!submitText(paneId, '/quit')) return false;
      burstPoll(paneId);
      // With terminal mode off the relay lists no shells at all, so a quit pane leaves `agents` and
      // turns up nowhere — indistinguishable from herdr having closed it. There is nothing to watch
      // for, so this stops at one line and says so rather than reporting a pane gone that is not.
      // ponytail: leaves a shell behind on a relay with HERDR_ENABLE_TERMINAL off.
      if (!startOptions || !startOptions.terminal) {
        showToast(`Quit ${paneLabel(pane)} — its pane may remain.`, 'info');
        // Watched quietly all the same, so the button says Ending… like every other one. Nothing
        // more is sent at it and nothing is reported if it outlasts the deadline — the pane simply
        // gets its End back, which is the honest answer where the shell cannot be seen.
        endWatch.set(paneId, {at: Date.now(), label: paneLabel(pane), quiet: true});
        return true;
      }
      endWatch.set(paneId, {at: Date.now(), label: paneLabel(pane)});
      showToast(`Ending ${paneLabel(pane)}…`, 'info');
      return true;
    }

    function endShell(paneId) {
      const at = endWatch.get(paneId);
      if (!submitText(paneId, 'exit')) { endWatch.delete(paneId); return false; }
      // Quiet from here: the line is out and there is nothing left to send. Kept rather than
      // dropped so the button stays Ending… across both halves of an agent's exit — the pane
      // leaving the list is what ends it, which is also what takes the card away.
      endWatch.set(paneId, {at: (at || {}).at || Date.now(),
                            label: (at || {}).label || paneLabel(paneOf(paneId) || {}),
                            quiet: true});
      burstPoll(paneId);
      return true;
    }

    // The second line, on the snapshot that shows the first one worked. A pane sitting in `shells`
    // is one whose agent has exited, which is exactly what `/quit` was aiming for.
    function endTick() {
      if (!endWatch.size) return;
      const now = Date.now();
      for (const [paneId, at] of Array.from(endWatch)) {
        // Gone from both lists: herdr closed the pane itself, which some harnesses do on /quit.
        if (!paneOf(paneId)) { endWatch.delete(paneId); continue; }
        // `quiet` and not `isShell` alone, or the second line would go out again on every poll
        // for as long as the shell took to close.
        if (!at.quiet && isShell(paneId)) { endShell(paneId); continue; }
        if (now - at.at > END_TIMEOUT_MS) {
          endWatch.delete(paneId);
          if (!at.quiet) showToast(`${at.label} did not quit — it is still running.`);
        }
      }
    }

    // Every live member of a conversation, each by whichever of the two it is. A member that has
    // already ended is skipped in silence: it is the state this is aiming for, not a failure.
    // Nothing is deleted and no field is written — the conversation and its transcripts survive,
    // and go grey because nothing in them is live, which is derived rather than stored.
    function endConversation(convId) {
      const conv = loadConvIndex().find(c => c.id === convId);
      if (!conv) return false;
      const live = (conv.members || [])
        .map(m => agents.concat(shells).find(x => convMemberKey(x) === m.key))
        .filter(Boolean);
      if (!live.length) { showToast('Nothing in this conversation is still running.'); return false; }
      live.forEach(p => endPane(p.pane_id));
      return true;
    }

    // Asking for history is what takes the pane back off the live frame Clear screen left it on.
    function loadMore() {
      paneSource = 'recent-unwrapped';
      paneLines = Math.min(paneLines + historyStep(), paneHistoryMax());
      refreshPane();
    }
    // Text into a pane, ending in the Enter that submits it. Every send in this app goes through
    // here, because "it never posted" is the failure they all had.
    //
    // The Enter rides on the last chunk instead of following it as its own message. It used to be a
    // separate `send_keys`, timed by a sleep in the relay — and an agent that was still busy with
    // what it had just been handed swallowed it: the text sat in the agent's composer, unsent,
    // looking exactly like a message that was never written. Worst on a session that had only just
    // started, which is the case the New agent dialog hits every time. `submit` makes the relay use
    // herdr's own one-call form, so nothing can arrive between the text and the Enter.
    //
    // A socket that is not open is a refusal, not a send: this returns false so the caller keeps the
    // message in the box rather than clearing it over a message the relay never saw.
    // pane_id -> the text the relay refused because the pane was at a menu. Nothing was typed, so
    // this is the whole of the message and it is still the client's to send: a start into a codex
    // asking whether it may trust the directory is the case this exists for, and losing its opening
    // prompt to the trust prompt is what made a spawn look like it had failed.
    const menuHeld = new Map();

    function holdForMenu(paneId, text) {
      if (paneId && text) menuHeld.set(paneId, {text: text, sawBlocked: false, at: Date.now()});
    }

    // How long a held message waits for the poll to report the menu the relay has already seen.
    // Giving up is safe because the relay refuses again at a pane still showing one: a late try
    // costs one pane read and the message is held afresh. Waiting for ever is not safe — a relay
    // too old to publish the state would hold the text for the life of the page.
    const MENU_HOLD_WAIT_MS = 10000;

    // Sent again the moment the pane is no longer at the question. Called from the snapshot, which
    // is the only thing that knows a pane has moved.
    function sendHeldAfterMenu(list) {
      if (!menuHeld.size) return;
      const seen = new Set();
      for (const a of list || []) {
        seen.add(a.pane_id);
        const held = menuHeld.get(a.pane_id);
        if (!held) continue;
        // A trust prompt can be reported idle. The relay turns it into blocked on the next spawn
        // snapshot; wait for that state before treating a later non-blocked snapshot as its answer.
        if (a.status === 'blocked') { held.sawBlocked = true; continue; }
        if (!held.sawBlocked && Date.now() - held.at < MENU_HOLD_WAIT_MS) continue;
        const text = held.text;
        // Dropped before the send: a second refusal puts it straight back, and holding it in two
        // places at once is how a message gets sent twice.
        menuHeld.delete(a.pane_id);
        submitText(a.pane_id, text);
      }
      // A pane that is no longer in the snapshot has ended, and text held for one is not going
      // anywhere. Dropped here rather than left to accumulate for the life of the page.
      for (const id of Array.from(menuHeld.keys())) if (!seen.has(id)) menuHeld.delete(id);
    }

    function submitText(paneId, text) {
      if (!text || !paneId || !ws || ws.readyState !== 1) return false;
      lastSubmitted.set(paneId, text);
      // One message per chunk. Nothing before the last one submits, so they land in the agent's
      // composer as one text; the relay handles a connection's messages in order.
      const parts = chunkText(text);
      if (!parts.length) return false;
      try {
        parts.forEach((part, i) => ws.send(JSON.stringify(
          { type: 'send_text', pane_id: paneId, text: part, submit: i === parts.length - 1 })));
      } catch (e) {
        // A socket that closed between the guard above and the write. Nothing was submitted.
        showToast('Not connected — that was not sent.');
        return false;
      }
      return true;
    }

    // What was last handed to a pane, so a refusal can carry it: `command_result` names the pane and
    // not the text, and the chunks it was split into are not what anyone would want re-sent.
    const lastSubmitted = new Map();

    // One text into one pane, from whichever composer had it. The pane's own composer is one
    // caller; the conversation window's is the other, and it can be pointed at a pane nobody has
    // open — which is why this takes the pane rather than reading `activePane`.
    function sendTextTo(paneId, text) {
      // Both composers land here, which is why the arbitration guard is here and not in each of
      // them. It arms rather than refuses — see arbGuardSend.
      if (typeof arbGuardSend === 'function' && !arbGuardSend(paneId)) return false;
      if (!submitText(paneId, text)) return false;
      // Recorded once the wire has taken it: a transcript that cannot tell a transfer from typing
      // claims the user said what another agent said, and one that records a send the socket
      // dropped claims they said it at all. The whole text, not a chunk of it — what was sent is
      // one message, however many the wire took.
      noteSent(text, paneId);
      lastSentText[paneId] = text;
      syncResend();
      return true;
    }

    function sendText() {
      const i = document.getElementById('termInput');
      if (!i.value || !ws || !activePane) return;
      const paneId = activePane, text = i.value;
      if (!sendTextTo(paneId, text)) return;
      i.value = ''; autoGrow(i);
      // What this end knows: the socket took it. The tick comes back from the relay once the
      // pane has it — see the `send_text` branch of command_result.
      showToast(`Sending to ${paneLabel(paneOf(paneId) || {}) || paneId}…`, 'info');
      renderQuickActions();   // the pane has a last send now, so Resend has something to offer
      // Only what was typed at a terminal, and only from this composer. A transfer, a shortcut and
      // a resend all reach the wire by other paths, and none of them is the user typing a command.
      if (isShell(paneId)) noteTermCommand(text);
      if (isShell(paneId)) burstPoll(paneId); else setTimeout(refreshPane, 500);
    }

    function syncResend() {
      const btn = document.getElementById('resendBtn');
      if (!btn) return;
      const again = lastSentText[activePane];
      btn.hidden = !again;
      if (again) btn.title = `Load this pane's last message into the composer: ${again.slice(0, 80)}`;
    }

    // One tap, unlike the buttons it sits beside. Those arm because what they do cannot be taken
    // back; this one fills a text box you can still edit, empty or send, and a draft already there
    // is refused rather than overwritten — there is nothing here for a second tap to protect.
    function resendLast() {
      const again = lastSentText[activePane];
      if (!again) return;
      const i = document.getElementById('termInput');
      if (i.value.trim()) { showToast('Composer already has a draft. Send or clear it first.'); return; }
      i.value = again;
      autoGrow(i);
      i.focus();
      closeFireMenu();
    }
    function sendKey(k) { if (!ws || !activePane) return; ws.send(JSON.stringify({ type: 'send_keys', pane_id: activePane, keys: [k] })); setTimeout(refreshPane, 300); }
    function sendKeys(k) { if (!ws || !activePane) return; ws.send(JSON.stringify({ type: 'send_keys', pane_id: activePane, keys: k })); setTimeout(refreshPane, 300); }

    // --- Nav Tray (collie-style) ---
    let keyQueue = [], armedMod = null, ctrlConfirm = null;
    const CTRL_PRESETS = [
      { label: 'Ctrl C', keys: ['ctrl+c'] },
      { label: 'Ctrl D', keys: ['ctrl+d'], danger: true },
      { label: 'Ctrl U', keys: ['ctrl+u'] },
      { label: 'Ctrl R', keys: ['ctrl+r'] },
      { label: 'Ctrl L', keys: ['ctrl+l'] },
      { label: 'Ctrl Z', keys: ['ctrl+z'], danger: true },
    ];
    const DANGER_KEYS = new Set(['ctrl+c', 'ctrl+d', 'ctrl+z']);
    // What a physical Ctrl+<letter> may send, derived from the presets so the two cannot drift
    // apart — and both are a subset of the relay's SAFE_KEYS, which refuses anything else anyway.
    const CTRL_CHORDS = CTRL_PRESETS.map(p => p.keys[0]);

    function fireKey(k) {
      if (window.cue) cue('tick');
      const composed = armedMod ? `${armedMod}+${k}` : k;
      if (keyQueue.length > 0 || armedMod) {
        keyQueue.push(composed);
        armedMod = null;
        if (window.cue) cue('droplet');
        renderKeyQueue();
        renderMods();
      } else {
        sendKeys([composed]);
      }
    }

    function armMod(m) {
      armedMod = armedMod === m ? null : m;
      if (window.cue) cue('toggle');
      renderMods();
    }

    function renderMods() {
      const s = document.getElementById('modShift');
      const c = document.getElementById('modCtrl');
      if (s) s.classList.toggle('armed', armedMod === 'shift');
      if (c) c.classList.toggle('armed', armedMod === 'ctrl');
    }

    function renderKeyQueue() {
      const strip = document.getElementById('keyQueueStrip');
      if (!keyQueue.length && !armedMod) { strip.style.display = 'none'; return; }
      strip.style.display = 'flex';
      let html = keyQueue.map((k, i) => {
        const isDanger = DANGER_KEYS.has(k.toLowerCase());
        const label = k.includes('+') ? k.replace('ctrl+', 'Ctrl ').replace('shift+', '\u21e7 ') : k;
        return `<span class="queue-chip${isDanger ? ' danger' : ''}" onclick="removeQueueKey(${i})">${label} \u00d7</span>`;
      }).join('');
      if (armedMod) html += `<span style="color:var(--muted);font-size:12px;padding:4px">${armedMod === 'shift' ? '\u21e7' : 'Ctrl'} + \u2026</span>`;
      html += `<span style="margin-left:auto;display:flex;gap:4px">`;
      html += `<button onclick="sendQueuedKeys()" style="padding:6px 12px;border-radius:6px;border:none;background:${keyQueue.some(k => DANGER_KEYS.has(k.toLowerCase())) ? 'var(--red)' : 'var(--blue)'};color:var(--bg);font-size:12px;font-weight:600;cursor:pointer">Send</button>`;
      html += `<button onclick="clearKeyQueue()" style="padding:6px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--muted);font-size:12px;cursor:pointer">✕</button>`;
      html += `</span>`;
      strip.innerHTML = html;
    }

    function removeQueueKey(i) { keyQueue.splice(i, 1); renderKeyQueue(); }
    function clearKeyQueue() { keyQueue = []; armedMod = null; renderKeyQueue(); renderMods(); }
    function sendQueuedKeys() {
      if (!keyQueue.length) return;
      if (window.cue) cue('success');
      sendKeys(keyQueue);
      keyQueue = []; armedMod = null; renderKeyQueue(); renderMods();
    }

    // The docks share the space above the composer, so only one is ever open.
    const DOCKS = ['termKeys', 'quickDock', 'ctrlDock'];

    function closeDocks() {
      DOCKS.forEach(d => { document.getElementById(d).style.display = 'none'; });
    }

    function toggleDock(id) {
      const el = document.getElementById(id);
      const show = el.style.display === 'none';
      closeDocks();
      el.style.display = show ? '' : 'none';
      if (window.cue) cue(show ? 'page' : 'tick');
    }

    // Typing wins over browsing: a dock and the on-screen keyboard together leave almost no pane
    // visible, and the user who just tapped the composer wants to read what they are answering.
    document.getElementById('termInput').addEventListener('focus', closeDocks);

    // Clearing is destructive and sits next to two controls that are not, so it takes two taps.
    // The armed state expires on its own — a stray first tap must not leave a live trigger behind.
    let clearArmedAt = 0;
