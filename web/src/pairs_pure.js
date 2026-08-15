    // --- P3 pair logic (pure) --- start
    // Pure, dependency-free, and extracted verbatim by tests/test_pairs.js. Keep it that way:
    // anything here that touches the DOM, ws, or localStorage breaks the tests silently.
    const PAIRS_KEY = 'herdr_pairs';
    const PAIRS_VERSION = 1;
    const MAX_PAIRS = 32;
    // The relay's cap on one `send_text` message, and no longer a cap on what may be sent: text
    // past it is split into this many characters at a time and typed into the same composer, then
    // submitted by the single `send_keys ['Enter']` that follows. Restated here rather than asked
    // for because the relay does not offer it — and it is the *oldest* relay's number, which is
    // what makes a client-side split work against a relay this app did not ship with.
    const SEND_TEXT_MAX = 4000;

    // Text too long for one message, split into messages that are not. Line boundaries where there
    // are any: a chunk boundary is invisible to the agent — it is one composer either way — but the
    // relay's audit log records one line per message, and a log that cuts a diff mid-hunk is harder
    // to read afterwards than one that does not.
    //
    // The newline stays with the line it ends, so the chunks concatenate back to exactly the input.
    function chunkText(text, max) {
      const cap = max || SEND_TEXT_MAX;
      const s = String(text == null ? '' : text);
      if (s.length <= cap) return s ? [s] : [];
      const out = [];
      let buf = '';
      const flush = () => { if (buf) { out.push(buf); buf = ''; } };
      const lines = s.split('\n').map((l, i, all) => i < all.length - 1 ? l + '\n' : l);
      for (let line of lines) {
        // One line longer than the cap has no boundary to break on, so it is cut. Never through a
        // surrogate pair: half an emoji is a byte sequence the agent receives as a replacement
        // character, and the two halves never rejoin.
        while (line.length > cap) {
          flush();
          const lead = line.charCodeAt(cap - 1);
          const n = lead >= 0xD800 && lead <= 0xDBFF ? cap - 1 : cap;
          out.push(line.slice(0, n));
          line = line.slice(n);
        }
        if (!line) continue;
        if (buf.length + line.length > cap) flush();
        buf += line;
      }
      flush();
      return out;
    }

    const SHORTCUTS = [
      { label: 'Review', text: 'Review, edit, fix; then propose next steps.' },
      { label: 'Implement', text: 'Proceed to implement.' },
      { label: 'Architect prompt', text: '/ponytail\n/caveman\n@.agent/prompts/System_Prompt_2_Architect.md\n' },
    ];

    // The terminal half of the same idea, and the opposite verb: an agent prompt is inserted into
    // the composer to be read before it is sent, a terminal command is the thing being sent.
    const TERM_KEY = 'herdr_term_shortcuts';
    const TERM_VERSION = 1;
    const MAX_TERM_SHORTCUTS = 24;

    // Read-only, every one of them. Nothing that writes ships as a default — a destructive
    // command in a grid the user did not choose is one mis-tap from a bad afternoon.
    const DEFAULT_TERM_SHORTCUTS = [
      { label: 'ls', text: 'ls -la' },
      { label: 'git status', text: 'git status' },
      { label: 'git log', text: 'git log --oneline -10' },
      { label: 'pwd', text: 'pwd' },
    ];

    // Same contract as parsePairs, with one distinction the caller makes rather than this
    // function: a *corrupt* blob loads as nothing, because replacing what someone wrote is worse
    // than showing them an empty grid, while an *absent* key seeds the defaults.
    function parseTermShortcuts(raw) {
      let data;
      try { data = JSON.parse(raw); } catch (e) { return []; }
      if (!data || data.version !== TERM_VERSION || !Array.isArray(data.items)) return [];
      return data.items
        .filter(s => s && typeof s.label === 'string' && s.label &&
          typeof s.text === 'string' && s.text && s.text.length <= SEND_TEXT_MAX)
        .slice(0, MAX_TERM_SHORTCUTS)
        .map(s => ({ label: s.label, text: s.text, danger: !!s.danger }));
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    // codex invokes its prompts with $; every other agent uses /. Only a line-leading slash is
    // rewritten, so a path or URL inside the shortcut text is left alone. Keyed off the pane the
    // text is going into, not the one it came from.
    function agentSlash(text, agent) {
      return agent === 'codex' ? text.replace(/^\//gm, '$') : text;
    }

    // A corrupt blob must not brick the terminal view — it loads as no pairs at all.
    function parsePairs(raw) {
      let data;
      try { data = JSON.parse(raw); } catch (e) { return []; }
      if (!data || data.version !== PAIRS_VERSION || !Array.isArray(data.pairs)) return [];
      return data.pairs.filter(p => p && typeof p.id === 'string' && Array.isArray(p.members) &&
        p.members.length === 2 && p.members.every(m => m && m.pane_id));
    }

    function newPairId() {
      // Not crypto.randomUUID(): it is undefined in a non-secure context, and the relay serves
      // this page over plain HTTP on a LAN address. Uniqueness among <=32 local entries is enough.
      return 'p_' + Math.random().toString(36).slice(2, 10);
    }

    // All four fields, because herdr reuses a pane_id after a pane closes. A matching pane_id
    // with a different cwd is a different session, and pasting into it is the worst failure here.
    function memberMatches(m, a) {
      return a.pane_id === m.pane_id && (a.host || 'local') === (m.host || 'local') &&
        a.agent === m.agent && (a.cwd || '') === (m.cwd || '');
    }

    function recentFingerprint(a) {
      return { pane_id: a.pane_id, host: a.host || 'local', agent: a.agent, cwd: a.cwd || '' };
    }

    function pairHealth(pair, list) {
      for (const m of pair.members) {
        if (list.filter(a => a.pane_id === m.pane_id).length > 1)
          return { state: 'stale', reason: `${m.pane_id} is reported by more than one host` };
        if (!list.some(a => memberMatches(m, a)))
          return { state: 'stale', reason: `${m.role || m.agent} (${m.pane_id}) is no longer running` };
      }
      return { state: 'healthy', reason: '' };
    }

    function pairFor(list, paneId) {
      return list.find(p => p.members.some(m => m.pane_id === paneId)) || null;
    }

    function memberOf(pair, paneId) { return pair.members.find(m => m.pane_id === paneId); }
    function partnerOf(pair, paneId) { return pair.members.find(m => m.pane_id !== paneId); }

    // Same host only: a bare pane_id cannot be routed unambiguously across hosts.
    function pairCandidates(list, source) {
      return list.filter(a => a.pane_id !== source.pane_id &&
        (a.host || 'local') === (source.host || 'local'));
    }

    // `from` is the source's display name — the pane label P2 assigns ("Architect 1", "Reviewer 2"),
    // editable in the pair sheet. The agent name is deliberately not repeated: the receiving agent
    // is being told which colleague the text came from, not which tool produced it.
    //
    // No fence. Removed at the user's direction, knowingly: it was the receiving agent's only
    // boundary marker for the quoted region, so a transferred line like "Proceed to implement."
    // now reads the same as an instruction the user typed. The remaining containment is the human
    // one — the user selects the text and reads the prefilled composer before sending.
    function composeTransfer(instruction, from, text) {
      if (!text) return { error: 'Select some text in the pane first' };
      // No length check. A transferred selection is code or a diff and is routinely past one
      // message's worth; the composer splits it (`chunkText`) rather than refusing it, and telling
      // someone to "select less" was never advice about their work — it was the wire's limit
      // wearing the shape of an editorial one.
      return { text: (instruction ? instruction + '\n\n' : '') + `feedback from ${from}:\n${text}` };
    }

    // A ruler selection is a pair of line indices, and `pane read` returns the *last* N lines —
    // so anything the agent prints shifts every index up, and loading more scrollback shifts them
    // down. The selection therefore follows its own text, not its position.
    //
    // Returns the new [a, b], or null when the block is gone — at which point the selection is
    // gone too, which is the honest answer. A block that repeats verbatim resolves to the first
    // match; distinguishing them would need an anchor the pane does not give us.
    function reanchorSel(text, selText, a, b) {
      if (!selText) return null;
      const rows = text.split('\n');
      if (rows.slice(a, b + 1).join('\n') === selText) return [a, b];
      // Whole lines only. A mid-line match, or one that stops short of the line's end, is a
      // different selection that happens to share characters.
      const whole = (i) => (i === 0 || text[i - 1] === '\n') &&
        (i + selText.length === text.length || text[i + selText.length] === '\n');
      let at = text.indexOf(selText);
      while (at >= 0 && !whole(at)) at = text.indexOf(selText, at + 1);
      if (at < 0) return null;
      const start = text.slice(0, at).split('\n').length - 1;
      return [start, start + selText.split('\n').length - 1];
    }

    // Back/forward over the visited-pane list. Split out here because the branch that matters is
    // the skipping: a session ends, and herdr can hand its pane_id to something else, so every
    // candidate has to be checked against the live snapshot before it is offered.
    //
    // Returns the index to move to, or -1 when there is nothing that way.
    function navStep(history, index, step, isLive, current) {
      for (let i = index + step; i >= 0 && i < history.length; i += step) {
        if (history[i] !== current && isLive(history[i])) return i;
      }
      return -1;
    }

    // Visiting a pane truncates anything ahead of the cursor, so going back and then opening
    // something else never leaves a forward branch nobody can reach. Returns the new list.
    function navPush(history, index, paneId, max) {
      if (history[index] === paneId) return history.slice();
      return history.slice(0, index + 1).concat([paneId]).slice(-max);
    }
    // What Enter means in the composer. Ctrl/Cmd+Enter always sends; over a terminal the user can
    // opt into a bare Enter sending too, because a shell line ends at Enter and typing a command
    // then reaching for a modifier is the wrong shape. Shift+Enter still writes a newline.
    function enterAction(e, opts) {
      if (e.key !== 'Enter') return 'none';
      if (e.metaKey || e.ctrlKey) return 'send';
      if (!e.shiftKey && opts.enterSends && opts.shell) return 'send';
      return 'newline';
    }
    // A physical Ctrl+<letter> typed in the composer, over a terminal, aimed at the shell rather
    // than at the text box. The browser owns Ctrl+C, Ctrl+X and Ctrl+Z whenever there is something
    // to copy, cut or undo, so the pane is only handed the chord while the composer is empty —
    // which is exactly when the user means the shell. Cmd and Alt are never claimed: ⌘C is copy on
    // macOS, and Alt belongs to the keyboard. Returns the key to send, or null to leave it alone.
    function ctrlChord(e, opts) {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
      if (!opts.shell || !opts.empty) return null;
      const k = 'ctrl+' + (e.key || '').toLowerCase();
      return opts.allowed.includes(k) ? k : null;
    }
    // --- P3 pair logic (pure) --- end
