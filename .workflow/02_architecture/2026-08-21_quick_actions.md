# Quick Actions — architecture proposal

**Status:** proposal, not frozen. **Class B** — additive storage, one new landing section, **no new
WebSocket message and no new relay verb**.
**Branch:** `feat/quick-actions`, off `feat/arbitrator`.

A Quick Action is one press that does a thing the user would otherwise assemble by hand: run a
command they have run fifty times, spawn the three agents they always spawn together, open the
session they always open with the same settings. The landing page gets a sixth section for them,
and the header gets a sixth tab.

**Every press lands somewhere the user can watch it.** That single rule is what makes this feature
small: a command runs in a terminal because a terminal is what shows output; agents open on their
pane; a roster opens on its conversation. Nothing is executed into a void and reported back through
a status message, so there is no result channel to design, no output cap to choose, and no new
message for the relay to learn.

---

## 1. Three types, two kinds

| # | Action | What it actually does | Existing machinery |
|---|--------|----------------------|--------------------|
| 1 | Run a predefined command or script | `open_terminal` at a Project, then `send_text` with `submit` | both messages already exist |
| 2 | Spawn agents / panes, a conversation of agents, or agents + arbitrator | N × `start_agent`, one conversation record, optionally `arb_start` | `start_agent.py`, `arbitration.py` |
| 3 | Spawn one agent with preconfigured settings | one `start_agent` with the dialog's fields prefilled | `start_dialog.js` |

Type 3 is type 2 with one member. **They are the same action with a smaller roster**, and building
them separately would be two code paths that drift. The document carries two kinds:

- `run` — open a terminal and type the command into it
- `spawn` — start panes; one member opens on its pane, several open on their shared conversation

---

## 2. What actually gates this

`run` is `open_terminal` followed by `send_text`. Neither is new, and their gates are already
decided:

| Message | Gate |
|---|---|
| `open_terminal` | `HERDR_ENABLE_TERMINAL` **and** `HERDR_ENABLE_WRITE_EXT` |
| `send_text` | none beyond `pane_guard` — the pane must exist and be unambiguous |
| `start_agent` | `HERDR_ENABLE_WRITE_EXT` |
| `arb_start` | `HERDR_ENABLE_ARBITER` |

`send_text` having no write gate is not an oversight; it is what terminal mode *means*. The
existing contract says so plainly: `HERDR_ENABLE_TERMINAL` "lists shell panes as Terminals and
makes them **readable and writable**." On a relay with terminal mode on, any connected client can
already open a shell pane and type anything into it. A Quick Action that types a command into a
terminal therefore grants **no privilege that was not already granted**, and there is nothing here
for a new boundary to defend.

So: **no command registry, no `ops.json` dependency, no `quick_run` message, no server-side
executor.** An earlier draft of this proposal put an allowlist in front of the run path. That was
the right answer for a server-executed argv — a command in an ungated shared document, run by the
relay, would have made `state_put` a way to execute anything — and it is the wrong answer for a
command typed into a terminal, where the privilege already exists and the allowlist only adds a
registry to maintain.

### 2.1 The boundary that remains

**A `run` tile is disabled when terminal mode is off**, and says so. This is the whole rule. On such
a relay there is no sanctioned path to a shell, and a Quick Action that manufactured one would be
genuine new privilege — which is exactly the case the relay's two gates already refuse.

### 2.2 The confused deputy, and the cheap answer

The command text lives in a document every browser can write and every browser can read. Browser A
writes a tile labelled "Run tests"; browser B presses it. B's user has executed A's text believing
the label. That is not privilege escalation — A could have typed it directly — but it is a real way
to be misled, and it is new, because a typed command was previously always typed by the person
running it.

The answer is not a registry. It is to **show the command on the tile and again in the confirm**.
A press of `run` opens a confirm carrying the literal text that is about to be typed and the Project
it will be typed in. Cheap, honest, and it makes the label untrustworthy in exactly the way a label
should be — the text below it is the truth.

`send_text` already audits its payload (`audit("send_text", …, f"…text={text!r}")`), so a Quick
Action run is recorded byte for byte, exactly as a hand-typed command is.

---

## 3. Storage

### 3.1 A fifth shared document

```python
# relay/user_state.py
DOC_NAMES = ("pairs", "conversations", "conv_view", "conv_hidden", "quick_actions")
```

**This one line is the entire relay change for this feature.**

It earns its place by the test the other four passed: is this a fact about the work, or about this
device? A Quick Action the user built is an assertion about their fleet — the three agents they
always start together are the same three from the phone. A browser that does not know them is
showing a different toolkit. It syncs.

`MAX_BODY` (256 KB) already covers it, and the `history` table already keeps 200 revisions, so a
client that writes a broken list is recoverable with `user_state.py restore quick_actions <rev>` —
a recovery path that does not need the app working, which is why that CLI exists.

### 3.2 The client half

```javascript
// web/src/state_sync.js
const STATE_DOCS = {
  …,
  quick_actions: { key: 'herdr_quick_actions_v2', pendingKey: 'herdr_quick_actions_pending' },
};
const STATE_SHAPE = {
  …,
  quick_actions: { list: 'items' },   // id'd rows — the same merge conversations use
};
```

`{ list: 'items' }` and not `{ map: true }`, because the rows have ids the user created — which is
what makes the pending-create outbox work unchanged, so an action built offline is carried across
the adopt rather than lost to it.

### 3.3 The name collision that must not be missed

`web/src/history.js:249` already holds:

```javascript
const QA_KEY = 'herdr_quick_actions';
function quickActionsOn() { return localStorage.getItem(QA_KEY) !== 'off'; }
```

That is an **unrelated existing feature** — the approval-button strip over the bottom dock, with
`renderQuickActions()` called from thirteen places. It stores the string `'off'`, not JSON.

1. The new document uses `herdr_quick_actions_v2`. Reusing the name would have `stateSyncPlan`
   upload the literal string `off` as a document body on first connect.
2. The new renderer is `renderQuickActionTiles`. Naming it `renderQuickActions` would shadow a
   function thirteen call sites depend on — and the scripts are plain, so load order *is* the
   program.

Rename the old family to `approvalStrip*` in a **separate commit** ahead of this work, so the diff
that renames is not the diff that adds.

---

## 4. The document shape

The relay never parses it — same contract as the other four. The schema lives in
`quick_actions_pure.js`, where the tests point.

```json
{
  "version": 1,
  "items": [
    {
      "id": "qa_k3f9",
      "kind": "run",
      "label": "Run tests",
      "glyph": "beaker",
      "project_id": "herdr-remote",
      "placement": "tab",
      "command": ".venv313/bin/python -m unittest discover -s tests -t tests"
    },
    {
      "id": "qa_m2p1",
      "kind": "spawn",
      "label": "Review pair",
      "glyph": "users",
      "project_id": "herdr-remote",
      "placement": "tab",
      "conv_label": "Review",
      "members": [
        { "name": "claude", "role": "implementer", "prompt": "Read the diff on this branch." },
        { "name": "codex",  "role": "reviewer" }
      ],
      "arbitrator": { "name": "claude", "role": "arbitrator", "scope": "Settle review disputes." }
    }
  ]
}
```

| Field | Rule |
|---|---|
| `id` | Client-generated, required. `stateMerge` cannot carry over an id-less row — it would duplicate on every connect |
| `kind` | `run` \| `spawn`. Unknown kinds render disabled and are written back untouched — §7 |
| `label` | 1–32 chars, matching `rename_pane`'s cap so a tile and a pane label agree |
| `project_id` | Required for both kinds. Must be a live Project. **cwd and host are never on the wire** (D4) — this names the Project, and the relay resolves the rest |
| `placement` | As `start_agent` / `open_terminal` already define it |
| `command` | `run` only. The literal text typed into the terminal. Capped at `SEND_TEXT_MAX`, which the relay enforces anyway |
| `members` | `spawn` only, 1–N. Each is a `name` (an agent kind from `start_options`) and a `role`, plus an optional opening `prompt` |
| `conv_label` | `spawn` only, and only meaningful with more than one member. The conversation's name; defaults to the action's label |
| `arbitrator` | `spawn` only, and only with **two or more** members. §14.1 fixes an arbitration *pair* at two — `MEMBERS_REQUIRED` in the relay, unchanged — but not the size of the room it sits in, exactly as the setup dialog has always allowed by asking Agent 1 and Agent 2 as selects. The pair is the first two of `members`, which is what the editor's two selects reorder; the rest start into the same conversation and are not arbitrated. Ignored at one member, never an error: a roster narrowed and widened again should not silently lose its arbitrator |

Note what is absent: no `cwd`, no `host`, no `argv`, no `shell`. A `run` action names a Project and
carries a line of text. Everything about *where* that text lands is the relay's to decide from
configuration, exactly as it is for a start.

---

## 5. Protocol

**None.** No new message in either direction.

A Quick Action is executed client-side as the sequence of existing calls the user would have made by
hand. The relay learns no new verb, every existing validation applies unchanged, and each step is
audited under its own name — a `run` shows up in the audit log as an `open_terminal` and a
`send_text`, which is what it is.

This also settles partial failure honestly. A three-member spawn whose second `start_agent` fails
leaves the first pane running, because `start_agent` is not reversible and a server-side
transaction could not have offered otherwise. The UI says which member failed and leaves the rest
alone.

### Feature gating without a gate message

`start_options` gates `spawn`; its absence already hides Start. Terminal mode's presence in the
snapshot (`shells`) gates `run`. `arb_sessions` gates the arbitrator field. All three gates exist,
and the tiles read them — so a relay too old for any of it shows the section with those tiles
disabled and their reason on them, and needs no capability handshake of its own.

---

## 6. Where a press lands

The rule from the top, made concrete. Each row is what the user sees *after* the press.

| Action | Lands on |
|---|---|
| `run` | The new terminal pane, opened as `openTerminal` opens any pane. The command's output is the pane's scrollback — read, scrolled and searched by the machinery that already reads panes |
| `spawn`, one member | That agent's pane |
| `spawn`, several members | The shared conversation, opened by `openConversation` |

### 6.1 `run` — a terminal, not a result

`open_terminal` → `command_result` carries the new `pane_id` → `send_text` with `submit: true` →
`openTerminal(pane_id)`.

`submit: true` and never a separate `send_keys ["Enter"]`, for the reason already written at
`herdr_relay.py:2264`: an Enter travelling as its own message arrives whenever the network feels
like it, and nothing at this end can hold it to the text. The relay watches the pane's
`agent_status` and presses when the pane will take it.

One caveat this inherits: `HERDR_TERMINAL_INIT` runs in a terminal the app opened, once its shell
reaches a prompt. The command must be sent after that, not racing it. `submit_paste` already waits
for a pane that is still starting, so this is a property of the existing path rather than something
this feature must build — but it is the first thing to check if a `run` ever lands mid-`clear`.

A fresh terminal every press. Not reusing the last one: a second press while the first command is
still running would queue text into a busy shell, and "the tile did nothing" is a worse failure
than an extra tab. If tab sprawl becomes the complaint, the fix is a `reuse` field on the action —
not a global rule guessed at now.

### 6.2 `spawn` — serial, then the conversation

Members are started **one at a time, each waiting for the previous `command_result`**. Not
politeness: `next_role_label` derives a pane's label from the live `agents` list, so two starts
issued before either has landed can pick the same name. The relay renames around the collision — the
`renamed` branch in the `command_result` handler exists for exactly this — but the user gets a
roster whose names they did not choose. Serial keeps the labels predictable, and three sequential
starts is a few seconds on a press the user is watching.

The intermediate panes must not steal the view. `openPendingStart` already has the mechanism: a
`startIntent` of `{arb: …}` adopts a started pane *without opening it* — "the dialog behind is half
filled in, and a terminal on screen is that work thrown away." A Quick Action spawn adds a fourth
intent, `{qa: <actionId>}`, with the same silent-adopt behaviour, so the run of starts is invisible
until it finishes.

Then, once every member is up:

1. Build the conversation record — `convMemberOf(a)` per pane, `saveConvIndex`, which marks
   `conversations` dirty and syncs it to every other browser
2. `convSetView(a, conv.id)` per member, so each pane reads under the conversation it was made for
   rather than whichever a fallback would pick
3. Any member `prompt`s go through `sendTextTo`, the same path a typed message takes — so the
   thread records them as the user's, which they are, and no turn is missing its opening words
4. `arb_start` if the action carries an arbitrator and the roster is two
5. `openConversation(conv.id)`

One member skips 1–2 and 5 and lands on `openTerminal(pane_id)`. A conversation of one is a record
with nothing to compare, and the pane's own thread already shows everything it would.

### 6.3 The queue is its own state

`pendingStart` and `startIntent` are single-slot and already claimed by the pair, arb and conv
routes. A multi-member spawn needs its own:

```javascript
let qaSpawn = null;   // { action, remaining: [...members], started: [...panes] }
```

Cleared on any failure and on `closeTerminal`, so an abandoned spawn cannot claim a later start —
the rule `startIntent` already follows and states.

---

## 7. The UI

### 7.1 The section

`sections.js` grows one entry in each of its five registries:

```javascript
const SECTION_IDS  = { …, quickactions: 'quickactions' };
const SECTION_DEFAULT = ['quickactions', 'agents', 'terminals', 'pairs', 'recents', 'conversations'];
const SECTION_NAMES = { …, quickactions: 'Quick Actions' };
const SECTION_TABS  = ['quickactions', 'conversations', 'agents', 'terminals', 'pairs', 'recents'];
const SECTION_GLYPHS = { …, quickactions: '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>' };
```

A `<div class="quickactions" id="quickactions" style="display:none">` beside its five siblings in
`index.html` — a sibling, not a child, for the reason already written there: each is rewritten
wholesale on its own schedule, and ordering is CSS `order`, never moved nodes.

Placed **first** in both lists. A launcher below five lists of running things is a launcher nobody
presses. This does change the landing page for an existing install — the one place this proposal
knowingly departs from the "an install that never opens Settings sees no change at all" note in
`sections.js`. A new section that defaults to invisible is a feature nobody finds, and it is one
checkbox to undo.

### 7.2 The separator

`renderQuickActionTiles` writes `<div class="section-header">Quick Actions</div>` followed by the
tiles, matching `renderRecents` exactly. Emptiness stays the renderer's own business: **write `''`
when there are no actions**, and `applySections` takes the section off screen leaving no bare
separator. The header tab needs nothing — `renderSectionTabs` builds from `sectionHasContent`, so it
appears the moment the section writes anything.

### 7.3 Tiles, not rows

A grid of labelled tiles sized for a thumb, with the command or the roster in small text beneath the
label — §2.2 requires the payload be visible, and it doubles as the thing that tells two similar
tiles apart. Deliberately unlike the agent cards: a card *reports* and a tile *acts*, and making
them look alike invites pressing one expecting the other.

A tile disables rather than hides when its Project is gone, its agent kind has left
`start_options`, or terminal mode is off. A launcher that silently drops buttons teaches the user
not to trust it; one that says "terminal mode is off on this relay" is repairable.

### 7.4 The editor

A sheet matching the Start dialog's field layout — the same Project and placement pickers, the same
agent/role rows. Add, edit, reorder, delete.

Reorder rides on `reorder.js` if its list handling generalises; otherwise up/down buttons. Do not
build a drag-and-drop system for six tiles.

---

## 8. Extensibility

`kind` is a string and the renderer switches on it. That is the entire mechanism, and one rule makes
it safe:

**An unknown `kind` renders as a disabled tile carrying its label, and is written back untouched.**

Without it, a browser on an older build would drop rows it does not understand on its next
`state_put` and destroy an action every other browser can see — the failure `stateSyncPlan` exists
to stop, one level up. With it, the old phone is merely unable to press the new tile.

Not built now: no plugin registry, no handler interface with one implementation, no scheduling, no
chaining, no conditional actions, no per-Project scoping (the answer was global — a `project_id` on
an action is a parameter, not a scope).

---

## 9. Configuration surface

**None.** No new environment variable.

`run` needs `HERDR_ENABLE_TERMINAL` and `HERDR_ENABLE_WRITE_EXT`; `spawn` needs
`HERDR_ENABLE_WRITE_EXT`; an arbitrator needs `HERDR_ENABLE_ARBITER`. All three already exist, all
three already gate the messages this feature sends, and a tile whose gate is closed is disabled
with the reason on it.

---

## 10. Files

| Path | Change |
|---|---|
| `relay/user_state.py` | `[MODIFY]` one name into `DOC_NAMES` — the whole relay diff |
| `web/src/quick_actions_pure.js` | `[NEW]` schema, validation, ordering, gate evaluation — where the tests point |
| `web/src/quick_actions_ui.js` | `[NEW]` `renderQuickActionTiles`, the editor sheet, the run and spawn executors, the spawn queue |
| `web/src/state_sync.js` | `[MODIFY]` one entry in `STATE_DOCS`, one in `STATE_SHAPE` |
| `web/src/sections.js` | `[MODIFY]` five registries, one entry each |
| `web/src/start_dialog.js` | `[MODIFY]` a fourth `startIntent` variant, `{qa}`, adopting silently as `{arb}` does |
| `web/src/status_bar.js` | `[MODIFY]` `renderBody` calls the new renderer |
| `web/index.html` | `[MODIFY]` the section div, the editor sheet, the Settings checkbox, two `<script src>` tags |
| `web/src/history.js` | `[MODIFY]` **separate commit** — rename the existing `quickActions*` to `approvalStrip*` |

The `_pure` / `_ui` split is the one every other feature here uses (`pairs_pure` / `pairs_ui`,
`conversation_pure` / `conversation_view`), and it is what lets the vm-slice suites test the schema
without a browser.

---

## 11. Verification

| What | How |
|---|---|
| Schema, merge, unknown-kind preservation, gate evaluation | `node --test tests/quick_actions.test.js` |
| The fifth document round-trips, and `history` restores it | `.venv313/bin/python -m unittest discover -s tests -t tests` |
| Script tags in the right order — the page boots | `npx playwright test app_smoke.spec.js` |
| A tile renders; the header appears and disappears with the section | `npx playwright test quick_actions.spec.js` |
| A `run` opens a terminal and the command lands in it | `npx playwright test quick_actions.spec.js` (fake herdr) |
| A two-member spawn starts both, files them into one conversation, and opens it | `node tests/e2e/e2e_quick_actions.js` |

The last one is the only test that proves the feature: the queue, the silent adopt, the conversation
write and the landing are all sequencing, and sequencing is what a vm slice cannot see.

The load-order guard matters more than usual — two new script files, and `quick_actions_ui.js`
reads `quick_actions_pure.js` bindings at load time.

---

## 12. Open questions

1. **`HERDR_TERMINAL_INIT` and the first command.** `submit_paste` waits for a starting pane, so
   this should be free — but it is the first thing to check if a `run` ever lands mid-`clear`.
2. **A tile whose Project is gone** — disabled, or offered with a Project picker so the action can
   be repointed in place? Leaning disabled with an "edit" affordance; repointing silently is how a
   command ends up running in the wrong tree.
