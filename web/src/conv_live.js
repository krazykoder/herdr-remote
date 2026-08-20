    // --- The relay's record, read live ---
    //
    // The thread this app draws is folded out of pane reads, so it knows what *this browser* was
    // connected for and nothing else: a phone that was asleep, a tab that was closed, a socket that
    // flapped all leave holes the recovery machinery then spends reads closing.
    //
    // The relay has no such gap. It polls herdr itself and writes one row per turn end for every
    // pane, watched or not, into the record the arbitrator reads — see
    // `.workflow/03_specs/2026-08-17_arbitrator_spec.md`. That is the ground truth; the local
    // transcript is a cache of the part of it this browser happened to witness.
    //
    // So this is a second *source* for the same view, never a second view. The thread renders
    // exactly as it always did — same bubbles, same picks, same badges — and the toggle beside the
    // hanging ⟳ decides which record is behind it. Nothing here writes: a live fetch reads the
    // relay's record and leaves this browser's own transcript untouched, which is what makes the
    // toggle safe to flip while looking at something.
    const CONV_LIVE_KEY = 'herdr_conv_live';

    // What one fetch asks for. The relay clamps to QUERY_ROWS_MAX and to a byte ceiling and says so
    // in `truncated`, so asking for the ceiling means a long conversation shows its recent end
    // rather than an arbitrary window of it.
    const CONV_LIVE_ROWS = 200;

    // How far back a reader may walk one pane, by hand. Ten presses of CONV_LIVE_ROWS.
    //
    // A ceiling and not "until the record runs out", because this store shares an IndexedDB budget
    // with the transcripts: an uncapped walk back through a busy pane evicts another conversation's
    // history to make room, and a silent eviction of something the reader did not ask about is a
    // worse outcome than a button that stops. What it costs is visible while it is spent — the
    // storage panel reports this store per pane.
    const CONV_LIVE_DEEP_MAX = 2000;

    // The thread re-renders on every poll of the open pane, and a query per render would be a
    // database read every three seconds for a thread nobody touched. A turn ending pushes straight
    // past this — see `convLiveSync` — so the cadence costs freshness only while nothing happens.
    const CONV_LIVE_EVERY = 5000;

    // The record, one bucket per pane fingerprint rather than one answer per roster, so a pane in
    // two conversations is fetched once and the second thread draws with no round trip.
    //
    //   Map<fpKey, { turns: Array, syncedTo: number, lastFetch: number,
    //                 depth: {paneId: rows}, ended: {paneId: true} }>
    //
    // `depth` is how many rows of each pane this browser has asked to keep — CONV_LIVE_ROWS until a
    // reader walks back, and raised a window at a time by `convLiveOlder`. `ended` is the pane the
    // record had nothing older for, which is what lets the button say so rather than go quiet.
    //
    // `syncedTo` is the id this fingerprint has been *answered through*, which is not the same as
    // the id of its newest turn. A roster query covers every member jointly, so a member that
    // produced nothing is still proven empty up to the highest id the answer carried. Storing the
    // newest-turn id instead would make a quiet pane look permanently stale and re-ask for its
    // whole history every cadence — see `convLiveFetch`.
    const convLiveCache = new Map();
    let convLiveTruncated = false, convLiveError = '';

    // --- "Asking the relay", said only while it is true ---
    //
    // The record arrives in windows and in deltas, so a thread can be on screen and still be short
    // of what the relay holds. A reader cannot tell that apart from a thread that is simply
    // finished, and the difference is between waiting a moment and going to look for a bug.
    //
    // Transient, and it never says the opposite. A resting "synced" would be a claim this client
    // has no way to back: the relay answers a bounded window and reports no total, so "everything
    // is here" is not something the answer contains. Saying nothing at rest is the honest state.
    let convLiveAsking = 0, convLiveAskedAt = 0;

    // A socket that dies with a question in it never answers. Past this the ask is presumed lost —
    // a pill that stays lit forever is worse than no pill.
    const CONV_LIVE_ASK_TIMEOUT = 15000;

    function convLiveSyncing() {
      if (convLiveAsking <= 0) return false;
      if (Date.now() - convLiveAskedAt > CONV_LIVE_ASK_TIMEOUT) { convLiveAsking = 0; return false; }
      return true;
    }

    function convLiveAskSent(n) {
      convLiveAsking += n;
      convLiveAskedAt = Date.now();
      if (typeof hangSync === 'function') {
        hangSync();
        // Nothing else redraws on a timeout expiring, and the pill has to be able to go out on its
        // own when the answer never comes.
        setTimeout(hangSync, CONV_LIVE_ASK_TIMEOUT + 100);
      }
    }

    function convLiveAskDone(all) {
      convLiveAsking = all ? 0 : Math.max(0, convLiveAsking - 1);
      if (typeof hangSync === 'function') hangSync();
    }

    // One host has two spellings: the relay's snapshot and the record both name the local host
    // `local`, but a pane that reached this app with no host at all is keyed under ''. Folded here
    // so a bucket is not filled under one spelling and read under the other.
    function convNormHost(h) {
      return !h || h === 'local' ? 'local' : h;
    }

    function convFpKey(fp) {
      if (!fp) return '';
      if (Array.isArray(fp)) {
        return JSON.stringify([convNormHost(fp[0]), fp[1] || '', fp[2] || '']);
      }
      return String(fp);
    }

    function convLiveBucket(fpKey) {
      let bucket = convLiveCache.get(fpKey);
      if (!bucket) {
        bucket = { turns: [], syncedTo: 0, lastFetch: 0, depth: {}, ended: {} };
        convLiveCache.set(fpKey, bucket);
      }
      return bucket;
    }

    // What this browser is keeping of the relay's record, per fingerprint, for the storage panel.
    //
    // Measured off the in-memory buckets rather than by reading the store back: they are written
    // through, so they are what is on disk, and the panel must not open a second transaction per
    // draw to learn what it already has.
    function convLiveCacheBytes() {
      const out = new Map();
      for (const [fpKey, bucket] of convLiveCache) {
        try { out.set(fpKey, JSON.stringify(bucket.turns || []).length); } catch (e) { /* skip */ }
      }
      return out;
    }

    // --- Kept on disk ---
    //
    // The record survives a refresh, a closed tab, and a week away, and reads with the relay down.
    // Two things follow from persisting it, and both are the point:
    //
    //   * the delta spans sessions. `syncedTo` was a session variable, so every reload re-asked for
    //     the window this feature exists to avoid re-asking for.
    //   * it outlives the relay's own pruning. The relay drops its oldest rows at
    //     HERDR_CONV_LOG_MAX, and what a client already holds is not dropped with them.
    //
    // Kept in its own store and never folded into a transcript: the two are different sources for
    // one conversation, and the whole value of the toggle is being able to tell them apart.
    const CONV_LIVE_KEEP = 400;      // fingerprints kept on disk, oldest touched evicted first

    // The buckets read back from disk, once per page. Everything that reads the cache awaits it, so
    // a render arriving before the disk does draws the record rather than an empty thread.
    let convLiveLoaded = null;
    // Fingerprints this session has heard the relay answer for. The first ask for each is the whole
    // window rather than a delta: a watermark restored from disk names an id in a database this
    // session has never spoken to, and a relay whose record was reset or moved would answer that
    // delta with silence forever. One window per fingerprint per session settles it.
    const convLiveVerified = new Set();

    function convLiveHydrate() {
      if (convLiveLoaded) return convLiveLoaded;
      convLiveLoaded = (async () => {
        if (typeof openConvDB !== 'function') return;
        const db = await openConvDB();
        if (!db) return;
        try {
          const read = db.transaction(CONV_LIVE_STORE, 'readonly').objectStore(CONV_LIVE_STORE);
          for (const rec of (await idbReq(read.getAll())) || []) {
            if (!rec || !rec.fp || convLiveCache.has(rec.fp)) continue;
            convLiveCache.set(rec.fp, {
              turns: rec.turns || [], syncedTo: rec.syncedTo || 0, lastFetch: 0,
              // Without this a walk back would survive the reload only until the next answer, when
              // the trim would cut every pane to one window again and throw it all away.
              depth: rec.depth || {}, ended: rec.ended || {},
              // Answered by the relay once, on a previous day. Without this the thread would say
              // "Reading the relay's record…" over rows it is already drawing.
              answered: true,
            });
          }
        } catch (e) { /* the session keeps its own copy in memory */ }
      })();
      return convLiveLoaded;
    }

    // Write-through, per fingerprint, after the answer that changed it. Failures are silent by
    // design: a full quota costs this session's durability and nothing else, and the thread on
    // screen is already drawn from memory.
    async function convLivePersist(fpKeys) {
      if (typeof openConvDB !== 'function') return;
      const db = await openConvDB();
      if (!db) return;
      const now = Date.now();
      try {
        const store = db.transaction(CONV_LIVE_STORE, 'readwrite').objectStore(CONV_LIVE_STORE);
        await Promise.all(Array.from(fpKeys || [], fpKey => {
          const bucket = convLiveCache.get(fpKey);
          if (!bucket) return null;
          return idbReq(store.put({ fp: fpKey, turns: bucket.turns || [],
            syncedTo: bucket.syncedTo || 0, depth: bucket.depth || {},
            ended: bucket.ended || {}, touched: now }));
        }).filter(Boolean));
      } catch (e) { return; }
      await convLiveEvict(db);
    }

    // The store's own ceiling. The per-fingerprint cap (CONV_LIVE_ROWS) bounds one pane; this bounds
    // how many panes are kept at all, so a machine that has run hundreds of sessions does not carry
    // every one of them forever. Oldest touched first, which is the same rule the transcripts use.
    async function convLiveEvict(db) {
      try {
        const read = db.transaction(CONV_LIVE_STORE, 'readonly').objectStore(CONV_LIVE_STORE);
        const count = await idbReq(read.count());
        if (count <= CONV_LIVE_KEEP) return;
        const byAge = db.transaction(CONV_LIVE_STORE, 'readwrite').objectStore(CONV_LIVE_STORE);
        const stale = (await idbReq(byAge.index('touched').getAllKeys())) || [];
        for (const key of stale.slice(0, count - CONV_LIVE_KEEP)) byAge.delete(key);
      } catch (e) { /* the cap is a tidy-up, not a correctness property */ }
    }

    // Everything this browser is keeping of the relay's record, dropped in one go. The transcripts
    // are untouched: this is the copy that can always be fetched again.
    async function convLiveForget() {
      convLiveCache.clear();
      convLiveVerified.clear();
      if (typeof openConvDB !== 'function') return;
      const db = await openConvDB();
      if (!db) return;
      try {
        await idbReq(db.transaction(CONV_LIVE_STORE, 'readwrite')
          .objectStore(CONV_LIVE_STORE).clear());
      } catch (e) { /* nothing to do about it, and nothing lost that cannot be re-read */ }
    }

    // The Settings button. Confirmed, because it is a delete — and worded as what it costs, which
    // is nothing except where the relay has pruned what this browser still had.
    async function forgetLiveRecord() {
      if (!confirm('Forget the relay record kept on this device? It is read again the next time a '
        + 'thread is opened, except for anything the relay has since pruned.')) return;
      await convLiveForget();
      if (typeof renderConvView === 'function') renderConvView();
      if (typeof renderConvAnalytics === 'function') renderConvAnalytics();
      showToast('Forgot the kept copy of the relay’s record');
    }

    function convLiveOn() {
      try { return localStorage.getItem(CONV_LIVE_KEY) === 'on'; } catch (e) { return false; }
    }

    function toggleConvLive() {
      const on = !convLiveOn();
      try { localStorage.setItem(CONV_LIVE_KEY, on ? 'on' : 'off'); }
      catch (e) { /* private mode: this session only */ }
      // Kept rather than dropped, now that a row belongs to a bucket and a bucket belongs to a
      // pane: what comes back on screen is this reader's own members and never the thread they
      // switched away from. Only the cadence goes, so the way back in is drawn at once and
      // corrected by the answer to the ask that follows it.
      convLiveInvalidate();
      convLiveError = '';
      renderConvView();
      if (typeof renderConvStandalone === 'function') renderConvStandalone(true);
      hangSync();
      showToast(on ? 'Reading the relay’s record' : 'Reading this browser’s transcript');
    }

    // A member key is [host, pane_id, agent, cwd]; a fingerprint is that key with the pane id taken
    // out. herdr changes pane ids on every restart — the lesson `healPairs` exists for — so the
    // fingerprint is what survives a respawn and what the record is indexed by.
    function convKeyFingerprint(key) {
      try {
        const p = JSON.parse(key);
        return Array.isArray(p) && p.length >= 4 ? [convNormHost(p[0]), p[2] || '', p[3] || ''] : null;
      } catch (e) { return null; }
    }

    // The member keys the last roster ask was made for. A fingerprint is `[host, agent, cwd]` and
    // several panes can share one — four claude panes in one repository do — so an answer that came
    // back truncated has to be refilled pane by pane, and this is what says which panes those are.
    let convLiveAsked = [];

    // "Ask the relay again on the way through." Called where something has happened that the record
    // already knows about and this cache does not — a turn ending, or a reader pressing ⟳. It drops
    // the cadence rather than the rows: the next render re-asks, and asks only for what is new.
    // Passing no keys invalidates every bucket, which is what the callers that do not know whose
    // thread is on screen want.
    function convLiveInvalidate(keys) {
      const fps = (keys || []).map(convKeyFingerprint).filter(Boolean);
      const buckets = fps.length
        ? fps.map(fp => convLiveCache.get(convFpKey(fp))).filter(Boolean)
        : Array.from(convLiveCache.values());
      for (const bucket of buckets) bucket.lastFetch = 0;
    }

    // One query for the whole roster. Sent only when the answer on hand cannot serve: a member with
    // no bucket yet, or a bucket old enough to be worth asking again. `force` is a turn ending or
    // the ⟳, both of which are someone saying "now".
    function convLiveFetch(keys, force, background) {
      if (!background && !convLiveOn()) return;
      const fps = (keys || []).map(convKeyFingerprint).filter(Boolean);
      if (!fps.length) return;
      // Whatever is on disk, before deciding anything: the watermark that says what to ask for
      // lives there now, and asking without it would re-fetch a window this browser already holds.
      // The render that follows draws from the same buckets, so a thread is on screen either way.
      if (!convLiveLoaded) {
        convLiveHydrate().then(() => {
          if (background) convLiveFetch(keys, force, true);
          else renderConvView();
        });
        return;
      }
      if (!ws || ws.readyState !== 1) {
        // Only when there is nothing to show. With the record on disk, a relay that is down or a
        // phone with no signal is a thread that is behind, not a thread that is empty — and saying
        // "cannot be read right now" over rows the reader is looking at is simply false.
        const held = fps.some(fp => (convLiveCache.get(convFpKey(fp)) || {}).turns?.length);
        convLiveError = held ? '' : 'Not connected — the relay’s record cannot be read right now.';
        return;
      }
      const now = Date.now();
      let needsFetch = !!force;
      // A fingerprint restored from disk carries a watermark from another session, possibly from
      // another copy of the relay's database. Its first ask is the window, and it is a delta after
      // that — see convLiveVerified.
      for (const fp of fps) {
        if (!convLiveVerified.has(convFpKey(fp))) { force = true; needsFetch = true; }
      }
      // The floor over the roster, not the ceiling: the buckets were last answered by different
      // queries, so the only id every member is proven current through is the lowest of them. A
      // member with no bucket has been answered through nothing, and the query goes out whole.
      let syncedTo = Infinity;
      for (const fp of fps) {
        const bucket = convLiveCache.get(convFpKey(fp));
        if (!bucket) { syncedTo = 0; needsFetch = true; continue; }
        if (bucket.syncedTo < syncedTo) syncedTo = bucket.syncedTo;
        if (now - bucket.lastFetch >= CONV_LIVE_EVERY) needsFetch = true;
      }
      if (!needsFetch) return;

      for (const fp of fps) convLiveBucket(convFpKey(fp)).lastFetch = now;

      convLiveAsked = (keys || []).slice();
      const payload = { type: 'conv_log', fingerprints: fps, last: CONV_LIVE_ROWS };
      // A delta only when every member is proven current through the same id. `force` still asks
      // for the window, because the reader pressing ⟳ is asking for the record and not for the
      // difference — a row edited or pruned behind this client's back is repaired by that ask and
      // by nothing else.
      if (!force && syncedTo > 0 && syncedTo !== Infinity) payload.since_id = syncedTo;
      ws.send(JSON.stringify(payload));
      convLiveAskSent(1);
    }

    // A fresh browser starts with no transcript cache, so a landing page of conversations it has
    // never watched has nothing to count. Warm the recent end of the user's work and leave older
    // threads to the on-demand reader.
    //
    // Not forced. This runs on the first answer of every connect, which on a phone is every time
    // it comes out of a pocket, and forcing would re-ask the whole recent roster each time; the
    // ordinary freshness rule already asks for a member with no bucket, which is the fresh browser
    // this exists for.
    function convLiveWarmRecent() {
      if (typeof loadConvIndex !== 'function') return;
      const items = loadConvIndex();
      const recent = items.slice().sort((a, b) => {
        const seen = c => Math.max(0, ...((c.members || []).map(m => Number(m.seen) || 0)));
        return seen(b) - seen(a) || (Number(b.created) || 0) - (Number(a.created) || 0);
      }).slice(0, 5);
      const keys = [...new Set(recent.flatMap(c => (c.members || []).map(m => m.key)).filter(Boolean))];
      convLiveFetch(keys, false, true);
    }

    // The newest rows of each pane, in reading order. Pure.
    //
    // CONV_LIVE_ROWS each, unless a reader has walked that pane back: `depth` is what
    // `convLiveOlder` raised, and without reading it this would discard every backfilled row on
    // the same tick it arrived — the walk back would fetch, trim, and show nothing.
    function convLiveTrim(turns, depth) {
      const kept = [];
      const seen = new Map();
      // Backwards: the newest end is the end that is kept, which is the same end the relay's own
      // window keeps.
      for (let i = turns.length - 1; i >= 0; i--) {
        const t = turns[i];
        const pane = t.pane_id || '';
        const cap = Math.min((depth && depth[pane]) || CONV_LIVE_ROWS, CONV_LIVE_DEEP_MAX);
        const n = seen.get(pane) || 0;
        if (n >= cap) continue;
        seen.set(pane, n + 1);
        kept.push(t);
      }
      return kept.reverse();
    }

    // --- Walking one thread backwards, because a reader asked ---
    //
    // Everything above goes forwards. The relay answers the newest `last` rows inside a byte
    // ceiling, and `since_id` asks for what has happened since — so a pane with a thousand turns
    // shows its recent end and grows from there, and the rest is unreachable by any question this
    // client knew how to ask.
    //
    // This is the other direction, and it is deliberately manual. The automatic behaviour is
    // unchanged: nothing walks back on its own, because the rows are the reader's disk and the
    // relay's time, and neither should be spent on history nobody asked to see.

    // Which pane ids a roster accounts for — one that is live right now, or one the roster names.
    // A row carrying any of them belongs to that member and to nobody else; a row from a pane that
    // has exited has no claimant and goes to whoever holds the fingerprint now, which is what keeps
    // a respawned pane's history attached to it.
    function convLiveClaimed(keys) {
      const claimed = new Set();
      for (const x of (typeof agents !== 'undefined' ? agents : [])) {
        if (x.pane_id) claimed.add(x.pane_id);
      }
      for (const k of (keys || [])) claimed.add(convPaneOfKey(k));
      return claimed;
    }

    function convPaneOfKey(k) {
      try { return (JSON.parse(k) || [])[1] || ''; } catch (e) { return ''; }
    }

    function convLiveRowIsMine(t, mine, claimed) {
      const pid = t.pane_id || '';
      return !(mine && pid && pid !== mine && claimed.has(pid));
    }

    // The oldest row this browser holds for one member, which is the id the next window back is
    // asked for. 0 when it holds nothing — there is no window before nothing, and the ordinary
    // forward fetch is what that member needs.
    function convLiveOldestSeq(key, claimed) {
      const fp = convKeyFingerprint(key);
      const bucket = fp && convLiveCache.get(convFpKey(fp));
      if (!bucket) return 0;
      const mine = convPaneOfKey(key);
      let oldest = 0;
      for (const t of bucket.turns) {
        if (!t.seq || !convLiveRowIsMine(t, mine, claimed)) continue;
        if (!oldest || t.seq < oldest) oldest = t.seq;
      }
      return oldest;
    }

    // Whether there is a window back left to ask for, per member. Three ways to be finished, and
    // the button has to be able to tell all three from "not yet asked": the record said it had
    // nothing older, the pane is at the ceiling, or this browser holds nothing to walk back from.
    function convLiveCanLoadOlder(keys) {
      if (!convLiveOn()) return false;
      const claimed = convLiveClaimed(keys);
      return (keys || []).some(key => {
        const fp = convKeyFingerprint(key);
        const bucket = fp && convLiveCache.get(convFpKey(fp));
        if (!bucket) return false;
        const pane = convPaneOfKey(key);
        if (bucket.ended[pane]) return false;
        if ((bucket.depth[pane] || CONV_LIVE_ROWS) >= CONV_LIVE_DEEP_MAX) return false;
        return convLiveOldestSeq(key, claimed) > 0;
      });
    }

    // One window back for every member that has one, asked pane by pane.
    //
    // Pane-scoped rather than over the roster, and not because it is tidier: `until_id` is one
    // member's oldest row, and several members do not share one. Asked jointly, the member with
    // the oldest row would set the bound for all of them and the others would be handed a window
    // they already hold.
    function convLiveOlder(keys) {
      if (!ws || ws.readyState !== 1) return 0;
      const claimed = convLiveClaimed(keys);
      let asked = 0;
      for (const key of (keys || [])) {
        const fp = convKeyFingerprint(key);
        if (!fp) continue;
        const fpKey = convFpKey(fp);
        const bucket = convLiveCache.get(fpKey);
        if (!bucket) continue;
        const pane = convPaneOfKey(key);
        if (bucket.ended[pane]) continue;
        const have = Math.min(bucket.depth[pane] || CONV_LIVE_ROWS, CONV_LIVE_DEEP_MAX);
        if (have >= CONV_LIVE_DEEP_MAX) continue;
        const oldest = convLiveOldestSeq(key, claimed);
        if (!oldest) continue;
        // Raised before the answer, not after it: the trim runs on the tick the rows land, and a
        // ceiling still at one window would throw them away before anything drew them.
        bucket.depth[pane] = Math.min(have + CONV_LIVE_ROWS, CONV_LIVE_DEEP_MAX);
        ws.send(JSON.stringify({ type: 'conv_log', fingerprints: [fp], pane: pane,
                                 until_id: oldest, last: CONV_LIVE_ROWS }));
        asked++;
      }
      if (asked) convLiveAskSent(asked);
      return asked;
    }

    // A window that did not reach the end, spent again on one pane at a time.
    //
    // The record is asked by fingerprint, because that is what survives herdr renumbering every
    // pane on restart. But a fingerprint is an agent in a directory, not a pane: four claude panes
    // in one repository are one fingerprint and 400 turns, and the relay answers the newest 200 of
    // them — cut further by a 64 KB bound. Whoever spoke most recently takes the whole window, and
    // a pane with 181 turns of its own renders a handful. Which is not "the relay has nothing for
    // this pane"; it is this client asking a question whose answer it then throws most of away.
    //
    // So when the answer says it was truncated, ask again for each pane the roster actually names.
    // `pane` narrows the same query, so each of those windows is spent on one pane. Once only, per
    // fingerprint per cadence — a pane-scoped answer never triggers another round.
    function convLiveRefill(fingerprints) {
      if (!ws || ws.readyState !== 1) return;
      const wanted = new Set((fingerprints || []).map(convFpKey));
      const now = Date.now();
      const sent = new Set();
      for (const key of convLiveAsked) {
        const fp = convKeyFingerprint(key);
        if (!fp) continue;
        const fpKey = convFpKey(fp);
        if (!wanted.has(fpKey)) continue;
        let pane = '';
        try { pane = (JSON.parse(key) || [])[1] || ''; } catch (e) { continue; }
        if (!pane || sent.has(pane)) continue;
        sent.add(pane);
        const bucket = convLiveBucket(fpKey);
        bucket.refilled = now;
        ws.send(JSON.stringify(
          { type: 'conv_log', fingerprints: [fp], pane: pane, last: CONV_LIVE_ROWS }));
      }
      if (sent.size) convLiveAskSent(sent.size);
    }

    // The control, at the top of the thread rather than floating over it: it is about the oldest
    // bubble, so it belongs above the oldest bubble — which is also where the reader's eye already
    // is by the time they want it. Absent whenever there is nothing to press it for, and it says
    // which of the reasons that is: the ceiling and the bottom of the record are different answers.
    function convOlderHtml(keys) {
      if (!convLiveOn()) return '';
      const fps = (keys || []).map(convKeyFingerprint).filter(Boolean);
      if (!fps.some(fp => (convLiveCache.get(convFpKey(fp)) || {}).answered)) return '';
      if (convLiveCanLoadOlder(keys)) {
        return '<div class="conv-older"><button class="conv-older-btn" ' +
          'onclick="convLoadOlder(this)" ' +
          'title="Ask the relay for the window before the oldest message here">' +
          '↑ Load older</button></div>';
      }
      const claimed = convLiveClaimed(keys);
      const deep = (keys || []).some(key => {
        const fp = convKeyFingerprint(key);
        const bucket = fp && convLiveCache.get(convFpKey(fp));
        return bucket && (bucket.depth[convPaneOfKey(key)] || 0) > CONV_LIVE_ROWS;
      });
      if (!deep) return '';
      const ceiling = (keys || []).some(key => {
        const fp = convKeyFingerprint(key);
        const bucket = fp && convLiveCache.get(convFpKey(fp));
        return bucket && (bucket.depth[convPaneOfKey(key)] || 0) >= CONV_LIVE_DEEP_MAX
          && !bucket.ended[convPaneOfKey(key)] && convLiveOldestSeq(key, claimed) > 0;
      });
      return '<div class="conv-older"><span class="conv-older-end">' + (ceiling
        ? `As far back as this device keeps — ${CONV_LIVE_DEEP_MAX} messages a pane`
        : 'The start of the relay’s record') + '</span></div>';
    }

    // Pressed. The thread grows *upwards*, so the reader's place has to be put back afterwards:
    // rows prepended above the scroll position move everything they were reading down by their own
    // height, and a control that throws you somewhere else is not one anybody presses twice.
    let convOlderAnchor = null;

    function convLoadOlder(btn) {
      const box = btn && btn.closest ? btn.closest('.conv-thread, .conv-wrap, .term-wrap') : null;
      const scroller = box && box.classList.contains('conv-thread') ? box
        : (typeof hangConvBox === 'function' && box && box.id === 'convWrap' ? hangConvBox() : box);
      const keys = convOlderKeys(box);
      if (scroller) convOlderAnchor = { box: scroller, height: scroller.scrollHeight };
      if (!convLiveOlder(keys)) { convOlderAnchor = null; return; }
      if (btn) btn.disabled = true;
    }

    // Whose thread was pressed. The window addresses its conversation's roster; the pane addresses
    // whatever roster its own thread is drawn from, which is the pane alone unless it is in a
    // conversation.
    function convOlderKeys(box) {
      const inWindow = !!(box && box.id === 'convViewThread');
      const id = inWindow ? (typeof convViewId !== 'undefined' ? convViewId : '')
        : (typeof convViewId !== 'undefined' && typeof convPaneRoster !== 'undefined'
           && convPaneRoster ? convViewId : '');
      const conv = id && typeof loadConvIndex === 'function'
        ? loadConvIndex().find(c => c.id === id) : null;
      if (inWindow) return conv ? (conv.members || []).map(m => m.key) : [];
      const a = (typeof activePane !== 'undefined' && activePane && typeof paneOf === 'function')
        ? paneOf(activePane) : null;
      const mine = a ? convMemberKey(a) : '';
      const roster = conv ? (conv.members || []).map(m => m.key) : [];
      if (roster.length) return roster;
      return mine ? [mine] : [];
    }

    // Put the reader back where they were, once the rows are on screen. Measured rather than
    // remembered by row: the bubbles are variable height and a wrapped one is not the same height
    // twice, so the only number that answers this is how much taller the box got.
    // Held across several answers rather than cleared by the first: a joint thread asks one
    // question per member, and each answer that lands grows the box again. The anchor moves with
    // it and is dropped only once nothing is outstanding.
    function convOlderRestore() {
      const anchor = convOlderAnchor;
      if (!anchor || !anchor.box) return;
      const grew = anchor.box.scrollHeight - anchor.height;
      if (grew > 0) anchor.box.scrollTop += grew;
      anchor.height = anchor.box.scrollHeight;
      if (!convLiveSyncing()) convOlderAnchor = null;
    }

    // The relay answering. Addressed to the client that asked and never broadcast, so this arrives
    // only where someone turned the toggle on.
    function convLiveReceive(msg) {
      convLiveAskDone();
      convLiveError = '';
      convLiveTruncated = !!msg.truncated;
      const turns = Array.isArray(msg.turns) ? msg.turns : [];
      const now = Date.now();

      // The highest id this answer carried, over every member of it. That is what proves the whole
      // queried roster current — including the members it returned nothing for.
      let answeredThrough = 0;
      const touched = new Set();
      for (const t of turns) {
        const fpKey = convFpKey([t.host, t.agent, t.cwd]);
        const bucket = convLiveBucket(fpKey);
        const seq = t.seq || 0;
        if (seq > answeredThrough) answeredThrough = seq;
        if (seq && bucket.turns.some(x => x.seq === seq)) continue;
        bucket.turns.push(t);
        touched.add(fpKey);
      }

      // Every fingerprint the query named, whether it answered with rows or with silence. The relay
      // echoes the request back for exactly this: without it an empty answer is indistinguishable
      // from one that was never asked, and a quiet pane would never come up to date.
      for (const fp of (Array.isArray(msg.fingerprints) ? msg.fingerprints : [])) {
        const fpKey = convFpKey(fp);
        const bucket = convLiveBucket(fpKey);
        // Heard from, this session, against this relay: the next ask for it can be a delta.
        // Not for a pane-scoped answer, which carries one pane out of the fingerprint's several —
        // taking its highest id as the watermark would tell the next delta that every *other*
        // pane sharing this fingerprint is current through an id it was never asked about, and
        // their rows would never arrive at all.
        // `until_id` as well as `pane`: a backfill's highest id is *older* than this bucket's
        // watermark, so taking it as one would wind the bucket backwards and make the next delta
        // re-fetch every turn in between. The relay echoes it back for exactly this check.
        if (!msg.pane && msg.until_id == null) {
          convLiveVerified.add(fpKey);
          if (answeredThrough > bucket.syncedTo) bucket.syncedTo = answeredThrough;
          bucket.lastFetch = now;
          bucket.answered = true;
        }
        // The record had nothing before what this browser already holds. Recorded per pane so the
        // reader is told the walk is over rather than handed a button that does nothing — and so
        // the depth this ask raised is not spent again on a question with no answer.
        if (msg.until_id != null && msg.pane && !turns.length) bucket.ended[msg.pane] = true;
        touched.add(fpKey);
      }

      for (const fpKey of touched) {
        const bucket = convLiveCache.get(fpKey);
        bucket.turns.sort((a, b) => (a.at || 0) - (b.at || 0) || (a.seq || 0) - (b.seq || 0));
        // The same ceiling a single query carries, held across the deltas that follow it: without
        // this a session left open all day grows a bucket without bound.
        //
        // Counted per pane rather than over the bucket, because the bucket is a fingerprint and the
        // thread is a pane. Over the bucket, the busiest pane sharing a fingerprint evicts the
        // quiet one's history down to nothing — the reader opens a pane with 181 turns behind it
        // and is shown whatever is left of 200 after its neighbours took theirs.
        bucket.turns = convLiveTrim(bucket.turns, bucket.depth);
      }

      // A roster answer that did not fit is asked again, pane by pane. Never off a pane-scoped
      // answer: that one being truncated means the pane alone has more than a window, and there is
      // no narrower question left to ask.
      if (convLiveTruncated && !msg.pane) convLiveRefill(msg.fingerprints);

      // Kept, so the next session starts where this one got to. Not awaited: the thread below is
      // drawn from memory and a disk write is not something a reader should wait behind.
      convLivePersist(touched);
      if (typeof convNoteLiveCounts === 'function') convNoteLiveCounts(convLiveAsked);

      if (!convLiveOn()) return;
      // `false`: an answer arriving is not the reader asking to be moved. Both views already follow
      // the newest message for anyone sitting at the bottom, and forcing it here dragged a reader
      // who had scrolled up back down every time the record was re-read — every five seconds.
      const drawn = [renderConvView(),
                     typeof renderConvStandalone === 'function' ? renderConvStandalone(false) : null];
      // After the bubbles are on screen, not before: the box has to have its new height for the
      // reader's place to be measurable at all. Both renders are async, so this waits on them.
      if (convOlderAnchor) Promise.all(drawn).then(convOlderRestore, convOlderRestore);
    }

    // The one refusal worth catching: the record is off, so there is nothing to read and no amount
    // of retrying changes that. Held as the view's empty state — the toast says it once, and the
    // thread has to keep saying it for as long as the toggle is on.
    function convLiveNoteError(message) {
      const text = String(message || '');
      if (!/^conv_log|conversation log is off/.test(text)) return;
      convLiveError = text === 'conversation log is off'
        ? 'The relay is not recording. Set HERDR_CONV_LOG=1 and restart it.' : text;
      convLiveCache.clear();
      convLiveAskDone(true);
      if (convLiveOn()) renderConvView();
    }

    // Which side of the thread a row goes on. The record grades every turn by `kind`; the view has
    // two speakers, so the prompts a person or an arbitrator delivered are the user's side and
    // everything an agent produced is the other.
    const CONV_LIVE_USER_KINDS = ['human_prompt', 'arbitrated'];

    // The record grades a stamp by how it was obtained and the thread grades it the same way under
    // its own names (see CONV_AT_RANK). `poll` and `state` are the identical claim — within one
    // relay poll of the pane's own ending transition — so it is renamed rather than left unknown,
    // which would draw every captured turn with the `~` that means "this time is a guess".
    const CONV_LIVE_AT_SRC = { poll: 'state', state: 'state', sent: 'sent', backfill: 'backfill' };

    // A live row's key, in the spelling the roster uses. The rest of the view reads the key for
    // colour, for which side of a pair a bubble goes on, and for the roster panel's hide-a-member
    // filter, so a key that is right but spelled differently is a bubble drawn as a stranger.
    //
    // Two spellings exist for one host — see `convNormHost`. The relay's snapshot names the local
    // host `local` and so does the record, and that ordinary case matches outright. But the
    // browser's own key builder folds a missing host to '', so a pane that reached this app with no
    // host at all is stored under a name its member key does not carry. Both are tried against the
    // roster before either is believed.
    function convLiveKey(t, roster) {
      const pane = { pane_id: t.pane_id || '', agent: t.agent || '', cwd: t.cwd || '' };
      const mine = convMemberKey(Object.assign({ host: t.host || '' }, pane));
      if (!roster || roster.has(mine) || t.host !== 'local') return mine;
      const bare = convMemberKey(Object.assign({ host: '' }, pane));
      return roster.has(bare) ? bare : mine;
    }

    // The record, in the shape the thread already renders. `keys` is the roster, so a row's member
    // index — which is what the standalone view picks a column from — is the position of its own
    // member rather than the order rows came back in. The buckets are per pane and each is already
    // in order; interleaving them is what turns a set of members into one conversation.
    function convLiveEntries(keys) {
      const at = new Map((keys || []).map((k, i) => [k, i]));
      const turns = [];
      const seen = new Set();
      // A bucket is a fingerprint, and a fingerprint has no pane id in it — that is what lets one
      // survive the restart that renumbers every pane. But it also means two panes running the same
      // agent in the same directory share a bucket, and "show this pane only" would draw both: the
      // thread would be filtered by agent, which is not what the reader asked for.
      //
      // So a row belongs to the member whose pane id it carries. A row from a pane that is no
      // longer live has no such claimant and goes to whoever holds the fingerprint now, which is
      // what keeps a respawned pane's history attached to it.
      // Every pane id with an owner: one that is live right now, or one this roster names. A row
      // carrying any of them belongs to that member and to nobody else.
      const claimed = convLiveClaimed(keys);
      for (const k of (keys || [])) {
        const fp = convKeyFingerprint(k);
        if (!fp) continue;
        const bucket = convLiveCache.get(convFpKey(fp));
        if (!bucket) continue;
        const mine = convPaneOfKey(k);
        for (const t of bucket.turns) {
          if (!convLiveRowIsMine(t, mine, claimed)) continue;
          // Two roster members can fold to one fingerprint — a pane respawned under a new id is the
          // same pane to the record — and the bucket must not be drawn twice for them.
          if (t.seq && seen.has(t.seq)) continue;
          if (t.seq) seen.add(t.seq);
          turns.push(t);
        }
      }
      turns.sort((a, b) => (a.at || 0) - (b.at || 0) || (a.seq || 0) - (b.seq || 0));

      return turns.map(t => {
        const key = convLiveKey(t, at);
        return {
          who: CONV_LIVE_USER_KINDS.includes(t.kind) ? 'user' : 'agent',
          // `text` is the closing message the relay detected. `tail` is the last few lines it kept
          // when it detected none, which is a worse answer than a message and a much better one
          // than a blank bubble — the pane tail usually holds the message the profile missed.
          text: t.text || t.tail || '',
          // `seen` as well as `at`: every reader goes through convAt, and old records have neither.
          at: t.at || 0, seen: t.at || 0,
          at_src: CONV_LIVE_AT_SRC[t.at_src] || 'read',
          key: key, member: at.has(key) ? at.get(key) : 0,
          label: t.label || '', agent: t.agent || '',
          // Where the work landed. The record's own columns, carried through untouched — a turn
          // that says what an agent did is worth much more next to the branch it did it on. The
          // host and directory come with them because they are what a commit range is asked for
          // in: the fingerprint has them, but the entry is what the thread renders from.
          branch: t.branch || '', commit: t.commit || '',
          commits: Array.isArray(t.commits) ? t.commits : [],
          host: t.host || 'local', cwd: t.cwd || '',
          kind: t.kind, live: true,
        };
      }).filter(e => e.text);
    }

    // --- Where the work landed, as events in the thread ---
    //
    // Not as a footer on every bubble. A branch is the same for twenty messages in a row and
    // stamping each of them says nothing; what a reader is looking for is the *moment it changed*,
    // which is one line between two messages. Commits are the same shape of fact — something that
    // happened between two things that were said — so they are drawn where they happened rather
    // than hung off whichever message came after them.
    //
    // Both are the same rule the thread already uses for a gap in the recording.

    // A commit is looked up by its first characters and read by its subject; the other 32 are noise
    // in a thread. The whole sha stays in the title, because a sha nobody can copy is a lookup
    // nobody can do.
    const CONV_SHA_SHOWN = 8;

    // Showing the commits is a per-device reading preference, like the record toggle beside it —
    // not a fact about the work, so it is not one of the documents that follow the user between
    // browsers.
    const CONV_COMMITS_KEY = 'herdr_conv_commits';

    function convCommitsOn() {
      try { return localStorage.getItem(CONV_COMMITS_KEY) === 'on'; }
      catch (e) { return false; }
    }

    function toggleConvCommits() {
      const on = !convCommitsOn();
      try { localStorage.setItem(CONV_COMMITS_KEY, on ? 'on' : 'off'); }
      catch (e) { /* private mode: this session only */ }
      renderConvView();
      if (typeof renderConvStandalone === 'function') renderConvStandalone(false);
      if (typeof hangSync === 'function') hangSync();
      showToast(on ? 'Showing commits in the thread' : 'Hiding commits');
    }

    // 'cwd|host|from|to' -> a list of commits, or 'asked' while the question is in the air. The
    // relay stores the list only when HERDR_GIT_COMMITS is on, because it is the one part of this
    // that can be recomputed from the two shas the record already keeps — so the ordinary case is
    // that the thread asks for it, once per range, the first time a reader wants to see it.
    const convCommitsCache = new Map();
    const convCommitsKey = (host, cwd, from, to) => `${host}|${cwd}|${from}|${to}`;

    function convCommitsAsk(host, cwd, from, to) {
      const key = convCommitsKey(host, cwd, from, to);
      if (convCommitsCache.has(key)) return;
      convCommitsCache.set(key, 'asked');
      try {
        ws.send(JSON.stringify({type: 'git_commits', host: host, cwd: cwd, from: from, to: to}));
      } catch (e) {
        convCommitsCache.delete(key);   // no socket; the next render asks again
      }
    }

    function convCommitsReceive(msg) {
      if (!msg) return;
      const key = convCommitsKey(msg.host || 'local', msg.cwd || '', msg.from || '', msg.to || '');
      convCommitsCache.set(key, Array.isArray(msg.commits) ? msg.commits : []);
      renderConvView();
      if (typeof renderConvStandalone === 'function') renderConvStandalone(false);
    }

    // The list for one range: stored on the turn if the relay was told to keep it, otherwise
    // whatever the answer to our question was. `null` means "not known yet" — the question has just
    // gone out and the next render draws it.
    function convCommitsFor(e, fromSha) {
      if ((e.commits || []).length) return e.commits;
      if (!fromSha || !e.commit || fromSha === e.commit || !e.cwd) return [];
      const host = e.host || 'local';
      const key = convCommitsKey(host, e.cwd, fromSha, e.commit);
      const hit = convCommitsCache.get(key);
      if (Array.isArray(hit)) return hit;
      convCommitsAsk(host, e.cwd, fromSha, e.commit);
      return null;
    }

    // --- The branch the addressed agent is on, as a standing badge ---
    //
    // The rules above answer "when did this change"; this answers "where am I now", which is the
    // question a reader has with their thumb over the composer. Per *agent* and not per view: a
    // conversation's members can be in different checkouts on different branches, so this follows
    // whoever the composer is addressing rather than the conversation as a whole.
    //
    // It rides on the snapshot and is asked for by nothing. The relay probes git at turn end and
    // reads the rest back out of its own record, so by the time a pane is on screen the answer is
    // already in the state this browser holds — one more round trip per selection would buy only
    // the minutes between a branch switch and the next turn that mentions it.

    function branchOf(pane) {
      return (pane && pane.branch) || '';
    }

    function syncBranchBadge(id, pane) {
      const box = document.getElementById(id);
      if (!box) return;
      const branch = branchOf(pane);
      // innerHTML only when it changed: this runs on every snapshot, and rewriting a node under a
      // finger is how a tap lands on nothing.
      if (box.dataset.branch !== branch) {
        box.dataset.branch = branch;
        box.innerHTML = branch ? `⎇ ${escapeHtml(branch)}` : '';
        box.title = branch ? `${branch} — the branch this agent's work is landing on` : '';
      }
      // The branch belongs to an agent, so use that agent's existing theme colour rather than a
      // generic git colour. A Claude target reads orange; a Codex target reads blue.
      box.style.setProperty('--branch-color',
                            typeof agentColor === 'function' ? agentColor((pane || {}).agent) : 'var(--blue)');
      box.hidden = !branch;
    }

    // Both badges from wherever the caller is. The pane view addresses the pane it has open; the
    // conversation addresses whichever member the dock is pointed at.
    function syncBranchBadges() {
      const of = id => (typeof paneOf === 'function' && id) ? paneOf(id) : null;
      syncBranchBadge('paneBranch', of(typeof activePane === 'undefined' ? '' : activePane));
      syncBranchBadge('convBranch', of(typeof dockAddressed === 'function' ? dockAddressed() : ''));
    }

    const convGitRule = (cls, body) => `<div class="conv-rule git ${cls}">${body}</div>`;

    // What goes above and below one entry, and the running state that makes it possible to tell.
    //
    // The two halves are not the same kind of thing, and they are drawn differently on purpose.
    // `before` is a rule across the thread: it announces the state the *next* bubble is in, which
    // is what a divider is for. `after` is a rule too, and used not to be: it hung under the bubble
    // above at that bubble's width and side, which said the turn that just ended made these
    // commits. It did not necessarily — see below — so it is drawn across the thread as well.
    //
    // They are also counted differently, and this is the part that is easy to get wrong. A branch
    // is tracked **per member**: a joint thread is several panes, and each of them deserves to be
    // introduced once. A commit range is tracked **per checkout**, because a commit belongs to a
    // repository's history and not to whoever happened to speak next. Two agents pairing in one
    // directory, counted per member, would each carry the previous sha *they* last ended on — so
    // the same commit would appear under a bubble from each of them, twice, once misattributed.
    // Per checkout it appears exactly once, under the first turn to end after it was made. It is
    // also the rule the relay already uses when it stores a list (last_commit is keyed by host and
    // cwd), so the fetched range and the stored one now describe the same window.
    //
    // What that ordering cannot say is *who* committed. The first turn to end after a commit is
    // not the pane that made it — with two agents in one checkout it is whichever finished first —
    // and git has no per-pane provenance to appeal to: both commit as the same person. So the strip
    // is drawn as a fact about the repository and never in the speaker's colour.
    const convGitWhere = e => `${e.host || 'local'}|${e.cwd || ''}`;

    function convGitRules(e, seen) {
      const none = {before: '', after: ''};
      if (!e || (!e.branch && !e.commit)) return none;
      const key = e.key || '';
      const was = seen.get(key) || {};
      // One map, two kinds of key. A member key is `[host, pane, agent, cwd]` and a checkout key is
      // `host|cwd`, so neither can be mistaken for the other.
      const where = convGitWhere(e);
      const there = seen.get(where) || {};
      let before = '';
      if (e.branch && e.branch !== was.branch) {
        // A first sighting is context and a change is an event, and they read differently: the
        // first says where this is happening, the second says something happened.
        before = convGitRule('branch', was.branch
          ? `⎇ Branch changed to ${escapeHtml(e.branch)}`
          : `⎇ ${escapeHtml(e.branch)}`);
      }
      let after = '';
      if (convCommitsOn()) {
        const commits = convCommitsFor(e, there.commit);
        if (commits && commits.length) {
          // Neutral, and not aligned to the bubble above it. These are the commits this checkout
          // gained during the turn that just ended — which is not the same claim as "this agent
          // made them", and git cannot tell the difference: two agents working in one repository
          // commit as the same person, and the range is per checkout precisely so a commit appears
          // once rather than under each of them. Drawn in the agent's colour and tucked under its
          // bubble, that once read as authorship, and a reader went looking for work in the wrong
          // pane's history.
          const where = (e.cwd || '').split('/').filter(Boolean).pop() || 'this checkout';
          const tip = `Landed in ${where} while this turn was open. Commits are per checkout — `
            + `another agent working here may have made them.`;
          after = `<div class="conv-commits" title="${escapeHtml(tip)}">` +
            `<span class="conv-commits-lede">landed in ${escapeHtml(where)}</span>` +
            commits.map(c =>
            `<span class="conv-commit" title="${escapeHtml(c.sha || '')}">` +
            `<code>${escapeHtml(String(c.sha || '').slice(0, CONV_SHA_SHOWN))}</code>` +
            `<span>${escapeHtml(c.subject || '')}</span></span>`).join('') + `</div>`;
        }
      }
      // Both are carried forward when a later turn has neither: a pane that stepped out of the
      // checkout for one turn has not changed branch, and announcing the same branch again when it
      // steps back in would be an event that did not happen.
      seen.set(key, {branch: e.branch || was.branch});
      seen.set(where, {commit: e.commit || there.commit});
      return {before: before, after: after};
    }

    // What the thread says when the relay's record is on screen and empty. Three different facts,
    // and a reader who cannot tell them apart will go looking for the wrong problem.
    function convLiveEmptyHtml(keys) {
      if (convLiveError) return `<p class="conv-empty">${escapeHtml(convLiveError)}</p>`;
      // `answered`, not "has a bucket": a bucket is opened when the question goes out, so asking
      // that instead would tell a reader the record is empty while the answer is still in flight.
      const fps = (keys || []).map(convKeyFingerprint).filter(Boolean);
      const answered = fps.length
        ? fps.every(fp => (convLiveCache.get(convFpKey(fp)) || {}).answered)
        : Array.from(convLiveCache.values()).some(b => b.answered);
      if (!answered) {
        return '<p class="conv-empty">Reading the relay’s record…</p>';
      }
      return '<p class="conv-empty">The relay has recorded nothing for these panes yet. ' +
        'It writes a row when a turn ends — the next one any of them finishes is the first entry.</p>';
    }
