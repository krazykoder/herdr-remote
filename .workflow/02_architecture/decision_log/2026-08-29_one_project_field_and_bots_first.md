# One Project field, and bots first

**2026-08-29 · Class A · web only**

Two small corrections to where a person's eye and thumb land in the launcher and the start sheet.
Neither changes the wire, the relay, or any stored document.

## The Project was askable from one door and fixed from the other

`openStartDialog(projectId, ev, mode)` is the single sheet behind four entry points: the Agents
section's `+ New`, the Terminals section's `+ New`, a Project tab's `+ Start session`, and its
`+ New terminal`. The first two stand in no Project and pass `activeProject`, which is `null` on the
landing page; the last two always name one.

The sheet drew its Project picker only when it had not been handed a Project (`startAskProject`).
So the same field was a question on the landing page and an unchangeable fact inside a Project tab.
Opening a terminal in the wrong Project — the case that prompted this — meant closing the sheet,
changing tab, and retyping every other answer in it.

**Decided:** the picker is always drawn, preselected with whatever the press named. A Project id the
relay does not have is treated as none at all, so the sheet opens on an empty picker rather than
pointed at something that is not there.

The `@badge` in the sheet header stays. It is not a second copy of the answer so much as the answer
where it is still visible: the picker is a row in a scrolling body and the header is not.

**Refused:** a second, terminal-only picker. Terminals and sessions differ in what they need *below*
the Project — an agent, a role, a config, a child directory — and the sheet already branches on
`startMode` for each of those. The Project is the one question both forms ask identically, and
answering it in two places is how the two forms would drift.

## Bots sat under a warning band

`launcherGroups` banded `[insecure]` first and `Bots` second. The reasoning for `[insecure]` first
still holds — a warning read after the tap is not a warning — but a bot is not a tile the reader is
choosing between: it is the one row that is always the same room, pressed by muscle memory, and the
first thing a thumb should find.

**Decided:** `Bots` is the first band unconditionally. A bot whose payload is marked insecure stays
in `Bots` and keeps its own badge, which is where that warning is actually read — on the tile, next
to what it is about, rather than in the heading of a band the tile was sorted into.

`[insecure]` keeps its place ahead of Templates and the Project bands for everything else.

## What this does not do

Neither change touches `launcherWithBots`, the tile document, or the order inside a band — a bot is
still seeded at the end of the list and still lifted by the band rather than by its index.
