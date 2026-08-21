# Quick Actions — architecture proposal

**Status:** proposal, not frozen. **Class B** — additive protocol, additive storage, one new
landing section, no existing message changed.
**Branch:** `feat/quick-actions`, off `feat/arbitrator`.

A Quick Action is one press that does a thing the user would otherwise assemble by hand: run a
command they have run fifty times, spawn the three agents they always spawn together, open the
session they always open with the same settings. The landing page gets a sixth section for them,
and the header gets a sixth tab.

---

## 1. Why this is not one feature

The three things the request names look alike on screen and are nothing alike underneath:

| # | Action | What it actually does | Existing machinery |
|---|--------|----------------------|--------------------|
| 1 | Run a predefined command or script | Executes a binary on the relay's host | `ops_config.py` — allowlist and argv builder |
| 2 | Spawn agents / panes, a conversation of agents, or agents + arbitrator | Several `start_agent` calls, a conversation record, optionally `arb_start` | `start_agent.py`, `arbitration.py` |
| 3 | Spawn one agent with preconfigured settings | One `start_agent` call with the dialog's fields prefilled | `start_dialog.js` |

Type 3 is type 2 with one member and no conversation. **They are the same action with a smaller
roster**, and building them as two things would be two code paths that drift. The proposal folds
3 into 2 and carries two action kinds, not three:

- `run` — execute a registered command
- `spawn` — create panes, optionally file them into a conversation, optionally arbitrate them

Type 3 is a `spawn` whose `members` array has one entry and whose `conversation` is absent.

---

## 2. The security split — the one decision everything else follows

`state_put` is deliberately **not** behind `HERDR_ENABLE_WRITE_EXT`. The existing contract says
why: *"that gate is for process creation, and this writes a label."* Any connected client may
write any of the four shared documents.

So a Quick Action cannot carry the command it runs.

If the argv lived in the state store, a browser could write `{"argv": ["curl", "…|sh"]}` and press
its own button, and `state_put` — a message with no write gate — would have become remote code
execution. That inverts the entire access model.

The same rule already exists one layer over, in `start_agent`:

> `cwd` and `host` come from the configured Project — never from the wire (D4).

Quick Actions obey it verbatim. **What may run is server configuration. What the user arranges is
client state.** The wire carries a *name*, never a payload.

| Lives on the relay, not client-writable | Lives in state sqlite, user-editable in the UI |
|---|---|
| The argv of every runnable command | Which actions exist and in what order |
| Which agent kinds may be started (`HERDR_START_AGENTS`) | The label, glyph and colour on each tile |
| Which `project_id`s exist and their cwd/host | Which registered command a tile names |
| Parameter specs (`enum` / `int` / `re`) | The parameter *values* the user typed |
| The `tier` that decides whether it confirms | Grouping, hiding, pinning |

A user editing a Quick Action in the app is choosing among what the machine's owner already
permitted. They cannot widen it. That is the whole boundary, and it is the reason this feature is
safe to expose to every browser on the LAN.

### 2.1 Reusing `ops_config.py` rather than writing a second registry

`relay/ops_config.py` already is this boundary, hardened, tested (`tests/test_ops_allowlist.py`),
and pure — reading a file is its only I/O. It gives, for free:

- `{placeholder}` must be a **whole argv element** — rejected at *load* time, not run time, so a
  parameter can never grow into a second argument, an option, or a shell fragment
- `shell=False`, always; no `/exec`, no free-form binary
- `validate_param` — one of `enum` / `int` / `re`, `MAX_PARAM_LEN` 128, and errors that echo the
  offending value only `repr`-truncated so a hostile argument cannot render its own text
- `tier: "R" | "W"` — `W` means the UI must confirm before running
- `timeout`, `cwd`, per-command

Today only `herdr_ops.py` and `ops_supervisor.py` import it. The relay imports it too. It is
stdlib-only and pure, so this adds no dependency and no I/O to the poll loop.

**Nothing new is invented for type 1.** A Quick Action of kind `run` names a key in the existing
`commands` table of `ops.json`. A machine that has never configured `ops.json` gets an empty
command list and the UI offers no `run` actions — the same way absent `start_options` hides Start.

---

## 3. Storage

### 3.1 A fifth shared document

```python
# relay/user_state.py
DOC_NAMES = ("pairs", "conversations", "conv_view", "conv_hidden", "quick_actions")
```

One line. It earns its place by the same test the other four passed: **is this a fact about the
work, or about this device?** A Quick Action the user built is an assertion about their fleet — the
three agents they always start together are the same three from the phone. A browser that does not
know them is showing a different toolkit. It syncs.

`MAX_BODY` (256 KB) already covers it. The `history` table already keeps the last 200 revisions, so
a client that writes a broken action list is recoverable with
`user_state.py restore quick_actions <rev>` — a recovery path that does not need the app working,
which is the point of that CLI.

### 3.2 The client half

```javascript
// web/src/state_sync.js
const STATE_DOCS = {
  …,
  quick_actions: { key: 'herdr_quick_actions_v2', pendingKey: 'herdr_quick_actions_pending' },
};
const STATE_SHAPE = {
  …,
  quick_actions: { list: 'items' },   // id'd rows — same merge as conversations
};
```

`{ list: 'items' }` and not `{ map: true }`, because rows have ids the user created, which means
the pending-create outbox works unchanged: an action built offline is carried across the adopt
rather than lost to it.

### 3.3 The key-name collision that must not be missed

`web/src/history.js:249` already holds:

```javascript
const QA_KEY = 'herdr_quick_actions';
function quickActionsOn() { return localStorage.getItem(QA_KEY) !== 'off'; }
```

That is an **unrelated existing feature** — the approval-button strip over the bottom dock, with
`renderQuickActions()` called from thirteen places and its own `toggleQuickActions`. It stores the
string `'off'`, not JSON.

Two consequences, both mandatory:

1. The new document uses `herdr_quick_actions_v2`. Reusing the name would have `stateSyncPlan`
   upload the literal string `off` as a document body on first connect.
2. **The existing `renderQuickActions` is not the renderer for this feature.** The new one is
   `renderQuickActionTiles`. Naming it `renderQuickActions` would silently shadow a function
   thirteen call sites depend on, and the scripts are plain — load order *is* the program.

The user-facing name collides too. The existing strip is internal (`quickActionsOn` gates the
approval buttons); the section this proposal adds is the one the user will call "Quick Actions".
Recommend renaming the old one to `approvalStrip` in a **separate commit** before this feature
lands, so the diff that renames is not the diff that adds.

---

## 4. The document shape

The relay never parses it — same contract as the other four. This is the app's schema, and it lives
in `quick_actions_pure.js` where the tests go.

```json
{
  "version": 1,
  "items": [
    {
      "id": "qa_k3f9",
      "kind": "run",
      "label": "Run tests",
      "glyph": "beaker",
      "command": "pytest",
      "args": { "suite": "unit" }
    },
    {
      "id": "qa_m2p1",
      "kind": "spawn",
      "label": "Review pair",
      "glyph": "users",
      "project_id": "herdr-remote",
      "placement": "tab",
      "members": [
        { "name": "claude", "role": "implementer" },
        { "name": "codex",  "role": "reviewer" }
      ],
      "conversation": { "label": "Review — {date}" },
      "arbitrator": { "name": "claude", "role": "arbitrator", "scope": "Review the diff." }
    }
  ]
}
```

### Field rules

| Field | Rule |
|---|---|
| `id` | Client-generated, required. `stateMerge` cannot carry over an id-less row — it would duplicate on every connect |
| `kind` | `run` \| `spawn`. Unknown kinds render as a disabled tile, never dropped — see §7 |
| `label` | 1–32 chars, matching `rename_pane`'s existing cap so a tile and a pane label agree |
| `command` | `run` only. A key in `ops.json` `commands`. Absent from the registry = disabled tile |
| `args` | `run` only. Values for that command's declared params. **Validated server-side regardless** — the client's check is a courtesy, `validate_param` is the boundary |
| `project_id` | `spawn` only. Must be a live Project. cwd and host are never on the wire (D4) |
| `members` | `spawn` only. 1–N. One member and no `conversation` is action type 3 |
| `conversation` | Optional. Present means the spawned panes are filed into a new conversation record |
| `arbitrator` | Optional, and only meaningful with exactly two members — §14.1 fixes an arbitration roster at two |

---

## 5. Protocol

Two new messages. Both follow the shape every existing command uses, so the client's
`command_result` branch needs one more arm and no new machinery.

### `quick_actions` (server → client, once after the snapshot)

The feature gate, exactly as `start_options` gates Start and `arb_sessions` gates arbitration —
**its presence is the gate, so an empty list is as meaningful as a full one.**

```json
{
  "type": "quick_actions",
  "commands": [
    { "name": "pytest", "tier": "W", "params": { "suite": { "enum": ["unit", "e2e"] } } }
  ]
}
```

The *registry*, not the user's tiles — the tiles arrive through `state`. This is what the editor
populates its "which command" dropdown from, and what tells a tile its command still exists.

Only `name`, `tier` and `params` are sent. **The argv is never on the wire**, in either direction.
A client has no reason to know which binary a command runs, and sending it makes the registry
readable by anything that connects.

### `quick_run` (client → server)

```json
{ "type": "quick_run", "command": "pytest", "args": ["unit"] }
```

Gated on `HERDR_ENABLE_WRITE_EXT`, because it creates a process — the line that gate exists to
draw. Answers `command_result` with `command: "quick_run"`, carrying `ok`, and on success the
exit code and captured output, capped at `stream_bytes`.

`args` is positional, matching `build_argv`'s existing contract (`len(args) != len(names)` is
already an error there). The client orders them from the `params` it was sent.

**No `quick_spawn` message.** A `spawn` action is executed *client-side* as the `start_agent`,
conversation-write and `arb_start` calls the user would have made by hand. The relay learns
nothing new, every existing validation applies unchanged, and a partial failure leaves the panes
that did start — which is what the user wants, and what a server-side transaction could not give
them anyway since `start_agent` is not reversible.

---

## 6. The UI

### 6.1 The section

`sections.js` grows one entry in each of its five registries:

```javascript
const SECTION_IDS  = { …, quickactions: 'quickactions' };
const SECTION_DEFAULT = ['quickactions', 'agents', 'terminals', 'pairs', 'recents', 'conversations'];
const SECTION_NAMES = { …, quickactions: 'Quick Actions' };
const SECTION_TABS  = ['quickactions', 'conversations', 'agents', 'terminals', 'pairs', 'recents'];
const SECTION_GLYPHS = { …, quickactions: '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>' };
```

A `<div class="quickactions" id="quickactions" style="display:none">` beside its five siblings in
`index.html` — a sibling and not a child, for the reason already written there: each is rewritten
wholesale on its own schedule.

Placed **first** in `SECTION_DEFAULT` and `SECTION_TABS`. A launcher below five lists of running
things is a launcher nobody presses. This does change the landing page for an existing install,
which is the one place this proposal knowingly departs from the "an install that never opens
Settings sees no change at all" note in `sections.js` — a new section that defaults to invisible is
a feature nobody finds. It is one checkbox to undo.

### 6.2 The separator

`renderQuickActionTiles` writes `<div class="section-header">Quick Actions</div>` followed by the
tiles, matching `renderRecents` exactly. Emptiness stays each renderer's own business:
**write `''` when there are no actions**, and `applySections` takes the section off screen and
leaves no bare separator — the existing contract, unchanged.

The header strip needs nothing: `renderSectionTabs` builds from `sectionHasContent`, so the tab
appears the moment the section writes anything and vanishes when it stops.

### 6.3 Tiles, not rows

A grid of labelled tiles, sized for a thumb. Distinct from the agent cards on purpose — a card
*reports* and a tile *acts*, and making them look alike invites pressing one expecting the other.

A tile shows a disabled state, never a hidden one, when its command has left the registry or its
project is gone. A launcher that silently drops buttons trains the user not to trust it; one that
says "`pytest` is no longer configured" is repairable.

### 6.4 The editor

A sheet, matching the Start dialog's field layout. Add, edit, reorder, delete. `tier: "W"` puts a
confirm step in front of the run — reusing the ops bot's semantics rather than inventing a second
notion of "this one is dangerous".

Reorder rides on `reorder.js` if its list handling generalises; otherwise up/down buttons. Do not
build a drag-and-drop system for six tiles.

---

## 7. Extensibility — the future kinds the request asks for

`kind` is a string, and the renderer switches on it. That is the entire extension mechanism, and it
is enough. What makes it work is one rule:

**An unknown `kind` renders as a disabled tile carrying its label, and is written back untouched.**

Without it, an old browser that loads a document containing a `kind` it does not know would drop
that row on its next `state_put` and destroy an action every other browser can see — the exact
failure `stateSyncPlan` was written to stop, one level up. With it, a phone on last week's build is
merely unable to *press* the new action.

Explicitly **not** built now:

- No plugin registry, no action interface with one implementation, no `kind` handler table
- No scheduling, no chaining, no conditional actions. A Quick Action is one press doing one thing;
  chaining is a script, and §2 already says where scripts live
- No per-Project scoping. The answer to Q3 was global. A `project_id` field on a `spawn` action is
  not scoping — it is a parameter

---

## 8. Configuration surface

| Variable | Effect |
|---|---|
| `HERDR_QUICK_ACTIONS` | `1` sends the `quick_actions` message and accepts `quick_run`. Off means the message is never sent and the wire is unchanged |
| `HERDR_OPS_CONFIG` | Already exists. The same registry the ops bot reads supplies runnable commands |

`quick_run` additionally requires `HERDR_ENABLE_WRITE_EXT`, and refuses at boot without it — the
pattern `HERDR_ENABLE_ARBITER` already sets by refusing to boot without its two prerequisites.
`spawn` actions need no new gate: they are `start_agent` calls, already gated.

A relay with `HERDR_QUICK_ACTIONS=1` and no `ops.json` sends an empty `commands` list. Type 2 and 3
still work; type 1 offers nothing to run. That is the correct degradation — the person who has not
told the machine what may execute has not been overruled.

---

## 9. Files

| Path | Change |
|---|---|
| `relay/user_state.py` | `[MODIFY]` one name into `DOC_NAMES` |
| `relay/herdr_relay.py` | `[MODIFY]` import `ops_config`; send `quick_actions`; handle `quick_run` |
| `relay/quick_actions.py` | `[NEW]` the run path: resolve name, `build_argv`, execute, cap output |
| `web/src/quick_actions_pure.js` | `[NEW]` document schema, validation, ordering — where the tests point |
| `web/src/quick_actions_ui.js` | `[NEW]` `renderQuickActionTiles`, the editor sheet, the run/spawn executors |
| `web/src/state_sync.js` | `[MODIFY]` one entry in `STATE_DOCS`, one in `STATE_SHAPE` |
| `web/src/sections.js` | `[MODIFY]` five registries, one entry each |
| `web/src/status_bar.js` | `[MODIFY]` `renderBody` calls the new renderer; `handleMessage` learns two message types |
| `web/index.html` | `[MODIFY]` the section div, the editor sheet, the Settings checkbox, two `<script src>` tags |
| `web/src/history.js` | `[MODIFY]` **separate commit** — rename the existing `quickActions*` to `approvalStrip*` |

`_pure` and `_ui` split deliberately: it is the split every other feature here uses
(`pairs_pure` / `pairs_ui`, `conversation_pure` / `conversation_view`), and it is what lets the
vm-slice suites test the schema without a browser.

---

## 10. Verification

| What | How |
|---|---|
| Document schema, merge, unknown-kind preservation | `node --test tests/quick_actions.test.js` |
| Fifth document round-trips, and history restores it | `.venv313/bin/python -m unittest discover -s tests -t tests` |
| `quick_run` refuses an unregistered command, a bad param, and a `spawn`-shaped message | `tests/test_quick_actions.py` |
| Script tags in the right order — the page boots | `npx playwright test app_smoke.spec.js` |
| A tile renders, presses, and the section header appears and disappears with it | `npx playwright test quick_actions.spec.js` |

The load-order guard matters more than usual here: two new script files, and
`quick_actions_ui.js` reads `quick_actions_pure.js` bindings at load time.

---

## 11. Open questions

1. **`run` output** — a toast, a sheet, or streamed into a pane? A `pytest` run is scrollback, and
   a toast cannot hold it. Leaning: sheet, reusing the pane reader's renderer, `stream_bytes`-capped.
2. **Where does a `spawn` land the user?** `start_agent` already sets `pendingStart` to open the
   pane once the poll sees it. With three panes there is no single answer — the conversation, if
   there is one, otherwise the first member.
3. **Does the old `quickActions` rename ship first, as its own commit?** Recommended, and this
   proposal assumes yes.
