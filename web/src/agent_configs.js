    // --- Agent configs ---
    // A config is one name for "this harness, against that provider, on that model, with that
    // key" — `oclaude1` beside stock `claude`. The split is the point and it is not this file's
    // to move: a *provider* is a file on the relay's machine and names the endpoint and which of
    // the relay's environment variables may supply a credential; an *alias* is what lives here,
    // and it can only ever choose among what that file already authorised. So there is no field
    // in this editor that names a host, a variable, or a secret — and nothing a browser writes
    // can send a key somewhere the file did not.
    //
    // localStorage is the working copy, mirrored by state_sync like the launcher next door: which
    // model `oclaude1` runs is a fact about the work, not about this screen.

    const AGENT_CONFIG_KEY = 'herdr_agent_configs';
    const AGENT_CONFIG_MAX = 64;

    function parseAgentConfigs(raw) {
      let doc = null;
      try { doc = JSON.parse(raw || 'null'); } catch (e) { doc = null; }
      const items = doc && Array.isArray(doc.aliases) ? doc.aliases : [];
      return items.filter(a => a && typeof a.id === 'string' && a.id).slice(0, AGENT_CONFIG_MAX);
    }

    function loadAgentConfigs() {
      try { return parseAgentConfigs(localStorage.getItem(AGENT_CONFIG_KEY)); }
      catch (e) { return []; }
    }

    function saveAgentConfigs(items) {
      const kept = items.slice(0, AGENT_CONFIG_MAX);
      try {
        localStorage.setItem(AGENT_CONFIG_KEY, JSON.stringify({aliases: kept}));
      } catch (e) { /* private mode: this session only */ }
      if (typeof stateSyncMark === 'function') stateSyncMark('agent_configs');
      return kept;
    }

    // What the relay says about each alias: its harness, whether the key variable is actually set
    // over there, and the command line the spawn will run. Derived on the relay because only the
    // relay has read the provider file — so a row this browser wrote is drawn from the answer
    // rather than from what it wrote, which is also what makes a typo visible.
    function agentConfigRows() {
      return ((typeof startOptions !== 'undefined' && startOptions) || {}).configs || [];
    }

    // Is this alias still one the relay offers, for that harness? The question every path that
    // starts something already recorded has to ask first: an id outlives what it names, and the
    // relay refuses a start carrying a dead one rather than quietly running it on the stock
    // endpoint — so the client asks before it sends, and puts the choice back to the reader.
    function agentConfigLive(id, kind) {
      const row = agentConfigRow(id);
      return !!(row && (!kind || row.kind === kind));
    }

    function agentConfigProviders() {
      return ((typeof startOptions !== 'undefined' && startOptions) || {}).providers || [];
    }

    function agentConfigRow(id) {
      return agentConfigRows().find(r => r.id === id) || null;
    }

    // The harness an alias runs, so every badge for it wears that harness's colour. `oclaude1` is
    // a claude and reads as one; a colour that meant "custom" would be a twelfth thing to learn.
    function agentConfigKind(id) {
      return (agentConfigRow(id) || {}).kind || '';
    }

    // --- The section, under the launcher's own tiles ---

    function agentConfigBands() {
      const out = [];
      for (const row of agentConfigRows()) {
        const band = out.find(b => b.kind === row.kind);
        if (band) band.rows.push(row); else out.push({kind: row.kind, rows: [row]});
      }
      return out;
    }

    // Two lines. The first is what the thing is — its name, its harness, the provider it is
    // pointed at; the second is what it will do — the model, and the key variable with whether
    // this relay actually holds it. Everything needed to tell two aliases apart without opening
    // either, which is the whole job of a list of near-identical things.
    function agentConfigRowHtml(row) {
      const badge = typeof agentBadge === 'function' ? agentBadge(row.label, row.kind)
        : ` <span class="badge">${escapeHtml(row.label)}</span>`;
      const key = row.key
        ? `<span class="cfg-key${row.key_set ? '' : ' cfg-unset'}"`
          + ` title="${row.key_set ? 'This relay holds ' + escapeHtml(row.key)
              : escapeHtml(row.key) + ' is not set on the relay — the session would start without'
                + ' a key'}">$${escapeHtml(row.key)}${row.key_set ? '' : ' ✕'}</span>`
        : '';
      return `<button class="cfg-row" onclick="openAgentConfig('${escapeHtml(row.id)}')"`
        + ` title="View and edit ${escapeHtml(row.label)}">`
        + `<span class="cfg-line">${badge}`
        + `<span class="cfg-provider">${escapeHtml(row.provider_label || row.provider)}</span></span>`
        + `<span class="cfg-line cfg-sub"><span class="cfg-model">`
        + `${escapeHtml(row.model || 'default model')}</span>${key}</span>`
        + '</button>';
    }

    function agentConfigsHtml() {
      // Nothing to draw without a provider file: aliases would have nothing to be aliases *of*,
      // and a header over an empty list that can never fill is worse than no header. The same
      // rule start_options already applies to Start.
      if (!agentConfigProviders().length) return '';
      const bands = agentConfigBands();
      return '<div class="section-header" style="margin-top:18px">Agent configs'
        + '<button class="section-action" onclick="openAgentConfig(\'\')"'
        + ' title="Add a config" aria-label="Add an agent config">+ New</button></div>'
        + (bands.length
          ? bands.map(b => `<div class="launcher-band">${escapeHtml(b.kind)}</div>`
            + b.rows.map(agentConfigRowHtml).join('')).join('')
          : '<div class="cfg-empty">No configs yet. + New names one — a model and a key, against'
            + ' a provider this relay already has.</div>');
    }

    // --- One config, in the launcher's own dialog ---
    // Reused rather than built again: it is the same modal, the same close button, and a second
    // one would be a second thing to dismiss.

    let agentConfigDraft = null;

    function openAgentConfig(id) {
      const providers = agentConfigProviders();
      // The local document first, then the relay's own row for it. The second is not a nicety: a
      // browser that has adopted the shared document has both, but one that has just connected has
      // the row on screen before the document lands — and a dialog that opened blank on a row the
      // user can see would look like the config had been lost.
      const row = id ? agentConfigRow(id) : null;
      const stored = loadAgentConfigs().find(a => a.id === id)
        || (row ? {id: row.id, label: row.label, provider: row.provider, model: row.model,
                   model_option: row.model_option, key: row.key} : null);
      // `saved` freezes the id: it is derived from the name while a config is being made, and a
      // rename afterwards must not silently become a different config.
      agentConfigDraft = stored ? Object.assign({saved: true}, stored)
        : {id: '', label: '', provider: (providers[0] || {}).id || '',
           model: '', model_option: '', key: ''};
      drawAgentConfig();
      const box = document.getElementById('launcherModal');
      if (box) box.style.display = 'block';
    }

    function agentConfigSet(field, value) {
      if (!agentConfigDraft) return;
      agentConfigDraft[field] = value;
      // The provider decides which keys exist, so changing it drops a key the new one never
      // offered rather than carrying a name the relay would refuse.
      if (field === 'provider') {
        agentConfigDraft.key = '';
        const provider = agentConfigProviders().find(p => p.id === value) || {};
        // These fields are absent because the selected provider cannot carry them. Leaving an
        // old value in the draft would save a setting the new provider silently ignores.
        if (provider.has_model === false) agentConfigDraft.model = '';
        if (provider.has_model_option === false) agentConfigDraft.model_option = '';
      }
      drawAgentConfig();
    }

    // A typed field records and does *not* redraw. The dialog is one innerHTML write, so redrawing
    // on every keystroke replaces the input under the cursor — which is a field that drops focus
    // after one character. Only the choices redraw, because only they change what is on the form.
    function agentConfigType(field, value) {
      if (agentConfigDraft) agentConfigDraft[field] = value;
    }

    // Suggestions when the provider file names none. A shortcut and never a limit — the field
    // stays free text, because model names move faster than any list in this app. Keyed by
    // harness, so a provider that carries a model variable at all gets the names for its CLI.
    const MODEL_SUGGESTIONS = {
      claude: ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-8[1m]',
               'claude-opus-4-6[1m]', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    };

    // The two model fields, drawn only where they do something. A provider with no `model_var`
    // takes its model from its own config file — codex does — and a box that silently went
    // nowhere is worse than no box, so it says where the model actually lives instead.
    function agentConfigModelHtml(provider, d) {
      if (!provider.has_model && !provider.has_model_option) {
        return '<div class="cfg-note">This provider takes its model from the CLI\'s own config,'
          + ' not the environment — so there is nothing to set here.</div>';
      }
      const list = (provider.models || []).length
        ? provider.models : (MODEL_SUGGESTIONS[provider.kind] || []);
      // A native datalist: the field is still free text, the suggestions are one tap on a phone,
      // and it is markup rather than a dropdown this app would have to own.
      const datalist = list.length
        ? `<datalist id="cfgModels">${list.map(m =>
            `<option value="${escapeHtml(m)}"></option>`).join('')}</datalist>`
        : '';
      const field = (label, key, placeholder) =>
        `<label class="start-field">${label}`
        + '<input type="text" maxlength="120" autocapitalize="none" autocomplete="off"'
        + (datalist ? ' list="cfgModels"' : '')
        + ` value="${escapeHtml(d[key] || '')}" placeholder="${escapeHtml(placeholder)}"`
        + ` oninput="agentConfigType('${key}', this.value)"></label>`;
      return datalist
        + (provider.has_model ? field('Model', 'model', list[0] || 'claude-opus-5') : '')
        + (provider.has_model_option
          ? field('Model option', 'model_option', list[1] || '') : '');
    }

    function drawAgentConfig() {
      const body = document.getElementById('launcherEditBody');
      const title = document.getElementById('launcherEditTitle');
      if (!body || !agentConfigDraft) return;
      const d = agentConfigDraft;
      const provider = agentConfigProviders().find(p => p.id === d.provider) || {};
      if (title) title.textContent = d.id ? d.label || d.id : 'New agent config';
      const row = d.id ? agentConfigRow(d.id) : null;
      const keys = provider.keys || [];
      body.innerHTML =
        '<label class="start-field">Name'
        + `<input id="cfgLabel" type="text" maxlength="32" autocapitalize="none" autocomplete="off"`
        + ` value="${escapeHtml(d.label || '')}"`
        + ' placeholder="oclaude1" oninput="agentConfigName(this.value)"></label>'
        + '<label class="start-field">Provider'
        + `<select onchange="agentConfigSet('provider', this.value)">`
        + agentConfigProviders().map(p =>
          `<option value="${escapeHtml(p.id)}"${p.id === d.provider ? ' selected' : ''}>`
          + `${escapeHtml(p.label)} — ${escapeHtml(p.kind)}</option>`).join('')
        + '</select></label>'
        // Read-only on purpose, and said out loud rather than left off: the endpoint is the whole
        // of what makes a provider a trust decision, and it is edited in the file on the relay's
        // machine. A field here that could change it would be this feature's one real hole.
        + (provider.base_url
          ? `<div class="cfg-note">Endpoint <code>${escapeHtml(provider.base_url)}</code>`
            + ' — set in the relay\'s config file, not here.</div>'
          : '')
        + agentConfigModelHtml(provider, d)
        + (keys.length
          ? '<div class="start-field">Key<div class="badge-strip">'
            + keys.map(k => badgeHtml('$' + k.name + (k.set ? '' : ' ✕'),
                k.name === (d.key || (keys[0] || {}).name),
                `agentConfigSet('key', '${escapeHtml(k.name)}')`,
                {proj: true, title: k.set ? 'This relay holds ' + k.name
                  : k.name + ' is not set on the relay'})).join('')
            + '</div></div>'
          : '<div class="cfg-note">This provider names no key variables.</div>')
        // The line the relay will actually run, with the key as a `$VAR` reference rather than a
        // value — so it is both safe to show and pasteable into the user's own shell, which is
        // how a wrong endpoint gets found in one paste instead of one spawn. Only for a saved
        // config: it comes from the relay, and an unsaved draft is not one it has read.
        + (row && row.command
          ? '<div class="cfg-note">Effective command</div>'
            + `<pre class="cfg-command" onclick="writeClipboard(this.textContent, function(){})"`
            + ' title="Tap to copy">' + escapeHtml(row.command) + '</pre>'
          : d.id ? '' : '<div class="cfg-note">Save it to see the command it will run.</div>')
        + '<div class="ql-actions">'
        + (d.id && loadAgentConfigs().some(a => a.id === d.id)
          ? '<button class="ql-secondary" onclick="deleteAgentConfig()">Delete</button>'
          : '<button class="ql-secondary" onclick="closeLauncherEdit()">Cancel</button>')
        + '<button class="ql-primary" onclick="saveAgentConfig()">Save config</button></div>';
    }

    // The name is the id, lowercased into the shape the relay accepts — one field rather than
    // two, because nobody wants to type `oclaude1` twice to get a config called oclaude1.
    function agentConfigName(value) {
      if (!agentConfigDraft) return;
      agentConfigDraft.label = value.slice(0, 32);
      if (!agentConfigDraft.saved) {
        // "oclaude [1]" is an id of `oclaude-1`, not `oclaude--1-`: runs of punctuation collapse
        // to one dash and the ends are trimmed, the same shape every other slug in this app has.
        agentConfigDraft.id = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
      }
    }

    function saveAgentConfig() {
      const d = agentConfigDraft;
      if (!d || !d.id || !d.provider) return;
      const items = loadAgentConfigs();
      const at = items.findIndex(a => a.id === d.id);
      const row = {id: d.id, label: d.label || d.id, provider: d.provider,
                   model: d.model || '', model_option: d.model_option || '', key: d.key || ''};
      if (at < 0) items.push(row); else items[at] = row;
      saveAgentConfigs(items);
      closeLauncherEdit();
      // The row's derived half — the command, whether the key is set — is the relay's answer, and
      // it arrives as a fresh start_options once the write lands. Until then the section redraws
      // from what it already had, which is the previous answer rather than a wrong new one.
      renderLauncher();
    }

    function deleteAgentConfig() {
      const d = agentConfigDraft;
      if (!d || !d.id) return;
      saveAgentConfigs(loadAgentConfigs().filter(a => a.id !== d.id));
      closeLauncherEdit();
      renderLauncher();
    }

    // state_sync's rerender target for this document, and the reason it is named rather than
    // inlined: a config written on the phone has to redraw the desktop's launcher.
    function renderAgentConfigs() {
      if (typeof renderLauncher === 'function') renderLauncher();
    }
