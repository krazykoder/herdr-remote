# Plan: End — take a session from live to closed

Spec: `../03_specs/2026-08-24_ending_a_session_spec.md`.
Decision log: `../02_architecture/decision_log/2026-08-24_ending_a_session.md`.
Class A. **No file under `relay/` changes. No new WebSocket message.**

## Goal

One `endPane(paneId)` that types `/quit` then `exit`, and four buttons that call it. Everything the
buttons need — `submitText`, `paneOf`, `isShell`, `burstPoll`, `armButton`, the `arm-btn` styling —
already exists.

## File-by-file

### `[MODIFY] web/src/controls.js`

Append after `armQuit` (ends line 118), in the same "Clear screen, and Quit" block. This file
already owns every keystroke this app sends at a pane, and End is two of them.

```js
    // --- Ending a session ---
    // End is QUIT carried one line further. `/quit` exits an agent's TUI and herdr keeps the pane:
    // it survives as a bare shell still wearing the name the session was started under, which is
    // how the Terminals section fills up with the remains of agents nobody is running. So the shell
    // is exited too, on the snapshot that shows the agent has gone.
    //
    // Two sends rather than one message because there is no relay verb for this and these are the
    // two lines a person types. Through submitText and not sendTextTo, so noteSent is not called:
    // these are control keystrokes, and a transcript claiming the user said "/quit" to an agent is
    // a transcript that is wrong. Same reason armQuit takes that path.
    const END_TIMEOUT_MS = 30000;

    // pane_id -> {at, label}. The panes whose agent has been told to quit and whose shell has not
    // been exited yet. Never persisted: a reload has no send in flight to finish.
    const endWatch = new Map();

    function endPane(paneId) {
      const pane = paneOf(paneId);
      if (!pane) return false;                       // already the goal state
      // The relay refuses send_text at a blocked pane — its box is a permission prompt. Saying so
      // is the whole answer: the user is one tap from unblocking it themselves.
      // ponytail: no way to end a wedged pane; `herdr pane close` is the upgrade if this bites.
      if (pane.status === 'blocked') {
        showToast('That pane is waiting on a prompt — answer it, then end it.');
        return false;
      }
      if (isShell(paneId)) return endShell(paneId);
      if (!submitText(paneId, '/quit')) return false;
      burstPoll(paneId);
      // With terminal mode off the relay lists no shells, so the pane leaves `agents` and appears
      // nowhere — indistinguishable from herdr having closed it. Nothing to watch for, so this
      // stops at one line and says so rather than pretending the pane is gone.
      // ponytail: leaves a shell behind on a relay with HERDR_ENABLE_TERMINAL off.
      if (!startOptions || !startOptions.terminal) {
        showToast(`Quit ${paneLabel(pane)} — its pane may remain.`, 'info');
        return true;
      }
      endWatch.set(paneId, {at: Date.now(), label: paneLabel(pane)});
      showToast(`Ending ${paneLabel(pane)}…`, 'info');
      return true;
    }

    function endShell(paneId) {
      if (!submitText(paneId, 'exit')) return false;
      endWatch.delete(paneId);
      burstPoll(paneId);
      return true;
    }

    // The second line, on the snapshot that shows the first one worked. A pane sitting in `shells`
    // is one whose agent has exited, which is exactly what `/quit` was aiming for.
    function endTick() {
      if (!endWatch.size) return;
      const now = Date.now();
      for (const [paneId, at] of Array.from(endWatch)) {
        if (isShell(paneId)) { endShell(paneId); continue; }
        // Gone from both lists: herdr closed the pane itself, which some harnesses do on /quit.
        if (!paneOf(paneId)) { endWatch.delete(paneId); continue; }
        if (now - at.at > END_TIMEOUT_MS) {
          endWatch.delete(paneId);
          showToast(`${at.label} did not quit — it is still running.`);
        }
      }
    }

    // Every live member, each by whichever of the two it is. An ended member is skipped in silence:
    // it is the state this is aiming for, not a failure to report.
    function endConversation(convId) {
      const conv = loadConvIndex().find(c => c.id === convId);
      if (!conv) return false;
      const live = (conv.members || [])
        .map(m => agents.concat(shells).find(x => convMemberKey(x) === m.key)).filter(Boolean);
      if (!live.length) { showToast('Nothing in this conversation is still running.'); return false; }
      live.forEach(p => endPane(p.pane_id));
      return true;
    }
```

`controls.js` loads at position 34 of 35, after `status_bar.js`, `shortcuts.js`, `terminal.js` and
`conversation_store.js` — so every binding above resolves at call time. Nothing here runs at load.

### `[MODIFY] web/src/status_bar.js`

One line, in the `agents` snapshot handler. Insert directly after `shells = Array.isArray(...)`
(line 813) and before `convAutoJoin()`:

```js
        // A pane told to quit is finished when it turns up as a shell, and only a snapshot says so.
        if (typeof endTick === 'function') endTick();
```

Guarded through `typeof` for the same reason `syncBranchBadges` is at line 828: `controls.js` loads
after this file, and a build that dropped it must still boot.

### `[MODIFY] web/src/shortcuts.js` — roster row

In `convRosterHtml` (line 628), the per-member controls. **Order is End, Remove, Open / Start
again** — the two destructive ones first, then the way in. Replace the three trailing button
expressions (lines 653-661) with:

```js
          // End before Remove, and both before Open: this row's two irreversible-looking actions
          // sit together, and the one that merely opens a pane is not among them. End is offered
          // only where there is something running to end — an ended member's row already carries
          // Start again in the same place.
          (on ? `<button class="conv-end arm-btn" data-key="${escapeHtml(m.key)}"` +
            ` onclick="armButton(this, 'End?', () => endConvMember(this.dataset.key))"` +
            ` aria-label="End this member's session">End</button>` : '') +
          `<button class="conv-drop arm-btn" data-key="${escapeHtml(m.key)}"` +
          ` onclick="armButton(this, 'Remove?', () => convRemoveMember(this.dataset.key))"` +
          ` aria-label="Remove this member from the conversation">Remove</button>` +
          (on ? `<button class="conv-open" data-key="${escapeHtml(m.key)}"` +
            ` onclick="openConvMemberPane(this.dataset.key)"` +
            ` aria-label="Open this member's pane">Open</button>` : '') +
          (!on && canRespawn(rec.spawn) ? `<button class="conv-again arm-btn" data-key="${escapeHtml(m.key)}"` +
            ` onclick="convArmRespawn(this, this.dataset.key)"` +
            ` aria-label="Start a new session and continue this conversation">Start again</button>` : '')
```

and add, beside `convRespawn`:

```js
    // A member is named by its fingerprint, not its pane — the roster outlives the panes in it.
    function endConvMember(key) {
      const live = agents.concat(shells).find(x => convMemberKey(x) === key);
      if (live) endPane(live.pane_id);
    }
```

### `[MODIFY] web/src/shortcuts.js` — roster actions

In the same function, `conv-roster-actions` (line 669). Insert **End** immediately after the
existing `conv-del` Delete button:

```js
        `<button class="conv-end arm-btn" onclick="armButton(this, 'End all?', () => endConversation(convViewId))"` +
        ` aria-label="End every session in this conversation">End all</button>` +
```

### `[MODIFY] web/src/shortcuts.js` — landing cards

`agentCard` (line 230): insert an End button before the existing `pair-btn` (line 250):

```js
    <button class="end-btn arm-btn" aria-label="End ${label}" onclick="event.stopPropagation();armButton(this, 'End?', () => endPane('${a.pane_id}'))">End</button>
```

`terminalCard` (line 299): the same button before the trailing chevron. `terminalCard` has no
nested button today, so this is its first — `event.stopPropagation()` is what keeps the card's own
`onclick="openTerminal(...)"` from firing underneath it, exactly as `openPairDialog` does with the
`event` it is handed.

### `[MODIFY] web/index.html` — CSS

Add `.conv-end` to the existing roster-button rule at line 4256, so it inherits the 32px floor and
the border:

```css
    .conv-roster .conv-drop,
    .conv-roster .conv-again,
    .conv-roster .conv-open,
    .conv-roster .conv-end,
    .conv-roster-actions button {
```

Then, after the `.conv-roster-actions .conv-del` rule (line 4285), the colour that tells the two
apart:

```css
    /* Orange, not the red Delete wears. Delete destroys a record and cannot be undone; End stops a
       session that Start again brings back on the same row. Two different promises, two colours. */
    .conv-roster .conv-end,
    .conv-roster-actions .conv-end {
      color: var(--orange);
      border-color: var(--orange);
    }
```

And beside `.pair-btn` (line 6360), for the landing cards:

```css
    /* Styled as pair-btn's sibling because that is what it is — the other thing a card offers
       without opening. Orange for the same reason it is orange on the roster. */
    .end-btn {
      background: none;
      border: 1px solid var(--orange);
      border-radius: 6px;
      color: var(--orange);
      font-size: 0.65rem;
      padding: 4px 8px;
      cursor: pointer;
      flex-shrink: 0;
    }
```

### `[NEW] tests/test_end_pane.js`

The vm-slice suite, in the shape of `tests/test_launcher_exec.js`. `endTick` is a state machine over
snapshots, which is exactly what a vm slice tests well and a browser tests slowly.

Cases:

| # | Set-up | Assert |
|---|--------|--------|
| 1 | agent pane, terminal mode on | `/quit` sent once; pane recorded as ending |
| 2 | then a snapshot where it is in `shells` | `exit` sent; no longer watched |
| 3 | then a snapshot where it is gone | no third send |
| 4 | agent pane, `startOptions.terminal` falsy | `/quit` sent; nothing watched; message mentions the pane may remain |
| 5 | pane `status: 'blocked'` | nothing sent at all |
| 6 | shell pane | `exit` sent, once, no watch |
| 7 | agent that never leaves `agents`, clock advanced past `END_TIMEOUT_MS` | watch dropped, message says still running |
| 8 | pane vanishes from both lists while watched | watch dropped, no `exit` |
| 9 | `endConversation` over two live and one ended member | two ends, ended member untouched |
| 10 | `endPane` with the socket closed (`submitText` false) | nothing watched |

### `[MODIFY] tests/e2e/browser/launcher.spec.js` or a sibling spec

One Playwright case: start a terminal against the fake herdr, press End on its landing card, confirm
the second tap, and assert the card leaves the Terminals section. This is the part a vm slice cannot
see — that the button is reachable, on top of the card rather than under it, and that the tap does
not open the pane instead.

## Verification

```bash
node --test tests/test_end_pane.js
node --test tests/*.js
npx playwright test
.venv313/bin/python -m unittest discover -s tests -t tests   # must be untouched: relay/ has no diff
```

## Acceptance criteria

1. `git diff --stat relay/` is empty.
2. All ten vm cases pass; the whole `node --test tests/*.js` suite and Playwright stay green.
3. An agent ended from its roster row leaves `agents`, then `shells`, and its row flips to `no
   longer live` with **Start again** offered by the existing `canRespawn` path.
4. That conversation goes grey on the landing page with no field written to the index — confirm by
   diffing `localStorage.herdr_conversations` before and after.
5. `/quit` and `exit` appear in no transcript.
6. Ending a blocked pane sends nothing and names the prompt.
7. Tapping End on a landing card does not open the pane.
