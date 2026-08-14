    let ws = null, agents = [], activePane = null, refreshInterval = null, userScrolledUp = false;
    // Shell panes, from the same snapshot as `agents`. Empty against a relay with terminal mode
    // off, which sends no `shells` key at all — its presence is the feature gate.
    let shells = [];
    let timeline = [], prevStatuses = {};

    // When each pane last did anything. herdr reports no timestamps, so this is kept here and
    // persisted — without that, a reload would make every pane look untouched, which is the one
    // reading the dot must never give. Keyed by pane_id, and a pane_id herdr later reuses costs
    // nothing worse than one dot warm for an hour.
    const SEEN_KEY = 'herdr_last_seen';
    // Two thresholds, used by both the dots and the status bar's word: under five minutes a pane
    // is still live, under an hour it is idle, past that it is cold. Declared together because
    // they are one scale — moving one without the other leaves a gap or an overlap.
    const LIVE_MS = 5 * 60 * 1000;
    const RECENT_MS = 60 * 60 * 1000;
    let lastSeen = {};

    function loadSeen() {
      try {
        const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '{}');
        const cutoff = Date.now() - RECENT_MS;
        // Anything already past the hour is dropped on the way in rather than carried forever:
        // the only question ever asked of this is "within the last hour", so older is not data.
        for (const [id, t] of Object.entries(v)) if (typeof t === 'number' && t > cutoff) lastSeen[id] = t;
      } catch (e) { lastSeen = {}; }
    }

    function noteActivity(paneId) {
      if (!paneId) return;
      lastSeen[paneId] = Date.now();
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(lastSeen)); }
      catch (e) { /* private mode: session-only */ }
    }

    // When each pane last entered a state, as this browser saw it. The relay polls herdr itself
    // and pushes a status for every pane, open or not — so this is a clock for panes nobody is
    // reading, which is exactly what a joint thread needs and what a pane read cannot give. In
    // memory only: a transition this browser was not connected for was never observed, and a
    // stored one would date a message by a session that saw a different turn.
    const statusAt = {};

    // One transition, one timestamp. The same change is announced twice — a `blocked` push and the
    // snapshot carrying it — and the recorder appends a turn when this clock moves past what it
    // last wrote, so a second stamp for a state the pane is already in would append the turn twice.
    // `seeded` is a status this browser did not watch arrive — the first snapshot after a reload,
    // where a pane sitting in an ending state finished at some unknown time while nothing was connected.
    // The stamp is still taken, because a clock that starts at zero would make the pane's next
    // turn look like its first; what the flag says is that the stamp is the reconnect, not the
    // transition, and a turn written off it has to prove itself some other way (§5.2).
    function noteStatus(paneId, status, seeded) {
      if (!paneId || !status) return;
      const at = statusAt[paneId] || (statusAt[paneId] = {});
      if (at.last === status) return;
      at.last = status;
      at[status] = Date.now();
      at.seeded = !!seeded;
    }

    function turnSeeded(paneId) {
      return !!(statusAt[paneId] || {}).seeded;
    }

    // The statuses that mean "the agent stopped writing", which is what ends a turn.
    //
    // `idle` is the one that matters and it was missing. herdr's agent lifecycle vocabulary is
    // `idle, working, blocked, unknown` — those four and no more; `herdr pane report-agent --state`
    // enumerates them, and 42s of polling a live workspace produced 1818 samples of which none was
    // `done`. So an agent finishing goes `working → idle`, and a turn clock that only watched
    // `done` and `blocked` never moved. Every consequence followed from that one omission: the
    // recorder's `end > held.lastTurn` was never true, so a transcript kept whatever its first read
    // backfilled and whatever this app sent, and never gained another word the agent said.
    //
    // `done` is kept ahead of it rather than replaced. It costs nothing, and if herdr ever
    // distinguishes "finished and unread" from "idle" this reads the better signal without
    // changing again. It is *not* dropped in favour of `idle` alone for the same reason.
    const TURN_END_STATES = ['idle', 'done', 'blocked'];

    // The end of the pane's most recent turn, or 0 while it is still writing one — then the fold's
    // own clock is already the right answer and a stale stamp would date a live message hours ago.
    function turnEnd(paneId) {
      const at = statusAt[paneId] || {};
      const end = Math.max(...TURN_END_STATES.map(s => at[s] || 0));
      return end > (at.working || 0) ? end : 0;
    }

    function endsTurn(status) {
      return TURN_END_STATES.includes(status);
    }
