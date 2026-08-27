# Decision Log: A project without a session, and a root that is not one

**Class B** — one new client→server message (`create_project`), one additive optional config field
(`container`) that rides out on `projects`, one new function in `relay/projects.py`
(`create_child`), and three client changes: a `+ Project` chip, a small sheet behind it, and an
order for the Project pickers. No existing message shape changes and no client is required to send
anything new.

## What this settles

The previous slice let a *start* name a directory that did not exist yet. That left "I want a place
to work, I do not yet want anything running in it" with no answer but a terminal — and made a root
that exists only to hold projects look, in every picker, like a project you could work in.

Three questions, settled together because they are one surface.

## The invariants frozen here

**1. A third door, still one registration.** `create_project` does exactly what a start's `child`
does and stops one step earlier: `create_child` resolves the name with the same `child_target`,
makes the directory with the same `make_child_dir`, and re-asks the same `child_path_ok` afterwards.
Nothing is written to the roster, to the config file, or to shared state. The next scan lists the
root and derives the row. So there are now three ways to make a project — `mkdir` in a terminal, a
start that names a child, and this — and all three are the same event on disk, indistinguishable
afterwards. That is what keeps the count harmless: a fourth door would be too, on the same terms.

**2. The gate is the write gate, not a new one.** No process is spawned here. A directory made on
this machine because a client asked is still the kind of thing `HERDR_ENABLE_WRITE_EXT` exists to
draw a line around, and without that gate there is no way to make a child at all, so a separate
switch would only ever be on when this one was.

**3. The root check happens before the mkdir, not after.** `os.makedirs` creates intermediate
directories, so a root whose directory has been moved away would be silently recreated by the very
call meant to make something inside it. `create_child` refuses on `not os.path.isdir(root["cwd"])`
first. A root that is gone is a config pointing somewhere that moved; putting it back is not this
function's decision.

**4. A name that is already a project is an answer, not an error.** `create_child` returns the
existing row with no error and nothing written. Making a project and asking for the one that is
already there converge, for the same reason creation and adoption do — the directory *is* the
registration, so asking for it twice is idempotent by construction.

**5. `container` is display, not authority.** A container root is still scanned, still takes new
children, and still names any pane that sits directly in it — a pane has to be called something.
All the flag says is "never offer this as somewhere to start". It changes no security boundary:
containment is still decided by `child_path_ok` against the same root row, and a container root is
as able to take a child as any other. Refused when set without `children`, because a flag that
narrows what a root offers means nothing on an entry that is not a root.

**6. Which projects a hand reaches for is not a fact about the work.** The picking order lives in
`localStorage` under `herdr_project_recent`, not in the six shared documents. Pairs and the
conversation index are assertions about the agents and must follow the user between browsers; a
phone and a laptop disagreeing about which projects are used most is each of them being right.
The sort is stable and keyed on that list alone, so a browser that has picked nothing sees the
roster in exactly the order it saw before this existed.

## What is deliberately not here

**A UI switch for `container`.** The flag is a property of what a root is *for*, and it lives in the
file that already says what a root is. Making it editable from the app means a seventh shared
document and a second authority over the roster — worth it if the question is ever asked twice,
and not before. The upgrade path is additive: the relay would merge the document over the file's
value in `public_projects`, and no other code reads the flag.

**`create_project` on a marker root.** `child_target` refuses it — the relay will not write the
marker file, and the scan would never adopt what it made. Same rule as a start's `child`, in the
same place, for the same reason.

**A dropdown for the Project strip.** The strip scrolls and is now ordered by use, which is the
cheaper half of the same complaint. A menu is what to add if the ordered strip still buries things.
