# Plan — A roster that can be woken

**2026-08-29 · Phase 4 · Implementer**

Obeys `.workflow/03_specs/2026-08-29_roster_that_can_be_woken_spec.md` and
`.workflow/02_architecture/decision_log/2026-08-29_a_roster_that_can_be_woken.md`.

> **Sequencing: land `2026-08-29_durable_spawn_binding_plan.md` first.** A3 restarts up to three
> members and then enrols the panes they produce. Without the durable note, three starts in flight
> share one `startIntent` and one `sessionStorage` slot, and the session enrols panes bound to
> nobody. This plan calls `convRestart`, `convRestartQueue` and `convPendingRefs` as that plan
> leaves them.

## Goal

The three slots in the arbitration setup dialog stop hiding candidates. The arbitrator may be any
pane in the roster's project whatever it is doing, members of the conversation included. Agent 1
and Agent 2 may be any member of the conversation, paused ones included. Picking something that is
not running restarts it and waits — which is the trio start, arrived at without a second mechanism.

---

## File-by-file

| Marker | Path | What |
|---|---|---|
| `[MODIFY]` | `relay/arbitration.py` | comment only — `_enrol`'s existing duplicate check becomes load-bearing |
| `[MODIFY]` | `web/src/arbitration.js` | the candidate lists, the picks' value space, A2's checks, the held start |
| `[MODIFY]` | `web/src/status_bar.js` | snapshot drives the held start |
| `[MODIFY]` | `web/index.html` | one line of CSS for the waiting note |
| `[NEW]` | `tests/test_arb_roster.py` | the relay's duplicate refusal, pinned now that it matters |
| `[MODIFY]` | `tests/test_arbitration_ui.js` | the widened lists, the value space, A2 |
| `[NEW]` | `tests/test_arb_hold.js` | the held start: restart, wait, resolve, deadline |
| `[MODIFY]` | `tests/e2e/browser/arbitration.spec.js` | a paused member picked and the session starting |

---

## 1. `[MODIFY] relay/arbitration.py` — comment only

`_enrol` already refuses a repeated pane id (line 834). No behaviour changes; the check gains a
comment saying what it now defends against, because removing the picker's "arbitrator is never a
member" filter is what turns it from a client-bug catcher into the rule.

## 2. `[MODIFY] web/src/arbitration.js`

### 2a. The value space

A slot's option value is a live pane's `pane_id`, or `paused:<member key>` for a member with no
pane. Add above `arbPaneSelect` (line 1040):

```javascript
    // What a slot is holding. Two kinds, because a roster may now name something that is not
    // running: a live pane is its own id, and a paused member is the key the conversation knows it
    // by. Prefixed rather than sniffed — a pane id and a member key are both opaque strings, and
    // guessing which one a value is would be a guess made on every read of the form.
    const ARB_PAUSED = 'paused:';

    function arbPickValue(row) {
      return row.pane ? row.pane.pane_id : ARB_PAUSED + row.key;
    }

    // A slot's value as something to act on: a pane to enrol, or a member to wake first.
    function arbResolvePick(v) {
      const s = String(v || '');
      if (!s) return null;
      if (s.indexOf(ARB_PAUSED) === 0) return {key: s.slice(ARB_PAUSED.length), pane_id: ''};
      return {key: '', pane_id: s};
    }

    // Whether two slots are pointing at the same agent, across both kinds of value.
    function arbSamePick(a, b) { return !!a && !!b && String(a) === String(b); }
```

### 2b. The candidate lists

Replace `arbCandidates` (lines 286–293) and add its two companions:

```javascript
    // Every pane in the roster's project. Not filtered by status and not filtered by membership of
    // this conversation: which pane is well placed to referee is the person's judgement, and a
    // pane that went `working` for one poll used to vanish from the list under their thumb. What
    // it cannot be is a pane another session already holds — two arbitrators typing into one
    // terminal — and that is a fact rather than a status three seconds old.
    //
    // Whether the pane can actually take the brief is still the relay's answer: it refuses a busy
    // arbitrator (N7) at the moment of the send, which is the only moment the answer is true.
    function arbCandidates(conv, project, except) {
      if (project === undefined) project = arbProject(conv);
      if (project === null) return [];
      return arbUntaken(agents.filter(x => convMemberKey(x) &&
        (x.project_id || '') === project), except);
    }

    // The conversation's roster as pickable rows: the live pane where there is one, and the member
    // itself where there is not. A paused member with no record to restart from is left out — the
    // slot would be naming something nothing can bring back.
    function arbMemberRows(conv, except) {
      const live = new Map(agents.map(x => [convMemberKey(x), x]));
      const taken = arbTakenPanes(except);
      return (conv.members || []).map(m => {
        const pane = live.get(m.key) || null;
        if (pane && taken.has(pane.pane_id)) return null;
        if (!pane && !arbCanWake(m.key)) return null;
        return {key: m.key, pane: pane, label: pane ? paneLabel(pane)
          : `${convMemberName(m.key, '', m.label, 'Former pane')} — paused`};
      }).filter(Boolean);
    }

    // The arbitrator's rows: every pane in the project, plus this conversation's paused members —
    // a session assembled from nothing is three restarts, not two and a hunt for a third pane.
    function arbArbiterRows(conv, project, except) {
      const rows = arbCandidates(conv, project, except)
        .map(x => ({key: convMemberKey(x), pane: x, label: paneLabel(x)}));
      const have = new Set(rows.map(r => r.key));
      return rows.concat(arbMemberRows(conv, except).filter(r => !r.pane && !have.has(r.key)));
    }

    // Whether a paused member can be brought back at all — the same record-shaped question the
    // roster's own Restart asks, borrowed rather than re-derived. Guarded by `typeof` because this
    // module is drawn before the conversation window has ever loaded its records.
    function arbCanWake(key) {
      if (typeof canRespawn !== 'function' || typeof convViewRecs === 'undefined') return false;
      return canRespawn(((convViewRecs || []).find(r => r.key === key) || {}).spawn);
    }
```

Delete `arbWithPick` (lines 899–905) and its three call sites in `arbDrawSetup` and
`arbCheckSetup`. It existed to hold a just-started pane in a list the status filter dropped it
from; the status filter is gone.

### 2c. The select

Replace `arbPaneSelect` (line 1040) — it now takes rows, not panes:

```javascript
    function arbPaneSelect(id, rows, selected, label) {
      return `<label>${label ? escapeHtml(label) : ''}<select id="${id}">` +
        rows.map(r => {
          const v = arbPickValue(r);
          return `<option value="${escapeHtml(v)}"` +
            `${arbSamePick(v, selected) ? ' selected' : ''}>${escapeHtml(r.label)}</option>`;
        }).join('') + '</select></label>';
    }
```

`arbSlot(id, panes, selected)` becomes `arbSlot(id, rows, selected)` — the body is unchanged, only
the parameter name.

### 2d. `arbDrawSetup`

```javascript
    function arbDrawSetup(conv, at, holding) {
      const el = document.getElementById('arbSetupBody');
      const mine = arbSetupSession;
      const free = arbArbiterRows(conv, arbPickedProject(conv, at), mine);
      const rows = arbMemberRows(conv, mine);
      if (el) el.innerHTML = arbSetupHtml(rows, free, at, !!mine, holding || arbHoldNote());
      const name = document.getElementById('arbSetupConvName');
      if (name) name.textContent = conv.name || '';
      arbSetupConv = conv.id;
      const box = document.getElementById('arbModal');
      if (box) box.style.display = 'block';
    }
```

`arbSetupHtml(live, free, at, editing)` gains a fifth argument `holding` — a string or `''`. Its
form actions become:

```javascript
        '<div class="arb-form-actions">' +
        (holding ? `<span class="arb-hold-note">${escapeHtml(holding)}</span>` : '') +
        '<button class="arb-btn" onclick="closeArbSetup()">Cancel</button>' +
        (editing
          ? `<button class="arb-btn go"${holding ? ' disabled' : ''} onclick="arbSave()">Save</button>`
          : `<button class="arb-btn go"${holding ? ' disabled' : ''} onclick="arbStart()">Start</button>`) +
        '</div>'
```

`arbPickedProject` reads `at.arbFirst` / `at.arbSecond` as pane ids; it must skip a paused pick:

```javascript
    function arbPickedProject(conv, at) {
      const picked = [(at || {}).arbFirst, (at || {}).arbSecond]
        .map(v => (arbResolvePick(v) || {}).pane_id)
        .map(id => id && agents.find(x => x.pane_id === id)).filter(Boolean);
      if (!picked.length) return arbProject(conv);
      const ids = new Set(picked.map(x => x.project_id || ''));
      return ids.size === 1 ? (picked[0].project_id || '') : null;
    }
```

`arbSetupOf` (line 876) is unchanged — a running session's participants are always live panes, so
its values are already in the pane-id half of the value space.

### 2e. `arbCheckSetup` — A1.6 and A2

Three edits inside it:

```javascript
      // Members that can be woken, not panes that are running. A conversation whose sessions have
      // been paused is exactly the one somebody opens this dialog on.
      const live = arbMemberRows(conv, except);
```

```javascript
      if (picks[0] === picks[1]) {
        showToast('Two different agents — one has nobody to talk to.');
        return null;
      }
      // The picker offers this conversation's own members as arbitrators now, so a pane can be
      // named twice. Said here for a readable message; refused again by the relay, which is where
      // it is law — see duplicate_participant.
      if (picks.some(p => arbSamePick(p, who))) {
        showToast('An agent cannot arbitrate itself.');
        return null;
      }
```

The `taken` check, the project check and the returned object all read pane ids. Change them to
work on resolved picks, and drop the `free.some(x => x.pane_id === who)` liveness block entirely —
a busy arbitrator is the relay's refusal now (A1.1):

```javascript
      const want = [picks[0], picks[1], who].map(arbResolvePick);
      const taken = arbTakenPanes(except);
      if (want.some(w => w.pane_id && taken.has(w.pane_id))) {
        showToast('One of those is already in another arbitration session.');
        return null;
      }
      // Only what is running can be checked for a project; a paused member is restarted into the
      // Project its record names, which is the same one. The relay checks the resolved roster.
      const chosen = want.map(w => w.pane_id && agents.find(x => x.pane_id === w.pane_id))
        .filter(Boolean);
      if (new Set(chosen.map(x => x.project_id || '')).size > 1) {
        showToast('Arbitration needs every selected agent in the same project.');
        return null;
      }
      return {
        scope: scope, picks: picks, who: who, want: want, roles: roles,
        ...
      };
```

### 2f. The held start

Add after `arbStart`:

```javascript
    // A roster with something paused in it. `Start` is one press for "wake what is missing and
    // then begin", because the alternative is a trip to the roster panel, three restarts by hand,
    // and the scope retyped when the person comes back.
    //
    // The restarts are ordinary restarts — the same press, the same durable note (S1), the same
    // one-at-a-time queue, and they land as members whether or not this dialog is still open. What
    // is held here is only the sending of `arb_start`, and only until every slot has a pane.
    let arbHold = null;
    const ARB_HOLD_MS = 120000;

    function arbHoldNote() {
      if (!arbHold) return '';
      const n = arbHold.want.filter(w => !w.pane_id).length;
      return n ? `Waiting for ${n} agent${n === 1 ? '' : 's'} to come up…` : 'Starting…';
    }

    // Every paused pick, queued through the conversation's own restart queue — which exists
    // precisely because one start's binding must land before the next one goes out.
    function arbBeginHold(conv, got, editing) {
      arbHold = {conv: conv.id, got: got, editing: editing || '', at: Date.now(),
                 want: got.want.map(w => Object.assign({}, w))};
      const waking = arbHold.want.filter(w => !w.pane_id).map(w => w.key);
      for (const key of waking) {
        if (!arbCanWake(key)) {
          arbEndHold(`${convMemberName(key, '', '', 'That member')} cannot be restarted — ` +
                     'it was left as it is.');
          return;
        }
      }
      convRestartQueue = (convRestartQueue || []).concat(waking);
      convRestartStep();
      arbDrawSetup(conv, arbSetupOf ? arbReadSetup() : null);
    }

    function arbEndHold(why) {
      const conv = arbHold && loadConvIndex().find(c => c.id === arbHold.conv);
      arbHold = null;
      if (why) showToast(why);
      if (conv && arbSetupOpen()) arbDrawSetup(conv, arbReadSetup());
    }

    // Called on every snapshot. Resolves each waking pick against the roster — the member's key
    // has moved to the new pane by then, which is what S1's landing does — and sends once they are
    // all there.
    function arbHoldStep() {
      if (!arbHold) return;
      if (Date.now() - arbHold.at > ARB_HOLD_MS) {
        arbEndHold('That did not come up in time — nothing was started.');
        return;
      }
      const conv = loadConvIndex().find(c => c.id === arbHold.conv);
      if (!conv) { arbHold = null; return; }
      const live = new Map(agents.map(x => [convMemberKey(x), x]));
      for (const w of arbHold.want) {
        if (w.pane_id || !w.key) continue;
        // The member's key is the *old* pane's until the landing moves it, so the row is found by
        // walking the roster rather than by looking the old key up in the live map.
        const m = (conv.members || []).find(x => x.key === w.key)
          || (conv.members || []).find(x => (x.was || []).includes(convKeyPaneId(w.key)));
        const pane = m && live.get(m.key);
        if (pane) { w.pane_id = pane.pane_id; w.key = m.key; }
      }
      if (arbHold.want.some(w => !w.pane_id)) {
        if (arbSetupOpen()) arbDrawSetup(conv, arbReadSetup());
        return;
      }
      const got = arbHold.got, editing = arbHold.editing;
      arbHold = null;
      arbSendRoster(conv, got, editing);
    }
```

`arbStart` and `arbSave` split into "check, then either send or hold":

```javascript
    function arbStart() {
      const conv = loadConvIndex().find(c => c.id === convCurrentId());
      if (!conv || arbHold) return;
      const got = arbCheckSetup(conv, arbReadSetup(), '');
      if (!got) return;
      if (got.want.some(w => !w.pane_id)) { arbBeginHold(conv, got, ''); return; }
      arbSendRoster(conv, got, '');
    }
```

`arbSendRoster(conv, got, editing)` holds what `arbStart`'s `arbSend({type:'arb_start', …})` and
`arbSave`'s `arb_edit` diff do today, reading pane ids from `got.want` rather than from
`got.picks`. `arbSave` becomes the same two lines with `arbBeginHold(conv, got, s.id)`.

### 2g. `arbWhyNot`

`live.length` is now a count of wakeable members, so the sentence changes:

```javascript
      const why = live.length < 2
        ? 'Arbitration watches two agents talk. This conversation has ' +
          (live.length === 1 ? 'one agent in it.' : 'none in it.')
        : ...
```

The third branch — "every other pane here is busy right now" — is no longer reachable and is
replaced by `'Arbitration needs an agent in this project to decide.'`

---

## 3. `[MODIFY] web/src/status_bar.js`

After `convRestartStep()` in the `agents` branch:

```javascript
        // A session whose roster was still coming up. After the restart queue, which is what
        // brings it up.
        if (typeof arbHoldStep === 'function') arbHoldStep();
```

---

## 4. `[MODIFY] web/index.html`

One rule beside the existing `.arb-form-actions`:

```css
    .arb-hold-note { flex: 1; font-size: 12px; color: var(--dim); align-self: center; }
```

---

## 5. Tests

**`[NEW] tests/test_arb_roster.py`** — `_enrol` refuses a roster whose arbitrator repeats a
member's pane with `duplicate_participant`, refuses one where both members are the same pane,
accepts three distinct panes, and still refuses a `working` arbitrator with `arbitrator_busy` —
which is the refusal the picker's status filter was pre-empting. Follows `tests/test_arbitration.py`'s
fixture style.

**`[MODIFY] tests/test_arbitration_ui.js`** —

| Test | Asserts |
|---|---|
| a working pane is offered as arbitrator | `arbArbiterRows` includes a pane with `status: 'working'` |
| a member of this conversation is offered as arbitrator | included |
| a pane in another session is offered by nobody | excluded from both lists |
| a paused member with a spawn record is offered | value is `paused:<key>`, label ends `— paused` |
| a paused member with no spawn record is not offered | absent |
| arbitrator equal to Agent 1 is refused | `arbCheckSetup` returns null, toast `An agent cannot arbitrate itself.` |
| a conversation with one live and one paused member opens | `arbCheckSetup` passes the `live.length < 2` gate |

**`[NEW] tests/test_arb_hold.js`** — boot `arbitration.js` in a vm with stubs for `convRestart*`,
`agents` and `loadConvIndex`:

| Test | Asserts |
|---|---|
| a paused pick queues a restart instead of sending | `arbSend` not called; the key is on `convRestartQueue` |
| the note says what it is waiting for | `arbHoldNote()` is `Waiting for 1 agent to come up…` |
| the send goes out once the member's key has moved to a live pane | `arb_start` carries that pane's id |
| a member whose key moved via `was` is still found | resolved through the `was` fallback |
| the deadline drops the hold and sends nothing | after `ARB_HOLD_MS`, `arbHoldStep` clears it and `arbSend` was never called |
| an unwakeable pick ends the hold immediately | no restart queued |

**`[MODIFY] tests/e2e/browser/arbitration.spec.js`** — one case: a conversation with a paused
member, `Agent 2` set to the paused option, `Start` pressed; the fake herdr brings the pane up and
`arb_start` is seen on the wire with three distinct pane ids.

---

## Verification

```bash
source .venv313/bin/activate

.venv313/bin/python -m unittest discover -s tests -t tests
node --test tests/test_arb_roster.py 2>/dev/null || true      # python, run by the line above
node --test tests/test_arbitration_ui.js tests/test_arb_hold.js
node --test tests/*.js

npx playwright test tests/e2e/browser/arbitration.spec.js tests/e2e/browser/arbiter_off.spec.js
npx playwright test tests/e2e/browser/app_smoke.spec.js

# The arbitration loop end to end, and the UI one — both touch the roster
.venv313/bin/python tests/e2e/e2e_arbitration.py
node tests/e2e/e2e_arb_ui.js

python3 scripts/build.py
```

---

## Acceptance criteria

- [ ] A1.1–A1.6 hold: a `working` pane, a `blocked` pane and a member of this conversation are all offerable as arbitrator; a paused member with a restartable record is offerable in all three slots; one held by another session is offerable in none.
- [ ] `arbWithPick` no longer exists. `grep -n arbWithPick web/src/arbitration.js` returns nothing.
- [ ] A2.2 is refused in the dialog with `An agent cannot arbitrate itself.` and by the relay with `duplicate_participant` when a client sends it anyway. The relay's guard already existed — no behaviour was added there.
- [ ] A3.2–A3.8 hold: `Start` on a roster with paused picks restarts them one at a time, keeps the dialog and everything typed into it, disables `Start` while waiting, sends once every slot resolves, and gives up after two minutes without sending.
- [ ] Closing the dialog mid-wait stops the wait and does not stop the restarts.
- [ ] `arb_start` and `arb_edit` are byte-for-byte what they are today when every pick is already live.
- [ ] The durable spawn binding plan is merged first; `convRestartQueue` and `convPendingRefs` are used, not reimplemented.
