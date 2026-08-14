    // --- Conversation recorder (pure) --- start
    // A pane keeps a few hundred lines of history and then forgets. This turns what is on screen
    // into transcript entries that outlive it, and it does so as a function of (rows, agent, what
    // is already stored) — no storage, no DOM, no clock of its own. Storing is §4.4's job and the
    // views are §7's; both sit on top of this.
    //
    // Nothing here reconciles one read against another, and that is the point (§5.2). A transcript
    // is written by events that happen once — the pane's first read, a turn ending, a prompt this
    // app sent — so "have I already recorded this" is answered by the event, never by comparing
    // text. That matters because comparing text cannot be made correct: an agent that says "Done."
    // twice said it twice, and no amount of matching can tell that from the same "Done." read
    // twice. The one place text is still compared is the menu's duplicate repair, on records
    // written by the version that did fold windows together.

    const CONV_TEXT_MAX = 4000, CONV_DEDUPE_WINDOW = 200;
    const CONV_OUTBOX_MAX = 50, CONV_OUTBOX_TTL = 30 * 60 * 1000;

    // Gutter glyph, the box side it may sit inside, and the leading space. Same characters as
    // _MARGIN in relay/pane_summary.py, and for the same reason: what is left is where the text
    // starts.
    const CONV_MARGIN = /^[\s│┃⏺•❯>›⋯]+/;

    function convLine(row) {
      return String(row == null ? '' : row).replace(/\s+$/, '').replace(/[│┃]+$/, '')
        .replace(CONV_MARGIN, '');
    }

    // A range of rows as one message. Line breaks are kept — Codex closes in three paragraphs and a
    // thread that ran them together would be lying about what it said — but a run of blank lines is
    // not structure, it is the gap before the next glyph.
    function convText(rows, [s, e]) {
      const out = [];
      for (let i = s; i <= e; i++) out.push(convLine(rows[i]));
      const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
      return text.length > CONV_TEXT_MAX ? text.slice(0, CONV_TEXT_MAX - 1) + '…' : text;
    }

    // The comparison key, and only ever that: whitespace collapsed, so one message read at a phone
    // width and at a desktop width is one string. Stored text stays as it was extracted.
    function convKey(text) { return String(text == null ? '' : text).replace(/\s+/g, ' ').trim(); }

    // Everything said in this window, in window order: the agent's closing message per turn, and
    // each run of the user's own lines as one message rather than one per line.
    //
    // Untrimmed on purpose. `trimRange` is a *learned* preference and it changes as the user
    // teaches it; applying it here would make the same message extract differently over time, which
    // is exactly what the overlap match reads as a new message. The trim belongs to the view.
    function paneMessages(rows, agent) {
      const found = [];
      for (const at of turnSummaries(rows, agent)) found.push({ who: 'agent', at });
      const userLines = userInputLines(rows, agent);
      // Codex's idle composer shares its prompt gutter. Its model/context status immediately
      // follows, unlike a sent prompt, which is followed by the agent reply.
      //
      // One forward scan: a pane read at the 50k ceiling must not rescan its tail once per prompt.
      if (agent === 'codex') for (let i = 0; i < rows.length; i++) {
        if (!/^\s*\S+(?:\s+\S+)*\s+· Context \d+% used(?:\s|$)/.test(rows[i] || '')) continue;
        let start = i;
        while (start >= 0 && userLines.has(start)) start--;
        for (const j of userLines) if (j > start) userLines.delete(j);
        break;
      }
      const lines = [...userLines].sort((a, b) => a - b);
      for (let i = 0; i < lines.length;) {
        let j = i;
        while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
        found.push({ who: 'user', at: [lines[i], lines[j]] });
        i = j + 1;
      }
      return found.sort((a, b) => a.at[0] - b.at[0])
        .map(m => ({ who: m.who, text: convText(rows, m.at) }))
        // The empty composer at the foot of a live pane is a prompt line with nothing typed on it.
        .filter(m => m.text);
    }

    function convEntry(m, seen, extra) {
      return Object.assign({ who: m.who, seen: seen, text: m.text }, extra || {});
    }

    // When an entry was said, as opposed to when this browser first saw it. `seen` is the fold's
    // own clock and is what the overlap machinery is built on; `at` is the best answer available
    // about the message itself, and `at_src` says how good that answer is:
    //
    //   sent      exact — the user pressed send in this browser and the outbox stamped it
    //   state     within one relay poll — the pane's own done/blocked transition ended this turn
    //   read      the fold's clock, for a turn still being written: now is the honest answer
    //   backfill  unknown, but older than everything live — scrollback that predates the first read
    //
    // Old records have neither field, so every reader goes through convAt.
    function convAt(e) { return (e && (e.at || e.seen)) || 0; }

    // A committed entry is not a view of the pane, it is a record of what was said — so a later
    // read may only ever *extend* it, never replace it, and its stamp may only ever get better.
    // Streaming pane content is what folds into new entries; it does not own the ones already
    // written, and the thread renders the record rather than the frame.
    const CONV_AT_RANK = { backfill: 0, read: 1, state: 2, sent: 3 };

    function convAtRank(e) {
      const r = CONV_AT_RANK[e && e.at_src];
      return r === undefined ? 0 : r;
    }

    // The first read of a pane, as a first transcript. There is nothing to compare it against, so
    // nothing is compared: everything on screen was said before this browser was watching, and the
    // order plus "older than now" is all that can honestly be said about it. This is the one write
    // that is not an event, and it happens once per pane (§5.2).
    function backfillEntries(fresh, now) {
      const ms = fresh || [];
      return ms.map((m, i) => convEntry(m, now, { at: now - (ms.length - i), at_src: 'backfill' }));
    }

    // A send can win the race to the store before the pane's first read, and more than one can:
    // nothing makes the user wait for a read between two prompts. Every one of them is already an
    // entry, so none of their echoes is history — and neither is anything the agent said after the
    // oldest of them. The seam is that oldest echo; the prefix above it is backfill.
    function splitFirstRead(fresh, stored) {
      const ms = fresh || [];
      const sent = (stored || [])
        .filter(e => e.who === 'user' && e.at_src === 'sent').map(e => convKey(e.text));
      let seam = -1;
      for (const key of sent) {
        // Newest occurrence, which is how a single send has always been matched: a prompt that
        // also appears far up the scrollback must not swallow the history above it.
        for (let i = ms.length - 1; i >= 0; i--) {
          if (ms[i].who === 'user' && convKey(ms[i].text) === key) {
            if (seam < 0 || i < seam) seam = i;
            break;
          }
        }
      }
      return seam < 0 ? { history: ms, turn: [] }
        : { history: ms.slice(0, seam), turn: ms.slice(seam) };
    }

    // The tail below that seam, as entries. Not `turnEntries`: that keeps the last agent block
    // alone, which is right for a turn that just ended and wrong here — two sends means two
    // replies, and the older one is not scrollback either. What it drops is the echoes, which the
    // sends already committed.
    //
    // The replies below the first echo are dated `now`, so the thread shows both prompts and then
    // both replies rather than interleaving them. That is what the store can honestly say: the
    // sends carry exact clocks and the replies were all first seen at this read.
    function sentTurnEntries(fresh, stored, now, end) {
      const sent = new Set((stored || [])
        .filter(e => e.who === 'user' && e.at_src === 'sent').map(e => convKey(e.text)));
      return stampTurn((fresh || [])
        .filter(m => !(m.who === 'user' && sent.has(convKey(m.text)))), now, end);
    }

    // The turn that just ended, out of the window read when it ended: the agent's closing message,
    // and the prompt that opened it if that prompt is directly above it. Walks back from the end —
    // an agent that ran twice on one prompt has no prompt of its own above the second reply, and
    // correctly contributes only the reply.
    function turnMessages(fresh) {
      const ms = fresh || [];
      let end = ms.length - 1;
      while (end >= 0 && ms[end].who !== 'agent') end--;
      if (end < 0) return [];
      let start = end;
      while (start - 1 >= 0 && ms[start - 1].who === 'user') start--;
      return ms.slice(start, end + 1);
    }

    // What of that turn is not already recorded, which is a question about *shape* and never about
    // text. A prompt this app sent was committed at the send, so the transcript already ends with a
    // user entry — and then the pane's echo of it is the same prompt, whatever it looks like after
    // the composer wrapped it. A prompt typed at the keyboard leaves the tail on an agent entry,
    // and is the one that has to be read back.
    //
    // Nothing here compares message text, so two turns that said the same words are two entries.
    // That is the whole reason the recorder no longer needs to align anything.
    // The second rule is for an agent that answers one prompt twice: at its second done the prompt
    // is still the newest thing above the reply in the window, and the transcript recorded it at
    // the first. Here the text is compared, because there is nothing else left to compare — and
    // the cost is stated rather than hidden: the same prompt typed at the keyboard twice running,
    // with nothing else said between, records once. A prompt this app sent is exempt, because rule
    // one has already dropped it.
    function newTurnMessages(stored, turn) {
      const entries = stored || [];
      const last = entries[entries.length - 1];
      if (last && last.who === 'user') return (turn || []).filter(m => m.who !== 'user');
      let said = '';
      for (let i = entries.length - 1; i >= 0 && !said; i--) {
        if (entries[i].who === 'user') said = convKey(entries[i].text);
      }
      return (turn || []).filter(m => !(m.who === 'user' && said && convKey(m.text) === said));
    }

    // A turn found sitting finished at a reconnect, rather than watched ending. There is no
    // transition to prove it is new — the clock was armed at the reconnect — so the one question
    // left is whether the transcript already ends on this exact closing message. If it does, this
    // is the turn that was recorded just before the tab closed and there is nothing to recover;
    // if it does not, it ended while nothing was connected and it is still on screen.
    //
    // The newest stored agent entry is the only thing consulted, once per reconnect. That is the
    // whole extent to which text is trusted here, and the cost is the mirror of the prompt rule
    // above: an agent whose last two turns closed with the same words recovers neither.
    function recoveredTurn(stored, turn) {
      const entries = stored || [], ms = turn || [], closing = ms[ms.length - 1];
      if (!closing) return [];
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i].who !== 'agent') continue;
        return convKey(entries[i].text) === convKey(closing.text) ? [] : ms;
      }
      return ms;
    }

    // One turn appended. `end` is the transition that ended it, which is also what dates the
    // closing message — the relay pushes done/blocked for every pane, so this is a real clock and
    // not the fold's own. A recovered turn passes no `end`: the reconnect is not when the agent
    // finished, and `read` is the honest stamp for "this is when it was found".
    function turnEntries(fresh, stored, now, end, recover) {
      const picked = turnMessages(fresh);
      return stampTurn(newTurnMessages(stored, recover ? recoveredTurn(stored, picked) : picked),
        now, end);
    }

    // `end` dates the closing message and nothing else — every other line was first seen now.
    function stampTurn(add, now, end) {
      return add.map((m, i) => convEntry(m, now, m.who === 'agent' && i === add.length - 1 && end
        ? { at: end, at_src: 'state' } : { at: now, at_src: 'read' }));
    }

    // Which pane a transcript belongs to. Not the pane_id alone: herdr recycles those, and a
    // recycled id landing on a dead session's transcript would inherit words that pane never said,
    // which is the worst failure this feature has.
    function convMemberKey(a) {
      return a ? JSON.stringify([a.host || '', a.pane_id || '', a.agent || '', a.cwd || '']) : '';
    }

    function convHash(text) {
      const t = convKey(text);
      let h = 0x811c9dc5;
      for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
      return (h >>> 0).toString(16);
    }

    // Where the words in an outgoing prompt came from. Transfer prefills the composer and stops,
    // so by the time the pane echoes the prompt back there is nothing left in it to tell a
    // transfer from typing — the answer has to be worked out at the send, against what was
    // prefilled.
    //
    // `mixed` is the ordinary outcome and not an edge case: the payload arrives in the composer
    // for the user to read, and adding an instruction over it before sending is what the
    // checkpoint is for.
    function classifyVia(pending, sent, now) {
      const text = convKey(sent);
      if (!pending || !pending.body || now - pending.at > CONV_OUTBOX_TTL) return { via: 'typed' };
      if (!text.includes(convKey(pending.body))) return { via: 'typed' };
      return {
        via: text === convKey(pending.payload) ? 'transfer' : 'mixed',
        from: { key: pending.key, label: pending.label, hash: pending.hash },
      };
    }

    // A send is classified now and read back off the pane seconds later, so the answer waits in a
    // small keyed list until the recorder comes looking. Short and capped: past the TTL a prompt
    // that has still not appeared is one this browser is never going to record.
    function outboxAdd(box, hash, note, now) {
      const kept = (box || []).filter(e => now - e.at < CONV_OUTBOX_TTL);
      kept.push(Object.assign({ hash: hash, at: now }, note));
      return kept.slice(-CONV_OUTBOX_MAX);
    }

    // Every user entry gets a `via`, and `typed` is what an unmatched one gets — the honest
    // failure mode, because provenance is only knowable where the send happened. A transfer made
    // on the desktop and recorded on the phone reads as typed there; the phone never saw it.
    //
    // Once tagged an entry is never re-examined, which is also what keeps this cheap: the hash is
    // computed for new entries only.
    function tagUserEntries(entries, box, now) {
      const left = (box || []).filter(e => now - e.at < CONV_OUTBOX_TTL);
      const tagged = (entries || []).map(e => {
        if (e.who !== 'user' || e.via) return e;
        const at = left.findIndex(x => x.hash === convHash(e.text));
        const hit = at < 0 ? null : left.splice(at, 1)[0];
        // The send is the only moment a prompt's real time is known, and the outbox already holds
        // it — the pane echoes the same words back seconds to minutes later.
        return Object.assign({}, e, hit
          ? { via: hit.via, from: hit.from, at: hit.at, at_src: 'sent' }
          : { via: 'typed' });
      });
      return { entries: tagged, outbox: left };
    }
    // The ceilings. IndexedDB's budget is a share of free disk rather than 5 MB, so these are set
    // by what a thread is still readable at rather than by what fits.
    //
    // MEMBER_MAX is a ceiling on *recording* members, and always was a statement about the view —
    // past this a joint thread stops being one. A conversation continued across several respawns
    // accumulates ended members that cost nothing to draw, so the roster's own cap is separate and
    // far larger. The index is localStorage, where the roster is what a member actually costs
    // (~120 bytes); the transcripts are IndexedDB, which is a different store and a different
    // budget.
    const CONV_ENTRY_MAX = 5000, CONV_MEMBER_MAX = 8, CONV_CONV_MAX = 200, CONV_TRANSCRIPT_MAX = 500;
    const CONV_ROSTER_MAX = 200, CONV_AUTO_ROSTER_MAX = 20;

    // A corrupt blob is no conversations, never a half-index — the contract parsePairs already
    // holds to, and for the same reason: a store that outlives the panes it describes will one day
    // be read by a version that did not write it.
    function parseConvIndex(raw) {
      try {
        const d = JSON.parse(raw || '');
        if (!d || d.version !== 1 || !Array.isArray(d.items)) return [];
        return d.items.filter(c => c && c.id && typeof c.name === 'string' && Array.isArray(c.members))
          // The roster, not the recording cap: an ended member is the record of a session that
          // happened, and truncating it here would delete history on the next read of the index.
          .map(c => Object.assign({}, c, { members: c.members.slice(-CONV_ROSTER_MAX) }));
      } catch (e) { return []; }
    }

    // Oldest-first, per transcript: a chatty pane must not evict a quiet one's history, which is
    // what one global entry budget would do.
    function capEntries(entries, max) {
      const cap = max || CONV_ENTRY_MAX;
      return entries.length > cap ? entries.slice(entries.length - cap) : entries;
    }

    // What to drop when there are too many transcripts, and what may never be dropped at all.
    //
    // A transcript a *named* conversation holds is a floor, not a preference: the record outliving
    // the panes that wrote it is the whole feature, and silently deleting one to stay under a
    // ceiling is the single failure this model cannot absorb. So `kept` is removed from the pool
    // entirely, and a cap reached with everything kept drops nothing — the caller says so out loud
    // instead.
    //
    // Everything else is ordered by how much anyone asked for it: a transcript no conversation
    // names at all, then one only an auto conversation holds, then oldest `touched` within each.
    // That is the tier split — what the user named is permanent, what the app started on its own
    // is book-keeping — and it is what lets recording be on by default without growing forever.
    function evictOrder(records, referenced, max, kept) {
      const keep = max || CONV_TRANSCRIPT_MAX;
      if (records.length <= keep) return [];
      const held = k => !!(kept && kept.has(k));
      const auto = k => !!(referenced && referenced.has(k));
      const pool = records.filter(r => !held(r.key));
      // Over the ceiling on kept records alone. Nothing here is the right thing to delete.
      const over = records.length - keep;
      return pool.slice()
        .sort((a, b) => (auto(a.key) ? 1 : 0) - (auto(b.key) ? 1 : 0)
          || (a.touched || 0) - (b.touched || 0))
        .slice(0, Math.min(over, pool.length))
        .map(r => r.key);
    }
    // Several members, one thread. A stable merge on `seen`: each member's own entries keep the
    // order they were recorded in, exactly, and a tie is broken by member order rather than by
    // whichever record was read first. That property is what makes the joint view a render — the
    // per-pane records are never merged on disk, so a member can always be read alone (§4).
    function mergeEntries(records) {
      const recs = (records || []).filter(r => r && r.entries && r.entries.length);
      const heads = recs.map(() => 0), out = [];
      for (;;) {
        let pick = -1;
        for (let i = 0; i < recs.length; i++) {
          const e = recs[i].entries[heads[i]];
          if (!e) continue;
          if (pick < 0 || convAt(e) < convAt(recs[pick].entries[heads[pick]])) pick = i;
        }
        if (pick < 0) return out;
        // `member` is the index the colour comes from, and it is the position in the list handed
        // in — member order, which is the order the conversation stores.
        out.push(Object.assign({}, recs[pick].entries[heads[pick]++],
          { key: recs[pick].key, member: recs[pick].member }));
      }
    }
    // The repair for a transcript that already holds duplicates, run from the menu and never on its
    // own. The duplicate it removes is a whole screen folded in a second time, which happened while
    // a pane was being read as a `visible` frame: those breaks land mid-word, so the same sentence
    // normalized to a string the overlap match had never seen and everything on screen was appended
    // again. convRecordable stopped it happening; records written before it still carry the copies.
    //
    // Whitespace is dropped entirely rather than collapsed, because that is exactly the difference
    // the wrap made — "our loca l database" against "our local database".
    function convDupKey(e) {
      return (e.who || '') + '\u0000' + convKey(e.text).replace(/\s+/g, '');
    }

    // Only a repeat inside one read window counts: an agent that says "Done." again an hour later
    // said it twice, and a dedupe that cannot tell those apart would quietly delete history.
    function convDedupe(entries) {
      const out = [], at = new Map();      // dup key -> index in `out` of the copy being kept
      let removed = 0;
      for (const e of entries || []) {
        const k = convDupKey(e), prev = at.get(k);
        if (prev !== undefined && out.length - prev <= CONV_DEDUPE_WINDOW) {
          // Earliest copy is the transcript's chronology. Later duplicates are repair debris,
          // and must not rewrite its words or its timestamp.
          removed++;
          continue;
        }
        at.set(k, out.length);
        out.push(e);
      }
      return { entries: out, removed: removed };
    }

    // A copy's name, against the names already taken. "(copy)", then "(copy 2)" — the second copy
    // of a thing is the third grouping of it, and a list holding two rows called the same is a list
    // nobody can pick from.
    function convCopyName(name, taken) {
      const base = (name || 'Conversation').replace(/ \(copy( \d+)?\)$/, '');
      const used = new Set(taken || []);
      for (let n = 1; ; n++) {
        const next = `${base} (copy${n > 1 ? ' ' + n : ''})`.slice(0, 64);
        if (!used.has(next)) return next;
      }
    }
    // --- Conversation recorder (pure) --- end

    // The pending transfer, and where a classified send waits for the recorder to find it. Both
    // are one browser's knowledge of its own sends; nothing here is shared and nothing is sent.
    const CONV_OUTBOX_KEY = 'herdr_conv_outbox';
    let pendingTransfer = null;

    function loadOutbox() {
      try {
        const d = JSON.parse(localStorage.getItem(CONV_OUTBOX_KEY) || '');
        return Array.isArray(d) ? d : [];
      } catch (e) { return []; }   // a corrupt blob is no provenance, never a broken send
    }

    function saveOutbox(box) {
      try { localStorage.setItem(CONV_OUTBOX_KEY, JSON.stringify(box)); }
      catch (e) { /* private mode: this session only */ }
    }

    // Called on the way out of every composer send. A prefill answers for one send: whether it was
    // used, edited or deleted, the next send starts from nothing.
    function noteSent(text, paneId) {
      const now = Date.now();
      const note = classifyVia(pendingTransfer, text, now);
      pendingTransfer = null;
      // The prompt itself, straight into the transcript. Exact text, exact time, no reading back.
      convRecordSend(paneId, text, note.via === 'typed' ? null : note, now);
      // `typed` is the default the recorder applies on its own, so there is nothing to leave.
      if (note.via === 'typed') return;
      saveOutbox(outboxAdd(loadOutbox(), convHash(text), note, now));
    }
