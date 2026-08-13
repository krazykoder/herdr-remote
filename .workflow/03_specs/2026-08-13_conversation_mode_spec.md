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
are the user's prompts. Conversation mode writes those out to `localStorage` as they go by, under a
name the user gives, and offers them back as a chat rather than a terminal.

Three things follow from that, and they are the whole feature:

1. **A conversation outlives the pane's scrollback.** The transcript is kept in the browser, so it
   survives the pane scrolling, `/clear`, the agent exiting, and the pane ID being recycled.
2. **A conversation is messages, not lines.** No box rules, no spinners, no tool output, no ANSI —
   what the agent said and what the user typed.
3. **The record is per pane; grouping is a view.** Each pane keeps its own transcript in its own
   order, always. A conversation names a *set* of panes — a pair, or any panes the user picks — and
   the joint thread is a render over those transcripts, never a second copy of them. Every member
   can therefore still be read alone, in its own order, with nothing lost by ungrouping.

---

## 2. Scope boundary

| In | Out |
|---|---|
| Recording messages of an open pane into `localStorage` | Any relay-side storage, or a relay that records while nothing is watching |
| A named conversation grouping any number of panes, chosen by the user | Cross-device sync, sharing, a server |
| Chat rendering: agent / agent / user, chronological | Editing a recorded message, deleting one message |
| A joint view over the members, and each member alone | A merged *record* — grouping never rewrites a pane's own transcript |
| Copy the whole conversation as Markdown | Search, filter, tags, folders |
| Byte budget with oldest-first eviction | Compression, IndexedDB, the File System Access API |

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
| `userInputLines(rows, agent)` | yes, tested | the line indices the user typed on |
| `trimRange(range, agent)` | yes, tested | the user's learned trim, applied to each range |
| `profileFor(agent)` | yes, tested | null for a harness with no profile — see below |

A harness with no profile (`opencode` today, and anything unknown) records **nothing** and says so
in the view. This is the same answer Summary already gives, and the alternative — guessing at a
boundary — writes wrong text into a store that outlives the pane it came from.

Recording is bound to the **conversation**, not to the view. A pane in a conversation records while
it is open no matter which of the two views is on screen; switching to the terminal must not punch
a hole in the transcript.

---

## 4. Storage

One key, `herdr_conversations`, versioned and parsed with the same contract `parsePairs` uses — a
corrupt blob loads as *nothing* rather than as a partial transcript.

```js
{
  version: 1,
  items: [{
    id: 'c_8f3a1c22',
    name: 'new authentication feature',   // the user's identifier, 1–64 chars
    created: 1755000000000,
    touched: 1755000900000,               // last recorded entry, for eviction order (§4 ceilings)
    // One transcript per pane, never merged on disk. Each member's `entries` is that pane's own
    // order and nothing else's, which is what lets a member be read alone (§7.1) and what makes
    // adding or removing a member a change to a list rather than a rewrite of a transcript.
    //
    // The fingerprint is the shape pairs use, so memberMatches() rejects a recycled pane_id: a
    // pane_id with a different cwd is a different session, and appending its words to this
    // transcript is the worst failure this feature has.
    members: [{
      pane_id: 'w1:p1', host: 'local', agent: 'claude', cwd: '/x',
      label: 'Architect 1',               // as of the last read; entries keep their own (§8)
      added: 1755000000000,
      entries: [{
        who: 'agent' | 'user',
        seen: 1755000012345,              // when THIS BROWSER first saw the text — see §5
        text: 'Ready. Name the change.',  // joined, margin-stripped, capped at TEXT_MAX
        gap: true,                        // optional: recording resumed after a break, see §6
      }],
    }],
    pair_id: 'p_9c1d',                    // set when the conversation was seeded from a pair
  }],
}
```

**A pane may belong to more than one conversation.** Two conversations over the same pane record the
same entries twice, which is the honest cost of a grouping the user chose and is bounded by the
same ceilings as everything else. The recorder writes to every conversation the pane is a member
of, in one pass over the rows.

**Adding and removing members.** "Add a pane to this conversation…" appends a member with its own
empty transcript, which then fills from that pane's first read — a member added today does not
retroactively acquire yesterday's messages, because nothing outside the pane's current scrollback
exists to acquire. Removing a member takes its transcript with it, and takes a confirmation.

**Identity is the text, not the line number.** Every read shifts the indices — the pane scrolls,
`Load more` shifts them the other way — so an entry is deduped on a 32-bit hash of its normalized
text. The recorder keeps the last ~200 hashes of each *member* in memory and appends only what that
member has not said. Per member, not per conversation: two agents can say "Done." and both are
real.

**Ceilings, named.** `localStorage` is ~5 MB for the whole origin and this app already keeps
fourteen other keys in it, so the transcript takes a budget rather than all of it:

| Constant | Value | Why |
|---|---|---|
| `TEXT_MAX` | 2000 chars per entry | a closing message longer than this is a document, and the tail of it is the part that matters |
| `ENTRY_MAX` | 400 entries per member | oldest-first eviction past it, per transcript — a chatty member must not evict a quiet one's history |
| `MEMBER_MAX` | 8 panes per conversation | past this the joint view stops being a thread; a soft cap the user is told about, not a silent drop |
| `CONV_MAX` | 16 conversations | oldest-*touched* first eviction past it |
| `BYTES_MAX` | 1 MB serialized | checked on write; evict oldest entries across all conversations until it fits |

`QuotaExceededError` on write is caught, triggers one eviction pass, and retries once. A browser
that still refuses keeps the conversation in memory for the session and says so once — the same
posture `setSound` and the theme picker already take on private mode.

---

## 5. Timestamps are observation times, and the field is named for it

A pane carries no clock. Nothing in `pane read` says when a line was printed, so a recorder on this
side of the wire can only say **when it first saw the text**. The field is `seen`, not `at`, and the
view says "seen 14:02" rather than pretending otherwise.

Two consequences, both worth stating in the UI rather than hiding:

- **A conversation only advances while its pane is open.** Everything an agent said with the app
  closed arrives stamped with the moment the app was next opened. The first read of a pane is 200
  lines deep, so that backfill is usually the last few turns — but it is backfill, and §6 says how
  it is ordered.
- **Within a member the order is exact; between members it is as good as the polling.** A pane's
  own transcript is stored in the pane's own order and `seen` is never what orders it — that is why
  a member always reads correctly on its own, however coarse the clock was. The joint view is the
  only place `seen` is used for ordering, and two messages seen 3 seconds apart may have been
  printed in the other order. So the joint view draws no precision it does not have: no seconds,
  no "replying to", and a member's own order is never broken to satisfy a timestamp.

---

## 6. Ordering, backfill, and gaps

- **Within one read**, entries are appended in window order. That order is the pane's own and is
  exact.
- **Backfill** — a `Load more` that reveals older turns — produces entries that belong *before*
  what is already stored. They are inserted at the front of that pane's run and stamped with the
  `seen` of the oldest entry they precede, flagged `backfill: true`. They are not given the current
  time; that would put an hour-old message at the end of the thread.
- **A gap** is detectable and is worth drawing. If none of that member's recent hashes appear
  anywhere in the current window, the window does not overlap what is stored — something was said
  and scrolled past between two reads. The next entry carries `gap: true` and the view draws a thin
  "…" rule above it. This is cheap (a set intersection over the window) and it is the difference
  between a transcript with a hole in it and a transcript that lies.
- **The joint view is a stable merge**, not a sort. Each member's transcript is walked in its own
  order and the merge only chooses *which member goes next*, by `seen`. A member's own sequence can
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
│  ┄┄┄┄┄┄┄┄┄┄┄┄┄ ⋯ 41 min ⋯ ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │   a gap (§6)
└──────────────────────────────────────────────┘
```

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

- **A pane menu item, "Start conversation…"**, which asks for the name and nothing else.
- **When the pane is in a pair**, the same item offers both panes pre-selected, as one tap. The
  pair is a suggestion, not a constraint — the members are a list the user edits.
- **"Add this pane to a conversation…"** on any pane, listing existing conversations and "New…".
  This is the whole of "beyond a pair": membership is the user's list, with no requirement that the
  panes are paired, on one host, or even still alive at the same time.
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
| `tests/test_conversation.js` (new, vm slice) | the recorder as a pure function: dedupe per member, append order, backfill insertion, gap detection, `TEXT_MAX` truncation, eviction at each ceiling, corrupt-blob parse, one pane recorded into two conversations |
| `tests/test_conversation.js` | the merge: three members interleave by `seen`, **and no member's own order is ever broken** — the property that lets a member be read alone. Fed by `tests/fixtures/pane_*_done.txt`, the same panes the detector is tested on, so a harness whose glyphs change breaks here too |
| `tests/e2e/browser/conversation.spec.js` (new) | naming a conversation, the thread rendering, a pair opening on the joint thread, "Show paired conversation" off leaving the pane's own transcript unchanged, adding a third pane, the quick-actions toggle surviving a pane switch, the landing-page section outliving a pane that has gone |

The recorder must be written as a pure block (rows in, entries out) so the vm slice can reach it —
the same constraint the P3 pair logic carries and for the same reason.

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

## 11. Open questions

1. **Does a conversation record only the open pane, or every member?** Recording every member needs
   a background read per member (a `read_pane` every ~12s for a pane nobody is looking at), and
   this now scales with `MEMBER_MAX`, not with two. Without it, each member's transcript advances
   only while that member is on screen — which is what agents watched in turn actually look like,
   and the joint view already draws the resulting gaps honestly (§6). **Recommendation: only the
   open pane in v1**, and revisit with real transcripts. If it is added later it is a poll budget
   (N members × 12s), not a change to anything above.
2. **Should the user's own sent text be recorded at send time** (exact, immediate, and includes
   what a shortcut sent) **or read back off the pane** (matches what the agent actually received)?
   Reading it back is one code path instead of two and cannot disagree with the pane.
   **Recommendation: read it back**, and accept that a prompt sent while the pane is closed lands
   at the next open.
3. **Does a conversation ever end?** Nothing here archives one. **Recommendation: no explicit end
   in v1** — a conversation whose panes are gone is already visibly finished, and eviction handles
   the rest.
4. **Is "Show paired conversation" per pane, per conversation, or global?** It is written as one
   stored preference (`herdr_conv_joint`), which is the smallest thing that works and is how every
   other pane-view setting in the menu behaves. Per conversation would let one thread be joint and
   another split, at the cost of a setting that answers differently depending on where you opened
   it. **Recommendation: one preference**, revisit only if someone actually wants both at once.
5. **Export format:** Markdown to the clipboard is proposed. A file download is one more line
   (`Blob` + `<a download>`) and works where the clipboard API is blocked on plain HTTP over a LAN
   address — which is exactly how this app is served. **Recommendation: both, download as the
   fallback.**

---

## 12. Rough sizing

| Piece | Size |
|---|---|
| Recorder + store + merge (pure, vm-testable) | ~140 lines |
| Views (one member, N members) and CSS | ~140 lines |
| Quick-actions toggle and the menu setting | ~30 lines |
| Menus, naming dialog, member editor, landing-page section | ~110 lines |
| Copy/export | ~20 lines |
| Tests (vm slice + Playwright) | ~280 lines |

No new dependency, no build step, no relay change.
