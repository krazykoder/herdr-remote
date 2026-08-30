    let ws = null, agents = [], activePane = null, refreshInterval = null, userScrolledUp = false;
    // When the socket went down, or 0 while it is up. The only record this app has that it was away:
    // `prevStatuses` survives a dropped socket, so a long outage with no reload looks like a
    // continuous session to everything else. Cleared by the first snapshot after the reconnect,
    // which is the one place that has to read it.
    let wsDownSince = 0;
    // The agents this relay knows that have no live pane, from the same snapshot as `agents`.
    // Empty against a relay too old to mint agent ids, which sends no `retired` key at all — its
    // presence is the feature gate, as `shells` is for terminal mode.
    //
    // This is what a member's Restart is built from when this browser never watched it start. The
    // spawn details used to live only in the local transcript record, so a member whose pane died
    // in another browser could be offered nothing but "Restart as…".
    let retiredAgents = [];
    // The last text sent to each pane, for Resend. In memory and not persisted: a prompt worth
    // repeating is one from the session you are in, and a button that fires a week-old transfer
    // into a live agent on the first tap after a reload is a worse offer than no button.
    const lastSentText = {};
    // Shell panes, from the same snapshot as `agents`. Empty against a relay with terminal mode
    // off, which sends no `shells` key at all — its presence is the feature gate.
    let shells = [];
    let timeline = [], prevStatuses = {};

    // WebSocket payload bytes the browser can observe. Frame, TLS and transport overhead live below
    // this API and are deliberately not guessed at.
    const BANDWIDTH_KEY = 'herdr_bandwidth', BANDWIDTH_STEP_KEY = 'herdr_bandwidth_step',
      BANDWIDTH_KEEP_KEY = 'herdr_bandwidth_keep', BANDWIDTH_DATA_KEY = 'herdr_bandwidth_data',
      PANE_BANDWIDTH_DATA_KEY = 'herdr_pane_bandwidth_data', BANDWIDTH_METRIC_KEY = 'herdr_bandwidth_metric',
      BANDWIDTH_PANES_KEY = 'herdr_bandwidth_panes', BANDWIDTH_OPEN_KEY = 'herdr_bandwidth_open';
    // Buckets are a small persisted stack, not a continuous chart. Empty slots say no interval was
    // collected; they do not invent a time or a zero-byte interval.
    const BANDWIDTH_STEPS = [1, 5, 10, 30, 60];   // minutes
    const BANDWIDTH_KEEPS = [12, 60];
    const PANE_BANDWIDTH_KEEP_MS = 24 * 60 * 60 * 1000;
    const BANDWIDTH_RESUME_MS = 30 * 1000;
    let bandwidth = loadBandwidth();
    let paneBandwidth = loadPaneBandwidth();
    let bandwidthOpen = loadBandwidthOpen();
    let bandwidthSaveTimer = null;

    function bandwidthOn() {
      try { return localStorage.getItem(BANDWIDTH_KEY) === 'on'; }
      catch (e) { return false; }
    }

    function bandwidthPick(key, allowed, fallback) {
      let v;
      try { v = Number(localStorage.getItem(key)); } catch (e) { /* private mode */ }
      return allowed.indexOf(v) < 0 ? (fallback || allowed[0]) : v;
    }

    function bandwidthStepMin() { return bandwidthPick(BANDWIDTH_STEP_KEY, BANDWIDTH_STEPS, 5); }
    function bandwidthKeep() { return bandwidthPick(BANDWIDTH_KEEP_KEY, BANDWIDTH_KEEPS); }
    function bandwidthBucketMs() { return bandwidthStepMin() * 60 * 1000; }
    function bandwidthCount() { return bandwidthKeep(); }

    function loadBandwidth() {
      try {
        const saved = JSON.parse(localStorage.getItem(BANDWIDTH_DATA_KEY) || '[]');
        return Array.isArray(saved) ? saved.filter(b => b && Number.isFinite(b.at) &&
          Number.isFinite(b.sent) && Number.isFinite(b.received) && b.sent >= 0 && b.received >= 0)
          .sort((a, b) => b.at - a.at).slice(0, Math.max.apply(null, BANDWIDTH_KEEPS)) : [];
      } catch (e) { return []; }
    }

    function saveBandwidth() {
      try { localStorage.setItem(BANDWIDTH_DATA_KEY, JSON.stringify(bandwidth)); }
      catch (e) { /* private mode: session-only */ }
    }

    // A reload during normal polling is not an outage. Resume only the bucket explicitly left
    // open and only while it was active very recently; disconnect and tracking-off remove its key.
    function loadBandwidthOpen() {
      try {
        const at = Number(localStorage.getItem(BANDWIDTH_OPEN_KEY));
        const bucket = bandwidth.find(b => b.at === at);
        return bucket && Number.isFinite(bucket.last) && Date.now() - bucket.last < BANDWIDTH_RESUME_MS ? bucket : null;
      } catch (e) { return null; }
    }

    function saveBandwidthOpen() {
      try {
        if (bandwidthOpen) localStorage.setItem(BANDWIDTH_OPEN_KEY, String(bandwidthOpen.at));
        else localStorage.removeItem(BANDWIDTH_OPEN_KEY);
      } catch (e) { /* private mode: session-only */ }
    }

    // Payloads arrive every poll. Keep live values in memory and batch the synchronous storage
    // write; pagehide flushes the small pending tail before a normal refresh.
    function flushBandwidth() {
      if (bandwidthSaveTimer) clearTimeout(bandwidthSaveTimer);
      bandwidthSaveTimer = null;
      saveBandwidth();
      savePaneBandwidth();
      saveBandwidthOpen();
    }

    function queueBandwidthSave() {
      if (bandwidthSaveTimer) return;
      bandwidthSaveTimer = setTimeout(flushBandwidth, 1000);
    }

    // Guarded because these modules are also run as slices in a vm context, which has no window and
    // no event target — an unguarded call there throws at load and takes the whole suite with it.
    if (typeof addEventListener === 'function') addEventListener('pagehide', flushBandwidth);

    function loadPaneBandwidth() {
      try {
        const saved = JSON.parse(localStorage.getItem(PANE_BANDWIDTH_DATA_KEY) || '{}');
        return saved && typeof saved === 'object' ? Object.fromEntries(Object.entries(saved).filter(([, b]) =>
          b && Number.isFinite(b.ping) && Array.isArray(b.buckets)).map(([key, b]) => [key, {
          ping: b.ping,
          buckets: b.buckets.filter(x => x && Number.isFinite(x.at) && Number.isFinite(x.sent) &&
            Number.isFinite(x.received)).slice(0, Math.max.apply(null, BANDWIDTH_KEEPS))
        }])) : {};
      } catch (e) { return {}; }
    }

    function savePaneBandwidth() {
      try { localStorage.setItem(PANE_BANDWIDTH_DATA_KEY, JSON.stringify(paneBandwidth)); }
      catch (e) { /* private mode: session-only */ }
    }

    // A wider bucket is not a merge of narrower ones: re-cutting would invent edge values. Start
    // a new stack when its interval changes; changing how many records are shown keeps the stack.
    function setBandwidthStep(min) {
      try { localStorage.setItem(BANDWIDTH_STEP_KEY, String(min)); } catch (e) { /* session-only */ }
      bandwidth = [];
      paneBandwidth = {};
      resetBandwidthBucket();
      saveBandwidth();
      savePaneBandwidth();
      syncBandwidthRange();
      renderBandwidth();
    }

    function setBandwidthKeep(count) {
      try { localStorage.setItem(BANDWIDTH_KEEP_KEY, String(count)); } catch (e) { /* session-only */ }
      syncBandwidthRange();
      renderBandwidth();
    }

    function bandwidthMetric() {
      try { const v = localStorage.getItem(BANDWIDTH_METRIC_KEY); return ['total', 'sent', 'received'].includes(v) ? v : 'total'; }
      catch (e) { return 'total'; }
    }

    function setBandwidthMetric(metric) {
      if (!['total', 'sent', 'received'].includes(metric)) return;
      try { localStorage.setItem(BANDWIDTH_METRIC_KEY, metric); } catch (e) { /* session-only */ }
      renderBandwidth();
    }

    function bandwidthPanesOn() {
      try { return localStorage.getItem(BANDWIDTH_PANES_KEY) === 'on'; }
      catch (e) { return false; }
    }

    function setBandwidthPanes(on) {
      try { localStorage.setItem(BANDWIDTH_PANES_KEY, on ? 'on' : 'off'); } catch (e) { /* session-only */ }
      renderBandwidth();
    }

    function syncBandwidthRange() {
      const step = document.getElementById('bandwidthStep');
      const keep = document.getElementById('bandwidthKeep');
      if (step) step.value = String(bandwidthStepMin());
      if (keep) keep.value = String(bandwidthKeep());
    }

    function setBandwidthOn(on) {
      try { localStorage.setItem(BANDWIDTH_KEY, on ? 'on' : 'off'); }
      catch (e) { /* private mode: session-only */ }
      // Turning collection off closes the open interval rather than leaving it to be resumed later:
      // a bucket that spans an hour of not looking, labelled with the minute it started, is a
      // measurement of nothing. Turning it back on opens a fresh one.
      if (!on) { flushBandwidth(); resetBandwidthBucket(); }
      const input = document.getElementById('bandwidthOn');
      if (input) input.checked = !!on;
      renderBandwidth();
    }

    // The counterpart of keeping it: what has been recorded stays on this device until it is either
    // pushed off the end of the stack or thrown away here. Off only stops collecting.
    function clearBandwidth() {
      bandwidth = [];
      paneBandwidth = {};
      resetBandwidthBucket();
      saveBandwidth();
      savePaneBandwidth();
      renderBandwidth();
      showToast('Cleared the recorded payload data');
    }

    function bandwidthBytes(data) {
      if (typeof data === 'string') return new TextEncoder().encode(data).length;
      if (data && typeof data.byteLength === 'number') return data.byteLength;
      if (data && typeof data.size === 'number') return data.size;
      return 0;
    }

    function noteBandwidth(direction, data, now) {
      if (!bandwidthOn()) return;
      const size = bandwidthBucketMs();
      const at = now || Date.now();
      if (!bandwidthOpen || at < bandwidthOpen.at || at - bandwidthOpen.at >= size) {
        bandwidthOpen = {at: at, last: at, sent: 0, received: 0};
        bandwidth.push(bandwidthOpen);
      }
      const bucket = bandwidthOpen;
      bucket[direction] += bandwidthBytes(data);
      bucket.last = at;
      bandwidth.sort((a, b) => b.at - a.at);
      bandwidth = bandwidth.slice(0, Math.max.apply(null, BANDWIDTH_KEEPS));
      queueBandwidthSave();
      // Whether the view is on screen, not which display mode it happens to use: PANELS decides
      // that, and a counter that stopped updating because a panel changed layout would be a
      // silent failure.
      const view = document.getElementById('timelineView');
      if (view && view.style.display !== 'none') renderBandwidth();
    }

    // Only read_pane and pane_content name a pane. Shared snapshots stay in the global total: a
    // browser cannot honestly assign their bytes to one agent.
    function notePaneBandwidth(paneId, direction, data, now) {
      if (!bandwidthOn() || !paneId) return;
      const at = now || Date.now();
      const pane = paneBandwidth[paneId] || (paneBandwidth[paneId] = {ping: at, buckets: []});
      const bucketAt = bandwidthOpen ? bandwidthOpen.at : at;
      const bucket = pane.buckets.find(b => b.at === bucketAt) ||
        (pane.buckets.push({at: bucketAt, sent: 0, received: 0}), pane.buckets[pane.buckets.length - 1]);
      bucket[direction] += bandwidthBytes(data);
      if (direction === 'sent') pane.ping = at;
      pane.buckets.sort((a, b) => b.at - a.at);
      pane.buckets = pane.buckets.slice(0, Math.max.apply(null, BANDWIDTH_KEEPS));
      // herdr reuses a pane_id once its pane is gone, and these totals are cumulative — a day-old
      // entry inherited by a new agent would report another session's traffic under its name. A day
      // is also longer than any pane worth attributing bytes to has been quiet for.
      const stale = at - PANE_BANDWIDTH_KEEP_MS;
      const keys = Object.keys(paneBandwidth)
        .filter(key => { if (paneBandwidth[key].ping >= stale) return true;
          delete paneBandwidth[key]; return false; })
        .sort((a, b) => paneBandwidth[b].ping - paneBandwidth[a].ping);
      keys.slice(200).forEach(key => delete paneBandwidth[key]);
      queueBandwidthSave();
      const view = document.getElementById('timelineView');
      if (view && view.style.display !== 'none') renderBandwidth();
    }

    function resetBandwidthBucket() { bandwidthOpen = null; saveBandwidthOpen(); }

    // Which record, if any, is still being filled — the only place that knows it, because a bucket
    // starts at the message that opened it rather than on a clock boundary, so no arithmetic over
    // `at` can recover it. Read by the table to mark the one number that is still moving.
    function bandwidthLiveAt() {
      return bandwidthOpen && bandwidthOn() &&
        Date.now() - bandwidthOpen.at < bandwidthBucketMs() ? bandwidthOpen.at : 0;
    }

    function bandwidthBuckets() {
      const kept = bandwidth.slice().sort((a, b) => b.at - a.at).slice(0, bandwidthCount());
      return kept.concat(Array.from({length: bandwidthCount() - kept.length}, () =>
        ({empty: true, sent: 0, received: 0})));
    }

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
