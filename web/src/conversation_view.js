    // --- Conversation view ---
    // The same pane read as a thread. Which view a pane was last read in is remembered per pane:
    // a pane being watched as a terminal and one being followed as a thread are two different
    // jobs, and a global switch would keep answering the wrong one.
    const CONV_VIEW_KEY = 'herdr_conv_view';

    // Set by a pane switch, consumed by the next render that completes. `stick` below is measured
    // against the box as it stands, and on a switch that box still holds the thread you left — so
    // arriving at a pane you had scrolled up in lands you in the middle of a different pane's
    // history. Not measured, because there is nothing yet to measure: the answer is decided by the
    // switch, not by where the last thread happened to sit.
    let convStickNext = false;

    function convViews() {
      try {
        const d = JSON.parse(localStorage.getItem(CONV_VIEW_KEY) || '');
        return d && typeof d === 'object' ? d : {};
      } catch (e) { return {}; }
    }

    function convViewOn(a) {
      const key = convMemberKey(a);
      return !!(key && convViews()[key]);
    }

    // Which of a pane's conversations its thread is showing. The stored value is the conversation's
    // id; versions before the pane could be in more than one wrote `1`, which still reads as on and
    // means "the first". A stored id that names nothing this pane is in any more falls back the
    // same way — a stale preference must never make a recorded pane look empty.
    function convViewConv(a) {
      const mine = convsForPane(a);
      if (!mine.length) return null;
      const want = convViews()[convMemberKey(a)];
      return mine.find(c => c.id === want) || mine[0];
    }

    function convSetView(a, id) {
      const key = convMemberKey(a), views = convViews();
      if (id) views[key] = id; else delete views[key];
      try { localStorage.setItem(CONV_VIEW_KEY, JSON.stringify(views)); }
      catch (e) { /* private mode: this session only */ }
    }

    function toggleConvView() {
      const a = activePane ? paneOf(activePane) : null;
      if (!a) return;
      const on = convViewOn(a), conv = on ? null : convViewConv(a);
      convSetView(a, on ? '' : ((conv && conv.id) || 1));
      renderConvBar();
      if (window.cue) cue('page');
    }

    // The thread's own picker, for a pane in more than one conversation. Reading the same pane under
    // two groupings is the whole point of a grouping being a view, and index order — which is
    // creation order — is not a preference anybody expressed.
    function selectConvView(id) {
      const a = activePane ? paneOf(activePane) : null;
      if (!a) return;
      convSetView(a, id);
      renderConvView();
    }

    // Not everything in a thread is a settled fact about what was said. Two kinds are not:
    //
    //   draft     the pane is mid-turn, and this is the block above the live composer. The agent
    //             may print past it, and then it is replaced rather than kept (§5.1).
    //   backfill  read off scrollback that predates the first read, so its place in the order is
    //             an inference and its time is not a reading at all.
    //
    // Both are worth showing by default — a thread that went quiet for the length of a turn reads
    // as broken — and both are worth being able to switch off while checking chronology, which is
    // the one job they get in the way of.
    function convProvisional(e) { return !!e && (!!e.draft || e.at_src === 'backfill'); }

    const CONV_FINAL_KEY = 'herdr_conv_final_only';

    function convFinalOnly() {
      try { return localStorage.getItem(CONV_FINAL_KEY) === 'on'; }
      catch (e) { return false; }
    }

    function toggleConvFinalOnly() {
      try { localStorage.setItem(CONV_FINAL_KEY, convFinalOnly() ? 'off' : 'on'); }
      catch (e) { /* private mode: this session only */ }
      renderConvView();
      if (window.cue) cue('page');
    }

    // Joint by default, and global rather than per pane: it is a preference about how threads are
    // read, not a fact about one pane. Off means this pane's own transcript alone, which is always
    // available — the joint thread is only ever a render, and the records are never merged on disk.
    const CONV_JOINT_KEY = 'herdr_conv_joint';

    function convJointOn() {
      try { return localStorage.getItem(CONV_JOINT_KEY) !== 'off'; }
      catch (e) { return true; }
    }

    function toggleConvJoint() {
      try { localStorage.setItem(CONV_JOINT_KEY, convJointOn() ? 'off' : 'on'); }
      catch (e) { /* private mode: this session only */ }
      renderTermMenuState();
      renderConvView();
    }

    // --- The default recorder ---
    // Book-keeping — "what happened in this repo" — is not served by a feature you have to
    // remember to switch on before the thing worth keeping happens (D5). So every agent pane files
    // itself under a conversation of its own, and the user's job is reading it rather than
    // arming it. D4's auto tier is what keeps that from becoming a storage problem.
    const CONV_AUTO_KEY = 'herdr_conv_auto', CONV_AUTO_SEEN_KEY = 'herdr_conv_auto_seen';
    const CONV_AUTO_SEEN_MAX = 500;
    const CONV_LANDING_AUTO_KEY = 'herdr_conv_landing_auto', CONV_LANDING_AUTO_MAX = 10;

    function convLandingAutoOn() {
      try { return localStorage.getItem(CONV_LANDING_AUTO_KEY) === 'on'; }
      catch (e) { return false; }
    }

    function toggleConvLandingAuto() {
      try { localStorage.setItem(CONV_LANDING_AUTO_KEY, convLandingAutoOn() ? 'off' : 'on'); }
      catch (e) { /* private mode: this session only */ }
      renderConversations();
    }

    function convAutoOn() {
      try { return localStorage.getItem(CONV_AUTO_KEY) !== 'off'; }
      catch (e) { return true; }
    }

    function toggleConvAuto() {
      try { localStorage.setItem(CONV_AUTO_KEY, convAutoOn() ? 'off' : 'on'); }
      catch (e) { /* private mode: this session only */ }
      renderTermMenuState();
      if (convAutoOn()) convAutoJoin();
    }

    // Which panes this has already filed, kept apart from membership on purpose: "already in an
    // auto conversation" is not the question. A member the user removed must stay removed, and
    // reading it off the roster would file it again on the next poll.
    function convAutoSeen() {
      try {
        const d = JSON.parse(localStorage.getItem(CONV_AUTO_SEEN_KEY) || '');
        return Array.isArray(d) ? d : [];
      } catch (e) { return []; }
    }

    // One conversation per pane, not per project: a project runs several threads of work at once,
    // and folding them into one record produces a transcript nobody can read. The name is the
    // project and the pane's label, which the relay sends for every pane — no Projects config
    // needed, and unique enough to tell two parallel sessions apart.
    function convAutoName(a) {
      const label = paneLabel(a) || a.agent || a.pane_id;
      const project = a.project || (a.cwd || '').split('/').filter(Boolean).pop() || '';
      return (project ? `${project} · ${label}` : label).slice(0, 64);
    }

    function convAutoJoin() {
      if (!convAutoOn() || !agents.length) return;
      const seen = convAutoSeen(), had = new Set(seen);
      // Only a pane an agent is running in has messages to record — the same gate the menu item
      // uses, so a harness the app cannot read is not filed under a record it can never write to.
      const fresh = agents.filter(a => convMemberKey(a) && !had.has(convMemberKey(a))
        && profileFor(a.agent));
      if (!fresh.length) return;
      const items = loadConvIndex();
      const added = fresh.map(a => {
        const conv = {
          id: 'c_' + Math.random().toString(36).slice(2, 10),
          name: convAutoName(a), created: Date.now(), members: [convMemberOf(a)],
          // The tier, and the whole of it: naming one is what promotes it (D4).
          auto: true,
        };
        items.unshift(conv);
        return { a, conv };
      });
      // Fitted once, and what is stored is what `kept` was read from. saveConvIndex fits again —
      // it has to, since every other caller writes through it — and on an already-fitted list that
      // is a no-op, which is the property that keeps the two from disagreeing.
      const fitted = convFit(items);
      const kept = new Set(fitted.map(c => c.id));
      saveConvIndex(fitted);
      // Do not call a pane filed if the cap had no auto slot for it. It retries after space is
      // freed; marking it seen here would lose its transcript permanently.
      for (const {a, conv} of added) if (kept.has(conv.id)) seen.push(convMemberKey(a));
      try { localStorage.setItem(CONV_AUTO_SEEN_KEY,
        JSON.stringify(seen.slice(-CONV_AUTO_SEEN_MAX))); }
      catch (e) { /* private mode: this session only */ }
      renderConversations();
    }

    // The other half of D4. A named conversation's roster grows without limit — the user asserted
    // that record mattered, and an ended member is a session that happened. An auto one was never
    // asserted by anybody, and a pane respawned daily would otherwise carry every session it ever
    // had in a ~5 MB store shared with fourteen other keys.
    //
    // Recording members are never touched, however many there are: what gives way is the oldest
    // *ended* ones, which is also what unreferences their transcripts and lets evictOrder reclaim
    // the words. Nothing here depends on the recorder being switched on — the tier is the question,
    // and a respawn adds a member either way.
    function convPruneAuto() {
      if (!agents.length) return;
      const live = new Set(agents.map(x => convMemberKey(x)));
      let changed = false;
      const items = loadConvIndex().map(c => {
        const members = c.members || [];
        if (!c.auto || members.length <= CONV_AUTO_ROSTER_MAX) return c;
        const drop = new Set(members.filter(m => !live.has(m.key))
          .sort((a, b) => (a.added || 0) - (b.added || 0))
          .slice(0, members.length - CONV_AUTO_ROSTER_MAX));
        if (!drop.size) return c;
        changed = true;
        return Object.assign({}, c, { members: members.filter(m => !drop.has(m)) });
      });
      if (changed) saveConvIndex(items);
    }

    // A pair can predate conversations, leaving each pane with its own recorded thread. Read
    // those two records together without changing either conversation's membership on disk.
    function pairedConvMembers(a, conv) {
      const members = conv.members || [];
      const pair = pairFor(pairs, a.pane_id);
      if (!pair || pairHealth(pair, agents).state !== 'healthy') return members;
      const partner = agents.find(x => memberMatches(partnerOf(pair, a.pane_id), x));
      if (!partner || !convsForPane(partner).length) return members;
      const key = convMemberKey(partner);
      return members.some(m => m.key === key) ? members : members.concat({key, label: paneLabel(partner)});
    }

    // A member is recording or it has ended, and that is derived rather than stored: a live pane
    // answers it, and a pane that has exited answers it by not being there. No lifecycle, no event
    // to miss, and a conversation whose panes have all gone is a full record rather than a
    // half-cleaned one.
    function convRecordingMembers(conv) {
      const live = new Set(agents.map(x => convMemberKey(x)));
      return (conv.members || []).filter(m => live.has(m.key));
    }

    // The thread, composed from the store and from nothing else. No pane, no view, no selection —
    // a conversation is a record, and reading one must not require a live pane to read it through.
    // The caller supplies the drafts, because a draft is the one part that only exists while a
    // pane is being watched.
    async function convCompose(conv, keys, drafts) {
      const recs = await convRecords(keys);
      const joint = keys.length > 1;
      const stored = joint ? mergeEntries(recs) : ((recs[0] && recs[0].entries) || []);
      // An entry recorded before convStamped existed carries no name and no harness, and a thread
      // read with no pane behind it has nothing else to fall back to. The record knows both.
      const by = new Map(recs.map(r => [r.key, r]));
      const all = stored.concat(drafts || []).map(e => {
        if (e.label) return e;
        const rec = by.get(e.key || (recs[0] || {}).key) || {};
        return Object.assign({}, e, { label: rec.label, agent: e.agent || (rec.spawn || {}).agent });
      });
      // `all` and `entries` both, because "nothing recorded" and "everything recorded is
      // provisional" are different empty states and the view says so differently.
      return { recs: recs, joint: joint, all: all,
        entries: convFinalOnly() ? all.filter(e => !convProvisional(e)) : all };
    }

    // Both halves of the switch: the button that offers it and the view it selects.
    function renderConvBar() {
      renderQuickActions();
      // The pair strip shares the pane composer, whose folded/thread state just changed. Repaint it
      // with the same transition so an existing pair cannot retain an absent or stale strip.
      renderPairStrip();
      renderConvView();
      // Which conversation the pane is reading is what the strip marks current, when the strip is
      // holding conversations. Diffed by its own signature, so this costs nothing when it is not.
      renderConvStrip();
      // And the pane strip is scoped to the conversation's members while its thread is up, so
      // turning the thread on and off is a change to what the strip holds.
      renderAgentTabs();
    }

    // A render can be overtaken by the next one while it waits on the database, and the loser
    // would paint a thread the pane has since left.
    let convViewToken = 0;

    async function renderConvView() {
      const wrap = document.getElementById('termWrap'), box = document.getElementById('convThread');
      const a = activePane ? paneOf(activePane) : null;
      const conv = a ? convViewConv(a) : null;
      const on = !!conv && convViewOn(a);
      wrap.classList.toggle('conv-on', on);
      // The same fact one level up, where the composer can see it: `conv-on` is on the wrap and CSS
      // has no ancestor selector, so the fold rule — which lives on the view — could not read it.
      document.getElementById('terminalView').classList.toggle('conv-view', on);
      box.hidden = !on;
      if (!on) {
        box.innerHTML = '';
        // The pane switched to reads as rows, so nothing will consume this. Left armed it would
        // yank the next thread to its end under a reader who had scrolled up in it.
        convStickNext = false;
        hideConvPaneRoster();
        convViewToken++;
        // Picks were bubbles, and they filled the same selection bar the rows fill, so they leave
        // with the thread. Only then: this runs on every recorded read, and clearing unasked would
        // wipe a ruler selection made on the rows every three seconds.
        const picked = convPicked.size > 0;
        convPicked.clear();
        if (convLastAgent >= 0) { convLastAgent = -1; renderQuickActions(); }
        if (picked) clearSel();
        else drawSel();
        return;
      }
      const token = ++convViewToken;
      const key = convMemberKey(a);
      // Every member, or this pane alone. Joint is the default because that is what a conversation
      // of several panes says they are: one piece of work.
      const members = pairedConvMembers(a, conv);
      const joint = convJointOn() && members.length > 1;
      const want = joint ? members.map(m => m.key) : [key];
      // The live draft is drawn, never stored: it is what a working pane is saying right now, and
      // the turn it belongs to has not ended, so there is nothing to record yet. Always last —
      // whatever is still being written is newer than everything that has been.
      const drafts = want.map((k, i) => {
        const d = convDrafts.get(k), live = agents.find(x => convMemberKey(x) === k);
        return d && live && live.status === 'working'
          ? Object.assign({}, d, { key: k, member: joint ? i : 0 }) : null;
      }).filter(Boolean);
      const composed = await convCompose(conv, want, drafts);
      if (token !== convViewToken) return;
      const recs = composed.recs;
      // Following the newest message is the default, and a reader who has scrolled up keeps their
      // place: the same rule the pane rows follow. Consumed here rather than where it is set, so
      // that the render which actually finishes is the one that spends it — two renders can be in
      // flight and only the newest token draws.
      const stick = convStickNext || box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
      convStickNext = false;
      // Filtered in the composer rather than in the renderer: picks, Summary and the count are all
      // positions in the list that was drawn, so the list that was drawn has to be the list they
      // index.
      // The same per-conversation filter the standalone view reads. The open pane is exempt from
      // it: this is its thread, and a pane that hid itself would be reading an empty screen with no
      // obvious way back.
      const hidden = convHidden(conv.id);
      const shows = e => (e.key || key) === key || !hidden.has(e.key || key);
      const entries = hidden.size ? composed.entries.filter(shows) : composed.entries;
      const all = hidden.size ? composed.all.filter(shows) : composed.all;
      const thread = members === conv.members ? conv : Object.assign({}, conv, {members});
      const paired = joint && (conv.pair_id || pairFor(pairs, a.pane_id)) && members.length === 2;
      // While the panel is open it is this conversation the actions act on. convViewId is "the
      // conversation being managed" and not "the one the standalone view is showing" — the two
      // views are never on screen at once, so one variable answers for both.
      if (convPaneRoster) convViewId = conv.id;
      // Under the pane's own header, not inside the thread: the same control in the same place as
      // the conversation view's, and drawn separately so an arriving message cannot rewrite the
      // roster under a reader who has just opened it.
      renderConvPaneChrome(conv, recs, hidden, key, entries);
      box.innerHTML = convHeadHtml(thread, key, joint ? -1 : entries.length,
        joint ? entries.length : -1, convsForPane(a)) +
        (joint ? convMembersHtml(thread, recs) : '') + (entries.length
        ? convEntriesHtml(entries, { key: key, agent: a.agent, label: paneLabel(a) }, paired)
        : (all.length
          ? '<p class="conv-empty">Everything recorded here is still provisional — a live draft, or ' +
            'backfill off the scrollback. Turn "final messages only" off in the pane menu to see it.</p>'
          : '<p class="conv-empty">Nothing recorded yet. The next read of this pane is the first entry.</p>'));
      // Which bubble Summary means, found once here rather than by the button every render. The
      // button is only rebuilt when the answer changed — it is on the poll path.
      const wasFinal = convLastAgent;
      convLastAgent = -1;
      entries.forEach((e, i) => { if (e.who !== 'user') convLastAgent = i; });
      if ((wasFinal < 0) !== (convLastAgent < 0)) renderQuickActions();
      // A render that only appended leaves the picks where they are; anything else moved them, and
      // a pick on the wrong message is worse than none.
      if (entries.length < convPickedOf) convPicked.clear();
      convPickedOf = entries.length;
      syncConvBadge();
      drawConvSel();
      if (stick) box.scrollTop = box.scrollHeight;
    }

    // What each pane is doing right now, on that pane's newest bubble. Written in place rather
    // than by re-rendering the thread: the status arrives on every poll, and rebuilding the thread
    // three times a minute would take the reader's text selection with it mid-copy.
    // Both threads use it: the pane's, and the conversation window's, which is a multi-agent panel
    // where several members working at once is the ordinary case rather than the exception.
    function syncConvBadge(id) {
      const box = document.getElementById(id || 'convThread');
      if (!box || box.hidden) return;
      const msgs = Array.from(box.querySelectorAll('.conv-msg'));
      // The newest bubble of each member, not the newest bubble of the thread. In a joint thread
      // the two are only the same for whoever spoke last, and a partner working while someone else
      // spoke is the case the joint thread exists to show.
      const newest = new Map();
      msgs.forEach(el => newest.set(el.dataset.key, el));
      msgs.forEach(el => {
        const live = newest.get(el.dataset.key) === el
          && agents.find(x => convMemberKey(x) === el.dataset.key);
        // 'idle' is not a state worth a badge — it is what a pane is nearly all of the time, and a
        // badge that is always on says nothing. blocked is here because it is the one this whole
        // app exists to surface.
        const status = live && ['working', 'done', 'blocked'].includes(live.status)
          ? live.status : '';
        let badge = el.querySelector('.conv-badge');
        if (!status) { if (badge) badge.remove(); return; }
        if (!badge) { badge = document.createElement('span'); el.appendChild(badge); }
        // Assigned rather than compared away: writing the same string to the same node is what
        // makes this safe to run on every poll, and a badge that only changed when the status did
        // would still have to find that out by reading the node.
        badge.className = 'conv-badge ' + status;
        badge.textContent = status;
      });
    }

    // This session's copies first, so the common case — a thread re-rendered on every read of the
    // open pane — waits on IndexedDB only for the members that are not this one.
    async function convRecords(keys) {
      const missing = keys.filter(k => !convHeld.has(k));
      const got = missing.length ? await convGet(missing) : [];
      return keys.map((k, i) => Object.assign(
        { key: k, entries: [] }, convHeld.get(k) || got.find(r => r.key === k), { member: i }));
    }

    // The conversation's total, not this pane's: the other members' counts come from the index,
    // which is what it caches them for, and the rendered member's own count comes from the entries
    // on screen — the index is written after a fold, so it is a message behind for exactly as long
    // as it takes this to run. A joint thread has every member's entries on screen already and
    // passes -1 to say so.
    function convHeadHtml(conv, key, count, total, mine) {
      const n = total >= 0 ? total : (conv.members || []).reduce(
        (t, m) => t + (count >= 0 && m.key === key ? count : (m.messages || 0)), 0);
      // A select and not a tap-to-cycle: cycling hides how many groupings this pane is in, and the
      // count is the information. One conversation draws the name it always drew.
      const name = (mine || []).length > 1
        ? `<select class="name" onchange="selectConvView(this.value)"` +
          ` aria-label="Which conversation this pane's thread is showing">` +
          mine.map(c => `<option value="${escapeHtml(c.id)}"${c.id === conv.id ? ' selected' : ''}>` +
            `${escapeHtml(c.name)}</option>`).join('') + '</select>'
        : `<span class="name">${escapeHtml(conv.name)}</span>`;
      return `<div class="conv-head">${name}<span>${n} message${n === 1 ? '' : 's'}</span></div>`;
    }

    // Colour carries "who", so it reuses what the tab strip already assigns: one PAIR_TINTS hue
    // per member, in member order. The user keeps --blue, which is why nothing here is near it.
    function convTint(i) {
      return `hsl(${PAIR_TINTS[i % PAIR_TINTS.length]} 60% 55%)`;
    }

    // Who is in this conversation, and which of them are still running. Collapsed to one row until
    // tapped: a conversation whose panes have all exited is still readable, and this is where it
    // says what it was.
    function convMembersHtml(conv, recs) {
      const live = new Set(agents.map(x => convMemberKey(x)));
      return `<button class="conv-members" onclick="this.classList.toggle('open')"
        aria-label="Who is in this conversation">` + (conv.members || []).map((m, i) => {
        const rec = recs.find(r => r.key === m.key);
        const spawn = (rec && rec.spawn) || {};
        const on = live.has(m.key);
        const facts = [spawn.agent, spawn.role, spawn.project || spawn.cwd].filter(Boolean);
        return `<span class="conv-member${on ? '' : ' gone'}">` +
          `<span class="dot" style="background:${convTint(i)}"></span>` +
          `<span class="who">${escapeHtml((rec && rec.label) || m.label || '')}</span>` +
          `${on ? '' : '<span class="tag">no longer live</span>'}` +
          `<span class="spawn">${escapeHtml(facts.join(' · '))}</span></span>`;
      }).join('') + '</button>';
    }

    function convSpan(ms) {
      const m = Math.max(1, Math.round(ms / 60000));
      if (m < 60) return `${m} min`;
      const h = Math.round(m / 60);
      return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
    }

    // A rule before an entry that is far enough from the one above it to be a different sitting,
    // and the same shape carries a gap — a break in the recording is a break in the thread, not a
    // second kind of furniture.
    const CONV_RULE_GAP = 10 * 60 * 1000;

    // The stamp on a bubble, as a clock rather than as a date: the rule between sittings carries
    // how far apart they were, and a bubble only has to answer "when, within this one".
    //
    // A backfilled entry was already on screen the first time this browser read the pane, so its
    // time is an ordering and not a reading — the tilde is the difference between a stamp and a
    // guess, and the title says which of the four sources it came from (§5).
    function convClock(e) {
      const at = convAt(e);
      if (!at) return '';
      const date = new Date(at), today = new Date();
      const day = date.toDateString() === today.toDateString() ? '' :
        date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ';
      const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return (convAtRank(e) ? '' : '~') + day + time;
    }

    // `self` is what an entry written before the recorder stamped its own label and harness falls
    // back to: the pane the thread is being read through, or nothing at all when it is being read
    // as a record with no pane behind it. `pick` is off for a thread that is not a selection —
    // the standalone view reads, it does not transfer.
    function convEntriesHtml(entries, self, paired, pick) {
      const me = self || {};
      let last = 0;
      return entries.map((e, i) => {
        const at = convAt(e);
        // How long the thread was not being recorded for, when both ends of the break are known —
        // "41 min" is the fact; "recording resumed" is all there is to say without a previous entry.
        const rule = e.gap
          ? `<div class="conv-rule gap">⋯ ${last && at > last ? escapeHtml(convSpan(at - last)) : 'recording resumed'} ⋯</div>`
          : (at - last > CONV_RULE_GAP
            ? `<div class="conv-rule">${escapeHtml(new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}</div>`
            : '');
        last = at;
        const user = e.who === 'user';
        // `transfer` says the source alone; `mixed` adds "edited", because "approved verbatim" and
        // "rewrote it" are different facts about the same bubble.
        const from = user && e.via && e.via !== 'typed' && e.from
          ? `<span class="via" aria-hidden="true">⇄</span> ${escapeHtml(e.from.label || 'another pane')}` +
            `${e.via === 'mixed' ? ' · edited' : ''}`
          : '';
        // Every agent bubble carries its label as well as its colour: two washes of one family are
        // not enough on a phone in sunlight, and past two members colour alone stops working.
        const tint = convTint(e.member || 0);
        const key = e.key || me.key || '';
        const live = agents.find(x => convMemberKey(x) === key);
        // The harness the entry was recorded under, not the one running in that pane today: a
        // conversation outlives its panes, and a member that has exited still gets its own badge.
        const agent = e.agent || (live && live.agent) || me.agent || '';
        const color = agentColor(agent) || 'var(--muted)';
        const name = escapeHtml(e.label || me.label || '');
        // The same badge the pane list and the pair sheet use, beside the name: colour says which
        // member, and the badge says what it is — a thread of claude and codex reads as two
        // colleagues rather than as two colours.
        const badge = agentBadge(agent);
        // A user bubble names the pane it was sent *to*, on the same terms as an agent bubble names
        // the one that spoke — in a joint thread "which colleague was this said to" is the question
        // the view exists to answer, and in a single-pane thread it is what keeps a prompt and the
        // reply to it under headers of the same shape rather than two different ones.
        // Two facts in one dot: filled with the member's state now, like every other agent dot —
        // a stopped pane has no live state left to claim — and ringed in the member's own colour,
        // which is what said *which* member before the fill did. Losing the ring would leave two
        // claude bubbles in one thread told apart by their labels alone.
        const dot = live ? statusColor(live) : 'var(--muted)';
        const who = `<span class="dot${live && live.status === 'working' ? ' pulse' : ''}" ` +
          `style="background:${dot};box-shadow:0 0 0 1.5px ${tint}"></span>${name}${badge}`;
        const bar = user ? [who, from].filter(Boolean).join(' · ') : who;
        // On every bubble, including a user's own in a single-pane thread, where it is the whole
        // header: a time you have to switch views to check is not one you can check an entry with.
        const clock = convClock(e);
        const time = clock
          ? `<span class="conv-time" title="${escapeHtml(new Date(at).toLocaleString())} · `
            + `${escapeHtml(e.at_src || 'unknown')}">${escapeHtml(clock)}</span>`
          : '';
        // Named as well as unfilled: the fill says "not settled", the word says which of the two
        // reasons it is. `~` in front of the clock already says backfill, so only the draft is
        // spelled out.
        const mark = e.draft ? '<span class="conv-state">draft</span>' : '';
        const head = bar || time ? `<span class="conv-who">${bar}${time}${mark}</span>` : '';
        // The pane being read is always the right side. Stored member order is conversation
        // history, not a reading preference, and can change when a pair is created or reopened.
        const side = paired && key === me.key ? ' conv-right' : '';
        // Told apart by having no fill at all rather than by a different one: an unfilled bubble
        // against a wall of washed ones is unmistakable at a glance, on any of the eleven themes,
        // and it needs no colour of its own to say "this is not settled yet".
        const state = convProvisional(e) ? ` provisional${e.draft ? ' draft' : ''}` : '';
        // `pick` is false for no ticks at all, or the name of the handler that owns them: the
        // pane's thread and the conversation window each keep their own set of picked messages,
        // and a bubble in one must not toggle a bubble in the other.
        const tick = pick === false ? '' :
          `<button class="conv-pick" onclick="${pick === true || !pick ? 'toggleConvPick' : pick}(${i})" ` +
          `aria-pressed="false" aria-label="Select this message">✓</button>`;
        const text = escapeHtml(e.text || '');
        return rule + `<div class="conv-msg${user ? ' user' : ''}${side}${state}" data-key="${escapeHtml(key)}"` +
          ` data-i="${i}" data-text="${text}" style="--conv-agent:${color}">${tick}${head}${text}</div>`;
      }).join('');
    }

    // --- Picking messages out of a thread ---
    // The ruler selects a range of lines and the thread has none, so the same three things it feeds
    // — Copy, Transfer, and the count bar they sit on — are fed here by a set of whole messages.
    //
    // ponytail: the set holds positions in the rendered list. Backfill (§6) inserts above them and
    // would shift what is picked, so a render that is not a pure append drops the selection rather
    // than moving it to the wrong message. Keyed identity would survive that, and the joint view
    // builds fresh objects every render, so it would have to be an entry id.
    let convPicked = new Set(), convPickedOf = 0, convLastAgent = -1;

    function toggleConvPick(i) {
      if (convPicked.has(i)) convPicked.delete(i); else convPicked.add(i);
      drawConvSel();
    }

    function clearConvPick() {
      if (!convPicked.size) return;
      convPicked.clear();
      drawConvSel();
    }

    // The final message, as the thread states it: the newest thing an agent said. Same claim the
    // Summary button makes on the pane, made about a bubble instead of a range of lines.
    function selectFinalConvMessage() {
      if (convLastAgent < 0) return;
      convPicked = new Set([convLastAgent]);
      drawConvSel();
      const el = document.querySelector(`#convThread .conv-msg[data-i="${convLastAgent}"]`);
      if (el) el.scrollIntoView({ block: 'center' });
    }

    // Paints the picks and fills selText, which is what Copy and Transfer already read. The bar is
    // the pane's own sel-bar: one selection bar, whichever view made the selection.
    function drawConvSel() {
      const box = document.getElementById('convThread');
      const bar = document.getElementById('selBar');
      if (!box || box.hidden) return;
      const msgs = Array.from(box.querySelectorAll('.conv-msg'));
      const texts = [];
      for (const el of msgs) {
        const on = convPicked.has(Number(el.dataset.i));
        el.classList.toggle('picked', on);
        const pick = el.querySelector('.conv-pick');
        if (pick) pick.setAttribute('aria-pressed', String(on));
        // Read in thread order rather than in the order they were tapped: a copied pair of
        // messages that arrives out of order is not the conversation the reader saw.
        if (on) texts.push(el.dataset.text || '');
      }
      if (!texts.length) {
        bar.hidden = true;
        return;
      }
      selText = texts.join('\n\n');
      bar.hidden = false;
      document.getElementById('selCount').textContent =
        texts.length + (texts.length === 1 ? ' message' : ' messages');
      // Learn teaches a gutter glyph and a trim from pane lines. A bubble has neither.
      document.getElementById('selLearn').hidden = true;
      // The sheet's own gate: it is the prefill-and-stop path, and that path is built on a pair.
      const pair = pairFor(pairs, activePane);
      document.getElementById('selTransfer').hidden =
        !pair || pairHealth(pair, agents).state !== 'healthy';
    }
