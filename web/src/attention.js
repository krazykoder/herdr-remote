    // --- Attention ---
    //
    // A pane is asking for you when it is blocked or done and you have not looked at it since.
    // One predicate, because five surfaces signal it — the card, the hoist above the list, the
    // Project/Space/Tab chips, the pane strip, and the browser tab — and a badge that disagrees
    // with the list it points at is worse than no badge.
    //
    // Acked per *status*, not per pane. Opening a pane records what it was when you looked, so a
    // pane that later moves to the other attention status raises the badge again. Per pane, a
    // done agent would badge until it was restarted; per pane, a pane acked while blocked would
    // stay silent when it finished.
    const ACK_KEY = 'herdr_acked';
    const ATTENTION = ['blocked', 'done'];
    let acked = {};
    try { acked = JSON.parse(localStorage.getItem(ACK_KEY)) || {}; } catch (e) { acked = {}; }

    function needsAttention(a) {
      return !!a && ATTENTION.includes(a.status) && acked[a.pane_id] !== a.status;
    }

    // Which of the two an unacked pane is, or null.
    //
    // Both are worth a badge and both clear on a look, so they share needsAttention above — but
    // only one of them is an interruption. Blocked cannot proceed without you and is the thing
    // the product exists to surface: it blinks, it is red, and it is what "Needs you" hoists.
    // Done is news, not a request. Same badge in blue, sitting still, left in the Done section it
    // was always going to be listed in. Reading them as one is why a finished agent used to shout
    // in red from the top of the list as loudly as one actually waiting on an answer.
    function attentionKind(a) {
      return needsAttention(a) ? (a.status === 'blocked' ? 'blocked' : 'done') : null;
    }

    // The strongest kind in a group, for a chip that stands in for several panes. Blocked wins:
    // a chip holding one blocked pane behind four finished ones must not read as "all finished".
    function groupKind(list) {
      let kind = null;
      for (const a of list) {
        const k = attentionKind(a);
        if (k === 'blocked') return 'blocked';
        if (k) kind = k;
      }
      return kind;
    }

    const alertClass = kind => (kind ? (kind === 'blocked' ? ' alert' : ' alert alert-done') : '');

    // What the top of the list lifts out. Blocked only — that is what makes "Needs you" mean it.
    // Everything the sections below exclude is keyed on this and not on needsAttention, so a done
    // pane is listed once, under Done, still carrying its badge.
    function hoisted(a) { return attentionKind(a) === 'blocked'; }
    // Whether a pane arriving at `status` should be heard as well as seen. Not the pane you are
    // watching with the tab in front of you — you can see it finish, and a sound for it is noise.
    // Hidden is the distinction and not merely "is it open": a phone with the app backgrounded on
    // that very pane is the case the sound exists for.
    function shouldSound(paneId, status) {
      return ATTENTION.includes(status) && !(paneId === activePane && !document.hidden);
    }
    function attentionCount() { return agents.filter(needsAttention).length; }

    function saveAcked() {
      try { localStorage.setItem(ACK_KEY, JSON.stringify(acked)); }
      catch (e) { /* private mode: session-only */ }
    }
    // Looking at a pane is what clears it. Called from openTerminal rather than from a timer or a
    // scroll, because opening is the only unambiguous "I have seen this".
    function ackPane(paneId) {
      const a = agents.find(x => x.pane_id === paneId);
      if (!a || acked[paneId] === a.status) return;
      acked[paneId] = a.status;
      saveAcked();
    }
    // An ack only ever means "this is the status I looked at", so it is dropped the moment the
    // pane is no longer in it. That covers two things at once:
    //
    // - A pane that went back to work and finished again is a new thing to look at. Without this
    //   the second `done` is indistinguishable from the first and stays silent.
    // - A pane herdr no longer reports. Without this the map grows for the life of the browser
    //   profile, and a recycled pane ID would arrive pre-acked — silently, which is the bad half.
    //
    // Called from render rather than from the snapshot handler, because agent_update merges a
    // single pane without one and that merge is exactly when a badge is owed.
    function syncAcked(live) {
      const status = new Map(live.map(a => [a.pane_id, a.status]));
      let dropped = false;
      for (const [id, was] of Object.entries(acked)) {
        if (status.get(id) !== was) { delete acked[id]; dropped = true; }
      }
      if (dropped) saveAcked();
    }
