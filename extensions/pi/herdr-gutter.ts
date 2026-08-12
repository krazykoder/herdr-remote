// Marks who is speaking in a pi transcript with a gutter glyph, so herdr-remote's pane parser
// can cut the pane into turns.
//
// Why this has to exist: herdr ships the relay the plain text of a pane, and every other harness
// puts a character in column 0 saying what a line is — claude `⏺`/`⎿`/`❯`, codex `•`/`└│`/`›`.
// pi indents its whole transcript by one space and gives user text and agent text the same shape,
// so there is nothing to key on. `registerMarkdownTransformer` hands over the one distinction the
// text lacks: whether a message is the user's or the agent's.
//
// Display-only. pi applies this on the way to the screen; the session file and the model's context
// never see these characters.
//
// Source of truth is `extensions/pi/herdr-gutter.ts` in the herdr-remote repo. See the README
// beside it for the install and for what the app has to know to read the result.

// Chosen by scanning 400 lines of a live pi pane for collisions: `›` and `⏺` appear zero times,
// while `•` and the box-drawing set `└ │ ├ ┌` do — pi renders markdown tables and lists, so those
// land in exactly the column a marker would. Do not reuse codex's glyphs here.
const GLYPH: Record<string, string> = {
  user: "›",        // ›
  assistant: "⏺",   // ⏺
};

export default function (pi) {
  pi.registerMarkdownTransformer((markdown: string, { messageType, isStreaming }) => {
    const glyph = GLYPH[messageType];
    // Streaming updates are partial, and re-marking each one flickers the glyph while the agent
    // is still writing. `assistant-thinking` gets no glyph at all: it is not a turn, and marking
    // it would make the parser treat reasoning as a closing message.
    if (!glyph || isStreaming) return markdown;
    // The glyph gets its own paragraph rather than being prefixed onto the first line. Agent
    // messages routinely open with a heading, and `⏺ ### Status` is no longer a heading — the
    // prefix would silently break pi's own rendering. A paragraph holding one character cannot
    // interact with whatever follows it.
    return `${glyph}\n\n${markdown}`;
  });
}
