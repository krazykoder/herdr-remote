# pi has no gutter — evidence, and the three ways out

Companion to `2026-08-11_agent_final_summary_detection.md`, which builds turn detection on
column-0 gutter glyphs and ships profiles for `claude` and `codex` only. This note answers the
question that table left open: what does `pi` actually emit, and what would it take to support it.

Research only. **No pi configuration was changed on this machine** — that was the instruction, and
nothing here has been applied. Every sample below was read from panes that were already running.

## The question

`pi` is in `HERDR_START_AGENTS` and panes run it, but the pane parser treats it as an unknown
harness: no suggestion, and **Learn** can teach it half a profile at best (a speaker glyph, never
the result glyph — see *Unknown harnesses* in the companion note). Is that a gap worth closing,
and by which route?

## Evidence 1 — plain text carries nothing usable

Read from `w24:pH`, an existing pi pane mid-conversation, `2026-08-11`.

Leading-character histogram over 286 lines of `herdr pane read`:

| column 0 | count |
|----------|-------|
| space | 162 |
| (blank line) | 117 |
| `[` | 3 |
| `─` | 2 |
| other | 2 |

**pi indents its entire transcript by one space.** Column 0 is blank for every line of
conversation. The only exceptions are the `[Context]` / `[Skills]` / `[Extensions]` startup
headers and a horizontal rule.

Worse than the missing glyph: user text and agent text are the same shape.

```
 /clear


 The user wants to clear the conversation. I'll acknowledge and reset.

 All set. The context is clear. What would you like to work on?


 summarize the last 10 commits


 The user wants to see the last 10 commits. Let me run git log for that.


 $ cd /Users/towshif/code/python/herdr-remote && git log --oneline --no-decorate -10

 ... (5 earlier lines, ctrl+o to expand)
 dd51cea feat(web): chime when a pane starts waiting, and synthesise it here

 Took 0.1s
```

` /clear` and ` summarize the last 10 commits` are user turns. ` The user wants to...` is the
agent. Nothing separates them. Blank-line runs do not either — two blank lines precede user
turns, agent prose, *and* tool calls alike.

What structure does exist, and where it sits:

| meaning | marker | column |
|---------|--------|--------|
| tool call | `$ ` | 1 |
| tool block end | `Took 0.1s` | 1 |
| collapsed scrollback | `... (206 earlier lines, ctrl+o to expand)` | 1 |
| startup headers | `[Context]`, `[Skills]`, `[Extensions]` | 0 |

So pi *can* have its tool blocks found — but the one distinction turn anchoring is built on,
user versus agent, is absent from the text entirely. A pi profile built on plain text would have
nothing to anchor on. This is the finding: not "pi's glyphs are unusual", but "pi has none".

## Evidence 2 — ANSI carries all of it

`herdr pane read` takes `--format ansi`, and it composes with `--source recent-unwrapped`, which
is the source the app's own reads use. Verified.

pi separates roles by **background colour**, not by glyph:

```
line 26  ESC[48;2;52;53;65m summarize the last 10 commits      user turn
line 32  ESC[48;2;40;50;40m $ cd ... && git log --oneline -10   tool block
line 41  ESC[48;2;40;50;40m Took 0.1s                           tool block, same background
         (agent prose carries no background at all)
```

Across the three live harnesses:

| harness | user turn bg | tool block bg | agent prose | has a gutter? |
|---------|--------------|---------------|-------------|---------------|
| `pi` | `48;2;52;53;65` | `48;2;40;50;40` | none | no |
| `codex` | `48;2;61;59;78` | `48;2;33;58;43` | none | yes — `•` `└│` `›` |
| `claude` | — | — | — | yes — `⏺` `⎿` `❯` |

Claude paints no role backgrounds; the backgrounds in its pane are diff hunks (`48;2;2;40;0`
added, `48;2;61;1;0` removed). It does not need them.

**So ANSI is worth exactly one harness today.** It would also dissolve the learning ceiling — a
selection can never reveal the result glyph, but a background is in the bytes whether it was
selected or not — and it would cover the next gutterless harness for free.

Wire cost, measured at 200 lines on the three panes:

| pane | plain | ansi | factor |
|------|-------|------|--------|
| `w24:pH` pi | 10.1 KB | 41.1 KB | 4.1x |
| `w24:pK` codex | 12.7 KB | 32.7 KB | 2.6x |
| `w24:pN` claude | 11.9 KB | 37.9 KB | 3.2x |

The open pane is re-read every 3s, so that multiplier lands on a phone through the tunnel.

One trap worth recording: **a table of literal RGB values rots.** `48;2;52;53;65` is that pi
theme's colour, and pi ships a theme system (`~/.pi/agent/themes/*.json`, `dark` and `light`
built in). Anything built here should partition a pane by *runs of the same background*, whatever
the colours are, rather than by matching named ones.

## Evidence 3 — pi has a hook built for precisely this

pi loads TypeScript extensions from `~/.pi/agent/extensions/`. Three are installed on this
machine already (`orca-agent-status.ts`, `orca-prefill.ts`, `orca-titlebar-spinner.ts`), so the
mechanism is in use and not theoretical.

From `docs/extensions.md` in `@earendil-works/pi-coding-agent`:

> ### pi.registerMarkdownTransformer(transformer)
>
> Register a transformer for the Markdown in normal user text, assistant text, and thinking
> blocks. […] The transformer receives the Markdown string and a context with:
> - `messageType` — `"user"`, `"assistant"`, or `"assistant-thinking"`
> - `isStreaming` — `true` for partial assistant updates; `false` for user, finalized assistant,
>   and restored messages
>
> The hook is display-only: the original message remains unchanged in the session and model
> context. It runs for new user messages, assistant streaming updates, **restored session
> messages**, and terminal width changes.

Three properties that matter:

1. `messageType` hands over the user/assistant distinction rather than making us infer it — the
   one thing pi's plain text lacks.
2. Display-only. The session file and the model's context are untouched, so this cannot change
   what the agent sees or does.
3. It runs on restored messages, so scrollback is marked too, not only new turns. The ↓↑ pill
   walks scrollback, so a hook that only marked live output would be half a feature.

The whole of it:

```typescript
// ~/.pi/agent/extensions/herdr-gutter.ts   — NOT INSTALLED, recorded for the record
export default function (pi) {
  pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
    if (isStreaming || messageType === "assistant-thinking") return markdown;
    return (messageType === "user" ? "› " : "• ") + markdown;
  });
}
```

### Two unknowns this route carries

**The indent.** pi puts every line one space in from the left, so a prefixed glyph renders at
column 1 and `GUTTERS` reads `row[0]`. The fix is a per-profile `indent` offset — one number —
not a rewrite of the parser, and deliberately not "read the first non-space character", which
would break claude and codex where column 0 is what keeps indented prose from being mistaken for
a marker. Unverified until the extension actually runs.

**No result glyph, still.** The transformer sees user, assistant, and thinking text — never tool
calls. pi's tool blocks would stay ` $ cmd` … ` Took 0.1s` with an empty gutter. That may be
harmless: `blockSpan` starts at a speaker glyph, so an unmarked tool block is not a block at all
and stepping skips it for free. But `findFinalMessage`'s "stop on a tool block" rule would have
no signal to stop on, and whether that misfires has not been traced. Testable against a fixture
without installing anything.

## Options

### A. Do nothing

pi stays an unknown harness: no suggestion, **Learn** teaches a speaker glyph only, the pill
overshoots into tool blocks occasionally. That is the behaviour the companion note already
designed and defended.

Cost: none. Buys: nothing. The honest baseline — pi is one harness of three, and the two that
carry the real work are both supported.

### B. ANSI role tags, parsed in the relay

`read_pane_content` runs the same command with `--format ansi`, strips SGR back to the plain text
that goes on the wire today, derives one tag per line from background runs, and sends
`roles: ["user", "tool", "agent", …]` beside `content`. The frontend reads `roles` when present
and falls back to the gutter when absent.

| | |
|---|---|
| relay | ~40 lines, plus the strip |
| wire | one optional field; text unchanged |
| frontend | one branch; no SGR parser |
| frontend-only constraint | **broken** |
| per-machine config | none — works on every host |
| covers | pi, and every future gutterless harness |

The hazard is the strip: it must reproduce herdr's plain output byte for byte or the line
geometry the ruler depends on drifts. That is testable, and it is the part that would bite.

Parsing ANSI in the *frontend* instead was considered and is worse on both axes — the 2.6–4.1x
wire growth above lands on every 3s poll, and the single-file app grows an SGR parser.

### C. A pi extension

Install the transformer above on each host that runs pi, and add a `pi` entry to `GUTTERS` with
an `indent: 1`.

| | |
|---|---|
| relay | none |
| wire | none |
| frontend | one profile entry, one number |
| frontend-only constraint | **kept** |
| per-machine config | **required on every host running pi** |
| covers | pi only |

The per-machine requirement is the real cost, and it fails softly: a pi pane on a host without
the extension parses exactly as it does today. Cheapest by a wide margin if pi support is what is
wanted; buys nothing toward the next unknown harness.

## Where this leaves it

B and C are not competing implementations of one feature — they answer different questions. C
supports pi. B removes the class of problem pi is an instance of, at the price of the
frontend-only rule and a byte-exact strip.

The deciding fact is that the class currently has one member, and the two harnesses doing the
work both already parse. That argues for A now and C when pi support is actually wanted, with B
held for a second gutterless harness — but the choice is a product one, not a technical one, and
it is not made here.
