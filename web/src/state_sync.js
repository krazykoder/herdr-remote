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
      conversations: { key: 'herdr_conversations', pendingKey: 'herdr_conversations_pending' },
      conv_view:     { key: 'herdr_conv_view' },
      conv_hidden:   { key: 'herdr_conv_hidden' },
    };

    // One message per document per burst. Renaming a pair is one edit to the user and several
    // writes to the key, and the relay only needs the last of them.
    const STATE_DEBOUNCE = 500;

    // idle: no socket. pulling: state_get sent, nothing back yet. live: the relay answered.
    // off: the relay is older than this client, or never answered — the app runs as it always did.
    let stateMode = 'idle';
    let stateSocket = null;
    // name -> the revision the relay last told us. Memory only, and cleared on every connect: a
    // reconnect re-learns them from state_get, which is cheaper than persisting a number whose
    // only correct source is the relay we just reconnected to.
    let stateRev = {};
    let stateSeeded = false;
    const stateDirty = new Set();
    const stateTimers = {};
    const stateInFlight = new Set();
    const stateSent = {};

    // Pure. What to do with one document on the first answer after connect.
    //   'adopt'  — the relay holds it; take it whole
    //   'upload' — the relay holds nothing and this browser does; seed it
    //   'idle'   — neither has anything, or they already agree
    //
    // A document the relay holds is the one every other browser is already reading, so this one
    // takes it whatever it had. That is what stopped a browser writing a list it had manufactured
    // from an empty localStorage over the real one — the bug that destroyed every conversation
    // name the user had typed. The cost is paid on the other side: an edit made in the round trip,
    // and anything created offline, is adopted over. `stateSyncApply` keeps a copy of what it
    // overwrites, and the pending-create outbox below is what carries offline work across instead
    // of losing it.
    function stateSyncPlan(serverRev, serverBody, localBody) {
      if (serverRev > 0) {
        if (serverBody === localBody) return 'idle';
        return 'adopt';
      }
      return localBody ? 'upload' : 'idle';
    }

    // The shape of each document, which is the whole of what this module knows about their
    // contents. `list` names the key an envelope carries its id'd objects under; `map` is a plain
    // object keyed by something already unique. Both merge without understanding a single field.
    const STATE_SHAPE = {
      pairs:         { list: 'pairs' },
      conversations: { list: 'items' },
      conv_view:     { map: true },
      conv_hidden:   { map: true },
    };

    // The relay's document with locally-created rows appended — never a general union. `onlyExtras`
    // is the set of ids this browser made and the relay has never acknowledged; every other local
    // row loses, which is what stops a stale cache resurrecting a deleted conversation or replacing
    // a newer one. A required argument, and an empty set is a real answer meaning "append nothing":
    // a document with no outbox must never fall through to appending everything local.
    //
    // Returns null when this cannot be done safely — a body that does not parse, or one without the
    // shape the name says it has — and the caller then adopts the relay's document whole.
    function stateMerge(name, serverBody, localBody, onlyExtras) {
      const shape = STATE_SHAPE[name];
      if (!shape || serverBody == null || localBody == null) return null;
      let server, local;
      try { server = JSON.parse(serverBody); local = JSON.parse(localBody); }
      catch (e) { return null; }
      if (!server || !local || typeof server !== 'object' || typeof local !== 'object') return null;
      const win = server, lose = local, winBody = serverBody;
      if (shape.list) {
        const key = shape.list;
        if (!Array.isArray(server[key]) || !Array.isArray(local[key])) return null;
        const have = new Set(win[key].map(x => x && x.id).filter(Boolean));
        // An entry with no id cannot be told apart from one already held, so it is not carried
        // over: duplicating it on every connect is worse than losing a malformed row.
        const extra = lose[key].filter(x => x && x.id && !have.has(x.id) && onlyExtras.has(x.id));
        // Nothing to add. Returned as the winning body itself, so the caller can tell "the union
        // is one of the two I already have" from "the union is new and has to be written".
        if (!extra.length) return winBody;
        const out = Object.assign({}, win);
        out[key] = win[key].concat(extra);
        return JSON.stringify(out);
      }
      // A map's keys are not rows anyone created, so there is no outbox for them and nothing to
      // rebase: the relay's document stands.
      return serverBody;
    }

    function stateRead(name) {
      try { return localStorage.getItem(STATE_DOCS[name].key); }
      catch (e) { return null; }  // private mode: nothing stored, nothing to sync
    }

    function statePending(name) {
      const key = STATE_DOCS[name] && STATE_DOCS[name].pendingKey;
      if (!key) return null;
      try {
        const ids = JSON.parse(localStorage.getItem(key) || '[]');
        return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
      } catch (e) { return new Set(); }
    }

    function stateClearPending(name, body) {
      const pending = statePending(name);
      if (!pending || !pending.size || body == null) return;
      try {
        const items = JSON.parse(body).items;
        if (!Array.isArray(items)) return;
        for (const item of items) if (item && item.id) pending.delete(item.id);
        localStorage.setItem(STATE_DOCS[name].pendingKey, JSON.stringify(Array.from(pending)));
      } catch (e) { /* local recovery metadata is best effort */ }
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

    function stateSyncOpen(socket = ws) {
      stateBindUnload();
      // Anything the previous socket accepted but never acknowledged, retried here — the one place
      // that runs for every way a socket can be replaced. A socket that closed came through
      // stateSyncClose; a socket replaced while still open (a manual reconnect) produces a close
      // event that arrives late and is dropped as stale, so open is all that is left.
      for (const name of stateInFlight) {
        stateDirty.add(name);
        delete stateSent[name];
      }
      stateInFlight.clear();
      stateSocket = socket;
      stateMode = 'pulling';
      stateSeeded = false;
      stateRev = {};
      try { stateSocket.send(JSON.stringify({ type: 'state_get' })); }
      catch (e) { stateMode = 'off'; }
    }

    function stateSyncClose(socket) {
      // Closing socket A after socket B has opened must not take B's sync offline. WebSocket
      // events are asynchronous, and `connect()` replaces the global before A's close arrives.
      if (socket && socket !== stateSocket) return;
      stateMode = 'idle';
      for (const name in stateTimers) { clearTimeout(stateTimers[name]); delete stateTimers[name]; }
      // `send()` accepting a frame is not an ack: the socket may close after the browser handed it
      // off but before the relay replied. Those documents stay in flight — deliberately not
      // cleared here — and stateSyncOpen turns them back into dirty when a socket returns. While
      // there is no socket the set blocks nothing: every flush is already gated on `live`.
      stateSocket = null;
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
      stateSent[name] = body;
      try {
        // The socket this module learned its revisions from, never the global `ws`. `connect()`
        // assigns the new socket before it opens, so a timer firing inside that gap would hand a
        // CONNECTING socket a frame it cannot take — and the revision we are quoting belongs to
        // the old socket's conversation anyway.
        stateSocket.send(JSON.stringify({ type: 'state_put', name: name,
                                          rev: stateRev[name] || 0, body: body }));
      } catch (e) {
        // The socket went while we were deciding. Still dirty, so the reconnect's state_get learns
        // the revision and this edit goes out then — dropping it here is the silent loss the
        // in-flight retry in stateSyncClose exists to prevent, reached by the other door.
        stateInFlight.delete(name);
        delete stateSent[name];
        stateDirty.add(name);
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
        const body = doc.body == null ? null : doc.body;
        if (first) {
          const local = stateRead(name);
          const pending = statePending(name);
          if (pending && rev > 0 && local) {
            const merged = stateMerge(name, body, local, pending);
            if (merged !== null && merged !== body) {
              stateSyncApply(name, merged);
              stateDirty.add(name);
            } else {
              stateSyncApply(name, body);
              stateDirty.delete(name);
              stateClearPending(name, body);
            }
            continue;
          }
          const plan = stateSyncPlan(rev, body, local);
          if (plan === 'upload') stateDirty.add(name);
          else if (plan === 'adopt') {
            stateSyncApply(name, body);
            stateDirty.delete(name);
            stateClearPending(name, body);
          } else {
            stateDirty.delete(name);   // 'idle': the relay already holds exactly this
          }
          continue;
        }
        if (stateDirty.has(name)) {
          // Edited in this browser between state_get and its answer. The answer was already in
          // flight when the user acted, so adopting it here would revert an edit made a moment
          // ago with nothing said about why. Take the revision — which is what the write needs —
          // and let the flush below push our body on top of it.
          //
          // Unless the relay already has exactly what we were going to send. That is the ordinary
          // shape of a retry after a dropped socket: the write did reach the relay and only the
          // ack was lost, so re-sending it would bump the revision and broadcast an identical
          // document to every other browser — once per reconnect, which on a phone is often.
          if (doc.body != null && doc.body === stateRead(name)) stateDirty.delete(name);
          continue;
        }
        if (rev > 0 && !stateInFlight.has(name)) {
          // A push from another browser. Not while our own write is in flight: the ack settles
          // that document, and applying an older body underneath it would undo the edit we made.
          stateSyncApply(name, body);
          stateClearPending(name, body);
        }
      }
      // Edits made while the answer was in the air, plus anything the seed decided to upload.
      for (const name of Array.from(stateDirty)) stateSyncFlush(name);
      // And the work that was held back until the index was real. A pane the relay's index has
      // never heard of still deserves a conversation — it just has to be decided against the
      // adopted document rather than against an empty one.
      if (first) {
        try { if (typeof convAutoJoin === 'function') convAutoJoin(); }
        catch (e) { /* the view is not loaded (vm slice), or not up yet */ }
        try { if (typeof convLiveWarmRecent === 'function') convLiveWarmRecent(); }
        catch (e) { /* the live reader is unavailable in this build */ }
      }
    }

    function stateSyncAck(msg) {
      const name = msg && msg.name;
      if (!STATE_DOCS[name]) return;
      stateRev[name] = msg.rev || 0;
      stateInFlight.delete(name);
      stateClearPending(name, stateSent[name]);
      delete stateSent[name];
      if (stateDirty.has(name)) stateSyncFlush(name);
    }

    // Someone else wrote first. Existing backend rows win; only locally-created, unacknowledged
    // conversations are rebased onto the returned document.
    function stateSyncConflict(msg) {
      const name = msg && msg.name;
      if (!STATE_DOCS[name]) return;
      const remote = msg.body == null ? null : msg.body;
      // Only a document with an outbox has anything to carry across. For the others this is the
      // plain adopt it has always been: their loser is dropped, not retried, because retrying is
      // what turns a guarded last-write-wins back into an unguarded one.
      const pending = statePending(name);
      const merged = pending ? stateMerge(name, remote, stateRead(name), pending) : null;
      stateRev[name] = msg.rev || 0;
      stateInFlight.delete(name);
      delete stateSent[name];
      clearTimeout(stateTimers[name]);
      delete stateTimers[name];
      if (merged !== null && merged !== remote) {
        stateSyncApply(name, merged);
        stateDirty.add(name);
        stateSyncFlush(name);
        return;
      }
      stateDirty.delete(name);
      stateSyncApply(name, remote);
      stateClearPending(name, remote);
    }

    // Whether the first answer is still in the air. The app must not *invent* a document while
    // this is true: a browser that has never connected reads its own empty localStorage, and
    // anything built from that emptiness — an auto conversation per live pane, say — is then a
    // local edit, which the dirty branch in stateSyncReceive protects from being adopted over.
    // The result is a new browser overwriting the shared index with a fabricated copy of it.
    // Editing is still fine here; what is not fine is manufacturing state from an absence that is
    // about to be filled.
    function stateSyncPending() { return stateMode === 'pulling'; }

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
    window.stateSyncPending = stateSyncPending;
    window.stateMerge = stateMerge;
