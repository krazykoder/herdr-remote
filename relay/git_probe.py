#!/usr/bin/env python3
"""Where an agent's work landed: the branch it is on, and what it committed.

A turn in the record says what an agent said. This says what changed while it was saying it — the
branch the pane's cwd was on, the commit it was at, and the commits that appeared between the
previous turn recorded for that directory and this one. That last part is the whole point: it is
what turns "the agent said it refactored the parser" into the two commits that did it.

Nothing here decides *when* to look. The relay does that at the two moments it already writes to
the record, so the cost is one or two git calls per turn rather than per poll.

Remote panes are reached the way the relay reaches herdr on them — over `ssh`, one shell word per
argument. `cwd` is a path this relay was given by herdr, but it is still interpolated into a remote
shell command, so it is quoted like everything else.
"""
import json
import shlex
import subprocess
import time

# Subjects are what a person reads; the sha is what they look up. Anything longer than this is a
# commit message that was never going to fit in a chat bubble.
SUBJECT_MAX = 200
# A turn's range is the work of one turn. A hundred commits means the previous head is ancient —
# a rebase, a fetch, a branch switch — and listing all of it would bury the turn it belongs to.
COMMITS_MAX = 20
# A repository that does not answer this fast is not a repository the poll loop should be waiting
# on. Short, because this runs inside the turn-end path.
TIMEOUT = 8


def _git(cwd, remote, *args, timeout=TIMEOUT):
    """git in `cwd`, locally or over ssh. Returns stdout, or '' for anything that went wrong.

    `-C` rather than a `cd`: one argv, no shell, and it fails cleanly on a path that is not a
    repository instead of leaving the process somewhere unexpected.
    """
    argv = ("git", "-C", cwd, *args)
    if remote:
        # ssh concatenates its arguments and hands them to a login shell, so every word is quoted.
        cmd = ["ssh", "-o", "ConnectTimeout=5", "-o", "BatchMode=yes",
               remote, " ".join(shlex.quote(a) for a in argv)]
    else:
        cmd = list(argv)
    try:
        done = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def head(cwd, remote=None):
    """(branch, sha) for `cwd`. ('', '') when it is not a repository.

    One call, not two: `rev-parse` takes both, and every one of these on a remote host is an ssh
    round trip. The sha is asked for *before* `--abbrev-ref`, because that flag applies to every
    revision after it and asking the other way round returns the branch name twice.

    `--abbrev-ref HEAD` is 'HEAD' on a detached checkout, which is reported as no branch — a
    detached HEAD is a commit, and claiming a branch called "HEAD" would be a lie that later reads
    as one.
    """
    if not cwd:
        return "", ""
    out = _git(cwd, remote, "rev-parse", "HEAD", "--abbrev-ref", "HEAD")
    lines = out.splitlines()
    if len(lines) < 2:
        return "", ""
    branch = lines[1].strip()
    return ("" if branch == "HEAD" else branch), lines[0].strip()


def commits(cwd, since_sha, until_sha, remote=None):
    """The commits in (since_sha, until_sha], oldest first, as {'sha', 'subject'} dicts.

    Empty when either end is missing, when nothing moved, or when `since_sha` is no longer in this
    repository — which is ordinary rather than exceptional: a rebase, a reset or a branch that was
    deleted leaves the record holding a sha that git can no longer reach. Returning nothing there
    is honest; guessing a range from a sha git disowns is not.
    """
    if not since_sha or not until_sha or since_sha == until_sha:
        return []
    # %x1f between the fields: a subject can contain anything a person can type, including tabs,
    # and a unit separator cannot appear in one.
    out = _git(cwd, remote, "log", "--no-merges", f"--max-count={COMMITS_MAX}",
               "--reverse", "--format=%H%x1f%s", f"{since_sha}..{until_sha}")
    rows = []
    for line in out.splitlines():
        sha, _, subject = line.partition("\x1f")
        if sha:
            rows.append({"sha": sha.strip(), "subject": subject.strip()[:SUBJECT_MAX]})
    return rows


def probe(cwd, remote=None, since_sha=None):
    """Everything one turn needs, in the shape conversation_log.record takes.

    Returns None when `cwd` is not a repository, so a caller can pass the result straight through
    and a pane that is not in a checkout costs nothing but the one failed call.
    """
    branch, sha = head(cwd, remote)
    if not sha:
        return None
    return {"branch": branch, "commit": sha,
            "commits": commits(cwd, since_sha, sha, remote) if since_sha else []}


class Cache:
    """One probe per directory per burst.

    A turn end writes several rows — an agent's narration and its closing message are separate
    turns of the same moment — and every one of them would otherwise be its own `git rev-parse`,
    or its own ssh round trip on a remote host. The window is short on purpose: this is here to
    collapse one event's calls, never to serve a stale branch to the next one.
    """

    def __init__(self, ttl=2.0):
        self.ttl = ttl
        self._at = {}

    def probe(self, cwd, remote=None, since_sha=None):
        key = (remote or "", cwd or "")
        hit = self._at.get(key)
        now = time.monotonic()
        if hit and now - hit[0] < self.ttl:
            return hit[1]
        got = probe(cwd, remote, since_sha)
        self._at[key] = (now, got)
        return got


def _demo():
    """Self-check against a repository built here, so it needs no fixture and no network."""
    import os
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@e",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@e"}
        run = lambda *a: subprocess.run(a, cwd=d, env=env, capture_output=True, check=True)
        run("git", "init", "-q", "-b", "work")
        open(os.path.join(d, "f"), "w").write("1")
        run("git", "add", "f")
        run("git", "commit", "-qm", "first")
        branch, first = head(d)
        assert branch == "work", branch
        assert len(first) == 40, first

        open(os.path.join(d, "f"), "w").write("2")
        run("git", "commit", "-qam", "second")
        got = probe(d, since_sha=first)
        assert got["branch"] == "work"
        assert [c["subject"] for c in got["commits"]] == ["second"], got
        assert got["commit"] != first

        assert commits(d, first, first) == []
        assert commits(d, "0" * 40, got["commit"]) == [], "a sha git disowns is not a range"
        assert head(tempfile.gettempdir() + "/definitely-not-a-repo-xyz") == ("", "")
    print("git_probe: ok")


if __name__ == "__main__":
    _demo()
    print(json.dumps(probe(".") or {}, indent=2))
