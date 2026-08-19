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

    // The record, one bucket per pane fingerprint rather than one answer per roster, so a pane in
    // two conversations is fetched once and the second thread draws with no round trip.
    //
    //   Map<fpKey, { turns: Array, syncedTo: number, lastFetch: number }>
    //
    // `syncedTo` is the id this fingerprint has been *answered through*, which is not the same as
    // the id of its newest turn. A roster query covers every member jointly, so a member that
    // produced nothing is still proven empty up to the highest id the answer carried. Storing the
    // newest-turn id instead would make a quiet pane look permanently stale and re-ask for its
    // whole history every cadence — see `convLiveFetch`.
    const convLiveCache = new Map();
    let convLiveTruncated = false, convLiveError = '';

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
        bucket = { turns: [], syncedTo: 0, lastFetch: 0 };
        convLiveCache.set(fpKey, bucket);
      }
      return bucket;
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
    function convLiveFetch(keys, force) {
      if (!convLiveOn()) return;
      const fps = (keys || []).map(convKeyFingerprint).filter(Boolean);
      if (!fps.length) return;
      if (!ws || ws.readyState !== 1) {
        convLiveError = 'Not connected — the relay’s record cannot be read right now.';
        return;
      }
      const now = Date.now();
      let needsFetch = !!force;
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

      const payload = { type: 'conv_log', fingerprints: fps, last: CONV_LIVE_ROWS };
      // A delta only when every member is proven current through the same id. `force` still asks
      // for the window, because the reader pressing ⟳ is asking for the record and not for the
      // difference — a row edited or pruned behind this client's back is repaired by that ask and
      // by nothing else.
      if (!force && syncedTo > 0 && syncedTo !== Infinity) payload.since_id = syncedTo;
      ws.send(JSON.stringify(payload));
    }

    // The relay answering. Addressed to the client that asked and never broadcast, so this arrives
    // only where someone turned the toggle on.
    function convLiveReceive(msg) {
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
        const bucket = convLiveBucket(convFpKey(fp));
        bucket.lastFetch = now;
        bucket.answered = true;
        if (answeredThrough > bucket.syncedTo) bucket.syncedTo = answeredThrough;
      }

      for (const fpKey of touched) {
        const bucket = convLiveCache.get(fpKey);
        bucket.turns.sort((a, b) => (a.at || 0) - (b.at || 0) || (a.seq || 0) - (b.seq || 0));
        // The same ceiling a single query carries, held across the deltas that follow it: without
        // this a session left open all day grows a bucket without bound.
        if (bucket.turns.length > CONV_LIVE_ROWS) {
          bucket.turns.splice(0, bucket.turns.length - CONV_LIVE_ROWS);
        }
      }

      if (!convLiveOn()) return;
      renderConvView();
      // `false`: an answer arriving is not the reader asking to be moved. Both views already follow
      // the newest message for anyone sitting at the bottom, and forcing it here dragged a reader
      // who had scrolled up back down every time the record was re-read — every five seconds.
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
      const claimed = new Set();
      for (const x of (typeof agents !== 'undefined' ? agents : [])) {
        if (x.pane_id) claimed.add(x.pane_id);
      }
      const paneOfKey = k => { try { return (JSON.parse(k) || [])[1] || ''; } catch (e) { return ''; } };
      for (const k of (keys || [])) claimed.add(paneOfKey(k));
      for (const k of (keys || [])) {
        const fp = convKeyFingerprint(k);
        if (!fp) continue;
        const bucket = convLiveCache.get(convFpKey(fp));
        if (!bucket) continue;
        const mine = paneOfKey(k);
        for (const t of bucket.turns) {
          const pid = t.pane_id || '';
          if (mine && pid && pid !== mine && claimed.has(pid)) continue;
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
    // is what a divider is for. `after` belongs to the bubble above it — the turn said it was
    // finished and these are what it finished — so it takes that bubble's width and side and hangs
    // under it as badges. `side` is the bubble's own alignment class, passed in because the view
    // owns the layout and this file owns the record's shape.
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
    const convGitWhere = e => `${e.host || 'local'}|${e.cwd || ''}`;

    function convGitRules(e, seen, side, color) {
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
          // The agent's own colour, carried on the strip rather than on each badge: the strip is a
          // sibling of the bubble and not a child of it, so it inherits nothing from the bubble's
          // own `--conv-agent`. The fill stays neutral — a wall of washed pills under every turn
          // competes with the bubbles, and the colour has already been said by the bubble above.
          after = `<div class="conv-commits${side || ''}"` +
            `${color ? ` style="--conv-agent:${color}"` : ''}>` + commits.map(c =>
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
