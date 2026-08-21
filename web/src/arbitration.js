    // --- Arbitration ---------------------------------------------------------------------
    //
    // A third agent reads what two members said and decides who is written to next. The browser
    // owns none of that: it names the participants, writes the scope, and can stop it. Every
    // decision, every send and every pause is the relay's, and this file never invents a state —
    // it draws what the last `arb_session` said and nothing more.
    //
    // The feature gate is the arrival of `arb_sessions`, exactly as `start_options` gates Start.
    // A relay with arbitration off never sends it, so nothing here draws and no message is ever
    // put on a wire that has no handler for it (N10).

    let arbOn = false;          // this relay sent arb_sessions on this connection
    let arbSession = null;      // the one session that may be running, or null
    // The start form, which is a tap away rather than always on screen. Null when closed; open, it
    // is the *frozen* candidate list the form was opened on. Frozen because the list is derived
    // from live pane status, and a candidate going `working` two seconds after the form opened
    // would otherwise change this element's html and rebuild the textarea a scope is being typed
    // into. A stale option is answered by the relay, which re-checks every participant anyway; a
    // sentence taken out from under someone is not answered by anything.
    let arbFormPanes = null;
    let arbFormConv = '';
    // The crew picker on a *running* session: null when closed, the frozen live-member list when
    // open. Frozen for the same reason the start form's list is — it is derived from live pane
    // status, and a member going `working` mid-edit would rebuild the element under the person
    // choosing from it.
    let arbCrew = null;
    let arbHtmlLast = '';
    // What the arbitrator was given, what it decided, and what was typed as a result. Fetched and
    // never pushed — it carries prose, which the relay answers only to the client that asked
    // (§15.2) — and held once for the two readers of it: the detail sheet, and the bubbles the
    // thread draws from the same rows.
    //
    // `arbDetailSeq` is the sequence of the last decision the held copy covers, so a re-ask happens
    // when the session actually decided something and not on every poll that repeats a budget.
    let arbDetail = null, arbDetailFor = '', arbDetailSeq = -1;

    // Per connection, never cached: a capability is a fact about the relay on the other end of
    // this socket, and the next one may be a different relay entirely.
    function arbReset() {
      arbOn = false;
      arbSession = null;
      arbFormPanes = null;
      arbFormConv = '';
      arbCrew = null;
      arbHtmlLast = '';
      arbDetail = null;
      arbDetailFor = '';
      arbDetailSeq = -1;
      closeArbDetail();
      const el = document.getElementById('arbStrip');
      if (el) el.innerHTML = '';
      // The tab too. A badge raised by a session this browser can no longer see is one nothing it
      // does will clear — the same gap the two receivers below close, at the other end.
      syncBrowserTab();
    }

    function arbReceiveSessions(msg) {
      arbOn = true;
      arbSession = (msg.sessions || [])[0] || null;
      arbAskDetail(arbSession);
      arbRender();
      syncBrowserTab();
    }

    // One session on any state change. `ended` is not a state to draw: the session is over, and a
    // strip reporting a finished session is chrome above a thread nobody is arbitrating.
    function arbReceiveSession(msg) {
      const s = msg.session;
      if (!s) return;
      arbOn = true;
      const was = arbSession;
      arbSession = s.state === 'ended' ? null : s;
      if (s.state !== 'ended') { arbFormPanes = null; arbFormConv = ''; }
      if (s.state === 'paused' && !(was && was.state === 'paused')) arbAlertPause(s);
      arbAskDetail(arbSession);
      arbRender();
      syncBrowserTab();
    }

    // A session that stopped is asking for a person, and `call_human` is it asking by name. That
    // used to be a label on a strip — chrome inside the one thread it belongs to, invisible to
    // anybody on the pane list or on another conversation, which is every way the app is actually
    // being looked at when an unattended loop stops.
    //
    // Deliberately not a pane status. `blocked` is what herdr says about a pane and five surfaces
    // are keyed on it; a stopped session is a fact about the session, and writing it into a pane
    // would make all five lie about what is on that pane's screen. So a pause raises the same
    // signals a blocked pane raises — the chime, a toast, the count on the tab — without
    // pretending to be one.
    //
    // Every reason and not only call_human: a loop that stopped on a spent budget or a member that
    // exited is equally not going to start itself again.
    function arbNeedsHuman() {
      return !!(arbSession && arbSession.state === 'paused');
    }

    // On the transition into paused, not on the state. A pause stands until somebody answers it,
    // and a chime on every poll would be an alarm with no off switch.
    function arbAlertPause(s) {
      const why = (s.last_decision || {}).why;
      showToast('⚖ Arbitration paused — ' + (s.pause_reason === 'call_human'
        ? (why || 'the arbitrator is asking for you')
        : String(s.pause_reason || 'stopped').replace(/_/g, ' ')));
      if (window.cue) cue('chime');
    }

    // Is this pane the one deciding? Asked by every list that draws a pane, because an arbitrator
    // mid-session looks exactly like an ordinary agent and is not one: what is typed there is read
    // by something whose entire instruction is to answer with a JSON file.
    function arbIsArbitrator(paneId) {
      return !!(arbSession && arbSession.arbitrator && paneId &&
                arbSession.arbitrator.pane_id === paneId);
    }

    function arbMark(paneId) {
      return arbIsArbitrator(paneId)
        ? ' <span class="badge arb" title="The arbitrator of a running session">⚖</span>' : '';
    }

    // Typing at the arbitrator is asked twice — not refused. A person may well need to answer a
    // permission prompt there, and that is exactly the case where a hard block would be wrong.
    let arbTypeArmed = {paneId: '', at: 0};
    function arbGuardSend(paneId) {
      if (!arbIsArbitrator(paneId)) return true;
      if (arbTypeArmed.paneId === paneId && Date.now() - arbTypeArmed.at < 15000) return true;
      arbTypeArmed = {paneId: paneId, at: Date.now()};
      showToast('That pane is arbitrating. Send again to type at it anyway.');
      return false;
    }

    // The panes of this conversation that are live right now, in the conversation's own order.
    // A member that has exited is a member nothing can be typed at, so it is not a candidate.
    function arbLiveMembers(conv) {
      const live = new Map(agents.map(x => [convMemberKey(x), x]));
      return (conv.members || []).map(m => live.get(m.key)).filter(Boolean);
    }

    // The project everyone in this session has to be in, or null if the conversation's own live
    // members do not agree on one. The relay refuses a roster that spans two projects — an
    // arbitrator reading agents in an unrelated checkout is deciding about work it cannot see —
    // so a picker that offered one would be offering a refusal.
    function arbProject(conv) {
      const live = arbLiveMembers(conv);
      const ids = new Set(live.map(x => x.project_id || ''));
      return ids.size === 1 ? (live[0].project_id || '') : null;
    }

    // Everything live that is not in this conversation, and is in its project. The arbitrator is
    // deliberately outside the conversation: it is not a participant in it, it is the thing
    // deciding what happens in it — but it is in the same repository, or it cannot read the work.
    function arbCandidates(conv) {
      const taken = new Set((conv.members || []).map(m => m.key));
      const project = arbProject(conv);
      if (project === null) return [];
      return agents.filter(x => convMemberKey(x) && !taken.has(convMemberKey(x)) &&
        (x.project_id || '') === project &&
        x.status !== 'working' && x.status !== 'blocked');
    }

    // Whether the thread shows what the arbitrator decided, as bubbles among the messages. A
    // per-device reading preference like the record and commit toggles beside it — and on by
    // default, because a session running with its decisions hidden is the state this whole feature
    // was invisible in.
    const ARB_BUBBLES_KEY = 'herdr_arb_bubbles';

    function arbBubblesOn() {
      try { return localStorage.getItem(ARB_BUBBLES_KEY) !== 'off'; } catch (e) { return true; }
    }

    function toggleArbBubbles() {
      const on = !arbBubblesOn();
      try { localStorage.setItem(ARB_BUBBLES_KEY, on ? 'on' : 'off'); }
      catch (e) { /* private mode: this session only */ }
      if (on) arbAskDetail(arbSession);
      arbRender();
      if (typeof renderConvView === 'function') renderConvView();
      if (typeof renderConvStandalone === 'function') renderConvStandalone(false);
      showToast(on ? 'Showing what the arbitrator decided' : 'Hiding the arbitrator');
      if (window.cue) cue('toggle');
    }

    // Ask for the decisions, unless the held copy already covers them. Called on every session
    // update, which is how a bubble appears at the moment the decision does rather than the next
    // time somebody opens the sheet.
    function arbAskDetail(session) {
      if (!session || !arbBubblesOn()) return;
      // Silently, unlike a command: this is a background read nobody asked for, and a "Not
      // connected" toast for it would be a toast about a poll. Returning before anything is marked
      // as held is what makes the reconnect's own `arb_sessions` ask again.
      if (!ws || ws.readyState !== 1) return;
      const seq = (session.last_decision || {}).sequence || 0;
      if (arbDetailFor === session.id && arbDetailSeq >= seq) return;
      if (arbDetailFor !== session.id) arbDetail = null;   // never the previous session's
      arbDetailFor = session.id;
      arbDetailSeq = seq;
      arbSend({type: 'arb_detail', session: session.id});
    }

    // A key that is not a member key. Every real one is a JSON array of four strings, so this
    // cannot collide with a pane — which matters because the thread filters, colours and hides
    // bubbles by key, and an arbitrator bubble must not answer to any of it.
    const ARB_ENTRY_KEY = 'arbitrator';

    // The arbitrator's decisions as thread entries, for the conversation being read.
    //
    // **Not the arbitrator's pane.** What is drawn is what it *decided* — the gate, who it called
    // and the sentence it wrote about why — and never what its terminal was showing while it
    // worked that out. And never enrolled: this is a list built for a render, and nothing here
    // touches the conversation's roster, its record or its stored members. Turning the toggle off
    // leaves the conversation byte for byte what it was.
    //
    // Refusals stay in the detail sheet. A record the relay rejected is a fact about the
    // arbitrator having a bad minute, not a step in the conversation.
    function arbThreadEntries(convId) {
      const s = arbSession;
      if (!s || !arbBubblesOn() || !convId || s.conversation !== convId) return [];
      if (!Array.isArray(arbDetail)) return [];
      const arb = s.arbitrator || {};
      const members = s.members || [];
      return arbDetail.filter(d => d.valid).map(d => {
        const to = members.find(m => m.id === d.to);
        return {
          who: 'arbiter', text: d.why || '', at: d.at || 0, seen: d.at || 0, at_src: 'sent',
          key: ARB_ENTRY_KEY, member: 0, live: true, kind: 'decision',
          label: arb.label || 'Arbitrator', agent: arb.agent || '',
          gate: d.gate || '',
          // The agent's own name, because `member-2` is an id this session made up and the person
          // reading the thread has never agreed to it. Its kind rides along for the badge.
          to: d.gate === 'call_human' ? 'you' : (to ? (to.label || d.to) : (d.to || '')),
          toAgent: to ? to.agent || '' : '',
          // Why this one and not the other. The roles are the person's instruction about who does
          // what, so the decision reads as an answer to it rather than a coin toss.
          toRole: to ? to.role || '' : '',
          delivered: !!d.send,
        };
      });
    }

    // A member on the strip: who, and what they are for. The roles are the only part of a roster
    // a person cannot read off the pane list itself.
    function arbMemberLine(m) {
      return (m.label || m.id) + (m.role ? ` (${m.role})` : '');
    }

    function arbStateLabel(s) {
      if (s.state === 'paused') {
        return 'Paused — ' + String(s.pause_reason || 'stopped').replace(/_/g, ' ');
      }
      return s.state === 'awaiting' ? 'Deciding…' : 'Arbitrating';
    }

    // What the last decision was, in one line: the gate, who it went to, and the arbitrator's own
    // sentence about why. The instruction is not here and never arrives — it is an entry in the
    // thread below, which is where a person reads what was actually said.
    function arbLastLine(s) {
      const d = s.last_decision;
      if (!d) return 'No decision yet.';
      const to = (s.members || []).find(m => m.id === d.to);
      const who = d.gate === 'call_human' ? 'you' : (to ? to.label || d.to : d.to || '—');
      return `${d.gate || '?'} · ${who} · ${d.why || ''}`;
    }

    // The way to the arbitrator's own pane, which is a place a person is allowed to go.
    //
    // It used to appear only when the pane was `blocked`. But talking to the arbitrator directly —
    // correcting its reading of the scope, answering a question it asked in its own terminal — is
    // an ordinary thing to want, and a session where the only route to the deciding agent is
    // hunting for it in the pane list is one nobody talks to. So the button is always here, and
    // `blocked` only changes what it says: that one is a permission prompt nobody is looking at,
    // and from a strip it is indistinguishable from thinking.
    //
    // What it opens is a pane like any other. Typing there is still asked twice — see
    // `arbGuardSend` — because what is typed at an arbitrator is read by something whose whole
    // instruction is to answer with a file.
    function arbArbitratorNote(s) {
      const arb = s.arbitrator || {};
      if (!arb.pane_id) return '';
      const blocked = arb.status === 'blocked';
      return `<button class="arb-btn${blocked ? ' warn' : ''}" ` +
        `onclick="openTerminal('${escapeHtml(arb.pane_id)}')" ` +
        `aria-label="Open the arbitrator's pane">⚖ ` +
        (blocked ? 'Arbitrator needs you' : escapeHtml(arb.label || 'Arbitrator')) + '</button>';
    }

    function arbBudgetLine(s) {
      const b = s.budget || {};
      return `${b.steps_left || 0} steps · ${b.minutes_left || 0} min`;
    }

    // The strip, or the way to start one, or nothing. Pure so the shape of every state can be
    // asserted without a browser — which matters more here than usual, because the states that go
    // wrong are the ones a person is least likely to be sitting in front of.
    function arbStripHtml(session, conv, on, formPanes, crew) {
      if (!on || !conv) return '';
      if (session && session.conversation === conv.id) {
        const s = session, paused = s.state === 'paused';
        // Refused by the relay while a decision is outstanding, and said here rather than
        // discovered as an error: a prompt is already with the arbitrator naming the roster as it
        // was, and a decision answering it that named someone who left would be recorded as the
        // arbitrator's mistake.
        if (crew) {
          const roster = s.members || [];
          const ids = roster.map(m => m.pane_id);
          return '<div class="arb-form">' +
            `<p class="arb-who">Who ${escapeHtml((s.arbitrator || {}).label || 'the arbitrator')}` +
            ' is watching, and what each of them is for</p>' +
            arbPaneSelect('arbCrewA', crew, ids[0], 'First') +
            arbRoleField('arbCrewRoleA', (roster[0] || {}).role) +
            arbPaneSelect('arbCrewB', crew, ids[1], 'Second') +
            arbRoleField('arbCrewRoleB', (roster[1] || {}).role) +
            (s.state === 'awaiting'
              ? '<p class="arb-who">A decision is in the air. This can be changed once it lands, ' +
                'or after a Pause.</p>' : '') +
            '<div class="arb-form-actions">' +
            '<button class="arb-btn" onclick="arbToggleCrew()">Cancel</button>' +
            '<button class="arb-btn go" onclick="arbSetCrew()">Change</button></div></div>';
        }
        return `<div class="arb-strip" data-state="${escapeHtml(s.state || '')}">` +
          `<span class="arb-state">${escapeHtml(arbStateLabel(s))}</span>` +
          // The arbitrator's own pane, when it is the thing holding the session up. A blocked
          // arbitrator is a permission prompt nobody is looking at, and from the strip it is
          // indistinguishable from thinking — this says which, and goes to the pane.
          arbArbitratorNote(s) +
          // The line is the control: what a person wants after reading "review · Reviewer 1 · …"
          // is the rest of it, and a separate button for that would be chrome beside the answer.
          `<button class="arb-last" onclick="arbOpenDetail()"` +
          ` aria-label="What this session decided">${escapeHtml(arbLastLine(s))}</button>` +
          `<span class="arb-budget">${escapeHtml(arbBudgetLine(s))}</span>` +
          // On the strip and not in the pane menu with the other reading toggles: this one is only
          // ever a question while a session is running, and the strip is the only thing on screen
          // that exists exactly then.
          `<button class="arb-btn quiet" onclick="toggleArbBubbles()"` +
          ` aria-pressed="${arbBubblesOn() ? 'true' : 'false'}"` +
          ` aria-label="Show what the arbitrator decided, in the thread">` +
          `${arbBubblesOn() ? '⚖ shown' : '⚖ hidden'}</button>` +
          // Who it is watching, and the way to change it. Attach, detach and swap are one edit —
          // the roster is replaced whole — so this opens the same picker the start form uses.
          `<button class="arb-btn" onclick="arbToggleCrew()"` +
          ` aria-label="Change who this session is arbitrating between">` +
          `${escapeHtml((s.members || []).map(arbMemberLine).join(' · '))}</button>` +
          (paused
            ? '<button class="arb-btn" onclick="arbCommand(\'arb_resume\')">Resume</button>'
            : '<button class="arb-btn" onclick="arbCommand(\'arb_pause\')">Pause</button>') +
          // The brief again, in an empty pane. A long session pushes the opening instruction out
          // of an agent's context and what is left is an arbitrator writing prose where the drop
          // box should be — this is the way back without losing the session. Armed, because it
          // clears the arbitrator's context and that is not undoable.
          `<button class="arb-btn arm-btn" onclick="armButton(this, 'Re-brief?',` +
          ` () => arbCommand('arb_reinit'))"` +
          ` aria-label="Clear the arbitrator and give it its brief again">↻ Brief</button>` +
          // Asked twice: ending a session is not undoable, and the loop it stops is the reason
          // somebody left two agents running unattended.
          `<button class="arb-btn arm-btn" onclick="armButton(this, 'End?',` +
          ` () => arbCommand('arb_cancel'))"` +
          ` aria-label="End this arbitration session">End</button></div>`;
      }
      if (session) return '';   // running, but over some other conversation
      const live = arbLiveMembers(conv), free = arbCandidates(conv);
      // Two *or more*: which two is the person's choice, not the conversation's size. Requiring
      // exactly two is what made a three-member conversation silently un-arbitratable.
      if (live.length < 2 || !free.length) return arbWhyNotHtml(live, free, arbProject(conv));
      if (!formPanes || !formPanes.length) {
        return '<div class="arb-strip idle"><button class="arb-btn" onclick="arbToggleForm()">' +
          '⚖ Arbitrate</button></div>';
      }
      return '<div class="arb-form">' +
        '<label>Scope<textarea id="arbScope" rows="2" maxlength="4000"' +
        ' placeholder="What this session is for, and when it should stop."></textarea></label>' +
        // The two being arbitrated, named rather than assumed. In a two-member conversation these
        // are the only answer and the selects say so by having one option each; past two they are
        // the question the strip used to refuse to ask.
        arbPaneSelect('arbFirst', live, (live[0] || {}).pane_id, 'First') +
        arbRoleField('arbRoleFirst', '') +
        arbPaneSelect('arbSecond', live, (live[1] || {}).pane_id, 'Second') +
        arbRoleField('arbRoleSecond', '') +
        '<label>Arbitrator<select id="arbWho">' +
        formPanes.map(x => `<option value="${escapeHtml(x.pane_id)}">${escapeHtml(paneLabel(x))}` +
          `</option>`).join('') + '</select></label>' +
        // §10's two clocks, off by default. A turn ending is always a trigger; these are for the
        // two ways a conversation stops without anyone's turn ending — a member that went quiet,
        // and one that has been working long enough to be stuck.
        '<label>If a member goes quiet<select id="arbIdle">' +
        arbClockOptions(ARB_IDLE_CHOICES) + '</select></label>' +
        '<label>If a member works without stopping<select id="arbRuntime">' +
        arbClockOptions(ARB_RUNTIME_CHOICES) + '</select></label>' +
        '<div class="arb-form-actions">' +
        '<button class="arb-btn" onclick="arbToggleForm()">Cancel</button>' +
        '<button class="arb-btn go" onclick="arbStart()">Start</button></div></div>';
    }

    // Minutes, because that is the unit a person thinks about a stuck agent in. `0` is off, and
    // off is the default for both — a clock nobody asked for is an unattended loop spending budget.
    const ARB_IDLE_CHOICES = [0, 5, 15, 30];
    const ARB_RUNTIME_CHOICES = [0, 15, 30, 60];

    // The pills, and what each one writes. A tag is short enough to tap and the phrase is what the
    // arbitrator actually reads — `#no-code` is a slug a person has to decode first, "no code
    // writing" is an instruction. Suggestions, not a vocabulary: the relay checks the shape of a
    // role and never its wording, so the field stays typeable and this list only saves the typing.
    const ARB_ROLE_TAGS = [
      {tag: 'implement', text: 'writes the code'},
      {tag: 'fix-code', text: 'fixes what review finds'},
      {tag: 'review-only', text: 'review only'},
      {tag: 'no-code', text: 'no code writing'},
      {tag: 'test-min', text: 'minimal focused test'},
      {tag: 'test-full', text: 'runs the full suite'},
      {tag: 'plan', text: 'plans the next phase'},
      {tag: 'research', text: 'researches without changing files'},
      {tag: 'docs', text: 'writes the documentation'},
    ];

    // The field is one comma-separated line, because that is what goes on the wire and what the
    // arbitrator is shown. These three keep the pills and the line saying the same thing without
    // the pills owning the value — a person may type a phrase no badge offers, and the badge for
    // one they typed by hand still lights up.
    function arbRoleParts(text) {
      return String(text || '').split(',').map(x => x.trim()).filter(Boolean);
    }

    function arbRoleHas(text, phrase) {
      return arbRoleParts(text).some(x => x.toLowerCase() === phrase.toLowerCase());
    }

    function arbRoleToggle(text, phrase) {
      const parts = arbRoleParts(text);
      const i = parts.findIndex(x => x.toLowerCase() === phrase.toLowerCase());
      if (i >= 0) parts.splice(i, 1); else parts.push(phrase);
      return parts.join(', ');
    }

    // What this member is here to do: the badges, and the line they write. Roles may overlap
    // across members on purpose — two agents that can both review is what lets the arbitrator keep
    // going when one of them is busy.
    //
    // Not inside a <label>: a tap on a button inside one is forwarded to the control it names, and
    // on a phone that is the keyboard opening on every badge.
    function arbRoleField(id, value) {
      return `<div class="arb-role"><span class="arb-role-lede">Roles</span>` +
        `<div class="arb-roles" id="${id}Pills">${arbRolePillsHtml(id, value)}</div>` +
        `<input id="${id}" maxlength="240" value="${escapeHtml(value || '')}"` +
        ` oninput="arbSyncRolePills('${id}')"` +
        ` placeholder="What this one is for, in your own words"></div>`;
    }

    function arbRolePillsHtml(id, value) {
      return ARB_ROLE_TAGS.map(r => badgeHtml('#' + r.tag, arbRoleHas(value, r.text),
        `arbPickRole('${id}', '${r.tag}')`, {proj: true, title: r.text})).join('');
    }

    function arbPickRole(id, tag) {
      const el = document.getElementById(id);
      const r = ARB_ROLE_TAGS.find(x => x.tag === tag);
      if (!el || !r) return;
      el.value = arbRoleToggle(el.value, r.text);
      arbSyncRolePills(id);
      if (window.cue) cue('tick');
    }

    function arbSyncRolePills(id) {
      const box = document.getElementById(id + 'Pills'), el = document.getElementById(id);
      if (box && el) box.innerHTML = arbRolePillsHtml(id, el.value);
    }

    function arbRoleValue(id) {
      return ((document.getElementById(id) || {}).value || '').trim();
    }

    // One pane select. Every picker here is the same question — which of these panes — and the
    // three of them differing only in their id is what keeps the markup honest about that.
    function arbPaneSelect(id, panes, selected, label) {
      return `<label>${escapeHtml(label)}<select id="${id}">` +
        panes.map(x => `<option value="${escapeHtml(x.pane_id)}"` +
          `${x.pane_id === selected ? ' selected' : ''}>${escapeHtml(paneLabel(x))}</option>`)
          .join('') + '</select></label>';
    }

    // Why there is no Arbitrate button, instead of no button. A strip that draws nothing is
    // indistinguishable from a broken one — and this was the bug: a conversation with three
    // members, or with every other pane busy, silently had no arbitration at all and no way to
    // find out why. Both reasons are things a person can act on.
    function arbWhyNotHtml(live, free, project) {
      const why = live.length < 2
        ? 'Arbitration watches two agents talk. This conversation has ' +
          (live.length === 1 ? 'one live member.' : 'none live.')
        : project === null
        ? 'Arbitration needs everyone in one project, and this conversation spans more than one.'
        : 'Arbitration needs a third agent in this project to decide, and every other pane here ' +
          'is busy right now.';
      return `<div class="arb-strip idle"><span class="arb-state">${escapeHtml(why)}</span></div>`;
    }

    function arbToggleCrew() {
      const conv = loadConvIndex().find(c => c.id === convCurrentId());
      arbCrew = arbCrew ? null : (conv ? arbLiveMembers(conv) : null);
      arbRender();
    }

    // The roster of a running session, replaced whole — which is what attach, detach and swap all
    // are when the size is fixed at two. The arbitrator, its brief, the budget and everything it
    // has already decided stay exactly where they are; that is the point of editing rather than
    // starting again.
    function arbSetCrew() {
      const picks = ['arbCrewA', 'arbCrewB']
        .map(id => (document.getElementById(id) || {}).value || '');
      if (!picks[0] || !picks[1]) return;
      if (picks[0] === picks[1]) {
        showToast('Two different panes — one agent has nobody to talk to.');
        return;
      }
      const roles = ['arbCrewRoleA', 'arbCrewRoleB'].map(arbRoleValue);
      arbCommand('arb_members',
        {members: picks.map((pane_id, i) => ({pane_id: pane_id, role: roles[i]}))});
      arbCrew = null;
      arbRender();
    }

    function arbClockOptions(choices) {
      return choices.map(m => `<option value="${m}">${m ? m + ' min' : 'Never'}</option>`).join('');
    }

    function arbClockValue(id) {
      const minutes = parseInt((document.getElementById(id) || {}).value || '0', 10);
      return minutes > 0 ? minutes * 60000 : 0;
    }

    function arbToggleForm() {
      const conv = loadConvIndex().find(c => c.id === convCurrentId());
      if (arbFormPanes) {
        arbFormPanes = null;
        arbFormConv = '';
      } else if (conv) {
        arbFormPanes = arbCandidates(conv);
        arbFormConv = conv.id;
      }
      arbRender();
    }

    // Diffed, and that is not an optimisation: the scope textarea lives in this element, and a
    // redraw on every poll would take a half-written sentence out from under the person writing it.
    function arbRender() {
      const el = document.getElementById('arbStrip');
      if (!el) return;
      const conv = typeof convCurrentId === 'function'
        ? loadConvIndex().find(c => c.id === convCurrentId()) : null;
      if (arbFormPanes && (!conv || arbFormConv !== conv.id)) {
        arbFormPanes = null;
        arbFormConv = '';
      }
      if (arbCrew && !(arbSession && conv && arbSession.conversation === conv.id)) arbCrew = null;
      const html = arbStripHtml(arbSession, conv || null, arbOn, arbFormPanes, arbCrew);
      if (html !== arbHtmlLast) {
        // A redraw takes an armed button with it — the budget ticking down a minute is enough to
        // trigger one — and an arm on a node that is no longer in the page is a first tap that was
        // silently lost. Both armed buttons here are destructive, so the arm is dropped out loud
        // and the person taps again. Same guard the thread's Esc makes when its row goes away.
        if (typeof armedEl !== 'undefined' && armedEl && el.contains(armedEl)) disarmButton();
        arbHtmlLast = html;
        el.innerHTML = html;
      }
    }

    function arbSend(msg) {
      if (!ws || ws.readyState !== 1) { showToast('Not connected — the relay cannot be reached.'); return; }
      ws.send(JSON.stringify(msg));
    }

    // Pane ids and a scope. Not agent, cwd or label: the relay reads a participant's identity off
    // its own pane list, because a fingerprint this browser supplies is one it can have stale.
    function arbStart() {
      const conv = loadConvIndex().find(c => c.id === convCurrentId());
      if (!conv) return;
      const live = arbLiveMembers(conv), free = arbCandidates(conv);
      const scope = ((document.getElementById('arbScope') || {}).value || '').trim();
      const who = (document.getElementById('arbWho') || {}).value || '';
      const picks = ['arbFirst', 'arbSecond']
        .map(id => (document.getElementById(id) || {}).value || '');
      const roles = ['arbRoleFirst', 'arbRoleSecond'].map(arbRoleValue);
      if (!scope) { showToast('Say what this session is for.'); return; }
      if (live.length < 2 || !picks[0] || !picks[1]) return;
      if (picks[0] === picks[1]) {
        showToast('Two different panes — one agent has nobody to talk to.');
        return;
      }
      // The frozen list is what was on screen; this is the live one. A pane that started working
      // while the scope was being written is said out loud rather than swallowed, and the form is
      // redrawn on what is free now — with the scope kept, because that is the part worth keeping.
      if (!free.some(x => x.pane_id === who)) {
        arbFormPanes = free;
        arbRender();
        const box = document.getElementById('arbScope');
        if (box) box.value = scope;
        showToast('That pane is busy now — pick another arbitrator.');
        return;
      }
      arbSend({
        type: 'arb_start', conversation: conv.id, scope: scope,
        members: picks.map((pane_id, i) => ({ pane_id: pane_id, role: roles[i] })),
        arbitrator: { pane_id: who },
        triggers: { on_turn_end: true, idle_ms: arbClockValue('arbIdle'),
                    runtime_ms: arbClockValue('arbRuntime') },
      });
      // Nothing is drawn optimistically. The session exists when the relay says it does, and a
      // strip that appears before the starter prompt landed would be reporting a session that a
      // failed send is about to end.
    }

    // --- the detail sheet ---------------------------------------------------------------
    //
    // One decision per block, newest first: what triggered it, what the arbitrator was shown, what
    // it decided and why, and the text that was typed at a member because of it. A send nobody
    // typed is only accountable if all four can be read back together.

    function arbDecTitle(d, session) {
      const to = ((session || {}).members || []).find(m => m.id === d.to);
      const who = d.gate === 'call_human' ? 'you' : (to ? to.label || d.to : d.to || '—');
      return d.valid ? `#${d.sequence} · ${d.gate || '?'} · ${who}`
                     : `#${d.sequence} · refused · ${(d.reject_code || 'invalid').replace(/_/g, ' ')}`;
    }

    // `details` rather than a toggle of this app's own: the prompt and the sent text are long, and
    // a native disclosure is the one thing here that already works with a screen reader and a
    // find-in-page.
    function arbDecText(summary, text) {
      if (!text) return '';
      return `<details class="arb-dec-text"><summary>${escapeHtml(summary)}</summary>` +
        `<pre>${escapeHtml(text)}</pre></details>`;
    }

    function arbDetailHtml(decisions, session) {
      if (decisions === null) return '<p class="arb-dec-empty">Reading the session…</p>';
      if (!decisions.length) {
        return '<p class="arb-dec-empty">Nothing decided yet. The first decision is written when ' +
          'a member ends a turn and the arbitrator answers.</p>';
      }
      return decisions.slice().reverse().map(d => {
        const when = d.at ? new Date(d.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
        return `<div class="arb-dec${d.valid ? '' : ' bad'}">` +
          `<p class="arb-dec-head"><span>${escapeHtml(arbDecTitle(d, session))}</span>` +
          `<span class="arb-dec-at">${escapeHtml(when)}</span></p>` +
          (d.why ? `<p class="arb-dec-why">${escapeHtml(d.why)}</p>` : '') +
          (d.ambiguity || d.complexity
            ? `<p class="arb-dec-meta">ambiguity ${escapeHtml(d.ambiguity || '—')} · ` +
              `complexity ${escapeHtml(d.complexity || '—')}</p>` : '') +
          arbDecText(d.prompt ? `What it was shown · ${d.prompt.trigger || 'prompt'}` : '',
                     d.prompt ? d.prompt.body : '') +
          arbDecText('What it wrote', d.instruction) +
          // Said, not left blank. A decision with no send is either a refusal or a delivery the
          // relay could not prove, and the second is the one a person has to go and look at.
          (d.send
            ? arbDecText(`What was typed · ${d.send.pane_id}`, d.send.text)
            : (d.valid ? '<p class="arb-dec-meta">Nothing recorded as delivered — the pane never ' +
                         'confirmed it.</p>' : '')) +
          '</div>';
      }).join('');
    }

    function arbRenderDetail() {
      const el = document.getElementById('arbDetailBody');
      if (el) el.innerHTML = arbDetailHtml(arbDetail, arbSession);
    }

    function arbOpenDetail() {
      if (!arbSession) return;
      if (arbDetailFor !== arbSession.id) arbDetail = null;   // never the previous session's
      const el = document.getElementById('arbSheet');
      if (el) el.style.display = 'block';
      arbRenderDetail();
      // Unconditionally, unlike the bubbles' own ask: the sheet is somebody looking now, and the
      // held copy may be a poll old. It is the same round trip either way.
      arbDetailFor = arbSession.id;
      arbDetailSeq = (arbSession.last_decision || {}).sequence || 0;
      arbSend({type: 'arb_detail', session: arbSession.id});
    }

    // Closing the sheet hides the sheet. The decisions stay: the thread is drawing bubbles from
    // the same copy, and throwing it away here would blank them until the next decision arrived.
    // `arbReset` is what drops it, because that is the one event that makes it another relay's.
    function closeArbDetail() {
      const el = document.getElementById('arbSheet');
      if (el) el.style.display = 'none';
    }

    // Ignored unless it answers the session being held. A late answer to a session that has since
    // ended is prose about something else entirely.
    function arbReceiveDetail(msg) {
      if (!arbDetailFor || (msg.session || '') !== arbDetailFor) return;
      arbDetail = Array.isArray(msg.decisions) ? msg.decisions : [];
      arbRenderDetail();
      // And the thread, which draws from the same rows. Only when there is one on screen — this
      // arrives on every decision, and a render is not free.
      if (typeof convCurrentId === 'function' && convCurrentId() &&
          typeof renderConvView === 'function') renderConvView();
      if (typeof renderConvStandalone === 'function') renderConvStandalone(false);
    }

    function arbCommand(type, extra) {
      if (!arbSession) return;
      arbSend(Object.assign({ type: type, session: arbSession.id }, extra || {}));
    }
