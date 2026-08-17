    // --- Conversation store ---
    // Transcripts live in IndexedDB and the index lives in localStorage. localStorage is a ~5 MB
    // origin-wide cap this app already spends a dozen keys of, and transcripts are the one thing
    // here that grows without limit — the feature exists *because* a pane's own history is short.
    // The index stays synchronous, so the landing list and the menus render before any await; only
    // the recordings are behind a promise.
    //
    // No library and no build step: what follows is the browser's own database behind about sixty
    // lines of promise wrappers.
    // The mark a conversation is shown by, drawn rather than typed. As an emoji it was whatever the
    // platform's font decided — colour on Apple, monochrome elsewhere — and a variation selector
    // does not reliably change that, so `color: var(--green)` was a request the font could refuse
    // and on a phone it simply did. An inline SVG has no font in it: it is green because it takes
    // currentColor, on every platform, and it is still markup rather than an image to load.
    function convGlyph() {
      return '<svg class="conv-glyph" viewBox="0 0 24 24" width="1em" height="1em" fill="none" ' +
        'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true"><path d="M20.5 11.5a8 8 0 0 1-8.5 8 8.6 8.6 0 0 1-3.9-.9L3.5 20l1.4-4.2' +
        'A7.7 7.7 0 0 1 3.5 11.5a8 8 0 0 1 8.5-8 8 8 0 0 1 8.5 8z"/></svg>';
    }

    const CONV_DB_NAME = 'herdr', CONV_DB_STORE = 'transcripts';
    const CONV_INDEX_KEY = 'herdr_conversations', CONV_FALLBACK_KEY = 'herdr_transcripts';
    // What the fallback keeps instead. It is sharing one 5 MB cap with everything else this app
    // stores, so it holds hours of history rather than months — and says so.
    const CONV_FALLBACK_ENTRIES = 400, CONV_FALLBACK_TRANSCRIPTS = 20;

    let convDB = null, convDBOpened = null, convToldFallback = false;

    function idbReq(req) {
      return new Promise((res, rej) => {
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    }

    // null means "use localStorage", not "fail": private mode, a policy-blocked store and a
    // blocked upgrade all land here, and none of them is a reason to stop rendering a pane.
    function openConvDB() {
      if (convDBOpened) return convDBOpened;
      convDBOpened = new Promise(res => {
        let req;
        try { req = indexedDB.open(CONV_DB_NAME, 1); } catch (e) { return res(null); }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(CONV_DB_STORE)) {
            const s = db.createObjectStore(CONV_DB_STORE, { keyPath: 'key' });
            s.createIndex('touched', 'touched');   // so eviction can range-scan by age
          }
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => res(null);
        req.onblocked = () => res(null);
      }).then(async db => {
        convDB = db;
        if (db) await convUpgradeFallback(db);
        return db;
      });
      return convDBOpened;
    }

    // Whatever the fallback kept while the database was unavailable moves across the first time it
    // opens, and is cleared behind it so nothing is read twice. A key the database already holds is
    // left alone: it is the longer recording of the two, since the fallback keeps hours.
    async function convUpgradeFallback(db) {
      const all = convFallbackAll(), keys = Object.keys(all);
      if (!keys.length) return;
      try {
        const read = db.transaction(CONV_DB_STORE, 'readonly').objectStore(CONV_DB_STORE);
        const existing = await Promise.all(keys.map(k => idbReq(read.get(k))));
        // Issued in one tick: an IndexedDB transaction commits as soon as the microtask queue
        // drains, so awaiting between two of its own operations is how it goes inactive.
        const write = db.transaction(CONV_DB_STORE, 'readwrite').objectStore(CONV_DB_STORE);
        await Promise.all(keys.map((k, i) => idbReq(write.put(convMergeRecord(existing[i], all[k])))));
        localStorage.removeItem(CONV_FALLBACK_KEY);
      } catch (e) { /* left where it is, and tried again on the next load */ }
    }

    // A database record may predate a brief IndexedDB failure, so a same-key fallback is not
    // safely disposable. Fold its entries onto the stored run; overlap keeps the common history
    // once and a disjoint fallback tail remains visibly gapped rather than being lost.
    function convMergeRecord(stored, fallback) {
      if (!stored) return fallback;
      const now = Math.max(stored.touched || 0, fallback.touched || 0, Date.now());
      // Both were written by the same append-only recorder, so the join is a concatenation and
      // the only thing that can be wrong with it is a message written to both. convDedupe is what
      // the menu action uses on exactly that.
      const joined = convDedupe((stored.entries || []).concat(fallback.entries || [])).entries;
      return Object.assign({}, stored, fallback, {
        first: Math.min(stored.first || now, fallback.first || now),
        touched: now,
        entries: capEntries(joined),
        spawn: fallback.spawn || stored.spawn,
      });
    }

    function convFallbackAll() {
      try {
        const d = JSON.parse(localStorage.getItem(CONV_FALLBACK_KEY) || '');
        return d && typeof d === 'object' ? d : {};
      } catch (e) { return {}; }
    }

    function convFallbackWrite(all) {
      try {
        localStorage.setItem(CONV_FALLBACK_KEY, JSON.stringify(all));
        return true;
      } catch (e) { return false; }   // full, or private mode: this session keeps it in memory
    }

    // The transcripts for the members of one conversation, by key, in one transaction. Nothing
    // scans the store to render a thread.
    //
    // Capped by the roster and not by MEMBER_MAX: that one is a ceiling on how many panes record
    // at once, and a conversation continued across several respawns has ended members whose
    // records are most of what it is. Fetching only the first eight would draw the oldest sessions
    // and drop the live one.
    async function convGet(keys) {
      const want = (keys || []).slice(0, CONV_ROSTER_MAX);
      if (!want.length) return [];
      const db = await openConvDB();
      if (!db) {
        const all = convFallbackAll();
        return want.map(k => all[k]).filter(Boolean);
      }
      try {
        const tx = db.transaction(CONV_DB_STORE, 'readonly').objectStore(CONV_DB_STORE);
        const got = await Promise.all(want.map(k => idbReq(tx.get(k))));
        return got.filter(Boolean);
      } catch (e) { return []; }
    }

    // Every transcript this browser holds, for the one screen that has to offer them as choices
    // rather than render them. Read when the picker opens and never on the poll path — this is the
    // only scan of the store outside eviction, and it stays that way.
    async function convAll() {
      const db = await openConvDB();
      if (!db) {
        const all = convFallbackAll();
        return Object.keys(all).map(k => all[k]).filter(Boolean);
      }
      try {
        const read = db.transaction(CONV_DB_STORE, 'readonly').objectStore(CONV_DB_STORE);
        return (await idbReq(read.getAll())) || [];
      } catch (e) { return []; }
    }

    // One put per pane per read cycle, and only when that cycle produced something — an idle pane
    // polled every 3s writes nothing. The caller has already appended in memory, so a refused
    // write costs the session's tail rather than the record.
    async function convPut(record) {
      const rec = Object.assign({}, record, { entries: capEntries(record.entries || []) });
      const db = await openConvDB();
      if (!db) {
        const all = convFallbackAll();
        all[rec.key] = Object.assign({}, rec, {
          entries: capEntries(rec.entries, CONV_FALLBACK_ENTRIES),
        });
        convFallbackTrim(all);
        if (!convToldFallback) {
          convToldFallback = true;
          showToast('Storing conversations in this browser only — history will be kept short.');
        }
        return convFallbackWrite(all);
      }
      try {
        await idbReq(db.transaction(CONV_DB_STORE, 'readwrite').objectStore(CONV_DB_STORE).put(rec));
        return true;
      } catch (e) {
        // Out of quota. One eviction pass, one retry, and then it is the session's own memory.
        await convEvict();
        try {
          await idbReq(db.transaction(CONV_DB_STORE, 'readwrite').objectStore(CONV_DB_STORE).put(rec));
          return true;
        } catch (e2) { return false; }
      }
    }

    // A deliberate conversation restart is the one safe exception to per-pane identity: the user
    // chose the dead member and asked its replacement to continue the same thread. Copy its record
    // under the new physical pane key; the old key remains for any other conversation that still
    // names that ended session.
    async function convContinueTranscript(oldKey, newKey, label) {
      if (!oldKey || !newKey || oldKey === newKey) return true;
      const old = convHeld.get(oldKey) || (await convGet([oldKey]))[0];
      if (!old) return true;
      // herdr recycles pane IDs, and a key is [host, pane_id, agent, cwd] — so the replacement can
      // land on a key some *other* ended session already recorded under. Copying over it would
      // delete a transcript a conversation still names. Refused instead: the caller falls back to
      // joining as a new member, which is what a restart did before it could continue anything.
      const taken = convHeld.get(newKey) || (await convGet([newKey]))[0];
      if (taken && (taken.entries || []).length && convReferenced().has(newKey)) return false;
      const next = Object.assign({}, old, {
        key: newKey, label: label || old.label || '', entries: (old.entries || []).slice(),
        // The new pane cannot be aligned to the old pane's output. Keep the continuation boundary
        // until its first completed turn, then append that whole turn after this history.
        continued: true, backfilled: true, depth: 0, lastTurn: 0,
      });
      if (!(await convPut(next))) return false;
      convHeld.set(newKey, next);
      return true;
    }

    // Which keys any conversation still names. Read from the index, which is why the index is the
    // synchronous half: eviction must not wait on a database to know what is protected.
    function convReferenced() {
      const out = new Set();
      for (const c of loadConvIndex()) for (const m of c.members || []) out.add(m.key);
      return out;
    }

    // The two tiers, as key sets. A conversation the user named is permanent and its transcripts
    // are a floor; one the recorder started on its own is book-keeping, and is what stays
    // evictable so that recording everything by default cannot become a storage problem. Naming an
    // auto conversation is the whole promotion — there is no keep switch and no archive.
    function convKept() {
      const out = new Set();
      for (const c of loadConvIndex()) if (!c.auto) for (const m of c.members || []) out.add(m.key);
      return out;
    }

    // Said once per page, not once per eviction pass: a ceiling reached with nothing droppable is
    // a standing condition, and repeating it every read would be the only thing on screen.
    let convFullSaid = false;

    function convEvictable(all, referenced, kept, max) {
      const drop = evictOrder(all, referenced, max, kept);
      const over = all.length - (max || CONV_TRANSCRIPT_MAX);
      if (over > 0 && drop.length < over && !convFullSaid) {
        convFullSaid = true;
        showToast('Every recording is in a named conversation — nothing was deleted to make room.');
      }
      return drop;
    }

    function convFallbackTrim(all) {
      const keys = convEvictable(Object.keys(all).map(k => all[k]), convReferenced(),
        convKept(), CONV_FALLBACK_TRANSCRIPTS);
      for (const k of keys) delete all[k];
    }

    async function convEvict() {
      const db = await openConvDB();
      if (!db) return;
      try {
        const read = db.transaction(CONV_DB_STORE, 'readonly').objectStore(CONV_DB_STORE);
        const all = await idbReq(read.getAll());
        const drop = convEvictable(all, convReferenced(), convKept());
        if (!drop.length) return;
        const write = db.transaction(CONV_DB_STORE, 'readwrite').objectStore(CONV_DB_STORE);
        await Promise.all(drop.map(k => idbReq(write.delete(k))));
      } catch (e) { /* nothing to evict is not an error */ }
    }

    function loadConvIndex() { return parseConvIndex(localStorage.getItem(CONV_INDEX_KEY)); }

    // The transcripts of panes read this session, so a 3s poll folds into memory and touches the
    // database only when the fold produced something.
    const convHeld = new Map(), convQueues = new Map();

    // One read, recorded. Bound to the conversation and not to the view: a pane in a conversation
    // records while it is open no matter which of the two views is on screen, because switching to
    // the terminal must not punch a hole in the transcript.
    // Only the unwrapped scrollback is folded into a transcript. `visible` is the live frame with
    // the terminal's own breaks left in, and those land mid-word — the same sentence read the two
    // ways normalizes to two different strings, so the overlap match sees a message it has never
    // seen and appends a second copy of everything on screen. A pane is on `visible` after a
    // /clear and goes back to unwrapped when it is reopened or Load more is pressed, so the flip
    // happens in ordinary use.
    //
    // Skipping is safe: the same lines come back unwrapped on the next read that asks for them.
    function convRecordable(msg) {
      return !msg.source || msg.source === 'recent-unwrapped';
    }

    function recordPane(paneId, rows) {
      const a = paneId ? paneOf(paneId) : null;
      if (!a || !profileFor(a.agent)) return;
      const key = convMemberKey(a);
      if (!convReferenced().has(key)) return;
      return convQueue(key, () => recordPaneNow(a, key, rows));
    }

    // pane_content can arrive again before IndexedDB answers the first read. One queue per
    // transcript keeps the second fold based on the first result, rather than two stale puts racing
    // and dropping whichever message wrote first. Every write of a transcript goes through here,
    // which is what keeps the menu's dedupe from landing on top of a fold in flight.
    function convQueue(key, job) {
      const previous = convQueues.get(key) || Promise.resolve();
      const queued = previous.catch(() => {}).then(job);
      convQueues.set(key, queued);
      queued.finally(() => { if (convQueues.get(key) === queued) convQueues.delete(key); });
      return queued;
    }

    async function convHold(key, now) {
      let held = convHeld.get(key);
      if (!held) {
        held = (await convGet([key]))[0] || { key: key, first: now, entries: [] };
        convHeld.set(key, held);
      }
      return held;
    }

    // An entry keeps the name and the harness the pane had when it was recorded, because that is
    // what the transcript said at the time (§8). It is also what lets the joint thread label three
    // members, and badge one that has since exited, without holding three snapshots.
    function convStamped(entries, label, agent) {
      return entries.map(e => e.label ? e : Object.assign({}, e, { label: label, agent: agent }));
    }

    // One read, recorded. Every durable write here is an event that happens once — the pane's first
    // read, or the end of one of its turns — so nothing is ever matched against a previous window
    // (§5.2). What a poll in between produces is the live draft, which is not history and is not
    // stored.
    async function recordPaneNow(a, key, rows) {
      const now = Date.now();
      const held = await convHold(key, now);
      const fresh = paneMessages(rows, a.agent);
      const live = paneOf(a.pane_id) || a;
      const working = live.status === 'working';
      const label = paneLabel(a) || held.label || '';
      // The turn's own clock. Zero until this browser has seen the pane end a turn, which is what
      // makes a first read a backfill and not an append.
      const end = turnEnd(a.pane_id);
      // Once per transcript, and not once per *empty* transcript: a prompt committed at the send
      // can reach a new record before its pane has ever been read, and that must not cost the pane
      // its history. Records written before this flag existed were all written from reads.
      let initialized = false;
      if (held.backfilled === undefined) {
        initialized = true;
        held.backfilled = held.entries.some(e => e.at_src !== 'sent');
        // The one moment a record written by the *previous* recorder is met by this one. That
        // recorder folded every read against the stored tail, and a pane read as a `visible` frame
        // came back with the terminal's breaks mid-word — so the same sentence normalized to a
        // string the match had never seen and the whole screen was appended again. Those records
        // still carry the copies; nothing written since can, because nothing since compares text.
        //
        // Repaired here and nowhere else, which is what keeps a lossy rule off a sound record:
        // `convDedupe` calls a repeat within 200 entries a duplicate, and an agent that says
        // "Done." twice inside 200 entries said it twice. Past this branch `backfilled` is set, so
        // no transcript this recorder wrote is ever offered to it.
        if (convTidyOn() && held.entries.length) {
          const out = convDedupe(held.entries);
          if (out.removed) {
            held.entries = out.entries;
            showToast(`Tidied an older transcript — removed ${out.removed} duplicate message`
              + (out.removed > 1 ? 's' : ''));
          }
        }
      }
      // A pane mid-turn has an unfinished block at the end of it, and that is a draft rather than
      // history — it goes to the draft slot below with everything else live. A record only ever
      // extends, so a half-written message committed here would stay half-written forever.
      const body = working && fresh.length && fresh[fresh.length - 1].who === 'agent'
        ? fresh.slice(0, -1) : fresh;
      // A window deeper than any this transcript has been recorded from — Load more, or the button
      // (§2.2). Not a comparison against the last read: it is a watermark, so the 3s poll can never
      // reach this branch however many times it runs.
      //
      // An explicit request is never declined for being a repeat. Idempotence is what makes that
      // safe, and it is not merely a nicety: a pane sitting at herdr's own scrollback ceiling comes
      // back the same length every time, so a watermark alone would refuse every recovery after the
      // first — on exactly the panes with the most history to lose. Hence `>=` while one is pending
      // and `>` otherwise.
      //
      // What the watermark still refuses, pending or not, is a window *shallower* than one this
      // transcript has already been read from: a 200-line turn-end read in flight when a recovery
      // was issued is not the reply being waited for, whatever else it is (§2.4). Answering it as
      // one is not merely a mis-counted toast — a window too shallow to hold the record's newest
      // message misses the anchor, and a miss is written down as a gap in history that never
      // happened. Below the watermark the read takes the ordinary turn path instead, and the deep
      // reply behind it still reports.
      const asked = convRecovering.has(key);
      const depth = held.depth || 0;
      const deep = held.backfilled && (asked ? rows.length >= depth : rows.length > depth);
      let before = [], add = [], noteGap = false;
      if (held.continued) {
        // A replacement pane starts with a fresh terminal. Its first finished turn belongs after
        // the copied record, not before it as scrollback and not against it as an overlap anchor.
        if (end) {
          add = sentTurnEntries(body, held.entries, now, end);
          if (add.length) { held.lastTurn = end; held.continued = false; }
        }
      } else if (!held.backfilled) {
        // The first read.
        const first = splitFirstRead(body, held.entries);
        before = backfillEntries(first.history, now);
        // A local send has its own event and timestamp. Its pane echo opens the current turn,
        // rather than becoming an older copy of the same prompt.
        if (first.turn.length) add = sentTurnEntries(first.turn, held.entries, now, end);
        if (body.length) held.backfilled = true;
        if (add.length) held.lastTurn = end;
      } else if (deep) {
        // History this browser was not connected for, out of a read it already paid for. Ahead of
        // the turn branch and not beside it: what a deep window holds past the record's own newest
        // message *includes* the turn that just ended, so running both would write it twice.
        const found = deepEntries(body, held.entries, now);
        before = found.before;
        add = found.add;
        // Noticed here, drawn above whatever is recorded next — which may be days away and a reload
        // later, so it is committed on its own rather than riding a write that never comes.
        if (found.gap && !held.gap) { held.gap = true; noteGap = true; }
        if (add.length && end) held.lastTurn = end;
      } else if (end > (held.lastTurn || 0)) {
        // A turn ended since the last one this transcript recorded. Reads of the same turn after
        // this one find `lastTurn` already at `end` and append nothing, so the turn-end read and
        // the poll that follows it cannot both write it.
        const found = turnSeeded(a.pane_id);
        // `body`, not `fresh`: the append is anchored now and takes everything past the record's own
        // end, so a pane that has already started its next turn would otherwise commit that turn's
        // half-written block — and a record only ever extends, so it would stay half-written.
        add = turnEntries(body, held.entries, now, found ? 0 : end, found);
        if (add.length) held.lastTurn = end;
      }
      convNoteDraft(key, working ? fresh[fresh.length - 1] : null, a, now);
      // The watermark moves on the read, not on what the read produced: a deeper window that added
      // nothing has still been recorded from, and asking it again would add nothing again.
      if (deep || held.backfilled) held.depth = Math.max(held.depth || 0, rows.length);
      let wrote = 0, dropped = 0;
      if (before.length || add.length) {
        const old = tagUserEntries(convStamped(before, label, a.agent || ''), loadOutbox(), now);
        const tagged = tagUserEntries(convStamped(add, label, a.agent || ''), old.outbox, now);
        saveOutbox(tagged.outbox);
        // A break the deep read could not close is drawn above the next thing recorded after it —
        // the window that missed the anchor had nothing to hang it on (§2.1).
        if (held.gap && tagged.entries.length) {
          tagged.entries[0] = Object.assign({}, tagged.entries[0], { gap: true });
          held.gap = false;
        }
        // The prepend is fitted to the room the record leaves it, rather than handed to `capEntries`
        // — which trims from the front, which is where a prepend lands (§2.8).
        const fitted = fitPrepend(old.entries, held.entries.length, tagged.entries.length);
        dropped = old.entries.length - fitted.length;
        wrote = fitted.length + tagged.entries.length;
        held.entries = capEntries(fitted.concat(held.entries, tagged.entries));
        held.label = label;
        held.touched = now;
        held.spawn = convSpawn(a, now);
        await convCommit(key);
      } else if (noteGap || initialized) {
        await convCommit(key);
      }
      // Answered on the first record after the press, whatever it found. A button that adds nothing
      // and says nothing reads as broken (§2.6).
      // Resolved on a *deep* write and no other. `pane_content` echoes no request id — that is a
      // wire change this spec refuses (§2.5) — so "deep" is the whole of what distinguishes the
      // reply being waited for from any other read of the same pane. The reads that could race it
      // are held off instead: the 3s poll cannot run above `POLL_MAX_LINES`, which a recovery puts
      // the pane past on its first line, and `convReadTurnEnd` declines while one is pending.
      const pending = deep ? convRecovering.get(key) : null;
      if (pending) {
        clearTimeout(pending.timer);
        convRecovering.delete(key);
        // The background sweep is invisible by construction — no toast, no redraw. Capacity is the
        // one thing it may not stay quiet about: history the transcript had no room for is a fact
        // about the ceiling, and a recovery that kept less than it found would look like one that
        // found less.
        if (pending.loud || dropped) convRecoverReport(wrote, dropped, held.gap);
      }
      // The thread draws the draft as well as the record, so a poll that added nothing can still
      // have changed what is on screen.
      if (convThreadShows(key)) renderConvView();
    }

    // What the pane is saying right now, held per member and never written down. It is the block
    // above a working composer, and it is replaced whole on every read — which is why it costs no
    // matching at all: the transcript is what has to be reconciled, and this is not in it.
    const convDrafts = new Map();

    function convNoteDraft(key, m, a, now) {
      if (!m || m.who !== 'agent') { convDrafts.delete(key); return; }
      convDrafts.set(key, convEntry(m, now, { at: now, at_src: 'read', draft: true,
        label: paneLabel(a) || '', agent: a.agent || '', pane_id: a.pane_id }));
    }

    // A prompt this app sent needs no reading back: the text is exact, the time is exact, and its
    // provenance was classified at the send. Committed here so that it is in the thread the moment
    // it is sent rather than when the agent finishes answering it — and so that the turn-end read
    // knows the prompt is already recorded without comparing a word of it.
    function convRecordSend(paneId, text, note, now) {
      const a = paneId ? paneOf(paneId) : null;
      if (!a || !profileFor(a.agent) || !text) return;
      const key = convMemberKey(a);
      if (!convReferenced().has(key)) return;
      return convQueue(key, async () => {
        const held = await convHold(key, now);
        const label = paneLabel(a) || held.label || '';
        const entry = convEntry({ who: 'user', text: text }, now,
          Object.assign({ at: now, at_src: 'sent' }, note));
        held.entries = capEntries(held.entries.concat(convStamped([entry], label, a.agent || '')));
        held.label = label;
        held.touched = now;
        held.spawn = convSpawn(a, now);
        await convCommit(key);
        if (convThreadShows(key)) renderConvView();
      });
    }

    async function convCommit(key) {
      const held = convHeld.get(key);
      if (!held) return;
      await convPut(held);
      convNoteCounts(key, held.entries, Date.now());
    }

    // The one place the append-only rule (§5.1) is broken, and it is broken by the user, on a
    // record they are looking at and can see is wrong. Counted and confirmed before anything is
    // written, and scoped to the open pane: a transcript is per-member, so the other members of a
    // joint thread are repaired from their own panes.
    async function removeConvDuplicates() {
      const a = activePane ? paneOf(activePane) : null;
      const key = a ? convMemberKey(a) : '';
      if (!key || !convReferenced().has(key)) return;
      const held = convHeld.get(key) || (await convGet([key]))[0];
      const found = convDedupe(held && held.entries).removed;
      if (!found) { showToast('No duplicates found in this transcript'); return; }
      if (!confirm(`Remove ${found} duplicate message${found > 1 ? 's' : ''} from this pane's `
        + `transcript? The copy that is kept is the longer of the two.`)) return;
      // Re-read and re-counted inside the queue: a fold may have landed while the dialog was up.
      const removed = await convQueue(key, () => convDedupeNow(key));
      showToast(removed ? `Removed ${removed} duplicate message${removed > 1 ? 's' : ''}`
        : 'No duplicates found in this transcript');
    }

    // The same repair, over the members the caller names and without the dialog: the hanging ⟳ is
    // the reader asking for exactly this on a record they are looking at, and a confirmation on
    // every refresh would make that button unusable. It reports what it removed and says nothing at
    // all when it removes nothing — the ordinary outcome, and not news.
    //
    // Queued per transcript like every other write, so a tidy cannot land on top of a fold in
    // flight. A member with no record of its own counts zero rather than failing: a conversation's
    // roster outlives the transcripts in it.
    async function convTidyQuiet(keys) {
      const held = convReferenced();
      let removed = 0;
      for (const key of new Set(keys || [])) {
        if (!key || !held.has(key)) continue;
        removed += await convQueue(key, () => convDedupeNow(key));
      }
      return removed;
    }

    // `Recover history` (§2.6). Every automatic trigger is bounded by a gate that can be wrong — a
    // gap too short to count, a pane the sweep has not reached yet — and the answer to a heuristic
    // that can miss is a button, not a looser heuristic.
    //
    // It issues no read of its own kind: it is `convRecoverStart` with every gate skipped. No
    // staleness test, because the user can see the gap; no watermark, because a pane sitting at
    // herdr's own scrollback ceiling comes back the same length every time and would otherwise be
    // refused every recovery after the first.
    function recoverConvHistory() {
      const a = activePane ? paneOf(activePane) : null;
      if (!a) return;
      convRecoverStart(a, true, READ_LINES_ASK);
    }

    // What the recovery did, in the pane's own words. `wrote` counts entries added on both sides;
    // `dropped` is history the transcript had no room for (§2.8), which is a fact about the ceiling
    // and not a failure of the read.
    function convRecoverReport(wrote, dropped, gap) {
      const many = n => `${n} message${n === 1 ? '' : 's'}`;
      if (gap && !wrote) {
        showToast('Could not find where the record left off — the gap is marked in the thread');
      } else if (!wrote && dropped) {
        showToast('This transcript is full — older messages could not be added');
      } else if (!wrote) {
        showToast('Nothing new to recover');
      } else if (dropped) {
        showToast(`Recovered ${many(wrote)}; ${many(dropped)} did not fit`);
      } else {
        showToast(`Recovered ${many(wrote)}`);
      }
    }

    async function convDedupeNow(key) {
      const held = convHeld.get(key) || (await convGet([key]))[0];
      const out = convDedupe(held && held.entries);
      if (!out.removed) return 0;
      held.entries = out.entries;
      held.touched = Date.now();
      convHeld.set(key, held);
      // Straight to disk, whatever the pane is doing: this one was asked for.
      await convCommit(key);
      if (convThreadShows(key)) renderConvView();
      return out.removed;
    }

    // The end of a turn is announced: the relay polls herdr itself and pushes ending states for
    // every pane, whether or not anyone is reading it. That is what the recorder writes on, so this
    // is the read behind every append — one per turn, for every pane in a conversation, wherever
    // the app happens to be looking.
    //
    // It is cheaper than what it replaced. Reading a conversation's other members every three
    // seconds could only be afforded while their thread was on screen; a read per turn can be
    // afforded always, which is why a partner's half of a conversation is now recorded whether or
    // not you were watching it.
    function convReadTurnEnd(paneId, status) {
      if (!ws || !paneId) return;
      if (!endsTurn(status)) return;
      const a = paneOf(paneId);
      if (!a || !profileFor(a.agent) || !convReferenced().has(convMemberKey(a))) return;
      // Not while a recovery is in flight for this transcript. `pane_content` carries no request
      // id, so a 200-line reply landing first is indistinguishable from the deep one it would be
      // reporting on — and this is the only other read anything sends for a pane nobody has open.
      // Nothing is lost by skipping it: the deep read is a superset of it and lands moments later.
      if (convRecovering.has(convMemberKey(a))) return;
      // Fixed source and length. `visible` is the live frame with the terminal's own breaks left in
      // and they land mid-word, so a turn read that way records a message no reader would recognise.
      ws.send(JSON.stringify(
        { type: 'read_pane', pane_id: paneId, lines: 200, source: 'recent-unwrapped' }));
    }

    // T2 — the recovery nobody asks for (§2.4).
    //
    // T1 covers the pane in front of you, because the read that closes its gap is a read the user
    // already made. It covers nothing else: the other members of a conversation are panes nobody
    // opened this session, and the one-turn recovery on reconnect is all their transcripts get.
    //
    // So one read has to be issued, and both gates on it are about cost. A healthy connected
    // session buys nothing — there is no gap to close. A three-second flap buys nothing — nothing
    // was missed. What buys a read is a gap in coverage *and* a member whose record is old enough
    // for that gap to have cost it something.
    const DEEP_AWAY_MS = 15 * 60 * 1000;
    // A request, not a bound: the relay clamps it (§2.7). Flat rather than `paneHistoryMax()` —
    // that setting is how much scrollback to *draw in the pane*, and a T2 read is never drawn.
    const DEEP_LINES = 5000;
    // Or everything the relay will give, for someone who would rather pay the read once than find
    // the gap later and press the button. Automatic reads are small by default; the setting lets
    // someone choose the relay's full allowance instead. §2.7's sentinel means "full" tracks the
    // relay's own ceiling rather than naming a number here.
    const CONV_DEEP_KEY = 'herdr_conv_deep';

    function convDeepAll() {
      try { return localStorage.getItem(CONV_DEEP_KEY) === 'full'; } catch (e) { return false; }
    }

    function setConvDeepAll(on) {
      try { localStorage.setItem(CONV_DEEP_KEY, on ? 'full' : 'day'); }
      catch (e) { /* private mode: session-only */ }
      document.getElementById('deepPick').value = on ? 'full' : 'day';
    }

    function convDeepLines() { return convDeepAll() ? READ_LINES_ASK : DEEP_LINES; }

    // Whether a transcript written by the previous recorder is repaired the first time this one
    // opens it. On by default: those records carry duplicates by construction, and a record nobody
    // repairs is one the duplicates stay in forever. Off is for anyone who would rather look at
    // what is stored before anything edits it — `Remove duplicates` in the pane menu is then the
    // same repair, on demand.
    const CONV_TIDY_KEY = 'herdr_conv_tidy';

    function convTidyOn() {
      try { return localStorage.getItem(CONV_TIDY_KEY) !== 'off'; } catch (e) { return true; }
    }

    function setConvTidy(on) {
      try { localStorage.setItem(CONV_TIDY_KEY, on ? 'on' : 'off'); }
      catch (e) { /* private mode: session-only */ }
      document.getElementById('tidyPick').value = on ? 'on' : 'off';
    }

    // How often a member nobody has opened is caught up on. Dormant panes are the only ones no
    // other trigger reaches — you are not looking at them, so nothing you do can pay for them —
    // and an hour is the cadence at which a background read stops being a cost anyone notices.
    const CONV_SWEEP_KEY = 'herdr_conv_sweep';
    const CONV_SWEEP_MS = { off: 0, '1h': 60 * 60 * 1000, '4h': 4 * 60 * 60 * 1000 };

    function convSweepEvery() {
      let v;
      try { v = localStorage.getItem(CONV_SWEEP_KEY); } catch (e) { v = null; }
      return CONV_SWEEP_MS[v] === undefined ? CONV_SWEEP_MS['1h'] : CONV_SWEEP_MS[v];
    }

    function setConvSweep(v) {
      const pick = CONV_SWEEP_MS[v] === undefined ? '1h' : v;
      try { localStorage.setItem(CONV_SWEEP_KEY, pick); } catch (e) { /* session-only */ }
      document.getElementById('sweepPick').value = pick;
      convArmSweep();
    }

    let convSweepTimer = null;
    function convArmSweep() {
      clearInterval(convSweepTimer);
      convSweepTimer = null;
      const every = convSweepEvery();
      // Armed, never fired immediately: a reload must cost nothing. The panes you open pay for
      // themselves, and the ones you do not can wait an hour.
      if (every) convSweepTimer = setInterval(convRecoverSweep, every);
    }

    // A recovery in flight, by transcript. `loud` is whether anyone is watching it happen: the
    // button and the pane you just opened say what they are doing, the background sweep says
    // nothing. Held so the write it lands on can report, and so a second trigger for the same pane
    // does not issue a second read.
    const convRecovering = new Map();
    // Long enough that a 50000-line read over SSH is not called a failure, short enough that a
    // toast which will never be answered does not sit there for the rest of the session.
    const CONV_RECOVER_WAIT = 45000;

    // One recovery, whoever asked for it. Every automatic trigger below and the manual button all
    // arrive here, and the only difference between them is who is watching.
    function convRecoverStart(a, loud, depth) {
      const key = a ? convMemberKey(a) : '';
      if (!key || !convReferenced().has(key)) return false;
      if (convRecovering.has(key)) return false;
      if (!ws || ws.readyState !== 1) {
        if (loud) showToast('Not connected — history cannot be recovered right now');
        return false;
      }
      const now = Date.now();
      // The setting is what the *automatic* triggers ask for. The button is not one of them: it
      // always asks for everything, because that is what pressing it means.
      const lines = depth || convDeepLines();
      // Stamped whether or not the read produces anything, or a recovery that finds nothing would
      // be re-issued for as long as the transcript stays quiet. `touched` cannot answer this on its
      // own: it moves only when something is written.
      convQueue(key, async () => {
        const held = await convHold(key, now);
        held.recovered = now;
        await convCommit(key);
      });
      convRecovering.set(key, {
        loud: loud,
        // A read the relay never answers — the pane died, the socket went down mid-flight, the SSH
        // hop hung. Nothing else in the app would ever say so, because a read that produces no
        // reply produces no error either.
        timer: setTimeout(() => {
          convRecovering.delete(key);
          if (loud) showToast('No answer from the relay — history was not recovered');
        }, CONV_RECOVER_WAIT),
      });
      if (loud) showToast(lines === READ_LINES_ASK
        ? 'Catching up on this pane — reading as far back as the relay allows…'
        : 'Catching up on this pane’s history…');
      // The open pane cannot take the silent path: its reply lands on the draw branch, which would
      // replace the rows under the reader's finger. It gets Load more to the same depth instead
      // (§2.5), and the recorder does not care which of the two brought the rows.
      if (a.pane_id === activePane) { paneLines = lines; refreshPane(); }
      else ws.send(JSON.stringify(
        { type: 'read_pane', pane_id: a.pane_id, lines: lines, source: 'recent-unwrapped' }));
      return true;
    }

    // Whether this member has been away long enough for a read to be worth issuing. One question,
    // asked by every trigger, so "stale" means one thing in this app.
    async function convStale(key, now) {
      const held = convHeld.get(key) || (await convGet([key]))[0];
      // No record is not stale: there is no history to catch up on, and the pane's first ordinary
      // read backfills the whole window anyway.
      if (!held) return false;
      return now - Math.max(held.touched || 0, held.recovered || 0) > DEEP_AWAY_MS;
    }

    // T2a — you opened a pane and its record is old. The read is paid for by the one thing that
    // makes it worth paying: you are about to read it. Loud, because you are looking at the pane
    // when it happens and a pane that suddenly grows ten thousand lines of scrollback should say
    // why.
    // A pane the app moved to on the user's behalf rather than one they tapped. Set for exactly one
    // activation, and read below: the trigger is loud because someone opened a pane to read it, and
    // nobody opened this one.
    let convQuietPane = '';

    async function convRecoverPane(paneId) {
      const quiet = convQuietPane === paneId;
      convQuietPane = '';
      const a = paneId ? paneOf(paneId) : null;
      if (!a || !profileFor(a.agent)) return;
      const key = convMemberKey(a);
      if (!convReferenced().has(key)) return;
      if (!(await convStale(key, Date.now()))) return;
      // Opened and closed again while IndexedDB answered: the read would land on a pane nobody is
      // looking at and redraw the one they moved to.
      if (activePane !== paneId) return;
      convRecoverStart(a, !quiet);
    }

    // T2b — the socket was down long enough to have missed turns, and the pane it was down over is
    // still open. No activation will fire for it, because it never went away.
    async function convRecoverOutage() {
      const down = wsDownSince;
      wsDownSince = 0;
      if (!down || Date.now() - down <= DEEP_AWAY_MS) return;
      if (activePane) await convRecoverPane(activePane);
    }

    // T2c — the members nobody has opened. Every other trigger is tied to something the user did;
    // this one is a clock, so it is the one that has to be cheap: quiet, skipping the open pane,
    // and off entirely for anyone who would rather it were.
    async function convRecoverSweep() {
      const referenced = convReferenced(), now = Date.now();
      const panes = agents.filter(a => a && a.pane_id !== activePane && profileFor(a.agent)
        && referenced.has(convMemberKey(a)));
      for (const a of panes) {
        if (await convStale(convMemberKey(a), now)) convRecoverStart(a, false);
      }
    }

    // Whether a transcript that just changed is one the view on screen is rendering: the open
    // pane's own, or another member of the joint thread it is showing.
    function convThreadShows(key) {
      const a = activePane ? paneOf(activePane) : null;
      if (!a) return false;
      if (convMemberKey(a) === key) return true;
      const conv = convViewConv(a);
      return !!conv && convViewOn(a) && convJointOn() &&
        pairedConvMembers(a, conv).some(m => m.key === key);
    }

    // The count and the last message time the landing list renders, kept per member rather than
    // per conversation: a member's own record is the only one this browser can count without
    // opening every other member's, and the list wants a total it can add up without awaiting
    // anything.
    //
    // `seen` here is the newest entry's own time, not the fold's — a first read that backfills an
    // afternoon of history would otherwise report the whole conversation as active just now, which
    // is the one thing the landing list is asked.
    function convNoteCounts(key, entries, now) {
      const items = loadConvIndex();
      const last = convAt(entries[entries.length - 1]) || now;
      let hit = false;
      for (const c of items) for (const m of c.members || []) {
        if (m.key === key) {
          m.messages = entries.length;
          m.seen = last;
          // Enough of the newest message to recognise it on a card, and no more: this lives in
          // the ~5 MB localStorage index beside fourteen other keys, and the words themselves are
          // in IndexedDB where there is room for them.
          m.last = String((entries[entries.length - 1] || {}).text || '')
            .replace(/\s+/g, ' ').trim().slice(0, 120);
          hit = true;
        }
      }
      // Not while a pane is open: the landing list is behind it, and this runs on every recorded
      // read of every member. renderBody redraws it on the way back out.
      if (hit) { saveConvIndex(items); if (!activePane) renderConversations(); }
    }

    // What the session was, for a conversation that outlives it. Every field is one the pane
    // record already carries, except `role`, which roleOf() recovers from the label. Placement and
    // slot are deliberately absent: a snapshot says where a pane *is*, never how it was created,
    // and a replacement is placed by today's layout rather than by a dead pane's.
    function convSpawn(a, now) {
      return {
        agent: a.agent || '', role: roleOf(a) || '', label: paneLabel(a) || '',
        // Which of the standard starter roles it was begun as, so starting it again begins it the
        // same way — including the opening prompt, which `role` alone cannot say: Arbitrator and
        // Orchestrator both go on the wire as `agent`.
        starter: (startRoleFromLabel(paneLabel(a)) || {}).at || '',
        project_id: a.project_id || '', project: a.project || '', cwd: a.cwd || '',
        host: a.host || '', workspace_id: a.workspace_id || '', tab_id: a.tab_id || '',
        captured: now,
      };
    }

    // At the ceiling it is the auto tier that gives way, oldest first (D4). New conversations are
    // prepended, so the tail is the oldest — and slicing the tail is exactly how the named ones,
    // the ones the user asserted mattered, would be the first to go.
    function convFit(items) {
      if (items.length <= CONV_CONV_MAX) return items;
      const drop = new Set(items.map((c, i) => ({ c, i })).filter(x => x.c.auto)
        .sort((a, b) => (a.c.created || 0) - (b.c.created || 0))
        .slice(0, items.length - CONV_CONV_MAX).map(x => x.i));
      // Named records are a floor, not the second tier of an eviction algorithm. A local index
      // may predate this cap; keeping it is safer than silently making a user's record disappear.
      return items.filter((c, i) => !drop.has(i));
    }

    function saveConvIndex(items) {
      try {
        localStorage.setItem(CONV_INDEX_KEY,
          JSON.stringify({ version: 1, items: convFit(items) }));
      } catch (e) { /* private mode: this session only */ }
    }

    // --- Conversation membership ---
    // Which conversations a pane is in, and the two edits that answer it: join one, or name a new
    // one. Membership is the whole of "is this recorded" (§3), so this is the switch — and it is
    // the user's list, never the pair's: a conversation seeded from a pair outlives it.
    let convSource = null;

    function convsForPane(a) {
      const key = convMemberKey(a);
      return key ? loadConvIndex().filter(c => (c.members || []).some(m => m.key === key)) : [];
    }

    function convMemberOf(a) {
      return { key: convMemberKey(a), added: Date.now(), label: paneLabel(a) };
    }

    function openConvDialog(paneId) {
      convSource = agents.find(x => x.pane_id === paneId);
      if (!convSource) return;
      document.getElementById('convSource').textContent = paneTitle(convSource);
      document.getElementById('convName').value = '';
      setConvError('');
      // The pair is offered as a second member only while it is healthy: a stale pair's partner is
      // a pane this browser has not verified, and seeding a member from it would record a
      // fingerprint nothing on the other end matches.
      const pair = pairFor(pairs, paneId);
      const partner = pair && pairHealth(pair, agents).state === 'healthy'
        ? agents.find(x => x.pane_id === partnerOf(pair, paneId).pane_id) : null;
      const row = document.getElementById('convPairRow');
      row.hidden = !partner;
      row.style.display = partner ? 'flex' : 'none';
      if (partner) {
        document.getElementById('convPair').checked = true;
        document.getElementById('convPairLabel').textContent = `Include ${paneLabel(partner)}`;
      }
      renderConvList();
      document.getElementById('convSheet').style.display = 'block';
      document.getElementById('convName').focus();
    }

    function closeConvDialog() {
      document.getElementById('convSheet').style.display = 'none';
      convSource = null;
    }

    function setConvError(text) {
      const el = document.getElementById('convError');
      el.textContent = text || '';
      el.style.display = text ? 'block' : 'none';
    }

    function renderConvList() {
      const box = document.getElementById('convList');
      if (!convSource) { box.innerHTML = ''; return; }
      const key = convMemberKey(convSource);
      const items = loadConvIndex();
      if (!items.length) {
        box.innerHTML = '<p class="pair-empty">No conversations yet. Name one below and this pane starts recording into it.</p>';
        return;
      }
      // Same row as the pair sheet's candidates: a list of things to pick reads as one when the
      // rows run the full width. The tick is membership, and tapping is the toggle.
      box.innerHTML = '<div class="pair-head">Conversations</div>' + items.map(c => {
        const on = (c.members || []).some(m => m.key === key);
        const n = (c.members || []).length;
        const msgs = (c.members || []).reduce((t, m) => t + (m.messages || 0), 0);
        const meta = `${n} member${n > 1 ? 's' : ''}` + (msgs ? ` · ${msgs} messages` : '');
        return `<button class="pair-pick${on ? ' on' : ''}" aria-pressed="${on ? 'true' : 'false'}" onclick="toggleConvMember('${escapeHtml(c.id)}')">
      <span class="kind conv-kind">${convGlyph()}</span>
      <span class="info"><span class="name">${escapeHtml(c.name)}</span><span class="meta">${meta}</span></span>
      <span class="pair-tick" aria-hidden="true">${on ? '✓' : ''}</span>
    </button>`;
      }).join('');
    }

    function toggleConvMember(id) {
      if (!convSource) return;
      const key = convMemberKey(convSource);
      const items = loadConvIndex();
      const conv = items.find(c => c.id === id);
      if (!conv) return;
      const at = (conv.members || []).findIndex(m => m.key === key);
      if (at >= 0) {
        // Leaving stops the recording and keeps what was recorded: the transcript is only evicted
        // once space runs out, and until then re-joining picks the thread back up.
        conv.members.splice(at, 1);
        setConvError('');
      } else {
        // Recording members, not the roster: MEMBER_MAX is what a joint thread stops being one
        // past, and an ended member draws history without competing for a colour or a poll.
        if (convRecordingMembers(conv).length >= CONV_MEMBER_MAX) {
          setConvError(`"${conv.name}" already has ${CONV_MEMBER_MAX} live panes.`); return;
        }
        conv.members.push(convMemberOf(convSource));
        setConvError('');
      }
      saveConvIndex(items);
      renderConvList();
      renderTermMenuState();
      renderConvBar();
    }

    function saveNewConv() {
      if (!convSource) return;
      const name = document.getElementById('convName').value.trim();
      if (!name) { setConvError('A conversation needs a name.'); return; }
      const items = loadConvIndex();
      if (items.length >= CONV_CONV_MAX) {
        setConvError(`Already at ${CONV_CONV_MAX} conversations — leave one first.`); return;
      }
      const members = [convMemberOf(convSource)];
      const pair = pairFor(pairs, convSource.pane_id);
      const row = document.getElementById('convPairRow');
      if (!row.hidden && document.getElementById('convPair').checked && pair) {
        const partner = agents.find(x => x.pane_id === partnerOf(pair, convSource.pane_id).pane_id);
        if (partner) members.push(convMemberOf(partner));
      }
      saveConvIndex([{
        // Not crypto.randomUUID(), for the reason newPairId() gives: no secure context on a LAN.
        id: 'c_' + Math.random().toString(36).slice(2, 10),
        name: name.slice(0, 64), created: Date.now(), members: members,
        pair_id: pair ? pair.id : '',   // provenance only — nothing reads it back (§8)
      }].concat(items));
      closeConvDialog();
      renderTermMenuState();
      renderConvBar();
    }
