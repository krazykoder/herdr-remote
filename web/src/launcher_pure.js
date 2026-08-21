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

    // The two the renderer knows how to press. A tile carrying anything else is *kept* and drawn
    // disabled — see launcherGate. Dropping it would let a browser on an older build destroy an
    // action every other browser can see, which is the failure stateSyncPlan exists to stop one
    // level up.
    const LAUNCHER_ACTIONS = ['run', 'spawn'];

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

    function launcherId() {
      return 'ql_' + Math.random().toString(36).slice(2, 10);
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
      if (!tile.project_id) return 'Pick a Project';
      if (LAUNCHER_ACTIONS.indexOf(tile.action) < 0) return 'Unknown action';
      if (tile.action === 'run') {
        const command = typeof tile.command === 'string' ? tile.command.trim() : '';
        if (!command) return 'Give it a command to run';
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
      if (!projects.some(p => p.id === tile.project_id)) {
        return { ok: false, reason: 'That Project is not configured on this relay',
                 badge: 'Missing Project' };
      }
      // start_options' absence is already the app's gate for Start, and open_terminal's two gates
      // are reported inside it as `terminal`. Same signals, read from a tile.
      if (!opts) return { ok: false, reason: 'This relay starts nothing', badge: 'Unavailable' };
      if (tile.action === 'run') {
        return opts.terminal ? { ok: true, reason: '', badge: '' }
          : { ok: false, reason: 'Terminal mode is off on this relay', badge: 'No terminals' };
      }
      const kinds = opts.agents || [];
      const missing = (tile.members || []).map(m => m.name).filter(n => kinds.indexOf(n) < 0);
      if (missing.length) {
        return { ok: false, reason: `This relay does not start ${missing.join(', ')}`,
                 badge: 'Unknown agent' };
      }
      return { ok: true, reason: '', badge: '' };
    }

    // The payload, visible. A tile carries text that some other browser may have written, so the
    // label is not evidence of what it does — the line below it is. Shown on the tile and again in
    // the confirm, which is the whole of this feature's answer to a mislabelled action.
    function launcherPreview(tile) {
      if (!tile) return '';
      if (tile.action === 'run') return String(tile.command || '');
      const members = Array.isArray(tile.members) ? tile.members : [];
      return members.map(m => (m && m.name) || '?').join(' + ');
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
        role: member.role,
        project_id: tile.project_id,
        placement: LAUNCHER_PLACEMENT,
        // The member's own label when it has one; otherwise absent, and the relay names it for the
        // role. Never the tile's label — that names the group, and three panes sharing it would be
        // three collisions the relay has to rename its way out of.
        label: member.label,
        slot: tile.slot,
      }, START_AGENT_FIELDS);
    }

    // A tile's members are spawned in order and one at a time, so the queue is just the list with
    // a cursor. Kept pure so the sequencing can be tested without a socket: `launcherBatchNext`
    // answers "what goes out now", and `launcherBatchDone` answers "was that the last one".
    function launcherBatch(tile) {
      return { id: launcherId(), tile: tile, sent: 0, panes: [],
               members: (tile.members || []).slice() };
    }

    function launcherBatchNext(batch) {
      return batch && batch.sent < batch.members.length ? batch.members[batch.sent] : null;
    }

    function launcherBatchDone(batch) {
      return !!batch && batch.panes.length === batch.members.length;
    }

    // A conversation is what several panes land on, and one pane does not need one: a conversation
    // of one is a record with nothing to compare, and the pane's own thread already shows it.
    function launcherWantsConv(tile) {
      return (Array.isArray(tile.members) ? tile.members.length : 0) > 1;
    }

    // An arbitrator reads two members and decides who is written to next, so a roster of any other
    // size has nothing for it to do. Ignored rather than refused: a tile edited from three members
    // back to two should not have silently lost its arbitrator on the way.
    function launcherWantsArb(tile) {
      return !!(tile && tile.arbitrator)
        && (Array.isArray(tile.members) ? tile.members.length : 0) === 2;
    }
    // --- Launcher tiles (pure) --- end
