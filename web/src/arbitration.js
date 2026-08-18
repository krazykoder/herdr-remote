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
    let arbHtmlLast = '';
    // The detail sheet: what the arbitrator was given, what it decided, and what was typed as a
    // result. Fetched and never pushed — it carries prose, which the relay answers only to the
    // client that asked (§15.2) — so it exists only while a sheet is open on one session.
    let arbDetail = null, arbDetailFor = '';

    // Per connection, never cached: a capability is a fact about the relay on the other end of
    // this socket, and the next one may be a different relay entirely.
    function arbReset() {
      arbOn = false;
      arbSession = null;
      arbFormPanes = null;
      arbFormConv = '';
      arbHtmlLast = '';
      closeArbDetail();
      const el = document.getElementById('arbStrip');
      if (el) el.innerHTML = '';
    }

    function arbReceiveSessions(msg) {
      arbOn = true;
      arbSession = (msg.sessions || [])[0] || null;
      arbRender();
    }

    // One session on any state change. `ended` is not a state to draw: the session is over, and a
    // strip reporting a finished session is chrome above a thread nobody is arbitrating.
    function arbReceiveSession(msg) {
      const s = msg.session;
      if (!s) return;
      arbOn = true;
      arbSession = s.state === 'ended' ? null : s;
      if (s.state !== 'ended') { arbFormPanes = null; arbFormConv = ''; }
      arbRender();
    }

    // The panes of this conversation that are live right now, in the conversation's own order.
    // A member that has exited is a member nothing can be typed at, so it is not a candidate.
    function arbLiveMembers(conv) {
      const live = new Map(agents.map(x => [convMemberKey(x), x]));
      return (conv.members || []).map(m => live.get(m.key)).filter(Boolean);
    }

    // Everything live that is not in this conversation. The arbitrator is deliberately outside it:
    // it is not a participant in the conversation, it is the thing deciding what happens in it.
    function arbCandidates(conv) {
      const taken = new Set((conv.members || []).map(m => m.key));
      return agents.filter(x => convMemberKey(x) && !taken.has(convMemberKey(x)) &&
        x.status !== 'working' && x.status !== 'blocked');
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

    function arbBudgetLine(s) {
      const b = s.budget || {};
      return `${b.steps_left || 0} steps · ${b.minutes_left || 0} min`;
    }

    // The strip, or the way to start one, or nothing. Pure so the shape of every state can be
    // asserted without a browser — which matters more here than usual, because the states that go
    // wrong are the ones a person is least likely to be sitting in front of.
    function arbStripHtml(session, conv, on, formPanes) {
      if (!on || !conv) return '';
      if (session && session.conversation === conv.id) {
        const s = session, paused = s.state === 'paused';
        return `<div class="arb-strip" data-state="${escapeHtml(s.state || '')}">` +
          `<span class="arb-state">${escapeHtml(arbStateLabel(s))}</span>` +
          // The line is the control: what a person wants after reading "review · Reviewer 1 · …"
          // is the rest of it, and a separate button for that would be chrome beside the answer.
          `<button class="arb-last" onclick="arbOpenDetail()"` +
          ` aria-label="What this session decided">${escapeHtml(arbLastLine(s))}</button>` +
          `<span class="arb-budget">${escapeHtml(arbBudgetLine(s))}</span>` +
          (paused
            ? '<button class="arb-btn" onclick="arbCommand(\'arb_resume\')">Resume</button>'
            : '<button class="arb-btn" onclick="arbCommand(\'arb_pause\')">Pause</button>') +
          // Asked twice: ending a session is not undoable, and the loop it stops is the reason
          // somebody left two agents running unattended.
          `<button class="arb-btn arm-btn" onclick="armButton(this, 'End?',` +
          ` () => arbCommand('arb_cancel'))"` +
          ` aria-label="End this arbitration session">End</button></div>`;
      }
      if (session) return '';   // running, but over some other conversation
      const live = arbLiveMembers(conv), free = arbCandidates(conv);
      if (live.length !== 2 || !free.length) return '';
      if (!formPanes || !formPanes.length) {
        return '<div class="arb-strip idle"><button class="arb-btn" onclick="arbToggleForm()">' +
          '⚖ Arbitrate</button></div>';
      }
      return '<div class="arb-form">' +
        `<p class="arb-who">${escapeHtml(live.map(paneLabel).join(' · '))}</p>` +
        '<label>Scope<textarea id="arbScope" rows="2" maxlength="4000"' +
        ' placeholder="What this session is for, and when it should stop."></textarea></label>' +
        '<label>Arbitrator<select id="arbWho">' +
        formPanes.map(x => `<option value="${escapeHtml(x.pane_id)}">${escapeHtml(paneLabel(x))}` +
          `</option>`).join('') + '</select></label>' +
        '<div class="arb-form-actions">' +
        '<button class="arb-btn" onclick="arbToggleForm()">Cancel</button>' +
        '<button class="arb-btn go" onclick="arbStart()">Start</button></div></div>';
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
      const html = arbStripHtml(arbSession, conv || null, arbOn, arbFormPanes);
      if (html !== arbHtmlLast) { arbHtmlLast = html; el.innerHTML = html; }
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
      if (!scope) { showToast('Say what this session is for.'); return; }
      if (live.length !== 2) return;
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
        members: live.map(a => ({ pane_id: a.pane_id })),
        arbitrator: { pane_id: who },
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
      arbDetail = null;                 // never the previous session's, not even for a frame
      arbDetailFor = arbSession.id;
      const el = document.getElementById('arbSheet');
      if (el) el.style.display = 'block';
      arbRenderDetail();
      arbSend({type: 'arb_detail', session: arbSession.id});
    }

    function closeArbDetail() {
      arbDetail = null;
      arbDetailFor = '';
      const el = document.getElementById('arbSheet');
      if (el) el.style.display = 'none';
    }

    // Ignored unless it answers the sheet that is open. A late answer to a session that has since
    // ended is prose about something else entirely.
    function arbReceiveDetail(msg) {
      if (!arbDetailFor || (msg.session || '') !== arbDetailFor) return;
      arbDetail = Array.isArray(msg.decisions) ? msg.decisions : [];
      arbRenderDetail();
    }

    function arbCommand(type) {
      if (!arbSession) return;
      arbSend({ type: type, session: arbSession.id });
    }
