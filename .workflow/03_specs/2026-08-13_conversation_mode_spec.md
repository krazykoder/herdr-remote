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
3. **A pair is one conversation.** Two panes working on the same thing read as one thread, with
   the two agents and the user coloured apart.

---

## 2. Scope boundary

| In | Out |
|---|---|
| Recording messages of an open pane into `localStorage` | Any relay-side storage, or a relay that records while nothing is watching |
| A named conversation binding one pane or one pair | Cross-device sync, sharing, a server |
| Chat rendering: agent / agent / user, chronological | Editing a recorded message, deleting one message |
| Merging a pair's two panes into one thread | Merging panes that are not a pair, or more than two |
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
    // Which panes feed it. The same fingerprint shape pairs use, so memberMatches() rejects a
    // recycled pane_id: a pane_id with a different cwd is a different session, and appending its
    // words to this transcript is the worst failure this feature has.
    members: [{ pane_id: 'w1:p1', host: 'local', agent: 'claude', cwd: '/x', label: 'Architect 1' }],
    pair_id: 'p_9c1d',                    // set when the conversation was made from a pair
    entries: [{
      who: 'agent' | 'user',
      pane: 'w1:p1',                      // which member said it; the view colours by this
      seen: 1755000012345,                // when THIS BROWSER first saw the text — see §5
      text: 'Ready. Name the change.',    // joined, margin-stripped, capped at TEXT_MAX
      gap: true,                          // optional: recording resumed after a break, see §6
    }],
  }],
}
```

**Identity is the text, not the line number.** Every read shifts the indices — the pane scrolls,
`Load more` shifts them the other way — so an entry is deduped on a 32-bit hash of
`pane + normalized text`. The recorder keeps the last ~200 hashes of each conversation in memory
and appends only what it has not seen.

**Ceilings, named.** `localStorage` is ~5 MB for the whole origin and this app already keeps
fourteen other keys in it, so the transcript takes a budget rather than all of it:

| Constant | Value | Why |
|---|---|---|
| `TEXT_MAX` | 2000 chars per entry | a closing message longer than this is a document, and the tail of it is the part that matters |
| `ENTRY_MAX` | 400 entries per conversation | oldest-first eviction past it |
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
- **Between two panes of a pair, ordering is as good as the polling and no better.** Within one
  pane the order is exact (it is the pane's own order). Across two panes, two messages seen 3
  seconds apart may have been printed in the other order. The view therefore groups by pane and
  orders by `seen`, and does not draw a precision it does not have (no seconds, no "replying to").

---

## 6. Ordering, backfill, and gaps

- **Within one read**, entries are appended in window order. That order is the pane's own and is
  exact.
- **Backfill** — a `Load more` that reveals older turns — produces entries that belong *before*
  what is already stored. They are inserted at the front of that pane's run and stamped with the
  `seen` of the oldest entry they precede, flagged `backfill: true`. They are not given the current
  time; that would put an hour-old message at the end of the thread.
- **A gap** is detectable and is worth drawing. If none of the conversation's recent hashes appear
  anywhere in the current window, the window does not overlap what is stored — something was said
  and scrolled past between two reads. The next entry carries `gap: true` and the view draws a thin
  "…" rule above it. This is cheap (a set intersection over the window) and it is the difference
  between a transcript with a hole in it and a transcript that lies.

---

## 7. The views

### 7.1 Single pane

The terminal view's rows are replaced; the header, composer, quick actions and everything else stay
exactly where they are. Switching is one control and does not reload the pane.

```
┌──────────────────────────────────────────────┐
│ ‹  ●  Architect 1        [💬]  QUIT CLS ↻ ⚙ │   💬 toggles conversation ⇄ terminal
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

### 7.2 A pair

One thread, both panes, three speakers. Colour is the only thing carrying "who", so it reuses what
the app already assigns: **the pair's own `--tint` hue** for one half and the next hue in
`PAIR_TINTS` for the other, mixed at low alpha exactly as the tab strip mixes it, with the user in
`--blue`. Each agent bubble carries its pane label ("Architect 1") because two washes of the same
family are not enough on a phone in sunlight. Nothing new enters the palette.

### 7.3 Where it is reached

- **A pane menu item, "Start conversation…"**, which asks for the name and nothing else.
- **A pair menu item of the same name** when the pane is in a pair — it binds both panes.
- **The 💬 button in the term header** once a conversation exists for the open pane, toggling the
  two views. Persisted per conversation, not globally: a pane being read as a terminal and one
  being read as a thread are two different jobs.
- **A "Conversations" section on the landing page**, in the existing `herdr_sections` machinery,
  listing name, message count, last-seen, and whether its panes are still live. A conversation
  whose panes are gone is still readable — that is the point of it.

---

## 8. Naming and identity

The name is the identifier, given by the user at creation ("new authentication feature"), 1–64
chars, stored verbatim and rendered through `escapeHtml`. It is not derived from the pane, the
project or the branch: a conversation spans a pane's whole life, and every automatic name available
here (project, cwd, first prompt) is wrong by the second turn.

The record binds pane fingerprints, so:

- A pane that exits and comes back with the same ID and a different cwd does **not** rejoin —
  `memberMatches` says no, and the conversation shows as "panes no longer live", still readable.
- A pane that comes back matching on all four fields **does** rejoin, and recording continues. This
  is the `/quit` then restart case, which is the common one.
- Renaming a pane (`rename_pane`) changes the label shown on new entries. Old entries keep the
  label they were recorded with, because that is what the transcript said at the time.

---

## 9. Tests

| Suite | What |
|---|---|
| `tests/test_conversation.js` (new, vm slice) | the recorder as a pure function: dedupe by hash, append order, backfill insertion, gap detection, `TEXT_MAX` truncation, eviction at each ceiling, corrupt-blob parse |
| `tests/test_conversation.js` | fed by `tests/fixtures/pane_*_done.txt`, the same panes the detector is tested on — a harness whose glyphs change breaks here too |
| `tests/e2e/browser/conversation.spec.js` (new) | naming a conversation, the thread rendering, the pair thread interleaving two panes, the toggle surviving a pane switch, the landing-page section outliving a pane that has gone |

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

1. **Does a conversation record only the open pane, or both halves of a pair?** Recording both
   needs a background read of the partner (a `read_pane` every ~12s for a pane nobody is looking
   at). Without it, a pair thread only advances for whichever half is on screen — and a pair is
   two agents talking to *the user*, alternately, so in practice each half is on screen while it
   matters. **Recommendation: only the open pane in v1**, and revisit with real transcripts.
2. **Is the 💬 toggle earning a slot in a header that already has five controls?** The alternative
   is a menu item and no header button. **Recommendation: header button**, because the toggle is
   the feature and a menu round-trip per switch is the thing that stops people using it.
3. **Should the user's own sent text be recorded at send time** (exact, immediate, and includes
   what a shortcut sent) **or read back off the pane** (matches what the agent actually received)?
   Reading it back is one code path instead of two and cannot disagree with the pane.
   **Recommendation: read it back**, and accept that a prompt sent while the pane is closed lands
   at the next open.
4. **Does a conversation ever end?** Nothing here archives one. **Recommendation: no explicit end
   in v1** — a conversation whose panes are gone is already visibly finished, and eviction handles
   the rest.
5. **Export format:** Markdown to the clipboard is proposed. A file download is one more line
   (`Blob` + `<a download>`) and works where the clipboard API is blocked on plain HTTP over a LAN
   address — which is exactly how this app is served. **Recommendation: both, download as the
   fallback.**

---

## 12. Rough sizing

| Piece | Size |
|---|---|
| Recorder + store (pure, vm-testable) | ~120 lines |
| Views (single + pair) and CSS | ~140 lines |
| Menus, naming dialog, landing-page section | ~90 lines |
| Copy/export | ~20 lines |
| Tests (vm slice + Playwright) | ~250 lines |

No new dependency, no build step, no relay change.
