# Decision — The web app is an app shell; the document never scrolls

**Date:** 2026-08-09
**Status:** Accepted
**Context:** `.workflow/02_architecture/2026-08-09_ui_shell_layout.md`

`web/index.html` sized itself with `body { min-height: 100dvh }` and positioned the terminal as a
`position:fixed` overlay offset by a hardcoded `top: 49px`, while its scrollable regions used
`flex:1; overflow-y:auto` without `min-height:0`. Three failures followed from that one modelling
choice: the header is actually 69px so the desktop rule `height: calc(100dvh - 49px)` overflowed the
viewport by 20px and put the composer below a permanent scrollbar; the missing `min-height:0` let
scrollable panes push `body` past one viewport, producing a second scrollbar outside the terminal's
own; and the offset had to be maintained by hand in two places that had already drifted from
reality. We adopt the inverse model: `body` is exactly `100dvh` with `overflow:hidden`, full-height
panes are ordinary flex siblings rather than fixed overlays, and every scrolling flex child declares
`min-height:0`. No pixel offset for the header survives anywhere in the file, mobile and desktop
share one height model, and the `@media (min-width:768px)` block is demoted to adjusting chrome
visibility and widths only. The accepted cost is that a non-scrolling document cannot make a mobile
browser collapse its URL bar; we take that back through PWA installation and, on Android only, a
feature-detected Fullscreen API button, and we reject scroll-jacking hacks that would buy the URL
bar back by reintroducing the document scroll this decision exists to remove.

**Class:** A — feature-only. No contract or protocol change; one additive relay static route.
