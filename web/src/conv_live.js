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

    // The thread re-renders on every poll of the open pane, and a query per render would be a
    // database read every three seconds for a thread nobody touched. A turn ending pushes straight
    // past this — see `convLiveSync` — so the cadence costs freshness only while nothing happens.
    const CONV_LIVE_EVERY = 5000;

    // Per-fingerprint cache of turns: Map<fpKey, { turns: Array, maxSeq: number, maxAt: number, lastFetch: number }>
    // This ensures turns for a pane are fetched once and shared across all conversations containing that pane.
    const convLiveCache = new Map();
    let convLiveTruncated = false, convLiveError = '';
    let convLiveAt = 0;

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

    function convLiveOn() {
      try { return localStorage.getItem(CONV_LIVE_KEY) === 'on'; } catch (e) { return false; }
    }

    function toggleConvLive() {
      const on = !convLiveOn();
      try { localStorage.setItem(CONV_LIVE_KEY, on ? 'on' : 'off'); }
      catch (e) { /* private mode: this session only */ }
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

    // Invalidate cached lastFetch timestamp for given keys or all cache entries to allow re-fetching.
    function convLiveInvalidate(keys) {
      const fps = (keys || []).map(convKeyFingerprint).filter(Boolean);
      if (fps.length) {
        for (const fp of fps) {
          const bucket = convLiveCache.get(convFpKey(fp));
          if (bucket) bucket.lastFetch = 0;
        }
      } else {
        for (const bucket of convLiveCache.values()) {
          bucket.lastFetch = 0;
        }
      }
    }

    // One query for the whole roster. Sent only when the answer on hand cannot serve: a different
    // set of members, or old enough to be worth asking again. `force` is a turn ending or the ⟳,
    // both of which are someone saying "now".
    function convLiveFetch(keys, force) {
      if (!convLiveOn()) return;
      const fps = (keys || []).map(convKeyFingerprint).filter(Boolean);
      if (!fps.length) return;
      if (!ws || ws.readyState !== 1) {
        convLiveError = 'Not connected — the relay’s record cannot be read right now.';
        return;
      }
      const now = Date.now();
      let allWarm = true;
      let minMaxSeq = Infinity;
      let needsFetch = !!force;

      for (const fp of fps) {
        const bucket = convLiveCache.get(convFpKey(fp));
        if (!bucket || bucket.maxSeq === 0) {
          allWarm = false;
          needsFetch = true;
        } else {
          if (bucket.maxSeq < minMaxSeq) minMaxSeq = bucket.maxSeq;
          if (now - (bucket.lastFetch || 0) >= CONV_LIVE_EVERY) {
            needsFetch = true;
          }
        }
      }

      if (!needsFetch) return;

      for (const fp of fps) {
        let bucket = convLiveCache.get(convFpKey(fp));
        if (!bucket) {
          bucket = { turns: [], maxSeq: 0, maxAt: 0, lastFetch: now };
          convLiveCache.set(convFpKey(fp), bucket);
        } else {
          bucket.lastFetch = now;
        }
      }

      const payload = { type: 'conv_log', fingerprints: fps, last: CONV_LIVE_ROWS };
      if (allWarm && minMaxSeq > 0 && minMaxSeq !== Infinity && !force) {
        payload.since_id = minMaxSeq;
      }
      ws.send(JSON.stringify(payload));
    }

    // The relay answering. Addressed to the client that asked and never broadcast, so this arrives
    // only where someone turned the toggle on.
    function convLiveReceive(msg) {
      convLiveError = '';
      convLiveTruncated = !!msg.truncated;
      const turns = Array.isArray(msg.turns) ? msg.turns : [];
      const now = Date.now();

      for (const t of turns) {
        const fp = [convNormHost(t.host), t.agent || '', t.cwd || ''];
        const fpKey = convFpKey(fp);
        let bucket = convLiveCache.get(fpKey);
        if (!bucket) {
          bucket = { turns: [], maxSeq: 0, maxAt: 0, lastFetch: now };
          convLiveCache.set(fpKey, bucket);
        }
        const seq = t.seq || t.id || 0;
        const exists = bucket.turns.some(x => (x.seq || x.id) === seq && seq !== 0);
        if (!exists) {
          bucket.turns.push(t);
          if (seq > bucket.maxSeq) bucket.maxSeq = seq;
          if ((t.at || 0) > bucket.maxAt) bucket.maxAt = t.at || 0;
        }
      }

      const queriedFps = Array.isArray(msg.fingerprints) ? msg.fingerprints : [];
      for (const fp of queriedFps) {
        const fpKey = convFpKey(fp);
        let bucket = convLiveCache.get(fpKey);
        if (!bucket) {
          bucket = { turns: [], maxSeq: 0, maxAt: 0, lastFetch: now };
          convLiveCache.set(fpKey, bucket);
        } else {
          bucket.lastFetch = now;
        }
      }

      for (const bucket of convLiveCache.values()) {
        bucket.turns.sort((a, b) => (a.at || 0) - (b.at || 0) || (a.seq || a.id || 0) - (b.seq || b.id || 0));
      }

      if (!convLiveOn()) return;
      renderConvView();
      if (typeof renderConvStandalone === 'function') renderConvStandalone(false);
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

    // A live row's key, in the spelling the roster uses.
    function convLiveKey(t, roster) {
      const pane = { pane_id: t.pane_id || '', agent: t.agent || '', cwd: t.cwd || '' };
      const mine = convMemberKey(Object.assign({ host: t.host || '' }, pane));
      if (!roster || roster.has(mine) || t.host !== 'local') return mine;
      const bare = convMemberKey(Object.assign({ host: '' }, pane));
      return roster.has(bare) ? bare : mine;
    }

    // The record, in the shape the thread already renders.
    function convLiveEntries(keys) {
      const at = new Map((keys || []).map((k, i) => [k, i]));
      const turns = [];
      const seenSeqs = new Set();
      for (const k of (keys || [])) {
        const fp = convKeyFingerprint(k);
        if (!fp) continue;
        const bucket = convLiveCache.get(convFpKey(fp));
        if (!bucket || !bucket.turns) continue;
        for (const t of bucket.turns) {
          const seq = t.seq || t.id;
          if (seq && seenSeqs.has(seq)) continue;
          if (seq) seenSeqs.add(seq);
          turns.push(t);
        }
      }
      turns.sort((a, b) => (a.at || 0) - (b.at || 0) || (a.seq || a.id || 0) - (b.seq || b.id || 0));

      return turns.map(t => {
        const key = convLiveKey(t, at);
        return {
          who: CONV_LIVE_USER_KINDS.includes(t.kind) ? 'user' : 'agent',
          text: t.text || t.tail || '',
          at: t.at || 0, seen: t.at || 0,
          at_src: CONV_LIVE_AT_SRC[t.at_src] || 'read',
          key: key, member: at.has(key) ? at.get(key) : 0,
          label: t.label || '', agent: t.agent || '',
          kind: t.kind, live: true,
        };
      }).filter(e => e.text);
    }

    // What the thread says when the relay's record is on screen and empty. Three different facts,
    // and a reader who cannot tell them apart will go looking for the wrong problem.
    function convLiveEmptyHtml(keys) {
      if (convLiveError) return `<p class="conv-empty">${escapeHtml(convLiveError)}</p>`;
      const fps = (keys || []).map(convKeyFingerprint).filter(Boolean);
      const anyFetched = fps.length ? fps.some(fp => convLiveCache.has(convFpKey(fp))) : (convLiveCache.size > 0);
      if (!anyFetched) {
        return '<p class="conv-empty">Reading the relay’s record…</p>';
      }
      return '<p class="conv-empty">The relay has recorded nothing for these panes yet. ' +
        'It writes a row when a turn ends — the next one any of them finishes is the first entry.</p>';
    }
