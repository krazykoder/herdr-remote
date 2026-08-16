# One walk over every destination

*2026-08-15 · concept · **steps 1–4 are now built**; this document is kept as the reasoning behind
them. What shipped differs from the plan below in one place only, noted under step 4.*

## What exists today

`web/src/history.js` already holds a back/forward walk: a list plus a cursor, `NAV_MAX = 20`,
truncating the forward tail on a new destination, skipping entries that are no longer live. It is
the design ARCH-Codex's proposal describes. What it does *not* hold is everything you can be
looking at:

| Destination | In the walk? | How you get back today |
|---|---|---|
| A pane, as rows | yes | `‹ ›` |
| A pane, as its thread | as the same entry — the thread is a per-pane preference, not a place | `‹ ›` lands on whichever view that pane was last read in |
| A conversation window | **as of this change, yes** | `‹ ›`, or the pane's Back when the pane was opened from it |
| Settings / Activity | no | the same button again, or Back |
| The landing page | no | Back |

So the question is not "where do we build a navigation stack" — it is **which of the remaining
destinations belong in the one that exists**, and what the entries have to say.

## The recommendation

**Keep one list. Widen the entry. Do not add a second stack, and do not persist it.**

Concretely, three changes to `history.js`, in this order, each shippable alone:

1. **A conversation is an entry.** *(done — `NAV_CONV` prefix, `navAlive`, `navLabel`)*
2. **A panel is an entry** — Settings and Activity, which today are toggles with a `panelReturnPane`
   that is a one-deep private history doing the same job worse. Folding them in deletes that
   variable rather than adding to it. *(done — `NAV_PANEL`, `openPanelId`, and `panelReturnPane`
   deleted. `closePanel` is now one line: `goBack()`.)*
3. **The landing page is an entry**, which makes `closeTerminal` a `navGo` rather than a special
   case, and makes the phone's own Back gesture mappable onto the same list (see below).
   *(done — `NAV_LANDING`, `showLanding`, and both Back chevrons now call one `goBack`.
   `paneReturnConversation` went with it, as predicted below.)*

### Why not the shape in the proposal

The proposal's entry is a tagged union:

```js
{kind: 'pane', paneId, view: 'rows' | 'thread', conversationId?}
```

Two of those fields are the problem.

**`view` must not be in the entry.** Which view a pane is read in is a stored per-pane preference
(`herdr_conv_view`), deliberately: "a pane being watched as a terminal and one being followed as a
thread are two different jobs". If the entry carries the view, stepping back to a pane you have
since switched to threads reopens it as rows — the walk would be overriding a preference the user
set after the entry was made. The entry names the pane; the pane says how it is read.

**`conversationId?` on a pane entry is the wrong relation.** It encodes "I came from there", which
is what a *previous entry* already is. Once a conversation is its own entry, `paneReturnConversation`
and the header-Back special case both become redundant: Back from the pane is the previous entry,
and the previous entry is the conversation. Two mechanisms answering "where was I" will disagree
the first time someone reaches a pane from a tab strip while a conversation is open.

So:

```js
// One list of strings, as now. A destination is its id, prefixed by kind when it needs one.
'w1:p1'            // a pane
'conv:<id>'        // a conversation window
'panel:settingsView'
'landing'
```

Strings, not objects, because the list is compared with `===` in three places, the dedupe in
`navPush` is an equality test, and the whole thing is exercised by a vm slice that would otherwise
need a deep-equal. If an entry ever needs a payload, that is the moment to make it an object — not
before.

### What stays exactly as proposed

- **Only deliberate taps push.** Already true: `noteVisit` is called from `openTerminal` only, and
  the `navigating` flag stops a step from pushing what it just walked to. Polls, renders and status
  changes never reach it.
- **Back then a new destination drops the forward tail.** Already `navPush`.
- **No pane content in history.** Restoring reopens; the entry is an id.
- **Dead entries are skipped.** Already `navStep` with a liveness predicate — now `navAlive`, which
  answers for both kinds.
- **Memory only.** Agreed, and for a stronger reason than "unproven": a walk restored from before a
  reload is a walk over panes that mostly no longer exist, and skipping all of them leaves a
  disabled arrow that looks broken. The Recent switcher already answers "where was I" across a
  reload, and it is MRU — which is the right shape for that question and the wrong shape for this
  one.
- **~30 entries.** 20 today; raising it is a constant, not a design.

### The one thing worth adding that the proposal does not have

**`history.pushState` should be the same list, not a mirror of it.** A mirror means two cursors that
can disagree — the phone's Back gesture moving one and `‹` moving the other. The way to do it
without that risk is:

- `noteVisit` calls `history.pushState({at: navIndex}, '')`.
- `popstate` reads `event.state.at` and moves the cursor *to that index* rather than stepping.
- `navGo` calls `history.go(delta)` and lets `popstate` do the actual work.

Then there is one cursor, the browser holds it, and the phone's Back gesture, the `‹` button and a
desktop mouse's back button are the same action. The cost is that it must be all-or-nothing: a
half-mapped list is worse than an unmapped one, because Back would sometimes leave the app.

That is why it is step 4, not step 1 — and why it should not be attempted until 1–3 have been
lived with. The PWA case in particular needs checking: in standalone display mode there is no
browser chrome to reveal what Back is about to do.

### What step 4 shipped as, and the one change from the plan

`pushState` carries **a serial, not `navIndex`**. The list drops its oldest entry at `NAV_MAX`, and
every index below the drop then shifts by one — under states already written into the browser's
stack, which do not shift. `popstate` would have restored the wrong destination after the
twenty-first visit of a session. So `navSerials` is pushed alongside `navHistory`, by the same
`navPush` on the same cursor and cap, and the state holds `{herdrNav: <serial>}`; `popstate` looks
it up with `indexOf`.

That leaves one case the plan did not have an answer for: a state whose serial has aged out of our
window, or one another page wrote. It cannot be shown, and worse, continuing to compute
`history.go(i - navIndex)` against a cursor the browser has already moved off would put the two
permanently out of step. `navDetached` covers it — the walk stops driving the browser and steps
directly until the next `noteVisit` re-anchors it with a fresh `pushState`.

The landing entry uses `replaceState`, not `pushState`, so Back off the list leaves the app in one
press rather than spending one on a state of ours.

**Still unchecked:** the PWA standalone case, and iOS Safari's edge-swipe against a page that is
now pushing states. Both need a phone, not a test.

## What I would not do

- **A second stack for "UI state" (menus, sheets, the roster disclosure).** Those are dismissals,
  not destinations. The tap-outside handler and Esc already cover them, and putting a sheet in the
  walk means `‹` sometimes closes a menu and sometimes changes pane — the same button doing two
  jobs is how a navigation model stops being predictable.
- **Persisting it before mapping `popstate`.** If Back is going to be the phone's own gesture, the
  browser's session history is the persistence, and building our own first means throwing it away.

## Ordering against everything else open

This is a 3–4 hour change spread over three commits, and it competes with a merge that is five
commits deep and untested against a real relay. My order: **merge and live-test first**, then step 2
(panels), then step 3 (landing), then re-read step 4 with a phone in hand.
