    // --- Dictation ---
    // The Web Speech API, not the keyboard's own dictation button: reaching that one means
    // raising the keyboard first, which is the half of the screen this is trying not to spend.
    // Chrome and Safari have it (prefixed on Safari); Firefox does not, and the button stays
    // hidden there rather than failing on press.
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    let dictation = null, dictationBase = '';

    // Off unless asked for: the rail is already six buttons wide, and a microphone is the one
    // control here that asks the browser for a permission.
    const MIC_KEY = 'herdr_dictation';
    function dictationOn() { return localStorage.getItem(MIC_KEY) === 'on'; }

    function setDictationEnabled(on) {
      try { localStorage.setItem(MIC_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode: session-only */ }
      document.getElementById('micPick').value = on ? 'on' : 'off';
      if (!on && dictation) dictation.stop();
      renderMicState();
    }

    function toggleDictation() {
      if (dictation) { dictation.stop(); return; }
      // The microphone is gated on a secure context, and the ordinary way this app is reached at
      // home is plain http on a LAN address. Say which URL works rather than failing silently.
      if (!window.isSecureContext) {
        showToast('Dictation needs https — open the app over the tunnel URL');
        return;
      }
      const input = document.getElementById('termInput');
      const r = new SpeechRec();
      r.lang = navigator.language || 'en-US';
      r.continuous = true;
      r.interimResults = true;
      // Whatever is already typed stays: dictation appends to the composer, it does not own it.
      dictationBase = input.value && !/\s$/.test(input.value) ? input.value + ' ' : input.value;
      r.onresult = e => {
        let said = '';
        for (let i = 0; i < e.results.length; i++) said += e.results[i][0].transcript;
        input.value = dictationBase + said;
        autoGrow(input);  // never focus() — a focused textarea is the keyboard this avoids
      };
      r.onerror = e => {
        showToast(e.error === 'not-allowed' ? 'Microphone permission denied' : `Dictation: ${e.error}`);
      };
      r.onend = () => { dictation = null; renderMicState(); };
      dictation = r;
      renderMicState();
      try { r.start(); } catch (err) { dictation = null; renderMicState(); }
    }

    function renderMicState() {
      const btn = document.getElementById('micBtn');
      btn.hidden = !SpeechRec || !dictationOn();
      btn.style.color = dictation ? 'var(--red)' : 'var(--muted)';
      btn.style.borderColor = dictation ? 'var(--red)' : 'var(--border)';
      btn.setAttribute('aria-label', dictation ? 'Stop dictating' : 'Dictate');
    }

    function clearComposer(btn) {
      if (Date.now() - clearArmedAt > 600) {
        clearArmedAt = Date.now();
        btn.classList.add('armed');
        setTimeout(() => btn.classList.remove('armed'), 600);
        return;
      }
      clearArmedAt = 0;
      btn.classList.remove('armed');
      const input = document.getElementById('termInput');
      input.value = '';
      autoGrow(input);
      input.focus();
      if (window.cue) cue('tick');
    }

    function toggleKeysDock() { toggleDock('termKeys'); }

    // The button stays in the rail over a terminal as the place script calls will live. Its dock
    // is not the thing to open there — yes / no / continue answer an agent, not a shell prompt.
    function toggleQuickDock() {
      if (activePane && isShell(activePane)) { showToast('Scripts — coming soon'); return; }
      toggleDock('quickDock');
    }

    function quickSend(text) {
      if (!ws || !activePane) return;
      if (window.cue) cue('success');
      submitText(activePane, text);
      document.getElementById('quickDock').style.display = 'none';
      setTimeout(refreshPane, 500);
    }

    function switchKeyTab(tab) {
      document.getElementById('tabKeys').classList.toggle('active', tab === 'keys');
      document.getElementById('tabDigits').classList.toggle('active', tab === 'digits');
      document.getElementById('tabCtrl').classList.toggle('active', tab === 'ctrl');
      document.getElementById('keysPad').style.display = tab === 'keys' ? '' : 'none';
      const dp = document.getElementById('digitsPad');
      dp.style.display = tab === 'digits' ? 'grid' : 'none';
      if (tab === 'digits' && !dp.innerHTML) {
        dp.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(d => `<button class="digit-key" onclick="fireKey('${d}')">${d}</button>`).join('');
      }
      document.getElementById('ctrlPresets').style.display = tab === 'ctrl' ? 'grid' : 'none';
      // Repainted on every entry, not filled once like the digits: a preset can be sitting armed
      // as "Confirm?" from a previous visit, and the pad has to show that rather than a stale label.
      if (tab === 'ctrl') paintCtrlPresets();
    }

    // The presets exist in two places \u2014 the keys pad's ^C tab and the terminal's own dock \u2014
    // so the armed state is painted into both from one function rather than into whichever one
    // the tap came from. Painting both also means the disarm below actually repaints: the old
    // toggle-twice trick left "Confirm?" on screen, because a toggle only paints an empty grid.
    function paintCtrlPresets() {
      const html = CTRL_PRESETS.map(p => {
        const armed = p.label === ctrlConfirm;
        const cls = p.danger ? (armed ? 'ctrl-key confirm' : 'ctrl-key danger') : 'ctrl-key';
        return `<button class="${cls}" onclick="pressCtrl('${p.label}')">${armed ? 'Confirm?' : p.label}</button>`;
      }).join('');
      ['ctrlPresets', 'ctrlDockGrid'].forEach(id => { document.getElementById(id).innerHTML = html; });
    }

    function toggleCtrlDock() {
      paintCtrlPresets();
      toggleDock('ctrlDock');
    }

    function pressCtrl(label) {
      const preset = CTRL_PRESETS.find(p => p.label === label);
      if (!preset) return;
      // If composing (queue has items), just stage it
      if (keyQueue.length > 0) { keyQueue.push(...preset.keys); renderKeyQueue(); return; }
      // Two-tap confirm for danger keys
      if (preset.danger && ctrlConfirm !== label) {
        ctrlConfirm = label;
        if (window.cue) cue('error');
        paintCtrlPresets();
        setTimeout(() => { if (ctrlConfirm === label) disarmCtrl(); }, 3000);
        return;
      }
      disarmCtrl();
      sendKeys(preset.keys);
    }

    function disarmCtrl() {
      if (ctrlConfirm === null) return;
      ctrlConfirm = null;
      paintCtrlPresets();
    }

    function toggleArrows() { }
    function hideArrows() { }
    function respond(t) {
      if (!ws || !activePane) return;
      if (window.cue) cue('success');
      ws.send(JSON.stringify({ type: 'respond', pane_id: activePane, text: t }));
      // Optimistic, and corrected by the next poll: the prompt has been answered, so the approval
      // buttons go now rather than lingering for up to three seconds over an agent that is
      // already working. Re-rendered rather than emptied, so back and forward survive it.
      const a = agents.find(x => x.pane_id === activePane);
      if (a) a.status = 'busy';
      renderQuickActions();
      setTimeout(refreshPane, 500);
    }
    // Enter inserts a newline; Ctrl/Cmd+Enter sends. Reversed from P2 deliberately: a transferred
    // payload is multi-line, and submitting it on the first Enter defeats the review checkpoint.
    // Over a terminal that reversal is opt-out — see enterAction.
    document.getElementById('termInput').addEventListener('keydown', e => {
      const shell = !!activePane && isShell(activePane);
      const chord = ctrlChord(e, { shell, empty: !e.target.value, allowed: CTRL_CHORDS });
      if (chord) {
        e.preventDefault();
        sendKeys([chord]);
        showToast(`Sent ${chord}`, 'info');  // the pane may show nothing for it, and silence reads as broken
        return;
      }
      const act = enterAction(e, { enterSends: enterSendsOn(), shell: shell });
      if (act === 'send') { e.preventDefault(); sendText(); }
    });
    document.getElementById('termInput').addEventListener('input', e => autoGrow(e.target));
    // Ctrl/Cmd+Shift+P switches to the paired pane. On document, not the composer, so it works
    // whether or not the composer has focus.
    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
        if (!activePane || !pairFor(pairs, activePane)) return;
        e.preventDefault();
        switchToPartner();
      }
      // ⌥Tab / ⌥⇧Tab step the tab strip, on a screen wide enough to be showing one and only while
      // the list is what is on screen — stepping a strip hidden behind an open pane is a keypress
      // with no visible effect. Phones keep plain Tab, which is how a touch keyboard moves between
      // fields. Windows never sees this: Alt+Tab belongs to the OS there.
      // Safari can report Option+Tab by physical code with an empty key value. Capture also keeps
      // a focused filter or chip from consuming the browser shortcut before the tab strip sees it.
      if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'Tab' || e.code === 'Tab')) {
        if (activePane || window.innerWidth < 768) return;
        if (stepTab(e.shiftKey ? -1 : 1)) { e.preventDefault(); e.stopPropagation(); }
      }

      // Desktop only: , and . walk the same history as the footer arrows — the keys the arrows are
      // printed on, without the Shift that turns them into < and >. Both forms are taken, because
      // the arrows are what the keys are labelled with and a held Shift should not go dead.
      // Never steal text input or a modified shortcut.
      const WALK_KEYS = {',': -1, '<': -1, '.': 1, '>': 1};
      if (window.innerWidth < 768 || e.altKey || e.metaKey || e.ctrlKey ||
          !(e.key in WALK_KEYS) ||
          (e.target && typeof e.target.closest === 'function' &&
            e.target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      // Back is goBack, not navGo(-1): the footer ‹ leaves to the list where the walk has nothing
      // behind it, and so does the browser's own Back. A key that went dead there instead would be
      // the third control in the row disagreeing with the other two — and from the first pane
      // opened, which is the only entry most sessions have, it would look like it does nothing.
      if (WALK_KEYS[e.key] < 0) { goBack(); e.preventDefault(); }
      else if (navGo(1)) e.preventDefault();
    }, true);
    document.getElementById('termContent').addEventListener('scroll', function () {
      const el = this;
      userScrolledUp = (el.scrollHeight - el.scrollTop - el.clientHeight) > 50;
      drawSel();  // the band lives outside the scroller, so it has to be re-placed by hand
      if (el.scrollTop === 0 && paneLines < paneHistoryMax()) loadMore();
      // Back at the tail after reading history: the pane goes live again, at the depth it opens
      // on. A frozen tail is worse than fetching the history a second time, and the history is
      // one scroll up either way.
      if (!userScrolledUp && paneLines > POLL_MAX_LINES) { paneLines = 200; refreshPane(); }
    });

    if (savedUrl) setTimeout(connect, 100); else showSetup();
