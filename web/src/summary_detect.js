    // --- Final message detection ---
    // A finished pane is mostly tool output — command runs, diffs, test logs — with the agent's
    // closing message a handful of lines at the end of it. Both harnesses already separate the
    // two in column 0: every block opens on a speaker glyph, and a tool call hangs its results
    // off a second one. So a block is an execution exactly when a result glyph appears under it,
    // and the closing message is the last block where none does.
    //
    // That reads one character per line and never a word of the content, which is what keeps the
    // whole feature in the browser — nothing stored, nothing asked of the relay, no second
    // opinion from a model about text a model just wrote.
    //
    // Headings were the obvious idea and are the wrong one. Neither sampled pane had one: Claude
    // closed with "Sound half committed on main as dd51cea", Codex with "S2b review clean."
    //
    // Profiles are literal and only cover harnesses whose panes have actually been read. An
    // unknown harness gets no suggestion rather than a guess — a user's selection could hint at
    // the speaker glyph, but never at the result gutter, which sits outside the block they
    // selected. tests/fixtures/pane_*_done.txt are those reads, so a harness that changes its
    // glyphs breaks a test rather than a user.
    //
    // `indent` is which column the gutter lives in. pi has none of its own — its glyphs come from
    // the herdr-gutter extension in extensions/pi, and pi indents its whole transcript by one
    // space, so they land in column 1. `ends` are glyphs that close the block above them without
    // making it a tool execution: pi's reasoning marker is not something the agent said, but it is
    // where a message stops.
    //
    // `composer: false` says the prompt gutter marks sent messages only. claude and codex draw the
    // composer with the same glyph, so it sits at the foot of every live pane and the closing
    // message is the block above it. pi's composer is a box the extension cannot reach, so pi's
    // last `›` is the newest request and the reply to it is *below*.
    // `tool` names a block that ran something by its *header* rather than by the result glyph
    // under it. The glyph is the rule and stays the rule; this is for the case where it is not on
    // screen. Claude collapses a tool result it has scrolled past — the `⎿ Added 7 lines` line
    // simply is not in the read — and what is left is `⏺ Update(web/index.html)` with a raw diff
    // hanging off it, which by shape alone is a block the agent spoke. It was already possible
    // before the recorder kept every message; it is merely much easier to hit now.
    //
    // Deliberately a shape and not a word: every word of the name capitalized, `(` immediately
    // after it with no space, and an argument starting straight away. No list of tool names to
    // keep current, and nothing that reads the arguments.
    //
    // Both halves are load-bearing, and a looser first cut proved it by eating three real closing
    // messages — "Merged into main (1f9690b), clean auto-merge" is a sentence whose parenthetical
    // is the only thing it shares with `Update(web/index.html)`. The space in front of the bracket
    // is what a sentence has and a call does not; the capitals are what `Web Search(` needs and
    // "Merged into main" fails on.
    const CLAUDE_TOOL = /^[A-Z][A-Za-z0-9_-]*(?: [A-Z][A-Za-z0-9_-]*){0,3}\(\S/;
    const GUTTERS = {
      claude: { speaker: '⏺', result: ['⎿'], user: ['❯', '>'], tool: CLAUDE_TOOL },
      codex: { speaker: '•', result: ['└', '│'], user: ['›'] },
      pi: { speaker: '⏺', result: ['$'], user: ['›'], ends: ['⋯'], indent: 1, composer: false },
      // OpenCode puts the user's messages, every tool block and the composer itself behind one
      // `┃`, and prints nothing at all in column 0 — so it has no speaker glyph, no result glyph
      // and no block starts. `messages: false` says so: Summary and the ↓↑ pill are switched off
      // rather than left to find nothing, because its reasoning and its answer are both plain
      // prose at the same indent with no boundary between them. The blue user rule is the one
      // thing that can be got right here, and it is worth getting right: the pane is a wall of
      // `┃` and the rule is what shows where your own questions were.
      //
      // Which `┃` is yours is a question about the whole run, not the line. A run holding a `$`
      // is a command and everything under it is that command's output; a run closed by `╹` is
      // the composer box at the foot; and a run reaching the top of what was read was cut off
      // mid-block, so its opener is not here to check. Each of those was read as user input by
      // the line-at-a-time version, on a real pane.
      opencode: {
        speaker: null, result: [], messages: false, endLine: /^\s*Thought:/,
        userLine: (row, rows, i) => {
          if (!/^\s*┃\s+\S/.test(row || '') || /^\s*┃\s+\$/.test(row)) return false;
          if (!rows) return false;
          const bar = r => /^\s*┃/.test(r || '');
          let j = i - 1;
          for (; j >= 0 && bar(rows[j]); j--) if (/^\s*┃\s+\$/.test(rows[j])) return false;
          if (j < 0) return false;    // run cut off by the top of the read
          let k = i + 1;
          while (k < rows.length && bar(rows[k])) k++;
          return !/^\s*╹/.test(rows[k] || '');
        },
      },
      // agy marks the user, its tool calls, its reasoning and its turn rules in column 0, and its
      // own reply not at all: that is plain prose two columns in. `speaker: null` is what makes a
      // block start positional rather than a glyph match, and `opens` says which column-0 lines a
      // message may follow. `result` is empty because a column-0 tool call is already an end.
      agy: { speaker: null, result: [], user: ['>'], opens: ['>', '●', '▸', '─'], chrome: '>' },
    };

    // The character in a harness's gutter column, which is column 0 everywhere but pi.
    function gutterOf(row, g) { return (row || '')[g.indent || 0]; }

    // How far above the bottom of a read the live composer may be found. The footer is a rule, an
    // empty input line, one or two blanks and a status bar; ten rows covers that and stops a
    // genuinely empty prompt in the middle of a transcript from cutting the window in half.
    const CHROME_ROWS = 10;

    // The rows above and including the live composer — the transcript, without the pane's own
    // footer. agy right-aligns a model and credit line under a rule at the foot of the pane, and a
    // positional harness reads any indented line under a column-0 line as the start of a message,
    // so its own chrome was read as its closing words.
    //
    // The *empty* composer only: a `>` with text after it is a prompt in the transcript and cannot
    // be told from the live one by shape. Inclusive of that line, because it is the anchor
    // findFinalMessage reads back from, and trimmed from the end so every index into the result is
    // still an index into the pane. Ported from `transcript` in relay/pane_summary.py.
    function transcriptRows(rows, g) {
      const mark = (g || {}).chrome;
      if (!mark || !rows || !rows.length) return rows;
      for (let j = rows.length - 1; j >= 0 && j > rows.length - 1 - CHROME_ROWS; j--) {
        if ((rows[j] || '').replace(/\s+$/, '') === mark) return rows.slice(0, j + 1);
      }
      return rows;
    }

    // Does this row close the block above it? Anything in column 0 does — the next glyph, the turn
    // footer, a rule, the prompt.
    //
    // An indented harness needs the second clause, and only an indented harness has it. claude and
    // codex hang-indent a wrapped line past their gutter, so column 0 alone separates a
    // continuation from a marker. pi does not: its continuation lines sit in the same column its
    // glyphs do, and the glyph set is the only thing telling them apart. Applying that rule to
    // claude would cut a block at the first wrapped line beginning with `⏺`.
    function endsBlock(row, g) {
      if (g.endLine && g.endLine.test(row || '')) return true;
      if (/^\S/.test(row || '')) return true;
      if (!g.indent) return false;
      const ch = gutterOf(row, g);
      return ch === g.speaker || (g.user || []).includes(ch) ||
        g.result.includes(ch) || (g.ends || []).includes(ch);
    }

    // A harness the user taught by selecting one of its messages. The first character of the line
    // they started on is its speaker glyph — the one thing a selection can reveal. It cannot
    // reveal the result glyph, which by definition sits in the tool blocks they did *not* select,
    // so a learned profile carries no result list. It supports explicit trim learning only;
    // Summary and message navigation require a complete shipped profile. With no result glyph it
    // cannot tell a command from a sentence, and a wrong tool-output selection is worse than no shortcut.
    const GUTTER_KEY = 'herdr_gutters', GUTTER_VERSION = 1;

    // Memoized: profileFor sits under drawSel, which runs on every scroll event, and parsing JSON
    // out of localStorage at that rate is a cost for nothing. Only learnGutter writes it.
    let gutterCache = null;

    function loadGutters() {
      if (gutterCache) return gutterCache;
      try {
        const d = JSON.parse(localStorage.getItem(GUTTER_KEY) || '');
        gutterCache = d && d.version === GUTTER_VERSION && d.byAgent ? d.byAgent : {};
      } catch (e) { gutterCache = {}; }
      return gutterCache;
    }

    function profileFor(agent) {
      if (GUTTERS[agent]) return GUTTERS[agent];
      const ch = loadGutters()[agent];
      return ch ? { speaker: ch, result: [] } : null;
    }

    // How far a block starting on `start` runs, or null when it turns out to be a tool execution.
    //
    // It ends at the next line with anything at all in column 0 — the next glyph, the turn footer,
    // a rule, the prompt. Blank lines stay inside it: Codex closes with three paragraphs, and
    // ending on the first blank would take only the last one.
    function blockSpan(rows, g, start) {
      // The header says it ran something, whether or not its result is still on screen.
      if (g.tool && g.tool.test(((rows[start] || '').slice(g.indent || 0).replace(/^\S\s*/, ''))))
        return null;
      let end = start;
      // A result glyph hangs *directly* under the call that produced it — the call line, its
      // wrapped remainder, then the output. Nothing separates them, so a glyph found past the
      // block's first blank line is not one: it is prose that happens to start a wrapped line with
      // the character, which is what an agent writing about a terminal does constantly. That cost
      // a whole message: a summary quoting `⎿` was read as a tool execution and never shown.
      //
      // Not on an indented harness. There a result glyph *is* an end (`endsBlock`), so it is read
      // in its own column rather than at the start of a wrapped line, and pi does put a blank line
      // between a reply and the command under it — the one case this rule would get backwards.
      let gap = false;
      for (let j = start + 1; j < rows.length; j++) {
        const line = (rows[j] || '').trimStart();
        // A result glyph means this block ran something rather than said something. Tested before
        // the end check, because on an indented harness a result glyph is itself an end.
        if (line && (!gap || g.indent) && g.result.includes(line[0])) return null;
        if (endsBlock(rows[j], g)) break;
        if (line) end = j;
        else gap = true;
      }
      return [start, end];
    }

    // Does a block start here? On every harness but agy that is one character in the gutter. agy
    // has no speaker glyph, so its answer is positional: the first indented line under a column-0
    // line that agy itself printed. `opens` is that last clause and it is load-bearing — without
    // it the shell command line that launched agy opens a block and its startup banner is read as
    // the pane's first message.
    //
    // The column-0 line above is not always the marker, though: agy wraps its own tool-call lines
    // and the continuation lands back in column 0 with no glyph on it —
    //
    //     ● Bash(git commit -m "Refactor frontend JS into functional...) (ctrl+o to
    //     expand)
    //
    // — so the run of column-0 lines is walked back to the marker that opened it. Checking only
    // the nearest one dropped every message agy wrapped a tool call above, including the closing
    // one, which is the message the whole feature exists to find.
    //
    // The prompt gutter wraps too, and its continuation is indented rather than column-0, which
    // makes it indistinguishable from a reply by shape alone. A blank line is what tells them
    // apart: agy answers a prompt through a tool call or a thought, never off the next row, so an
    // indented line touching a `>` is the rest of what the user typed. Without this the second
    // line of every multi-line prompt is read as an agent message and taken out of the blue rule.
    function startsBlock(rows, g, i) {
      const row = rows[i] || '';
      if (g.speaker) return gutterOf(row, g) === g.speaker;
      if (!row.trim() || /^\S/.test(row)) return false;
      for (let j = i - 1; j >= 0; j--) {
        const above = rows[j] || '';
        if (!above.trim()) continue;
        if (!g.opens) return /^\S/.test(above);
        const gap = j < i - 1;
        for (let k = j; k >= 0; k--) {
          const line = rows[k] || '';
          if (!line.trim() || !/^\S/.test(line)) return false;
          if (g.opens.includes(line[0])) return gap || !(g.user || []).includes(line[0]);
        }
        return false;
      }
      return false;     // nothing above it, so nothing opened it
    }

    function isUserInput(row, agent, rows, i) {
      const g = profileFor(agent);
      return !!g && ((g.userLine && g.userLine(row, rows, i)) ||
        (!!g.user && g.user.includes(gutterOf(row, g))));
    }

    function lastUserInput(rows, agent) {
      for (let i = (rows || []).length - 1; i >= 0; i--) {
        if (isUserInput(rows[i], agent, rows, i)) return i;
      }
      return -1;
    }

    // A user turn is its gutter plus every continuation line until the next agent utterance.
    // That is the one contiguous region that should be visually distinct in the terminal.
    //
    // "Agent utterance" has to include reasoning, which on pi sits between the prompt and the
    // reply. Left out, the blue rule would run down the agent's thinking as though the user had
    // typed it — which is why the extension marks thinking at all.
    function userInputLines(rows, agent) {
      const g = profileFor(agent), lines = new Set();
      if (!g || !rows) return lines;
      rows = transcriptRows(rows, g);
      let inTurn = false, pending = [];
      rows.forEach((row, i) => {
        if (isUserInput(row, agent, rows, i)) { inTurn = true; pending = []; }
        // The agent's reply ends the turn as surely as its glyph would. On agy that reply carries
        // no glyph and is not in column 0, so without this the blue rule runs on into it.
        else if (endsBlock(row, g) || startsBlock(rows, g, i)) inTurn = false;
        if (!inTurn) return;
        // A blank line inside the turn is part of it only if more of the turn follows. Trailing
        // blanks are the gap before the agent answers, and a rule running down empty rows reads
        // as the turn never ending.
        if ((row || '').trim()) { pending.forEach(j => lines.add(j)); pending = []; lines.add(i); }
        else pending.push(i);
      });
      return lines;
    }

    // The last block above the latest user prompt, and null if it ran a tool. A `>` line closes
    // the completed turn the user is about to transfer; without one this remains the last block
    // in the pane. Deliberately not "the last block that didn't": an agent that stopped after a
    // command has no closing message, and walking further up would offer something it said before
    // doing work it has not reported on.
    function findFinalMessage(rows, agent) {
      const g = profileFor(agent);
      if (!g || !rows || !rows.length) return null;
      rows = transcriptRows(rows, g);
      const lastInput = g.composer === false ? -1 : lastUserInput(rows, agent);
      const before = lastInput < 0 ? rows.length : lastInput;
      for (let i = before - 1; i >= 0; i--) {
        if (startsBlock(rows, g, i)) return blockSpan(rows, g, i);
      }
      return null;
    }

    // Stepping between messages, which is a different question: here tool blocks are passed over
    // rather than stopped on, because the user is walking the conversation and a command is not
    // part of it. `before` and `after` are line indices, exclusive and inclusive respectively, so
    // a returned range's own start feeds straight back in to get the next one.
    function blockBefore(rows, agent, before) {
      const g = profileFor(agent);
      if (!g || !rows) return null;
      for (let i = Math.min(before, rows.length) - 1; i >= 0; i--) {
        if (!startsBlock(rows, g, i)) continue;
        const at = blockSpan(rows, g, i);
        if (at) return at;
      }
      return null;
    }

    function blockAfter(rows, agent, after) {
      const g = profileFor(agent);
      if (!g || !rows) return null;
      for (let i = Math.max(0, after); i < rows.length; i++) {
        if (!startsBlock(rows, g, i)) continue;
        const at = blockSpan(rows, g, i);
        if (at) return at;
      }
      return null;
    }

    // One range per turn: the agent's closing message, which is the last thing it said before the
    // user typed again. Stepping walks these rather than every block, because between two prompts
    // an agent says a dozen things and only the last of them answers the question — that is what
    // ↑ is for. Falls back to nothing on a harness with no prompt gutter, and stepBlock then walks
    // messages the old way.
    function turnSummaries(rows, agent) {
      const g = profileFor(agent), out = [];
      if (!g || !rows) return out;
      const at = i => {
        const r = blockBefore(rows, agent, i);
        // Two prompts in a row share the block above them; one entry, not two.
        if (r && (!out.length || r[0] > out[out.length - 1][0])) out.push(r);
      };
      let prompts = 0;
      for (let i = 0; i < rows.length; i++) if (isUserInput(rows[i], agent, rows, i)) { prompts++; at(i); }
      // A harness whose composer carries no glyph has one more turn than it has prompt lines: the
      // newest reply sits below the last request, where the others sit above the next one. Counted
      // rather than read off `out`, because the first request has nothing above it to summarize.
      if (g.composer === false && prompts) at(rows.length);
      return out;
    }

    // Every message in the window, in order — each block that said something rather than ran
    // something. `turnSummaries` above answers a different question and keeps its own: stepping
    // wants one stop per turn, because between two prompts an agent says a dozen things and only
    // the last of them answers the question.
    //
    // The record wants all of them. A turn is minutes of work and the agent narrates it — what it
    // is about to do, what a test said, what it found on the way — and a transcript holding only
    // the closing line of each turn is a transcript of the conclusions with the reasoning cut out.
    // Tool blocks are still not messages: `blockSpan` returns null for a block with a result glyph
    // under it, which is the same rule the summary uses.
    function messageBlocks(rows, agent) {
      const g = profileFor(agent), out = [];
      if (!g || !rows) return out;
      rows = transcriptRows(rows, g);
      for (let i = 0; i < rows.length; i++) {
        if (!startsBlock(rows, g, i)) continue;
        const at = blockSpan(rows, g, i);
        // Past the end of the block, not past its first line: a block's own body must not be
        // scanned for starts, or an indented harness opens a second block inside the first.
        if (at) { out.push(at); i = at[1]; }
      }
      return out;
    }

    // Every turn's closing message, as line numbers, trimmed the way this user trims. Scrolling
    // back is exactly when the marks earn their keep: the newest summary is on screen anyway, and
    // the one being hunted for is four screens up. Falls back to the pane's final message on a
    // harness with no prompt gutter, which is the only range there is to mark there.
    function summaryRows(rows, agent) {
      const out = new Set();
      const turns = turnSummaries(rows, agent);
      const ranges = turns.length ? turns : (finalAt ? [finalAt] : []);
      for (const at of ranges) {
        const [s, e] = trimRange(at, agent);
        for (let i = s; i <= e; i++) out.add(i);
      }
      return out;
    }

    // The block a line falls inside, or null. Walking up from the line is what lets teaching work
    // anywhere in the pane: a range is measured against its own block rather than against whichever
    // one happened to be last read. Hitting a footer, rule or prompt on the way up means the line
    // is not inside a block at all.
    function blockContaining(rows, agent, i) {
      const g = profileFor(agent);
      if (!g || !rows || !rows.length) return null;
      for (let s = Math.min(i, rows.length - 1); s >= 0; s--) {
        if (startsBlock(rows, g, s)) return blockSpan(rows, g, s);
        if (endsBlock(rows[s], g)) return null;
      }
      return null;
    }

    // Set while a range is one this found rather than one the user dragged. It is what paints the
    // band orange and what the footer names, and it is the whole difference between a suggestion
    // and a selection.
    let selSuggested = false;

    // What the user trims off a suggestion, remembered per harness.
    //
    // The gutter parse gets the block right; what it cannot know is how much of that block a
    // given person actually wants. Some always drop the opening sentence, some always drop the
    // trailing next-steps paragraph. Either way it is a pair of small line offsets measured from
    // the block's own edges, it is stable per harness, and a tally of the pairs already confirmed
    // is the entire model. No content is stored — two integers and a count.
    const TRIM_KEY = 'herdr_summary_trim', TRIM_VERSION = 2;

    function loadTrims() {
      try {
        const d = JSON.parse(localStorage.getItem(TRIM_KEY) || '');
        return d && (d.version === 1 || d.version === TRIM_VERSION) && d.byAgent ? d.byAgent : {};
      } catch (e) { return {}; }   // a corrupt blob is no trims, never a broken pane
    }

    // The pair confirmed most often. Ties go to the most recent explicit trim.
    function learnedTrim(agent) {
      const tally = loadTrims()[agent];
      let best = [0, 0], top = 0, newest = -1;
      for (const k in tally || {}) {
        const [h, t] = k.split(',').map(Number);
        const vote = tally[k], count = Array.isArray(vote) ? vote[0] : vote;
        const last = Array.isArray(vote) ? vote[1] : 0;
        if (!(h >= 0 && t >= 0)) continue;
        if (count > top || (count === top && last > newest)) {
          top = count;
          newest = last;
          best = [h, t];
        }
      }
      return best;
    }

    function noteTrim(agent, head, tail) {
      if (!agent || head < 0 || tail < 0) return;
      const all = loadTrims();
      const tally = all[agent] || (all[agent] = {});
      const k = head + ',' + tail;
      const old = tally[k], count = Array.isArray(old) ? old[0] : old || 0;
      const last = Math.max(0, ...Object.values(tally).map(v => Array.isArray(v) ? v[1] : 0));
      tally[k] = [count + 1, last + 1];
      try { localStorage.setItem(TRIM_KEY, JSON.stringify({ version: TRIM_VERSION, byAgent: all })); }
      catch (e) { /* private mode: session-only */ }
    }

    // Computed once per read rather than per render: the Summary button and the ↓↑ pill depend on
    // these, renderQuickActions and drawSel both run constantly, and a pane can be tens of
    // thousands of lines long.
    let paneProfile = null, finalAt = null;

    function scanFinalMessage() {
      const a = activePane ? paneOf(activePane) : null;
      paneProfile = a ? profileFor(a.agent) : null;
      const raw = a ? findFinalMessage(paneRows, a.agent) : null;
      // Trimmed, because that is the whole point of learning one: the range arrives the way this
      // user selects it rather than the way the parser found it. Only an explicit act votes for a
      // trim now (learnFromSelection ignores an untouched suggestion), so what comes off here is
      // something the user asked for at least once.
      finalAt = raw ? trimRange(raw, a.agent) : null;
    }

    // Redundant lines come off both ends: the ones this user has trimmed before, and then any
    // blank ones on the edges — the trim can expose them, and a block can carry one from the
    // start. A trim that would leave nothing is discarded and the block kept whole; a learned
    // offset is a preference, not a licence to select no lines at all.
    function trimRange([a, b], agent) {
      const [head, tail] = learnedTrim(agent);
      let s = a + head, e = b - tail;
      if (s > e) { s = a; e = b; }
      while (s < e && !(paneRows[s] || '').trim()) s++;
      while (e > s && !(paneRows[e] || '').trim()) e--;
      return [s, e];
    }

    // A range the user has committed to — sent, copied, or explicitly taught — measured against
    // the block it sits in. Returns the offsets learned, or null when the range is not inside a
    // block: that is a different intent and says nothing about how much of a block to keep.
    function learnFromSelection() {
      const a = activePane ? paneOf(activePane) : null;
      // An untouched suggestion says nothing about the user's trim. Its accidental 0/0 vote
      // would otherwise eventually drown out every real correction.
      if (!a || selA === null || selSuggested) return null;
      const s = Math.min(selA, selB), e = Math.max(selA, selB);
      const raw = blockContaining(paneRows, a.agent, s);
      if (!raw || s < raw[0] || e > raw[1]) return null;
      const at = [s - raw[0], raw[1] - e];
      noteTrim(a.agent, at[0], at[1]);
      return at;
    }

    // The Learn button, which does one of two quite different jobs.
    //
    // On a harness with no profile it teaches the speaker glyph, and that is confirmed before it
    // is stored — a wrong glyph misplaces *every* block boundary in the pane, and there is no
    // tally to outvote it. The confirmation shows the character itself, because pressing a button
    // twice confirms nothing: the second press carries no information the first did not.
    //
    // On a known harness it records the trim, which is a two-line offset against a tally that
    // already outvotes a stray press. So it is a single press, and what it learned is shown after
    // the fact rather than gated before it.
    function learnSelection() {
      const a = activePane ? paneOf(activePane) : null;
      if (!a || selA === null) return;
      const btn = document.getElementById('selLearn');
      const said = t => {
        btn.textContent = t;
        setTimeout(() => { if (btn.textContent === t) btn.textContent = 'Learn'; }, 1600);
      };
      if (!profileFor(a.agent)) { if (learnGutter(a.agent)) said('Learned ✓'); return; }
      if (selSuggested) { said('Trim it first'); return; }
      const at = learnFromSelection();
      said(at ? `Learned ${at[0]}/${at[1]} ✓` : 'Not a message');
      // The trim it just learned moves the summary, and the orange rows are drawn from it. Without
      // this they stay where they were until the pane's text happens to change.
      if (at) { scanFinalMessage(); repaintHighlights(); }
    }

    function learnGutter(agent) {
      const ch = (paneRows[Math.min(selA, selB)] || '')[0];
      // A letter or digit in column 0 is prose, not a gutter. Learning one would make every
      // unindented sentence a block boundary and the feature worse than absent.
      if (!ch || /[\s\w]/.test(ch)) {
        showToast('Start the selection on the line with the agent\'s marker.');
        return false;
      }
      if (!confirm(`Learn "${ch}" as ${agent}'s message marker?`)) return false;
      const all = Object.assign({}, loadGutters(), { [agent]: ch });
      gutterCache = all;
      try { localStorage.setItem(GUTTER_KEY, JSON.stringify({ version: GUTTER_VERSION, byAgent: all })); }
      catch (e) { /* private mode: session-only */ }
      scanFinalMessage();
      renderQuickActions();
      repaintHighlights();   // draws the ruler too
      return true;
    }

    // Walking the conversation. With no range on screen this starts from the end of the pane going
    // up, or the beginning coming down, so it works before anything has been selected.
    function stepBlock(dir) {
      const a = activePane ? paneOf(activePane) : null;
      if (!a) return;
      // Where to step from, in block coordinates. What is on screen is *trimmed*, and a trim of
      // even one line puts the selection's start inside the block it came from — compare that
      // against block starts and `previous` finds the block it is already on while `next` finds
      // nothing past it, which wedges stepping entirely. So the anchor is the block the selection
      // sits in. A range the user dragged themselves may sit in no block, and then it is its own
      // anchor, exactly as before.
      const sel = selA === null ? null : Math.min(selA, selB);
      const here = sel === null ? null : blockContaining(paneRows, a.agent, sel);
      const from = here ? here[0] : sel;
      const turns = turnSummaries(paneRows, a.agent);
      const at = turns.length
        ? (dir < 0
          ? [...turns].reverse().find(t => t[0] < (from === null ? paneRows.length : from))
          : turns.find(t => t[0] > (from === null ? -1 : from))) || null
        : (dir < 0
          ? blockBefore(paneRows, a.agent, from === null ? paneRows.length : from)
          : blockAfter(paneRows, a.agent, from === null ? 0 : from + 1));
      if (!at) {
        // Off the top of what has been read. The pane opens on 200 lines and two long tool blocks
        // eat that, so running out here means asking for more history rather than dead-ending.
        if (dir < 0 && paneLines < paneHistoryMax()) { loadMore(); showToast('Loading more history…'); }
        else showToast(dir < 0 ? 'No earlier message' : 'No later message');
        return;
      }
      [selA, selB] = trimRange(at, a.agent);
      selSuggested = true;
      drawSel();
      scrollPaneToLine(Math.min(selA, selB));
    }

    // At most one suggestion per pane per snapshot. The 3s poll re-delivers identical text, and
    // re-selecting a range the user just cleared would make it impossible to clear.
    let suggestedKey = '';

    function suggestFinalMessage() {
      const a = activePane ? paneOf(activePane) : null;
      // Shipped profiles only. A learned one has no result glyph, so it cannot tell a command from
      // a sentence — it answers when asked and never volunteers.
      if (!a || !GUTTERS[a.agent] || a.status !== 'done' || selA !== null) return;
      const key = activePane + ' ' + paneRows.length + ' ' + (paneRows[paneRows.length - 1] || '');
      if (key === suggestedKey) return;
      suggestedKey = key;   // set before the check, so a pane with nothing to find stays quiet
      if (finalAt) selectFinalMessage();
    }

    // The Summary button, and the automatic suggestion, land on the same range through here.
    // Unlike the suggestion it has no status gate: pressing it is the user asking, and an agent
    // that is mid-turn still has a previous message worth lifting out.
    // `scroll` is what separates the two: pressing the button is a request to go and look at the
    // message, and on a long pane it is usually far above the foot. The automatic suggestion does
    // not scroll — it arrives with a poll, and moving the pane under someone reading scrollback
    // would be the poll stealing their place.
    function selectFinalMessage(scroll) {
      if (!finalAt) return;
      [selA, selB] = finalAt;
      selSuggested = true;
      drawSel();
      if (scroll) scrollPaneToLine(Math.min(selA, selB));
    }
