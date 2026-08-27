# Decision Log: A start that makes its own project

**Class B** — one additive optional field on `start_agent` (`child`), one additive field on the
internal spawn plan (`create_child`), two new functions in `relay/projects.py`. No existing message
shape changes and no client is required to send anything new.
Plan: `../../04_implementation_plans/2026-08-26_child_on_a_start_plan.md`.

## What this settles

Slice 1 made a directory under a marked root into a project by *looking*: `scan_root` lists,
`child_projects` derives, `child_path_ok` re-checks the path at the two points where a chosen
project's cwd becomes a pathname herdr is handed. Nothing could create such a directory except a
human at a terminal. Slice 2 is the missing half — a start may name a child that does not exist
yet, and the relay makes the directory.

## The invariants frozen here

**1. Creation and adoption are the same mechanism.** `start_agent {child: "notes"}` does exactly one
thing the previous slice could not do: `os.makedirs`. It writes nothing to the roster, no file, no
row, no state document. The next poll stats the root, sees its mtime moved, lists it, and derives
the row the ordinary way. There is no second path by which a project comes into being, so there is
no second path to keep in agreement with the first, and a child made by hand and a child made by a
start are indistinguishable afterwards — which is the point.

**2. The name is one path component, by charset.** `CHILD_NAME_RE` is
`^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$`. It holds no `/`, so there is no traversal syntax to strip and
no path to sanitise: `../..`, `a/b` and an absolute path are not dangerous inputs that get cleaned,
they are inputs that do not match. The leading character excludes `.` and `-` for a different
reason — `scan_root` skips dotdirs, so a `.hidden` child would be created and then never adopted,
which is a start into a directory that is not a project.

**3. Containment is still decided in one place per side.** Validation resolves the name into the
row it will become and refuses everything it can decide without the disk;
`_create_target_pane` — the single point every creation command already routes through — makes the
directory and then asks `child_path_ok`, unchanged, about the result. The mkdir sits *inside* that
one point rather than beside it, so the last look before the herdr calls is still the last look.
No new place decides where a pane goes.

**4. `child_path_ok` is not modified.** A path that exists when the request is validated must
already satisfy it; a path that does not exist is not asked about until after the mkdir, when it
does. `os.makedirs(..., exist_ok=True)` is satisfied by a *symlink* to a directory — `isdir`
follows links — so the post-mkdir call is not a formality: it is the guard that catches the
directory swapped for a symlink between the two moments, exactly as in slice 1.

**5. A marker root refuses a new child.** `"marker": ".git"` narrows a root to the directories
holding that file. The relay is not going to write a `.git`, so a directory it created there would
never be adopted. Refused at validation rather than created and orphaned.

**6. A folded id that is already taken refuses.** `child_id` folds a directory name, so `web.app`
and `web-app` are one id. `child_projects` resolves that collision by first-wins and logs the
loser. A start into the losing name would create a directory the scan will always skip, so the
start is refused rather than landing somewhere that is not a project. A name whose id belongs to
the *same* directory is not a collision — it is the ordinary "start again in the place that
already exists", and it converges on that row with no mkdir of consequence.

## Refused rather than dropped

`child` follows `ref` and `config`. A malformed value, a non-string, `null`, a name for a project
that is not a root, a name whose id is taken: each refuses the whole start with its own message. A
start that quietly ignored `child` would come up in the *root* directory — the parent of the place
that was asked for, holding every sibling project — and the client has no way to tell that from
success. That is a worse outcome than a refusal, which is the same argument `config` makes.

## The ceiling that stays recorded

The window between the last check and herdr's spawn is unchanged and still marked with the
`ponytail:` comment at `_create_target_pane`. herdr 0.8.0 takes `--cwd` as a path string with no
descriptor and no `--no-follow`, and the chdir happens in the herdr server behind `herdr.sock`
rather than in a child of the relay, so closing it is an upstream change. Adding a mkdir does not
widen it: the directory is created inside the same guarded block, one call before the check.

Rename is also unchanged and still a new project under scan-is-truth, with its `ponytail:` comment
naming the marker-file-with-an-id upgrade. Neither is in this slice.
