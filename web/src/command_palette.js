    // --- Command Palette ---
    const COMMANDS = {
      claude: [
        { cmd: '/compact', desc: 'Summarize context to free tokens', common: true },
        { cmd: '/clear', desc: 'Start fresh conversation', common: true, danger: true },
        { cmd: '/model', desc: 'Switch model', common: true },
        { cmd: '/status', desc: 'Show version and connectivity', common: true },
        { cmd: '/context', desc: 'Visualize context-window usage', common: true },
        { cmd: '/review', desc: 'Review a pull request', common: true },
        { cmd: '/diff', desc: 'Show uncommitted changes', common: false },
        { cmd: '/resume', desc: 'Resume previous conversation', common: false },
        { cmd: '/help', desc: 'Show all commands', common: false },
      ],
      codex: [
        { cmd: '/compact', desc: 'Summarize history to free context', common: true },
        { cmd: '/clear', desc: 'Reset and start new chat', common: true, danger: true },
        { cmd: '/diff', desc: 'Show git diff of working tree', common: true },
        { cmd: '/model', desc: 'Switch model', common: true },
        { cmd: '/status', desc: 'Show model and token usage', common: true },
        { cmd: '/review', desc: 'Code review working tree', common: true },
        { cmd: '/mention', desc: 'Attach files to context', common: false },
        { cmd: '/plan', desc: 'Enter plan mode', common: false },
      ],
      // agy lists 57 commands; these are the ones worth a tap on a phone. Read off the live
      // menu, not from docs — `/clear` and `/rewind` carry agy's own aliases in that menu.
      agy: [
        { cmd: '/context', desc: 'Visualize context usage', common: true },
        { cmd: '/clear', desc: 'Clear conversation and start a new one', common: true, danger: true },
        { cmd: '/model', desc: 'Set a model', common: true },
        { cmd: '/effort', desc: 'Set the reasoning effort', common: true },
        { cmd: '/diff', desc: 'View uncommitted changes and per-turn diffs', common: true },
        { cmd: '/plan', desc: 'Plan carefully before executing', common: true },
        { cmd: '/usage', desc: 'View model quota usage', common: false },
        { cmd: '/rewind', desc: 'Rewind to a previous message', common: false, danger: true },
        { cmd: '/tasks', desc: 'View background tasks', common: false },
        { cmd: '/permissions', desc: 'Manage tool permissions', common: false },
        { cmd: '/copy', desc: 'Copy the last response', common: false },
        { cmd: '/help', desc: 'Show all commands and keybindings', common: false },
      ],
      pi: [
        { cmd: '/compact', desc: 'Compact context', common: true },
        { cmd: '/new', desc: 'Start new session', common: true, danger: true },
        { cmd: '/model', desc: 'Switch model', common: true },
        { cmd: '/session', desc: 'Show session info', common: true },
        { cmd: '/tree', desc: 'Jump to earlier point', common: true },
        { cmd: '/share', desc: 'Share session as gist', common: true },
        { cmd: '/copy', desc: 'Copy last response', common: false },
        { cmd: '/reload', desc: 'Reload extensions and skills', common: false },
      ],
      // kiro lists 40, read off its own `/help` menu on 2026-08-23. `/tools trust-all` first
      // because it is the one a remotely started kiro needs before it can run anything — the relay
      // sends it at start, and a person who started kiro by hand has no other way to reach it.
      kiro: [
        { cmd: '/tools trust-all', desc: 'Stop asking before every tool call', common: true },
        { cmd: '/compact', desc: 'Compact conversation history', common: true },
        { cmd: '/clear', desc: 'Clear conversation history', common: true, danger: true },
        { cmd: '/model', desc: 'Select or list available models', common: true },
        { cmd: '/effort', desc: 'Set thinking effort for this session', common: true },
        { cmd: '/context show', desc: 'Show context files and token usage', common: true },
        { cmd: '/plan', desc: 'Switch to the Plan agent', common: true },
        { cmd: '/rewind', desc: 'Rewind to a previous turn, forking the session', common: false, danger: true },
        { cmd: '/copy', desc: 'Copy last response to clipboard', common: false },
        { cmd: '/usage', desc: 'Show billing and usage information', common: false },
        { cmd: '/help', desc: 'Show available commands', common: false },
      ],
      opencode: [
        { cmd: '/compact', desc: 'Compact current session', common: true },
        { cmd: '/new', desc: 'Start new session', common: true, danger: true },
        { cmd: '/models', desc: 'List and switch models', common: true },
        { cmd: '/undo', desc: 'Undo last turn and revert', common: true, danger: true },
        { cmd: '/share', desc: 'Share session', common: true },
        { cmd: '/diff', desc: 'Show working changes', common: false },
        { cmd: '/export', desc: 'Export to Markdown', common: false },
      ],
    };

    function getAgentCommands() {
      const a = activeAgent();
      if (!a) return [];
      const key = (a.agent || '').toLowerCase();
      if (COMMANDS[key]) return COMMANDS[key];
      if (key.startsWith('claude')) return COMMANDS.claude;
      if (key.startsWith('codex')) return COMMANDS.codex;
      if (key.startsWith('agy')) return COMMANDS.agy;
      if (key.startsWith('kiro')) return COMMANDS.kiro;
      if (key.startsWith('pi')) return COMMANDS.pi;
      if (key.startsWith('opencode')) return COMMANDS.opencode;
      return COMMANDS.claude; // fallback
    }

    // One searchable sheet for all three lists — agent commands, agent prompts, terminal
    // commands. They are the same interaction (scan a short list, tap one), and the dock the last
    // two lived in spent half the screen on four buttons with nothing to search them by.
    const PALETTE_TITLES = { commands: 'Commands', prompts: 'Prompts', terminal: 'Commands' };
    let paletteMode = 'commands';

    // idx is the index into the array a row acts on, so the row can call the existing
    // insertShortcut / runShortcut / deleteShortcut unchanged.
    function paletteItems() {
      if (paletteMode === 'prompts')
        return promptChips().map(({s, i}) => ({ cmd: `@${s.at}`, desc: s.label, idx: i }));
      if (paletteMode === 'terminal')
        return termShortcuts.map((s, i) => ({ cmd: s.label, desc: s.text, idx: i, danger: s.danger }));
      return getAgentCommands();
    }

    function openPalette(mode) {
      paletteMode = mode;
      if (window.cue) cue('page');
      document.getElementById('paletteTitle').textContent = PALETTE_TITLES[mode];
      document.getElementById('cmdPalette').style.display = '';
      const search = document.getElementById('cmdSearch');
      search.value = '';
      search.placeholder = mode === 'prompts' ? 'Search prompts…' : 'Search commands…';
      filterCommands();
      // Not on a touch screen. Focusing the field summons the on-screen keyboard, and this sheet is
      // a short list someone opened in order to *tap* one row of — the search is for the rare long
      // one. The keyboard covered half of what they came to look at, to filter a list that mostly
      // shows every item it has. On a pointer device the focus costs nothing and saves a click.
      if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      search.focus();
    }

    // The composer's P / $ button: prompts over an agent, saved commands over a shell.
    function openShortcutPalette() { openPalette(isShell(activePane) ? 'terminal' : 'prompts'); }

    function closePalette() {
      document.getElementById('cmdPalette').style.display = 'none';
      disarmShortcut();
    }

    function paletteOpen() { return document.getElementById('cmdPalette').style.display !== 'none'; }

    // Arming, adding and deleting all change the list under the user's finger, and only matter
    // while the sheet is up.
    function refreshPalette() { if (paletteOpen()) filterCommands(); }

    function filterCommands() {
      const q = (document.getElementById('cmdSearch').value || '').toLowerCase();
      const items = paletteItems();
      // Only the built-in command lists have a "common" subset worth hiding behind a search —
      // prompts and saved commands are short lists the user wrote, so all of them show.
      const filtered = q
        ? items.filter(c => c.cmd.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q))
        : (paletteMode === 'commands' ? items.filter(c => c.common) : items);
      const el = document.getElementById('cmdList');
      const add = paletteMode === 'terminal'
        ? `<div role="button" tabindex="0" onclick="addShortcut()" onkeydown="if(event.key==='Enter')addShortcut()" style="padding:10px 12px;border-radius:8px;cursor:pointer;font-size:0.8rem;color:var(--muted)">+ Add command</div>`
        : '';
      if (!filtered.length) {
        el.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:0.8rem">Nothing matches</div>' + add;
        return;
      }
      el.innerHTML = filtered.map(c => {
        const armed = paletteMode === 'terminal' && shortcutArmed === c.idx;
        const act = paletteMode === 'commands' ? `runCommand('${c.cmd}')`
          : paletteMode === 'prompts' ? `insertShortcut(${c.idx})`
            : `runShortcut(${c.idx})`;
        const del = paletteMode === 'terminal'
          ? `<button class="palette-del arm-btn" aria-label="Delete ${escapeHtml(c.cmd)}"
        onclick="event.stopPropagation();armButton(this, 'Delete?', () => deleteShortcut(${c.idx}))">✕</button>` : '';
        return `<div role="button" tabindex="0" onclick="${act}" onkeydown="if(event.key==='Enter')${act}" style="padding:10px 12px;border-radius:8px;cursor:pointer;display:flex;align-items:center;gap:8px;margin-bottom:2px;transition:background 0.15s" onmouseover="this.style.background='var(--border)'" onmouseout="this.style.background=''">
    <span style="font-family:monospace;font-weight:600;font-size:0.85rem;${c.danger ? 'color:var(--red)' : 'color:var(--blue)'}">${escapeHtml(armed ? `Run ${c.cmd}?` : c.cmd)}</span>
    <span style="flex:1;font-size:0.75rem;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.desc)}</span>${del}
  </div>`;
      }).join('') + add;
    }

    function runCommand(cmd) {
      closePalette();
      if (!ws || !activePane) return;
      submitText(activePane, cmd);
      setTimeout(refreshPane, 500);
    }
