# Plan: Child on a start

Decision log: `../02_architecture/decision_log/2026-08-26_a_start_that_makes_its_own_project.md`.
**Class B** — one additive optional field on `start_agent`. No existing message shape changes.

## Goal

`start_agent {project_id: "<root>", child: "notes"}` starts in `<root cwd>/notes`, creating the
directory when it is not there. Nothing registers the project: the next poll lists the root and
derives the row, the same as for a directory made by hand.

## File-by-file

### `[MODIFY] relay/projects.py`
- `CHILD_NAME_RE = ^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$` beside `MARKER_RE`.
- `child_target(name, root, projects) -> (project, create, error)` — charset, root-is-a-root,
  marker refusal, id folding and collision, and `child_path_ok` for a path that already exists.
- `make_child_dir(cwd, root) -> error|None` — `assert _under(cwd, root)`, then
  `os.makedirs(exist_ok=True)`.

### `[MODIFY] relay/start_agent.py`
- `"child"` into `BASE_FIELDS` (start only; `OPEN_TERMINAL_FIELDS` unchanged, so an
  `open_terminal` naming one is refused as an unexpected field).
- `_placement_plan`: placement/extra-field checks move above the child resolution; `child_target`
  resolves the row; the existing `child_path_ok` call runs for every case except a directory that
  does not exist yet. `plan["create_child"]` carries the name to make, `""` otherwise.

### `[MODIFY] relay/herdr_relay.py`
- Import `make_child_dir`; `_child_dir(plan)` re-identifies the root and creates the directory;
  `_create_target_pane` calls it inside the existing `plan.get("parent")` block, before the
  unchanged `child_path_ok` re-check. Audit detail gains `child=`.

### `[MODIFY] tests/test_projects.py`
`ChildOnAStartTests`: charset refusals, not-a-root, marker root, id collision, converge on an
existing child, validation makes nothing on disk, the executor creates it and the next scan finds
it, a root that moved, a symlink planted between the mkdir and the check.

### `[MODIFY] CLAUDE.md`
`child` in the `start_agent` wire line.

## Wire contract

| `child` | Result |
|---|---|
| absent | unchanged behaviour |
| `^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$` on a root | starts in `<root>/<name>`, created if absent |
| anything else, incl. `null`, non-string, `""`, `.`/`..`, a path | refused |
| on a project that is not a root | `"that project is not a root"` |
| on a root with a `marker` | `"that root only lists directories holding <marker>"` |
| id already held by another directory | `"that name's project id (<id>) is already taken"` |
| name exists as a symlink/file/outside | `"that name is not a directory inside this root"` |
| on `open_terminal` | `"unexpected field(s) for <placement>: child"` |

Refused, never dropped — like `ref` and `config`. A dropped `child` starts in the root itself,
which the client cannot distinguish from success.

## Verification

```bash
.venv313/bin/python -m unittest discover -s tests -t tests
.venv313/bin/python tests/test_projects.py
.venv313/bin/python tests/e2e/e2e_start_agent.py
```

## Acceptance

1. A start naming a new child creates one directory and starts in it; the roster carries the row
   within one poll, with `parent` set.
2. Validation touches nothing on disk.
3. Every refusal above returns its message as `command_result {ok:false}`; no directory is made.
4. A symlink planted after the mkdir still loses at `child_path_ok`.
5. Slice 1's suites stay green.
