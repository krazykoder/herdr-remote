# Architecture — The frontend is written as modules and ships as one file

**Date:** 2026-08-14
**Commits:** `37ace68` (the split), `0c482f2` (Makefile and docs repair), `a916335` (the file
surface is LAN-only)
**Status:** Built, on `feat/modular-js`, not yet merged to `main`.
**Supersedes:** the "single self-contained file, no build step" property stated in `CLAUDE.md`
since the app began.

---

## 1. What changed

`web/index.html` was 11,084 lines: markup, CSS and the whole application in one `<script>`. It is
now 3,991 lines of markup and CSS that load 26 plain scripts from `web/src/`, and
`scripts/build.py` inlines those back into a single `web/dist/index.html` for deploy.

| | Before | After |
|---|---|---|
| Written as | one file | `index.html` + 26 files in `web/src/` |
| Shipped as | that same file | `web/dist/index.html`, generated |
| Build in the edit loop | none | still none |
| Build before deploy | none | `python3 scripts/build.py`, stdlib only |
| Tests read | `web/index.html`, by string offset | `web/src/*.js`, as files |

The modules, by size — the split is by subject, and it is uneven because the subjects are:

```
shortcuts.js 946   status_bar.js 697   conversation_store.js 623   terminal.js 597
conversation_view.js 581   summary_detect.js 487   conversation_pure.js 437   start_dialog.js 356
reorder.js 341   agent_order.js 259   controls.js 234   history.js 239   dictation.js 210
pairs_pure.js 181   command_palette.js 153   push.js 133   transfer.js 99   attention.js 89
pairs_ui.js 84   sections.js 77   state.js 70   settings.js 64   cue.js 52   utils.js 43
init.js 19   sound.js 19
```

## 2. The shape, and why this one

The rule the design turns on: **exactly one source of truth, and the single file is a generated
artifact.** `web/dist/` is gitignored. Nothing in the repository is both hand-edited and
generated, so there is no pair of files that can silently disagree.

The alternative that was rejected — committing a modular draft *and* a compiled `index.html`, and
running the tests against the compiled one — fails on that rule twice: the compiled copy is
hand-editable, and green tests on a stale build are indistinguishable from green tests on a good
one.

Three properties were preserved deliberately:

- **Edit and reload, with no build between.** The relay serves `index.html` and `src/*.js` from
  disk on every GET, `no-cache`. The build exists for deploy and for `/dist/`, never for
  development.
- **One file on the wire.** GitHub Pages gets `web/dist/`, which is one HTML file and six assets.
  This matters beyond taste: with `index.html` and 26 scripts on a static host, a browser can hold
  a cached old page against new modules and fail in a way neither file explains. The bundle makes
  a deploy atomic.
- **No runtime dependencies, no framework, no bundler.** `scripts/build.py` is 58 lines of stdlib
  that substitutes each `<script src="src/x.js"></script>` with the file's contents and escapes
  `</script` inside it.

## 3. Caveats

**The load order is the program.** These are plain scripts sharing globals, not ES modules. The
order of the `<script src>` tags in `index.html` is the concatenation order and the initialisation
order, and *nothing enforces it* — there are no imports to resolve. A module that reads another's
binding at load time breaks at boot if the tags are reordered, and it breaks with a `ReferenceError`
in the console rather than with a failing unit test. The two boot tests in `app_smoke.spec.js` —
one against the source, one against the built bundle — are the guard, and they are the only guard.

ES modules would enforce it. They were not used because they change scoping and defer semantics,
which would make the development page and the concatenated bundle behave differently — and every
inline `onclick=` in the markup would need its handler explicitly hung on `window`.

**`</script` escaping is untested in practice.** The build rewrites it correctly, but there are
zero occurrences in the source today, so the path has never run against a real case.

**No source maps.** A stack trace from production names a line in a 532 KB generated file. In
development the line numbers are the module's own, which is where the debugging happens, so this
was accepted rather than solved.

**The two deploy targets ship different artifacts.** `deploy.sh` builds and publishes `web/dist/`
to GitHub Pages. Cloudflare Pages still deploys `web/` on push to `main`, which since the split is
the *modular* form — it works, because a static host serves subdirectories, but it is not the same
bytes. Point Cloudflare at `web/dist` with a `python3 scripts/build.py` build command to make them
agree.

**Test coupling moved rather than vanished.** The 42 `HTML.indexOf(...)` slices across 15 suites
became file reads, which is less code and a stronger test — but the suites still know module names
and still extract by marker inside them. Moving a function between modules can still break a test
that has nothing to do with the behaviour.

## 4. The relay's part, and its limit

The development loop needs the relay to serve `src/*.js`, which is a change to a file that had no
business changing for a frontend refactor. It is 8 lines, single-level, `.js`-suffixed, with a
character allowlist — deliberately not a directory walk, because any route that turns a request
path into a filesystem path is one `..` from serving the repository.

A further 19 lines serve `web/dist/` so the built bundle can be looked at in a browser before it
is published. That block is optional: the bundle's boot test could serve the file through
Playwright instead, and the capability it buys is previewing the shipped artifact on a phone.

`a916335` then closed what the split had quietly widened. Both listeners ran the same handler, so
every one of those files was reachable through the tunnel — public internet, one token away. The
file surface is now the LAN listener's alone (`serve_app`, taken from the listener exactly as
`require_token` already was), and off the LAN the page comes from where it is hosted while the
tunnel carries the socket. The API a hosted app needs — the WebSocket upgrade, the push endpoint,
the VAPID key — is unchanged on both. `tests/test_static_scope.py` pins the line.

## 5. What this is worth

The honest accounting: every gain is developer-side. The shipped bytes are unchanged, the app is
not faster, and no user-visible behaviour differs. What was bought is a 3,991-line file instead of
an 11,084-line one, a test suite that reads real files, and a subject-shaped place to put the next
thing. What was paid is a build step before deploy, 27 lines of relay, a load-order hazard with a
single guard, and a generated artifact that must never be edited.

Worth keeping. Not worth repeating for the CSS, which would need the same machinery for a smaller
return.
