    // --- Launcher, pressed ---
    // The wiring between a tile and the two messages launcher_pure already knows how to build.
    // Nothing here constructs a payload: launcherRunMsg and launcherSpawnMsg do that, under
    // launcherStrict, so a stray key is a test failure rather than a start that silently did
    // nothing. This file decides *when* they go out and what happens to what comes back.
    //
    // A press never invents state. Every message goes through the same pendingStart/startIntent
    // path the Start dialog and Duplicate use — the pane appears on the next poll snapshot, and
    // openPendingStart lands on it. Inventing a pane here would mean two code paths for "a
    // session just started", and the older one is the one that has been debugged.

    // The multi-member spawn in flight, or null. One at a time: a second batch started over the
    // first would interleave two rosters through one cursor, and there is exactly one user.
    let launcherLive = null;

    // The three signals a tile is gated on, read in one place so the tile and the press cannot
    // disagree about them. `arb` is arbitration.js's own gate — whether this relay sent
    // arb_sessions on this connection — read through typeof so this file still works in a build
    // that does not carry arbitration at all.
    function launcherEnv() {
      return {
        projects: projects, startOptions: startOptions,
        arb: typeof arbOn !== 'undefined' && arbOn,
      };
    }

    // What the confirm says. Pure and returned as lines rather than written, so a test can read
    // what a user would have been shown without a DOM.
    //
    // The payload is quoted verbatim. A tile's *label* may have been written by another browser
    // and is a claim; this is the evidence, and it is the whole of this feature's answer to a
    // mislabelled action — which is why there is no "don't ask again".
    function launcherConfirmLines(tile, env) {
      const e = env || {};
      const project = (e.projects || []).find(p => p.id === tile.project_id) || {};
      // Not the cwd: public_projects strips it, deliberately, so the path a Project points at
      // never leaves the relay (D4). The label and the host are what a client is allowed to know,
      // and together they are what tells two otherwise identical tiles apart.
      const where = `${project.label || tile.project_id}`
        + (project.host && project.host !== 'local' ? ` on ${project.host}` : '');
      if (tile.action === 'run') {
        return [`Run this in a new terminal on ${where}?`, '', tile.command];
      }
      // The arbitrator counts. It is a third pane started on the same relay in the same Project,
      // and a confirm that said "2 sessions" before starting three would be the one number on
      // screen that was wrong.
      const roster = launcherRoster(tile);
      const many = roster.length > 1;
      const arb = launcherWantsArb(tile);
      return [`Start ${many ? roster.length + ' sessions' : 'a session'} on ${where}?`,
              '', roster.map(m => m.name).join(', '),
              '',
              arb ? `${tile.arbitrator.name} will decide between `
                + `${(tile.members || []).slice(0, 2).map(m => m.label || m.name).join(' and ')}`
                + `, on: `
                + `${String(tile.scope || '').trim()}\n`
                // Said before the press, because it is the difference between a room that starts
                // talking and one that waits: a tile lays out the roster, it does not make the
                // first decision for it.
                + 'It starts paused — arm it from the conversation.'
                : many ? 'They are started one at a time and grouped into a conversation.'
                : 'It gets a conversation of its own, under the name you give it.']
        .filter(l => l !== null);
    }

    // The whole of a press. Everything that can refuse does so before anything is sent.
    function launcherPress(id) {
      const tile = loadLauncher().find(t => t.id === id);
      if (!tile) return false;
      const env = launcherEnv();
      const gate = launcherGate(tile, env);
      // A Project that has gone is the one closed gate the person pressing can actually fix, and
      // fixing it is picking a different one — so the press opens the tile on that field rather
      // than reporting a dead end. Every other refusal is about the relay, not the tile.
      if (!gate.ok && gate.badge === 'Missing Project' && typeof launcherRepoint === 'function') {
        launcherRepoint(tile.id);
        return false;
      }
      // The tile is already drawn with this reason in its title and a badge on it, so a press is
      // either a stale render or a keyboard reaching an aria-disabled button. Say it either way —
      // a button that does nothing is worse than one that says why.
      if (!gate.ok) { showToast(gate.reason); return false; }
      if (!ws || ws.readyState !== 1) { showToast('Not connected — nothing was started.'); return false; }
      // A batch already running owns pendingStart and the cursor. Refusing is the honest answer:
      // queueing the second one would start six panes from two taps that looked like one.
      if (launcherLive) { showToast('Still starting the last one — give it a moment.'); return false; }
      // Every press goes through the sheet: it is where the Project a template does not name is
      // chosen, where the launch is named, and where the confirm is read. A press that ends there
      // has started nothing — launcherPressIn is what its Start button calls.
      if (typeof launcherLaunchSheet === 'function') return launcherLaunchSheet(tile);
      // A build without the tile editor still starts a tile that already names its Project. The
      // launch is then unnamed, which launcherNamed answers with the noun and the tag.
      return tile.project_id ? launcherGo(tile, env, '') : false;
    }

    // The press, once the sheet has answered both of its questions.
    function launcherGo(tile, env, typed) {
      // Gated again: the sheet is a round trip through the DOM, and the answer it came back with is
      // a Project id this side never checked.
      const gate = launcherGate(tile, env || launcherEnv());
      if (!gate.ok) { showToast(gate.reason); return false; }
      // From here down it is the *named* tile, never the stored one. Everything downstream reads
      // `label` — the pane's name, the conversation's, the status line's — so naming it once here
      // is what keeps the launch's name and the tile's name from having to be the same thing.
      const named = launcherNamed(tile, typed);
      return named.action === 'run' ? launcherRunTile(named) : launcherSpawnTile(named);
    }

    // What the sheet calls back into: the tile as stored, run in the Project just chosen. The
    // choice is never written back — a template that quietly became a button after one press is
    // the feature undoing itself.
    function launcherPressIn(id, projectId, name) {
      if (typeof closeLauncherEdit === 'function') closeLauncherEdit();
      const tile = loadLauncher().find(t => t.id === id);
      if (!tile || !projectId) return false;
      return launcherGo(Object.assign({}, tile, {project_id: projectId}), launcherEnv(), name || '');
    }

    // A `run` is an open_terminal and then the command typed at the prompt it comes up on. The
    // command cannot ride along: open_terminal has nowhere to carry it, and a shell is not started
    // with an argument. So the text waits in the intent until there is a pane to type it into.
    function launcherRunTile(tile) {
      startIntent = {ql: {tile: tile, command: tile.command}};
      showSpawnStatus(`Opening a terminal for ${tile.label}…`, 'busy');
      ws.send(JSON.stringify(launcherRunMsg(tile)));
      return true;
    }

    // Members go out one at a time and never in a loop that does not wait: next_role_label reads
    // the live agent list to pick "Architect 2", so two starts in flight can choose the same name
    // and the relay renames around the collision — leaving a roster the user did not pick.
    function launcherSpawnTile(tile) {
      launcherLive = launcherBatch(tile);
      return launcherSpawnNext();
    }

    function launcherSpawnNext() {
      const batch = launcherLive;
      const member = launcherBatchNext(batch);
      if (!member) return false;
      batch.sent += 1;
      startIntent = {ql: {tile: batch.tile, batch: batch}};
      showSpawnStatus(batch.members.length > 1
        ? `Starting ${member.name} (${batch.sent} of ${batch.members.length})…`
        : `Starting ${member.name}…`, 'busy');
      ws.send(JSON.stringify(launcherSpawnMsg(batch.tile, member)));
      return true;
    }

    // What a member opens with, resolved now rather than stored on the tile: a starter's text is
    // edited in one place, and a tile saved last month should open with what that chip says today.
    // Typed through sendTextTo for the same reason a `run` tile's command is — the arbitration
    // guard, the chunk cap and the record of what was sent all apply, because this is the user
    // opening the session, by proxy.
    function launcherStarter(paneId, member) {
      const at = member && member.at;
      if (!at || typeof SHORTCUTS === 'undefined') return false;
      const text = ((SHORTCUTS.find(s => s.at === at) || {}).text || '').trim();
      return text ? sendTextTo(paneId, text) : false;
    }

    // A refusal anywhere in a batch ends the batch. Carrying on would leave a conversation holding
    // half a roster under a name that promised the whole one, and the user is already reading an
    // error — a second pane appearing under it reads as the error not having happened.
    function launcherFailed() {
      if (!launcherLive) return;
      const batch = launcherLive;
      launcherLive = null;
      startIntent = null;
      if (batch.panes.length) {
        showToast(`Started ${batch.panes.length} of ${batch.members.length} — the rest did not.`);
      }
    }

    // One pane has landed for a launcher intent. Called from openPendingStart, which owns the
    // "the poll has seen it" half; this owns what the tile asked for.
    async function launcherLanded(a, ql) {
      // A `run`: the pane is a shell, and the command is what the tile is for. Through sendTextTo
      // rather than the socket directly, so the arbitration guard, the chunk cap and the record of
      // what the user sent all apply — this *is* the user typing a command, by proxy.
      if (ql.command) {
        openTerminal(a.pane_id);
        sendTextTo(a.pane_id, ql.command);
        // The same note sendText makes for anything typed at a shell, so the command shows up in
        // the terminal's own history. A launcher press is still a command the user ran.
        if (typeof noteTermCommand === 'function' && isShell(a.pane_id)) noteTermCommand(ql.command);
        showSpawnStatus(`${ql.tile.label} — running.`, 'success');
        return;
      }
      const batch = ql.batch;
      // A batch cancelled or superseded while this start was in flight. The pane is real and stays;
      // it is simply not adopted into a grouping that no longer exists.
      if (!batch || batch !== launcherLive) { openTerminal(a.pane_id); return; }
      batch.panes.push(a);
      // Its first prompt, as soon as it is up. `agent start` has already blocked until herdr saw
      // the pane interactively ready, so there is nothing here to wait for — and waiting until the
      // whole roster has landed would open every session on a prompt none of them was given yet.
      launcherStarter(a.pane_id, batch.members[batch.panes.length - 1]);
      if (!launcherBatchDone(batch)) { launcherSpawnNext(); return; }
      launcherLive = null;
      // Only a tile with no roster at all, which launcherValid already refuses. Kept as the guard
      // it is: everything below assumes there is something to put in the conversation.
      if (!launcherWantsConv(batch.tile)) {
        openTerminal(a.pane_id);
        showSpawnStatus(`${batch.tile.label} started.`, 'success');
        return;
      }
      const conv = launcherMakeConv(batch);
      if (!conv) { openTerminal(a.pane_id); return; }
      renderConversations();
      openConversation(conv.id);
      if (launcherWantsArb(batch.tile)) return launcherAppoint(batch, conv);
      showSpawnStatus(batch.panes.length > 1
        ? `${batch.tile.label} started — ${batch.panes.length} in "${conv.name}".`
        : `${batch.tile.label} started, in a conversation of its own.`, 'success');
    }

    // The third pane, told what it is for. Exactly the message the setup dialog sends — same
    // fields, same shape, built by launcherArbMsg — because a session appointed from a tile and
    // one appointed by hand must be the same session, not two kinds the rest of arbitration.js
    // has to tell apart.
    //
    // Nothing is drawn in its place. The session exists when the relay says it does, and it
    // answers with arb_session, which arbitration.js already listens for.
    function launcherAppoint(batch, conv) {
      // A refusal comes back as a plain `error`, which status_bar already toasts. The two panes
      // and the conversation survive it, so the fallback is the setup dialog that conversation
      // already has — one tap, with the roster it needs already in it. That is why this does not
      // retry: the pane the relay is most likely to have refused is an arbitrator whose TUI is
      // still coming up, and a retry loop here would be guessing at how long.
      arbSend(launcherArbMsg(batch.tile, conv.id, batch.panes));
      // Paused, so the arbitrator is briefed and nothing else — the brief goes out on every start
      // and `paused` decides only whether the loop behind it is armed. Saying "is deciding" here
      // would be the one line on screen that is wrong.
      showSpawnStatus(`${batch.tile.label} started — ${batch.tile.arbitrator.name} is briefed and `
                      + 'the session is paused.', 'success');
    }

    // The conversation a multi-member tile lands on, named for the tile. Built with the same
    // helpers the respawn path uses rather than a shape of its own, so a conversation made by a
    // launcher is indistinguishable from one made by hand — which is the point: it is the same
    // thing, reached faster.
    function launcherMakeConv(batch) {
      const items = loadConvIndex();
      if (items.length >= CONV_CONV_MAX) {
        showToast(`Already at ${CONV_CONV_MAX} conversations — the panes started, ungrouped.`);
        return null;
      }
      const taken = new Set(items.map(c => c.name));
      // The tile's own name first, then numbered. Pressing the same tile twice is a second run of
      // the same thing, and two conversations called the same are two the user cannot tell apart.
      let name = batch.tile.label;
      for (let n = 2; taken.has(name) && n < 100; n++) name = `${batch.tile.label} ${n}`;
      // The members, not the roster. An arbitrator is deliberately outside the conversation it
      // decides about — it is not a participant in it, it is the one reading it — and a
      // conversation carrying it would show its brief as a third voice in the thread.
      const inside = batch.panes.slice(0, (batch.tile.members || []).length);
      const conv = {
        id: 'c_' + Math.random().toString(36).slice(2, 10),
        name: name, created: Date.now(), members: inside.map(convMemberOf),
      };
      saveConvIndex([conv].concat(items));
      // Each pane opens on this grouping rather than on whatever it would default to: they were
      // started together, and a member that opens alone is the grouping not having happened.
      inside.forEach(p => convSetView(p, conv.id));
      return conv;
    }
