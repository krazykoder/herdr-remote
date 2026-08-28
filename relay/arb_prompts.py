"""Every word the arbitrator ever reads, loaded from `relay/prompts/*.md` so it can be curated.

These used to be f-strings interleaved with the assembly code in `arbitration.py`. They are markdown
files instead because they are the part of this feature most likely to be rewritten by hand,
repeatedly, by somebody reading a real session's transcript — and prompt text buried between a `for`
loop and a `json.loads` is text nobody edits twice. Each file carries its own note on what it is for
and what may be substituted into it, above the first heading and never sent to anybody.

**Re-read on every use, not held from boot.** A prompt is sent a handful of times per session and
the files are a few kilobytes, so caching them buys nothing worth the surprise of an edit that does
not take until the relay is restarted. The `mtime` check means an unedited file is one `stat`.

**A broken edit keeps the last copy that loaded.** Same rule as the Projects config, and for the
same reason: taking a running relay's sessions down is a heavy price for a typo in a text file, and
a half-written brief is worse than yesterday's whole one. Boot is the exception — `check()` runs at
import, so a relay whose prompts are missing or malformed fails to start rather than discovering it
at the first session.

Substitution is `string.Template`: `$name`, and `$$` for a literal dollar. Not `str.format`,
because every one of these prompts is about writing JSON and doubling each brace in prose a person
is meant to edit is a trap that would be sprung exactly once, in production.
"""
import logging
import os
import string

log = logging.getLogger("herdr-relay")

DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "prompts")

# What must be there for a session to run at all, and which sections each file has to carry. Named
# rather than discovered, so a file that lost a heading is caught at boot by the same check that
# catches one that lost the whole file.
REQUIRED = {
    "starter": ("brief",),
    "modes": ("rules", "line"),
    "roster": ("opening", "changed-both", "changed-members", "changed-roles", "changed-scope",
               "columns", "moved", "same", "closing"),
    "resume": ("fallback",),
}

# name -> (mtime, size, {section: text}). The last copy that parsed, which is what a bad edit falls
# back to.
_cache = {}


def _parse(text):
    """`## name` splits the file; anything above the first heading is the editor's note."""
    out, key, body = {}, None, []
    for line in text.split("\n"):
        if line.startswith("## "):
            if key:
                out[key] = "\n".join(body).strip("\n")
            key, body = line[3:].strip(), []
        elif key is not None:
            body.append(line)
    if key:
        out[key] = "\n".join(body).strip("\n")
    return out


def sections(name):
    """One file's sections, re-read when it has changed on disk."""
    path = os.path.join(DIR, f"{name}.md")
    held = _cache.get(name)
    try:
        st = os.stat(path)
        stamp = (st.st_mtime_ns, st.st_size)
        if held and held[0] == stamp:
            return held[1]
        with open(path, encoding="utf-8") as fh:
            got = _parse(fh.read())
        missing = [s for s in REQUIRED.get(name, ()) if not got.get(s)]
        if missing:
            raise ValueError(f"{path}: missing section(s) {', '.join(missing)}")
    except (OSError, ValueError) as e:
        if held is None:
            raise
        log.warning("arbitration prompts: keeping the last copy of %s.md — %s", name, e)
        return held[1]
    _cache[name] = (stamp, got)
    return got


def text(name, section, **fields):
    """One section with its placeholders filled. An unknown `$name` is left as written.

    `safe_substitute` rather than `substitute`: a person editing prose is far likelier to write a
    stray `$` than to depend on one being fatal, and a brief with a literal `$foo` in it is a
    cosmetic fault where a raised KeyError mid-session is a stopped session.
    """
    body = sections(name).get(section, "")
    return string.Template(body).safe_substitute(**fields) if fields else body


def check():
    """Load every file once, so a bad prompt directory fails the relay's boot and not a session."""
    for name in REQUIRED:
        sections(name)


def starter(*, scope, gates, max_instruction, query_path):
    """The opening brief. Both instruction styles are described, not only the one in force — see
    `modes.md`, and `Arbitration.edit`, which is why a mid-session change needs no re-brief."""
    return text("starter", "brief", scope=scope, gates=gates, max_instruction=max_instruction,
                modes=text("modes", "rules"), query_path=query_path)


def mode_line(mode):
    return text("modes", "line", mode=mode)


def roster_what(moved, reroled):
    if moved and reroled:
        return text("roster", "changed-both")
    if moved:
        return text("roster", "changed-members")
    if reroled:
        return text("roster", "changed-roles")
    return text("roster", "changed-scope")


def resume_note(reason):
    """A pause reason's own words, or the fallback. Adding a section is all a new reason needs."""
    got = sections("resume")
    known = got.get(reason or "")
    if known and reason != "fallback":
        return known
    return string.Template(got["fallback"]).safe_substitute(
        reason=str(reason or "unknown").replace("_", " "))


check()
