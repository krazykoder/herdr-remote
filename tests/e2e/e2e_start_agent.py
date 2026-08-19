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
import asyncio, json, os, re, signal, socket, subprocess, sys, time
from websockets.asyncio.client import connect

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PY = sys.executable
LOG = f"{HERE}/fake_herdr.log"
PORT = os.environ.get("HERDR_E2E_PORT", "8399")
EXT_PORT = str(int(PORT) + 1)
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
        # Both databases named explicitly, into this script's own log directory. Left unset
        # they default under the repo root, which on a developer's machine is the record
        # their own relay is keeping. HERDR_STATE_DIR stood here and is read by nothing in
        # the relay, so it never moved anything.
        "HERDR_ARBITER_DB": f"{HERE}/logs/arbitration.sqlite3",
        "HERDR_STATE_DB": f"{HERE}/logs/state.sqlite3",
    })
    env.pop("HERDR_ENABLE_WRITE_EXT", None)
    env.pop("HERDR_ENABLE_TERMINAL", None)
    env.pop("HERDR_RELAY_TOKEN", None)
    env.pop("HERDR_START_AGENTS", None)
    env.pop("HERDR_LAN_OPEN", None)
    env.pop("HERDR_LAN_BIND", None)
    env.pop("HERDR_EXTERNAL_PORT", None)
    env.update(extra)
    return env


def start_relay(**extra):
    open(LOG, "w").close()
    proc = subprocess.Popen([PY, f"{REPO}/relay/herdr_relay.py"], env=relay_env(**extra),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"relay exited during startup: {proc.stdout.read()}")
        try:
            with socket.create_connection(("127.0.0.1", int(PORT)), timeout=0.2):
                return proc
        except OSError:
            time.sleep(0.1)
    stop_relay(proc)
    raise RuntimeError(f"relay did not listen on {PORT} within 10 seconds")


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

            # --- W1 pane width. The browser lays unwrapped output out at `cols`, so a wrong
            # number scales every glyph to the wrong pane. It is measured from the wrapped
            # scrollback, not from `pane layout`, whose rect reports a pane's birth width
            # forever once the pane has been resized.
            open(LOG, "w").close()
            await ws.send(json.dumps({"type": "read_pane", "pane_id": "w1:p1", "lines": 12}))
            while True:
                m = json.loads(await ws.recv())
                if m["type"] == "pane_content":
                    break
            check("W1 pane_content carries the measured wrap column", m.get("cols") == 87, m)
            await asyncio.sleep(0.3)
            check("W1 the width is measured, never asked of pane layout",
                  not log_lines("pane layout")
                  and "local pane read w1:p1 --lines 12 --source recent" in log_lines("pane read"),
                  log_lines("pane read") + log_lines("pane layout"))

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
                  ["local agent start architect-2 --kind claude --pane local:pShell --timeout 30000"],
                  log_lines("agent start"))
            check("A9 pane renamed",
                  log_lines("pane rename") == ["local pane rename local:pNew Architect 2"],
                  log_lines("pane rename"))
            check("L1 the workspace's own shell pane becomes the agent's — nothing is closed",
                  not log_lines("pane close"), log_lines("pane close"))

            # --- A1 new workspace, remote project ---
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "codex", "role": "reviewer",
                               "project_id": "relay", "placement": "new_workspace"})
            check("A1 remote new workspace ok", r.get("ok") is True, r)
            await asyncio.sleep(0.3)
            check("A1 remote calls all landed on box",
                  log_lines("workspace create") == ["box workspace create --cwd /srv/relay --label Relay --focus"]
                  and log_lines("agent start") ==
                  ["box agent start reviewer-2 --kind codex --pane box:pShell --timeout 30000"],
                  log_lines("workspace create") + log_lines("agent start"))
            check("A1 nothing ran on local", not [l for l in log_lines("create") if l.startswith("local")])

            # --- A2 new tab in a live Project workspace (remote) ---
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "agent",
                               "project_id": "relay", "placement": "new_tab", "workspace_id": "w2"})
            check("A2 new tab ok", r.get("ok") is True, r)
            await asyncio.sleep(0.3)
            check("A2 tab created on the workspace's host, carrying the pane's label and cwd",
                  log_lines("tab create") ==
                  ["box tab create --workspace w2 --cwd /srv/relay --label Agent 1 --focus"],
                  log_lines("tab create"))
            check("A2 agent attached to the tab's own root pane",
                  log_lines("agent start") ==
                  ["box agent start agent-1 --kind claude --pane box:pShell --timeout 30000"],
                  log_lines("agent start"))
            check("L1 the new tab's shell pane is the agent's — nothing is closed",
                  not log_lines("pane close"), log_lines("pane close"))

            # --- A3 split beside a live pane (local) ---
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "split", "split_from": "w1:p1"})
            check("A3 split ok", r.get("ok") is True, r)
            await asyncio.sleep(0.3)
            check("A3 split splits the source pane itself, no tab created",
                  log_lines("pane split") ==
                  ["local pane split w1:p1 --direction right --cwd /work/charts --focus"]
                  and not log_lines("tab create"),
                  log_lines("pane split") + log_lines("tab create"))
            check("A3 agent attached to the pane the split returned",
                  log_lines("agent start") ==
                  ["local agent start architect-2 --kind claude --pane local:pSplit --timeout 30000"],
                  log_lines("agent start"))
            check("L2 split closes nothing — the sibling pane is the user's own",
                  not log_lines("pane close"), log_lines("pane close"))
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
            check("L3 the workspace created for the failed start is rolled back",
                  log_lines("workspace close") == ["local workspace close local:wNew"],
                  log_lines("workspace close"))
            check("L3 the root pane is not closed separately — the workspace rollback takes it",
                  not log_lines("pane close"), log_lines("pane close"))

            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "new_tab", "workspace_id": "w1"})
            check("L3 new tab failure reported as not ok", r.get("ok") is False, r)
            await asyncio.sleep(0.3)
            check("L3 the tab created for the failed start is rolled back",
                  log_lines("tab close") == ["local tab close local:tNew"], log_lines("tab close"))

            # A failed split is the one rollback that reaches into a workspace the user is
            # already using, so the relay must close exactly the pane it just made and nothing else.
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "split", "split_from": "w1:p1"})
            check("L3c split failure reported as not ok", r.get("ok") is False, r)
            await asyncio.sleep(0.3)
            check("L3c only the pane the split created is rolled back",
                  log_lines("pane close") == ["local pane close local:pSplit"],
                  log_lines("pane close"))
            check("L3c the split rollback touches no tab or workspace",
                  not log_lines("tab close") and not log_lines("workspace close"),
                  log_lines("tab close") + log_lines("workspace close"))
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


async def naming_run():
    """N1-N5: the session name — client-supplied, collision-proof, and honestly reported.

    The herdr agent name is unique per host, so passing the allowlisted agent kind there let
    the first start of an agent work and every later one fail agent_name_taken.
    """
    proc = start_relay(HERDR_ENABLE_WRITE_EXT="1", HERDR_RELAY_TOKEN=TOKEN,
                       HERDR_START_AGENTS="claude")
    try:
        async with connect(url()) as ws:
            await drain_to_agents(ws)
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "new_workspace",
                               "label": "Backend"})
            check("N1 client label accepted", r.get("ok") is True and r.get("label") == "Backend", r)
            await asyncio.sleep(0.3)
            check("N1 the label is slugged into a name herdr will accept",
                  log_lines("agent start") ==
                  ["local agent start backend --kind claude --pane local:pShell --timeout 30000"],
                  log_lines("agent start"))

            for label, bad, want in [
                ("N2 empty label refused", "   ", "label is empty"),
                ("N2 dash-leading label refused", "--focus", "label cannot start with '-'"),
                ("N2 control characters refused", "a\nb", "label contains control characters"),
                ("N2 over-long label refused", "x" * 33, "label is longer than 32 characters"),
            ]:
                r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                                   "project_id": "charts", "placement": "new_workspace",
                                   "label": bad})
                check(label, r.get("ok") is False and r.get("error") == want, r)
    finally:
        stop_relay(proc)

    # A name already held by a live agent — the case that produced "exited 1" on every start
    # after the first, because pane list never reports the name that herdr enforces.
    proc = start_relay(HERDR_ENABLE_WRITE_EXT="1", HERDR_RELAY_TOKEN=TOKEN,
                       HERDR_START_AGENTS="claude", FAKE_TAKEN_NAMES="backend,architect-2")
    try:
        async with connect(url()) as ws:
            await drain_to_agents(ws)
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "new_workspace",
                               "label": "Backend"})
            check("N3 taken name starts anyway, and the label the client sees is untouched",
                  r.get("ok") is True and r.get("label") == "Backend", r)
            await asyncio.sleep(0.3)
            check("N3 the suffix lands on the herdr agent name, not the pane label",
                  re.fullmatch(
                      r"local agent start backend-[a-km-z2-9]{5} --kind claude "
                      r"--pane local:pShell --timeout 30000", "".join(log_lines("agent start"))),
                  log_lines("agent start"))

            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "new_workspace"})
            check("N4 a taken derived name is suffixed too",
                  r.get("ok") is True and r.get("label") == "Architect 2", r)
            await asyncio.sleep(0.3)
            check("N4 the derived name is slugged and suffixed for herdr",
                  re.fullmatch(
                      r"local agent start architect-2-[a-km-z2-9]{5} --kind claude "
                      r"--pane local:pShell --timeout 30000", "".join(log_lines("agent start"))),
                  log_lines("agent start"))
    finally:
        stop_relay(proc)

    # herdr refuses with a JSON error body on stdout and a non-zero exit. Reporting only the exit
    # code turned every distinct refusal into the same unactionable "exited 1".
    proc = start_relay(HERDR_ENABLE_WRITE_EXT="1", HERDR_RELAY_TOKEN=TOKEN,
                       HERDR_START_AGENTS="claude", FAKE_FAIL="agent start",
                       FAKE_FAIL_MODE="error_json")
    try:
        async with connect(url()) as ws:
            await drain_to_agents(ws)
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "new_workspace"})
            check("N5 herdr's own refusal reaches the client",
                  r.get("ok") is False and "agent name is already used" in r.get("error", ""), r)
    finally:
        stop_relay(proc)


def http_status(port, token=None, path="/"):
    """GET a path and report the status. 401 is the interesting one — process_request gates the
    whole HTTP surface, not only the WebSocket upgrade."""
    import urllib.error, urllib.request
    u = f"http://127.0.0.1:{port}{path}" + (f"?token={token}" if token else "")
    try:
        with urllib.request.urlopen(u, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def dual_boot_gate_run():
    """Boot refusals that only exist once there are two listeners."""
    proc = subprocess.Popen([PY, f"{REPO}/relay/herdr_relay.py"],
                            env=relay_env(HERDR_EXTERNAL_PORT=EXT_PORT),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out, _ = proc.communicate(timeout=20)
    check("D1 external port without token refuses to boot", proc.returncode == 1, proc.returncode)
    check("D1 refusal names both variables",
          "HERDR_EXTERNAL_PORT" in out and "HERDR_RELAY_TOKEN" in out, out.strip())

    # HERDR_LAN_OPEN must not be a way around the external listener's token.
    proc = subprocess.Popen([PY, f"{REPO}/relay/herdr_relay.py"],
                            env=relay_env(HERDR_EXTERNAL_PORT=EXT_PORT, HERDR_LAN_OPEN="1",
                                          HERDR_ENABLE_WRITE_EXT="1"),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out, _ = proc.communicate(timeout=20)
    check("D2 lan_open does not excuse the external listener", proc.returncode == 1, proc.returncode)

    # The repealed rule still holds without the explicit opt-in.
    proc = subprocess.Popen([PY, f"{REPO}/relay/herdr_relay.py"],
                            env=relay_env(HERDR_ENABLE_WRITE_EXT="1"),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out, _ = proc.communicate(timeout=20)
    check("D3 write ext without token still refuses without lan_open", proc.returncode == 1,
          proc.returncode)
    check("D3 refusal offers the opt-in by name", "HERDR_LAN_OPEN" in out, out.strip())

    # Both listeners on one port binds the LAN socket, then fails on the external one — leaving
    # the open listener up and the authenticated one gone.
    proc = subprocess.Popen([PY, f"{REPO}/relay/herdr_relay.py"],
                            env=relay_env(HERDR_EXTERNAL_PORT=PORT, HERDR_RELAY_TOKEN=TOKEN),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out, _ = proc.communicate(timeout=20)
    check("D11 identical ports refuse to boot", proc.returncode == 1, proc.returncode)


async def lan_open_run():
    """Local mode: no token on the LAN listener, and it is fully capable."""
    proc = start_relay(HERDR_ENABLE_WRITE_EXT="1", HERDR_LAN_OPEN="1",
                       HERDR_START_AGENTS="claude")
    try:
        check("D4 open LAN listener serves without a token", http_status(PORT) == 200)
        async with connect(url(token=None)) as ws:
            seen, _ = await drain_to_agents(ws)
            types = [m["type"] for m in seen]
            check("D5 start_options reaches an unauthenticated LAN client",
                  types[:3] == ["projects", "start_options", "agents"], types)
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "start_agent", "name": "claude", "role": "architect",
                               "project_id": "charts", "placement": "new_workspace"})
            check("D6 an unauthenticated LAN client can start an agent", r.get("ok") is True, r)
    finally:
        stop_relay(proc)


async def dual_listener_run():
    """Both listeners at once, with a token set: the safety rule 5 regression."""
    proc = start_relay(HERDR_ENABLE_WRITE_EXT="1", HERDR_RELAY_TOKEN=TOKEN,
                       HERDR_EXTERNAL_PORT=EXT_PORT, HERDR_START_AGENTS="claude")
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                with socket.create_connection(("127.0.0.1", int(EXT_PORT)), timeout=0.2):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError(f"external listener never bound {EXT_PORT}")

        # The regression this whole variable split exists to prevent: adding a tunnel must not
        # be the thing that drops authentication from the port the LAN can reach.
        check("D7 LAN listener still requires the token when lan_open is unset",
              http_status(PORT) == 401, http_status(PORT))
        check("D7 LAN listener accepts the token", http_status(PORT, TOKEN) == 200)
        check("D8 external listener refuses without a token", http_status(EXT_PORT) == 401)
        check("D8 external listener refuses a wrong token", http_status(EXT_PORT, "nope") == 401)
        # Accepted, and still 404: the external listener carries the API and not the app's files,
        # so a good token gets past the gate and finds nothing to serve at `/`. Anything but 401
        # is the token being accepted; 200 here would mean the tunnel had started publishing the
        # file surface, which is the thing the split exists to prevent.
        check("D8 external listener accepts the token", http_status(EXT_PORT, TOKEN) == 404,
              http_status(EXT_PORT, TOKEN))
        check("D8 external listener still serves the API", http_status(EXT_PORT, TOKEN,
              "/api/vapid-public-key") == 200)

        # One poll loop, whatever the listener and client count.
        async with connect(f"ws://127.0.0.1:{PORT}?token={TOKEN}") as a, \
                   connect(f"ws://127.0.0.1:{EXT_PORT}?token={TOKEN}") as b:
            _, snap_a = await drain_to_agents(a)
            _, snap_b = await drain_to_agents(b)
            check("D9 both listeners see the same sessions",
                  [x["pane_id"] for x in snap_a["agents"]] == [x["pane_id"] for x in snap_b["agents"]])
            open(LOG, "w").close()
            await asyncio.sleep(4.5)          # >2 poll intervals
            polls = len(log_lines("pane list"))
            # Two hosts (local + the fake box) per tick, two ticks in the window, a little slack
            # for where the sleep lands. Two clients on two listeners must not multiply it.
            check("D9 one poll loop, not one per listener or client", polls <= 8, polls)
    finally:
        stop_relay(proc)


async def lan_bind_run():
    """HERDR_LAN_BIND narrows exposure rather than merely documenting it."""
    lan_ip = None
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 53))            # no packet sent; just picks the default route
        lan_ip = s.getsockname()[0]
    except OSError:
        pass
    finally:
        s.close()

    proc = start_relay(HERDR_LAN_OPEN="1", HERDR_LAN_BIND="127.0.0.1")
    try:
        check("D10 loopback bind still serves loopback", http_status(PORT) == 200)
        if lan_ip and lan_ip != "127.0.0.1":
            try:
                with socket.create_connection((lan_ip, int(PORT)), timeout=2):
                    check("D10 loopback bind is unreachable on the LAN address", False,
                          f"connected to {lan_ip}:{PORT}")
            except OSError:
                check("D10 loopback bind is unreachable on the LAN address", True)
        else:
            print("SKIP D10 LAN address check — no routable address")
    finally:
        stop_relay(proc)


def preflight():
    os.makedirs(f"{HERE}/logs", exist_ok=True)
    for port in (PORT, EXT_PORT):
        probe = socket.socket()
        try:
            probe.connect(("127.0.0.1", int(port)))
        except OSError:
            continue
        finally:
            probe.close()
        sys.exit(f"port {port} is in use — set HERDR_E2E_PORT to a free port (it also uses +1)")


async def terminal_run():
    """T1/T2 — shell panes are listed, readable, and (since T2) writable through send_text.

    The pure splitter is tested next door. What is exercised here is the part it cannot reach:
    the WebSocket handler and the shared pane_guard, which is where admitting a shell pane to
    known_panes opens six message types at once and where `respond` has to stay closed.
    """
    # --- flag off: the wire must not mention shells at all ---
    proc = start_relay(HERDR_RELAY_TOKEN=TOKEN)
    try:
        async with connect(url()) as ws:
            _, snap = await drain_to_agents(ws)
            check("T1 terminal mode off sends no shells key", "shells" not in snap, snap.keys())
            check("T1 terminal mode off leaves the agent list untouched",
                  len(snap["agents"]) == 5, [a["pane_id"] for a in snap["agents"]])
            r = await rpc(ws, {"type": "read_pane", "pane_id": "w9:p3", "lines": 5})
            check("T1 a shell is not addressable with the flag off",
                  r.get("message") == "unknown pane_id", r)
    finally:
        stop_relay(proc)

    # --- flag on ---
    proc = start_relay(HERDR_RELAY_TOKEN=TOKEN, HERDR_ENABLE_TERMINAL="1")
    try:
        async with connect(url()) as ws:
            _, snap = await drain_to_agents(ws)
            shells = {s["pane_id"]: s for s in snap.get("shells", [])}
            check("T1 shells arrive on the same snapshot as agents", "shells" in snap, snap.keys())
            check("T1 an ordinary shell is listed", "w9:p3" in shells, list(shells))
            check("T1 the spacer is in neither list", "w9:p2" not in shells, list(shells))
            check("T1 a shell carries no status and no agent",
                  "status" not in shells.get("w9:p3", {}) and "agent" not in shells.get("w9:p3", {}),
                  shells.get("w9:p3"))
            check("T1 an unlabelled shell is still a shell",
                  shells.get("w9:p3", {}).get("label") == "", shells.get("w9:p3"))
            check("T1 the agent list is unchanged by terminal mode",
                  len(snap["agents"]) == 5, [a["pane_id"] for a in snap["agents"]])

            # Reading is the whole of T1's value, and it goes through the same path agents use.
            open(LOG, "w").close()
            await ws.send(json.dumps({"type": "read_pane", "pane_id": "w9:p3", "lines": 5}))
            while True:
                m = json.loads(await ws.recv())
                if m["type"] == "pane_content":
                    break
            check("T1 a shell answers read_pane", m["pane_id"] == "w9:p3" and m.get("cols") == 87, m)

            r = await rpc(ws, {"type": "send_keys", "pane_id": "w9:p3", "keys": ["ctrl+c"]})
            check("T1 ctrl+c reaches a shell", r.get("ok") is True, r)
            check("T1 and reaches it as herdr spells it",
                  log_lines("pane send-keys w9:p3 ctrl+c"), log_lines("send-keys"))

            # T2 opened this one. send_text answers with no command_result, so the fake herdr log
            # is the evidence that it went through rather than being swallowed.
            open(LOG, "w").close()
            await ws.send(json.dumps({"type": "send_text", "pane_id": "w9:p3", "text": "git status"}))
            await asyncio.sleep(0.6)  # SEND_SETTLE holds the handler before it answers
            check("T2 send_text reaches a shell", log_lines("pane send-text w9:p3 git status"),
                  log_lines("send-text"))

            # The one the guard keeps shut for good: SAFE_RESPONSES is agent approval words.
            r = await rpc(ws, {"type": "respond", "pane_id": "w9:p3", "text": "yes"})
            check("T1 respond to a shell is refused",
                  r.get("message") == "respond is not available on a terminal pane", r)
            open(LOG, "w").close()
            await asyncio.sleep(0.2)
            check("T1 the respond refusal reached no herdr write",
                  not log_lines("send-text") and not log_lines("send-keys"), log_lines(""))

            # The collision. A shell ID on two hosts routes to whichever was polled last unless
            # the ambiguity set covers shells too, which is the D6 bug with a shell on one end.
            check("T1 the colliding shell is still listed", "w9:p1" in shells, list(shells))
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "read_pane", "pane_id": "w9:p1", "lines": 5})
            check("T1 a cross-host shell ID is refused",
                  r.get("message") == "ambiguous pane_id (same id on multiple hosts)", r)
            r = await rpc(ws, {"type": "send_keys", "pane_id": "w9:p1", "keys": ["ctrl+c"]})
            check("T1 and refused for keys as well",
                  r.get("message") == "ambiguous pane_id (same id on multiple hosts)", r)
            await asyncio.sleep(0.2)
            check("T1 no herdr call was made for the ambiguous shell",
                  not log_lines("w9:p1"), log_lines("w9:p1"))
    finally:
        stop_relay(proc)


async def open_terminal_run():
    """T3 — creating a shell pane, behind both gates.

    open_terminal is start_agent with the `agent start` step removed, and the two share their
    validation and their pane creation. What is checked here is the part that is *not* shared:
    both gates, the absence of an agent start in the log, and the label rule a start does not have.
    """
    # --- one gate open is not enough, either way round ---
    for env, want in [({"HERDR_ENABLE_WRITE_EXT": "1"}, "terminal mode disabled"),
                      ({"HERDR_ENABLE_TERMINAL": "1"}, "write extensions disabled")]:
        proc = start_relay(HERDR_RELAY_TOKEN=TOKEN, **env)
        try:
            async with connect(url()) as ws:
                await drain_to_agents(ws)
                open(LOG, "w").close()
                r = await rpc(ws, {"type": "open_terminal", "project_id": "charts",
                                   "placement": "new_workspace"})
                check(f"T3 refused when only one gate is open ({want})",
                      r.get("ok") is False and r.get("error") == want, r)
                await asyncio.sleep(0.2)
                check("T3 and the refusal created nothing",
                      not log_lines("workspace create"), log_lines("create"))
        finally:
            stop_relay(proc)

    # --- both gates ---
    proc = start_relay(HERDR_RELAY_TOKEN=TOKEN, HERDR_ENABLE_TERMINAL="1",
                       HERDR_ENABLE_WRITE_EXT="1")
    try:
        async with connect(url()) as ws:
            seen, _ = await drain_to_agents(ws)
            opts = next(m for m in seen if m["type"] == "start_options")
            check("T3 start_options advertises terminal mode", opts.get("terminal") is True, opts)

            open(LOG, "w").close()
            r = await rpc(ws, {"type": "open_terminal", "project_id": "charts",
                               "placement": "new_workspace", "label": "build watch"})
            check("T3 a terminal is created", r.get("ok") is True and r.get("pane_id"), r)
            check("T3 at the Project's cwd, which the client never sent",
                  log_lines("workspace create --cwd /work/charts"), log_lines("workspace create"))
            check("T3 and it is labelled", log_lines("pane rename", "build watch"),
                  log_lines("pane rename"))
            check("T3 no agent is started in it", not log_lines("agent start"), log_lines("agent"))

            # The rule a start does not need: plan_slot closes a pane wearing this label.
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "open_terminal", "project_id": "charts",
                               "placement": "new_workspace", "label": "· spacer ·"})
            check("T3 the spacer label is refused",
                  r.get("ok") is False and r.get("error") == "label is reserved", r)
            r = await rpc(ws, {"type": "open_terminal", "project_id": "charts",
                               "placement": "new_workspace", "cwd": "/etc"})
            check("T3 a client-supplied cwd is refused",
                  r.get("error") == "unexpected field(s) for new_workspace: cwd", r)
            r = await rpc(ws, {"type": "open_terminal", "project_id": "charts",
                               "placement": "new_workspace", "name": "claude", "role": "architect"})
            check("T3 agent fields are refused",
                  r.get("error") == "unexpected field(s) for new_workspace: name, role", r)
            await asyncio.sleep(0.2)
            check("T3 none of those refusals reached herdr",
                  not log_lines("workspace create"), log_lines("create"))

            # A terminal beside a terminal: the split source is a shell, which is only a legal
            # target because the relay validates open_terminal against agents *and* shells.
            open(LOG, "w").close()
            r = await rpc(ws, {"type": "open_terminal", "project_id": "charts",
                               "placement": "split", "split_from": "w9:p3"})
            check("T3 a terminal splits off another terminal", r.get("ok") is True, r)
            check("T3 and the split carries the Project's cwd",
                  log_lines("pane split w9:p3", "--cwd /work/charts"), log_lines("pane split"))
    finally:
        stop_relay(proc)


async def main():
    preflight()
    boot_gate_run()
    await gate_off_run()
    await gate_on_run()
    await failure_run()
    await naming_run()
    dual_boot_gate_run()
    await lan_open_run()
    await dual_listener_run()
    await lan_bind_run()
    await terminal_run()
    await open_terminal_run()
    print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
    sys.exit(1 if fails else 0)


asyncio.run(main())
