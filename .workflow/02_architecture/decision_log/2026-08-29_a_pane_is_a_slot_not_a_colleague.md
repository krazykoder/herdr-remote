# A pane is a slot, not a colleague

**Date:** 2026-08-29
**Status:** proposed
**Area:** identity — relay snapshot, conversations, pairs, transcripts

## The distinction

A herdr pane id is a **slot**. It is assigned by herdr, it is reused, and it changes for reasons
that have nothing to do with the agent sitting in it: the session was respawned, the session was
killed and another started in its place, herdr was restarted, the machine was rebooted, the
workspace was reopened.

An **agent** is the thing that matters to this app. It has spawn details — harness, project, cwd,
agent config, the opening prompt it was started with — and it has a history: a transcript, a place
in a conversation, a partner it is paired with. That agent occupies a succession of slots over its
life.

This app has used the slot as the identity. That is the confusion.

## What exists today

Three identities are in the code; two of them are named.

| | What it is | Where |
|---|---|---|
| `pane_id` | herdr's slot. An **address** — correct for writing to a terminal | 339 uses across 26 files in `web/src`, plus 191 of `activePane` |
| member key | `JSON.stringify([host, pane_id, agent, cwd])` — contains the slot, so it identifies a **session**, not an agent. Changes on every restart, by construction | `convMemberKey`, and every keyed document behind it |
| the seat | `[host, agent, cwd]` — never named as a type, but the durable identity in practice | `healPairs` re-points on it; the relay's `conv_log` `fingerprints` selector is a list of these triples *because pane ids change on every restart* |

The FE does already model "same colleague, new slot" — but as an explicit **migration** rather than
as a stable id: `convContinueTranscript(oldKey, newKey)` copies the transcript, `member.was[]`
records the panes a member continues, `repointPair` moves the pair, `convLandMember` performs the
swap, and `ref` names a start so the pane it produces is found by equality rather than by
resemblance.

That was deliberate. D3 says a recycled pane id must never *silently* inherit a dead session's
words — succession happens only where the reader asked for it. That property is worth keeping and
this decision does not weaken it.

## Why the migration model is not enough

Every consumer has to run the migration correctly or it silently splits one agent in two, and the
migration only runs where this browser watched the restart happen. Three consequences, all
observed:

- **Pairs.** A pair pins `{host, pane_id, agent, cwd}` (`memberMatches`). The partner never came
  back, `healPairs` refuses to guess a replacement, and `repointPair` kept moving the *surviving*
  member onto each new pane — so the pair stayed anchored to a live pane with a corpse on the other
  end, announcing "Brainstorm-Codex (w3H:p1) is no longer running" in every browser for ever. Fixed
  on 2026-08-29 with an Unpair control and a one-week age-out, which treats the symptom.
- **Spawn details.** `spawn` — harness, project, config, opening prompt — is written by the
  recorder into the member's **IndexedDB transcript record**, which is browser-local. The shared
  index member row carries only `{key, added, label, agent, project}`. So a member whose pane died
  before *this* browser recorded it has no spawn, `canRespawn` is false, and the only thing offered
  is "Restart as…". The agent's own restart is unavailable in every browser but the one that
  watched it run.
- **`ref` is not an answer.** It is the closest thing to a real agent id — client-minted,
  relay-stamped, carried on every snapshot for the life of the pane — but it lives in the relay's
  memory (`pane_ref`, `relay/herdr_relay.py:1053`), so a relay restart drops it while the pane runs
  on, and it exists only for starts this app made.

## The decision

Introduce a first-class **agent id** (`aid`): minted once, durable across a pane change *and* a
relay restart, existing for panes this app did not start.

- The **relay** mints and persists it. It is the only participant that sees every pane, survives a
  browser, and can be the single writer.
- The **snapshot** carries it on every pane, beside `pane_id`.
- The **FE** keys identity on it — conversation members, pair members, `conv_view`, the transcript
  store — and keeps `pane_id` everywhere it is an address. No sweeping rename: the split is between
  "which agent is this" and "where do I type".

## What this is not

- Not a replacement for `pane_id`. Writing to a terminal needs the slot, and always will.
- Not an abandonment of D3. An `aid` the relay never issued for a pane is not that pane's, so a
  recycled slot still inherits nothing. What changes is that the succession is recorded once, by
  the relay, instead of being re-derived by each browser that happens to be watching.
- Not a change to what an agent *is* to herdr. herdr has no such concept and is not asked for one.

## Alternatives rejected

- **Key on the seat `[host, agent, cwd]` directly.** Two claude panes in one directory are two
  colleagues, and this makes them one. `healPairs` already refuses to guess between them for exactly
  this reason.
- **Make `ref` durable and use it.** It only exists for starts this app made. A pane launched from
  the terminal would still have no identity, which is half the fleet.
- **Have each browser mint ids.** Two browsers watching the same restart mint two ids for one
  agent, and the shared documents then disagree about who is who. Identity has to have one writer.

## Follow-up

`.workflow/03_specs/2026-08-29_agent_identity_spec.md` — the wire field, how it is minted, how it
survives a restart, and the migration of the four keyed documents.
