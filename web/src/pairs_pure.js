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

    // The mark an agent is shown by, drawn as an inline SVG with bright pink color.
    // Drawn rather than typed to ensure identical crisp rendering across platforms without emoji
    // font differences.
    function agentGlyph() {
      return '<svg class="agent-glyph" viewBox="0 0 24 24" width="1em" height="1em" fill="none" ' +
        'stroke="var(--pink, #ff2d87)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
        'aria-hidden="true" style="color:var(--pink, #ff2d87);"><rect x="3" y="7" width="18" height="14" rx="2"/>' +
        '<path d="M12 3v4"/><circle cx="8.5" cy="13.5" r="1" fill="var(--pink, #ff2d87)"/>' +
        '<circle cx="15.5" cy="13.5" r="1" fill="var(--pink, #ff2d87)"/><path d="M8.5 17.5h7"/></svg>';
    }

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

    // Two sigils, and the app draws no third: `@` is a prompt — text that gets typed at an agent —
    // and `#` is a role, which is what a session *is*. A reader who has learned one of them has
    // learned both, and every list that draws either wears it: the composer chips, the palette,
    // the transfer sheet, a launcher member's starter, and the role badges in both start dialogs.
    //
    // `at` is the chip's name in the thread — `@review`, `@test` — and the label is its name
    // everywhere else. Two fields rather than one derived from the other: a label is prose and can
    // be renamed without silently renaming the control the user has learned to tap.
    const SHORTCUTS = [
      { at: 'review-fix', label: 'Review, edit & fix', text: 'Review, edit, fix; then propose next steps.' },
      { at: 'review-only', label: 'Review only', text: 'Review only. Dont edit/ change code; then propose next steps.' },
      { at: 'implement', label: 'Implement', text: 'Proceed to implement.' },
      { at: 'test', label: 'Test',
        text: 'Write /update tests this needs, run them, and report what actually failed.' },
      { at: 'test-min', label: 'Test, minimally',
        text: 'Dont rerun passing tests. Dont run full test suite. Only tests relevant to code ' +
          'changes you make or essential for you.' },
      { at: 'no-test', label: 'No tests, just finish',
        text: 'Dont test, just finish implementation.' },
      { at: 'status-now', label: 'Status of what was asked',
        text: 'At the end also list out the features requested with brief status of each.' },
      // The four a session can be *started* as. `-prompt` and not a bare name because they are the
      // only chips that are also an opening instruction, and a reader tapping `@architect-prompt`
      // into a running conversation should be able to see that it is the same thing the Start
      // sheet offers as `@architect`.
      //
      // Three of them have nothing written under them yet. They are listed anyway: the badge exists
      // so a session can be started as a Reviewer today, and the day someone writes the text every
      // tile and every record naming it opens with it, with no migration. `promptChips` is what
      // keeps them out of the composer until then — a chip that types nothing is a dead control.
      { at: 'architect-prompt', label: 'Architect prompt', text: '/ponytail\n/caveman\n@.agent/prompts/System_Prompt_2_Architect.md\n' },
      { at: 'reviewer-prompt', label: 'Reviewer prompt', text: '' },
      { at: 'implementer-prompt', label: 'Implementer prompt', text: '' },
      { at: 'arbitrator-prompt', label: 'Arbitrator prompt', text: '' },
    ];

    // The chips worth showing in a composer, a palette or a transfer sheet: the ones with something
    // to type. Carries each one's index, because every one of those lists acts on the index and a
    // filtered copy would renumber them.
    function promptChips() {
      return SHORTCUTS.map((s, i) => ({s: s, i: i})).filter(x => x.s.text);
    }

    // A starter recorded before the four carried their suffix — `architect` for `architect-prompt`.
    // One line rather than a migration: those names are on disk in conversations, in launcher tiles,
    // in localStorage and in whatever another browser on older code writes next, and a rename that
    // has to reach all four is a rename that will miss one.
    function canonAt(at) {
      if (!at || SHORTCUTS.some(s => s.at === at)) return at || '';
      return SHORTCUTS.some(s => s.at === at + '-prompt') ? at + '-prompt' : at;
    }

    // What a session is started as, and the start dialogs ask it as a *prompt* — the badges are
    // `@architect`, not `# Architect`. That is the whole of it as far as the user is concerned: the
    // opening instruction is the choice, and everything else here is bookkeeping under it.
    //
    // `role` is that bookkeeping. It goes on the wire, the relay knows only its own three, and the
    // rest ride on `agent` and carry their name as the pane's label instead — which is why a pane
    // started as an Arbitrator is still called "Arbitrator" and not "Agent 1". A role is a thing the
    // user names in only one place, the arbitrator's own setup, where `#` marks it.
    //
    // Orchestrator is gone and Implementer is here: the four are the ways of working this project
    // actually has. A record still naming the old one resolves to no prompt, which is what it always
    // had.
    const START_ROLES = [
      { name: 'Architect', role: 'architect', at: 'architect-prompt' },
      { name: 'Reviewer', role: 'reviewer', at: 'reviewer-prompt' },
      { name: 'Implementer', role: 'agent', at: 'implementer-prompt' },
      { name: 'Arbitrator', role: 'agent', at: 'arbitrator-prompt' },
    ];

    // The badge's own text: the prompt without its suffix, which is what the picker is asking. The
    // suffix is for the composer, where these sit beside `@test` and `@review-fix` and need to say
    // they are the opening kind.
    function startRoleTag(r) {
      return '@' + String((r || {}).at || '').replace(/-prompt$/, '');
    }

    // What a session is started as when nobody has said otherwise. The first badge is Architect
    // and this is that name written down, because "the first one" is an accident of order and this
    // is a decision: a session is better started as something.
    const START_DEFAULT_AT = 'architect-prompt';

    // And what a session *deliberately* started bare records instead of nothing. Empty is also what
    // a record written before any of this existed says, and the two have to be told apart: one is a
    // session that asked for no opening prompt, the other is one nobody ever asked. Not a name in
    // SHORTCUTS, so everything that resolves an `at` already answers nothing for it.
    const NO_STARTER = 'none';

    // The opening text a role badge carries, or '' while its prompt is still to be written.
    function roleStarter(r) {
      return ((SHORTCUTS.find(s => s.at === canonAt((r || {}).at)) || {}).text || '').trim();
    }

    // `at` is the badge's name on disk as well as in SHORTCUTS: a conversation records which role a
    // session was started as so a respawn can start as the same one, and a name is the one part of
    // this list that will still mean something after the list has been reordered.
    function startRoleOf(at) {
      return START_ROLES.find(r => r.at === canonAt(at)) || null;
    }

    // The badge a live pane was started as, read back off its label — every started pane is named
    // for its role ("Architect 1", "Arbitrator"), by the relay or by the dialog. A pane renamed
    // since matches nothing, which is right: what it is called is all there is left to go on.
    function startRoleFromLabel(label) {
      return startRoleOf(String(label || '').trim().split(/\s+/)[0].toLowerCase());
    }

    // The terminal half of the same idea, and the opposite verb: an agent prompt is inserted into
    // the composer to be read before it is sent, a terminal command is the thing being sent.
    const TERM_KEY = 'herdr_term_shortcuts';
    const TERM_VERSION = 1;
    const MAX_TERM_SHORTCUTS = 24;

    // Read-only, every one of them. Nothing that writes ships as a default — a destructive
    // command in a grid the user did not choose is one mis-tap from a bad afternoon. `RPROMPT=`
    // is the one that changes anything, and what it changes is a variable in the shell's own
    // session: it is the relay's HERDR_TERMINAL_INIT by hand, for a terminal the app did not open
    // or a relay too old to send it.
    const DEFAULT_TERM_SHORTCUTS = [
      { label: 'tidy prompt', text: 'RPROMPT=; clear' },
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

    // --- What was typed at a terminal, kept so it can be typed again ---
    //
    // Not the shortcuts above and not a second copy of them: a shortcut is a command the user
    // decided was worth keeping, this is every command they ran. Ten of them, most recent last,
    // because a terminal is read bottom-up and the newest thing is the one being repeated.
    const TERM_HIST_KEY = 'herdr_term_history';
    const TERM_HIST_VERSION = 1;
    const MAX_TERM_HISTORY = 10;

    // Same contract as parseTermShortcuts: a corrupt or foreign-version blob loads as nothing.
    // Plain strings rather than objects — there is nothing to say about a history entry except
    // what it was.
    function parseTermHistory(raw) {
      let data;
      try { data = JSON.parse(raw); } catch (e) { return []; }
      if (!data || data.version !== TERM_HIST_VERSION || !Array.isArray(data.items)) return [];
      return data.items
        .filter(t => typeof t === 'string' && t && t.length <= SEND_TEXT_MAX)
        .slice(-MAX_TERM_HISTORY);
    }

    // One entry in, oldest out. Unique by exact text: a command run twice is one thing the user
    // does repeatedly, and two rows of it in a ten-row list is one row of history lost. The repeat
    // moves to the end rather than staying where it was — the list is ordered by when it was last
    // useful, not by when it was first seen.
    function pushTermHistory(items, text) {
      const t = String(text || '').trim();
      if (!t || t.length > SEND_TEXT_MAX) return items;
      // Multi-line pastes are not commands and read as one unreadable row in a list this narrow.
      if (/[\r\n]/.test(t)) return items;
      return items.filter(x => x !== t).concat(t).slice(-MAX_TERM_HISTORY);
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

    // What the composer holds that is an instruction rather than a message, split off the front.
    //
    // A filled @ prompt is ordinary text in the box — being readable and editable is the whole
    // point of filling it in — so at the send there is nothing marking it as anything but typing,
    // and it went out *under* the quoted bubbles: the instruction framing the quote, printed after
    // it. Recognised here instead, by what it says: text that still matches a shortcut verbatim is
    // the app's own sentence and is lifted above the quote. Edited even slightly, it stops matching
    // and travels as the message, which is the honest reading — it is the user's sentence now.
    //
    // Only at the front, and only whole: an instruction under a paragraph is being quoted or
    // answered, not issued.
    //
    // Returns [lead, note].
    function peelDockLead(text, agent) {
      const known = SHORTCUTS.map(s => agentSlash(s.text, agent).trim()).filter(Boolean)
        // Longest first, so an instruction that begins with another is matched whole.
        .sort((a, b) => b.length - a.length);
      const lead = [];
      let rest = text.trim();
      for (;;) {
        const hit = known.find(t => rest === t || rest.startsWith(t + '\n'));
        if (!hit) break;
        lead.push(hit);
        rest = rest.slice(hit.length).replace(/^\n+/, '');
      }
      return [lead.join('\n'), rest];
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
