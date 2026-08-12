# herdr-gutter — a pi extension

Marks who is speaking in a pi transcript with a column-0 glyph, so herdr-remote's pane parser can
cut the pane into turns.

## Why it exists

herdr ships the relay the plain text of a pane, and the app finds turns by reading column 0.
Every other harness puts a character there saying what a line is:

| harness | speaker | result gutter | user prompt |
|---------|---------|---------------|-------------|
| `claude` | `⏺` | `⎿` | `❯` `>` |
| `codex` | `•` | `└` `│` | `›` |
| `pi` | — | — | — |

pi indents its entire transcript by one space, so column 0 is empty on every line of
conversation, and user text and agent text are the same shape:

```
 summarize the last 10 commits


 The user wants to see the last 10 commits. Let me run git log for that.
```

There is nothing to key on. `pi.registerMarkdownTransformer` hands over the one distinction the
text lacks — `messageType` is `"user"`, `"assistant"`, or `"assistant-thinking"` — so this
extension writes it into the render.

The full investigation, including the two routes not taken, is in
`.workflow/07_dev_notes/2026-08-11_pi_has_no_gutter.md`.

## What it does, and does not do

- **Display only.** pi applies the transformer on the way to the screen. The session file and the
  model's context never see these characters, so nothing the agent reads or does changes.
- **Marks whole turns, not tool calls.** The transformer sees user, assistant, and thinking text;
  it never sees tool calls. pi's tool blocks keep their existing ` $ cmd` … ` Took 0.1s` shape and
  an empty gutter.
- **Skips streaming and thinking.** Re-marking every partial update flickers the glyph while the
  agent is still writing, and reasoning is not a turn — marking it would let the parser mistake
  thinking for a closing message.

## Glyphs

`›` for the user, `⏺` for the agent. Chosen by scanning 400 lines of a live pi pane for
collisions:

```
•  1     ›  0     ❯  0     ⏺  0     ⎿  0     └  1     │  12
```

`›` and `⏺` never appear. `•` and the box-drawing set do — pi renders markdown tables and lists,
so those glyphs land in exactly the column a marker would occupy. Do not reuse codex's set here.

## Install

```bash
pi install /absolute/path/to/herdr-remote/extensions/pi
pi list                 # confirm it is registered
```

Then in a running pi session:

```
/reload
```

`pi install` writes to `~/.pi/agent/settings.json`. Add `-l` to write to a project's
`.pi/settings.json` instead, which pi installs automatically on startup once the project is
trusted — that is the route for sharing it with a team.

Per host: every machine that runs pi needs this. A host without it parses exactly as it does
today, so the failure is soft.

## What the app has to know

herdr-remote's `GUTTERS` table reads `row[0]`, and pi indents by one space, so the glyph lands in
column 1. The `pi` profile needs an indent offset — deliberately not "read the first non-space
character", which would break claude and codex, where column 0 is what keeps indented prose from
being mistaken for a marker.
