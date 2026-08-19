    // One sheet for every "which other pane?" question.
    //
    // Pinning a partner and adding members to a conversation were two pickers that differed only in
    // what they did with the answer: one list of live panes, one row shape, one tick. They are one
    // sheet now — search at the head because a roster of twenty is otherwise a scroll, the action at
    // the foot so it is on screen with the keyboard up, and multi-select where adding four panes
    // used to be four round trips through a closing dialog.
    //
    // What differs between the two is a spec, passed to openPanePicker:
    //
    //   title        the sheet's heading
    //   multi        true to tick several rows; one replaces the other otherwise
    //   groups()     [{head, rows}] — read on every keystroke, so it reflects live panes
    //   empty        what to say when there is nothing to choose at all
    //   extra()      html appended under the rows: the way out of an empty list
    //   choose(ids)  called after every tick, for a form that opens on the choice
    //   label(ids)   the submit button's words
    //   submit(ids)  what the answer is for
    //
    // A row is {id, name, meta, note, color, glyph, dim}. `meta` is html — the caller escapes it,
    // because it carries an agent badge — and everything else is text.
    let picker = null;

    function openPanePicker(spec) {
      picker = Object.assign({multi: false, chosen: []}, spec);
      document.getElementById('pickTitle').textContent = spec.title || '';
      document.getElementById('pickSearch').value = '';
      document.getElementById('pairFields').style.display = 'none';
      setPickError('');
      renderPicker();
      document.getElementById('pickSheet').style.display = 'block';
    }

    function pickerOpen() {
      return !!picker;
    }

    function closePicker() {
      document.getElementById('pickSheet').style.display = 'none';
      picker = null;
      // The pair's own working state lives outside this sheet — start_dialog reads it to tell a
      // saved pair from a refused one — so closing the sheet is what clears it.
      pairSource = null;
      pairPartner = null;
    }

    // warn=true for "this will replace X" — it is a caution, not a refusal, and colouring it like
    // a failure teaches the user to ignore the colour.
    function setPickError(text, warn) {
      const el = document.getElementById('pickError');
      el.textContent = text || '';
      el.style.color = warn ? 'var(--orange)' : 'var(--red)';
      el.style.display = text ? 'block' : 'none';
    }

    // Name, harness and path, which is everything a row shows — so what is searched is what is
    // read. Tags are stripped rather than excluded: `meta` arrives as html and its badge holds the
    // agent's name, which is exactly the word someone types to find "the codex one".
    function pickHay(row) {
      return `${row.name || ''} ${String(row.meta || '').replace(/<[^>]*>/g, ' ')} ${row.note || ''}`
        .toLowerCase();
    }

    function pickRowHtml(row) {
      const on = picker.chosen.includes(row.id);
      return `<button class="pair-pick${on ? ' on' : ''}${row.dim ? ' past' : ''}" ` +
        `aria-pressed="${on ? 'true' : 'false'}" data-id="${escapeHtml(row.id)}" ` +
        `onclick="pickChoose(this.dataset.id)">` +
        `<span class="dot" style="background:${row.color || 'var(--muted)'}" aria-hidden="true"></span>` +
        `<span class="kind" aria-hidden="true">${row.glyph || '⬛'}</span>` +
        `<span class="info"><span class="name">${escapeHtml(row.name || '')}</span>` +
        `<span class="meta">${row.meta || ''}</span></span>` +
        (row.note ? `<span class="pair-note">${escapeHtml(row.note)}</span>` : '') +
        `<span class="pair-tick" aria-hidden="true">${on ? '✓' : ''}</span></button>`;
    }

    function renderPicker() {
      if (!picker) return;
      const q = document.getElementById('pickSearch').value.trim().toLowerCase();
      let shown = 0, all = 0;
      const html = picker.groups().map(g => {
        const rows = q ? g.rows.filter(r => pickHay(r).includes(q)) : g.rows;
        all += g.rows.length;
        shown += rows.length;
        // A heading over nothing reads as a group that has emptied rather than one that was
        // filtered away, so a group with no matches is not drawn at all.
        if (!rows.length) return '';
        return `<div class="pair-head">${escapeHtml(g.head)}</div>` + rows.map(pickRowHtml).join('');
      }).join('');
      // Two different nothings: nothing matches what was typed, and there was nothing to begin
      // with. The first is answered by clearing the box and the second is not, so they are not the
      // same sentence.
      const none = all ? `Nothing here matches "${q}".` : (picker.empty || 'Nothing to choose.');
      document.getElementById('pickList').innerHTML =
        (shown ? html : `<p class="pair-empty">${escapeHtml(none)}</p>`) +
        (picker.extra ? picker.extra() : '');
      // The search box appears once there is enough to search. Below that it is a control that can
      // only ever filter a list already entirely on screen.
      document.getElementById('pickSearch').parentElement.hidden = all < 5 && !q;
      const submit = document.getElementById('pickSubmit');
      submit.textContent = picker.label ? picker.label(picker.chosen) : 'Save';
      submit.disabled = !picker.chosen.length;
    }

    function pickChoose(id) {
      if (!picker) return;
      const at = picker.chosen.indexOf(id);
      if (!picker.multi) picker.chosen = at < 0 ? [id] : [];
      else if (at < 0) picker.chosen.push(id);
      else picker.chosen.splice(at, 1);
      if (picker.choose) picker.choose(picker.chosen);
      renderPicker();
      if (window.cue) cue('tick');
    }

    function pickSubmit() {
      if (picker && picker.chosen.length) picker.submit(picker.chosen.slice());
    }

    // The row every live pane gets, wherever it is being chosen: the reorder sheet's shape without
    // the handle. Same dot, same kind glyph, same name over a badge and a short path.
    function pickPaneRow(a, extra) {
      const cwd = a.cwd ? escapeHtml(a.cwd.split('/').slice(-2).join('/')) : '';
      return Object.assign({
        id: a.pane_id,
        name: paneLabel(a),
        meta: a.agent ? `${agentBadge(a.agent)} ${cwd}` : cwd,
        color: a.agent ? statusColor(a) : shellColor(a.pane_id),
        glyph: a.agent ? agentGlyph() : '⬛',
      }, extra || {});
    }
