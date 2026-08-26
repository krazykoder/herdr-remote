    // --- Start session dialog ---
    function fillSelect(id, options) {
      const el = document.getElementById(id);
      el.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
      el.disabled = !options.length;
      return options.length;
    }

    // The dialog reopens on the choices it was last used with. Spawning is repetitive — the same
    // agent into the same kind of place, several times an hour — and restating it every time is
    // the tax. Browser-local, like the rest of the per-device preferences.
    const START_AGENT_KEY = 'herdr_start_agent';
    const START_PLACE_KEY = 'herdr_start_placement';
    const START_ROLE_KEY = 'herdr_start_role';

    // The app's own badge, the one a pane header wears — `[name @project agent]` — offered as a
    // choice. Same shape, same colours, same rule about which of them is coloured: the harness
    // carries agentBadge's kind colour, and the role and the Project stay uncoloured beside it,
    // because colour in that row already means the kind. Shared with the conversation's New agent
    // dialog, which asks the same three questions in a smaller box.
    //
    // opts: {agent} colours it by kind, {proj} takes the Project badge's weight, {title} explains.
    function badgeHtml(label, on, call, opts) {
      const o = opts || {};
      const own = o.agent ? agentColor(o.agent) : '';
      // Picked wears its colour outright, over a wash of it; unpicked keeps the header's own
      // treatment — the kind tinted at the border, everything else neutral.
      const c = own || 'var(--blue)';
      const tint = on
        ? `color:${c};border-color:${c};background:color-mix(in srgb, ${c} 16%, transparent)`
        : (own ? `color:${own};border-color:color-mix(in srgb, ${own} 55%, transparent)` : '');
      return `<button type="button" class="badge pick${o.proj ? ' proj' : ''}${on ? ' on' : ''}" ` +
        `onclick="${call}" aria-pressed="${on}"` + (tint ? ` style="${tint}"` : '') +
        (o.title ? ` title="${escapeHtml(o.title)}"` : '') + `>${escapeHtml(label)}</button>`;
    }

    // Only the roles this relay will actually accept. A badge whose wire role it does not know
    // would be a refusal after the tap rather than a choice that was never offered.
    function startRoles() {
      const known = (startOptions && startOptions.roles) || [];
      return START_ROLES.filter(r => known.includes(r.role));
    }

    // What a starter role puts on the wire. The relay names a pane for the role it was given, and
    // it knows only its own three; a badge riding on one of those carries its own name as the label
    // instead, or an Arbitrator would come up called "Agent 1". A typed name always wins, and no
    // badge at all is a start with no role asked for — the field is a recommendation, not a gate.
    function startRoleFields(role, typed) {
      const known = (startOptions && startOptions.roles) || [];
      const wire = role && known.includes(role.role) ? role.role
        : (known.includes('agent') ? 'agent' : known[0]);
      // The badge's own name against the role it rides on: `@architect` goes out as `architect` and
      // the relay names the pane, `@arbitrator` goes out as `agent` and would come up called
      // "Agent 1", so it carries its name instead. Compared without the suffix — that is for the
      // composer, and the wire has never heard of it.
      const bare = String((role || {}).at || '').replace(/-prompt$/, '');
      const label = typed || (role && bare !== role.role ? role.name : '');
      const out = wire ? {role: wire} : {};
      if (label) out.label = label;
      return out;
    }

    // A session the relay just started, waiting for the poll to catch up so it can be opened.
    let pendingStart = null;
    // What the next successful start was asked for, when it was asked for from inside a pane:
    // 'open' to land in it regardless, {pair: paneId} to come back to the pair dialog with it
    // chosen. null — every other route in — keeps the old deferring behaviour. Set at request
    // time and cleared when it is acted on, so an abandoned dialog cannot claim a later start.
    let startIntent = null;
    // What the next successful start opens with: the starter role's prompt, or '' for a start made
    // without one. Kept apart from startIntent because it is a different question — where the new
    // pane lands versus what it is told first — and every route in can ask both.
    let startPrompt = '';
    // *Which* starter that was, as a SHORTCUTS `at`. The prompt is text and cannot be asked again
    // what it was; this is the name, and it is what makes a restart open the same way.
    let startStarter = '';

    // pane_id -> the `at` it was started under. Written by whoever starts a session, read by
    // convSpawn so a conversation records what the session *was* rather than guessing it back off
    // the pane's name.
    //
    // Guessing was the bug: a pane named for its role ("Architect 1") gave the right answer and a
    // pane named anything else — every session a launcher tile starts, which names its members
    // after the tile — gave none at all, so Start again brought it up silent. In memory only; the
    // durable copy is the one convSpawn writes into the conversation, and convSpawn keeps what is
    // already recorded rather than overwriting it with nothing after a reload.
    const paneStarter = new Map();

    // Bounded, because pane ids are recycled by herdr and this is never read for a pane that is not
    // on screen. Oldest first — a browser open for a week starting sessions all day is what this is
    // for, and the sessions that matter are the recent ones.
    const PANE_STARTER_MAX = 200;

    function notePaneStarter(paneId, at) {
      if (!paneId || !at) return;
      paneStarter.delete(paneId);
      paneStarter.set(paneId, at);
      while (paneStarter.size > PANE_STARTER_MAX) {
        paneStarter.delete(paneStarter.keys().next().value);
      }
    }

    async function openPendingStart() {
      if (!pendingStart) return;
      // Both lists: an opened terminal arrives in `shells`, and looking only at `agents` would
      // leave the pending id set for good, reopening nothing on every poll from then on.
      const a = paneOf(pendingStart);
      if (!a) return;
      // Cleared before opening, not after: openTerminal can throw on a half-rendered snapshot,
      // and a pending id that survives that would reopen the pane on every poll from then on.
      pendingStart = null;
      const intent = startIntent;
      startIntent = null;
      // Read once here for the same reason: a start that never came up must not leave its opening
      // words to be said to whatever is started next.
      //
      // Written for the pane that actually landed, not for the harness the caller had in mind when
      // it resolved the text. Those two disagree more often than they look: a member swapped from
      // one harness to another, a start whose kind came off a stale record, an alias resolved
      // somewhere that only knew its id. The pane is the one place the answer is a fact, and
      // agentSlash is idempotent, so a prompt already in the right form passes through untouched.
      const prompt = startPrompt ? agentSlash(startPrompt, a.agent) : '';
      const starterAt = startStarter;
      startPrompt = '';
      startStarter = '';
      // Before anything below opens, joins or sends: the first thing that happens to this pane may
      // be a record of it, and a record taken before this is one that learned nothing.
      notePaneStarter(a.pane_id, starterAt);
      // The pair dialog reopens on the pane it was left from, with the session that was started
      // for it already chosen, and saves itself. "Start a session and pair with it" already said
      // what the pair is; stopping at a filled-in form asks the user to confirm a decision they
      // made two dialogs ago, and the default name it fills in is the one they would have kept.
      // Only while the pane that asked is still live — a pair cannot be made against a pane that
      // has since exited, and the new session is better opened than left nowhere.
      if (intent && intent.pair && agents.some(x => x.pane_id === intent.pair)) {
        openPairDialog(intent.pair);
        choosePartner(a.pane_id);
        // Not when either pane is in a pair already: savePair drops it, and the warning
        // choosePartner has just written is the one thing that must not be auto-answered.
        // Nor when saving refuses — at the pair ceiling the dialog stays up holding the reason.
        if (![intent.pair, a.pane_id].some(id => pairFor(pairs, id))) savePair();
        const paired = !pairSource;   // savePair closes the dialog; a refusal leaves it open
        if (prompt) sendTextTo(a.pane_id, prompt);
        showSpawnStatus(`${a.label || a.agent || 'Session'} started` +
          (paired ? ' and paired.' : ' — confirm the pair.'), 'success');
        return;
      }
      // Started from a slot in the arbitration dialog. It is chosen there and nothing is opened —
      // the dialog behind is half filled in, and a terminal on screen is that work thrown away.
      // The prompt still goes, because a member started with something to say to it is a turn the
      // thread would otherwise be missing the start of.
      if (intent && intent.arb) {
        arbAdoptStarted(a, intent.arb);
        if (prompt) sendTextTo(a.pane_id, prompt);
        showSpawnStatus(`${a.label || a.agent || 'Session'} started — it is in the dialog.`,
                        'success');
        return;
      }
      // A launcher tile. What it asked for is a whole sequence rather than a destination — a
      // command to type, or the next member to start — so it is handed the pane and owns the rest.
      if (intent && intent.ql) {
        await launcherLanded(a, intent.ql);
        return;
      }
      // A respawn asked from a conversation replaces the ended member in that conversation. The
      // old terminal is gone, but its local thread is continued under this new pane's key.
      if (intent && intent.conv) {
        const next = convMemberKey(a);
        // The pair goes with it. A restart is the same colleague in a new pane, and the pair record
        // names panes by id — so without this the strip in the surviving partner reported the pair
        // stale and dropped the switch, the name and the badge.
        if (intent.replace) repointPair(convKeyPaneId(intent.replace), a);
        // The copy happens before the index is read, and the index is read again after it. The
        // recorder writes members' previews on every poll, so an index loaded before an await and
        // saved after it puts back a snapshot taken seconds ago — and the copy is the one step here
        // that waits on a database. A refusal (quota, a blocked store) falls back to joining as a
        // new member rather than dropping the pane out of the conversation altogether.
        const replacing = ((loadConvIndex().find(c => c.id === intent.conv) || {}).members || [])
          .find(m => m.key === intent.replace);
        const continued = replacing &&
          await convContinueTranscript(replacing.key, next, replacing.label).catch(() => false);
        const items = loadConvIndex();
        const conv = items.find(c => c.id === intent.conv);
        if (conv) {
          const prior = (conv.members || []).find(m => m.key === (replacing || {}).key);
          // Whether this pane is already one of this conversation's members. The fallback below
          // joins as a new member, which is right for a pane the conversation has never held and
          // wrong for one it already names: herdr recycles pane ids, and a replace intent that no
          // longer matches — a second landing, a member moved by the restart before it — would
          // otherwise append a second row for a key that is already in the list. Two members, one
          // pane, both drawing the same transcript.
          const already = (conv.members || []).some(m => m.key === next);
          conv.members = continued && prior
            ? conv.members.map(m => m.key === prior.key
              ? Object.assign({}, m, {
                  key: next, label: prior.label || paneLabel(a),
                  // The pane this member continues. This is the only place a member's key moves
                  // from one pane to another, so it is the only place succession is a fact rather
                  // than a guess — and the guess it replaces handed a quit agent's words to every
                  // conversation running the same harness in the same directory.
                  was: (m.was || []).concat(convKeyPaneId(prior.key))
                    .filter(Boolean).slice(-CONV_WAS_MAX),
                })
              : m)
            : (already ? conv.members : (conv.members || []).concat(convMemberOf(a)));
          saveConvIndex(items);
          // This conversation and not merely "on": the new pane is a member of exactly one so far,
          // but a respawn into a grouping the user chose must open on that grouping.
          convSetView(a, conv.id);
        }
        openTerminal(a.pane_id);
        // Started with something to say to it. The send goes through the same path a typed message
        // does, so the conversation records it as the user's — it is, and a first instruction that
        // was missing from the thread would be a turn nobody could see the start of. After the
        // membership above, so the thread it is recorded into is the one it was started for.
        if (prompt) sendTextTo(a.pane_id, prompt);
        showSpawnStatus(conv ? `${a.label || a.agent || 'Session'} continued "${conv.name}".`
          : `${a.label || a.agent || 'Session'} started.`, 'success');
        return;
      }
      // Never over a pane the user has since opened themselves — the start was a while ago in
      // phone terms, and yanking them out of what they are reading is worse than not landing.
      // Unless the start was a Duplicate, which is a request made from that very pane.
      if (intent === 'open' || !activePane) openTerminal(a.pane_id);
      if (prompt) sendTextTo(a.pane_id, prompt);
      showSpawnStatus(`${a.label || a.agent || 'Session'} started.`, 'success');
    }

    // A pane does not carry the role it was started with — herdr reports labels — so it is read
    // back off the label, which the relay derives from the role ("Architect 1"). A pane renamed
    // since falls back to the first role, the same one the dialog would have opened on.
    function roleOf(a) {
      const roles = (startOptions && startOptions.roles) || [];
      const first = String(a.label || '').split(' ')[0].toLowerCase();
      return roles.includes(first) ? first : roles[0];
    }

    // Can this pane be duplicated: the relay must be willing to start, the Project must be known,
    // and the agent must be one it will start. A pane running something outside the allowlist
    // would only earn an "agent not in allowlist" refusal, so the item is absent rather than dead.
    function canDuplicate(a) {
      return !!(a && a.agent && a.project_id && startOptions &&
        (startOptions.agents || []).includes(a.agent) && roleOf(a));
    }

    // Same harness, same Project, same tab, no dialog. Everything the dialog would have asked is
    // answered from the pane it was asked from — which is the whole point of the item.
    function duplicatePane() {
      const a = activePane ? agents.find(x => x.pane_id === activePane) : null;
      if (!ws || !canDuplicate(a)) return;
      // Same agent means the same agent config — and an alias the relay no longer offers is not a
      // reason to quietly bring the copy up on the stock endpoint under the same name. The dialog
      // is opened on that Project instead and the reader picks, which is the same answer Start
      // again gives to the same question.
      if (a.config && !(typeof agentConfigLive === 'function' && agentConfigLive(a.config, a.agent))) {
        openStartDialog(a.project_id);
        if (typeof showToast === 'function') {
          showToast(`Agent config "${a.config}" is gone. Pick what to start instead.`);
        }
        return;
      }
      const tab = !!a.workspace_id;
      const msg = {
        type: 'start_agent', name: a.agent, role: roleOf(a), project_id: a.project_id,
        // Beside it, so a duplicate lands where the pane it came from is. A pane whose workspace
        // the snapshot does not name has nowhere to be beside, and gets its own.
        placement: tab ? 'new_tab' : 'new_workspace', slot: slotFor(),
      };
      if (tab) msg.workspace_id = a.workspace_id;
      if (a.config) msg.config = a.config;
      // A duplicate comes up the way the pane it came from did, and the same default decides it:
      // the snapshot does not say how that one was started, so a config is the whole of what is
      // known about it.
      if (a.config && startUnattendedOffered(a.agent)) msg.unattended = true;
      // A duplicate opens the way the pane it came from opened. The wire role alone cannot say
      // that — Arbitrator and Orchestrator both go out as `agent` — so the starter is resolved the
      // same way a conversation resolves it: what this browser watched, then the pane's name.
      const dupAt = canonAt(typeof convStarterOf === 'function' ? convStarterOf(a) : '');
      startPrompt = roleStarter({at: dupAt}, a.agent);
      startStarter = dupAt;
      // No label: the relay names it for the role, so a duplicate of "Architect 1" arrives as
      // "Architect 2" rather than as a second pane with the same name.
      startIntent = 'open';
      showSpawnStatus(`Duplicating ${a.label || a.agent || 'session'}…`, 'busy');
      ws.send(JSON.stringify(msg));
    }

    // Spawn into the Project the open pane belongs to, without going back to the list to find
    // the card for it. Same dialog, same validation — only the Project is answered in advance.
    function startInThisProject() {
      const a = agents.find(x => x.pane_id === activePane);
      if (!a || !a.project_id) return;
      openStartDialog(a.project_id);
    }

    // Which starter role the sheet is holding, as the badge's `at`, or '' for none. A session is
    // better started as something, and the standard four are how this project works — but a start
    // with no role is still a start, so the badges are a row that can be left empty rather than a
    // select that always has an answer.
    let startRolePick = '';

    function renderStartRoles() {
      document.getElementById('startRoles').innerHTML =
        badgeHtml('@none', !startRolePick, "pickStartRole('')",
          {proj: true, title: 'Starts with nothing typed at it'})
        + startRoles().map(r =>
          badgeHtml(startRoleTag(r), r.at === startRolePick, `pickStartRole('${r.at}')`,
            {proj: true, title: roleStarter(r) ? `Opens with @${r.at}` : 'No opening prompt yet'}))
          .join('');
    }

    // The harness, in the same row of badges rather than in a select beside them: the sheet asks
    // three questions about what a session *is*, and one of them reading as a form control while
    // the other two read as badges was the whole inconsistency.
    let startAgentPick = '';
    // An agent config, when one was picked instead of the stock harness. Held apart from the kind
    // rather than folded into it: a config *is* a kind plus an environment, and the relay is told
    // both — `name` is what it starts, `config` is what it starts it under.
    let startConfigPick = '';
    let startCustomOpen = false;
    // null until the checkbox is touched, and then the user's own answer for the rest of this
    // dialog. Held apart from the default so that picking a different agent moves the box with the
    // pick right up until someone disagrees with it, and never after.
    let startUnattendedPick = null;

    // Which harnesses this relay can start with their own approval prompts off. Empty against a
    // relay too old to say, and then the row is not drawn at all rather than drawn and refused.
    function startUnattendedOffered(kind) {
      return ((startOptions || {}).unattended || []).indexOf(kind) >= 0;
    }

    // On under an agent config, off on a stock harness. A config is an endpoint the user set up for
    // work that runs without them; a stock start is the one they are sitting in front of.
    function startUnattendedOn() {
      if (!startUnattendedOffered(startAgentPick)) return false;
      return startUnattendedPick === null ? !!startConfigPick : startUnattendedPick;
    }

    function renderStartUnattended() {
      const row = document.getElementById('startUnattendedRow');
      const box = document.getElementById('startUnattended');
      if (!row || !box) return;
      row.style.display = startUnattendedOffered(startAgentPick) ? 'flex' : 'none';
      box.checked = startUnattendedOn();
    }

    function pickStartUnattended(on) {
      startUnattendedPick = !!on;
    }

    function startConfigs() {
      // Offered, not merely known: a config the user switched off is refused by the relay, so it
      // must not be on a strip that starts something.
      return typeof agentConfigOffered === 'function' ? agentConfigOffered() : [];
    }

    // Stock kinds, then one `+custom`. One badge and not a badge per alias: there will be more
    // aliases than harnesses before long, and a strip that grows with them is a strip nobody can
    // read. Open, the aliases appear after it wearing their own harness's colour.
    function renderStartAgents() {
      const configs = startConfigs();
      document.getElementById('startAgents').innerHTML =
        ((startOptions || {}).agents || []).map(k =>
          badgeHtml(k, !startConfigPick && k === startAgentPick, `pickStartAgent('${k}')`,
                    {agent: k})).join('')
        + (configs.length
          ? badgeHtml('+custom', startCustomOpen || !!startConfigPick, 'toggleStartCustom()',
              {proj: true, title: 'Start under one of your agent configs'})
            + (startCustomOpen || startConfigPick
              ? configs.map(c => badgeHtml(c.label, c.id === startConfigPick,
                  `pickStartConfig('${escapeHtml(c.id)}')`,
                  {agent: c.kind, title: c.command || c.provider_label || ''})).join('')
              : '')
          : '');
    }

    function toggleStartCustom() {
      startCustomOpen = !startCustomOpen;
      // Closing it also drops the choice: the row would otherwise say a stock kind is picked while
      // the start still carried a config nobody can see.
      if (!startCustomOpen) startConfigPick = '';
      renderStartAgents();
      renderStartUnattended();
      if (window.cue) cue('tick');
    }

    function pickStartConfig(id) {
      const row = startConfigs().find(c => c.id === id);
      if (!row) return;
      startConfigPick = id;
      startAgentPick = row.kind;
      renderStartAgents();
      renderStartUnattended();
      if (window.cue) cue('tick');
    }

    function pickStartAgent(kind) {
      startAgentPick = kind;
      startConfigPick = '';
      renderStartAgents();
      renderStartUnattended();
      if (window.cue) cue('tick');
    }

    // Tapping the one already on takes it off: the row is the only way back to no role, and a
    // choice that cannot be unmade is not optional.
    function pickStartRole(at) {
      startRolePick = startRolePick === at ? '' : at;
      renderStartRoles();
      if (window.cue) cue('tick');
    }

    function restoreStartChoice(id, key, fallback) {
      const el = document.getElementById(id);
      // Falls back when the remembered value is gone — an agent dropped from the relay's
      // allowlist leaves a stored name that matches no option, and silently ignoring it beats
      // opening the dialog on a blank select.
      const want = localStorage.getItem(key) || fallback;
      if (want && [...el.options].some(o => o.value === want)) el.value = want;
    }

    // A start can outlive its sheet (Duplicate has none), so its result also has one global card.
    // Success and warnings clear shortly; errors stay long enough to be read and retried.
    //
    // Busy has a ceiling of its own, and it is the one state that needs one. Every other state
    // ends by timing out; busy ends only when the pane it is waiting for turns up in a snapshot
    // and openPendingStart says how it went. A start whose pane never arrives — one refused
    // between the relay's answer and the poll, one on a host that stopped answering, a batch
    // abandoned mid-sequence — leaves nothing to clear it, and a spinner that runs for ever reads
    // as a start that failed silently when the session is in fact up and working.
    //
    // Long enough not to talk over a slow one: the relay waits AGENT_START_TIMEOUT_MS (30s) for
    // herdr alone, and each member of a launcher batch resets this on its own way out. Worded as
    // a report and not an error, because that is all this knows — the pane has not been seen.
    const SPAWN_BUSY_MS = 90000;
    let spawnStatusTimer = null;
    function showSpawnStatus(text, state) {
      const el = document.getElementById('spawnStatus');
      const spinner = document.getElementById('spawnSpinner');
      document.getElementById('spawnStatusText').textContent = text || '';
      el.style.display = text ? 'flex' : 'none';
      const color = state === 'error' ? 'var(--red)' : state === 'warning' ? 'var(--orange)'
        : state === 'success' ? 'var(--green)' : 'var(--blue)';
      el.style.borderColor = color;
      spinner.hidden = state !== 'busy';
      clearTimeout(spawnStatusTimer);
      if (state === 'busy') {
        spawnStatusTimer = setTimeout(
          () => showSpawnStatus(`${text} no pane has appeared yet — it may still be coming up.`,
                                'warning'), SPAWN_BUSY_MS);
        return;
      }
      spawnStatusTimer = setTimeout(() => { el.style.display = 'none'; },
        state === 'error' ? 10000 : 5000);
    }

    // One line under the fields carries both halves of what happens after Start is pressed:
    // that it is running, and how it ended. A start blocks for as long as the agent takes to
    // reach a prompt — up to 30s, and longer over SSH — and until this said so the dialog sat
    // with a greyed button and no sign it had heard the press.
    function setStartStatus(text, busy) {
      const el = document.getElementById('startError');
      el.textContent = text || '';
      el.style.display = text ? 'block' : 'none';
      el.style.color = busy ? 'var(--muted)' : 'var(--red)';
    }

    function setStartError(text) { setStartStatus(text, false); }

    // herdr refuses a pane that has not reached its shell prompt yet, and the relay already
    // retries that for 20s before giving up. What is left is a race the user can win by pressing
    // the button again — and nothing in the dialog to change first, so say that rather than
    // leaving them to guess which field was wrong.
    const START_RETRYABLE = /busy|not ready|not an available shell|timed? ?out|timeout|exited|malformed|no pane_id/i;

    function withRetryHint(text) {
      return START_RETRYABLE.test(text) && !/try again/i.test(text) ? text + ' — try again.' : text;
    }

    // The Project a press did not name, asked for in the sheet. Only when the dialog was opened
    // without one: the landing page's two + New buttons stand in no Project, so the question they
    // cannot answer is asked here instead of being guessed at.
    let startAskProject = false;

    function renderStartProjects() {
      const row = document.getElementById('startProjectRow');
      if (!row) return;
      row.hidden = !startAskProject;
      row.style.display = startAskProject ? '' : 'none';
      if (!startAskProject) return;
      row.innerHTML = '<div class="start-field">Project<div class="badge-strip">'
        + (projects.length
          ? projects.map(p => badgeHtml(p.label || p.id, p.id === startProjectId,
              `startPickProject('${escapeHtml(p.id)}')`,
              {proj: true, title: p.host && p.host !== 'local' ? 'on ' + p.host : ''})).join('')
          : '<span class="field-note">This relay has no Projects configured.</span>')
        + '</div></div>';
    }

    // Picking one redraws the rest: placement is answered against what that Project has running,
    // and the answer the previous Project gave means nothing here. submitStart already refuses
    // without a Project, so the sheet is simply unusable until this is tapped.
    function startPickProject(id) {
      startProjectId = id;
      syncStartProjectBadge();
      renderStartProjects();
      renderStartTarget();
      if (document.getElementById('startSubmit').disabled) {
        document.getElementById('startPlacement').value = 'new_workspace';
        renderStartTarget();
      }
    }

    function syncStartProjectBadge() {
      const p = projects.find(x => x.id === startProjectId);
      const badge = document.getElementById('startProject');
      badge.textContent = p ? `@${p.label}` : '';
      badge.hidden = !p;   // an empty badge is a stray outline, not a Project
    }

    function openStartDialog(projectId, ev, mode) {
      if (ev) ev.stopPropagation();
      if (!startOptions) return;
      // Every route into the dialog clears it; startAndPair sets it back after opening. An
      // abandoned pair-and-start must not attach itself to whatever is started next.
      startIntent = null;
      startMode = mode === 'terminal' ? 'terminal' : 'agent';
      const terminal = startMode === 'terminal';
      if (terminal && !startOptions.terminal) return;
      startProjectId = projectId;
      // A Project the relay does not have is the same question as none at all — ask, rather than
      // open the sheet pointed at something that is not there.
      startAskProject = !projectId || !projects.some(x => x.id === projectId);
      syncStartProjectBadge();
      renderStartProjects();
      document.getElementById('startTitle').textContent = terminal ? 'New terminal' : 'Start session';
      document.getElementById('startAgentRows').style.display = terminal ? 'none' : '';
      document.getElementById('startSubmit').textContent = terminal ? 'Open terminal' : 'Start session';
      document.getElementById('startName').placeholder = terminal ? 'Auto — Terminal N' : 'Auto — Role N';
      // Reopens on the role it last started as, which is usually the one being started again —
      // and on none when that badge is gone, rather than silently on a different way of working.
      //
      // Never having chosen is a different answer from having chosen and taken it off again, and
      // getItem is the one place the two are still told apart: null for the first, '' for the
      // second. A session is better started as something, so the first opens on the first badge
      // offered — Architect, the way conv_dock's own picker already opens — and the second stays
      // empty, because tapping a lit badge off is how a start with no opening prompt is asked for.
      const seenRole = localStorage.getItem(START_ROLE_KEY);
      startRolePick = seenRole === null ? ((startRoles()[0] || {}).at || '')
        : startRoles().some(r => r.at === seenRole) ? seenRole : '';
      renderStartRoles();
      // The harness is not optional, so unlike the role it falls back to the first offered rather
      // than to none — a remembered kind the relay has since dropped picks nothing otherwise.
      const kinds = startOptions.agents || [];
      const remembered = localStorage.getItem(START_AGENT_KEY);
      startAgentPick = kinds.includes(remembered) ? remembered : (kinds[0] || '');
      startConfigPick = '';
      startCustomOpen = false;
      // A fresh dialog asks the question fresh: an answer given to the last start says nothing
      // about this one, which may be a different harness entirely.
      startUnattendedPick = null;
      renderStartAgents();
      renderStartUnattended();
      fillSelect('startPlacement', [['new_tab', 'New tab'], ['new_workspace', 'New workspace'], ['split', 'Split']]);
      restoreStartChoice('startPlacement', START_PLACE_KEY, 'new_tab');
      document.getElementById('startName').value = '';  // blank means "let the relay name it"
      setStartError('');
      document.getElementById('startSubmit').disabled = false;
      renderStartTarget();  // may disable submit again when the Project has no live target
      // New tab and Split both need something of this Project's already running. Falling back
      // keeps the dialog usable instead of opening it disabled on a choice that cannot apply
      // here — the first session in a Project has nowhere to go but a new workspace.
      if (document.getElementById('startSubmit').disabled) {
        document.getElementById('startPlacement').value = 'new_workspace';
        renderStartTarget();
      }
      // Nothing to start until a Project is picked. submitStart refuses without one anyway, and a
      // live button that silently does nothing is worse than one that says it is not ready yet.
      if (!startProjectId) document.getElementById('startSubmit').disabled = true;
      document.getElementById('startSheet').style.display = 'block';
    }

    function closeStart() {
      document.getElementById('startSheet').style.display = 'none';
      startProjectId = null;
      // Cleared here, not only on open: the field is read back when the relay reports the name it
      // actually used, and a start made without the dialog — a Duplicate — would otherwise be
      // compared against whatever the last dialog was left holding.
      document.getElementById('startName').value = '';
    }

    // New tab lists this Project's live workspaces; Split lists its live panes. Neither is
    // offered for a Project with no live sessions — New workspace always is.
    function renderStartTarget() {
      const placement = document.getElementById('startPlacement').value;
      const row = document.getElementById('startTargetRow');
      // A terminal may land beside a terminal, and in a workspace holding nothing else. An agent
      // may not: `agent start` wants a pane of its own, and the relay validates against agents.
      const live = startMode === 'terminal' ? agents.concat(shells) : agents;
      const mine = live.filter(a => a.project_id === startProjectId);
      if (placement === 'new_workspace') {
        // Clears both, and not only the row. New workspace needs no target, so whatever the
        // previous placement left behind — the "no live workspaces" error, and the disabled
        // submit that came with it — belongs to a question this placement does not ask. Leaving
        // them was what made the dialog impossible to submit from: pick New workspace after
        // seeing that error and the button stayed dead.
        row.innerHTML = '';
        setStartError('');
        document.getElementById('startSubmit').disabled = false;
        return;
      }
      const isTab = placement === 'new_tab';
      const label = isTab ? 'Workspace' : 'Beside pane';
      row.innerHTML = `<label class="start-field">${label}<select id="startTarget"></select></label>`;
      let options;
      if (isTab) {
        const seen = new Set();
        options = mine.filter(a => a.workspace_id && !seen.has(a.workspace_id) && seen.add(a.workspace_id))
          .map(a => [a.workspace_id, a.project || a.workspace_id]);
      } else {
        // Not `a.agent` as the fallback — a terminal has none, and the option read "undefined".
        options = mine.map(a => [a.pane_id, `${a.label || a.agent || a.project || a.pane_id} · ${a.pane_id}`]);
      }
      const any = fillSelect('startTarget', options);
      setStartError(any ? '' : (isTab ? 'No live workspaces in this project' : 'No live panes in this project'));
      document.getElementById('startSubmit').disabled = !any;
    }

    function submitStart() {
      if (!ws || !startProjectId) return;
      const terminal = startMode === 'terminal';
      const placement = document.getElementById('startPlacement').value;
      const role = startRoleOf(startRolePick);
      const typed = document.getElementById('startName').value.trim();
      // Agent fields are omitted rather than blanked: the relay refuses an open_terminal carrying
      // a name or a role as an unexpected field, which is what keeps the two messages distinct.
      const msg = terminal
        ? { type: 'open_terminal', project_id: startProjectId, placement: placement }
        : Object.assign({
          type: 'start_agent',
          name: startAgentPick,
          project_id: startProjectId,
          placement: placement,
        }, startRoleFields(role, typed));
      // A relay that offers no harness has nothing to start; the row is empty and the press would
      // reach the relay only to be refused for a missing name.
      if (!terminal && !msg.name) { setStartError('This relay starts no agents'); return; }
      // Spawn at the width of the screen doing the spawning, so a session started from a phone is
      // readable on it without a second round trip. Not for a split: "beside that pane" is already
      // a statement about width, and a desktop asking for "wide" would move the new session
      // straight back out of the split the user picked.
      if (!terminal && startConfigPick) msg.config = startConfigPick;
      // Only when it is on. The relay's default is a session that asks before it acts, and saying
      // so on the wire would be a longer way of saying nothing.
      if (!terminal && startUnattendedOn()) msg.unattended = true;
      if (placement !== 'split') msg.slot = slotFor();
      // A terminal takes the typed name too, and has no role to have been named after: startRoleFields
      // answered that for an agent, this answers it for the other message. Omitted, not empty — the
      // relay derives "Terminal N" from an absent label and refuses a blank one.
      if (terminal && typed) msg.label = typed;
      if (placement !== 'new_workspace') {
        const target = document.getElementById('startTarget');
        if (!target || !target.value) { setStartError('Select a target first'); return; }
        msg[placement === 'new_tab' ? 'workspace_id' : 'split_from'] = target.value;
      }
      setStartStatus(terminal ? 'Opening terminal…' : 'Starting session… this can take up to 30s.', true);
      showSpawnStatus(terminal ? 'Opening terminal…' : 'Starting session…', 'busy');
      document.getElementById('startSubmit').disabled = true;
      // Remembered on send rather than on change: what the user actually spawned is the choice
      // worth reopening on, not one they scrolled past.
      try {
        if (msg.name) localStorage.setItem(START_AGENT_KEY, msg.name);
        localStorage.setItem(START_PLACE_KEY, placement);
        if (!terminal) localStorage.setItem(START_ROLE_KEY, startRolePick);
      } catch (e) { /* private mode: session-only */ }
      // Said to it as soon as it comes up, so the session starts as the thing it was started as
      // rather than waiting to be told. Set here and not above the target check: a submit that
      // refused must leave nothing behind for the next start to open with. Nothing to say for a
      // terminal, or for a role whose prompt is still to be written.
      startPrompt = terminal ? '' : roleStarter(role, startAgentPick);
      startStarter = terminal ? '' : ((role || {}).at || NO_STARTER);
      ws.send(JSON.stringify(msg));
    }

    // --- Recents ---
    // Most-recently-opened panes, for one-tap access without hunting the list. Browser-local, like
    // pairs: the relay has no notion of which panes this device visited.

    const RECENTS_KEY = 'herdr_recents';
    const MAX_RECENTS = 5;
    // What is stored, against what the landing section draws. The section shows five panes; the
    // switcher in the status bar orders everything that is running, and a five-entry log would have
    // it forgetting the pane before last. Storing more costs nothing and the section still slices.
    const RECENT_LOG = 24;

    function loadRecents() {
      try {
        const v = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
        // Version-one recents stored bare pane IDs. Drop them: herdr can reuse an ID for a
        // different session, and this is a convenience list, not data worth migrating unsafely.
        // Conversations are in the same log, because "where was I" has one answer and it is in the
        // order things were visited, not one order per kind of thing.
        return Array.isArray(v) ? v.filter(x => x && typeof x === 'object'
          && (x.conv || (x.pane_id && (x.agent || x.terminal)))) : [];
      } catch (e) { return []; }
    }

    // A terminal has no `agent` to fingerprint on, so it is matched on cwd and host instead and
    // flagged. The flag is what stops a bare pane_id matching across kinds — herdr reuses IDs, and
    // a recent terminal landing on the agent that inherited its ID is exactly the failure the
    // fingerprint exists to prevent. Agents keep memberMatches, which the pair tests own.
    function recentMatchesPane(r, p, shell) {
      if (!!r.terminal !== shell) return false;
      if (!shell) return memberMatches(r, p);
      return r.pane_id === p.pane_id && (r.host || 'local') === (p.host || 'local')
        && (r.cwd || '') === (p.cwd || '');
    }

    function noteRecent(paneId) {
      const shell = isShell(paneId);
      const pool = shell ? shells : agents;
      const live = pool.filter(p => p.pane_id === paneId);
      if (live.length !== 1) return;
      const current = shell
        ? { pane_id: paneId, host: live[0].host || 'local', cwd: live[0].cwd || '', terminal: true }
        : recentFingerprint(live[0]);
      const next = [current, ...loadRecents().filter(r => r.pane_id !== paneId)].slice(0, RECENT_LOG);
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    }

    // A conversation window opened is a visit, in the same log and the same order. Stored by id
    // alone: a conversation is this browser's own record, so there is no session to fingerprint
    // against and nothing another machine could reuse the id for.
    function noteConvVisit(id) {
      if (!id) return;
      const next = [{conv: id}, ...loadRecents().filter(r => r.conv !== id)].slice(0, RECENT_LOG);
      try { localStorage.setItem(RECENTS_KEY, JSON.stringify(next)); }
      catch (e) { /* private mode: this session only */ }
    }

    // --- The recent switcher ---
    //
    // Every live pane, agents and terminals together, in the order this device last opened them.
    // Reached from the status bar, which is the one row on screen in every view: "put me back where
    // I was" is not a question about the screen you are asking it from, and the landing page's
    // Recents section can only answer it from the landing page.

    // Panes herdr is ambiguous about are dropped, the same rule the landing section follows: an ID
    // that is an agent in one list and a shell in the other is one the relay will refuse.
    function livePanes() {
      return agents.concat(shells).filter(p => agents.filter(x => x.pane_id === p.pane_id).length
        + shells.filter(x => x.pane_id === p.pane_id).length === 1);
    }

    // Panes and conversations in one order, which is what makes this a switcher rather than two
    // lists that happen to share a sheet: a reader who was last in a conversation window and before
    // that in a pane wants those two in that order, not the panes first because they are panes.
    //
    // Conversations appear only once visited. A pane is offered whether or not this device has
    // opened it — it is running, and something running that cannot be reached from here would be a
    // hole — but every conversation is already one tap away on the landing page, and listing all of
    // them would make the switcher a second copy of it.
    function recentItems() {
      const log = loadRecents();
      const paneRank = p => {
        const i = log.findIndex(r => recentMatchesPane(r, p, isShell(p.pane_id)));
        return i < 0 ? log.length : i;
      };
      const convs = loadConvIndex();
      const items = livePanes().map((p, i) => ({pane: p, rank: paneRank(p), seen: lastSeen[p.pane_id] || 0, i}));
      log.forEach((r, at) => {
        const conv = r.conv && convs.find(c => c.id === r.conv);
        // A conversation deleted since it was visited is simply gone; the log is a convenience
        // list, not a record, and it is rewritten by the next visit anyway.
        if (conv) items.push({conv: conv, rank: at, seen: 0, i: items.length});
      });
      // Visited first in visit order; everything else after it by when it last moved, so the list
      // stays a recent list rather than a second copy of the agent list.
      return items.sort((a, b) => a.rank - b.rank || b.seen - a.seen || a.i - b.i);
    }

    function recentPaneRow(p) {
      const shell = isShell(p.pane_id);
      const seen = lastSeen[p.pane_id];
      const meta = [p.project, shell ? (p.cwd || 'shell') : p.status,
        seen ? fmtAgo(new Date(seen)) : ''].filter(Boolean).join(' · ');
      return `<button class="pair-pick${p.pane_id === activePane ? ' on' : ''}" ` +
        `onclick="closeRecentSheet(); jumpToPane('${escapeHtml(p.pane_id)}')">` +
        `<span class="kind" aria-hidden="true">${shell ? '⬛' : agentGlyph()}</span>` +
        `<span class="info"><span class="name">${escapeHtml(paneLabel(p))}` +
        `${shell ? '' : paneBadge(p)}</span>` +
        `<span class="meta">${escapeHtml(meta)}</span></span>` +
        `<span class="dot" style="background:${statusColor(p)}" aria-hidden="true"></span>` +
        `</button>`;
    }

    // The same row, saying what a conversation is instead of what a pane is doing: the mark the
    // conversation sheet uses, the name, and how many panes wrote it. No status dot — a record has
    // no status, and the members that do have their own rows here.
    function recentConvRow(c) {
      const n = (c.members || []).length;
      const live = (c.members || []).filter(m => agents.some(a => convMemberKey(a) === m.key)).length;
      const meta = `${n} pane${n === 1 ? '' : 's'}` + (live ? ` · ${live} live` : '');
      return `<button class="pair-pick${c.id === convViewId ? ' on' : ''}" ` +
        `onclick="closeRecentSheet(); openConversation('${escapeHtml(c.id)}')">` +
        `<span class="kind conv-kind">${convGlyph()}</span>` +
        `<span class="info"><span class="name">${escapeHtml(c.name)}</span>` +
        `<span class="meta">${escapeHtml(meta)}</span></span>` +
        `</button>`;
    }

    // What a row can be found by. The same shape pickHay builds, so the same words reach the same
    // pane in both sheets — a switcher that answered "cdx" differently from the picker would be a
    // second search to learn.
    function recentHay(x) {
      const p = x.pane;
      return (p
        ? [paneLabel(p), p.agent, p.project, p.cwd, isShell(p.pane_id) ? 'terminal' : p.status]
        : [x.conv.name, 'conversation'])
        .map(f => String(f || '').toLowerCase()).filter(Boolean);
    }

    function openRecentSheet() {
      document.getElementById('recentSearch').value = '';
      renderRecentSheet();
      document.getElementById('recentSheet').style.display = 'block';
    }

    // Redrawn on every keystroke rather than filtered in place: the list is short, and rebuilding
    // it is what keeps the active-pane mark and the status dots right when a poll lands mid-search.
    function renderRecentSheet() {
      const box = document.getElementById('recentList');
      const q = document.getElementById('recentSearch').value.trim().toLowerCase();
      const all = recentItems();
      const list = q ? all.filter(x => pickMatch(recentHay(x), q)) : all;
      // Same row as the pair and conversation sheets: a list of things to pick reads as one when
      // every list in the app is picked from the same way.
      box.innerHTML = list.length
        ? list.map(x => x.conv ? recentConvRow(x.conv) : recentPaneRow(x.pane)).join('')
        : `<p class="pair-empty">${all.length
            ? `Nothing here matches &quot;${escapeHtml(q)}&quot;.` : 'Nothing is running.'}</p>`;
      // The box appears once there is enough to search, the picker's rule: below that it can only
      // filter a list already entirely on screen. Kept up while something is typed, so clearing it
      // is always possible.
      document.getElementById('recentSearch').parentElement.hidden = all.length < 5 && !q;
    }

    function closeRecentSheet() {
      document.getElementById('recentSheet').style.display = 'none';
    }

    // Only live panes are offered. A dead pane_id is dropped rather than shown greyed: herdr reuses
    // pane IDs, so a stale entry could open a pane the user never visited.
    function renderRecents() {
      const el = document.getElementById('recents');
      // Sliced here too, not only on write: a list stored under an older, larger cap must not
      // render six entries just because it predates the current one.
      const live = loadRecents()
        .map(r => {
          const pool = r.terminal ? shells : agents;
          return pool.find(p => recentMatchesPane(r, p, !!r.terminal)) || null;
        })
        // Still one, and still counted across both lists: an ID that is now an agent here and a
        // shell there is ambiguous, and the relay will refuse it.
        .filter(p => p && agents.filter(x => x.pane_id === p.pane_id).length
          + shells.filter(x => x.pane_id === p.pane_id).length === 1)
        .slice(0, MAX_RECENTS);
      // Same section header and same cards as the list above, so a recent reads as the session it
      // is rather than as a second kind of thing. Whether the node is on screen is applySections'
      // to decide — this only says whether there is anything to show.
      el.innerHTML = live.length
        ? `<div class="section-header">Recents</div>`
          + live.map(p => isShell(p.pane_id) ? terminalCard(p) : agentCard(p)).join('')
        : '';
      applySections();
    }
