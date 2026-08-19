    // --- Shared user state ---
    //
    // Four of this app's localStorage keys are not preferences about a device. A pair, a
    // conversation's name and roster, which conversation a pane is read under, and which
    // conversations are hidden are assertions about the *agents*, and a second browser that does
    // not know them is showing a different fleet. Those four are mirrored to the relay.
    //
    // localStorage stays the working copy every render reads. This is a mirror, not a move — so
    // the app is unchanged offline, unchanged against a relay built before this existed, and
    // unchanged in the frame between a keystroke and an ack.
    //
    // The theme, the font sizes, the wrap mode, the dictation switch, the relay URL and the relay
    // token are deliberately absent. They are answers to "how should this device behave", and a
    // desktop that adopts a phone's font size is a bug. The allowlist below is the whole boundary:
    // nothing outside it is read, written, or sent.

    const STATE_DOCS = {
      pairs:         { key: 'herdr_pairs' },
      conversations: { key: 'herdr_conversations' },
      conv_view:     { key: 'herdr_conv_view' },
      conv_hidden:   { key: 'herdr_conv_hidden' },
    };

    // One message per document per burst. Renaming a pair is one edit to the user and several
    // writes to the key, and the relay only needs the last of them.
    const STATE_DEBOUNCE = 500;

    // idle: no socket. pulling: state_get sent, nothing back yet. live: the relay answered.
    // off: the relay is older than this client, or never answered — the app runs as it always did.
    let stateMode = 'idle';
    // name -> the revision the relay last told us. Memory only, and cleared on every connect: a
    // reconnect re-learns them from state_get, which is cheaper than persisting a number whose
    // only correct source is the relay we just reconnected to.
    let stateRev = {};
    let stateSeeded = false;
    const stateDirty = new Set();
    const stateTimers = {};
    const stateInFlight = new Set();

    // Pure. What to do with one document on the first answer after connect.
    //   'adopt'  — the relay holds it; take it, whatever this browser had
    //   'upload' — the relay holds nothing and this browser does; seed it
    //   'idle'   — neither has anything, or they already agree
    //
    // 'adopt' is where this feature deletes something the user typed: the second browser to
    // connect loses its own pairs to the first. That is what one shared answer means, and it is
    // why stateSyncApply keeps a copy of what it overwrites.
    function stateSyncPlan(serverRev, serverBody, localBody) {
      if (serverRev > 0) return serverBody === localBody ? 'idle' : 'adopt';
      return localBody ? 'upload' : 'idle';
    }

    function stateRead(name) {
      try { return localStorage.getItem(STATE_DOCS[name].key); }
      catch (e) { return null; }  // private mode: nothing stored, nothing to sync
    }

    // Everything still waiting on its timer, sent now.
    //
    // The debounce is a 500 ms window in which an edit exists in this browser and nowhere else,
    // and a page that goes away inside it loses that edit — then adopts the relay's older document
    // on the way back in, so a deleted conversation returns and a rename undoes itself. Reloading
    // straight after an edit is ordinary, and on a phone every switch away from the browser is one
    // of these.
    function stateSyncFlushAll() {
      for (const name of Array.from(stateDirty)) {
        clearTimeout(stateTimers[name]);
        delete stateTimers[name];
        stateSyncFlush(name);
      }
    }

    // Bound on first connect rather than at load: this module is evaluated in a vm context with no
    // DOM by tests/test_state_sync.js, and reaching for one at load time is what that check exists
    // to catch. Once only, however many times the socket comes back.
    let stateUnloadBound = false;
    function stateBindUnload() {
      if (stateUnloadBound || typeof addEventListener !== 'function') return;
      stateUnloadBound = true;
      // pagehide covers reload and navigation; visibilitychange covers the phone case, where the
      // page is not unloaded at all — it is backgrounded, and may be discarded much later without
      // ever getting another event.
      addEventListener('pagehide', stateSyncFlushAll);
      addEventListener('visibilitychange', () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          stateSyncFlushAll();
        }
      });
    }

    function stateSyncOpen() {
      stateBindUnload();
      stateMode = 'pulling';
      stateSeeded = false;
      stateRev = {};
      stateInFlight.clear();
      try { ws.send(JSON.stringify({ type: 'state_get' })); }
      catch (e) { stateMode = 'off'; }
    }

    function stateSyncClose() {
      stateMode = 'idle';
      for (const name in stateTimers) { clearTimeout(stateTimers[name]); delete stateTimers[name]; }
      stateInFlight.clear();
    }

    // Called by the four save paths. Records the intent; the send happens after the burst.
    function stateSyncMark(name) {
      if (!STATE_DOCS[name]) return;
      stateDirty.add(name);
      clearTimeout(stateTimers[name]);
      stateTimers[name] = setTimeout(() => { delete stateTimers[name]; stateSyncFlush(name); },
                                     STATE_DEBOUNCE);
    }

    function stateSyncFlush(name) {
      if (stateMode !== 'live' || !stateDirty.has(name) || stateInFlight.has(name)) return;
      // Read at flush time and not at mark time: a burst of edits sends the final state, and an
      // edit that arrived while the timer was running is already included rather than queued.
      const body = stateRead(name);
      if (body === null) { stateDirty.delete(name); return; }
      stateDirty.delete(name);
      stateInFlight.add(name);
      try {
        ws.send(JSON.stringify({ type: 'state_put', name: name,
                                 rev: stateRev[name] || 0, body: body }));
      } catch (e) {
        // The socket went while we were deciding. The local copy is untouched, and the reconnect's
        // state_get settles who is ahead.
        stateInFlight.delete(name);
      }
    }

    // Write an incoming document over the local one. Returns whether anything changed.
    function stateSyncApply(name, body) {
      const key = STATE_DOCS[name].key;
      let had = null;
      try { had = localStorage.getItem(key); } catch (e) { /* private mode */ }
      if (had === body) return false;
      try {
        // Overwriting what the user typed is what "the same thing across browsers" costs. Losing
        // it without a copy is not part of the deal — one slot, last overwrite only, written here
        // and never read back by this app, so a first connect that discards a browser's pairs is
        // recoverable by hand.
        if (had) localStorage.setItem(key + '_local', had);
        if (body === null) localStorage.removeItem(key); else localStorage.setItem(key, body);
      } catch (e) { return false; }
      stateSyncRerender(name);
      return true;
    }

    // The same functions each document's own save path calls, so a change that arrived over the
    // wire lands on screen exactly as a local one does.
    //
    // Applying is not editing: nothing here may call stateSyncMark, or adopting a document would
    // immediately push it back and the two browsers would take turns writing forever. `loadPairs`
    // is the one named for pairs precisely because it only reads.
    const STATE_RERENDER = {
      pairs:         ['loadPairs', 'render', 'renderPairStrip'],
      conversations: ['renderConversations', 'renderConvBar', 'renderConvView'],
      conv_view:     ['renderConvBar', 'renderConvView'],
      conv_hidden:   ['renderConvManage', 'renderConvView'],
    };

    function stateSyncRerender(name) {
      if (name === 'conversations' || name === 'conv_hidden') {
        // The roster panel memoizes its own markup, and a roster that changed under it would
        // otherwise redraw as the one it replaced.
        try { convStandaloneHtml = ''; } catch (e) { /* shortcuts.js not loaded (vm slice) */ }
      }
      for (const fn of STATE_RERENDER[name] || []) {
        // Every target is a function declaration, so `typeof` is safe even before its file ran.
        // Each call is guarded on its own: one render throwing must not skip the rest.
        try { if (typeof window[fn] === 'function') window[fn](); }
        catch (e) { /* the page is not up yet; the next ordinary render picks the document up */ }
      }
    }

    // `state` — the answer to state_get, and the message every other browser gets when one writes.
    function stateSyncReceive(msg) {
      const docs = (msg && msg.docs) || {};
      const first = !stateSeeded;
      stateSeeded = true;
      stateMode = 'live';
      for (const name in docs) {
        if (!STATE_DOCS[name]) continue;
        const doc = docs[name] || {};
        const rev = doc.rev || 0;
        stateRev[name] = rev;
        if (stateDirty.has(name)) {
          // Edited in this browser between state_get and its answer. The answer was already in
          // flight when the user acted, so adopting it here would revert an edit made a moment
          // ago with nothing said about why. Take the revision — which is what the write needs —
          // and let the flush below push our body on top of it.
          continue;
        }
        if (first) {
          const plan = stateSyncPlan(rev, doc.body == null ? null : doc.body, stateRead(name));
          if (plan === 'adopt') stateSyncApply(name, doc.body == null ? null : doc.body);
          else if (plan === 'upload') { stateDirty.add(name); }
        } else if (rev > 0 && !stateInFlight.has(name)) {
          // A push from another browser. Not while our own write is in flight: the ack settles
          // that document, and applying an older body underneath it would undo the edit we made.
          stateSyncApply(name, doc.body == null ? null : doc.body);
        }
      }
      // Edits made while the answer was in the air, plus anything the seed decided to upload.
      for (const name of Array.from(stateDirty)) stateSyncFlush(name);
    }

    function stateSyncAck(msg) {
      const name = msg && msg.name;
      if (!STATE_DOCS[name]) return;
      stateRev[name] = msg.rev || 0;
      stateInFlight.delete(name);
      if (stateDirty.has(name)) stateSyncFlush(name);
    }

    // Someone else wrote this document between our read and our write. Their version wins and ours
    // is dropped — not retried. Retrying is exactly what turns a guarded last-write-wins back into
    // an unguarded one, and the copy stateSyncApply leaves behind is what makes the loss survivable.
    function stateSyncConflict(msg) {
      const name = msg && msg.name;
      if (!STATE_DOCS[name]) return;
      stateRev[name] = msg.rev || 0;
      stateInFlight.delete(name);
      stateDirty.delete(name);
      clearTimeout(stateTimers[name]);
      delete stateTimers[name];
      stateSyncApply(name, msg.body == null ? null : msg.body);
    }

    // A relay older than this client answers state_get with its unknown-message-type error. That is
    // a fact about the relay, not a failure to put in front of the user — swallow it once, run
    // local-only for the life of this socket, and never send a state_put it cannot answer.
    function stateSyncNoteError(text) {
      const s = String(text == null ? '' : text);
      if (stateMode === 'pulling' && /unknown message type/i.test(s) && /state_get/.test(s)) {
        stateMode = 'off';
        return true;
      }
      return false;
    }

    window.stateSyncOpen = stateSyncOpen;
    window.stateSyncClose = stateSyncClose;
    window.stateSyncMark = stateSyncMark;
    window.stateSyncReceive = stateSyncReceive;
    window.stateSyncAck = stateSyncAck;
    window.stateSyncConflict = stateSyncConflict;
    window.stateSyncNoteError = stateSyncNoteError;
