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

// Markdown constructs that have to own the start of their line: indented code, ATX headings,
// blockquotes, bullet and ordered list items, fenced code, table rows, thematic breaks. Putting
// a glyph in front of any of these stops it being that construct — `⏺ ### Status` is no longer a
// heading — so a message opening with one keeps its glyph on a line of its own. Everything else,
// which is most prose, gets it inline.
//
// Tested in tests/test_pi_gutter.js, which reads this expression out of this file.
const OWNS_ITS_LINE = /^(?:\s{4}|\t|#{1,6}\s|>|[-*+]\s|\d+[.)]\s|```|~~~|\||([-*_])\s*\1\s*\1)/;

export default function (pi) {
  pi.registerMarkdownTransformer((markdown: string, { messageType, isStreaming }) => {
    const glyph = GLYPH[messageType];
    // Streaming updates are partial, and re-marking each one flickers the glyph while the agent
    // is still writing. `assistant-thinking` gets no glyph at all: it is not a turn, and marking
    // it would make the parser treat reasoning as a closing message.
    if (!glyph || isStreaming) return markdown;
    // Inline, so the glyph reads as a gutter on the same line as the text it marks. A message
    // that opens with a construct owning its line falls back to a paragraph of its own, which
    // cannot interact with whatever follows it.
    return OWNS_ITS_LINE.test(markdown) ? `${glyph}\n\n${markdown}` : `${glyph} ${markdown}`;
  });
}
