#!/usr/bin/env python3
"""E2E for the arbitration loop — T12 and T13 of the spec's test plan.

Everything under `tests/test_arbitration.py` runs with `send` and `panes` injected, which is what
makes the lifecycle testable at all but also means no test so far has watched a decision become a
keystroke. This one does: a real relay process, a real poll loop, a real `submit_paste`, and a fake
herdr whose pane list is a file the test rewrites — which is the only way to make a turn *end*, and
a turn ending is the trigger the whole feature hangs off.

Not a unittest — it spawns a relay and binds a port, so it is named to stay out of
`unittest discover`. Run it directly:

    .venv313/bin/python tests/e2e/e2e_arbitration.py

Override the port with HERDR_E2E_PORT.
"""
import asyncio, json, os, shutil, signal, socket, sqlite3, subprocess, sys, tempfile, time
from websockets.asyncio.client import connect

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PY = sys.executable
PORT = os.environ.get("HERDR_E2E_PORT", "8397")

# Three local panes with distinct fingerprints. Two members and an arbitrator, which is the only
# shape v1 runs (MEMBERS_REQUIRED = 2). Distinct cwds because (host, agent, cwd) is the identity —
# two panes sharing one would be §5.2's ambiguous pair, which is a different test.
MEMBER_1 = {"pane_id": "a1:p1", "agent": "claude", "label": "Architect 1", "agent_status": "idle",
            "cwd": "/work/one", "workspace_id": "a1", "tab_id": "a1:t1"}
MEMBER_2 = {"pane_id": "a1:p2", "agent": "codex", "label": "Reviewer 1", "agent_status": "idle",
            "cwd": "/work/two", "workspace_id": "a1", "tab_id": "a1:t2"}
ARBITER = {"pane_id": "a1:p3", "agent": "claude", "label": "Arbitrator", "agent_status": "idle",
           "cwd": "/work/arb", "workspace_id": "a1", "tab_id": "a1:t3"}

SCOPE = "Get the footer change reviewed, then stop."

fails = []
RELAY_OUT = ""
TMP = None
STATE = None
DB = None
LOG = None


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  {detail}" if not cond else ""))
    if not cond:
        fails.append(name)


# --- the fake herdr's world -----------------------------------------------------------------


def write_panes(panes):
    """Atomically, because the relay polls this file and a half-written one is a pane list with
    no panes in it — which arbitration would read as every member gone."""
    tmp = STATE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(panes, fh)
    os.replace(tmp, STATE)


def read_panes():
    with open(STATE) as fh:
        return json.load(fh)


def set_status(pane_id, status):
    panes = read_panes()
    for p in panes:
        if p["pane_id"] == pane_id:
            p["agent_status"] = status
    write_panes(panes)


async def arbitrator_answers(session_id, sequence, doc):
    """The arbitrator's whole side of the protocol: write the file, then end the turn.

    The wait is not padding. The prompt's Enter left this pane `working`, and the poll loop has to
    have *seen* that before `done` is a transition into an end state — a pane that goes done → done
    has not ended anything, and the drop-box would sit unread.
    """
    drop(session_id, sequence, doc)
    await asyncio.sleep(2.6)
    set_status(ARBITER["pane_id"], "done")


async def end_turn(pane_id):
    """Take a pane through a turn: working, then done. Both transitions have to be *seen* by the
    poll loop, so each gets more than a poll interval — the end state is only an end state
    relative to the status the loop last recorded."""
    set_status(pane_id, "working")
    await asyncio.sleep(2.6)
    set_status(pane_id, "done")


# --- the relay ------------------------------------------------------------------------------


def relay_env(**extra):
    env = dict(os.environ)
    env.update({
        "PATH": f"{HERE}/bin:" + env["PATH"],
        "HERDR_BIN": f"{HERE}/bin/herdr",
        "FAKE_LOG": LOG,
        "FAKE_PANES": STATE,
        "HERDR_RELAY_PORT": PORT,
        "HERDR_STATE_DIR": f"{TMP}/logs",
        "HERDR_ARBITER_DB": DB,
        "HERDR_CONV_LOG": "1",
        "HERDR_ENABLE_WRITE_EXT": "1",
        "HERDR_ENABLE_ARBITER": "1",
        "HERDR_LAN_OPEN": "1",
    })
    for name in ("HERDR_REMOTES", "HERDR_PROJECTS_FILE", "HERDR_RELAY_TOKEN",
                 "HERDR_EXTERNAL_PORT", "HERDR_LAN_BIND", "HERDR_ENABLE_TERMINAL"):
        env.pop(name, None)
    env.update(extra)
    return env


def start_relay(**extra):
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
    # The relay is where this feature actually runs, so its traceback is the evidence. Kept rather
    # than printed: a passing run's log is noise, and a failing one without it is a guessing game.
    global RELAY_OUT
    RELAY_OUT = proc.stdout.read()


def show_relay():
    if RELAY_OUT:
        print("\n--- relay output ---\n" + "\n".join(RELAY_OUT.splitlines()[-40:]))


def herdr_log():
    with open(LOG) as fh:
        return fh.read()


def db():
    """Read-only, and its own connection: the relay owns the file and is writing to it."""
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def rows(sql, *args):
    conn = db()
    try:
        return [dict(r) for r in conn.execute(sql, args)]
    finally:
        conn.close()


async def wait_db(sql, args=(), timeout=25):
    """Poll a query until it returns something. The loop under test runs on the relay's clock —
    a poll interval, a settle, four Enter presses — so every assertion here is eventually-true."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            found = rows(sql, *args)
        except sqlite3.Error:
            found = []
        if found:
            return found
        await asyncio.sleep(0.3)
    return []


async def wait_log(needle, timeout=15):
    """Wait for a herdr call to appear. Rows and calls are not simultaneous — a prompt is written
    down before it is delivered — so a check on the log has to wait for the delivery rather than
    assume the row implies it."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if needle in herdr_log():
            return True
        await asyncio.sleep(0.2)
    return False


async def wait_msg(ws, kind, pred=lambda m: True, timeout=25):
    """Next message of a type that satisfies `pred`, or None. The socket also carries an `agents`
    broadcast every poll, so filtering is not optional."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            m = json.loads(await asyncio.wait_for(ws.recv(), timeout=deadline - time.monotonic()))
        except (asyncio.TimeoutError, TimeoutError):
            return None
        if m.get("type") == kind and pred(m):
            return m
    return None


async def drain_to_agents(ws):
    seen = []
    while True:
        m = json.loads(await ws.recv())
        seen.append(m)
        if m["type"] == "agents" and m["agents"]:
            return seen


def decision(session_id, sequence, **over):
    doc = {"session_id": session_id, "sequence": sequence, "gate": "review", "to": "member-2",
           "instruction": "Check the footer change on mobile.", "why": "Ready for review.",
           "ambiguity": "low", "decision_complexity": "low"}
    doc.update(over)
    return doc


def drop(session_id, sequence, doc):
    """Write the arbitrator's answer where the relay already knows to look. This is the arbitrator's
    whole side of the protocol — one file, at a path it was told, and nothing else."""
    path = os.path.join(os.path.dirname(DB), "arbitration", session_id,
                        f"{sequence:04d}-decision.json")
    with open(path, "w") as fh:
        json.dump(doc, fh)
    return path


def participant(pane, role=""):
    """What a client is allowed to say about a participant: which pane, and what the person calls
    its part. Identity — agent, cwd, label — is the relay's to read off its own snapshot, so this
    deliberately sends none of it."""
    return {"pane_id": pane["pane_id"], "role": role}


# --- the runs -------------------------------------------------------------------------------


async def gate_off_run():
    """N10: off means off. The wire is what it was, and the family is not merely refused —
    a client that never saw `arb_sessions` has no reason to send one."""
    proc = start_relay(HERDR_ENABLE_ARBITER="0")
    try:
        async with connect(f"ws://127.0.0.1:{PORT}") as ws:
            seen = await drain_to_agents(ws)
            check("A0 no arb_sessions when arbitration is off",
                  "arb_sessions" not in [m["type"] for m in seen], [m["type"] for m in seen])
            await ws.send(json.dumps({"type": "arb_start", "scope": SCOPE}))
            r = await wait_msg(ws, "error", timeout=5)
            check("A0 arb_start refused when arbitration is off",
                  r and r.get("message") == "arbitration is off", r)
    finally:
        stop_relay(proc)


def boot_gate_run():
    """The two companions are requirements, not conveniences — and the refusal names both."""
    env = relay_env()
    env.pop("HERDR_CONV_LOG")
    proc = subprocess.Popen([PY, f"{REPO}/relay/herdr_relay.py"], env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    out, _ = proc.communicate(timeout=20)
    check("A0 arbitration without the record refuses to boot", proc.returncode == 1,
          proc.returncode)
    check("A0 the refusal names both variables",
          "HERDR_ENABLE_WRITE_EXT" in out and "HERDR_CONV_LOG" in out, out.strip())


async def loop_run():
    """T12 and T13, in one session, because T13 is what the loop does *next*."""
    write_panes([dict(MEMBER_1), dict(MEMBER_2), dict(ARBITER)])
    proc = start_relay()
    try:
        async with connect(f"ws://127.0.0.1:{PORT}") as ws:
            seen = await drain_to_agents(ws)
            gate = next((m for m in seen if m["type"] == "arb_sessions"), None)
            check("T12 arb_sessions is the client's gate, and arrives empty",
                  gate is not None and gate["sessions"] == [], gate)

            # --- start -----------------------------------------------------------------
            open(LOG, "w").close()
            await ws.send(json.dumps({
                "type": "arb_start", "conversation": "c-e2e", "scope": SCOPE,
                "members": [participant(MEMBER_1, "Architect"), participant(MEMBER_2, "Reviewer")],
                "arbitrator": participant(ARBITER)}))
            m = await wait_msg(ws, "arb_session")
            s = (m or {}).get("session", {})
            session_id = s.get("id")
            check("T12 the session starts active", s.get("state") == "active", m)
            check("T12 the relay assigned the id, and the client never named one",
                  bool(session_id) and session_id.startswith("s-"), session_id)
            check("T12 both members are on the roster with live panes",
                  sorted((x["id"], x["pane_id"]) for x in s.get("members", []))
                  == [("member-1", "a1:p1"), ("member-2", "a1:p2")], s.get("members"))
            # The client sent a pane id and a role and nothing else. Agent and label are on the
            # roster because the relay read them off its own pane list.
            check("T12 identity comes from the relay's snapshot, not the client's payload",
                  sorted((x["agent"], x["label"], x["role"]) for x in s.get("members", []))
                  == [("claude", "Architect 1", "Architect"),
                      ("codex", "Reviewer 1", "Reviewer")], s.get("members"))
            check("T12 the starter prompt went to the arbitrator's pane and nowhere else",
                  "pane send-text a1:p3 You are the arbitrator" in herdr_log()
                  and "pane send-text a1:p1" not in herdr_log()
                  and "pane send-text a1:p2" not in herdr_log(),
                  [l for l in herdr_log().splitlines() if "send-text" in l][:3])

            # The starter prompt's Enter left the arbitrator working, exactly as a real TUI would.
            # A person's arbitrator finishes reading and goes quiet; this is that.
            set_status("a1:p3", "idle")
            await asyncio.sleep(2.6)

            # --- T12: a member ends a turn, and the loop runs to a send ------------------
            open(LOG, "w").close()
            await end_turn("a1:p1")
            m = await wait_msg(ws, "arb_session", lambda m: m["session"]["state"] == "awaiting")
            check("T12 a member's turn end prompts the arbitrator", m is not None, m)
            check("T12 and the prompt is the one the relay wrote, naming the drop-box",
                  f"0001-decision.json" in herdr_log() and "pane send-text a1:p3" in herdr_log(),
                  [l for l in herdr_log().splitlines() if "send-text" in l][:2])
            check("T12 nothing was typed at a member while the arbitrator was thinking",
                  "pane send-text a1:p1" not in herdr_log()
                  and "pane send-text a1:p2" not in herdr_log(), herdr_log()[:400])

            open(LOG, "w").close()
            await arbitrator_answers(session_id, 1, decision(session_id, 1))

            sends = await wait_db("SELECT * FROM sends WHERE session_id=?", (session_id,))
            check("T12 the decision became a delivery, recorded", len(sends) == 1, sends)
            check("T12 to the member it named, at that member's live pane",
                  sends and sends[0]["to_member"] == "member-2"
                  and sends[0]["pane_id"] == "a1:p2", sends)
            check("T12 wearing the host's gate template, not the arbitrator's own words alone",
                  sends and sends[0]["text"].startswith("Please review the work described above.")
                  and "Check the footer change on mobile." in sends[0]["text"], sends)
            check("T12 and it reached herdr as a paste at that pane",
                  "pane send-text a1:p2" in herdr_log(),
                  [l for l in herdr_log().splitlines() if "send-text" in l][:2])

            row = rows("SELECT * FROM sessions WHERE id=?", session_id)[0]
            check("T12 one step is spent, and only one",
                  (row["steps_used"], row["consecutive"]) == (1, 1), dict(row))
            check("T12 the session is active again, not left awaiting",
                  row["state"] == "active" and row["pause_reason"] is None, dict(row))
            turns = rows("SELECT * FROM turns WHERE kind='arbitrated'")
            check("T12 N8 — the automated send is in the thread",
                  len(turns) == 1 and turns[0]["origin"] == "arbitrator"
                  and turns[0]["pane_id"] == "a1:p2", turns)

            m = await wait_msg(ws, "arb_session", lambda m: m["session"]["last_decision"])
            last = (m or {}).get("session", {}).get("last_decision") or {}
            check("T12 the strip is told what was decided and why",
                  last.get("gate") == "review" and last.get("to") == "member-2"
                  and last.get("why") == "Ready for review.", m)
            check("T12 and what the budget has left",
                  (m or {}).get("session", {}).get("budget", {}).get("steps_left") == 7, m)
            check("T12 the broadcast carries no instruction — the thread already has it",
                  "Check the footer change on mobile." not in json.dumps(m), m)

            # --- T13: a decision naming a working member ---------------------------------
            # member-2 is `working` now, because it was just handed an instruction. Naming it is
            # the mistake an arbitrator makes constantly, and N7 says it is never queued.
            open(LOG, "w").close()
            await end_turn("a1:p1")
            m = await wait_msg(ws, "arb_session", lambda m: m["session"]["state"] == "awaiting")
            check("T13 a second turn end prompts again, at the next sequence", m is not None, m)

            open(LOG, "w").close()
            await arbitrator_answers(session_id, 2, decision(session_id, 2, to="member-2"))

            bad = await wait_db(
                "SELECT * FROM decisions WHERE session_id=? AND sequence=2", (session_id,))
            check("T13 the decision is recorded as rejected, naming the code",
                  len(bad) == 1 and bad[0]["valid"] == 0
                  and bad[0]["reject_code"] == "target_working", bad)
            reprompts = await wait_db(
                "SELECT * FROM prompts WHERE session_id=? AND trigger='reprompt'", (session_id,))
            check("T13 the arbitrator is told, once, and asked to correct the same file",
                  len(reprompts) == 1
                  and "rejected: target_working" in reprompts[0]["body"],
                  [r["trigger"] for r in reprompts])
            check("T13 the re-prompt reached the arbitrator's pane",
                  await wait_log("pane send-text a1:p3"),
                  [l for l in herdr_log().splitlines() if "send-text" in l][:2])

            # Asserted last, once the rejection has run all the way to its re-prompt: "nothing was
            # typed at the busy member" is only worth anything after the point where something
            # would have been.
            check("T13 nothing was sent to the working member",
                  "pane send-text a1:p2" not in herdr_log(),
                  [l for l in herdr_log().splitlines() if "send-text" in l][:2])
            check("T13 and no delivery was recorded",
                  len(rows("SELECT * FROM sends WHERE session_id=?", session_id)) == 1)

            row = rows("SELECT * FROM sessions WHERE id=?", session_id)[0]
            check("T13 no step is spent on a rejection", row["steps_used"] == 1, dict(row))
            check("T13 and the session is still awaiting its answer",
                  row["state"] == "awaiting", dict(row))
    finally:
        stop_relay(proc)


def preflight():
    global TMP, STATE, DB, LOG
    probe = socket.socket()
    try:
        probe.connect(("127.0.0.1", int(PORT)))
    except OSError:
        pass
    else:
        sys.exit(f"port {PORT} is in use — set HERDR_E2E_PORT to a free port")
    finally:
        probe.close()
    TMP = tempfile.mkdtemp(prefix="herdr-arb-e2e-")
    STATE = f"{TMP}/panes.json"
    DB = f"{TMP}/arb/arbitration.sqlite3"
    LOG = f"{TMP}/fake_herdr.log"
    os.makedirs(f"{TMP}/logs", exist_ok=True)
    write_panes([dict(MEMBER_1), dict(MEMBER_2), dict(ARBITER)])
    open(LOG, "w").close()


async def main():
    preflight()
    try:
        boot_gate_run()
        await gate_off_run()
        await loop_run()
    except Exception:
        import traceback
        traceback.print_exc()
        fails.append("the run did not finish")
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
    if fails:
        show_relay()
    print("\n" + ("ALL PASS" if not fails else f"{len(fails)} FAILED: {fails}"))
    sys.exit(1 if fails else 0)


asyncio.run(main())
