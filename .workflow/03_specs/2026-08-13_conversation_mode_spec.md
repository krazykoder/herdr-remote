# Spec — Conversation Mode (proposal)

**Date:** 2026-08-13
**Status:** **Proposed — not implemented.** Open questions in §11 need answers before build.
**Scope:** `web/index.html` only. No relay change, no new WebSocket message, no new env var.
**Builds on:** the final-message detector (`web/index.html`, `// --- Final message detection ---`,
covered by `tests/test_summary_detect.js`) and P3 Session Pairs
(`.workflow/03_specs/2026-08-09_pairs_transfer_spec.md`).

---

## 1. Goal

A pane is a terminal: a fixed-height window over a transcript that scrolls out from under you. The
relay reads the last N lines on demand and stores nothing, so what an agent said an hour ago is
gone the moment it passes the read ceiling — and on a phone, where the pane is 40 lines tall and
the read is 200, "an hour ago" is closer to "ten minutes ago".

**Conversation mode is a recorder.** While a pane is open, the browser already receives its content
every few seconds, and the detector already knows which lines are the agent's messages and which
are the user's prompts. Conversation mode writes those out to the browser's own database as they go
by, under a name the user gives, and offers them back as a chat rather than a terminal.

Four things follow from that, and they are the whole feature:

1. **A conversation outlives the pane's scrollback.** The transcript is kept in the browser, so it
   survives the pane scrolling, `/clear`, the agent exiting, and the pane ID being recycled.
2. **A conversation is messages, not lines.** No box rules, no spinners, no tool output, no ANSI —
   what the agent said and what the user typed.
3. **The record is per pane; grouping is a view.** Each pane keeps its own transcript in its own
   order, always. A conversation names a *set* of panes — a pair, or any panes the user picks — and
   the joint thread is a render over those transcripts, never a second copy of them. Every member
   can therefore still be read alone, in its own order, with nothing lost by ungrouping.
4. **It records the session, not only its words.** Each member carries what it would take to stand
   that session up again (§4.1), and every prompt carries whether the user typed it, transferred it
   from another agent, or both (§4.2). Those are the two things a transcript is useless without once
   the panes are gone: what this was, and who actually said it.

---

## 2. Scope boundary

| In | Out |
|---|---|
| Recording messages of an open pane, into IndexedDB | Any relay-side storage, or a relay that records while nothing is watching |
| A named conversation grouping any number of panes, chosen by the user | Cross-device sync, sharing, a server |
| Chat rendering: agent / agent / user, chronological | Editing a recorded message, deleting one message |
| A joint view over the members, and each member alone | A merged *record* — grouping never rewrites a pane's own transcript |
| Per-session `spawn` metadata: agent, role, Project, cwd, host, where it was observed | A Respawn button in v1 (§4.1), a recorded placement or slot (§4.1), and any replay of a transcript into a new agent |
| Per-prompt provenance: typed, transferred, or mixed | Recording provenance for a send this browser did not make (§4.2) |
| Copy the whole conversation as Markdown | Search, filter, tags, folders |
| A `localStorage` fallback when IndexedDB is unavailable | Compression, the File System Access API, a worker, any storage library |

**No relay change of any kind.** Everything below runs on the `pane_content` messages the browser
already asks for. This is deliberate: the same recorder in the relay is a different feature with a
different cost (a poll per recorded pane, forever, whether or not anyone is looking), and
`HERDR_PUSH_SUMMARY` is the standing evidence that the detector is not yet trusted enough to run
unattended. See §10.

---

## 3. What is recorded, and from what

Nothing new is fetched. On every `pane_content` for a pane that belongs to a conversation, the
recorder runs over the rows it already has:

| Source | Already exists | Gives |
|---|---|---|
| `turnSummaries(rows, agent)` | yes, tested | one `[start, end]` per turn — the agent's closing message |
| `userInputLines(rows, agent)` | yes, tested | the line indices in the user's turn; adjacent indices are joined into one user message |
| `profileFor(agent)` | yes, tested | null for a harness with no profile — see below |

**`trimRange` is deliberately not in that list.** It applies a *learned* trim, and it keeps
learning: the same message extracted before and after the user teaches it once comes out as two
different strings, which is precisely what the overlap match (§4) reads as a new message. So the
transcript stores the block as found and the trim belongs to the view, where a preference that
changes is allowed to change what is on screen without rewriting what was said.

A harness with no profile (`opencode` today, and anything unknown) records **nothing** and says so
in the view. This is the same answer Summary already gives, and the alternative — guessing at a
boundary — writes wrong text into a store that outlives the pane it came from.

Recording is bound to the **conversation**, not to the view. A pane in a conversation records while
it is open no matter which of the two views is on screen; switching to the terminal must not punch
a hole in the transcript.

---

## 4. Storage

**A transcript is stored once, under the pane that said it. A conversation is a name and a list of
references.** Nothing is copied when a pane joins a conversation, and a pane in three conversations
is recorded once. The joint thread is composed at render time, every time (§6, §7.3).

**Two stores, split by what each is good at** (§4.4): the conversation *index* in `localStorage`,
because it is small and has to be on screen before the first `await`; the *transcripts* in
IndexedDB, because they are the part that grows and `localStorage` is a ~5 MB cap shared with
fourteen other keys.

```js
// localStorage['herdr_conversations'] — the index. Small, synchronous, versioned and parsed with
// the same contract parsePairs uses: a corrupt blob loads as nothing rather than as a half-index.
// No entries here, by construction. A conversation cannot hold a message, so it cannot hold a
// second copy of one.
{
  version: 1,
  items: [{
    id: 'c_8f3a1c22',
    name: 'new authentication feature',   // the user's identifier, 1–64 chars
    created: 1755000000000,
    members: [{
      key: '["local","w1:p1","claude","/x"]', added: 1755000000000, label: 'Architect 1',
      // Cached per member, so the landing list and the thread header render unawaited. Per member
      // rather than per conversation because a member's own record is the only one this browser
      // can count without opening every other member's; the total is their sum.
      messages: 24, seen: 1755000900000,
    }],
    pair_id: 'p_9c1d',                    // provenance: seeded from this pair. Nothing reads it back
  }],
}

// IndexedDB `herdr` → store `transcripts`, keyPath 'key' — the recordings.
// Keyed by the JSON encoding of `[host, pane_id, agent, cwd]`. The explicit encoding, rather
// than a delimiter join, keeps valid path text from making two fingerprints collide. A recycled
// pane_id with a different cwd lands on a different key and cannot inherit the dead session's
// words, which is the worst failure this feature has.
{
  key: '["local","w1:p1","claude","/x"]',
  label: 'Architect 1',                   // as of the last read; entries keep their own (§8)
  first: 1755000000000,
  touched: 1755000900000,                 // indexed, so eviction can range-scan by age
  spawn: { /* the session facts the browser can recover — §4.1 */ },
  entries: [{
    who: 'agent' | 'user',
    seen: 1755000012345,                  // when THIS BROWSER first saw the text — see §5
    text: 'Ready. Name the change.',      // joined, margin-stripped, capped at TEXT_MAX
    label: 'Architect 1',                 // the pane's name when this was recorded — see §8
    gap: true,                            // optional: recording resumed after a break, see §6
    via: 'typed' | 'transfer' | 'mixed',  // user entries only — where the words came from, §4.2
    from: { key: '["local","w1:p2","codex","/x"]', label: 'Reviewer 2', hash: 0x8f3a1c22 },  // via != typed
  }],
}
```

**Recording is per pane and does not consult the conversation list** beyond "is this pane in one at
all". One pass over the rows, one append, however many conversations reference it.

**Adding a member is retroactive, and removing one is not destructive.** A pane joining a
conversation brings the transcript it already has — everything recorded since it was first watched,
not only what it says next. Removing a member unlinks it; the transcript stays, and re-adding it
later gets the history back. This is the direct consequence of storing once: membership is a list
operation, never a transcript operation.

**A dangling reference is a rendered state, not an error.** A member whose transcript has been
evicted renders as "recording no longer held" in the thread and the conversation opens normally.

**Identity is the overlapping window, not a line number or just its text.** Every read shifts the
indices — the pane scrolls, `Load more` shifts them the other way — so the recorder matches the
longest exact suffix/prefix overlap between its previous normalized window and the current one.
It appends only the non-overlapping tail (or prepends the non-overlapping head on backfill). A
short hash may find candidates, but exact normalized text confirms every match. This preserves two
real, separate `Done.` messages in one pane; deduping against every text ever seen would silently
lose the second. Per transcript, not globally: two agents can both say `Done.` and both are real.

Three things the overlap has to be pinned to, or it is not implementable:

- **The unit is the extracted message, not the row.** Both windows are run through §3's extractors
  first, and the match is over that list. Rows would make every wrap width change look like a gap.
  *Normalized* means what `summary_body` already does to a range — gutter and box margin stripped,
  lines joined, runs of whitespace collapsed to one space — so the same message read at a phone
  width and a desktop width is one string. It is the comparison key only; `text` is stored as
  extracted.
- **Two messages are allowed to match inexactly**, and both are one message cut by the edges of a
  read rather than two different ones:
  - *The window's first message* can have its opener above the top of the read (agy starts blocks
    positionally, so this is reachable), so a stored message that **ends with** it is it. A
    truncated head is never appended and never rewrites the stored full text.
  - *The transcript's last message* was read while the agent was still writing it, so a fresh
    message that **starts with** it is that same message, longer — it is extended in place and
    keeps its original `seen`. This is the common one: every poll during a reply reads another few
    sentences of the same paragraph, and without this each poll appends another copy of it.
- **Only the tail is searched.** The scan compares at most the last `OVERLAP_MAX` (200) stored
  messages against the window, so the cost is bounded by the window and not by the transcript. No
  overlap inside that span is a gap (§6), not a reason to search further back.

**Ceilings, named.** IndexedDB's budget is a share of free disk, not 5 MB, so these are set by what
a thread is still readable at rather than by what fits:

| Constant | Value | Why |
|---|---|---|
| `OVERLAP_MAX` | 200 messages | how far back the overlap scan looks; a read window holds far fewer, so a miss here is a real gap and not a short search |
| `TEXT_MAX` | 4000 chars per entry | a closing message longer than this is a document; kept high because the store is no longer the constraint |
| `ENTRY_MAX` | 5000 entries per transcript | oldest-first eviction past it, per pane — a chatty pane must not evict a quiet one's history. Months of turns, not hours |
| `MEMBER_MAX` | 8 panes per conversation | past this the joint view stops being a thread; a soft cap the user is told about, not a silent drop |
| `CONV_MAX` | 200 conversations | oldest-*touched* first eviction past it |
| `TRANSCRIPT_MAX` | 500 transcripts | its own cap, because transcripts outlive the conversations that referenced them |
| `BYTES_TARGET` | 50 MB | checked against `navigator.storage.estimate()` where it exists (§4.4); evict until under it |

**Eviction order, once transcripts are shared.** Unreferenced first: a transcript no conversation
names and no open pane is writing to is the only thing here nobody asked to keep. Then oldest
`touched` among the rest. A referenced transcript is never dropped while an unreferenced one exists,
so naming a conversation is what protects its history — which is the promise the name makes.

A `QuotaExceededError` on write triggers one eviction pass and one retry. A store that still refuses
keeps the session's recording in memory and says so once — the same posture `setSound` and the theme
picker already take on private mode.

### 4.1 `spawn` — the session facts v1 can recover

A conversation outlives its panes, and the question it leaves behind is "what was this, and how do
I get it back". The `spawn` block records the session facts the browser can actually recover,
captured on the first read and refreshed while the pane is live. It sits on the transcript and not
on the membership, because it describes the session, and the session does not change when someone
files it under a second name.

```js
spawn: {
  agent: 'claude',            // harness kind — what herdr was asked to run
  role: 'architect',          // as roleOf() reads it off the label
  label: 'Architect 1',
  project_id: 'charts',       // normalized to '' when Projects are off — see the caveat below
  project: 'charts',          // display name, for a record a human reads years later
  cwd: '/Users/x/code/charts',
  host: 'local',              // or the HERDR_REMOTES target
  workspace_id: 'w1',         // where it was observed, not proof of how it was created
  tab_id: 't1',
  captured: 1755000900000,    // when this was last true
}
```

Every field above is in the pane record, except `role`, which `roleOf()` recovers from its label.
Nothing new is asked of the relay. `placement` and `slot` are deliberately absent: a snapshot tells
us the current workspace and tab, but not whether the pane was created in a workspace, tab, or
split, nor which slot it occupied. Recording invented values would make the future action wrong.

**Two honest limits, stated rather than designed around:**

- **`cwd` cannot spawn anything.** The relay takes a new session's directory from the Project, never
  from the client — that is a security property of `start_agent` and this feature does not touch it.
  So a member with a `project_id` can be respawned; one recorded while Projects were off carries
  `cwd` as a **note for a human**, not as a parameter. The view says which of the two it is.
- **A replacement is placed by today's layout, not by the dead pane's.** Nothing here replays a
  transcript into a new agent either, and offering to would be a feature that silently pastes hours
  of old output into a fresh context.

**Respawn is a v2 button, not a v1 one.** v1 records `spawn` and shows it ("claude · architect ·
charts"), with **Copy start details**. Recording is the part that cannot be added retroactively.

When v2 comes, placement is `duplicatePane()`'s rule and not a new dialog — the app already answers
this question from a snapshot, at `web/index.html:4326`: a recorded `workspace_id` that is still
live means `new_tab` in it, and anything else means `new_workspace`; `slot` comes from `slotFor()`,
which reads the viewport this browser has *now*. That is the correct answer rather than a cheaper
one: the slot exists to fit the screen the replacement is being watched on, and the dead pane's slot
was a fact about a screen someone had months ago. The dialog is only needed when the Project is
unknown.

### 4.2 `via` — typed, transferred, or both

P3 transfer moves one agent's words into another agent's composer, and after it lands the pane shows
that text as a prompt like any other. A transcript that cannot tell the two apart claims the user
said something a different agent said. So every `user` entry carries where its words came from:

| `via` | Means |
|---|---|
| `typed` | the user's own text |
| `transfer` | the payload `composeTransfer` built, sent unchanged |
| `mixed` | that payload, edited or added to before sending — the common case, since `doTransfer` **prefills and stops** |

**How it is known, given prompts are read back off the pane (§11.2).** `doTransfer` prefills the
composer and never sends; the user reads it, may edit it, and presses send. So:

1. `doTransfer` records a **pending transfer**: `{from_pane, from_label, body, hash, at}`, where
   `body` is the transferred text (not the instruction), and `hash` identifies the source entry.
2. On send, the outgoing text is classified against it: equal to the composed payload →
   `transfer`; still contains `body` → `mixed`; no longer contains it → `typed`.
3. The classification is written to a small **outbox** keyed by a hash of the sent text — 50
   entries, 30 minutes, in `localStorage` so a reload does not lose it. When the recorder later
   reads that prompt back off the pane, it matches the hash and tags the entry.
4. No match, or an expired one, means `typed`. Which is the honest failure mode and worth naming:
   **provenance is only knowable where the send happened.** A transfer done on the desktop and
   recorded on the phone reads as typed there — the phone never saw the transfer.

`from.hash` points at the source agent's own entry, so when the source pane is also a member the
joint view can draw the transfer as a link between two bubbles rather than a label on one. When it
is not a member, the label is all there is, and that is still the answer to "where did this come
from".

The agent's own entries are never given a `via`: everything an agent says is the agent saying it.
`from.key` names the source pane whether or not it is a member, so a transfer from a pane nobody
filed is still attributed.

### 4.3 Why the record is normalized — the trade, stated

The alternative considered was a conversation owning its members' entries, copying a pane's messages
into every conversation that names it. Rejected. What it costs to store once instead:

| Gained | Paid |
|---|---|
| A pane in *n* conversations is recorded once and written once, not *n* times | One indirection: the view resolves member keys before it can render |
| Adding a member brings its **existing** history, which the copying design could not do — there is no second copy to backfill from | Eviction needs a reference rule (above), because "delete the conversation" no longer means "delete its messages" |
| Removing a member is reversible: unlink, re-link, history intact | A dangling reference becomes a state the view has to render (above) |
| The per-pane order is structurally the only order stored, so "grouping is a view" is enforced by the schema rather than by discipline | Two collections to migrate together if the format ever changes |
| One transcript to correct when a message is wrong, one to export, one to reason about | |

**Verdict: normalize.** The costs are all one-time code; the copying design's costs are permanent
and grow with use. And its worst property is not the bytes — it is that two conversations over one
pane would slowly *disagree*, because each copy is appended to independently and one of them was
made while the app was on a different screen. A transcript that disagrees with itself is worse than
no transcript.

### 4.4 Where it lives: IndexedDB for the transcripts, `localStorage` for the index

`localStorage` is a ~5 MB origin-wide cap this app already spends fourteen keys of, it is
synchronous on the main thread, and every write re-serializes the whole value. Transcripts are the
one thing here that grows without limit — this feature exists *because* the pane's own history is
too short — so they go where growth is allowed.

| | `localStorage` | IndexedDB |
|---|---|---|
| Holds | the conversation index, the transfer outbox (§4.2), the view preferences | one record per transcript |
| Size | a few KB | tens of MB, evicted against `BYTES_TARGET` |
| Why there | read synchronously at boot, so the landing list and the menus render before any `await` | async, per-record writes, and no cap worth designing around |

**Reads.** Opening a conversation loads its members' transcripts by key — at most `MEMBER_MAX`
records, in one transaction. Nothing scans the store to render a thread. The landing list renders
from the index's cached `counts` and never touches IndexedDB at all, which is what keeps the app's
first screen synchronous.

**Writes.** One `put` per pane per read cycle at most, and only when that cycle actually produced a
new entry — a 3-second poll over an idle pane writes nothing. The recorder appends to an in-memory
copy of the transcript and the store write is the last step, so a rejected write costs the session's
tail and never a corrupt record.

**When IndexedDB is not there.** Private mode in some browsers, a blocked-by-policy store, an
`onblocked` upgrade: the store falls back to `localStorage` under the small ceilings the earlier
draft of this spec used (400 entries, 1 MB, oldest-first), tells the user once that history is being
kept short, and upgrades itself the next time IndexedDB opens successfully. A same-key record in
both places is overlap-merged during that upgrade: the database may predate a temporary failure,
so either side alone can lose a tail. **The app must not fail to render a pane because a transcript
could not be stored.** Recording is the feature; the terminal is the product.

**Persistence and quota are best-effort, and secure-context-only.** `navigator.storage.persist()`
and `.estimate()` do not exist on `http://192.168.x.x`, which is exactly how the relay serves this
page on a LAN — the same non-secure-context problem `newPairId` already works around for
`crypto.randomUUID`. So both are called behind a guard and their absence is normal: eviction then
runs on the record counts alone. Over HTTPS (the tunnel, or GitHub Pages) the persist request is
made once and its refusal is not an error.

**No library, no build step.** IndexedDB is reached through ~60 lines of promise wrappers in the
same file as everything else, keeping the app's one-file property intact.

**Testability, which the split changes.** The recorder stays pure — rows in, entries out — and is
what `tests/test_conversation.js` extracts and runs in a `vm`, with no store of any kind. The
persistence layer is thin by design and is covered in the browser, where there is a real
IndexedDB, by `tests/e2e/browser/conversation.spec.js` (§9). Any logic that migrates into the store
layer is logic that leaves the fast suite, so it does not.

---

## 5. Timestamps: `seen` is observation, `at` is the best answer available

A pane carries no clock. Nothing in `pane read` says when a line was printed, so the fold can only
say **when it first saw the text**. That field is `seen`, it is the fold's own clock, and the
overlap machinery is built on it — it never changes meaning.

`at` is a second field, added later, and it answers a different question: *when was this said*.
`at_src` says how good the answer is, and every reader goes through `convAt(e)` (`e.at || e.seen`)
so records written before the field existed keep working.

| `at_src` | Accuracy | Where it comes from |
|----------|----------|---------------------|
| `sent` | Exact | The user pressed send in this browser; the outbox stamped the moment |
| `state` | Within one relay poll | The pane's own `done`/`blocked` transition ended that turn |
| `read` | The fold's clock | The turn is still being written, so "now" is the honest answer |
| `backfill` | Unknown, but older than everything live | Scrollback that predates this browser's first read of the pane |

The relay pushes a status for **every** pane, open or not, so `state` is available for a member
nobody is reading — which is the whole reason the joint thread can order two panes at all. The
transitions are held in memory only: one this browser was not connected for was never observed, and
a stored one would date a message by a session that saw a different turn.

### 5.1 A committed entry is append-only

Recording is not a view of the pane. Once an entry is written to the store:

- **Its text may only be extended, never replaced.** The one legal edit is the message that was
  still being written when it was last read, now read whole — and only where the committed words
  are still the start of the new ones. A longer text that does not begin with what was committed is
  a misalignment, not a finished message, and taking it would rewrite history to match the current
  frame.
- **Its stamp may only improve.** `at_src` is ranked `backfill < read < state < sent`; a later fold
  may raise it — a turn that ended after the entry was written now has a real closing time — and
  may never lower it, and never moves a `sent` stamp.
- **Streaming pane content does not own it.** `pane_content` folds into *new* entries. The
  conversation view renders the committed record, never the frame.

**An entry becomes committed when the turn ends.** A turn in progress has no closing message yet,
and what the detector reports in its place moves: it reads the block above the live composer, so
each new block the agent prints *replaces* the last one rather than extending it. That entry is a
**draft** — marked `draft: true`, the thing the thread shows while the agent works, and a record of
nothing until the pane's `done`/`blocked` transition drops the flag and stamps it `state`.

Drafts sit outside the append-only rule and nowhere else does. Concretely:

- Only the newest entry may be a draft, only while the pane's status is `working`, and never a user
  prompt — a prompt is real the moment it is on screen.
- A fold peels trailing drafts off *before* aligning the window. This is the load-bearing part: a
  stored tail that is nowhere in the new window agrees with no offset, the alignment fails, and the
  failure path appends the whole window. One moving message duplicated every message on screen with
  it, which is the bug drafts exist to close.
- A draft that comes back word for word is not news: the fold reports nothing, so a quiet poll
  mid-turn neither re-renders the thread nor writes the record.
- The durable write follows the same boundary — §4.4 defers the IndexedDB put while the pane is
  working, with a 30s flush and a flush on `visibilitychange`/`pagehide` behind it.

The cost is stated plainly: a mid-turn message the agent printed and then printed past is not kept.
One agent bubble per turn, live while it is being written, frozen when the turn ends.

Two consequences of the pane having no clock of its own, both worth stating in the UI rather than
hiding:

- **A conversation only advances while its pane is open.** Everything an agent said with the app
  closed is `backfill`: ordered, marked, and placed just before the first read, never dated. The first read of a pane is 200
  lines deep, so that backfill is usually the last few turns — but it is backfill, and §6 says how
  it is ordered.
- **Within a member the order is exact; between members it is as good as the polling.** A pane's
  own transcript is stored in the pane's own order and no timestamp is ever what orders it — that is why
  a member always reads correctly on its own, however coarse the clock was. The joint view is the
  only place a timestamp is used for ordering, and two messages 3 seconds apart may have been
  printed in the other order. So the joint view draws no precision it does not have: no seconds,
  no "replying to", and a member's own order is never broken to satisfy a timestamp.

---

## 6. Ordering, backfill, and gaps

- **Within one read**, entries are appended in window order. That order is the pane's own and is
  exact.
- **Backfill** — a `Load more` that reveals older turns — uses the same overlap and inserts the
  unmatched head at the front of that pane's run. Those entries take the `seen` of the oldest entry
  they precede, an `at` just below it, and are flagged `backfill: true`; they are not given the current time, which would
  put an hour-old message at the end of the thread.
- **A gap** is detectable and is worth drawing. If the prior and current normalized windows have
  no exact overlap, something may have scrolled past between reads. The next entry carries
  `gap: true` and the view draws a thin "…" rule above it. This is the difference between a
  transcript with a possible hole and a transcript that lies.
- **The joint view is a stable merge**, not a sort. Each member's transcript is walked in its own
  order and the merge only chooses *which member goes next*, by `convAt`. A member's own sequence can
  therefore never be reordered by a coarse timestamp — the worst a bad clock can do is interleave
  two members badly, which is visible and honest, rather than shuffle one agent's own turns, which
  would be a lie about a single transcript.

---

## 7. The views

### 7.1 The switch: a Conversation button in the quick actions bar

The bar above the composer already carries the controls that are about *reading* the pane — fold,
‹ ›, Summary, Last — and it sits under the thumb. The switch belongs there, at the **left** of the
nav row beside the fold control, and not in the header: the header's five controls are all
destructive or global (QUIT, CLS, refresh, settings), and this is neither.

```
┌──────────────────────────────────────────────┐
│  v  │ 💬 │      ‹      ›      │ Summary Last │   💬 = terminal ⇄ conversation
└──────────────────────────────────────────────┘
```

It is a toggle, it shows which view is on (pressed state, `aria-pressed`), and it does not reload
the pane — the rows are already in memory, so switching is a re-render and nothing goes on the wire.
Offered only on a pane that is in a conversation; a button that does nothing on most panes teaches
people to stop pressing it. Which view a pane was last read in is remembered per pane, because a
pane being watched as a terminal and one being followed as a thread are two different jobs.

Recording is unaffected by the switch (§3). Reading a pane as a terminal never costs a transcript.

### 7.2 Conversation view, one pane

The pane rows are replaced; header, composer and quick actions stay exactly where they are.

```
┌──────────────────────────────────────────────┐
│ ‹  ●  Architect 1              QUIT CLS ↻ ⚙ │
├──────────────────────────────────────────────┤
│  new authentication feature · 24 messages    │   conversation name, tap to rename
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄ 12:04 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
│                                              │
│      ┌────────────────────────────────────┐  │
│      │ add a login screen with SSO        │  │   user: right, --blue wash
│      └────────────────────────────────────┘  │
│  ┌───────────────────────────────────────┐   │
│  │ Added web/login.html and wired the     │   │  agent: left, pane's own tint
│  │ callback. Tests pass.                  │   │
│  └───────────────────────────────────────┘   │
│      ┌────────────────────────────────────┐  │
│      │ ⇄ Reviewer 2 · edited              │  │   via: mixed (§4.2) — the source, named
│      │ Review, edit, fix; then propose…   │  │
│      └────────────────────────────────────┘  │
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄ ⋯ 41 min ⋯ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │   a gap (§6)
└──────────────────────────────────────────────┘
```

A transferred prompt wears a `⇄` and the pane it came from. `transfer` says the name alone;
`mixed` adds "edited", because "the user approved this verbatim" and "the user rewrote it" are
different facts about the same bubble. Tapping the marker scrolls to the source entry when its pane
is a member of this conversation — which is the whole reason `from.hash` is stored.

Under the conversation name, a **members strip**: each member's colour, label, live/gone, and its
`spawn` line ("claude · architect · charts · new\_tab"), collapsed to one row until tapped. That is
where a conversation whose panes have all exited says what it was.

### 7.3 Conversation view, several panes

**A pane in a pair opens on the joint thread by default.** That is what the pair says the two panes
are: one piece of work. Both transcripts, each in its own order, stably merged (§6), with a header
row naming the members and their colours.

**"Show paired conversation" turns that off**, in the pane settings menu (`#termMenu`, beside
`Enter sends` and the wrap-mode picker) and stored as `herdr_conv_joint`. Off means this pane's own
transcript alone — which is always available, because the joint thread is only ever a render and
the per-pane record is never merged on disk (§4).

Colour carries "who", so it reuses what the app already assigns: **`PAIR_TINTS` hues**, one per
member in member order, mixed at low alpha exactly as the tab strip mixes them, with the user in
`--blue`. Every agent bubble also carries its pane label ("Architect 1") — two washes of the same
family are not enough on a phone in sunlight, and past two members colour alone stops working.

A conversation with more members than the pair (§4, up to `MEMBER_MAX`) renders identically; the
pair is not a special case in the view, only the thing that seeds the default.

### 7.4 Where it is reached

- **One pane menu item, opening one sheet**, because joining an existing conversation and naming a
  new one are the same act: membership is a list the user edits, and splitting them into two items
  would ask the user to know which they wanted before seeing what exists. The item names the state
  it is in — "Start conversation…" with none, "Add to a conversation…" with some, `In "…"` once
  this pane is in one. The sheet lists every conversation with a tick for membership, tapping is
  the toggle, and a name field underneath starts a new one.
- **When the pane is in a healthy pair**, the sheet offers the partner as a second member, checked,
  as one tap. The pair is a suggestion, not a constraint — the members are a list the user edits.
  A *stale* pair is not offered: its partner is a pane this browser has not verified, and seeding a
  member from it would record a fingerprint nothing on the other end matches.
- This is the whole of "beyond a pair": membership has no requirement that the panes are paired, on
  one host, or even still alive at the same time.
- **A "Conversations" section on the landing page**, in the existing `herdr_sections` machinery,
  listing name, member count, message count, last-seen, and which members are still live. A
  conversation whose panes are gone is still readable — that is the point of it.

---

## 8. Naming and identity

The name is the identifier, given by the user at creation ("new authentication feature"), 1–64
chars, stored verbatim and rendered through `escapeHtml`. It is not derived from the pane, the
project or the branch: a conversation spans a pane's whole life, and every automatic name available
here (project, cwd, first prompt) is wrong by the second turn.

Members are the user's list, not the pair's. A conversation seeded from a pair keeps recording after
the pair is deleted, and adding a third pane does not touch the pair. `pair_id` is provenance only —
where the members came from — and nothing reads it back.

The record binds pane fingerprints, so:

- A pane that exits and comes back with the same ID and a different cwd does **not** rejoin —
  `memberMatches` says no, and that member shows as "no longer live", still readable.
- A pane that comes back matching on all four fields **does** rejoin, and recording continues. This
  is the `/quit` then restart case, which is the common one.
- Renaming a pane (`rename_pane`) changes the label shown on new entries. Old entries keep the
  label they were recorded with, because that is what the transcript said at the time.

---

## 9. Tests

| Suite | What |
|---|---|
| `tests/test_conversation.js` (new, vm slice) | the recorder as a pure function: adjacent user rows become one message; overlap dedupe preserves repeated identical messages, append order, backfill insertion, gap detection, `TEXT_MAX` truncation, eviction at each ceiling, corrupt-blob parse, one pane recorded into two conversations |
| `tests/test_conversation.js` | the `via` classifier (§4.2): the composed payload sent unchanged is `transfer`, the payload with an instruction typed over it is `mixed`, the payload deleted and replaced is `typed`, an expired outbox entry is `typed`. Fed by `composeTransfer` itself, so a change to the payload shape breaks the classifier's test rather than the classifier |
| `tests/test_conversation.js` | the overlap's pinned cases (§4): a reply still being written is extended rather than appended again; a truncated head neither duplicates nor overwrites the stored message; a pane that scrolled past a whole window is a `gap` and not a search further back; a window re-read at a different wrap width is not a gap |
| `tests/test_conversation.js` | `spawn` is captured only from snapshot fields plus `roleOf()`: it records workspace/tab as observations and never invents placement or slot |
| `tests/test_conversation.js` | the merge: three members interleave by `seen`, **and no member's own order is ever broken** — the property that lets a member be read alone. Fed by `tests/fixtures/pane_*_done.txt`, the same panes the detector is tested on, so a harness whose glyphs change breaks here too |
| `tests/e2e/browser/conversation.spec.js` (new) | naming a conversation, the thread rendering, a pair opening on the joint thread, "Show paired conversation" off leaving the pane's own transcript unchanged, adding a third pane, the quick-actions toggle surviving a pane switch, the landing-page section outliving a pane that has gone |
| `tests/e2e/browser/conversation.spec.js` | the store layer (§4.4), which the vm slice cannot see: a transcript written and read back across a **page reload**, the index in `localStorage` agreeing with the records in IndexedDB, eviction dropping unreferenced transcripts first, and a conversation whose panes are gone still opening |
| `tests/e2e/browser/conversation.spec.js` | the `localStorage` fallback: with `indexedDB` stubbed to throw on `open`, recording still works under the small ceilings, and the same page with IndexedDB restored self-upgrades — the transcripts already in `localStorage` move across and are not read twice |

The recorder must be written as a pure block (rows in, entries out) so the vm slice can reach it —
the same constraint the P3 pair logic carries and for the same reason. The store is the other side
of that line: it is asynchronous and it is the browser's, so it is proved in a real browser and
never in a `vm` context.

---

## 10. Why this is frontend-only, given the relay now has the detector

`relay/pane_summary.py` exists and is the same parser. It is not the right place for this:

- The relay reads a pane **on demand**, for a client that is watching. A relay-side recorder needs
  its own poll per recorded pane, running for as long as the conversation exists, whether or not
  anyone is connected — a standing cost on the relay, on every SSH hop, and on nothing anyone asked
  for.
- The trim is the user's. `trimRange` applies a *learned* trim that lives in this browser's
  `localStorage`; the relay deliberately does not have it (see the port's docstring).
- `HERDR_PUSH_SUMMARY` is off by default because the detector is new and a wrong summary is worse
  than a vague one. Writing wrong summaries into durable storage is that same bet at longer odds.

If the recorder is later wanted server-side, this spec is the shape of it and §4's record is the
wire format. That is a different phase.

---

## 11. V1 decisions

1. **Record only the actively read pane.** Recording every member needs a background read per member
   (a `read_pane` every ~12s for a pane nobody is looking at), and that scales with `MEMBER_MAX`,
   not with two. Without it, each member's transcript advances only while that member is on screen —
   which is what agents watched in turn actually look like, and the joint view already draws the
   resulting gaps honestly (§6). If background recording is added later it is a poll budget
   (N members × 12s), not a change to anything above.
2. **Read the user's own sent text back from the pane.** Recording at send time is exact, immediate,
   and includes what a shortcut sent, but it can disagree with what the agent actually received.
   Readback is one code path and cannot disagree with the pane; a prompt sent while the pane is
   closed lands at the next open.
3. **No explicit end in v1.** A conversation whose panes are gone is visibly finished, and eviction
   handles the rest.
4. **One global `herdr_conv_joint` preference.** It is how every other pane-view setting in the
   menu behaves. Revisit only if someone actually wants both views at once.
5. **Export both ways.** Markdown goes to the clipboard, with a `Blob` download fallback for the
   plain-HTTP LAN page where the clipboard API may be blocked.

---

## 12. Rough sizing

| Piece | Size |
|---|---|
| Recorder + overlap match + merge (pure, vm-testable) | ~170 lines |
| IndexedDB wrapper — open, `get`/`put`/`getAll`, the age index, eviction | ~60 lines |
| `localStorage` index + fallback store + self-upgrade | ~50 lines |
| Views (one member, N members) and CSS | ~140 lines |
| Quick-actions toggle and the menu setting | ~30 lines |
| Menus, naming dialog, member editor, landing-page section | ~110 lines |
| Copy/export | ~20 lines |
| Tests (vm slice + Playwright) | ~340 lines |

No new dependency, no build step, no relay change.
