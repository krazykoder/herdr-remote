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

    function launcherKinds() { return (startOptions && startOptions.agents) || []; }

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
      (d.members || []).forEach((m, i) => {
        const role = val('qlRole' + i);
        if (role !== undefined) m.role = role.trim();
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

    function openLauncherEdit() {
      launcherDrawList();
      const box = document.getElementById('launcherModal');
      if (box) box.style.display = 'block';
    }

    function closeLauncherEdit() {
      launcherDraft = null;
      launcherEditing = '';
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
        id: launcherId(), label: '', action: 'run',
        // The first Project rather than none: there is usually one in play, and a form that opens
        // with its only required choice unmade reads as broken rather than as a question.
        project_id: (projects[0] || {}).id || '',
        command: '', members: [], scope: '',
      };
      // A relay that starts nothing still has terminals, and one with terminals off still starts
      // agents. Opening on the half that cannot work is a form whose first act is to refuse.
      if (!(startOptions || {}).terminal && kinds.length) launcherDraft.action = 'spawn';
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
      launcherDrawForm();
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

    function launcherAddMember(name) {
      launcherReadForm();
      const d = launcherDraft;
      if ((d.members || []).length >= LAUNCHER_MEMBERS_MAX) {
        showToast(`At most ${LAUNCHER_MEMBERS_MAX} agents`);
        return;
      }
      d.members = (d.members || []).concat([{name: name, role: ''}]);
      launcherDrawForm();
    }

    function launcherDropMember(i) {
      launcherReadForm();
      launcherDraft.members = (launcherDraft.members || []).filter((m, at) => at !== i);
      launcherDrawForm();
    }

    // '' switches it off. Off and not absent, because launcherWantsArb reads the field's presence
    // and a tile that lost its arbitrator by being widened to three keeps it — see step 6.
    function launcherPickArb(name) {
      launcherReadForm();
      launcherDraft.arbitrator = name ? {name: name} : null;
      launcherDrawForm();
    }

    function launcherFormHtml() {
      const d = launcherDraft;
      const kinds = launcherKinds();
      const terminal = !!(startOptions || {}).terminal;
      const members = d.members || [];
      // Exactly two is what §14.1 fixes an arbitrated roster at, so the row is offered at exactly
      // two. A tile that has one anyway keeps it — the field is hidden, not cleared.
      const canArb = d.action === 'spawn' && members.length === 2;
      const arbName = (d.arbitrator || {}).name || '';
      return '<label class="start-field">Name<input id="qlName" type="text"'
        + ` maxlength="${LAUNCHER_LABEL_MAX}" autocapitalize="none" autocomplete="off"`
        + ` placeholder="what pressing this does" value="${escapeHtml(d.label || '')}" /></label>`
        + '<div class="start-field">What it does<div class="badge-strip">'
        + badgeHtml('Run a command', d.action === 'run', "launcherPickAction('run')",
                    {title: terminal ? 'Opens a terminal and types this at it'
                                     : 'This relay has terminal mode switched off'})
        + badgeHtml('Start agents', d.action === 'spawn', "launcherPickAction('spawn')",
                    {title: kinds.length ? 'Starts one or more sessions'
                                         : 'This relay starts nothing'})
        + '</div></div>'
        + '<div class="start-field">Project<div class="badge-strip">'
        + (projects.length
          ? projects.map(p => badgeHtml(p.label || p.id, p.id === d.project_id,
              `launcherPickProject('${escapeHtml(p.id)}')`,
              {proj: true, title: p.host && p.host !== 'local' ? 'on ' + p.host : ''})).join('')
          : '<span class="ql-none">This relay has no Projects configured.</span>')
        + '</div></div>'
        + (d.action === 'run'
          ? '<label class="start-field">Command<textarea id="qlCommand" rows="2"'
            + ' autocapitalize="none" autocomplete="off" spellcheck="false"'
            + ` placeholder="pytest -q">${escapeHtml(d.command || '')}</textarea></label>`
          : launcherMembersHtml(members, kinds))
        + (canArb
          ? '<div class="start-field">Arbitrator<div class="badge-strip">'
            + badgeHtml('None', !arbName, "launcherPickArb('')",
                        {title: 'The two talk without one deciding between them'})
            + kinds.map(k => badgeHtml(k, k === arbName, `launcherPickArb('${escapeHtml(k)}')`,
                                       {agent: k})).join('')
            + '</div></div>'
            + (arbName
              ? '<label class="start-field">Deciding about<textarea id="qlScope" rows="2"'
                + ` placeholder="what this session is for">${escapeHtml(d.scope || '')}</textarea>`
                + '</label>'
              : '')
          : '')
        + '<p id="qlError" style="display:none;color:var(--red);font-size:0.75rem;margin:0"></p>'
        + '<div class="ql-actions">'
        + (launcherEditing
          ? `<button class="ql-secondary" onclick="launcherDelete('${escapeHtml(launcherEditing)}')">Delete</button>`
          : '<button class="ql-secondary" onclick="launcherDrawList()">Cancel</button>')
        + '<button id="qlSave" class="ql-primary" onclick="launcherSaveTile()">Save tile</button>'
        + '</div>';
    }

    function launcherMembersHtml(members, kinds) {
      return '<div class="start-field">Agents<div class="badge-strip">'
        + (kinds.length
          ? kinds.map(k => badgeHtml('+ ' + k, false, `launcherAddMember('${escapeHtml(k)}')`,
                                     {agent: k, title: 'Add one of these to the roster'})).join('')
          : '<span class="ql-none">This relay starts nothing.</span>')
        + '</div>'
        // One text field per member and no more. The relay names a pane for the role it was given,
        // which is the label anybody wanted; a second field for the pane's own name would be a
        // field that is right to leave blank almost every time.
        + (members.length
          ? '<div class="ql-members">' + members.map((m, i) =>
            '<div class="ql-member">'
            + `<span class="ql-member-kind">${escapeHtml(m.name)}</span>`
            + `<input id="qlRole${i}" type="text" maxlength="32" autocapitalize="none"`
            + ` autocomplete="off" placeholder="role (optional)"`
            + ` value="${escapeHtml(m.role || '')}" />`
            + `<button class="ql-del" onclick="launcherDropMember(${i})"`
            + ` aria-label="Remove ${escapeHtml(m.name)}">✕</button></div>`).join('') + '</div>'
          : '<p class="ql-none">Tap an agent above to build the roster. Two of them with an '
            + 'arbitrator is an arbitrated session; more than one without is a conversation.</p>')
        + '</div>';
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
      if (d.action === 'run') { tile.command = String(d.command || '').trim(); return tile; }
      tile.members = (d.members || []).map(m => {
        const out = {name: m.name};
        if (m.role) out.role = m.role;
        if (m.label) out.label = m.label;
        return out;
      });
      // Kept whatever the roster size, exactly as launcherWantsArb expects: a tile widened to
      // three and edited back down to two must still have the arbitrator it was given.
      if (d.arbitrator && d.arbitrator.name) {
        tile.arbitrator = {name: d.arbitrator.name};
        if (d.arbitrator.role) tile.arbitrator.role = d.arbitrator.role;
        if (d.arbitrator.label) tile.arbitrator.label = d.arbitrator.label;
        const scope = String(d.scope || '').trim();
        if (scope) tile.scope = scope;
      }
      return tile;
    }
