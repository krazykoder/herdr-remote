# herdr-gutter — a pi extension

Marks who is speaking in a pi transcript with a gutter glyph, so herdr-remote's pane parser can
cut the pane into turns.

## Why it exists

herdr ships the relay the plain text of a pane, and the app finds turns by reading column 0.
Every other harness puts a character there saying what a line is:

| harness | speaker | result gutter | user prompt |
|---------|---------|---------------|-------------|
| `claude` | `⏺` | `⎿` | `❯` `>` |
| `codex` | `•` | `└` `│` | `›` |
| `pi` | — | `$` | — |

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
  it never sees tool calls. pi's tool blocks keep their existing ` $ cmd` … ` Took 0.1s` shape, and
  the app reads that `$` as the marker it is.
- **Skips streaming.** Re-marking every partial update flickers the glyph while the agent is still
  writing, so the glyph lands when the message finishes. Nothing downstream minds: the app only
  offers a summary on a pane herdr reports as done.
- **Does not change pi's line spacing.** The gaps between messages are pi's own layout around each
  block. A markdown transformer sees one message's text and nothing around it.

## Where the glyph goes

Inline, so it reads as a gutter on the same line as the text it marks:

```
 › hello there

 ⋯ The user is saying hello. Let me answer warmly.

 ⏺ Hey! What can I help you with?
```

A message that opens with a markdown construct owning its line — a heading, a list item, a
blockquote, a fence, a table row, a thematic break, indented code — gets the glyph on a line of
its own instead. `⏺ ### Status` is not a heading, and the failure is silent: it renders a literal
paragraph where a heading belonged. `tests/test_pi_gutter.js` reads the expression out of this
extension and pins both sides of that branch.

## Glyphs

`›` for the user, `⏺` for the agent, `⋯` for reasoning. Chosen by scanning 400 lines of a live pi
pane for collisions:

```
•  1     ›  0     ❯  0     ⏺  0     ⎿  0     └  1     │  12     ⋮  3     ⋯  0
```

`›`, `⏺` and `⋯` never appear. `•`, `⋮` and the box-drawing set do — pi renders markdown tables and
lists, so those glyphs land in exactly the column a marker would occupy. Do not reuse codex's set
here.

Reasoning is marked deliberately, and deliberately not with the agent's glyph. It sits between the
request and the reply, and left bare it is the one stretch of the transcript with no marker at all
— so the app would paint the user's turn straight on down through pi's thinking. `⋯` gives it a
boundary without ever reading as something the agent said.

## Install

This directory is a pi package, so `pi install` is the whole install. It takes an **absolute**
path, and it registers that path rather than copying the files — edits here take effect on the
next `/reload`, with nothing to keep in step.

```bash
# 1. from anywhere, pointing at this directory
pi install "$(git -C /path/to/herdr-remote rev-parse --show-toplevel)/extensions/pi"

# 2. confirm it is registered
pi list
```

`pi list` should show `herdr-gutter`. What `pi install` wrote is a line in
`~/.pi/agent/settings.json`:

```json
{ "packages": ["../../code/python/herdr-remote/extensions/pi"] }
```

Then in each pi session that is already running:

```
/reload
```

Sessions started afterwards pick it up on their own. Confirm it took by looking at the pane: the
banner lists `herdr-gutter.ts` under `[Extensions]`, and the next message you send comes back
marked `›`.

**Verify from the app's side** — the glyphs have to survive the trip through herdr:

```bash
herdr pane read <pane-id> --source recent-unwrapped --format text | grep -c '^ [›⏺⋯]'
```

### Per project instead of per user

```bash
pi install -l /absolute/path/to/herdr-remote/extensions/pi
```

writes to the project's `.pi/settings.json`, which pi installs automatically on startup once the
project is trusted. That is the route for sharing it with a team.

### Uninstall

```bash
pi remove /absolute/path/to/herdr-remote/extensions/pi
```

### Per host

Every machine that runs pi needs this, including anything reached through `HERDR_REMOTES`. A host
without it parses exactly as it did before — no glyphs, no turns, no summary — so the failure is
soft and local to that host.

## What the app knows about it

herdr-remote's `GUTTERS` table in `web/index.html` carries a `pi` profile shaped around three
things this harness does differently:

```js
pi: { speaker: '⏺', result: ['$'], user: ['›'], ends: ['⋯'], indent: 1, composer: false },
```

- **`indent: 1`** — pi indents its whole transcript, so the gutter is column 1. Deliberately not
  "the first non-space character", which would break claude and codex, where column 0 is what
  keeps indented prose from being mistaken for a marker.
- **`ends`** — pi does *not* hang-indent a wrapped line: a continuation sits in the same column a
  glyph does. Column 0 alone therefore cannot end a block, and the glyph set has to.
- **`composer: false`** — claude and codex draw their composer with the prompt glyph, so it sits at
  the foot of a live pane and the closing message is the block above it. pi's composer is a box
  this extension cannot reach, so pi's last `›` is the newest *request* and its answer is below.

`tests/test_summary_detect.js` pins all three against `tests/fixtures/pane_pi_done.txt`, a
sanitized read of a live pi pane with this extension loaded.
