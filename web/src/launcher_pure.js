    // --- Launcher tiles (pure) --- start
    // Pure, dependency-free, and extracted verbatim by tests/test_launcher.js. Keep it that way:
    // anything here that touches the DOM, ws, or localStorage breaks the tests silently.
    //
    // A launcher tile is the answers a person would otherwise type into the Start dialog or at a
    // shell prompt, kept so they can be pressed instead. It carries no cwd, no host and no argv —
    // a `run` names a Project and a line of text, and where that text lands is the relay's to
    // decide from configuration, exactly as it is for a start (D4).
    //
    // Not to be confused with `#quickActions` (the approval bar over a pane) or `#quickDock` (the
    // composer's canned replies). Both of those act on the pane already open; a launcher tile
    // creates the thing to act on.
    const LAUNCHER_KEY = 'herdr_launcher';
    const LAUNCHER_PENDING_KEY = 'herdr_launcher_pending';
    const LAUNCHER_VERSION = 1;

    // Same cap and the same reason as a pane label: a tile and the pane it starts should be able
    // to wear the same name.
    const LAUNCHER_LABEL_MAX = 32;
    // A roster the arbitrator can read is two, and §14.1 fixes it there. Above that a tile is
    // still legal and still spawns — it just cannot be arbitrated.
    const LAUNCHER_MEMBERS_MAX = 8;
    // A screenful on a phone, several on a desktop. A bound on a client gone wrong rather than a
    // limit anyone will meet; the document also has user_state's 256 KB over it.
    const LAUNCHER_MAX = 60;

    // The three the renderer knows how to press, in the order the editor offers them: sessions
    // first, because that is what this launcher is mostly for. A tile carrying anything else is
    // *kept* and drawn disabled — see launcherGate. Dropping it would let a browser on an older
    // build destroy an action every other browser can see, which is the failure stateSyncPlan
    // exists to stop one level up.
    const LAUNCHER_ACTIONS = ['spawn', 'term', 'run'];

    // Both open a terminal and neither starts an agent; `run` also types a line at it. One
    // predicate rather than two names threaded through every branch, because the difference
    // between them is one field and everything else about them is the same.
    // ponytail: `term` is a `run` with an optional command today. If it grows its own fields —
    // a shell to open, a directory under the Project — this is where they part.
    function launcherIsTerm(tile) {
      return !!tile && (tile.action === 'run' || tile.action === 'term');
    }

    // Exactly what relay/start_agent.py accepts, restated because the relay does not offer it.
    // `extra = set(msg) - base_fields` is a hard refusal there, so a stray key is not a warning —
    // it is the whole message rejected. launcherStrict is what makes that a test failure here
    // instead of a spawn that mysteriously does nothing.
    const OPEN_TERMINAL_FIELDS = ['type', 'project_id', 'placement', 'label', 'slot'];
    const START_AGENT_FIELDS = ['type', 'name', 'role', 'project_id', 'placement', 'label', 'slot'];

    // Always. The other two placements name a live pane — `workspace_id` for a tab, `split_from`
    // for a split — and a tile saved last week cannot: the pane it would have named is gone, and
    // herdr reuses pane ids, so a stale one is not merely dead but potentially somebody else's.
    // A tile therefore asks for the one placement that refers to nothing.
    const LAUNCHER_PLACEMENT = 'new_workspace';
    // The wire role every relay accepts. start_agent knows three — architect, reviewer, agent —
    // and refuses the *whole message* for anything else. A tile's role is not one of those: it is
    // what the arbitrator is told this member is for, free text the user typed. So it rides as
    // the pane's label, exactly as the Start dialog does with its own named roles, and the wire
    // role stays the neutral one.
    const LAUNCHER_ROLE = 'agent';

    // The starter every new member is given until it is changed. A SHORTCUTS `at` name and not the
    // text itself: the text is edited in one place and a tile saved last month follows it, which is
    // the whole reason the chips are addressed by name everywhere else.
    const LAUNCHER_DEFAULT_AT = 'architect-prompt';

    function launcherId() {
      return 'ql_' + Math.random().toString(36).slice(2, 10);
    }

    // The suffix an unnamed launch runs under. Five characters is short enough to still read as a
    // tag rather than an id, and wide enough that two presses of one tile in the same minute do
    // not land on the same name — which is the whole reason a launch is named apart from its tile.
    const LAUNCHER_TAG_LEN = 5;
    const LAUNCHER_TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

    function launcherTag() {
      let out = '';
      for (let i = 0; i < LAUNCHER_TAG_LEN; i++) {
        out += LAUNCHER_TAG_ALPHABET[Math.floor(Math.random() * LAUNCHER_TAG_ALPHABET.length)];
      }
      return out;
    }

    // What this tile makes, in one word. Read off the roster and not off launcherWantsConv: every
    // spawn lands on a conversation now, but one agent in one is still an agent to the person who
    // pressed it, and calling it a conversation would name the container instead of the thing.
    function launcherNoun(tile) {
      if (!tile || launcherIsTerm(tile)) return 'terminal';
      return (Array.isArray(tile.members) ? tile.members.length : 0) > 1 ? 'conversation' : 'agent';
    }

    function launcherAutoName(tile) {
      return `${launcherNoun(tile)} ${launcherTag()}`;
    }

    // A name that is about to become a pane label, made safe to be one. validate_pane_label refuses
    // a control character outright and caps the length, so an unscrubbed name is a launch the relay
    // rejects with nothing on screen saying why.
    function launcherClean(name) {
      return String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
        .slice(0, LAUNCHER_LABEL_MAX);
    }

    // A member's pane name for one launch. The template's name plus the launch's tag, always —
    // a tile pressed twice is two panes, and two panes called "Reviewer" are two the roster, the
    // conversation and herdr's own status line all fail to tell apart. The name is trimmed to fit
    // the tag rather than the tag trimmed off the end: the tag is the half that makes it unique.
    //
    // '' for a member the template never named, which is what leaves launcherSpawnMsg's own
    // fallbacks — the role, then the relay — in charge, exactly as before.
    function launcherMemberName(member, tag, fallback) {
      const own = launcherClean((member && member.label) || '') || launcherClean(fallback || '');
      if (!own) return '';
      return `${own.slice(0, LAUNCHER_LABEL_MAX - tag.length - 1).trim()} ${tag}`;
    }

    // Who is Agent 1 and who is Agent 2 when an arbitrator is appointed, and what each is there
    // for. Agent 1 writes, Agent 2 reviews what it wrote, and both propose what comes next — the
    // shape nearly every arbitrated pair is set up as, offered rather than typed out again.
    //
    // The preference is by harness, in order, because the two jobs are not interchangeable: the
    // implementer is picked first and is then off the table for the reviewer, so a roster with only
    // one of the preferred kinds still fills both slots instead of naming the same pane twice.
    const LAUNCHER_ARB_SLOTS = [
      {prefer: ['claude', 'kiro', 'pi', 'agy'], tags: ['implement', 'test-min', 'fix-code', 'next']},
      {prefer: ['codex', 'kiro', 'pi', 'agy'], tags: ['fix-code', 'review', 'next']},
    ];

    // The roster in slot order. A copy, and everything past the slots kept in the order it was in:
    // the tile is the user's list and this only decides which two of it are the pair.
    // Every preferred kind is claimed before anything falls back, and not slot by slot: a roster of
    // codex and something neither slot names would otherwise hand codex to the implementer, because
    // that slot ran out of preferences first and took whatever was on top.
    function launcherArbOrder(members) {
      const left = (members || []).slice();
      const picked = LAUNCHER_ARB_SLOTS.map(slot => {
        let at = -1;
        slot.prefer.some(kind => { at = left.findIndex(m => m && m.name === kind); return at >= 0; });
        return at < 0 ? null : left.splice(at, 1)[0];
      });
      return picked.map(m => m || left.shift()).filter(Boolean).concat(left);
    }

    // The tile as *this* press will run it. A copy and never a write back into the document: the
    // name was typed for one launch, and a tile that renamed itself on every press would be a
    // button labelled with whatever it last did.
    function launcherNamed(tile, name) {
      const tag = launcherTag();
      // The tag goes on the launch's own name too, not only on the panes under it. One press is
      // one tag: the conversation, every member and the arbitrator all wear it, which is what makes
      // "which of these three sessions is the one I started at 11" a question the names answer.
      const label = launcherMemberName({label: name}, tag, launcherNoun(tile));
      const out = Object.assign({}, tile, {label: label});
      const members = Array.isArray(out.members) ? out.members : [];
      if (members.length) {
        // One member and no name of its own falls back to the launch's: there is nothing to tell
        // it apart from, so the pane, its conversation and the tag all say the same thing. Several
        // members do not — the launch name is the room's, and every pane wearing it is the one
        // roster nobody can read.
        out.members = members.map(m => {
          // A one-agent launch is named once: its pane and conversation are the same thing until
          // the member is deliberately given a name of its own.
          const own = launcherClean(m.label || '');
          // A member the template never named falls back to its kind, so it is `claude a1b2c` and
          // not whatever herdr would have called it: an untagged pane in a tagged roster is the one
          // nobody can place.
          return Object.assign({}, m, {label: members.length === 1 && !own
            ? label : launcherMemberName(m, tag, m.name)});
        });
      }
      if (out.arbitrator) {
        out.arbitrator = Object.assign({}, out.arbitrator,
          {label: launcherMemberName(out.arbitrator, tag, 'arbiter')});
      }
      return out;
    }

    // Anything unreadable falls back to empty. This is a document a user can edit and a second
    // browser can write, and a bad value must not blank the page.
    function parseLauncher(raw) {
      let v = null;
      try { v = JSON.parse(raw); } catch (e) { return []; }
      const items = v && Array.isArray(v.items) ? v.items : [];
      const seen = new Set();
      return items.filter(t => {
        // id and label are what every tile needs to be drawn and to survive a merge; the action
        // is deliberately *not* checked against LAUNCHER_ACTIONS here. A kind this build does not
        // know is a tile it cannot press, not a tile it may delete.
        if (!t || typeof t.id !== 'string' || !t.id) return false;
        if (typeof t.label !== 'string' || !t.label) return false;
        if (typeof t.action !== 'string' || !t.action) return false;
        if (seen.has(t.id)) return false;   // a duplicate id merges into one row, never two
        seen.add(t.id);
        return true;
      }).slice(0, LAUNCHER_MAX);
    }

    function serializeLauncher(items) {
      return JSON.stringify({ version: LAUNCHER_VERSION, items: items.slice(0, LAUNCHER_MAX) });
    }

    // What is wrong with a tile as *written*, independent of what the relay currently offers.
    // Returns '' when there is nothing wrong. Kept apart from launcherGate because the two answer
    // different questions: this one says the editor may not save it, that one says the tile cannot
    // be pressed right now.
    function launcherValid(tile) {
      if (!tile || typeof tile !== 'object') return 'Not a tile';
      const label = typeof tile.label === 'string' ? tile.label.trim() : '';
      if (!label) return 'Give it a name';
      if (label.length > LAUNCHER_LABEL_MAX) return `At most ${LAUNCHER_LABEL_MAX} characters`;
      // Exactly the characters validate_pane_label refuses (ord < 0x20, or 0x7F). This label is
      // sent as a pane label, and a control character there corrupts herdr's status line.
      if (/[\u0000-\u001f\u007f]/.test(label)) return 'No control characters';
      // No Project is a legal tile and the more useful one: it is a template rather than a button,
      // the same roster pressed into whichever tree wants it. The Project is then asked for at the
      // press, where it is mandatory — see launcherAskProject.
      if (LAUNCHER_ACTIONS.indexOf(tile.action) < 0) return 'Unknown action';
      if (launcherIsTerm(tile)) {
        const command = typeof tile.command === 'string' ? tile.command.trim() : '';
        // A `term` with nothing to type is the whole point of it — an empty prompt in the right
        // tree. A `run` with nothing to run is a button that opens a terminal and lies about it.
        if (tile.action === 'run' && !command) return 'Give it a command to run';
        // SEND_TEXT_MAX is the relay's cap on one send_text. Longer text is splittable in the
        // composer, but a launcher command that arrived in two pieces would run the first half at
        // the prompt — so this is a real limit rather than a chunking problem.
        if (command.length > SEND_TEXT_MAX) return 'That command is too long to send';
        return '';
      }
      const members = Array.isArray(tile.members) ? tile.members : [];
      if (!members.length) return 'Add at least one agent';
      if (members.length > LAUNCHER_MEMBERS_MAX) return `At most ${LAUNCHER_MEMBERS_MAX} agents`;
      if (members.some(m => !m || typeof m.name !== 'string' || !m.name)) return 'Every agent needs a kind';
      if (members.some(m => /[\u0000-\u001f\u007f]/.test(String(m.label || '')))) {
        return 'No control characters in an agent name';
      }
      // Only when the arbitrator is one this tile can actually use. A tile edited from three
      // members back to two keeps whatever arbitrator it had — see launcherWantsArb — and the
      // same rule has to hold going the other way: three members with a leftover arbitrator is a
      // tile that still spawns three agents, not one the editor may refuse to save.
      if (launcherWantsArb(tile)) {
        if (typeof tile.arbitrator.name !== 'string' || !tile.arbitrator.name) {
          return 'The arbitrator needs a kind';
        }
        // The relay refuses an empty scope outright, and rightly: the scope is the whole of what
        // the arbitrator is told the session is for, and one with none decides about nothing.
        if (!String(tile.scope || '').trim()) return 'Say what the arbitrator is deciding about';
      }
      return '';
    }

    // Whether this tile can be pressed against the relay currently connected, and why not.
    // `env` is {projects, startOptions} — the two things the snapshot already carries.
    //
    // Disabled, never hidden. A launcher that silently drops buttons teaches the user not to trust
    // it; one that says which Project went missing is repairable.
    function launcherGate(tile, env) {
      const e = env || {};
      const projects = e.projects || [];
      const opts = e.startOptions;
      const bad = launcherValid(tile);
      // An action this build does not know reads as a tile from a newer app, because that is the
      // likeliest thing it is. Checked before `bad`, which would only say "Unknown action".
      if (tile && LAUNCHER_ACTIONS.indexOf(tile.action) < 0) {
        return { ok: false, reason: 'Needs a newer app', badge: 'Unsupported' };
      }
      if (bad) return { ok: false, reason: bad, badge: 'Broken' };
      if (!tile.project_id) {
        // A template is pressed *into* a Project, so all this can check is that there is one to
        // choose. Not a stale pointer, so not repointable — the press asks.
        if (!projects.length) {
          return { ok: false, reason: 'This relay has no Projects configured',
                   badge: 'No Projects' };
        }
      } else if (!projects.some(p => p.id === tile.project_id)) {
        return { ok: false, reason: 'That Project is not configured on this relay',
                 badge: 'Missing Project' };
      }
      // start_options' absence is already the app's gate for Start, and open_terminal's two gates
      // are reported inside it as `terminal`. Same signals, read from a tile.
      if (!opts) return { ok: false, reason: 'This relay starts nothing', badge: 'Unavailable' };
      if (launcherIsTerm(tile)) {
        return opts.terminal ? { ok: true, reason: '', badge: '' }
          : { ok: false, reason: 'Terminal mode is off on this relay', badge: 'No terminals' };
      }
      const kinds = opts.agents || [];
      // The arbitrator is started by the same start_agent as the members, so it is checked against
      // the same allowlist. A tile that could start its two and not the third would come up as a
      // conversation the arbitration it promised never joined.
      const missing = launcherRoster(tile).map(m => m.name).filter(n => kinds.indexOf(n) < 0);
      if (missing.length) {
        return { ok: false, reason: `This relay does not start ${missing.join(', ')}`,
                 badge: 'Unknown agent' };
      }
      // `arb` is arbOn — whether this relay sent arb_sessions on this connection, which is the
      // app's gate for arbitration everywhere else. A tile is refused rather than quietly
      // downgraded to a plain conversation: what was asked for was the third agent.
      if (launcherWantsArb(tile) && !e.arb) {
        return { ok: false, reason: 'Arbitration is off on this relay', badge: 'No arbitration' };
      }
      return { ok: true, reason: '', badge: '' };
    }

    // The payload, visible. A tile carries text that some other browser may have written, so the
    // label is not evidence of what it does — the line below it is. Shown on the tile and again in
    // the confirm, which is the whole of this feature's answer to a mislabelled action.
    function launcherPreview(tile) {
      if (!tile) return '';
      if (launcherIsTerm(tile)) return String(tile.command || '');
      const members = Array.isArray(tile.members) ? tile.members : [];
      const line = members.map(m => (m && m.name) || '?').join(' + ');
      // The arbitrator is named apart from the two rather than joined into them: it is not a third
      // participant, it is the one deciding between the other two, and a preview reading
      // "claude + codex + claude" would be three of a kind that this tile is not.
      return launcherWantsArb(tile) ? `${line} ⚖ ${tile.arbitrator.name}` : line;
    }

    // Throws if `msg` carries a key the relay would refuse. The relay's check is
    // `set(msg) - base_fields`, so an unexpected key rejects the entire message rather than being
    // ignored — a start that quietly did nothing because an `id` rode along is a bad afternoon.
    function launcherStrict(msg, allowed) {
      const extra = Object.keys(msg).filter(k => allowed.indexOf(k) < 0);
      if (extra.length) throw new Error('unexpected field(s): ' + extra.sort().join(', '));
      return msg;
    }

    // Undefined keys are dropped rather than sent empty: the relay derives a label from an absent
    // one and refuses a blank, and `slot` is optional in both messages.
    function launcherFields(pairs, allowed) {
      const out = {};
      for (const k of Object.keys(pairs)) {
        const v = pairs[k];
        if (v !== undefined && v !== null && v !== '') out[k] = v;
      }
      return launcherStrict(out, allowed);
    }

    // The open_terminal a `run` tile sends. No `command` — that is typed into the pane afterwards,
    // because open_terminal has nowhere to carry it and a shell is not started with an argument.
    function launcherRunMsg(tile) {
      return launcherFields({
        type: 'open_terminal',
        project_id: tile.project_id,
        placement: LAUNCHER_PLACEMENT,
        label: tile.label,
        slot: tile.slot,
      }, OPEN_TERMINAL_FIELDS);
    }

    // One member's start_agent. Called once per member and never in a loop that does not wait:
    // next_role_label reads the live agent list to pick "Architect 2", so two starts in flight at
    // once can choose the same name and the relay renames around the collision — leaving a roster
    // the user did not pick.
    function launcherSpawnMsg(tile, member) {
      return launcherFields({
        type: 'start_agent',
        name: member.name,
        role: LAUNCHER_ROLE,
        project_id: tile.project_id,
        placement: LAUNCHER_PLACEMENT,
        // The member's own name, and otherwise absent — leaving the relay to name the pane.
        // Never the tile's label: that names the group, and three panes sharing it would be three
        // collisions the relay has to rename its way out of. And never the *role*: a role is what
        // the arbitrator is told this member is for, it means nothing to the agent itself, and it
        // is prose — the arbitration setup's own 240-character field, a comma-separated line as
        // soon as two pills are tapped. validate_pane_label refuses a label over 32 outright, so a
        // role sent here is not a bad name, it is the whole start_agent rejected and the batch
        // behind it.
        label: member.label,
        slot: tile.slot,
      }, START_AGENT_FIELDS);
    }

    // A tile's members are spawned in order and one at a time, so the queue is just the list with
    // a cursor. Kept pure so the sequencing can be tested without a socket: `launcherBatchNext`
    // answers "what goes out now", and `launcherBatchDone` answers "was that the last one".
    // Everything a spawn starts, in the order it starts it. The arbitrator is last and flagged,
    // which is what lets one cursor drive all three: it is started by the same start_agent as the
    // other two, and the only thing that makes it different happens after every pane exists.
    //
    // Last on purpose. It is briefed with the roster it is deciding between, so it is the pane
    // that most wants the other two to already be there.
    function launcherRoster(tile) {
      const members = (tile && Array.isArray(tile.members) ? tile.members : []).slice();
      if (!launcherWantsArb(tile)) return members;
      return members.concat([Object.assign({}, tile.arbitrator, { arb: true })]);
    }

    function launcherBatch(tile) {
      return { id: launcherId(), tile: tile, sent: 0, panes: [],
               members: launcherRoster(tile) };
    }

    function launcherBatchNext(batch) {
      return batch && batch.sent < batch.members.length ? batch.members[batch.sent] : null;
    }

    function launcherBatchDone(batch) {
      return !!batch && batch.panes.length === batch.members.length;
    }

    // Every spawn lands on a conversation, including a spawn of one. A conversation of one has
    // nothing to compare — but it is what carries the name the launch was given, it is where the
    // record of that name lives once the pane id has been reused, and a single agent started from
    // a tile is the same kind of thing as three started from one.
    function launcherWantsConv(tile) {
      return (Array.isArray(tile.members) ? tile.members.length : 0) > 0;
    }

    // An arbitrator reads *two* members and decides who is written to next — MEMBERS_REQUIRED in
    // the relay, and not something this changes. What it does not fix is the size of the room: a
    // conversation of five can have two of them arbitrated, which is exactly what the setup dialog
    // has always allowed by asking Agent 1 and Agent 2 as selects. So a tile is the same: two or
    // more members, and the pair is the first two of them.
    //
    // First two rather than a stored pair of indices, because launcherArbOrder already puts the
    // roster in slot order and the selects in the editor reorder it. An index would be a second
    // way to say the same thing, and one that goes stale the moment a member above it is dropped.
    function launcherWantsArb(tile) {
      return !!(tile && tile.arbitrator)
        && (Array.isArray(tile.members) ? tile.members.length : 0) >= 2;
    }

    // The arb_start a finished roster turns into. `panes` is what the batch collected, in the order
    // it was started — so the first two are the members and the last is the arbitrator, which is
    // the whole reason launcherRoster puts it there.
    //
    // Pane ids and a scope, and nothing else about who they are: the relay reads a participant's
    // identity off its own pane list, because a fingerprint a browser supplies is one it can have
    // stale. Same rule arbStart follows, and the reason this builds the same message rather than a
    // launcher-shaped one.
    function launcherArbMsg(tile, convId, panes) {
      // The first two, and never the whole roster: the relay takes exactly two and the rest of the
      // conversation is simply not what this session is deciding between. They are panes[0] and
      // panes[1] because the batch starts the roster in order — see launcherRoster.
      const members = (tile.members || []).slice(0, 2).map((m, i) => {
        const out = { pane_id: panes[i].pane_id };
        if (m.role) out.role = m.role;
        return out;
      });
      const msg = {
        type: 'arb_start', conversation: convId, scope: String(tile.scope || '').trim(),
        members: members,
        arbitrator: { pane_id: panes[panes.length - 1].pane_id },
        // A turn ending is the trigger that needs no guessing and is always on. The two clocks are
        // whatever the tile was given and off when it was given none, exactly as the setup dialog
        // opens: a clock nobody asked for is an unattended loop spending budget.
        triggers: { on_turn_end: true,
                    idle_ms: launcherMinutes(tile.idle), runtime_ms: launcherMinutes(tile.runtime) },
        // A tile lays out a room but does not make its first decision for it.  The person can
        // review the members and scope, then arm it from the conversation.
        paused: true,
      };
      // Only when the tile carries them. An absent budget is the relay's DEFAULT_BUDGET, which is
      // the one place those numbers are authoritative — restating them here would be a second copy
      // to keep in step for no gain, and the editor already clamps what it writes against
      // ARB_LIMITS.
      const budget = launcherBudget(tile);
      if (budget) msg.budget = budget;
      // Off unless asked for, same as the dialog. `warmup: false` and an absent one mean the same
      // thing to the relay, so the field only rides when it says something.
      if (tile.warmup) msg.warmup = true;
      return msg;
    }

    // Minutes on a tile, milliseconds on the wire. Anything that is not a positive number is off.
    function launcherMinutes(v) {
      const n = Number(v);
      return n > 0 ? Math.round(n) * 60000 : 0;
    }

    // The three hard stops, or null when the tile names none of them. Partial is allowed — a tile
    // that only ever changed the step count still sends the other two, because `budget` is one
    // object to the relay and half of it would read as the other half being zero.
    function launcherBudget(tile) {
      const steps = Number(tile.steps), runs = Number(tile.runs), minutes = Number(tile.minutes);
      if (!(steps > 0) && !(runs > 0) && !(minutes > 0)) return null;
      const out = {};
      if (steps > 0) out.max_steps = Math.round(steps);
      if (runs > 0) out.max_consecutive = Math.round(runs);
      if (minutes > 0) out.max_wall_clock_ms = Math.round(minutes) * 60000;
      return out;
    }
    // --- Launcher tiles (pure) --- end
