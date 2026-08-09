#!/usr/bin/env python3
"""E2E for P2 start_agent: two fake hosts, real relay, browser-shaped WebSocket client.

Not a unittest — it spawns real relay processes and binds a port, so it is named to stay
out of `unittest discover`. Run it directly:

    .venv313/bin/python tests/e2e/e2e_start_agent.py

`bin/herdr` and `bin/ssh` here are fakes. The fake ssh sets HERDR_FAKE_HOST and execs
locally, which is what lets one machine present two hosts — the only way to reproduce the
pane-ID and workspace-ID collisions the guards exist for. Override the port with
HERDR_E2E_PORT; the interpreter must have `websockets` (the repo venv does).
"""
import asyncio, json, os, signal, socket, subprocess, sys, time
from websockets.asyncio.client import connect

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PY = sys.executable
LOG = f"{HERE}/fake_herdr.log"
PORT = os.environ.get("HERDR_E2E_PORT", "8399")
TOKEN = "s3cret"

fails = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  {detail}" if not cond else ""))
    if not cond:
        fails.append(name)


def relay_env(**extra):
    env = dict(os.environ)
    env.update({
        "PATH": f"{HERE}/bin:" + env["PATH"],          # fake ssh
        "HERDR_BIN": f"{HERE}/bin/herdr",              # fake herdr
        "FAKE_LOG": LOG,
        "HERDR_REMOTES": "box",
        "HERDR_PROJECTS_FILE": f"{HERE}/projects.json",
        "HERDR_RELAY_PORT": PORT,
        "HERDR_LOG_DIR": f"{HERE}/logs",
    })
    env.pop("HERDR_ENABLE_WRITE_EXT", None)
    env.pop("HERDR_RELAY_TOKEN", None)
    env.pop("HERDR_START_AGENTS", None)
    env.update(extra)
    return env


def start_relay(**extra):
    open(LOG, "w").close()
    proc = subprocess.Popen([PY, f"{REPO}/relay/herdr_relay.py"], env=relay_env(**extra),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(3.5)  # first poll is at t+0, second at t+2
    return proc


def stop_relay(proc):
    proc.send_signal(signal.SIGKILL)
    proc.wait()


def log_lines(*needles):
    with open(LOG) as f:
        return [l for l in f.read().splitlines() if all(n in l for n in needles)]


def url(token=TOKEN):
    return f"ws://127.0.0.1:{PORT}" + (f"?token={token}" if token else "")


async def drain_to_agents(ws):
    """Read the connect burst; return (messages_by_type, first agents snapshot)."""
    seen = []
    while True:
        m = json.loads(await ws.recv())
        seen.append(m)
        if m["type"] == "agents" and m["agents"]:
            return seen, m


async def rpc(ws, payload):
    await ws.send(json.dumps(payload))
    while True:
        m = json.loads(await ws.recv())
        if m["type"] in ("agents", "blocked", "agent_update", "pane_content"):
            continue
        return m


async def gate_off_run():
    proc = start_relay()
    try:
        async with connect(url(token=None)) as ws:
            seen, _ = await drain_to_agents(ws)
            types = [m["type"] for m in seen]
            check("A10 no start_options when write ext off", "start_options" not in types, types)
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "new_workspace"})
            check("A5 start refused when write ext off",
                  r.get("command") == "start_agent" and r.get("ok") is False
                  and r.get("error") == "write extensions disabled", r)
            await asyncio.sleep(0.3)
            check("A5 no herdr write call made", not log_lines("agent start"), log_lines("agent start"))
    finally:
        stop_relay(proc)


def boot_gate_run():
    """WRITE_EXT without a token must refuse to boot."""
    proc = subprocess.Popen([PY, f"{REPO}/relay/herdr_relay.py"],
                            env=relay_env(HERDR_ENABLE_WRITE_EXT="1"),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out, _ = proc.communicate(timeout=20)
    check("write ext without token refuses to boot", proc.returncode == 1, proc.returncode)
    check("boot refusal names both variables",
          "HERDR_ENABLE_WRITE_EXT" in out and "HERDR_RELAY_TOKEN" in out, out.strip())

    proc = subprocess.Popen([PY, f"{REPO}/relay/herdr_relay.py"],
                            env=relay_env(HERDR_START_AGENTS="cl aude"),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out, _ = proc.communicate(timeout=20)
    check("bad allowlist refuses to boot", proc.returncode == 1, proc.returncode)
    check("allowlist refusal names the value", "'cl aude'" in out, out.strip())


async def gate_on_run():
    proc = start_relay(HERDR_ENABLE_WRITE_EXT="1", HERDR_RELAY_TOKEN=TOKEN,
                       HERDR_START_AGENTS="claude,codex")
    try:
        async with connect(url()) as ws:
            seen, snap = await drain_to_agents(ws)
            types = [m["type"] for m in seen]
            check("start_options sits between projects and agents",
                  types[:3] == ["projects", "start_options", "agents"], types)
            opts = seen[1]
            check("allowlist is the relay's, in order", opts["agents"] == ["claude", "codex"], opts)
            check("roles are fixed", opts["roles"] == ["architect", "reviewer", "agent"], opts)

            # --- refusals (no herdr call may happen) ---
            open(LOG, "w").close()
            cases = [
                ("A4 unknown agent", {"name": "bash"}, "agent not in allowlist"),
                ("A4 unknown role", {"role": "root"}, "unknown role"),
                ("A4 unknown project", {"project_id": "nope"}, "unknown project_id"),
                ("A4 client cwd refused", {"cwd": "/etc"}, "unexpected field(s) for new_workspace: cwd"),
                ("A4 client argv refused", {"argv": ["sh"]}, "unexpected field(s) for new_workspace: argv"),
            ]
            for label, patch, want in cases:
                msg = {"type": "start_agent", "name": "claude", "role": "architect",
                       "project_id": "charts", "placement": "new_workspace"}
                msg.update(patch)
                r = await rpc(ws, msg)
                check(label, r.get("ok") is False and r.get("error") == want, r)

            for label, patch, want in [
                ("A11 two-host workspace refused", {"placement": "new_tab", "workspace_id": "w8"},
                 "ambiguous workspace_id (same id on multiple hosts)"),
                ("A4 cross-host workspace refused", {"placement": "new_tab", "workspace_id": "w2"},
                 "workspace is not on this project's host"),
                ("A4 foreign workspace refused", {"placement": "new_tab", "workspace_id": "w8x"},
                 "unknown workspace_id"),
                ("A4 ambiguous split pane refused", {"placement": "split", "split_from": "w8:p1"},
                 "ambiguous pane_id (same id on multiple hosts)"),
                ("A4 cross-host split refused", {"placement": "split", "split_from": "w2:p1"},
                 "pane is not on this project's host"),
            ]:
                msg = {"type": "start_agent", "name": "claude", "role": "architect",
                       "project_id": "charts", "placement": "new_workspace"}
                msg.update(patch)
                r = await rpc(ws, msg)
                check(label, r.get("ok") is False and r.get("error") == want, r)

            await asyncio.sleep(0.3)
            check("A4 refusals issued no herdr write",
                  not log_lines("agent start") and not log_lines("workspace create"),
                  log_lines("agent start") + log_lines("workspace create"))

            # --- A1 new workspace, local project ---
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "new_workspace"})
            check("A1 local new workspace ok", r.get("ok") is True, r)
            check("A9 label is the next free Role N", r.get("label") == "Architect 2", r)
            await asyncio.sleep(0.3)
            check("A1 workspace created local with configured cwd",
                  log_lines("workspace create") ==
                  ["local workspace create --cwd /work/charts --label Charts --focus"],
                  log_lines("workspace create"))
            check("A1 agent start carries fixed argv on local",
                  log_lines("agent start") ==
                  ["local agent start claude --cwd /work/charts --workspace local:wNew --focus -- claude"],
                  log_lines("agent start"))
            check("A9 pane renamed",
                  log_lines("pane rename") == ["local pane rename local:pNew Architect 2"],
                  log_lines("pane rename"))

            # --- A1 new workspace, remote project ---
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "codex", "role": "reviewer",
                               "project_id": "relay", "placement": "new_workspace"})
            check("A1 remote new workspace ok", r.get("ok") is True, r)
            await asyncio.sleep(0.3)
            check("A1 remote calls all landed on box",
                  log_lines("workspace create") == ["box workspace create --cwd /srv/relay --label Relay --focus"]
                  and log_lines("agent start") ==
                  ["box agent start codex --cwd /srv/relay --workspace box:wNew --focus -- codex"],
                  log_lines("workspace create") + log_lines("agent start"))
            check("A1 nothing ran on local", not [l for l in log_lines("create") if l.startswith("local")])

            # --- A2 new tab in a live Project workspace (remote) ---
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "agent",
                               "project_id": "relay", "placement": "new_tab", "workspace_id": "w2"})
            check("A2 new tab ok", r.get("ok") is True, r)
            await asyncio.sleep(0.3)
            check("A2 tab created on the workspace's host, carrying the pane's label",
                  log_lines("tab create") == ["box tab create --workspace w2 --label Agent 1 --focus"],
                  log_lines("tab create"))
            check("A2 agent anchored to the returned tab id",
                  log_lines("agent start") ==
                  ["box agent start claude --cwd /srv/relay --tab box:tNew --focus -- claude"],
                  log_lines("agent start"))

            # --- A3 split beside a live pane (local) ---
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "split", "split_from": "w1:p1"})
            check("A3 split ok", r.get("ok") is True, r)
            await asyncio.sleep(0.3)
            check("A3 split reuses the source pane's tab, no tab created",
                  log_lines("agent start") ==
                  ["local agent start claude --cwd /work/charts --tab w1:t1 --split right --focus -- claude"]
                  and not log_lines("tab create"),
                  log_lines("agent start") + log_lines("tab create"))
    finally:
        stop_relay(proc)


async def failure_run():
    """A6/A7: herdr failures must not be reported as a started session."""
    proc = start_relay(HERDR_ENABLE_WRITE_EXT="1", HERDR_RELAY_TOKEN=TOKEN,
                       HERDR_START_AGENTS="claude", FAKE_FAIL="agent start")
    try:
        async with connect(url()) as ws:
            await drain_to_agents(ws)
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "new_workspace"})
            check("A7 agent start failure reported as not ok", r.get("ok") is False, r)
            check("A7 no pane_id claimed", "pane_id" not in r, r)
            await asyncio.sleep(0.3)
            check("A7 no rename attempted", not log_lines("pane rename"), log_lines("pane rename"))
    finally:
        stop_relay(proc)

    proc = start_relay(HERDR_ENABLE_WRITE_EXT="1", HERDR_RELAY_TOKEN=TOKEN,
                       HERDR_START_AGENTS="claude", FAKE_FAIL="workspace create",
                       FAKE_FAIL_MODE="no_id")
    try:
        async with connect(url()) as ws:
            await drain_to_agents(ws)
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "new_workspace"})
            check("A6 missing workspace_id reported as not ok",
                  r.get("ok") is False and "workspace_id" in r.get("error", ""), r)
            await asyncio.sleep(0.3)
            check("A6 no agent started", not log_lines("agent start"), log_lines("agent start"))
    finally:
        stop_relay(proc)


def preflight():
    os.makedirs(f"{HERE}/logs", exist_ok=True)
    probe = socket.socket()
    try:
        probe.connect(("127.0.0.1", int(PORT)))
    except OSError:
        return
    finally:
        probe.close()
    sys.exit(f"port {PORT} is in use — set HERDR_E2E_PORT to a free port")


async def main():
    preflight()
    boot_gate_run()
    await gate_off_run()
    await gate_on_run()
    await failure_run()
    print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
    sys.exit(1 if fails else 0)


asyncio.run(main())
