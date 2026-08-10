#!/usr/bin/env python3
"""Pane slots against the real herdr, in a throwaway workspace.

Not part of `unittest discover`: it needs a running herdr server and it creates and destroys
real panes. Run it deliberately, and after a herdr upgrade.

    .venv313/bin/python tests/e2e/e2e_pane_slots.py

What it covers that the unit tests cannot: herdr's actual geometry contract. `slot_exec`'s argv
is asserted in tests/test_slot_exec.py, but that a pane alone in a tab gets the whole area, that
a split halves it, and that closing a sibling hands the columns back are herdr's promises — and
those are exactly what a new herdr release could quietly change.

It calls slot_exec itself. A probe that reimplements what it is testing proves nothing about the
code that ships.
"""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "relay"))

import herdr_relay  # noqa: E402
from herdr_relay import slot_exec  # noqa: E402
from start_agent import SPACER_LABEL  # noqa: E402

HERDR = herdr_relay.HERDR
failures = []
created = []


def run(*args):
    p = subprocess.run([HERDR, *args], capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        print(f"  ! herdr {' '.join(args)} -> {p.stderr.strip()[:120]}")
    return p.stdout.strip()


def layout(pane_id):
    """[(pane_id, width)] for the layout holding pane_id, plus the tab's area width."""
    snap = json.loads(run("api", "snapshot"))["result"]["snapshot"]
    for L in snap.get("layouts", []):
        if pane_id in [p["pane_id"] for p in L.get("panes", [])]:
            return ([(p["pane_id"], p["rect"]["width"]) for p in L["panes"]],
                    L.get("area", {}).get("width"))
    return ([], None)


def show(tag, pane_id):
    panes, area = layout(pane_id)
    body = " | ".join(f"{i}={w}" for i, w in panes) if panes else "NOT FOUND"
    print(f"  {tag}: area={area}  {body}")
    return dict(panes)


def check(cond, msg):
    print(f"  {'PASS' if cond else 'FAIL'} {msg}")
    if not cond:
        failures.append(msg)


def labels():
    data = json.loads(run("pane", "list"))
    return {p["pane_id"]: p.get("label", "") for p in data["result"]["panes"]}


try:
    ws = json.loads(run("workspace", "create", "--label", "_slot_e2e"))["result"]
    wsid = ws["workspace"]["workspace_id"]
    created.append(wsid)
    a = ws["root_pane"]["pane_id"]
    print(f"throwaway workspace={wsid} pane={a}\n")

    print("baseline — alone in its tab, so it owns the area")
    panes = show("start", a)
    check(len(panes) == 1, "one pane")
    full = panes.get(a)
    check(bool(full), "the pane reports a width")

    print("\nnarrow — split in place, spacer beside it")
    check(slot_exec(a, "narrow") is None, "no error")
    panes = show("narrow", a)
    check(len(panes) == 2, "two panes")
    check(abs(panes.get(a, 0) - full // 2) <= 2, f"about half of {full}")
    made = [p for p in panes if p != a]
    check(labels().get(made[0]) == SPACER_LABEL, "the new pane carries the spacer label")

    print("\nnarrow again — already in the slot")
    check(slot_exec(a, "narrow") is None, "no error")
    check(len(show("narrow", a)) == 2, "still two panes — no compounding")

    print("\nwide — the spacer is closed, not stranded in a tab of its own")
    check(slot_exec(a, "wide") is None, "no error")
    panes = show("wide", a)
    check(len(panes) == 1, "one pane")
    check(panes.get(a) == full, f"back to {full}")
    check(made[0] not in labels(), "the spacer is gone, not parked elsewhere")

    print("\nwide again — already in the slot")
    check(slot_exec(a, "wide") is None, "no error")
    check(len(show("wide", a)) == 1, "one pane")

    print("\na crowded tab of shells nobody labelled — move out, close nothing")
    run("pane", "split", a, "--direction", "right")
    run("pane", "split", a, "--direction", "right")
    before = show("crowded", a)
    check(len(before) == 3, "three panes")
    others = [p for p in before if p != a]
    check(slot_exec(a, "narrow") is None, "no error")
    panes = show("narrow", a)
    check(len(panes) == 2, "two panes after leaving the crowd")
    live = labels()
    check(all(p in live for p in others), "the hand-split shells were left alone")
finally:
    for wsid in created:
        run("workspace", "close", wsid)
        print(f"\ncleaned up {wsid}")

print("\n" + ("ALL PASS" if not failures else "FAILURES: " + "; ".join(failures)))
sys.exit(1 if failures else 0)
