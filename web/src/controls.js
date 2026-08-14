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
    const ARM_LABELS = { clsBtn: 'CLS', quitBtn: 'QUIT', abortBtn: 'Esc' };
    const armedAt = { clsBtn: 0, quitBtn: 0, abortBtn: 0 };

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
    let armedEl = null, armedTimer = 0;

    function armButton(btn, label, run) {
      if (armedEl === btn) { disarmButton(); run(); return; }
      disarmButton();
      armedEl = btn;
      btn.dataset.armLabel = btn.textContent;
      btn.dataset.armed = '1';
      btn.textContent = label;
      // Disarms itself rather than waiting to be pressed again — the same reason the header's does.
      armedTimer = setTimeout(disarmButton, ARM_MS);
    }

    function disarmButton() {
      clearTimeout(armedTimer);
      const btn = armedEl;
      armedEl = null;
      if (!btn) return;
      btn.textContent = btn.dataset.armLabel;
      delete btn.dataset.armed;
      delete btn.dataset.armLabel;
    }

    // Anywhere else, and the arm is off: a tap that lands somewhere else is a tap that was not
    // the second half of this pair.
    document.addEventListener('click', (e) => { if (e.target !== armedEl) disarmButton(); }, true);

    function disarmClear() { disarmFire('clsBtn'); }
    function disarmQuit() { disarmFire('quitBtn'); }
    function disarmAbort() { disarmFire('abortBtn'); }

    // Sent as a line, not as keys: this is the pane's own command in both cases. No agentSlash
    // here — the $ form is codex's way of reaching a *prompt or skill*, and its built-in commands
    // are slash commands like everyone else's.
    function sendLine(text) {
      ws.send(JSON.stringify({ type: 'send_text', pane_id: activePane, text: text }));
      ws.send(JSON.stringify({ type: 'send_keys', pane_id: activePane, keys: ['Enter'] }));
      burstPoll();
    }

    function armClear() {
      armFire('clsBtn', () => {
        closeFireMenu();
        const line = isShell(activePane) ? 'clear' : '/clear';
        sendLine(line);
        // The screen the pane repaints after a clear is the live frame; the backlog behind it is
        // history the user did not ask to keep looking at. Undone by Load more or reopening it.
        paneSource = 'visible';
        showToast(`Sent ${line} — Load more or reopen for history`);
      });
    }

    function armQuit() {
      armFire('quitBtn', () => {
        closeFireMenu();
        const line = isShell(activePane) ? 'exit' : '/quit';
        sendLine(line);
        showToast(`Sent ${line}`);
      });
    }

    // Asking for history is what takes the pane back off the live frame Clear screen left it on.
    function loadMore() {
      paneSource = 'recent-unwrapped';
      paneLines = Math.min(paneLines + historyStep(), paneHistoryMax());
      refreshPane();
    }
    function sendText() {
      const i = document.getElementById('termInput');
      if (!i.value || !ws || !activePane) return;
      if (i.value.length > SEND_TEXT_MAX) {
        showToast(`Text must be ${SEND_TEXT_MAX} characters or fewer.`); return;
      }
      const paneId = activePane;
      // Before the send, while the composer still holds what is being sent: a transcript that
      // cannot tell a transfer from typing claims the user said what another agent said.
      noteSent(i.value, paneId);
      ws.send(JSON.stringify({ type: 'send_text', pane_id: paneId, text: i.value }));
      ws.send(JSON.stringify({ type: 'send_keys', pane_id: paneId, keys: ['Enter'] }));
      i.value = ''; autoGrow(i);
      if (isShell(paneId)) burstPoll(paneId); else setTimeout(refreshPane, 500);
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
