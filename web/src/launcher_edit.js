    // --- Launcher tiles, edited ---
    // One dialog, two views: the list, where tiles are reordered and deleted, and the form for
    // one tile. Every write goes through launcher_store, and every refusal comes from
    // launcherValid — nothing here decides for itself whether a tile is legal, because a second
    // opinion about that is how an editor comes to save what the presser cannot run.

    // The tile being edited, as an object rather than as a set of field values. Held here so a
    // repaint can rebuild the fields from it: a badge tap changes which fields there *are*, and
    // reading them back off the DOM afterwards would read the ones that just went away.
    let launcherDraft = null;

    // What the form was opened on, so Delete knows whether there is anything to delete and the
    // list can be returned to. '' for a tile being added.
    let launcherEditing = '';
    let launcherMembersCustom = false, launcherArbCustom = false;

    function launcherKinds() { return (startOptions && startOptions.agents) || []; }

    function launcherConfigs() {
      return typeof agentConfigOffered === 'function' ? agentConfigOffered() : [];
    }

    // Everything typed since the last repaint, back into the draft. Called before every redraw
    // and before saving, which is what lets the form rebuild itself around a badge tap without
    // taking a half-written command out from under the person writing it.
    function launcherReadForm() {
      const d = launcherDraft;
      if (!d) return null;
      const val = id => {
        const el = document.getElementById(id);
        return el ? el.value : undefined;
      };
      const name = val('qlName');
      if (name !== undefined) d.label = name;
      const command = val('qlCommand');
      if (command !== undefined) d.command = command;
      const scope = val('qlScope');
      if (scope !== undefined) d.scope = scope;
      const insecure = document.getElementById('qlInsecure');
      if (insecure) d.insecure = !!insecure.checked;
      // The arbitration settings, and only ever what is on screen: `val` answers undefined for a
      // field this draw did not make, which is what leaves a tile's clocks alone while its
      // arbitrator is switched off and on again.
      ['idle', 'runtime', 'steps', 'runs', 'minutes'].forEach(k => {
        const got = val('ql' + k[0].toUpperCase() + k.slice(1));
        if (got !== undefined) d[k] = got === '' ? '' : Number(got);
      });
      const warm = document.getElementById('qlWarmup');
      if (warm) d.warmup = !!warm.checked;
      (d.members || []).forEach((m, i) => {
        const role = val('qlRole' + i);
        if (role !== undefined) m.role = role.trim();
        const label = val('qlMemberName' + i);
        if (label !== undefined) m.label = label.trim();
        const at = val('qlAt' + i);
        if (at !== undefined) m.at = at;
        const solo = document.getElementById('qlSolo' + i);
        if (solo) m.unattended = !!solo.checked;
      });
      return d;
    }

    // --- the list ---

    function launcherRowHtml(tile, i, last) {
      const gate = launcherGate(tile, launcherEnv());
      return `<div class="ql-row">`
        + `<button class="ql-row-main" onclick="launcherEditTile('${escapeHtml(tile.id)}')"`
        + ` title="Edit this tile">`
        + `<span class="ql-row-name">${escapeHtml(tile.label)}</span>`
        + `<span class="ql-row-payload">${escapeHtml(launcherPreview(tile))}</span>`
        // The same badge the tile wears on the page. A list that showed a broken tile as fine
        // would be the one place the problem is fixable and the last place it is mentioned.
        + (gate.badge ? `<span class="launcher-badge">${escapeHtml(gate.badge)}</span>` : '')
        + `</button>`
        + `<button class="ql-move" onclick="launcherMove('${escapeHtml(tile.id)}', -1)"`
        + ` aria-label="Move ${escapeHtml(tile.label)} up"${i === 0 ? ' disabled' : ''}>↑</button>`
        + `<button class="ql-move" onclick="launcherMove('${escapeHtml(tile.id)}', 1)"`
        + ` aria-label="Move ${escapeHtml(tile.label)} down"${last ? ' disabled' : ''}>↓</button>`
        + `<button class="ql-del" onclick="launcherDelete('${escapeHtml(tile.id)}')"`
        + ` aria-label="Delete ${escapeHtml(tile.label)}">✕</button>`
        + `</div>`;
    }

    function launcherListHtml() {
      const tiles = loadLauncher();
      return (tiles.length
        ? tiles.map((t, i) => launcherRowHtml(t, i, i === tiles.length - 1)).join('')
        : '<p class="pair-empty">No tiles yet. A tile is the answers the Start dialog or a shell '
          + 'prompt would have asked for, kept so they can be pressed instead.</p>')
        + `<button id="qlAdd" class="ql-primary" onclick="launcherNewTile()">+ New tile</button>`;
    }

    function launcherDrawList() {
      launcherDraft = null;
      launcherEditing = '';
      const title = document.getElementById('launcherEditTitle');
      if (title) title.textContent = 'Launcher';
      const el = document.getElementById('launcherEditBody');
      if (el) el.innerHTML = launcherListHtml();
    }

    // --- pressing a tile -----------------------------------------------------------------
    //
    // Everything a press has to answer, in one dialog: what it is about to do, which tree it runs
    // in, and what to call what it makes. It was three round trips through two kinds of dialog —
    // the Project a sheet, the name a native `prompt`, and the confirm folded inside that prompt
    // where it could not be laid out at all. One sheet, because they are one question.
    //
    // Held here rather than read off the fields: picking a Project redraws the sheet, and a name
    // half typed must survive that.
    let launcherLaunch = null;

    // Returns false, always — nothing has been started when this opens. launcherLaunchFire is
    // where that happens, and closing the sheet starts nothing.
    function launcherLaunchSheet(tile) {
      launcherLaunch = {id: tile.id, project_id: tile.project_id || '', name: ''};
      launcherDrawLaunch();
      return false;
    }

    // The tile as this press would run it: the stored one, plus the Project chosen here. The
    // choice is never written back — a template that quietly became a button after one press is
    // the feature undoing itself.
    function launcherLaunchTile() {
      const tile = launcherLaunch && loadLauncher().find(t => t.id === launcherLaunch.id);
      return tile ? Object.assign({}, tile, {project_id: launcherLaunch.project_id}) : null;
    }

    function launcherLaunchRead() {
      const el = document.getElementById('qlLaunchName');
      if (el && launcherLaunch) launcherLaunch.name = el.value;
    }

    function launcherLaunchProject(id) {
      launcherLaunchRead();
      if (!launcherLaunch) return;
      launcherLaunch.project_id = id;
      launcherDrawLaunch();
    }

    // What this press will actually spawn, drawn rather than described. launcherConfirmLines says
    // it in a sentence, which is the right form for a confirm and the wrong one for a roster: the
    // reader is checking a list against what they meant to press, and a list is read as a list.
    //
    // Drawn whether or not a Project has been picked, unlike the confirm above it. The roster is a
    // fact about the tile; the confirm is a fact about the press, and there is no press to describe
    // until there is somewhere to press it.
    function launcherRosterHtml(tile) {
      const roster = launcherIsTerm(tile) ? [] : launcherRoster(tile);
      if (!roster.length) return '';
      return '<div class="ql-roster">' + roster.map(m => {
        // The @name and not the label: this is the same prompt the composer offers, and a strip
        // that renamed it would be the one place in the app it is not addressed by name.
        const starter = (SHORTCUTS.find(s => s.at === canonAt(m.at)) || {}).at || '';
        return `<span class="ql-part${m.arb ? ' arb' : ''}">`
          // Scales for the arbitrator, the robot for a member. It is not a third participant, it is
          // the one deciding between the other two, and a strip drawing all three alike would tell
          // the same lie launcherPreview already refuses to.
          + (m.arb ? '<span class="ql-part-mark" aria-hidden="true">⚖</span>'
                   : `<span class="ql-part-mark">${launcherIcon('spawn')}</span>`)
          + `<span class="ql-part-name">${escapeHtml(m.label || m.name)}</span>`
          + configBadge(m.name, m.config)
          + (starter ? `<span class="ql-part-role">@${escapeHtml(starter)}</span>` : '')
          + launcherUnattendedHtml(m, '', true)
          + '</span>';
      }).join('') + '</div>';
    }

    function launcherDrawLaunch() {
      const tile = launcherLaunchTile();
      if (!tile) { closeLauncherEdit(); return; }
      const title = document.getElementById('launcherEditTitle');
      // Named for what this sheet does. The same node is the tile *editor's* header, where a bare
      // tile label reads identically — and one of the two starts sessions on a real host.
      if (title) title.textContent = `Launch: ${tile.label}`;
      const el = document.getElementById('launcherEditBody');
      if (el) {
        el.innerHTML =
          // What pressing this does, quoted rather than described — the tile's own label may have
          // been written by another browser, and this is the evidence for it. Only once there is a
          // Project: every line of it names one.
          (tile.project_id
            ? `<p class="ql-launch-say">${launcherConfirmLines(tile, launcherEnv())
                .map(escapeHtml).join('<br>')}</p>`
            : '<p class="ql-none">This tile is a template — pick the Project to start it in.</p>')
          + launcherRosterHtml(tile)
          + '<div class="start-field">Project<div class="badge-strip">'
          + (projects.length
            ? projects.map(p => badgeHtml(p.label || p.id, p.id === tile.project_id,
                `launcherLaunchProject('${escapeHtml(p.id)}')`,
                {proj: true, title: p.host && p.host !== 'local' ? 'on ' + p.host : ''})).join('')
            : '<span class="ql-none">This relay has no Projects configured.</span>')
          + '</div></div>'
          + `<label class="start-field">Name<input id="qlLaunchName" type="text"`
          + ` maxlength="${LAUNCHER_LABEL_MAX}" autocapitalize="none" autocomplete="off"`
          + ` placeholder="${escapeHtml(launcherNoun(tile))} — blank is fine"`
          + ` value="${escapeHtml(launcherLaunch.name)}" /></label>`
          + `<p class="ql-none">Every pane this starts wears the name and one shared tag, so a `
          + 'second press of the same tile is never mistaken for this one.</p>'
          + '<div class="ql-actions">'
          + '<button class="ql-secondary" onclick="closeLauncherEdit()">Cancel</button>'
          // arm-btn is what draws the armed state — the orange fill draining over the arm window,
          // the same one QUIT and the arbitration dialog's two finals wear. Without the class the
          // button arms and says so in its label with nothing on screen agreeing.
          + '<button type="button" class="ql-primary arm-btn"'
          + ' onclick="launcherLaunchFire(this)">Start</button></div>';
      }
      const box = document.getElementById('launcherModal');
      if (box) box.style.display = 'block';
    }

    function launcherLaunchFire(btn) {
      launcherLaunchRead();
      const at = launcherLaunch;
      if (!at) return;
      // The one answer that cannot be defaulted: a session started in the wrong tree is worse than
      // one not started.
      if (!at.project_id) { showToast('Pick a Project'); return; }
      // Two taps. A tile starts up to three sessions in someone else's checkout and types a first
      // prompt into each, which is not something to do on a thumb brushing a list. armButton and
      // not armFire: this button is drawn by a render and has no id worth having, and armFire is
      // keyed by one against a table of labels.
      armButton(btn, 'Start?', () => {
        const to = at.project_id, name = at.name;
        closeLauncherEdit();
        launcherPressIn(at.id, to, name);
      });
    }

    // The + in the section header. Straight to the form, because that button says Add and a list
    // is not what adding looks like — Edit beside it is how the list is reached.
    function openLauncherNew() {
      openLauncherEdit();
      launcherNewTile();
    }

    function openLauncherEdit() {
      launcherDrawList();
      const box = document.getElementById('launcherModal');
      if (box) box.style.display = 'block';
    }

    function closeLauncherEdit() {
      launcherDraft = null;
      launcherEditing = '';
      launcherLaunch = null;
      const box = document.getElementById('launcherModal');
      if (box) box.style.display = 'none';
    }

    function launcherMove(id, by) {
      moveLauncherTile(id, by);
      renderLauncher();
      launcherDrawList();
    }

    function launcherDelete(id) {
      const tile = loadLauncher().find(t => t.id === id);
      if (!tile) return;
      // Asked, because it is the one action here that cannot be undone by pressing the other
      // arrow — and the tile may have been written on another browser, where it still is until
      // this delete syncs.
      if (!confirm(`Delete "${tile.label}"?`)) return;
      removeLauncherTile(id);
      renderLauncher();
      launcherDrawList();
    }

    // --- the form ---

    function launcherNewTile() {
      const kinds = launcherKinds();
      launcherEditing = '';
      launcherDraft = {
        id: launcherId(), label: '', action: 'spawn',
        // None, deliberately. A tile is more useful as a template than as a button — the same
        // roster pressed into whichever tree wants it — and a form that opened on one Project
        // would make the narrower tile the one people make by accident.
        project_id: '',
        command: '', members: [], scope: '',
      };
      // A relay that starts nothing still has terminals, and one with terminals off still starts
      // agents. Opening on the one that cannot work is a form whose first act is to refuse.
      if (!kinds.length && (startOptions || {}).terminal) launcherDraft.action = 'term';
      launcherMembersCustom = false;
      launcherArbCustom = false;
      launcherDrawForm();
    }

    function launcherEditTile(id) {
      const tile = loadLauncher().find(t => t.id === id);
      if (!tile) return;
      launcherEditing = id;
      // A copy, so abandoning the form leaves the stored tile exactly as it was. The members are
      // copied one deep too — the role inputs write into them.
      launcherDraft = Object.assign({}, tile, {
        members: (tile.members || []).map(m => Object.assign({}, m)),
        arbitrator: tile.arbitrator ? Object.assign({}, tile.arbitrator) : null,
      });
      launcherMembersCustom = launcherDraft.members.some(m => m.config);
      launcherArbCustom = !!((launcherDraft.arbitrator || {}).config);
      launcherDrawForm();
    }

    // The pencil in a tile's corner. The sheet has to be up before the form can be drawn into it,
    // which is the same two steps launcherRepoint takes and the reason neither calls the other.
    function launcherEditFromTile(id) {
      openLauncherEdit();
      launcherEditTile(id);
    }

    // A stale tile, opened on the one field that is wrong. Not a wizard: the Project strip is
    // already in the form, and what a repoint *is* is picking a different one and saving.
    function launcherRepoint(id) {
      openLauncherEdit();
      launcherEditTile(id);
      showToast('That Project is gone — pick another and save.');
    }

    function launcherPickAction(action) {
      launcherReadForm();
      launcherDraft.action = action;
      launcherDrawForm();
    }

    function launcherPickProject(id) {
      launcherReadForm();
      launcherDraft.project_id = id;
      launcherDrawForm();
    }

    function launcherAddMember(name, config) {
      launcherReadForm();
      const d = launcherDraft;
      if ((d.members || []).length >= LAUNCHER_MEMBERS_MAX) {
        showToast(`At most ${LAUNCHER_MEMBERS_MAX} agents`);
        return;
      }
      if (config) launcherMembersCustom = true;
      d.members = (d.members || []).concat(
        [{name: name, config: config || '', role: '', label: '', at: LAUNCHER_DEFAULT_AT,
          unattended: launcherUnattended({name: name, config: config || ''})}]);
      launcherDrawForm();
    }

    function launcherDropMember(i) {
      launcherReadForm();
      launcherDraft.members = (launcherDraft.members || []).filter((m, at) => at !== i);
      launcherDrawForm();
    }

    // '' switches it off. Off and not absent, because launcherWantsArb reads the field's presence
    // and a tile that lost its arbitrator by being widened to three keeps it — see step 6.
    function launcherPickArb(name, config) {
      launcherReadForm();
      if (config) launcherArbCustom = true;
      launcherDraft.arbitrator = name ? {name: name, config: config || ''} : null;
      if (name) launcherArbSeed();
      launcherDrawForm();
    }

    function launcherToggleCustom(where) {
      launcherReadForm();
      if (where === 'members') launcherMembersCustom = !launcherMembersCustom;
      else launcherArbCustom = !launcherArbCustom;
      launcherDrawForm();
    }

    // Appointing an arbitrator is where the pair stops being two agents and becomes an implementer
    // and a reviewer, so it is where that is filled in: the roster is put in slot order and each
    // member is given the roles its slot is usually for. Only ever into an empty field — a role
    // somebody typed is the answer to this question and must not be overwritten by the suggestion.
    function launcherArbSeed() {
      const d = launcherDraft;
      if (!d) return;
      d.members = launcherArbOrder(d.members || []);
      // The phrases live with the pills that light up for them, so the tags are resolved through
      // that list rather than repeated here — two copies of "fixes what review finds" is a badge
      // that silently stops matching the field it wrote.
      if (typeof ARB_ROLE_TAGS === 'undefined') return;
      d.members.forEach((m, i) => {
        const slot = LAUNCHER_ARB_SLOTS[i];
        if (!slot || m.role) return;
        m.role = slot.tags.map(t => (ARB_ROLE_TAGS.find(x => x.tag === t) || {}).text)
          .filter(Boolean).join(', ');
      });
    }

    function launcherFormHtml() {
      const d = launcherDraft;
      const kinds = launcherKinds();
      const configs = launcherConfigs();
      const terminal = !!(startOptions || {}).terminal;
      const members = d.members || [];
      // Two or more. The arbitrator itself still takes exactly two — that is the relay's
      // MEMBERS_REQUIRED and it does not move — but which two is a question, not an assumption,
      // the moment there are three in the room. Asked the same way the setup dialog asks it: two
      // selects over the roster, defaulted to the pair launcherArbOrder picked.
      const canArb = d.action === 'spawn' && members.length >= 2;
      const arbName = (d.arbitrator || {}).name || '';
      const arbConfig = (d.arbitrator || {}).config || '';
      return '<label class="start-field">Name<input id="qlName" type="text"'
        + ` maxlength="${LAUNCHER_LABEL_MAX}" autocapitalize="none" autocomplete="off"`
        + ` placeholder="what pressing this does" value="${escapeHtml(d.label || '')}" /></label>`
        + '<div class="start-field">What it does<div class="badge-strip">'
        + badgeHtml('Start agents', d.action === 'spawn', "launcherPickAction('spawn')",
                    {title: kinds.length ? 'Starts one or more sessions'
                                         : 'This relay starts nothing'})
        + badgeHtml('Start terminal', d.action === 'term', "launcherPickAction('term')",
                    {title: terminal ? 'Opens a terminal in the Project, and types nothing'
                                     : 'This relay has terminal mode switched off'})
        + badgeHtml('Run a command', d.action === 'run', "launcherPickAction('run')",
                    {title: terminal ? 'Opens a terminal and types this at it'
                                     : 'This relay has terminal mode switched off'})
        + '</div></div>'
        + '<div class="start-field">Project<div class="badge-strip">'
        + badgeHtml('Ask each time', !d.project_id, "launcherPickProject('')",
                    {title: 'A template — the Project is picked when the tile is pressed'})
        + (projects.length
          ? projects.map(p => badgeHtml(p.label || p.id, p.id === d.project_id,
              `launcherPickProject('${escapeHtml(p.id)}')`,
              {proj: true, title: p.host && p.host !== 'local' ? 'on ' + p.host : ''})).join('')
          : '<span class="ql-none">This relay has no Projects configured.</span>')
        + '</div></div>'
        + (launcherIsTerm(d)
          // Offered for a `term` too, and optional there: the two differ by whether the line is
          // required, and a field that vanished between them would make switching one to the other
          // lose what was typed.
          ? `<label class="start-field">Command${d.action === 'term' ? ' <span class="field-note">optional</span>' : ''}`
            + '<textarea id="qlCommand" rows="2"'
            + ' autocapitalize="none" autocomplete="off" spellcheck="false"'
            + ` placeholder="pytest -q">${escapeHtml(d.command || '')}</textarea></label>`
          : launcherMembersHtml(members, kinds, configs))
        + (canArb
          ? '<div class="start-field">Arbitrator<div class="badge-strip">'
            + badgeHtml('None', !arbName, "launcherPickArb('')",
                        {title: 'The two talk without one deciding between them'})
            + kinds.map(k => badgeHtml(k, !arbConfig && k === arbName,
              `launcherPickArb('${escapeHtml(k)}')`,
                                       {agent: k})).join('')
            + launcherCustomBadges(configs, launcherArbCustom, 'arbitrator', c =>
              `launcherPickArb('${escapeHtml(c.kind)}', '${escapeHtml(c.id)}')`,
              c => c.id === arbConfig)
            + '</div></div>'
            + (arbName ? launcherArbSetupHtml(d, members) : '')
          : '')
        + launcherInsecureHtml(d)
        + '<p id="qlError" style="display:none;color:var(--red);font-size:0.75rem;margin:0"></p>'
        + '<div class="ql-actions">'
        + (launcherEditing
          ? `<button class="ql-secondary" onclick="launcherDelete('${escapeHtml(launcherEditing)}')">Delete</button>`
          : '<button class="ql-secondary" onclick="launcherDrawList()">Cancel</button>')
        + '<button id="qlSave" class="ql-primary" onclick="launcherSaveTile()">Save tile</button>'
        + '</div>';
    }

    // The one answer on this form that is not about what the tile does. Nothing here can tell a
    // provider that protects the user's work from one that does not — only the person who set the
    // endpoints up knows — so it is asked plainly and then repeated wherever the tile appears.
    // A checkbox and not a badge strip: it is a warning being accepted, not an option being tuned.
    function launcherInsecureHtml(d) {
      return '<label class="ql-insecure">'
        // No redraw on change: nothing else on the form depends on it, and launcherReadForm
        // picks it up before the save like every other field here.
        + `<input type="checkbox" id="qlInsecure"${d.insecure ? ' checked' : ''}>`
        + '<span><strong>Insecure</strong> — the providers behind this tile do not protect what is'
        + ' sent to them. Prompts, code and file contents may be retained or used for training.'
        + '</span></label>';
    }

    function launcherCustomBadges(configs, open, where, pick, selected) {
      if (!configs.length) return '';
      return badgeHtml('+custom', open, `launcherToggleCustom('${where === 'members' ? 'members' : 'arbitrator'}')`,
        {proj: true, title: 'Start under one of your agent configs'})
        + (open ? configs.map(c => badgeHtml(c.label, !!(selected && selected(c)), pick(c),
          {agent: c.kind, title: c.command || c.provider_label || ''})).join('') : '');
    }

    function launcherMembersHtml(members, kinds, configs) {
      return '<div class="start-field">Agents<div class="badge-strip">'
        + (kinds.length
          ? kinds.map(k => badgeHtml('+ ' + k, false, `launcherAddMember('${escapeHtml(k)}')`,
                                     {agent: k, title: 'Add one of these to the roster'})).join('')
          : '<span class="ql-none">This relay starts nothing.</span>')
        + launcherCustomBadges(configs, launcherMembersCustom, 'members', c =>
          `launcherAddMember('${escapeHtml(c.kind)}', '${escapeHtml(c.id)}')`)
        + '</div>'
        // Three answers per member: what to call it, what it is for, and what to say to it first.
        // The name is a template rather than the pane's name — launcherNamed puts the launch's tag
        // after it, because a tile pressed twice is two panes and two called "Reviewer" are two
        // the roster, the conversation and herdr's status line all fail to tell apart.
        + (members.length
          ? '<div class="ql-members">' + members.map((m, i) => launcherMemberHtml(m, i)).join('')
            + '</div>'
          : '<p class="ql-none">Tap an agent above to build the roster. Two of them with an '
            + 'arbitrator is an arbitrated session; more than one without is a conversation.</p>')
        // Step 4 of the press names what this makes, and so does the tile. Said here too, with the
        // same mark the conversation card wears, because the roster is where it is decided — and a
        // second agent added by accident is otherwise a room nobody meant to open.
        + (members.length > 1
          ? `<p class="ql-conv">${launcherIcon('conv')}<span>These ${members.length} start `
            + 'together in one conversation, named when you press the tile.</span></p>'
          : '')
        + '</div>';
    }

    // Everything that is only a question once there is an arbitrator: what it is deciding about,
    // what each member is *for*, and the clocks and limits it runs under. Drawn in `arb-form`
    // because that is the block the arbitration setup's own fields are laid out by — the role
    // picker, the folded clocks and the checkbox all come with their layout when they are inside
    // it, and a second stylesheet for the same three controls is the thing that drifts.
    function launcherArbSetupHtml(d, members) {
      const clocks = typeof arbClockOptions === 'function';
      return '<div class="arb-form ql-arb">'
        // The same class and the same sentence the arbitration setup shows, because it is the same
        // missing thing said in the second place it can be chosen.
        + '<span class="arb-note">@arbitrator starter prompt — not defined yet.</span>'
        + '<label>Deciding about<textarea id="qlScope" rows="2"'
        + ` placeholder="what this session is for">${escapeHtml(d.scope || '')}</textarea></label>`
        // The two being arbitrated, with a role each. Two slots and not the whole roster: the
        // arbitrator reads two members, so a third with a role field would be a question about
        // something nobody is going to be asked. Which two is the select — named rather than
        // assumed, the same way and for the same reason the setup dialog names them.
        + '<div class="ql-arb-roles">'
        + members.slice(0, 2).map((m, i) => '<div class="ql-arb-member">'
          // Which slot, then who is in it. At exactly two the select has one thing left to say by
          // the time it reaches Agent 2 — which is the honest shape of the question, not a control
          // that looks live and is not.
          + `<span class="ql-member-kind"><span class="ql-arb-slot">Agent ${i + 1}</span>`
          + launcherPairSelect(members, i)
          + (typeof configBadge === 'function' ? configBadge(m.name, m.config)
             : ` <span class="badge">${escapeHtml(m.name)}</span>`) + '</span>'
          + (typeof arbRoleField === 'function'
            ? arbRoleField(`qlRole${i}`, m.role || '')
            : `<input id="qlRole${i}" type="text" maxlength="240" autocapitalize="none"`
              + ` autocomplete="off" placeholder="what this one is for"`
              + ` value="${escapeHtml(m.role || '')}" />`)
          + '</div>').join('')
        + (members.length > 2
          ? `<p class="ql-none">The other ${members.length - 2} start in the conversation too — `
            + 'the arbitrator is not deciding between them.</p>'
          : '')
        + '</div>'
        // Folded, and for the same reason the dialog folds them: both clocks are Never until
        // somebody goes looking for them, and three limits nobody changed are the relay's own
        // defaults. `typeof` because a build without arbitration draws a tile editor that simply
        // does not offer them, rather than a broken page.
        + (clocks
          ? '<details class="arb-more"><summary>Clocks and limits</summary>'
            + '<label>If a member goes quiet<select id="qlIdle">'
            + arbClockOptions(ARB_IDLE_CHOICES, d.idle) + '</select></label>'
            + '<label>If a member works without stopping<select id="qlRuntime">'
            + arbClockOptions(ARB_RUNTIME_CHOICES, d.runtime) + '</select></label>'
            + arbLimitField('qlSteps', 'Stop after this many sends', d.steps, ARB_LIMITS.arbSteps)
            + arbLimitField('qlRuns', 'Stop after this many in a row with nobody joining in',
                            d.runs, ARB_LIMITS.arbRuns)
            + arbLimitField('qlMinutes', 'Stop after this many minutes', d.minutes,
                            ARB_LIMITS.arbMinutes)
            + '<label class="arb-check"><input id="qlWarmup" type="checkbox"'
            + `${d.warmup ? ' checked' : ''}> Wake the members before the first instruction</label>`
            + '<span class="arb-note">agy is always woken — it is the one that needs it.</span>'
            + '</details>'
          : '')
        + '</div>';
    }

    // Who is in one of the two arbitrated slots. Slot 1 may be any member; slot 2 is everything
    // that is not already slot 1, because a pair naming the same pane twice is not a pair.
    function launcherPairSelect(members, slot) {
      const opts = members
        .map((m, at) => ({m: m, at: at}))
        .filter(o => slot === 0 || o.at !== 0);
      return `<select id="qlPair${slot}" onchange="launcherPickPair(${slot}, this.value)"`
        + ` aria-label="Which agent is Agent ${slot + 1}">`
        + opts.map(o => `<option value="${o.at}"${o.at === slot ? ' selected' : ''}>`
            + escapeHtml(o.m.label ? `${o.m.label} — ${o.m.name}` : o.m.name)
            + '</option>').join('')
        + '</select>';
    }

    // A swap and not a stored index: the pair is the first two of the roster everywhere else, so
    // moving a member into a slot is moving it up the list. The role rides with it — it is a field
    // on the member — which is what makes swapping the two slots do the obvious thing.
    function launcherPickPair(slot, at) {
      launcherReadForm();
      const members = (launcherDraft || {}).members || [];
      const i = Number(at);
      if (!(i >= 0) || i >= members.length || i === slot) return;
      const held = members[slot];
      members[slot] = members[i];
      members[i] = held;
      launcherDrawForm();
    }

    // One member. A card and not a row: three fields side by side is a phone's whole width spent
    // on placeholders nobody can read.
    function launcherMemberHtml(m, i) {
      const at = m.at === undefined ? LAUNCHER_DEFAULT_AT : m.at;
      const config = m.config && launcherConfigs().find(c => c.id === m.config);
      const shown = config ? config.label : m.name;
      return '<div class="ql-member">'
        + `<span class="ql-member-kind">${escapeHtml(shown)}</span>`
        + `<button class="ql-del" onclick="launcherDropMember(${i})"`
        + ` aria-label="Remove ${escapeHtml(m.name)}">✕</button>`
        + launcherUnattendedHtml(m, 'qlSolo' + i)
        + `<input id="qlMemberName${i}" type="text" maxlength="${LAUNCHER_LABEL_MAX}"`
        + ` autocapitalize="none" autocomplete="off" placeholder="name (optional)"`
        + ` value="${escapeHtml(m.label || '')}" />`
        // No role here. A role is what the *arbitrator* is told this member is for — it means
        // nothing to the agent, which is never shown it and is not started differently because of
        // it. So it is asked for in the one place it means something: under the arbitrator, once
        // there is one. See launcherArbSetupHtml.
        //
        // A select over the chips the composer already offers, rather than a textarea: the text of
        // a starter is edited in one place and every tile that names it follows, which is why the
        // chips are addressed by name everywhere else in the app.
        + `<select id="qlAt${i}" aria-label="First prompt for ${escapeHtml(m.name)}">`
        + `<option value=""${at ? '' : ' selected'}>@none — no first prompt</option>`
        + (typeof SHORTCUTS === 'undefined' ? '' : SHORTCUTS.map(sc =>
            `<option value="${escapeHtml(sc.at)}"${sc.at === canonAt(at) ? ' selected' : ''}>`
            + `@${escapeHtml(sc.at)} — ${escapeHtml(sc.label)}</option>`).join(''))
        + '</select>'
        + '</div>';
    }

    // One rendering for the editable member card and the read-only launch sheet. The latter is
    // deliberately a disabled native checkbox: the tile's saved answer is visible but cannot be
    // changed while confirming a launch.
    function launcherUnattendedHtml(m, id, readOnly) {
      if (!launcherUnattendedOffered(m.name)) return '';
      const checked = launcherUnattended(m) ? ' checked' : '';
      const disabled = readOnly ? ' disabled' : '';
      const ident = id ? ` id="${id}"` : '';
      return `<label class="ql-solo${readOnly ? ' ql-solo-readonly' : ''}">`
        + `<input type="checkbox"${ident}${checked}${disabled}`
        + ` aria-label="Start ${escapeHtml(m.name)} without approval prompts" />`
        + '<span>Skip approvals</span></label>';
    }

    // The relay says which harnesses it can start this way. An older relay says nothing, and then
    // nothing is offered: the checkbox would be a start refused on arrival.
    function launcherUnattendedOffered(kind) {
      return ((startOptions || {}).unattended || []).indexOf(kind) >= 0;
    }

    function launcherDrawForm() {
      const title = document.getElementById('launcherEditTitle');
      if (title) title.textContent = launcherEditing ? 'Edit tile' : 'New tile';
      const el = document.getElementById('launcherEditBody');
      if (el) el.innerHTML = launcherFormHtml();
    }

    function launcherSetFormError(text) {
      const el = document.getElementById('qlError');
      if (!el) return;
      el.textContent = text || '';
      el.style.display = text ? 'block' : 'none';
    }

    function launcherSaveTile() {
      const d = launcherReadForm();
      if (!d) return false;
      const tile = launcherTileOf(d);
      // launcherValid and not a second opinion written here: an editor that had its own idea of
      // what is legal is how a tile gets saved that the presser then refuses.
      const bad = launcherValid(tile);
      if (bad) { launcherSetFormError(bad); return false; }
      putLauncherTile(tile);
      renderLauncher();
      // The gate is a different question from the validation, and it is worth saying out loud on
      // the way out: a tile can be perfectly well written and still not be pressable on the relay
      // that is connected right now. Said, not refused — the relay it is for may be the next one.
      const gate = launcherGate(tile, launcherEnv());
      if (!gate.ok) showToast(gate.reason);
      launcherDrawList();
      return true;
    }

    // The draft as a tile: the working fields the form keeps dropped, and the ones a tile of this
    // kind has no use for left off entirely. A `run` carrying an empty members array would be a
    // tile whose stored shape says something about a roster it does not have.
    function launcherTileOf(d) {
      const tile = {id: d.id, label: String(d.label || '').trim(), action: d.action,
                    project_id: d.project_id};
      // Absent rather than false, like every other optional field here: a tile that has never been
      // marked and one marked and unmarked are the same tile.
      if (d.insecure) tile.insecure = true;
      if (launcherIsTerm(d)) { tile.command = String(d.command || '').trim(); return tile; }
      tile.members = (d.members || []).map(m => {
        const out = {name: m.name};
        if (m.config) out.config = m.config;
        if (m.role) out.role = m.role;
        if (m.label) out.label = m.label;
        // '' is a real answer — this member opens with nothing — so it is stored as absent and
        // read back as absent, and the default only applies to a member being added.
        if (m.at) out.at = m.at;
        // Absent while it agrees with the default for a member like this — on under an agent
        // config, off on a stock harness — and written down the moment the user disagrees. Same
        // rule as every other optional field here: a tile stores answers, not restatements.
        const solo = launcherUnattended(m);
        if (solo !== !!m.config) out.unattended = solo;
        return out;
      });
      // Kept whatever the roster size, exactly as launcherWantsArb expects: a tile widened to
      // three and edited back down to two must still have the arbitrator it was given.
      if (d.arbitrator && d.arbitrator.name) {
        tile.arbitrator = {name: d.arbitrator.name};
        if (d.arbitrator.config) tile.arbitrator.config = d.arbitrator.config;
        // Only what was answered. An absent clock is off and an absent limit is the relay's own
        // DEFAULT_BUDGET — restating either here would be a second copy of a number the relay
        // owns, kept in step by hand for no gain.
        ['idle', 'runtime', 'steps', 'runs', 'minutes'].forEach(k => {
          const n = Number(d[k]);
          if (n > 0) tile[k] = Math.round(n);
        });
        if (d.warmup) tile.warmup = true;
        if (d.arbitrator.role) tile.arbitrator.role = d.arbitrator.role;
        if (d.arbitrator.label) tile.arbitrator.label = d.arbitrator.label;
        const scope = String(d.scope || '').trim();
        if (scope) tile.scope = scope;
      }
      return tile;
    }
