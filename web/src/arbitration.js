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
    let arbSessions = [];       // unfinished sessions, newest first; one may be running
    // The conversation the setup dialog is open over, or '' when it is closed. The dialog is drawn
    // once, when it opens, and never again while it is open: its pane lists are derived from live
    // status, and a candidate going `working` two seconds in would otherwise rebuild the textarea a
    // scope is being typed into. A stale option is answered by the relay, which re-checks every
    // participant anyway; a sentence taken out from under someone is not answered by anything.
    let arbSetupConv = '';
    // The session the dialog is editing, or '' when it is appointing a new one. The same three
    // questions either way — who decides, and the two it decides between — so the same form asks
    // them; what changes is that an edit starts from what the session already says and sends only
    // what the person moved.
    let arbSetupSession = '';
    let arbHtmlLast = '';
    // What the arbitrator was given, what it decided, and what was typed as a result. Fetched and
    // never pushed — it carries prose, which the relay answers only to the client that asked
    // (§15.2) — and held once for the two readers of it: the detail sheet, and the bubbles the
    // thread draws from the same rows.
    //
    // `arbDetailAt` is how far the held copy goes — see `arbDetailStamp` — so a re-ask happens when
    // the session actually moved and not on every poll that repeats a budget.
    let arbDetail = null, arbEvents = null, arbDetailFor = '', arbDetailAt = '';

    // What Resume would do, as of the answer that opened the sheet. Held beside the events rather
    // than read off the session message every render: the session message is broadcast on state
    // changes and the plan moves without one — a member goes idle, a drop box gains a file — so
    // the copy that arrived with the path is the one that matches the path being read.
    let arbPlan = null, arbResumeOpen = false;

    // Per connection, never cached: a capability is a fact about the relay on the other end of
    // this socket, and the next one may be a different relay entirely.
    function arbReset() {
      arbOn = false;
      arbSession = null;
      arbSessions = [];
      closeArbSetup();
      arbHtmlLast = '';
      arbDetail = null;
      arbEvents = null;
      arbDetailFor = '';
      arbDetailAt = '';
      arbPlan = null;
      closeArbDetail();
      closeArbResume();
      const el = document.getElementById('arbStrip');
      if (el) el.innerHTML = '';
      arbSyncOpenButton();
      // The tab too. A badge raised by a session this browser can no longer see is one nothing it
      // does will clear — the same gap the two receivers below close, at the other end.
      syncBrowserTab();
    }

    function arbReceiveSessions(msg) {
      arbOn = true;
      arbSessions = (msg.sessions || []).filter(s => s && s.state !== 'ended');
      arbSession = arbSessions[0] || null;
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
      const was = arbSessions.find(x => x.id === s.id);
      arbSessions = arbSessions.filter(x => x.id !== s.id);
      if (s.state !== 'ended') arbSessions.unshift(s);
      arbSession = arbSessions[0] || null;
      // The session it was appointing now exists, so the form that appointed it is answered.
      if (s.state !== 'ended' && s.conversation === arbSetupConv) closeArbSetup();
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
      return arbSessions.some(s => s.state === 'paused');
    }

    // On the transition into paused, not on the state. A pause stands until somebody answers it,
    // and a chime on every poll would be an alarm with no off switch.
    function arbAlertPause(s) {
      const why = (s.last_decision || {}).why;
      // No mark: a toast is textContent, and the one thing it must never carry is markup.
      showToast('Arbitration paused — ' + (s.pause_reason === 'call_human'
        ? (why || 'the arbitrator is asking for you')
        : String(s.pause_reason || 'stopped').replace(/_/g, ' ')));
      if (window.cue) cue('chime');
    }

    // Is this pane the one deciding? Asked by every list that draws a pane, because an arbitrator
    // mid-session looks exactly like an ordinary agent and is not one: what is typed there is read
    // by something whose entire instruction is to answer with a JSON file.
    function arbIsArbitrator(paneId) {
      return !!(paneId && arbSessions.some(s => (s.arbitrator || {}).pane_id === paneId));
    }

    function arbSessionForConversation(convId) {
      return (convId && arbSessions.find(s => s.conversation === convId)) || null;
    }

    // The session the conversation on screen is under, and **never** another one's. Several may be
    // open at once — the relay runs one loop at a time but keeps every paused session — so a
    // control drawn over one conversation that reached the newest session anywhere is a Pause
    // landing in a thread the person is not looking at.
    function arbSessionHere() {
      return arbSessionForConversation(
        typeof convCurrentId === 'function' ? convCurrentId() : '');
    }

    // What a *pane* is taking part in, as a member or as the arbitrator. The pane view has no
    // conversation to scope by, so this is what scopes it instead.
    function arbSessionForPane(paneId) {
      if (!paneId) return null;
      return arbSessions.find(s => (s.arbitrator || {}).pane_id === paneId ||
        (s.members || []).some(m => m.pane_id === paneId)) || null;
    }

    // ⚖ over a thread. Shown only where it has somewhere to go, and lit only when that somewhere
    // is an arbitrator already at work — an always-on button that sometimes opens a form and
    // sometimes jumps to a terminal is one a person cannot predict.
    function arbSyncOpenButton() {
      const here = arbSessionHere();
      const conv = typeof convCurrentId === 'function' ? convCurrentId() : '';
      arbMarkButton('convArbitrator', arbOn && !!conv, (here || {}).arbitrator,
                    'Start arbitrating this conversation');
      const mine = arbSessionForPane(activePane);
      arbMarkButton('paneArbitrator', arbOn && !!mine, (mine || {}).arbitrator, '');
    }

    function arbMarkButton(id, show, arb, idleLabel) {
      const el = document.getElementById(id);
      if (!el) return;
      // `on` is what makes a .hang-btn visible at all — the class the refresh and the jump are
      // drawn by. `live` is the second question: whether the tap goes to an arbitrator already at
      // work, or offers to appoint one.
      const at = arb && arb.pane_id;
      el.classList.toggle('on', !!show);
      el.classList.toggle('live', !!at);
      const label = at ? `Open ${arb.label || 'the arbitrator'}’s pane` : idleLabel;
      el.title = label;
      el.setAttribute('aria-label', label);
    }

    // Two states and no third: this conversation has an arbitrator, so go to it — or it does not,
    // so open the form that gives it one. Reaching the newest session anywhere is what put a tap
    // on this button into somebody else's conversation.
    function arbOpenFromConv() {
      const at = ((arbSessionHere() || {}).arbitrator || {}).pane_id;
      if (at) { openTerminal(at); return; }
      const conv = loadConvIndex().find(c => c.id === convCurrentId());
      if (!conv) return;
      const live = arbLiveMembers(conv), free = arbCandidates(conv);
      // Refused only when the dialog could do nothing about it. A missing member or a missing
      // arbitrator is a slot away now that each one can start its own — what is not answerable
      // from here is a relay that will not start agents at all, or a conversation whose own
      // members are in two projects, which no new pane fixes.
      if (!arbCanSpawn() && (live.length < 2 || !free.length)) {
        showToast(arbWhyNot(live, free, arbProject(conv)));
        return;
      }
      // A conversation whose own live members are in two projects is the one refusal a new pane
      // cannot fix. An *empty* one also has no project — that is not a disagreement, it is a room
      // with nobody in it yet, and filling it is what + New is for.
      if (live.length >= 2 && arbProject(conv) === null) {
        showToast(arbWhyNot(live, free, null));
        return;
      }
      openArbSetup();
    }

    // From a pane, there is no conversation and no strip — only the session this pane is in, if it
    // is in one, and the arbitrator reading it.
    function arbOpenFromPane() {
      const at = ((arbSessionForPane(activePane) || {}).arbitrator || {}).pane_id;
      if (at && at !== activePane) openTerminal(at);
    }

    function arbMark(paneId) {
      return arbIsArbitrator(paneId)
        ? ' <span class="badge arb" title="The arbitrator of a running session">' +
          arbSign(15) + '</span>' : '';
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

    // Panes another session already holds, as the arbitrator or as a member. Two arbitrators
    // typing into one terminal is the one thing independent sessions must not do to each other, and
    // the relay refuses it at enrolment (`participant_in_session`) — for a paused session too,
    // because a pause is not a release. Offered here, it is a choice that exists to be refused.
    //
    // `except` is the session whose own roster is being edited: its members are the answer to that
    // question, not a conflict with it.
    function arbTakenPanes(except) {
      const out = new Set();
      arbSessions.forEach(s => {
        if (except && s.id === except) return;
        const arb = (s.arbitrator || {}).pane_id;
        if (arb) out.add(arb);
        (s.members || []).forEach(m => { if (m.pane_id) out.add(m.pane_id); });
      });
      return out;
    }

    function arbUntaken(panes, except) {
      const taken = arbTakenPanes(except);
      return panes.filter(x => !taken.has(x.pane_id));
    }

    // The project the *roster* has to be in, which is not always the project the conversation is
    // in. The relay refuses participants that span two (`project_mismatch`) and says nothing about
    // anyone else — so once two members are picked, they are the answer. A third member sitting in
    // another checkout is not a reason the two on screen cannot be arbitrated, and after a slot
    // spawned an agent into a second project it was the reason the dialog offered no arbitrator at
    // all and then called it busy.
    //
    // Before anything is picked there is nothing to read but the conversation, which is what the
    // ⚖ button asks about.
    function arbPickedProject(conv, at) {
      const picked = [(at || {}).arbFirst, (at || {}).arbSecond]
        .map(id => id && agents.find(x => x.pane_id === id)).filter(Boolean);
      if (!picked.length) return arbProject(conv);
      const ids = new Set(picked.map(x => x.project_id || ''));
      return ids.size === 1 ? (picked[0].project_id || '') : null;
    }

    // Everything live that is not in this conversation, and is in the roster's project. The
    // arbitrator is deliberately outside the conversation: it is not a participant in it, it is the
    // thing deciding what happens in it — but it is in the same repository, or it cannot read the
    // work.
    function arbCandidates(conv, project, except) {
      const taken = new Set((conv.members || []).map(m => m.key));
      if (project === undefined) project = arbProject(conv);
      if (project === null) return [];
      return arbUntaken(agents.filter(x => convMemberKey(x) && !taken.has(convMemberKey(x)) &&
        (x.project_id || '') === project &&
        x.status !== 'working' && x.status !== 'blocked'), except);
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
      if (on) arbAskDetail(arbSessionHere());
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
      const at = arbDetailStamp(session);
      if (arbDetailFor === session.id && arbDetailAt === at) return;
      if (arbDetailFor !== session.id) { arbDetail = null; arbEvents = null; arbPlan = null; }
      arbDetailFor = session.id;
      arbDetailAt = at;
      // Without the prose, unless a sheet is open. This ask fires on every event a session
      // records and the bubbles draw none of the prompt, the instruction or the sent text —
      // carrying them was a fifth of a megabyte an event, six times what the thread can use.
      arbSend({type: 'arb_detail', session: session.id, brief: !arbSheetsOpen()});
    }

    // Either sheet on screen. Read off the DOM rather than tracked: the detail sheet has no open
    // flag of its own, and a second copy of "is it visible" is a second thing to get wrong.
    function arbSheetsOpen() {
      if (arbResumeOpen) return true;
      const el = document.getElementById('arbSheet');
      return !!el && el.style.display === 'block';
    }

    // How far this session has got, as one comparable string: the last decision, the state it is
    // in, and the relay's own watermark over the path.
    //
    // The decision alone is what this used to be, and it is the one thing a stuck session never
    // moves — a loop waiting on a record that never arrives, or dropping triggers at a paused
    // session, sat at the same sequence for ever and the thread never asked again. Which is
    // precisely when a person is reading it.
    function arbDetailStamp(s) {
      return [(s.last_decision || {}).sequence || 0, s.state || '', s.pause_reason || '',
              s.event_at || 0].join('|');
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
      const s = arbSessionForConversation(convId);
      if (!s || !arbBubblesOn() || !convId || s.conversation !== convId) return [];
      if (arbDetailFor !== s.id || !Array.isArray(arbDetail)) return [];
      const arb = s.arbitrator || {};
      const members = s.members || [];
      return arbEventEntries(arb).concat(arbDetail.filter(d => d.valid).map(d => {
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
      })).sort((a, b) => (a.at || 0) - (b.at || 0));
    }

    // The steps between the decisions: what the arbitrator was asked, the record it wrote, what
    // was typed at a member because of it, and every stop and error on the way. Drawn in the same
    // shape a commit strip and a `call_human` rail are drawn in — a small thing that happened at
    // this point in the thread, not a message anybody sent — because that is what they are.
    //
    // `decided` is left out: the decision bubble directly beneath it says the same gate, the same
    // member and the arbitrator's own sentence about why. Everything else has no other way to be
    // seen, which is the whole reason the path is recorded.
    const ARB_EVENT_LEDE = {
      started: 'session started', briefed: 'briefed', trigger: 'trigger', asked: 'asked',
      human: 'you typed',
      waiting: 'waiting', record: 'record written', decided: '', rejected: 'record refused',
      reprompt: 're-asked', sent: 'sent', paused: 'paused', resumed: 'resumed',
      warmed: 'woke',
      edited: 'session edited', ended: 'session ended', error: 'error',
    };

    function arbEventEntries(arb) {
      if (!Array.isArray(arbEvents)) return [];
      return arbEvents.filter(e => ARB_EVENT_LEDE[e.kind]).map(e => ({
        who: 'arbiter', event: true, kind: e.kind, lede: ARB_EVENT_LEDE[e.kind],
        text: e.detail || '', at: e.at || 0, seen: e.at || 0, at_src: 'sent',
        key: ARB_ENTRY_KEY, member: 0, live: true,
        label: arb.label || 'Arbitrator', agent: arb.agent || '',
        // The two a person is looking for when a session stopped, in the colour the thread already
        // uses for "this is the part that went wrong".
        warn: e.kind === 'error' || e.kind === 'rejected' || e.kind === 'paused',
      }));
    }

    // The relay's pause codes, in the words a person would use. The codes are exact and several
    // of them name their own mechanism rather than the reader's problem — `budget_consecutive` is
    // a count of automated sends nobody joined in on, which is "needs a human" and nothing else.
    // The sentence under the strip still gives the whole of it; this is the two words on the chip.
    const ARB_PAUSE_SHORT = {
      budget_steps: 'out of steps',
      budget_consecutive: 'needs a human',
      budget_time: 'out of time',
      call_human: 'needs you',
      invalid_record: 'bad decision file',
      send_unconfirmed: 'send not confirmed',
      arbitrator_gone: 'arbitrator gone',
      member_gone: 'member gone',
      member_ambiguous: 'two panes match',
      restart: 'relay restarted',
      not_started: 'not started',
      user: 'by you',
    };

    function arbStateLabel(s) {
      if (s.state === 'paused') {
        const code = String(s.pause_reason || 'stopped');
        return 'Paused · ' + (ARB_PAUSE_SHORT[code] || code.replace(/_/g, ' '));
      }
      // A pane sitting on a permission prompt, wherever it is: from a state pill that says
      // "Deciding…" a blocked arbitrator is indistinguishable from one that is thinking, and the
      // session will not move again until somebody answers that prompt. It is the one thing the
      // tray has to say out loud now that the sentence under it lives in the sheet.
      const stuck = arbStuck(s);
      if (stuck) return `${stuck.label || stuck.id || 'Arbitrator'} needs you`;
      return s.state === 'awaiting' ? 'Deciding…' : 'Arbitrating';
    }

    // Whichever of the three is on a permission prompt, or nothing.
    function arbStuck(s) {
      return [s.arbitrator || {}].concat(s.members || []).find(w => w.status === 'blocked') || null;
    }

    // What a pause reason means, in a sentence, and what to do about it. The codes are the
    // relay's and they are precise; "budget consecutive" is not a thing a person can act on
    // without being told that it counts sends nobody joined in on and that resuming clears it.
    const ARB_PAUSE_WHY = {
      budget_steps: 'This session has taken every step it was given. Resuming buys nothing — ' +
        'start a new session for more.',
      budget_consecutive: 'That many automated sends in a row with nobody joining in. Resuming ' +
        'clears the run, and so does typing at either agent yourself.',
      budget_time: 'The session ran out its clock. Resuming grants it a fresh one.',
      call_human: 'The arbitrator asked for you. Read what it decided, then resume.',
      invalid_record: 'The arbitrator wrote something that was not a decision, twice. ↻ Brief ' +
        'gives it its instructions again in an empty pane.',
      send_unconfirmed: 'A send could not be confirmed. Look at the pane before resuming — the ' +
        'text may have landed anyway.',
      arbitrator_gone: 'The deciding pane has exited. Edit the session to appoint another.',
      member_gone: 'A member’s pane has exited. Edit the session to put another in its place.',
      member_ambiguous: 'A member’s fingerprint now matches two panes, so nothing can be typed ' +
        'at it safely. Edit the session to name one.',
      restart: 'The relay restarted while this was running. Nothing was decided in between.',
      not_started: 'Briefed and waiting for you to start it.',
      user: 'You stopped it.',
    };

    function arbStateTitle(s) {
      if (s.state !== 'paused') {
        return s.state === 'awaiting' ? 'The arbitrator is reading and has not answered yet.'
                                      : 'Armed — the next turn that ends is a decision.';
      }
      return ARB_PAUSE_WHY[s.pause_reason] || 'The session stopped and is waiting for you.';
    }

    function arbBudgetLine(s) {
      const b = s.budget || {};
      return `${b.steps_left || 0} steps · ${b.minutes_left || 0} min`;
    }

    // The running session, or nothing at all. Pure so the shape of every state can be asserted
    // without a browser — which matters more here than usual, because the states that go wrong are
    // the ones a person is least likely to be sitting in front of.
    //
    // Nothing at all when this conversation has no session: the strip sits above the thread and
    // pushes every message down by its own height, and a person reading a conversation nobody is
    // arbitrating was paying that for a button. Appointing one is the ⚖ in the header, which costs
    // no height and is there whether or not the thread is scrolled to the top.
    // The eye, for the one control here that is a view toggle rather than an action. Inline
    // rather than a glyph: nothing in the emoji set reads as "shown/hidden" at 13px, and the two
    // states are the same drawing in two colours, which a font cannot give.
    // The tray's controls, drawn rather than typed. A glyph row is at the mercy of the font: ⏭ and
    // ▶ arrive at different weights and different widths, ⓘ is a full-height circle next to a
    // half-height ✎, and on a phone at least one of them is a colour emoji nobody asked for. These
    // are one 24-box and one stroke width, so the row reads as one set of six.
    const ARB_ICONS = {
      edit: '<path d="M4.5 19.5h4L19 9a2.1 2.1 0 0 0-3-3L5.5 15.5v4z" />',
      log: '<path d="M4.5 7h15M4.5 12h15M4.5 17h9" />',
      steps: '<circle cx="12" cy="12" r="8.5" /><path d="M12 11.2v5" />' +
             '<path d="M12 7.6h.01" />',
      play: '<path d="M8.5 5.8 18.5 12 8.5 18.2z" fill="currentColor" stroke-linejoin="round" />',
      kick: '<path d="M5.5 5.8 14 12 5.5 18.2z" fill="currentColor" stroke-linejoin="round" />' +
            '<path d="M18 5.8v12.4" />',
      pause: '<path d="M9.3 5.8v12.4M14.7 5.8v12.4" />',
    };

    function arbGlyph(name) {
      return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
        'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        ARB_ICONS[name] + '</svg>';
    }

    // Two drawings, not one in two colours: shown is an open eye, hidden is the same eye struck
    // through. A toggle whose only difference is a colour is a toggle nobody can read the state of
    // without pressing it.
    function arbEye(on) {
      return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M1.5 12S5.5 5 12 5s10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" />' +
        '<circle cx="12" cy="12" r="3" />' +
        (on ? '' : '<path d="M4 20 20 4" />') + '</svg>';
    }

    // The mark for everything arbitration: three signal lights. Drawn rather than typed so it is
    // the same size in every place it appears, and so the theme owns the red, amber and green.
    function arbSign(size) {
      const px = size || 20;
      // Three lights in a triangle — red on top, amber and green under it — and nothing else: an
      // outline around them was three specks inside a box at the sizes this is actually drawn at.
      //
      // The cluster is centred on the 24-box rather than on its own centroid, so the mark sits
      // level with the text beside it and centred in a 28px button. Each light carries a thin ring
      // of `currentColor` at a third opacity: on a dark ground the amber and green need an edge to
      // stop them bleeding into it, and a ring that is the text colour is one that every theme
      // already agrees with.
      return `<svg class="arb-sign" viewBox="0 0 24 24" width="${px}" height="${px}"` +
        ' aria-hidden="true">' +
        arbLight(12, 8.37, 'red') + arbLight(7.8, 15.64, 'orange') +
        arbLight(16.2, 15.64, 'green') + '</svg>';
    }

    function arbLight(cx, cy, colour) {
      return `<circle cx="${cx}" cy="${cy}" r="4" fill="var(--${colour})"` +
        ' stroke="currentColor" stroke-opacity="0.35" stroke-width="1.1" />';
    }

    function arbStripHtml(session, conv, on) {
      if (!on || !conv || !session || session.conversation !== conv.id) return '';
      const s = session, paused = s.state === 'paused';
      // Drawn as the same 28px chip as the row in the opposite corner — see `.hang-float`. They
      // float over one thread and belong to it equally, and a second visual language for the
      // controls on the left would read as a second kind of thing.
      //
      // The name is what it is called — the accessible name, and the only thing a screen reader
      // or a test has to go on. The title is the sentence about it, which is a tooltip and must
      // never be the name: "Resume — arm the loop and wait for the next turn to end" is not what
      // anybody calls that button.
      const icon = (glyph, name, why, onclick, cls) =>
        `<button class="hang-btn arb-ico${cls ? ' ' + cls : ''}" ${onclick}` +
        ` title="${escapeHtml(why)}" aria-label="${escapeHtml(name)}">${glyph}</button>`;
      const lead = arbLeadsWithTrigger(s);
      // Anywhere that is not a button opens the sheet. The tray says where the session is and no
      // longer says what that means or what Resume would do — those are a paragraph each, and a
      // paragraph floating over a thread is a second thread. A tap is the way to the rest.
      return '<div class="arb-strip" onclick="if (!event.target.closest(\'button\'))' +
        ' arbOpenResume()"' + ` data-state="${escapeHtml(s.state || '')}"` +
        `${arbStuck(s) ? ' data-blocked="1"' : ''}>` +
        '<div class="arb-bar">' +
        // Left to right, least to most consequential: the two dialogs, then the toggle, then what
        // acts on the session. Nothing that ends or empties something is here at all — Re-brief
        // and End live in the Edit dialog, behind a deliberate trip, because the strip is a row of
        // 28px squares over a thread being read with a thumb.
        //
        // The dialog that appointed it, opened on what it already says.
        icon(arbGlyph('edit'), 'Edit', 'Change this session — who, what for, and who decides',
             'onclick="arbEditHere()"') +
        // The path: what was asked, what was written, what was typed and where it stopped.
        icon(arbGlyph('log'), 'Log', 'What this session has done, step by step',
             'onclick="arbOpenDetail()"') +
        // Here and not in the pane menu with the other reading toggles: this one is only ever a
        // question while a session is running, and the strip is the only thing on screen that
        // exists exactly then.
        `<button class="hang-btn arb-ico${arbBubblesOn() ? ' lit' : ''}"` +
        ` onclick="toggleArbBubbles()" aria-pressed="${arbBubblesOn() ? 'true' : 'false'}"` +
        ' title="Show what the arbitrator decided, in the thread"' +
        ` aria-label="Arbitrator’s decisions in the thread">${arbEye(arbBubblesOn())}</button>` +
        // What a resume does first. Armed, it waits for a trigger — a member ending a turn, or a
        // clock — and with two idle members and no clocks that is a session that reads as running
        // and never acts. `Ask the arbitrator now` puts the question straight to it — the relay
        // calls that a `kick`, and it is the way out of a question that was asked and never
        // answered. Two buttons rather than
        // one that guesses, and which of them is lit comes from the plan: the relay has already
        // worked out whether arming alone would do anything. Last, and in that order, because the
        // plain Resume is the one a thumb reaches for without looking.
        (paused
          ? icon(arbGlyph('kick'), 'Ask the arbitrator now',
                 'Resume and ask the arbitrator for a decision now',
                 'onclick="arbCommand(\'arb_resume\', {kick: true})"', lead ? 'lit' : '') +
            icon(arbGlyph('play'), 'Resume', 'Arm the loop and wait for the next turn to end',
                 'onclick="arbCommand(\'arb_resume\')"', lead ? '' : 'lit') +
            // Last, beside the button it explains: the sheet it opens is the answer to "what will
            // Resume do", and the tray under it no longer carries that sentence.
            icon(arbGlyph('steps'), 'Steps', 'The last steps, and what Resume will do',
                 'onclick="arbOpenResume()"')
          : icon(arbGlyph('pause'), 'Pause', 'Stop the loop — nothing is sent until it is resumed',
                 'onclick="arbCommand(\'arb_pause\')"')) +
        '</div>' + arbSayHtml(s) + '</div>';
    }

    // Whether arming alone would do nothing. Defined once, in `arbLeads`, so the strip and the
    // sheet cannot disagree about which button is the answer.
    function arbLeadsWithTrigger(s) {
      return arbLeads(s.plan, s);
    }

    // Where the session is, under the row of icons: the state, and what is left of the budget.
    // Both are facts rather than controls, both are short enough never to wrap, and neither is a
    // sentence — what the state means and what Resume would do are paragraphs, and they live in
    // the sheet a tap on the tray opens rather than floating over the thread.
    function arbSayHtml(s) {
      // A row each. Side by side they were two chips fighting for a line the tray is only as wide
      // as its buttons — and the state is the one that has to be readable, so it is the one that
      // gets a line of its own to wrap into.
      return '<div class="arb-say">' +
        `<span class="arb-say-state">${escapeHtml(arbStateLabel(s))}</span>` +
        `<span class="arb-say-budget">${escapeHtml(arbBudgetLine(s))}</span>` +
        '</div>';
    }

    // --- appointing one -------------------------------------------------------------------
    //
    // Three sections because there are three decisions, and they used to be interleaved: who
    // decides, and the two it is deciding between. The scope is above all three because it is the
    // one thing every one of them is read against.
    //
    // Pure, and given its lists rather than reading them, for the same reason the strip is: the
    // states worth asserting are the ones nobody is sitting in front of.
    function arbSetupHtml(live, free, at, editing) {
      at = at || {};
      return '<label>Scope<textarea id="arbScope" rows="2" maxlength="4000"' +
        ' placeholder="What this session is for, and when it should stop.">' +
        escapeHtml(at.arbScope || '') + '</textarea></label>' +
        // The one that decides. It is deliberately not in the conversation — it is not a
        // participant in it, it is the thing deciding what happens in it — so its list is the panes
        // outside the conversation and inside its project.
        arbPart('Arbitrator',
          arbSlot('arbWho', free, at.arbWho || (free[0] || {}).pane_id) +
          // §10's two clocks, off by default and folded away because of it. A turn ending is
          // always a trigger; these are for the two ways a conversation stops without anyone's
          // turn ending — a member that went quiet, and one that has been working long enough to
          // be stuck. Both are `Never` until somebody goes looking for them, and two selects
          // saying Never are two rows of a dialog spent on nothing.
          '<details class="arb-more"><summary>Clocks and limits</summary>' +
          '<label>If a member goes quiet<select id="arbIdle">' +
          arbClockOptions(ARB_IDLE_CHOICES, at.arbIdle) + '</select></label>' +
          '<label>If a member works without stopping<select id="arbRuntime">' +
          arbClockOptions(ARB_RUNTIME_CHOICES, at.arbRuntime) + '</select></label>' +
          // The three hard stops, editable here and nowhere else. A session that spends one is
          // paused until a person raises it, and until this dialog carried them the only answer
          // to that was to throw the session away and start another.
          arbLimitField('arbSteps', 'Stop after this many sends', at.arbSteps,
                        ARB_LIMITS.arbSteps) +
          arbLimitField('arbRuns', 'Stop after this many in a row with nobody joining in',
                        at.arbRuns, ARB_LIMITS.arbRuns) +
          arbLimitField('arbMinutes', 'Stop after this many minutes', at.arbMinutes,
                        ARB_LIMITS.arbMinutes) +
          // A cold agent answers its first prompt with nothing — the harness wakes, redraws, and
          // the turn ends with no reply — and the arbitrator then reports, correctly and
          // uselessly, that the member said nothing. agy does it reliably enough to be woken
          // whether or not this is ticked, which the note says rather than hides.
          `<label class="arb-check"><input id="arbWarmup" type="checkbox"` +
          `${at.arbWarmup ? ' checked' : ''}> Wake the members before the first instruction` +
          '</label>' +
          '<span class="arb-note">agy is always woken — it is the one that needs it.</span>' +
          '</details>', arbSign(16) + ' ') +
        // The two being arbitrated, named rather than assumed. In a two-member conversation these
        // are the only answer and the selects say so by having one option each; past two they are
        // the question the strip used to refuse to ask.
        arbPart('Agent 1',
          arbSlot('arbFirst', live, at.arbFirst || (live[0] || {}).pane_id) +
          arbRoleField('arbRoleFirst', at.arbRoleFirst)) +
        arbPart('Agent 2',
          arbSlot('arbSecond', live, at.arbSecond || (live[1] || {}).pane_id) +
          arbRoleField('arbRoleSecond', at.arbRoleSecond)) +
        // Only when appointing one. A session that is already running has been armed or not
        // armed already, and the strip's Pause and Resume are where that is changed.
        (editing ? arbSessionActionsHtml() : arbArmChoiceHtml()) +
        '<div class="arb-form-actions">' +
        '<button class="arb-btn" onclick="closeArbSetup()">Cancel</button>' +
        (editing
          ? '<button class="arb-btn go" onclick="arbSave()">Save</button>'
          : '<button class="arb-btn go" onclick="arbStart()">Start</button>') + '</div>';
    }

    // The two that empty or end something. They used to sit on the strip, one tap from a thread
    // being scrolled with a thumb — armed, but armed is one mistap away from done. Here they are
    // behind opening a dialog, which is the trip that suits what they do, and they are the only
    // things in it that are not a field.
    //
    // Editing only: a session that does not exist yet has nothing to re-brief or end.
    function arbSessionActionsHtml() {
      return '<div class="arb-part arb-danger">' +
        '<button type="button" class="arb-btn arm-btn"' +
        ` onclick="armButton(this, 'Re-brief?', () => arbSessionAction('arb_reinit'))">` +
        'Re-brief the arbitrator</button>' +
        '<button type="button" class="arb-btn arm-btn warn"' +
        ` onclick="armButton(this, 'End session?', () => arbSessionAction('arb_cancel'))">` +
        'End session</button>' +
        '<span class="arb-note">Re-briefing empties the arbitrator’s context and gives it its ' +
        'brief again — the session and its record are kept. Ending it is final.</span>' +
        '</div>';
    }

    // Both close the dialog they were pressed in: the form behind them describes a session that
    // is about to be re-briefed or gone, and leaving it open invites a Save on top of that.
    function arbSessionAction(command) {
      closeArbSetup();
      arbCommand(command);
    }

    // The pane, or a new one. A room is often assembled from nothing — two fresh agents and
    // something to decide between them — and leaving this dialog to start each one loses every
    // answer already in it. So each slot can start its own, and the new pane lands *here*: it is
    // chosen in the slot that asked for it and the page does not move.
    function arbSlot(id, panes, selected) {
      return '<div class="arb-slot">' + arbPaneSelect(id, panes, selected, '') +
        (arbCanSpawn()
          ? `<button type="button" class="badge pick proj" onclick="arbSpawnFor('${id}')"` +
            ' title="Start a new agent and put it in this slot">+ New</button>' : '') +
        '</div>';
    }

    // The New agent dialog is the one that knows how to start one, and it is two taps. Guarded by
    // `typeof` because arbitration is drawn by relays that never sent `start_options`, and a
    // missing Start is a slot with no + New rather than a broken page.
    function arbCanSpawn() {
      return typeof canStartFromConv === 'function' && canStartFromConv();
    }

    function arbSpawnFor(slot) {
      if (arbCanSpawn()) openNewAgent(slot);
    }

    // What the dialog is holding right now, keyed by the element it is in — which is also what
    // `arbSetupHtml` reads, so a redraw is "read it, change one field, draw it again".
    function arbReadSetup() {
      const at = {};
      ['arbScope', 'arbWho', 'arbFirst', 'arbSecond', 'arbRoleFirst', 'arbRoleSecond',
       'arbIdle', 'arbRuntime', 'arbSteps', 'arbRuns', 'arbMinutes'].forEach(id => {
        at[id] = (document.getElementById(id) || {}).value || '';
      });
      // A checkbox answers with `checked`, not `value` — read the same way as the rest, every
      // session would be a woken one.
      at.arbWarmup = !!(document.getElementById('arbWarmup') || {}).checked;
      return at;
    }

    // A pane started for a slot, once the poll has it. A member joins the conversation, because
    // that is what the two being arbitrated are; the arbitrator does not, because it is not a
    // participant in the conversation — it is the thing deciding what happens in it.
    //
    // Nothing is opened. The person is half way through filling this dialog in, and landing them
    // in a terminal is losing it.
    function arbAdoptStarted(a, want) {
      const at = arbSetupOpen() ? arbReadSetup() : {};
      if (want.slot !== 'arbWho') {
        const items = loadConvIndex();
        const conv = items.find(c => c.id === want.conv);
        if (conv && !(conv.members || []).some(m => m.key === convMemberKey(a))) {
          conv.members = (conv.members || []).concat(convMemberOf(a));
          saveConvIndex(items);
        }
      }
      at[want.slot] = a.pane_id;
      const conv = loadConvIndex().find(c => c.id === want.conv);
      if (conv) arbDrawSetup(conv, at);
    }

    // A rule above rather than a box around: the three are a reading order, not three forms.
    function arbPart(lede, body, mark) {
      return '<div class="arb-part"><span class="arb-part-lede">' +
        (mark || '') + `${escapeHtml(lede)}</span>` + body + '</div>';
    }

    function arbSetupOpen() {
      return !!arbSetupConv;
    }

    // Drawn once, on open, and left alone after — see `arbSetupConv`. `at` is what the dialog was
    // holding, passed back in on the two redraws there are: a pane that went busy while the scope
    // was being written, and a pane started from a slot.
    function arbDrawSetup(conv, at) {
      const el = document.getElementById('arbSetupBody');
      // The session being edited is not a conflict with itself: its own three panes are the
      // answer to the question this dialog is asking, not a clash with it.
      const mine = arbSetupSession;
      const free = arbWithPick(arbCandidates(conv, arbPickedProject(conv, at), mine),
                               (at || {}).arbWho);
      // Members too, and for the same reason: a member of another session is a pane that session
      // is deciding about, and enrolling it here would put two arbitrators over one terminal.
      const live = arbWithPick(arbUntaken(arbLiveMembers(conv), mine), (at || {}).arbFirst);
      if (el) {
        el.innerHTML = arbSetupHtml(arbWithPick(live, (at || {}).arbSecond), free, at, !!mine);
      }
      const name = document.getElementById('arbSetupConvName');
      if (name) name.textContent = conv.name || '';
      arbSetupConv = conv.id;
      const box = document.getElementById('arbModal');
      if (box) box.style.display = 'block';
    }

    function openArbSetup(session) {
      const conv = loadConvIndex().find(c => c.id === convCurrentId());
      if (!conv) return;
      arbStartPaused = false;
      arbSetupSession = (session || {}).id || '';
      arbDrawSetup(conv, session ? arbSetupOf(session) : null);
    }

    // A running session, as an answer to the form that would have created it. The one place the
    // two shapes are converted into each other, so `arbSave` can send what moved by comparing the
    // form against this rather than against a session in a different shape.
    function arbSetupOf(s) {
      const m = s.members || [], t = s.triggers || {}, b = s.budget || {};
      return {
        arbScope: s.scope || '',
        arbWho: (s.arbitrator || {}).pane_id || '',
        arbFirst: (m[0] || {}).pane_id || '', arbSecond: (m[1] || {}).pane_id || '',
        arbRoleFirst: (m[0] || {}).role || '', arbRoleSecond: (m[1] || {}).role || '',
        arbIdle: String((t.idle_ms || 0) / 60000), arbRuntime: String((t.runtime_ms || 0) / 60000),
        // The maxima, not what is left of them: this form sets limits, and a session two sends
        // from its stop would otherwise redraw itself as a session that may take two sends.
        arbSteps: String(b.max_steps || ARB_LIMITS.arbSteps[0]),
        arbRuns: String(b.max_consecutive || ARB_LIMITS.arbRuns[0]),
        arbMinutes: String(b.max_minutes || ARB_LIMITS.arbMinutes[0]),
        arbWarmup: !!s.warmup,
      };
    }

    // From the strip. The session on screen and no other — every control there routes through the
    // conversation, because pausing what is being read must never pause what is not.
    function arbEditHere() {
      const s = arbSessionHere();
      if (s) openArbSetup(s);
    }

    // An arbitrator started from this dialog a second ago is `working` while its TUI comes up, and
    // `arbCandidates` drops a working pane — so the slot the person just filled would empty itself
    // under them. Held in the list by name. Whether it can actually take the brief is still the
    // relay's answer, and it refuses a busy arbitrator (N7).
    function arbWithPick(list, paneId) {
      if (!paneId || list.some(x => x.pane_id === paneId)) return list;
      const a = agents.find(x => x.pane_id === paneId);
      return a ? list.concat([a]) : list;
    }

    function closeArbSetup() {
      arbSetupConv = '';
      arbSetupSession = '';
      const box = document.getElementById('arbModal');
      if (box) box.style.display = 'none';
    }

    // Whether the loop is armed behind the brief. Two different things wearing one word until now:
    // the starter prompt goes out either way — that is what makes an agent an arbitrator — and
    // this decides only whether a turn ending starts costing budget. A person assembling a room
    // wants the brief first and the loop when they say so.
    let arbStartPaused = false;

    // The badges are repainted where they stand rather than through a redraw of the dialog: the
    // scope textarea is in the same element, and rebuilding it would take a half-written sentence
    // out from under the person writing it. Same reason the role pills do it this way.
    function arbPickStartPaused(paused) {
      arbStartPaused = paused;
      const box = document.getElementById('arbArmPills');
      if (box) box.innerHTML = arbArmPillsHtml();
      if (window.cue) cue('tick');
    }

    function arbArmChoiceHtml() {
      return '<div class="arb-role"><span class="arb-role-lede">On start</span>' +
        `<div class="arb-roles" id="arbArmPills">${arbArmPillsHtml()}</div></div>`;
    }

    function arbArmPillsHtml() {
      return badgeHtml('Start deciding', !arbStartPaused, 'arbPickStartPaused(false)',
                       {proj: true, title: 'Brief the arbitrator and arm the loop'}) +
        badgeHtml('Brief only', arbStartPaused, 'arbPickStartPaused(true)',
                  {proj: true, title: 'Brief the arbitrator and leave it paused until you resume'});
    }

    // Minutes, because that is the unit a person thinks about a stuck agent in. `0` is off, and
    // off is the default for both — a clock nobody asked for is an unattended loop spending budget.
    const ARB_IDLE_CHOICES = [0, 5, 15, 30];
    const ARB_RUNTIME_CHOICES = [0, 15, 30, 60];

    // `[default, max]` for each hard stop, matching `DEFAULT_BUDGET` and `BUDGET_MAX` in
    // relay/arbitration.py. Kept in step by hand, because the relay refuses anything over the max
    // and a form that offers what will be refused is worse than one that never showed the field.
    // The same two ranges twice: the resume sheet asks for a budget too, and a field there that
    // accepted a number the dialog would refuse is one the relay answers with an error nobody
    // asked for.
    const ARB_LIMITS = {arbSteps: [8, 50], arbRuns: [8, 20], arbMinutes: [45, 480],
                        arbResumeSteps: [8, 50], arbResumeMins: [45, 480]};

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
    //
    // An empty label draws no label: in the dialog the section heading above it already says which
    // pane is being picked, and a row reading "Pane" under one reading "① Agent 1" is a line of
    // height spent saying nothing.
    function arbPaneSelect(id, panes, selected, label) {
      return `<label>${label ? escapeHtml(label) : ''}<select id="${id}">` +
        panes.map(x => `<option value="${escapeHtml(x.pane_id)}"` +
          `${x.pane_id === selected ? ' selected' : ''}>${escapeHtml(paneLabel(x))}</option>`)
          .join('') + '</select></label>';
    }

    // Why the ⚖ did not open anything, instead of a tap that did nothing. A conversation with
    // three members, or with every other pane busy, silently had no arbitration at all and no way
    // to find out why. Both reasons are things a person can act on, so both are said out loud.
    function arbWhyNot(live, free, project) {
      const why = live.length < 2
        ? 'Arbitration watches two agents talk. This conversation has ' +
          (live.length === 1 ? 'one live member.' : 'none live.')
        : project === null
        ? 'Arbitration needs everyone in one project, and this conversation spans more than one.'
        : 'Arbitration needs a third agent in this project to decide, and every other pane here ' +
          'is busy right now.';
      return why;
    }

    // A number, bounded. `type="number"` because the browser already knows how to draw a stepper
    // and a phone already knows to show a numeric keypad for one.
    function arbLimitField(id, label, value, range) {
      return `<label>${escapeHtml(label)}<input id="${id}" type="number" class="arb-limit"` +
        ` min="1" max="${range[1]}" value="${escapeHtml(String(value || range[0]))}"></label>`;
    }

    // What the field says, or the default — never NaN and never over the relay's cap, which is the
    // one refusal this dialog can prevent rather than report.
    function arbLimitValue(id) {
      const range = ARB_LIMITS[id];
      const n = parseInt((document.getElementById(id) || {}).value || '', 10);
      return !(n > 0) ? range[0] : Math.min(n, range[1]);
    }

    function arbClockOptions(choices, selected) {
      return choices.map(m => `<option value="${m}"${String(m) === String(selected) ? ' selected' : ''}>` +
        `${m ? m + ' min' : 'Never'}</option>`).join('');
    }

    function arbClockValue(id) {
      const minutes = parseInt((document.getElementById(id) || {}).value || '0', 10);
      return minutes > 0 ? minutes * 60000 : 0;
    }

    // Diffed, and that is not an optimisation: the scope textarea lives in this element, and a
    // redraw on every poll would take a half-written sentence out from under the person writing it.
    function arbRender() {
      arbSyncOpenButton();
      const el = document.getElementById('arbStrip');
      if (!el) return;
      const conv = typeof convCurrentId === 'function'
        ? loadConvIndex().find(c => c.id === convCurrentId()) : null;
      // A session attached to this conversation is the one its controls must operate on. The
      // primary session remains the fallback solely to suppress a second Start while another loop
      // is active — the relay is still the final authority for that refusal.
      // This conversation's session and no other. There is nothing to fall back to any more:
      // sessions run in parallel, so another conversation having one says nothing about this one.
      const session = conv ? arbSessionForConversation(conv.id) : null;
      // A dialog appointing an arbitrator for a conversation nobody is reading any more is one
      // whose Start would land somewhere else.
      if (arbSetupOpen() && (!conv || arbSetupConv !== conv.id)) closeArbSetup();
      if (session) arbAskDetail(session);
      const html = arbStripHtml(session, conv || null, arbOn);
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

    // Everything the relay has to be told the truth about, checked before it is told anything.
    // Shared by the two things this dialog does — appoint one, and change a running one — because
    // the questions are the same three panes and the same scope either way. Says what is wrong and
    // returns nothing; a caller that gets nothing sends nothing.
    //
    // `except` is the session being edited: its own three panes are the answer to this form, not a
    // clash with it.
    function arbCheckSetup(conv, at, except) {
      const who = at.arbWho;
      // Not filtered by what other sessions hold: an empty count here would say "start one" about
      // a conversation whose panes are taken, and the taken check below is the sentence that
      // actually names the problem.
      const live = arbLiveMembers(conv);
      const free = arbCandidates(conv, arbPickedProject(conv, at), except);
      const scope = at.arbScope.trim();
      const picks = [at.arbFirst, at.arbSecond];
      const roles = ['arbRoleFirst', 'arbRoleSecond'].map(arbRoleValue);
      if (!scope) { showToast('Say what this session is for.'); return null; }
      if (live.length < 2 || !picks[0] || !picks[1] || !who) {
        // Sayable now that a slot can fill itself: an empty one used to mean the conversation was
        // short a member and there was nothing to be done about it from here.
        showToast('Two agents and one to decide between them — + New starts a missing one.');
        return null;
      }
      if (picks[0] === picks[1]) {
        showToast('Two different panes — one agent has nobody to talk to.');
        return null;
      }
      const taken = arbTakenPanes(except);
      if ([picks[0], picks[1], who].some(id => taken.has(id))) {
        showToast('One of those is already in another arbitration session.');
        return null;
      }
      // A slot may have started an agent in another Project. Said here, about the three panes
      // actually chosen — which is what the relay checks (`project_mismatch`) — rather than about
      // the conversation, whose other members it does not ask about. Before this the roster went
      // out to be refused, or worse came back called "busy": with no single project, there were no
      // candidates at all and the arbitrator pick failed the liveness test below.
      const chosen = [picks[0], picks[1], who].map(id => agents.find(x => x.pane_id === id));
      if (new Set(chosen.map(x => (x || {}).project_id || '')).size > 1) {
        showToast('Arbitration needs every selected agent in the same project.');
        return null;
      }
      // The frozen list is what was on screen; this is the live one. A pane that started working
      // while the scope was being written is said out loud rather than swallowed, and the form is
      // redrawn on what is free now — with the scope kept, because that is the part worth keeping.
      if (!free.some(x => x.pane_id === who)) {
        // Held in the list it was just dropped from, so the answer is still on screen while the
        // sentence explaining it is read. An arbitrator started from this dialog a moment ago is
        // the common case: it is `working` until its TUI comes up, and the relay refuses a busy
        // one (N7) rather than briefing something that is not listening yet.
        arbDrawSetup(conv, at);
        showToast('That pane is not free — if it has just started, give it a moment.');
        return null;
      }
      return {
        scope: scope, picks: picks, who: who, roles: roles,
        idle: arbClockValue('arbIdle'), runtime: arbClockValue('arbRuntime'),
        budget: {
          max_steps: arbLimitValue('arbSteps'),
          max_consecutive: arbLimitValue('arbRuns'),
          max_wall_clock_ms: arbLimitValue('arbMinutes') * 60000,
        },
        warmup: !!at.arbWarmup,
      };
    }

    // Pane ids and a scope. Not agent, cwd or label: the relay reads a participant's identity off
    // its own pane list, because a fingerprint this browser supplies is one it can have stale.
    function arbStart() {
      const conv = loadConvIndex().find(c => c.id === convCurrentId());
      if (!conv) return;
      const got = arbCheckSetup(conv, arbReadSetup(), '');
      if (!got) return;
      arbSend({
        type: 'arb_start', conversation: conv.id, scope: got.scope,
        members: got.picks.map((pane_id, i) => ({ pane_id: pane_id, role: got.roles[i] })),
        arbitrator: { pane_id: got.who },
        triggers: { on_turn_end: true, idle_ms: got.idle, runtime_ms: got.runtime },
        budget: got.budget,
        warmup: got.warmup,
        paused: arbStartPaused,
      });
      // The dialog is done — it asked its questions. Nothing is drawn in its place, though: the
      // session exists when the relay says it does, and a strip that appeared before the starter
      // prompt landed would be reporting a session that a failed send is about to end.
      closeArbSetup();
    }

    // The same form, against a session that already exists. Only what moved is sent: the relay
    // announces a roster change to the members and re-briefs a swapped arbitrator, so naming a
    // field that did not change is an interruption nobody asked for.
    function arbSave() {
      const s = arbSessions.find(x => x.id === arbSetupSession);
      const conv = loadConvIndex().find(c => c.id === convCurrentId());
      if (!s || !conv) return;
      const at = arbReadSetup();
      const got = arbCheckSetup(conv, at, s.id);
      if (!got) return;
      const was = arbSetupOf(s), t = s.triggers || {};
      const msg = { type: 'arb_edit', session: s.id };
      if (got.scope !== was.arbScope) msg.scope = got.scope;
      if (got.picks[0] !== was.arbFirst || got.picks[1] !== was.arbSecond ||
          got.roles[0] !== was.arbRoleFirst || got.roles[1] !== was.arbRoleSecond) {
        msg.members = got.picks.map((pane_id, i) => ({ pane_id: pane_id, role: got.roles[i] }));
      }
      if (got.who !== was.arbWho) msg.arbitrator = { pane_id: got.who };
      if (got.idle !== (t.idle_ms || 0) || got.runtime !== (t.runtime_ms || 0)) {
        msg.triggers = { on_turn_end: true, idle_ms: got.idle, runtime_ms: got.runtime };
      }
      if (got.warmup !== was.arbWarmup) msg.warmup = got.warmup;
      if (String(got.budget.max_steps) !== was.arbSteps ||
          String(got.budget.max_consecutive) !== was.arbRuns ||
          String(got.budget.max_wall_clock_ms / 60000) !== was.arbMinutes) {
        msg.budget = got.budget;
      }
      // Closed either way. Nothing moved is an answer to the question the dialog asked.
      if (Object.keys(msg).length > 2) arbSend(msg);
      closeArbSetup();
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

    // Every step, newest last, above the decisions. This is what a stopped session is opened for:
    // the state says it stopped and the reason says what tripped, and neither says which step it
    // got to — whether the prompt went out, whether a record was ever written, whether the
    // instruction reached the member.
    // The steps the poll loop repeats while nothing is moving. Worth recording and not worth
    // reading: at four polls a minute a stopped session's path is mostly these, and the row a
    // person opened the sheet for is the one they scroll past looking for them.
    const ARB_STEP_NOISE = ['waiting', 'warmed'];
    const ARB_PATH_KEY = 'herdr_arb_path';

    function arbPathFilter() {
      return localStorage.getItem(ARB_PATH_KEY) === 'all' ? 'all' : 'key';
    }

    function setArbPathFilter(v) {
      try { localStorage.setItem(ARB_PATH_KEY, v === 'all' ? 'all' : 'key'); }
      catch (e) { /* private mode: this session only */ }
      arbRenderDetail();
    }

    function arbPathHtml(events) {
      if (!Array.isArray(events) || !events.length) return '';
      const filter = arbPathFilter();
      const rows = filter === 'all' ? events
        : events.filter(e => !ARB_STEP_NOISE.includes(e.kind));
      const toggle = ['key', 'all'].map(v =>
        `<button class="arb-filter" aria-pressed="${filter === v ? 'true' : 'false'}"` +
        ` onclick="setArbPathFilter('${v}')">${v === 'key' ? 'Key steps' : 'All'}</button>`).join('');
      // Where it is stopped *now*: the last pause with no resume under it. Marked rather than
      // left to be inferred from the last row, because the last row of a stopped session is
      // often a trigger that arrived after the stop and was dropped — which reads like progress.
      const stopped = rows.map(e => e.kind).lastIndexOf('paused');
      const breakpoint = stopped >= 0 && !rows.slice(stopped + 1).some(e => e.kind === 'resumed')
        ? stopped : -1;
      return '<details class="arb-path" open><summary>The path</summary>' +
        `<p class="arb-path-bar">${toggle}` +
        `<span class="arb-path-count">${rows.length} of ${events.length} steps</span></p>` +
        rows.map((e, i) => {
          const when = e.at
            ? new Date(e.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
          const bad = e.kind === 'error' || e.kind === 'rejected' || e.kind === 'paused';
          return `<p class="arb-step${bad ? ' bad' : ''}${i === breakpoint ? ' stop' : ''}">` +
            `<span class="arb-step-at">${escapeHtml(when)}</span>` +
            `<span class="arb-step-kind">${escapeHtml(e.kind || '')}</span>` +
            `<span>${escapeHtml(e.detail || '')}` +
            `${i === breakpoint ? '<span class="arb-step-stop"> ◀ stopped here</span>' : ''}` +
            '</span></p>';
        }).join('') + '</details>';
    }

    // How long ago, in the coarsest unit that is still true. A member that went quiet is read as
    // "did I forget this?", and the answer to that is minutes and hours, never seconds.
    function arbAgo(at) {
      const ms = Date.now() - (at || 0);
      if (ms < 90_000) return 'just now';
      const mins = Math.round(ms / 60000);
      return mins < 60 ? `${mins} min ago`
        : `${Math.round(mins / 60)} h ago`;
    }

    // What Resume will do, in the words of the thing it will do — the relay works the case out
    // with the same code that acts on it (`resume_plan`), so this only has to say it.
    //
    // The reason this exists: four of these read identically from outside — the button says
    // Resume and the session says paused — and one of them, `wait`, does nothing you can see.
    // That is the session left armed and idle while a member sits finished, which is the single
    // most expensive way this feature fails.
    // What Resume will do, in as few words as it takes — and the detail under it, for the reader
    // who wants it. Two fields rather than one sentence: the first line answers "can I press it",
    // and everything that made the old single sentence long (which member, how long ago, what the
    // other button does) is the second, which nobody has to read to act.
    //
    // The reason this exists: four resumes read identically from outside — the button says Resume
    // and the session says paused — and one of them, `wait`, does nothing you can see. That is a
    // session left armed while a member sits finished, which is the most expensive way this
    // feature fails.
    // How long a question can be out before "it is still deciding" stops being the truth. An
    // arbitrator answers in seconds; anything on the order of a coffee break is one that is not
    // going to. The number only chooses which of two sentences is shown and which button leads —
    // both buttons stay pressable either way.
    const ARB_COLD_ASK_MS = 10 * 60 * 1000;

    // When the outstanding question was asked, if this browser has the path for this session.
    // Nothing when it does not, which reads as "not cold" — the quieter of the two claims.
    function arbAskedAt(session) {
      if (!session || arbDetailFor !== session.id || !Array.isArray(arbEvents)) return 0;
      const asked = arbEvents.filter(e => e.kind === 'asked');
      return asked.length ? (asked[asked.length - 1].at || 0) : 0;
    }

    function arbColdAsk(session) {
      const at = arbAskedAt(session);
      return !!at && Date.now() - at > ARB_COLD_ASK_MS;
    }

    function arbPlanLine(plan, session) {
      const seq = plan.sequence;
      const s = session || {};
      if (plan.action === 'collect') {
        return {line: 'A decision is written and ready to send.',
                hint: `Resume sends what the arbitrator decided for step #${seq}.`};
      }
      if (plan.action === 'await') {
        // The one that cost a real session two days. The arbitrator was asked at #8 and never
        // wrote an answer, and every Resume after that went straight back to waiting on the same
        // dead question — which the path recorded, correctly and uselessly, five times over. The
        // way out is Ask now: it throws the old question away and asks a fresh one.
        const at = arbAskedAt(s);
        if (arbColdAsk(s)) {
          return {line: `The arbitrator was asked at step #${seq} and never answered.`,
                  hint: `Asked ${arbAgo(at)}. Resume goes straight back to waiting on that same ` +
                    'question — Ask now throws it away and asks again, which is the only way out ' +
                    'of an arbitrator that is not going to answer.'};
        }
        return {line: 'The arbitrator is deciding.',
                hint: `Asked ${at ? arbAgo(at) : `at step #${seq}`}. Resume goes back to waiting ` +
                  'for that answer. Ask now throws the question away and asks a fresh one.'};
      }
      if (plan.action === 'ask') {
        return {line: 'A turn ended while it was stopped.',
                hint: 'Resume asks the arbitrator to decide about it now. Nothing was lost — the ' +
                  'trigger was kept.'};
      }
      if (plan.stale) {
        const who = plan.stale.label || plan.stale.member;
        return {line: `${who} was written to and never came back.`,
                hint: `Written to ${arbAgo(plan.stale.at)}, and it has not ended a turn since. ` +
                  'Resume alone waits for a wake-up that has already been and gone — Ask now ' +
                  'asks the arbitrator to decide from what is already said.'};
      }
      // Armed and waiting. Which of two very different things that is depends on whether anybody
      // is working, and the difference is the whole question a person opens this to ask: a session
      // with a member mid-turn resumes into a decision, and one with nobody working resumes into
      // nothing at all until somebody gives an agent something to do.
      const busy = (s.members || []).filter(m => m.status === 'working' || m.status === 'blocked');
      if (busy.length) {
        const who = busy.map(m => m.label || m.id).join(' and ');
        return {line: `${who} ${busy.length > 1 ? 'are' : 'is'} working.`,
                hint: 'Resume arms the loop, and the arbitrator is asked the moment that turn ' +
                  'ends. Nothing to do but wait.'};
      }
      return {line: 'Nothing is pending and nobody is working.',
              hint: 'Resume arms the loop, but with every member idle there is no turn end coming ' +
                'to wake it — it will sit exactly like this. Give an agent something to do, or ' +
                'Ask now to have the arbitrator decide from what has already been said.'};
    }

    // Which of the two buttons is the answer here. The relay works out three of these cases
    // (`resume_plan`); the fourth — an armed session with nobody working — is a fact about the
    // panes, which the roster on the session message already carries.
    function arbLeads(plan, session) {
      if (!plan) return false;
      if (plan.stale || plan.action === 'ask') return true;
      if (plan.action === 'await') return arbColdAsk(session);
      if (plan.action === 'collect') return false;
      return !(session.members || []).some(m => m.status === 'working' || m.status === 'blocked');
    }

    function arbDetailHtml(decisions, session, events) {
      if (decisions === null) return '<p class="arb-dec-empty">Reading the session…</p>';
      if (!decisions.length) {
        return arbPathHtml(events) +
          '<p class="arb-dec-empty">Nothing decided yet. The first decision is written when ' +
          'a member ends a turn and the arbitrator answers.</p>';
      }
      return arbPathHtml(events) + decisions.slice().reverse().map(d => {
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

    // --- the resume dialog --------------------------------------------------------------
    //
    // Its own sheet, not a banner on the log. The log is a reading of everything this session did
    // and it will keep growing; this is the one question asked at the one moment a person is
    // standing at a stopped session with a finger over a button: what happens if I press it, and
    // what was the last thing that happened before it stopped.

    const ARB_RESUME_ROWS = 15;

    function arbResumeRows(events) {
      if (!Array.isArray(events)) return [];
      return events.filter(e => !ARB_STEP_NOISE.includes(e.kind)).slice(-ARB_RESUME_ROWS);
    }

    function arbResumeHtml(session, events, plan) {
      if (!session) return '';
      const rows = arbResumeRows(events);
      const paused = session.state === 'paused';
      const said = plan ? arbPlanLine(plan, session) : null;
      const lead = arbLeads(plan, session);
      // What the tray used to carry as a third row: what Resume would do, and what the state
      // means. It is two paragraphs, so it belongs where there is room for two paragraphs.
      const head = `<p class="arb-plan-line">${escapeHtml(said ? said.line : arbStateLabel(session))}</p>` +
        `<p class="arb-plan-hint">${escapeHtml(said ? said.hint : arbStateTitle(session))}</p>`;
      // What it gets to spend when it starts again. A session that stopped on a spent budget had
      // exactly one way out of it before this — the Edit dialog, three taps away from the button
      // that will not work — and every other resume is a moment where "how much more of this" is
      // the question already being asked.
      const b = session.budget || {};
      const budget = !paused ? '' :
        '<div class="arb-plan-budget">' +
        arbBudField('arbResumeSteps', 'Steps', b.steps_left, 1) +
        arbBudField('arbResumeMins', 'Minutes', b.max_minutes, 15) +
        '</div>';
      // Running, and the one thing worth doing to a running session from here is stopping it.
      // The sheet is opened by tapping the tray, which is a thing people do while a session is
      // going — and until now it answered a question nobody had asked yet.
      const acts = !paused
        ? '<div class="arb-plan-do">' +
          '<button class="arb-btn stop" onclick="arbCommand(\'arb_pause\')"' +
          ' title="Stop the loop — nothing is sent until it is resumed">' +
          arbGlyph('pause') + ' Pause</button></div>'
        : '<div class="arb-plan-do">' +
          `<button class="arb-btn${lead ? ' quiet' : ''}" onclick="arbResumeNow(false)">` +
          arbGlyph('play') + ' Resume</button>' +
          // Named for what it does rather than for the mechanism. A "trigger" is something that
          // *arrives* — a turn ending, a clock — and nothing here can send one; what this does is
          // skip waiting for one and put the question to the arbitrator now.
          `<button class="arb-btn${lead ? '' : ' quiet'}"` +
          ' onclick="arbResumeNow(true)" title="Resume and ask the arbitrator for a decision now"' +
          ` aria-label="Ask the arbitrator now">${arbGlyph('kick')} Ask now</button></div>`;
      // Where it is stopped *now*: the last pause with no resume under it. Not the last row — a
      // trigger that arrived after the stop sits below it and reads like progress.
      const stopped = rows.map(e => e.kind).lastIndexOf('paused');
      const mark = stopped >= 0 && !rows.slice(stopped + 1).some(e => e.kind === 'resumed')
        ? stopped : -1;
      // The newest trigger — the one a decision would be about if it were asked for now.
      const live = rows.map(e => e.kind).lastIndexOf('trigger');
      // Newest first. The question this table answers is "what was the last thing that happened",
      // and the answer to that was the row a person had to scroll to the bottom to find. The
      // stop marker is worked out above against the events in the order they happened, so only the
      // drawing is reversed.
      const body = rows.length
        ? rows.map((e, i) => {
            const when = e.at
              ? new Date(e.at).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
            const bad = e.kind === 'error' || e.kind === 'rejected' || e.kind === 'paused';
            // The one action the row invites, and only on the row it is still true of: the
            // newest trigger is the one a decision would be asked about, and the stop marker is
            // where the session actually is. The same buttons on every historical row would be
            // seven copies of one thing, all doing what the last of them does.
            const act = !paused
              // Running: the newest row is where the session is, and the one control that
              // applies to it is the one that stops it.
              ? (i === rows.length - 1
                 ? '<button class="arb-row-act stop" onclick="arbCommand(\'arb_pause\')"' +
                   ' title="Stop the loop — nothing is sent until it is resumed"' +
                   ` aria-label="Pause the session">${arbGlyph('pause')}</button>`
                 : '')
              : i === live ? arbRowAct('kick', true, 'Ask the arbitrator to decide about this now')
              : i === mark ? arbRowAct('play', false, 'Resume from here')
              : '';
            return `<tr class="${bad ? 'bad' : ''}${i === mark ? ' stop' : ''}">` +
              `<td class="arb-row-at">${escapeHtml(when)}</td>` +
              `<td class="arb-row-seq">${e.sequence ? '#' + escapeHtml(String(e.sequence)) : ''}</td>` +
              `<td class="arb-row-kind"><span class="arb-badge" data-kind="${escapeHtml(e.kind || '')}">` +
              `${escapeHtml(e.kind || '')}</span></td>` +
              `<td class="arb-row-act-cell">${act}</td>` +
              `<td>${escapeHtml(e.detail || '')}` +
              `${i === mark ? '<span class="arb-step-stop"> ◀ stopped here</span>' : ''}</td></tr>`;
          }).reverse().join('')
        : '<tr><td colspan="5" class="arb-dec-empty">Nothing has happened yet.</td></tr>';
      return `<div class="arb-plan${plan && plan.stale ? ' warn' : ''}">${head}${budget}${acts}</div>` +
        '<table class="arb-rows"><thead><tr><th>Time</th><th>Step</th><th>What</th>' +
        '<th></th><th>Detail</th></tr></thead><tbody>' + body + '</tbody></table>';
    }

    // One budget field: a number, and the two buttons that are how it is actually set. This is
    // read standing at a stopped session with a thumb — "a bit more" is the whole question — and a
    // number field on a phone is a keyboard over the sheet to change 8 into 12. The field stays
    // typeable for the times that is what somebody wants.
    //
    // The step is the field's own unit: steps go one at a time because that is what a step is, and
    // minutes go a quarter of an hour, because nobody grants a session one more minute.
    function arbBudField(id, label, value, step) {
      const range = ARB_LIMITS[id];
      const nudge = (dir, sign, why) =>
        `<button type="button" class="arb-bud-btn" onclick="arbStepBy('${id}', ${dir}, ${step})"` +
        ` aria-label="${escapeHtml(why)} ${escapeHtml(label.toLowerCase())}">${sign}</button>`;
      return '<div class="arb-bud-field">' +
        `<span class="arb-bud-label">${escapeHtml(label)}</span>` +
        '<span class="arb-bud-stepper">' + nudge(-1, '−', 'Fewer') +
        `<input id="${id}" type="number" inputmode="numeric" class="arb-limit" min="1"` +
        ` max="${range[1]}" value="${escapeHtml(String(value || range[0]))}"` +
        ` aria-label="${escapeHtml(label)}">` +
        nudge(1, '+', 'More') + '</span></div>';
    }

    // A row's action, as the drawing alone. The words are in the banner above the table, where the
    // same two buttons are named — here they are one column of a table read by scanning, and a
    // labelled button in it is a second Detail column.
    function arbRowAct(glyph, kick, why) {
      return `<button class="arb-row-act" onclick="arbResumeNow(${kick})"` +
        ` title="${escapeHtml(why)}" aria-label="${escapeHtml(why)}">${arbGlyph(glyph)}</button>`;
    }

    // Bounded by the same range the relay enforces, so neither button can ask for a refusal.
    function arbStepBy(id, dir, step) {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = String(Math.max(1, Math.min(ARB_LIMITS[id][1],
                                             arbLimitValue(id) + dir * (step || 1))));
    }

    // Resume, with whatever the two fields say it may spend. The budget goes first and as its own
    // message: `arb_edit` is what changes a limit, and a resume that carried one would be a second
    // way to do the same thing for the relay to keep working.
    //
    // Steps are counted from the start of the session and a resume does not clear them, so asking
    // for N more is `spent + N` — the field says what it will have, not what its ceiling reads.
    // Minutes need no such arithmetic: the relay restarts the wall clock on every resume, so the
    // field is the window itself.
    function arbResumeNow(kick) {
      const s = arbSessionHere();
      if (!s) return;
      const b = s.budget || {};
      const steps = arbLimitValue('arbResumeSteps'), mins = arbLimitValue('arbResumeMins');
      const spent = Math.max(0, (b.max_steps || 0) - (b.steps_left || 0));
      // Never past the relay's own ceiling: a session that has already spent 45 of 50 cannot be
      // given 8 more, and the honest answer to that is the 5 it can have rather than a refusal.
      const want = Math.min(spent + steps, ARB_LIMITS.arbResumeSteps[1]);
      if (want !== b.max_steps || mins !== b.max_minutes) {
        arbSend({type: 'arb_edit', session: s.id,
                 budget: {max_steps: want, max_consecutive: b.max_consecutive || 8,
                          max_wall_clock_ms: mins * 60000}});
      }
      arbCommand('arb_resume', kick ? {kick: true} : undefined);
    }

    function arbRenderResume() {
      const el = document.getElementById('arbResumeBody');
      if (!el || !arbResumeOpen) return;
      const here = arbSessionHere();
      // The copy that came with the path when there is one, and the session message's own
      // otherwise — which is what an older relay leaves, and what this shows in the moment before
      // its own answer arrives.
      el.innerHTML = arbResumeHtml(here, arbEvents, arbPlan || (here || {}).plan || null);
      // The sheet is opened from the tray whatever the session is doing, and "Resume from here"
      // over a running one is a heading that describes a button that is not there.
      const title = document.getElementById('arbResumeTitle');
      if (title) {
        title.textContent = here && here.state !== 'paused' ? 'Where this session is'
                                                            : 'Resume from here';
      }
    }

    function arbOpenResume() {
      const session = arbSessionHere();
      if (!session) return;
      if (arbDetailFor !== session.id) { arbDetail = null; arbEvents = null; arbPlan = null; }
      arbResumeOpen = true;
      const el = document.getElementById('arbResumeSheet');
      if (el) el.style.display = 'block';
      arbRenderResume();
      // Always asked, never taken from the held copy: what Resume would do is exactly the thing
      // that moves while a session sits stopped, and this is somebody looking now.
      arbDetailFor = session.id;
      arbDetailAt = arbDetailStamp(session);
      arbSend({type: 'arb_detail', session: session.id});
    }

    function closeArbResume() {
      arbResumeOpen = false;
      const el = document.getElementById('arbResumeSheet');
      if (el) el.style.display = 'none';
    }

    function arbRenderDetail() {
      const el = document.getElementById('arbDetailBody');
      const here = arbSessionHere();
      if (el) el.innerHTML = arbDetailHtml(arbDetail, here, arbEvents);
      // The resume dialog reads the same two answers — the path and the plan that came with it —
      // and is open or not independently of this one.
      arbRenderResume();
    }

    function arbOpenDetail() {
      const session = arbSessionHere();
      if (!session) return;
      if (arbDetailFor !== session.id) { arbDetail = null; arbEvents = null; arbPlan = null; }
      const el = document.getElementById('arbSheet');
      if (el) el.style.display = 'block';
      arbRenderDetail();
      // Unconditionally, unlike the bubbles' own ask: the sheet is somebody looking now, and the
      // held copy may be a poll old. It is the same round trip either way.
      arbDetailFor = session.id;
      arbDetailAt = arbDetailStamp(session);
      arbSend({type: 'arb_detail', session: session.id});
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
      // A relay too old to send them is not a relay with an empty path — the thread draws none
      // either way, and the sheet says so rather than showing a session that did nothing.
      arbEvents = Array.isArray(msg.events) ? msg.events : null;
      // Worked out at the moment this answer was built, which is the only copy that matches the
      // path beside it. Absent from an older relay, and then the session message's own is used.
      arbPlan = msg.plan || null;
      arbRenderDetail();
      // And the thread, which draws from the same rows. Only when there is one on screen — this
      // arrives on every decision, and a render is not free.
      if (typeof convCurrentId === 'function' && convCurrentId() &&
          typeof renderConvView === 'function') renderConvView();
      if (typeof renderConvStandalone === 'function') renderConvStandalone(false);
    }

    // Every strip control routes through here, so this is the one place that has to be right:
    // the session named is the one this conversation is under. Pausing what is on screen must
    // never pause what is not.
    function arbCommand(type, extra) {
      const session = arbSessionHere();
      if (!session) return;
      arbSend(Object.assign({ type: type, session: session.id }, extra || {}));
    }
