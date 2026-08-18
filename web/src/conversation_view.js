    // --- Conversation view ---
    // The same pane read as a thread. Rows or thread is one switch for the whole app: a reader who
    // is following threads means it for the next pane too, and remembering it per pane meant every
    // pane opened in whatever mode it happened to be left in a week ago — including the pane a
    // conversation's own 🖥 button opens, which arrived as a thread on top of the thread it was
    // opened from.
    //
    // *Which* conversation a pane is showing stays per pane. That is a fact about the pane, not a
    // preference about how to read.
    const CONV_VIEW_KEY = 'herdr_conv_view';
    const CONV_MODE_KEY = 'herdr_conv_mode';

    // Set by a pane switch, consumed by the next render that completes. `stick` below is measured
    // against the box as it stands, and on a switch that box still holds the thread you left — so
    // arriving at a pane you had scrolled up in lands you in the middle of a different pane's
    // history. Not measured, because there is nothing yet to measure: the answer is decided by the
    // switch, not by where the last thread happened to sit.
    let convStickNext = false;
    // The thread last written into the pane's own view, so a render that would draw the same one
    // again can leave the DOM — and the reader's selection and scroll — alone.
    let convViewHtml = '';

    function convViews() {
      try {
        const d = JSON.parse(localStorage.getItem(CONV_VIEW_KEY) || '');
        return d && typeof d === 'object' ? d : {};
      } catch (e) { return {}; }
    }

    // Off until it has been turned on, except for a browser that was already reading threads before
    // the switch became one: a pane filed under the old per-pane key stands in for the answer that
    // was never stored.
    function convMode() {
      const v = localStorage.getItem(CONV_MODE_KEY);
      return v === null ? Object.keys(convViews()).length > 0 : v === 'on';
    }

    function setConvMode(on) {
      try { localStorage.setItem(CONV_MODE_KEY, on ? 'on' : 'off'); }
      catch (e) { /* private mode: this session only */ }
    }

    // A pane with nothing recorded has no thread to be in, whatever the switch says.
    function convViewOn(a) {
      return convMode() && !!convsForPane(a).length;
    }

    // Which of a pane's conversations its thread is showing. The stored value is the conversation's
    // id; versions before the pane could be in more than one wrote `1`, which still reads as on and
    // means "the first". A stored id that names nothing this pane is in any more falls back the
    // same way — a stale preference must never make a recorded pane look empty.
    function convViewConv(a) {
      const mine = convsForPane(a);
      if (!mine.length) return null;
      const want = convViews()[convMemberKey(a)];
      // A choice already made wins, and one is made for you on the way in: opening a pane *from* a
      // conversation stores that conversation against it — see openConvMemberPane — so a pane
      // reached from a thread opens on the thread it was reached from, every time.
      //
      // With nothing chosen, the one that is going on now. This was the widest record the user had
      // named, which was already better than index order — but "widest" is a fact about the roster
      // and the reader is asking about the work: a pane that belongs to last month's three-way and
      // to this morning's pair should open on this morning's. Newest message first, then a named
      // record ahead of an auto one, then the wider roster; ties keep index order, sort being
      // stable.
      return mine.find(c => c.id === want) || mine.slice().sort((x, y) =>
        (convSeenAt(y) - convSeenAt(x)) || (!!x.auto - !!y.auto)
        || ((y.members || []).length - (x.members || []).length))[0];
    }

    function convSetView(a, id) {
      const key = convMemberKey(a), views = convViews();
      if (id) views[key] = id; else delete views[key];
      try { localStorage.setItem(CONV_VIEW_KEY, JSON.stringify(views)); }
      catch (e) { /* private mode: this session only */ }
    }

    // Carry the thread across a pair switch. A pair is two panes on one job, so stepping between
    // them should not change which record you are reading — the partner arrives showing the same
    // conversation, the way a pane opened from the conversation window does.
    //
    // Only when the partner is actually in it. A pane in three conversations still has its own
    // answer to "which of them", and forcing this one on it would file its thread under a record
    // it never joined. Then it keeps whatever it had, and the fallback decides as before.
    //
    // Nothing carries off a pane being read as rows either: the source is not reading a thread, so
    // there is no thread to keep, and switching would turn one on for the partner unasked.
    function carryConvToPane(from, to) {
      if (!from || !to || !convViewOn(from)) return;
      const conv = convViewConv(from);
      const key = to && convMemberKey(to);
      if (!conv || !key || !(conv.members || []).some(m => m.key === key)) return;
      convSetView(to, conv.id);
    }

    // The switch itself, thrown for every pane at once. Which conversation this one lands on is
    // still its own: turning the thread on here names the record the fallback would have picked, so
    // the pane keeps it when the reader comes back to it under a different one.
    function toggleConvView() {
      const a = activePane ? paneOf(activePane) : null;
      if (!a) return;
      const on = convViewOn(a);
      setConvMode(!on);
      if (!on) {
        const conv = convViewConv(a);
        if (conv) convSetView(a, conv.id);
      }
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
    // What a pane is saying mid-turn is not in here at all: it is not settled in either source, and
    // it is drawn as the standing slot below the thread — see `convDraftSlotHtml`.
    async function convCompose(conv, keys) {
      const recs = await convRecords(keys);
      const joint = keys.length > 1;
      // The relay's own record, when the reader has asked for it (conv_live.js). The records are
      // still read — the member panel names who was in this and what they were spawned as, and
      // that is the local record's job either way — but the bubbles come off the wire.
      const fromRelay = convLiveOn();
      if (fromRelay) convLiveFetch(keys);
      const stored = fromRelay ? convLiveEntries(keys)
        : (joint ? mergeEntries(recs) : ((recs[0] && recs[0].entries) || []));
      // An entry recorded before convStamped existed carries no name and no harness, and a thread
      // read with no pane behind it has nothing else to fall back to. The record knows both.
      const by = new Map(recs.map(r => [r.key, r]));
      const all = stored.map(e => {
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
        convViewHtml = '';   // emptied here, so the diff below must not skip redrawing the same thread
        const workingEl = document.getElementById('paneWorking');
        if (workingEl) workingEl.innerHTML = '';
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
      const composed = await convCompose(conv, want);
      if (token !== convViewToken) return;
      const recs = composed.recs;
      // Following the newest message is the default, and a reader who has scrolled up keeps their
      // place: the same rule the pane rows follow. Consumed here rather than where it is set, so
      // that the render which actually finishes is the one that spends it — two renders can be in
      // flight and only the newest token draws.
      const stick = convStickNext || box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
      convStickNext = false;
      // Where the reader actually is. Rewriting innerHTML below sets scrollTop to 0, and a reader
      // who has scrolled up is not sticking — so without this the poll that arrives every three
      // seconds throws them to the top of the thread. Kept whether or not the write happens.
      const at = box.scrollTop;
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
      // Nobody else is speaking here, so the bubbles take the width back off the empty column.
      box.classList.toggle('conv-solo', !joint);
      // While the panel is open it is this conversation the actions act on. convViewId is "the
      // conversation being managed" and not "the one the standalone view is showing" — the two
      // views are never on screen at once, so one variable answers for both.
      if (convPaneRoster) convViewId = conv.id;
      // Under the pane's own header, not inside the thread: the same control in the same place as
      // the conversation view's, and drawn separately so an arriving message cannot rewrite the
      // roster under a reader who has just opened it.
      renderConvPaneChrome(conv, recs, hidden, key, entries);
      const html = convHeadHtml(thread, key, joint ? -1 : entries.length,
        joint ? entries.length : -1, convsForPane(a)) +
        (joint ? convMembersHtml(thread, recs) : '') + (entries.length
        ? convEntriesHtml(entries, { key: key, agent: a.agent, label: paneLabel(a) }, paired)
        : (all.length
          ? '<p class="conv-empty">Everything recorded here is still provisional — a live draft, or ' +
            'backfill off the scrollback. Turn "final messages only" off in the pane menu to see it.</p>'
          : (convLiveOn() ? convLiveEmptyHtml(want)
            : '<p class="conv-empty">Nothing recorded yet. The next read of this pane is the first entry.</p>'))) +
        // Below the thread in both sources. Neither record holds a turn that has not ended, so this
        // is the only place the reader sees a pane mid-sentence — and the only reason to watch a
        // thread rather than come back to it.
        convSlotsHtml(want, paired ? key : '');
      // Only a thread that changed is written, exactly as the conversation window's is. The
      // snapshot redraws this every three seconds, and an innerHTML the reader cannot see any
      // difference from still costs them their text selection and their place in the scroll.
      if (html !== convViewHtml) { convViewHtml = html; box.innerHTML = html; }
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
      const workingEl = document.getElementById('paneWorking');
      if (workingEl) {
        const workingList = (recs || []).map(r => {
          const live = agents.find(x => convMemberKey(x) === r.key);
          return (live && (live.status === 'working' || live.agent_status === 'working')) ? live : null;
        }).filter(Boolean);
        workingEl.innerHTML = convWorkingBadgesHtml(workingList);
      }
      box.scrollTop = stick ? box.scrollHeight : at;
    }

    function convWorkingBadgesHtml(workingList) {
      if (!workingList || !workingList.length) return '';
      return workingList.map(a => {
        const name = paneLabel(a) || a.pane_id || 'Agent';
        const badge = a.agent ? agentBadge(a.agent) : '';
        return `<div class="conv-working-chip">` +
          `<span class="conv-working-dot" aria-hidden="true"></span> ` +
          `<span>Working … <strong>${escapeHtml(name)}</strong></span>${badge}` +
          `</div>`;
      }).join('');
    }

    // The draft slot at the foot of a pane's thread: one bubble held open for as long as the pane
    // is working, empty until the parser has something out of the live pane and carrying it the
    // moment it does.
    //
    // A slot rather than a bubble that appears and disappears mid-turn. The draft used to exist
    // only while the pane was working *and* the parser had found a block, so watching a pane work
    // meant a bubble popping in partway through the turn, pushing the scroll, and popping out
    // again at the end — and a pane working with nothing parsed out of it yet looked like a pane
    // doing nothing. The slot holds that place open for the whole turn, so what changes is the
    // text in it and not the shape of the thread.
    //
    // Outside the entry list, deliberately. Picks, Summary, the message count and the empty state
    // are all positions in the list that was drawn, and a placeholder in it would be a pickable,
    // countable message with nothing in it — Summary would select a blank bubble.
    //
    // Only while provisional content is shown. With "final messages only" on, the reader has asked
    // for the settled record and nothing else, and a draft slot is the opposite of that.
    //
    // The slot is where the live stream goes, in both sources. What a pane is saying *now* is not
    // in the relay's record — that gets a row when the turn has ended — and it is not settled in
    // this browser's transcript either. So it is never an entry in either mode: the same standing
    // slot carries it, filled from the pane rows as they are read and emptied when the turn ends.
    // Before this the two sources disagreed in the one place a reader was most likely to look — a
    // live thread showed nothing at all while a pane worked — and a parsed draft in the local
    // thread became a countable, pickable `.conv-msg` that Summary could select mid-sentence.
    function convDraftSlotHtml(a, key, draft, paired) {
      if (convFinalOnly()) return '';
      const live = paneOf(a.pane_id) || agents.find(x => convMemberKey(x) === key);
      // Nothing is coming until the pane is working. An empty draft over a pane that finished its
      // turn is a promise the thread cannot keep.
      if (!live || live.status !== 'working') return '';
      const color = agentColor(a.agent) || 'var(--muted)';
      const dot = statusColor(live);
      const who = `<span class="dot pulse" style="background:${dot}"></span>` +
        `${escapeHtml(paneLabel(a) || '')}${agentBadge(a.agent)}`;
      const text = (draft && draft.text || '').trim();
      // `conv-slot` and not `conv-msg`: it looks like a bubble but it is not a message, and the
      // pick handler, Summary, Last and the badge writer all find messages by that class.
      return `<div class="conv-slot provisional draft${paired ? ' conv-right' : ''}" ` +
        `data-key="${escapeHtml(key)}" style="--conv-agent:${color}">` +
        `<span class="conv-who">${who}<span class="conv-state">draft</span></span>` +
        (text ? escapeHtml(text)
          : '<span class="conv-waiting">Nothing parsed out of the live pane yet.</span>') +
        `</div>`;
    }

    // Every member that is working, in roster order, so a joint thread streams all of them at once
    // rather than only the pane that happens to be open. A member that is idle contributes nothing,
    // so the common case of one agent working is still one slot.
    function convSlotsHtml(keys, rightKey) {
      return (keys || []).map(k => {
        const live = agents.find(x => convMemberKey(x) === k);
        if (!live) return '';
        return convDraftSlotHtml(live, k, convDrafts.get(k), !!rightKey && k === rightKey);
      }).join('');
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
        let wrap = el.querySelector('.conv-live');
        if (!status) { if (wrap) { if (wrap.contains(armedEl)) disarmButton(); wrap.remove(); } return; }
        if (!wrap) {
          wrap = document.createElement('span');
          wrap.className = 'conv-live';
          wrap.innerHTML = '<span class="conv-badge"></span>';
          el.appendChild(wrap);
        }
        // Assigned rather than compared away: writing the same string to the same node is what
        // makes this safe to run on every poll, and a badge that only changed when the status did
        // would still have to find that out by reading the node.
        const badge = wrap.querySelector('.conv-badge');
        badge.className = 'conv-badge ' + status;
        badge.textContent = status;
        // Esc, immediately left of the tag it belongs to. One per working pane rather than one for
        // the app: the bar at the bottom of the screen could only ever stop the open pane, and the
        // thread a reader is watching may have three members working at once.
        let esc = wrap.querySelector('.conv-esc');
        if (status !== 'working') {
          // An arm must not survive the pane leaving the state the button existed for: it would
          // come back armed the next time it worked, one tap from firing.
          if (esc) { if (esc === armedEl) disarmButton(); esc.remove(); }
          return;
        }
        if (!esc) {
          esc = document.createElement('button');
          esc.className = 'conv-esc arm-btn';
          esc.textContent = 'Esc';
          esc.setAttribute('aria-label', 'Stop this agent');
          esc.onclick = () => armEscMember(esc, el.dataset.key);
          wrap.insertBefore(esc, badge);
        }
      });
    }

    // Two taps, the same promise CLS and QUIT make in the header: stopping an agent mid-run is not
    // undoable, and this button hangs over a thread a thumb is already scrolling. Addressed to the
    // member's own pane, which in a joint thread is usually not the pane that is open.
    function armEscMember(btn, key) {
      const live = agents.find(x => convMemberKey(x) === key);
      if (!ws || !live || live.status !== 'working') return;
      armButton(btn, 'Esc?', () => {
        ws.send(JSON.stringify({ type: 'send_keys', pane_id: live.pane_id, keys: ['Escape'] }));
        showToast(`Sent Escape to ${paneLabel(live)}`);
        burstPoll();
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
      return `<div class="conv-head">${name}` +
        `<span class="count">${n} message${n === 1 ? '' : 's'}</span></div>`;
    }

    // Who is in this conversation, and which of them are still running. Collapsed to one row until
    // tapped: a conversation whose panes have all exited is still readable, and this is where it
    // says what it was.
    //
    // Named the way every other list of panes names one — label then agent badge. The harness is a
    // fact about the session, so it is the badge the rest of the UI uses and not a word in the
    // spawn line.
    function convMembersHtml(conv, recs) {
      const live = new Map(agents.map(x => [convMemberKey(x), x]));
      return `<button class="conv-members" onclick="this.classList.toggle('open')"
        aria-label="Who is in this conversation">` + (conv.members || []).map(m => {
        const rec = recs.find(r => r.key === m.key);
        const spawn = (rec && rec.spawn) || {};
        const on = live.has(m.key);
        const facts = [spawn.role, spawn.project || spawn.cwd].filter(Boolean);
        return `<span class="conv-member${on ? '' : ' gone'}">` +
          `<span class="who">${escapeHtml((rec && rec.label) || m.label || '')}</span>` +
          agentBadge(spawn.agent || (live.get(m.key) || {}).agent || '') +
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
        // This is a status dot, so it carries only the member's state now. The bubble wash, name
        // and badge already identify the speaker; a second colour ring made a working dot look
        // like it had changed to an unrelated warning state.
        const dot = live ? statusColor(live) : 'var(--muted)';
        const who = `<span class="dot${live && live.status === 'working' ? ' pulse' : ''}" ` +
          `style="background:${dot}"></span>${name}${badge}`;
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
