#!/usr/bin/env python3
"""Start session: validate a start_agent request and build its herdr command arguments.

Pure module — no I/O, no subprocess, no relay state. Everything that decides *whether* a
start is allowed lives here so it is testable without herdr.
See .workflow/03_specs/2026-08-08_start_agent_spec.md
"""
import random
import re

from projects import ambiguous_pane_ids, resolve_workspace_remote

ROLES = ("architect", "reviewer", "agent")
# Collision suffix: "-XBEOE". Random rather than a counter because the taken set is a snapshot —
# two starts inside one poll interval both read it before either lands. I and O are out so a
# name read off a phone screen is not retyped as 1 or 0.
SUFFIX_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
SUFFIX_LEN = 5
# herdr's own rule for an agent name, enforced before it even looks at the pane:
# "must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_'".
# Pane labels are not bound by this — "Architect 1" is a fine label and an illegal agent name.
HERDR_AGENT_NAME_RE = re.compile(r"^[a-z][a-z0-9_-]{0,31}$")
DEFAULT_START_AGENTS = ["codex", "claude", "pi", "agy", "kiro", "opencode"]
# Extra argv a kind needs to come up usable, passed through herdr's `-- [AGENT_ARG]...`. Server
# side and per kind, never from a client — a client that could name argv could name any argv.
#
# agy prompts for permission on every tool call in its own UI, and that UI is not herdr's
# approval prompt, so the relay cannot see it or answer it. Left interactive, a remotely started
# agy stalls on the first command with nothing to relay. Started this way it asks nothing, which
# is the same trade the operator makes running `agy --dangerously-skip-permissions` by hand.
AGENT_ARGS = {"agy": ("--dangerously-skip-permissions",)}
# The same problem, for a kind that has no flag for it. kiro asks before every tool call and its
# own UI is not herdr's approval prompt, so a remotely started kiro stalls on the first command
# with nothing to relay — but the answer is a slash command rather than argv, and it can only be
# typed once the TUI is up. Sent by the relay after `agent start` reports the agent ready, server
# side and per kind for the same reason AGENT_ARGS is: a client that could name the first prompt
# could name any first prompt.
AGENT_INIT = {"kiro": ("/tools trust-all",)}
# What a cold agent is asked before it is asked to work, and which kinds are asked it at start.
#
# A first prompt into an agent that has been sitting idle — and a pane that has just come up is as
# cold as an agent gets — is often answered with nothing at all: the harness wakes, redraws, and
# the turn ends with no reply. agy does that reliably enough to have been arbitration's default
# since it existed; this is the same line, sent at every agy start rather than only inside a
# session. Its own message, before whatever the pane is opened with, so the reply that is nothing
# belongs to a question that was asking for nothing.
WARMUP_TEXT = ("Hi — are you ready for work? I will send you instructions shortly. "
               "Reply with one short line and do nothing else.")
AGENT_WAKE = {"agy": (WARMUP_TEXT,)}
# Argv that turns a harness's own approval prompts off, asked for per start rather than baked into
# the kind the way AGENT_ARGS is. The flag differs per harness and both are the vendor's own; what
# the client sends is `unattended`, and which argv that becomes is decided here — a client that
# could name argv could name any argv.
#
# This is a real grant: an agent started this way runs tools without asking. It is the same trade
# the operator makes typing the flag themselves, and it is available only where starting agents is
# already allowed (HERDR_ENABLE_WRITE_EXT). Asked for at a kind with no entry here, the start is
# refused rather than quietly started interactive — a session that ignored it would sit on its
# first tool call with nobody to answer it.
UNATTENDED_ARGS = {
    "claude": ("--dangerously-skip-permissions",),
    "codex": ("--dangerously-bypass-approvals-and-sandbox",),
}
AGENT_NAME_RE = re.compile(r"^[a-z0-9_-]{1,32}$")
# herdr waits this long for the agent to reach interactive readiness. Explicit rather than
# left to herdr's 30s default because the relay's own subprocess timeout must exceed it —
# see START_EXEC_TIMEOUT in herdr_relay.py.
AGENT_START_TIMEOUT_MS = 30_000

PLACEMENTS = {
    "new_workspace": None,
    "new_tab": "workspace_id",
    "split": "split_from",
}
# A slot is a pane count, not a column count. herdr hands a pane the whole tab area when it is
# alone in it and divides the area evenly otherwise, so the only two widths a client can ask for
# are "alone" and "sharing with one sibling" — which land on the desktop/phone pair.
#
# Counting panes rather than columns is what makes that hold on any terminal. The area is the
# attached client's window minus herdr's sidebar and is nobody's to set here: the same two slots
# measured 139/69 and then 144/72 across a window resize, with no code involved either time.
# Anything finer would be a resize, and herdr's `pane resize` is a ratio of the area that the
# next split in that tab immediately undoes.
SLOTS = ("wide", "narrow")
# herdr has no placeholder pane — a pane is a PTY, so the thing holding the other half of a narrow
# slot is a live shell. It is labelled at creation and identified by that label alone, never by
# "has no agent": a shell the user split themselves and left a build running in has no agent
# either, and closing it to reclaim columns would be destroying their work to widen a window.
SPACER_LABEL = "· spacer ·"
# The narrow slot exists to be read on a phone: 370px ÷ (0.6 × 9px) ≈ 68.5 columns. A band and
# not a point, because both 69 and 70 read fine there — and insisting on one of them would throw
# away a column of tab area to hit it.
NARROW_SLOT_COLS = (69, 70)
# herdr's own ui.sidebar_min_width / sidebar_max_width defaults. Both are configurable, so this
# only decides whether the advisory suggests the sidebar or the terminal — never a refusal.
SIDEBAR_BOUNDS = (18, 36)
BASE_FIELDS = {"type", "name", "role", "project_id", "placement", "label", "slot", "config",
               "unattended"}
# An agent config's id. Checked for shape here and for existence in the relay, which is the only
# place that knows what the provider file authorised — this module stays free of files.
CONFIG_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
# open_terminal carries neither: there is no agent to name and no role for it to play.
OPEN_TERMINAL_FIELDS = {"type", "project_id", "placement", "label", "slot"}


class StartAgentConfigError(Exception):
    """Raised for a malformed HERDR_START_AGENTS. The relay exits non-zero on this."""


def load_start_agents(raw):
    """Parse HERDR_START_AGENTS into an ordered allowlist. Unset yields the default set.

    This allowlist is the boundary on *what* can be executed: the names are herdr agent
    kinds, passed to `agent start --kind`. herdr owns the kind enum and refuses an unknown
    one with its own message, so mirroring that enum here would only rot on each release.
    """
    if not raw or not raw.strip():
        return list(DEFAULT_START_AGENTS)
    names = []
    for part in raw.split(","):
        name = part.strip()
        if not name:
            continue
        if not AGENT_NAME_RE.match(name):
            raise StartAgentConfigError(
                f"HERDR_START_AGENTS: {name!r} must match ^[a-z0-9_-]{{1,32}}$"
            )
        if name not in names:
            names.append(name)
    if not names:
        raise StartAgentConfigError("HERDR_START_AGENTS is set but lists no agents")
    return names


def next_role_label(role, project_id, agents):
    """Return "Architect 1" — lowest unused N among live same-Project labels for this role.

    Cosmetic only. Parsing labels means two starts inside one poll interval can pick the
    same N, and a pane the user renames leaves the sequence; neither matters because no
    part of the protocol resolves a session by its label (spec §2).
    """
    prefix = role.capitalize()
    pattern = re.compile(rf"^{re.escape(prefix)} (\d+)$")
    used = set()
    for a in agents:
        if a.get("project_id") != project_id:
            continue
        m = pattern.match(a.get("label", "") or "")
        if m:
            used.add(int(m.group(1)))
    n = 1
    while n in used:
        n += 1
    return f"{prefix} {n}"


def agent_name_from_label(label, fallback):
    """Slug a pane label into a name herdr will accept as an agent name.

    The label is what a human reads off the pane — "Architect 1", "Backend". herdr's agent
    names are a separate, stricter namespace (HERDR_AGENT_NAME_RE), so the two cannot be the
    same string any more; every label carrying a space or a capital would be refused outright.
    `fallback` is the agent kind, used when a label slugs away to nothing (e.g. "___").
    """
    slug = re.sub(r"[^a-z0-9_-]+", "-", label.lower()).strip("-_")
    slug = re.sub(r"-{2,}", "-", slug).lstrip("0123456789-_")
    return (slug or fallback)[:32].rstrip("-_") or fallback


def unique_agent_name(desired, taken):
    """Return `desired`, or a suffixed variant, so a start never hits agent_name_taken.

    A herdr agent name is unique per host and `pane list` does not report it, so a name the
    relay derives from live *pane labels* can collide with an agent name that no longer matches
    its label — a user rename moves the label and leaves the name behind. The result is bounded
    to 32 characters and stays inside HERDR_AGENT_NAME_RE.
    """
    if desired not in taken:
        return desired
    base = desired[:32 - SUFFIX_LEN - 1].rstrip("-_")
    while True:
        candidate = f"{base}-{''.join(random.choices(SUFFIX_ALPHABET, k=SUFFIX_LEN))}"
        if candidate not in taken:
            return candidate


def _project_remote(project):
    """herdr's remote= convention: None for local, otherwise the SSH target."""
    return None if project["host"] == "local" else project["host"]


def validate_start_request(msg, projects, agents, allowed):
    """Validate a start_agent message. Returns (plan, error); exactly one is not None.

    The client supplies only name, role, project_id, placement, and one placement field.
    cwd and host come from the configured Project — never from the wire (D4).
    """
    name = msg.get("name")
    if name not in allowed:
        return None, "agent not in allowlist"

    role = msg.get("role")
    if role not in ROLES:
        return None, "unknown role"

    plan, err = _placement_plan(msg, projects, agents, BASE_FIELDS,
                                lambda project: next_role_label(role, project["id"], agents))
    if err:
        return None, err
    plan["name"] = name
    plan["role"] = role
    # Optional, and absent means the stock CLI on this machine — which is every start made before
    # agent configs existed. Only the shape is settled here; whether this id names a config the
    # provider file backs is the relay's question, and refusing it is its answer.
    config = msg.get("config") or ""
    if config and not CONFIG_ID_RE.match(config):
        return None, "bad config id"
    plan["config"] = config
    # Off unless asked for, and refused rather than dropped where the kind has no flag for it: the
    # client's checkbox and the session that comes up must agree about whether anyone is going to
    # be asked before a tool runs.
    plan["unattended"] = bool(msg.get("unattended"))
    if plan["unattended"] and name not in UNATTENDED_ARGS:
        return None, "that agent has no unattended flag"
    return plan, None


def validate_open_terminal(msg, projects, panes):
    """Validate an open_terminal message. Returns (plan, error); exactly one is not None.

    start_agent without the agent: same Projects-only cwd, same placements, same host rules —
    which is why the half that decides whether a spawn is allowed is shared rather than
    reimplemented. `panes` is agents *and* shells: a workspace holding only terminals is a
    legitimate place to open a tab, and a terminal is a legitimate pane to split off.
    """
    plan, err = _placement_plan(msg, projects, panes, OPEN_TERMINAL_FIELDS,
                                lambda project: next_role_label("terminal", project["id"], panes))
    if err:
        return None, err
    # The one rule a start does not need. plan_slot closes a pane carrying this label, so a
    # client able to set it could ask the relay to create a pane the relay will later delete.
    if plan["label"] == SPACER_LABEL:
        return None, "label is reserved"
    return plan, None


def _placement_plan(msg, projects, panes, base_fields, default_label):
    """The half of a spawn request that is the same whether or not an agent lands in it."""
    project_id = msg.get("project_id")
    project = next((p for p in projects if p["id"] == project_id), None)
    if project is None:
        return None, "unknown project_id"

    placement = msg.get("placement")
    if placement not in PLACEMENTS:
        return None, "unknown placement"

    required = PLACEMENTS[placement]
    extra = set(msg) - base_fields - ({required} if required else set())
    if extra:
        return None, f"unexpected field(s) for {placement}: {', '.join(sorted(extra))}"
    if required and not msg.get(required):
        return None, f"{required} required for {placement}"

    # The one free-text field a spawn may carry. Absent means "name it for me"; present it
    # becomes the pane label — and, for a start, the herdr agent name too — so it is bounded
    # like any other client-supplied argv element rather than trusted.
    if "label" in msg:
        label, label_err = validate_pane_label(msg["label"])
        if label_err:
            return None, label_err
    else:
        label = default_label(project)

    # Optional: absent means "whatever the placement gives you", which is what every client sent
    # before slots existed. Present, it is applied after the pane is up (spec §3) — the width the
    # phone wants is not worth failing a spawn over.
    slot = msg.get("slot")
    if slot is not None and slot not in SLOTS:
        return None, "unknown slot"

    remote = _project_remote(project)
    plan = {
        "project_id": project["id"],
        "project_label": project["label"],
        "cwd": project["cwd"],
        "remote": remote,
        "placement": placement,
        "label": label,
        "slot": slot,
    }

    if placement == "new_tab":
        workspace_id = msg["workspace_id"]
        # workspace_id is its own ID space: one distinct *host*, not one matching agent (D6).
        ws_remote, err = resolve_workspace_remote(panes, workspace_id)
        if err:
            return None, err
        if ws_remote != remote:
            return None, "workspace is not on this project's host"
        in_project = [
            a for a in panes
            if a.get("workspace_id") == workspace_id and a.get("project_id") == project["id"]
        ]
        if not in_project:
            return None, "workspace does not belong to this project"
        plan["workspace_id"] = workspace_id

    elif placement == "split":
        split_from = msg["split_from"]
        # pane_id collides independently of workspace_id, so this is the *pane* guard.
        matches = [p for p in panes if p.get("pane_id") == split_from]
        if not matches:
            return None, "unknown pane_id"
        if split_from in ambiguous_pane_ids(panes):
            return None, "ambiguous pane_id (same id on multiple hosts)"
        source = matches[0]
        if source.get("remote") != remote:
            return None, "pane is not on this project's host"
        if source.get("project_id") != project["id"]:
            return None, "pane does not belong to this project"
        plan["split_from"] = split_from

    return plan, None


def workspace_create_args(cwd, label):
    return ("workspace", "create", "--cwd", cwd, "--label", label, "--focus")


def tab_create_args(workspace_id, cwd, label):
    return ("tab", "create", "--workspace", workspace_id, "--cwd", cwd,
            "--label", label, "--focus")


def pane_split_args(pane_id, cwd):
    """Split an existing pane to the right, landing a shell at the Project's cwd.

    herdr attaches an agent to a pane that already exists, so the relay creates the pane
    itself instead of asking `agent start` to split one.
    """
    return ("pane", "split", pane_id, "--direction", "right", "--cwd", cwd, "--focus")


def pane_spacer_args(pane_id, cwd):
    """Split a pane to give it a sibling, halving its width. The sibling is a bare shell.

    Deliberately not `--focus`: the point of this pane is to occupy columns, and stealing the
    user's focus into an empty shell is the opposite of what they clicked for.
    """
    return ("pane", "split", pane_id, "--direction", "right", "--cwd", cwd)


def is_spacer(pane):
    """True only for a pane this feature created to hold columns and may therefore close.

    Both halves of the test matter. The label alone would let a user relabel any pane into
    something closable; no-agent alone would close the shell they were building in.
    """
    return not pane.get("agent") and pane.get("label") == SPACER_LABEL


def _tab_panes(panes, tab_id):
    return [p for p in panes if p.get("tab_id") == tab_id]


def free_slot(panes, workspace_id, exclude_tab=None):
    """A spacer elsewhere in this workspace whose half can be handed to another pane, or None.

    A spacer is half a slot somebody already paid for. Moving onto it costs one command and
    leaves nothing behind, where splitting would mint a *second* spacer and strand this one for
    good — which is how a workspace ends up with more idle shells than sessions.

    Same workspace only. herdr renumbers a pane that crosses workspaces (w28:p1 becomes w27:p3),
    and pane IDs are what the relay hands to clients — a move that changes one under a phone
    leaves it holding a dead id. A tab of three or more is skipped: taking a third of an area is
    not the narrow slot.
    """
    for p in panes:
        if not is_spacer(p) or p.get("workspace_id") != workspace_id:
            continue
        if exclude_tab is not None and p.get("tab_id") == exclude_tab:
            continue
        if len(_tab_panes(panes, p.get("tab_id"))) <= 2:
            return p
    return None


def pane_move_beside_args(pane_id, target):
    """Move a pane into `target`'s tab, splitting off `target`. herdr requires --tab as well.

    `--no-focus` for the same reason the spacer split has no `--focus`: this is a layout change,
    and a pane that steals focus on its way there is one the user has to click back out of.
    """
    return ("pane", "move", pane_id, "--tab", target["tab_id"], "--split", "right",
            "--target-pane", target["pane_id"], "--no-focus")


def claimable_spacer(panes, workspace_id, cwd):
    """A spacer in this workspace already sitting at `cwd`, ready to be handed an agent.

    A spacer is a shell at a prompt, which is exactly what `agent start --pane` wants — so a
    start can fill a half-width slot that already exists instead of opening a tab beside it.
    cwd has to match: herdr starts the agent in the pane's directory, and the Project's cwd is
    not something a client may talk the relay out of.
    """
    return next((p["pane_id"] for p in panes
                 if is_spacer(p) and p.get("workspace_id") == workspace_id
                 and p.get("cwd") == cwd), None)


def plan_slot(panes, pane_id, slot):
    """Return (steps, error) — the herdr commands that put `pane_id` into the requested slot.

    `panes` is a whole `pane list` for one host, *including panes with no agent* — the poll
    snapshot drops those, and they are exactly what has to be seen here. Only a pane carrying
    SPACER_LABEL may be closed. Anything else in the tab, agent or not, is somebody's: the pane
    moves out to its own tab instead, which costs them nothing.

    Pure: every step is argv, and nothing is read or run. Steps are ordered and must be applied
    in order; an empty list means the pane is already in the slot asked for. The split step is
    last so its caller can label the pane it creates.
    """
    if slot not in SLOTS:
        return None, "unknown slot"
    pane = next((p for p in panes if p.get("pane_id") == pane_id), None)
    if pane is None:
        return None, "unknown pane_id"

    siblings = [p for p in panes
                if p.get("tab_id") == pane.get("tab_id") and p.get("pane_id") != pane_id]
    spacers = [p for p in siblings if is_spacer(p)]
    only_spacers = siblings and len(spacers) == len(siblings)

    if slot == "wide":
        if not siblings:
            return [], None
        if only_spacers:
            # Closing hands the columns straight back and leaves nothing behind. Moving out would
            # widen this pane just the same, but strand a tab holding a shell nobody asked for.
            return [("pane", "close", p["pane_id"]) for p in spacers], None
        return [("pane", "move", pane_id, "--new-tab")], None

    # narrow
    if len(siblings) == 1:
        return [], None
    steps = []
    free = free_slot(panes, pane.get("workspace_id"), pane.get("tab_id"))
    if free:
        steps.append(pane_move_beside_args(pane_id, free))
        # A tab of two means the spacer's own half is the one being taken, so it goes. Alone in
        # its tab it is a spacer nothing reclaimed, and it becomes this pane's sibling instead.
        if len(_tab_panes(panes, free["tab_id"])) == 2:
            steps.append(("pane", "close", free["pane_id"]))
    elif siblings:
        # Three or more panes divide the area into thirds or worse, and splitting again only
        # makes it smaller. Leave for an empty tab first, then take half of that.
        steps.append(("pane", "move", pane_id, "--new-tab"))
    if only_spacers:
        # Whichever route was taken, the spacers left behind in the old tab hold columns for
        # nobody now. Before the split, so the split stays last for its caller to label.
        steps += [("pane", "close", p["pane_id"]) for p in spacers]
    if not free:
        steps.append(pane_spacer_args(pane_id, pane.get("cwd") or "."))
    return steps, None


def slot_advice(area, sidebar, band=NARROW_SLOT_COLS):
    """Return a one-line fix when a narrow slot falls outside `band`, or None when it fits.

    Advisory, and deliberately never an action. The tab area is the user's terminal minus herdr's
    sidebar; both are theirs, and a relay that quietly resized either would be moving furniture in
    someone else's room. Said once at boot, because a narrow slot five columns wrong looks like a
    client bug rather than a herdr setting.

    An even area splits exactly (144 gives 72|72); an odd one hands the spare column to the left
    pane (139 gives 70|69). Either pane can end up holding the agent, so *both* have to sit in the
    band — which makes the widest usable area `hi * 2`, and that is what gets suggested. Aiming at
    `lo * 2` instead would hit the band by throwing away two columns of desktop.
    """
    lo_cols, hi_cols = band
    if not area or area < 4 or not sidebar:
        return None
    narrower, wider = area // 2, -(-area // 2)
    if lo_cols <= narrower and wider <= hi_cols:
        return None
    want_area = hi_cols * 2
    want_sidebar = sidebar + area - want_area
    lo, hi = SIDEBAR_BOUNDS
    # Config first, dragging second, because config.toml calls sidebar_width a *default* and a
    # width the user has dragged is remembered in herdr's session.json — where it appears to win.
    fix = (f"set ui.sidebar_width = {want_sidebar}, or drag the sidebar there"
           if lo <= want_sidebar <= hi
           else f"resize the herdr terminal to {want_area + sidebar} cols")
    return (f"herdr tab area is {area} cols, so a narrow slot lands at {wider}|{narrower}, "
            f"outside {lo_cols}-{hi_cols}. To fix: {fix} — area {want_area} gives "
            f"{want_area // 2}|{want_area // 2} on a phone and {want_area} on a desktop. "
            f"(terminal {area + sidebar} cols, sidebar {sidebar})")


def agent_start_args(kind, label, pane_id, timeout_ms=AGENT_START_TIMEOUT_MS, unattended=False,
                     extra_args=()):
    """herdr attaches an agent to an existing pane sitting at its shell prompt.

    The positional is herdr's *agent name*, which is unique per host — passing the agent kind
    there let the first start of an agent succeed and every later one fail agent_name_taken.
    The session label goes there instead; `kind` is the allowlisted herdr agent kind.

    pane_id is always a pane the relay just created or one that passed
    validate_start_request — never a raw client value.

    `extra_args` is argv the agent config asked for — today the `--model` of a stock provider. It
    comes from agent_configs, which is the only thing on this machine allowed to name argv on a
    client's behalf, and it goes last so a config can never displace AGENT_ARGS or the unattended
    flag.
    """
    args = ("agent", "start", label, "--kind", kind, "--pane", pane_id,
            "--timeout", str(timeout_ms))
    extra = tuple(AGENT_ARGS.get(kind) or ())
    if unattended:
        extra += UNATTENDED_ARGS.get(kind, ())
    extra += tuple(extra_args)
    return args + ("--",) + extra if extra else args


def unattended_kinds():
    """The kinds that can be started without their approval prompts, for the client's Start gate."""
    return sorted(UNATTENDED_ARGS)


def agent_init_prompts(kind):
    """The lines this kind needs typed at it once it is up. Empty for every kind that needs none."""
    return list(AGENT_INIT.get(kind) or ())


def agent_wake_prompts(kind):
    """The lines this kind is woken with, before whatever it is opened with. Usually none."""
    return list(AGENT_WAKE.get(kind) or ())


def pane_rename_args(pane_id, label):
    return ("pane", "rename", pane_id, label)


def validate_pane_label(raw):
    """Return (label, error) for a client-supplied pane label.

    The label is the one piece of free text a client may put on a pane, so it is bounded here
    rather than trusted: control characters would corrupt the herdr status line and the pane
    list, and an unbounded string is an unbounded argv entry.
    """
    if not isinstance(raw, str):
        return "", "label must be a string"
    label = raw.strip()
    if not label:
        return "", "label is empty"
    if len(label) > 32:
        return "", "label is longer than 32 characters"
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in label):
        return "", "label contains control characters"
    # A start passes the label to herdr as a positional, so a leading dash would be read as a flag.
    if label.startswith("-"):
        return "", "label cannot start with '-'"
    return label, ""


def validate_start_ref(raw):
    """Return (ref, error) for the client's own id for a start.

    A start's answer names the pane it made, and that answer only exists on the socket that asked
    — reload the tab and the browser has no way to say which pane it was waiting for. So a client
    may name the start itself, and the relay carries that name on the pane for as long as it lives.

    Bounded and narrow because it is client text that ends up on every other client's snapshot:
    an opaque token, never parsed here, never shown to a user, and never passed to a shell.
    """
    if raw is None:
        return "", ""
    if not isinstance(raw, str):
        return "", "ref must be a string"
    ref = raw.strip()
    if not ref:
        return "", ""
    if len(ref) > 64:
        return "", "ref is longer than 64 characters"
    if not all(c.isalnum() or c in "-_" for c in ref):
        return "", "ref may only hold letters, digits, '-' and '_'"
    return ref, ""


def dig(data, *path):
    """Read a nested JSON path, returning "" if any hop is missing or not a dict.

    The IDs herdr returns are nested (result.workspace.workspace_id); a missing one must
    read as absent rather than raise, so the caller can report ok:false (spec §3).
    """
    cur = data
    for key in path:
        if not isinstance(cur, dict):
            return ""
        cur = cur.get(key)
    return cur if isinstance(cur, str) else ""
