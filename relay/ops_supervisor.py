"""Start, stop and probe the services in the registry. No Telegram in this module.

Two rules run through everything here, and both exist because the alternative has a failure mode
that is worse than not having the feature at all:

**Signal the process group, never the pid.** `start.sh` runs the relay *and* `cloudflared`, and
cleans both up from its `trap cleanup INT TERM EXIT`. Killing only the pid we recorded leaves the
tunnel alive, publishing a hostname that now answers 502 — the exact state this bot exists to
resolve. So children are started with `start_new_session=True` (their own group) and stopped with
`killpg`.

**Re-check identity before signalling.** A pid recorded minutes ago may belong to something else by
now. Every signal is preceded by reading the live process's argv back and confirming it is still
ours; a mismatch clears the stale state and refuses. This is the same rule `lib-ports.sh` states
for ports — never stop a process this project did not start — applied to pids.
"""
import json
import os
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from ops_config import Service

DEFAULT_STATE_DIR = "~/.config/herdr-remote/run"

TERM_GRACE = 20.0    # start.sh's cleanup has to stop a relay and a tunnel; give it room
KILL_GRACE = 3.0
POLL = 0.25


def state_dir() -> Path:
    path = Path(os.path.expanduser(os.environ.get("HERDR_OPS_STATE_DIR") or DEFAULT_STATE_DIR))
    path.mkdir(parents=True, exist_ok=True)
    return path


def state_path(name: str) -> Path:
    return state_dir() / f"{name}.json"


def read_state(name: str) -> dict | None:
    try:
        with open(state_path(name), encoding="utf-8") as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_state(name: str, state: dict):
    state_path(name).write_text(json.dumps(state), encoding="utf-8")


def clear_state(name: str):
    state_path(name).unlink(missing_ok=True)


def process_argv(pid: int) -> str:
    """The live command line of `pid`, or "" if it is gone."""
    try:
        out = subprocess.run(["ps", "-o", "command=", "-p", str(pid)],
                             capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip()


def identity_ok(pid: int, argv: list[str]) -> bool:
    """Is `pid` still the process we started? Guards against pid reuse before any signal."""
    if not argv:
        return False
    live = process_argv(pid)
    return bool(live) and os.path.basename(argv[0]) in live


# Popen handles for services this bot start()ed, so they can be reaped properly. A service adopted
# across a bot restart is not in here, and the waitpid fallback below covers it.
_CHILDREN: dict[int, subprocess.Popen] = {}


def reap(pid: int):
    """Collect an exited child, targeted at one pid.

    Services are our direct children even though they lead their own session, so an exited one
    stays a zombie until someone waits for it — and a zombie still answers `kill(pid, 0)`, which
    would have the bot reporting a dead service as running. Targeted rather than `waitpid(-1)`:
    a blanket reaper would steal the exit status from the `subprocess.run` calls used by probes.
    """
    child = _CHILDREN.get(pid)
    if child is not None:
        if child.poll() is not None:
            _CHILDREN.pop(pid, None)
        return
    try:
        os.waitpid(pid, os.WNOHANG)
    except (ChildProcessError, OSError):   # not ours: adopted across a restart, or already reaped
        pass


def running(state: dict | None) -> bool:
    if not state:
        return False
    pid = state.get("pid")
    if not isinstance(pid, int):
        return False
    reap(pid)
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, PermissionError, OSError):
        return False
    return identity_ok(pid, state.get("argv") or [])


def reconcile(names) -> list[str]:
    """Drop state files whose process is gone. Run at boot, so a restarted bot adopts reality.

    Without this the bot would either start a duplicate (the port then hard-errors in start.sh) or
    report a service up because a file on disk says so.
    """
    cleared = []
    for name in names:
        state = read_state(name)
        if state and not running(state):
            clear_state(name)
            cleared.append(name)
    return cleared


def uptime(state: dict | None) -> str:
    if not state or not state.get("started_at"):
        return "-"
    seconds = int(time.time() - state["started_at"])
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h{(seconds % 3600) // 60}m"
    return f"{seconds // 86400}d{(seconds % 86400) // 3600}h"


# --- Lifecycle ---

def start(svc: Service) -> dict:
    """Launch the service detached, in its own session. Returns the state that was recorded."""
    state = read_state(svc.name)
    if running(state):
        raise RuntimeError(f"{svc.name} is already running (pid {state['pid']}, "
                           f"up {uptime(state)})")
    clear_state(svc.name)
    if not svc.start:
        raise RuntimeError(f"{svc.name} has no 'start' argv (unit-only service)")

    log_path = svc.log or str(state_dir() / f"{svc.name}.log")
    Path(log_path).parent.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, **svc.env}

    with open(log_path, "ab") as log:
        log.write(f"\n=== herdr-ops start {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n"
                  .encode())
        log.flush()
        proc = subprocess.Popen(
            svc.start, cwd=svc.root, env=env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            start_new_session=True,   # its own session and group: outlives this bot, and killpg
        )                             # below reaches start.sh's whole tree

    _CHILDREN[proc.pid] = proc
    state = {"pid": proc.pid, "pgid": proc.pid, "argv": list(svc.start),
             "started_at": time.time(), "log": log_path}
    write_state(svc.name, state)      # before returning: a reply the caller sees must be backed by
    return state                      # state on disk, or a crash here would orphan the child


def _group_gone(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
        gone = False
    except (ProcessLookupError, PermissionError, OSError):
        gone = True
    # Reap *after* the check, not before. A group whose only member is an unreaped zombie leader
    # already answers ESRCH, so the check can go true in the same instant the child exits — reaping
    # first would then leave the Popen unwaited and the process a zombie for the bot's lifetime.
    reap(pgid)
    return gone


def stop(svc: Service) -> str:
    """SIGTERM the process group, escalate if it will not go. Returns a human outcome."""
    state = read_state(svc.name)
    if not state:
        return f"{svc.name} is not running."
    pid, pgid = state.get("pid"), state.get("pgid") or state.get("pid")
    if not running(state):
        clear_state(svc.name)
        return f"{svc.name} was not running (cleared stale state)."
    if not identity_ok(pid, state.get("argv") or []):
        clear_state(svc.name)
        return f"pid {pid} is no longer {svc.name} (pid reuse). Cleared stale state, sent nothing."

    os.killpg(pgid, signal.SIGTERM)   # the group — start.sh's trap takes the tunnel down with it
    deadline = time.time() + TERM_GRACE
    while time.time() < deadline:
        if _group_gone(pgid):
            clear_state(svc.name)
            return f"{svc.name} stopped (SIGTERM)."
        time.sleep(POLL)

    os.killpg(pgid, signal.SIGKILL)
    deadline = time.time() + KILL_GRACE
    while time.time() < deadline:
        if _group_gone(pgid):
            clear_state(svc.name)
            return f"{svc.name} stopped (SIGKILL after {TERM_GRACE:.0f}s)."
        time.sleep(POLL)
    return f"{svc.name} did not die after SIGKILL — pgid {pgid} still present."


def restart(svc: Service, health_wait: float = 30.0) -> str:
    """Stop, wait for the probe to go down, start, wait for it to come back."""
    lines = [stop(svc)]

    deadline = time.time() + 10
    while time.time() < deadline and probe(svc)[0]:
        time.sleep(POLL)

    state = start(svc)
    lines.append(f"{svc.name} started (pid {state['pid']}).")

    deadline = time.time() + health_wait
    while time.time() < deadline:
        ok, reason = probe(svc)
        if ok:
            lines.append(f"health: {reason}")
            return "\n".join(lines)
        if not running(read_state(svc.name)):
            lines.append(f"exited immediately — check /logs {svc.name}")
            return "\n".join(lines)
        time.sleep(0.5)
    lines.append(f"started but health probe still failing after {health_wait:.0f}s "
                 f"— /logs {svc.name}")
    return "\n".join(lines)


# --- Health ---

def probe(svc: Service) -> tuple[bool, str]:
    """Is the service actually working? Never raises — any failure is a (False, reason)."""
    kind, value = next(iter(svc.health.items()))
    try:
        if kind == "tcp":
            with socket.create_connection(("127.0.0.1", value), timeout=1):
                return True, f"tcp {value} open"
        if kind == "pgrep":
            done = subprocess.run(["pgrep", "-f", value], capture_output=True, timeout=2)
            return done.returncode == 0, "pgrep matched" if done.returncode == 0 else "no match"
        if kind == "http":
            with urllib.request.urlopen(value, timeout=3) as response:
                return response.status < 500, f"http {response.status}"
        if kind == "unit":
            return _unit_active(svc)
    except (OSError, urllib.error.URLError, subprocess.SubprocessError, ValueError) as exc:
        return False, f"{kind}: {type(exc).__name__}"
    return False, f"unknown probe {kind}"


def unit_name(svc: Service) -> str | None:
    if not svc.unit:
        return None
    key = "macos" if os.uname().sysname == "Darwin" else "linux"
    name = svc.unit.get(key)
    return name.replace("$UID", str(os.getuid())) if name else None


def _unit_active(svc: Service) -> tuple[bool, str]:
    name = unit_name(svc)
    if not name:
        return False, "no unit for this platform"
    if os.uname().sysname == "Darwin":
        done = subprocess.run(["launchctl", "print", name], capture_output=True, text=True,
                              timeout=3)
        return ("state = running" in done.stdout,
                "unit running" if "state = running" in done.stdout else "unit not running")
    done = subprocess.run(["systemctl", "--user", "is-active", name], capture_output=True,
                          text=True, timeout=3)
    return done.returncode == 0, f"unit {done.stdout.strip() or 'unknown'}"


def unit_action(svc: Service, action: str) -> str:
    """start/stop/restart through launchd or systemd. Only used when the registry names a unit."""
    name = unit_name(svc)
    if not name:
        raise RuntimeError(f"{svc.name} has no unit for this platform")
    if os.uname().sysname == "Darwin":
        argv = {"start": ["launchctl", "kickstart", name],
                "stop": ["launchctl", "kill", "SIGTERM", name],
                "restart": ["launchctl", "kickstart", "-k", name]}[action]
    else:
        argv = ["systemctl", "--user", action, name]
    done = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    if done.returncode != 0:
        raise RuntimeError(f"{' '.join(argv[:2])} failed: "
                           f"{(done.stderr or done.stdout).strip()[:200]}")
    return f"{svc.name}: {action} via {argv[0]} ({name})"
