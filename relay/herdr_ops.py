#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["python-telegram-bot>=21.0"]
# ///
"""herdr-ops — operate this machine from Telegram, without the relay.

The relay and the tunnel are how everything else reaches this host, which means they are also what
fails when nothing can reach it. The other bot (herdr_telegram.py) is a WebSocket client of the
relay, so a relay crash silences it too. This one holds no relay connection at all: Telegram long
polling is an outbound HTTPS call, so it works with the tunnel down, the port firewalled and no
public hostname — and it can restart the stack and hand back the new wss:// link.

What it may do is entirely described by ops.json (see ops_config). Process control is
ops_supervisor. This file is handlers, streaming, and the health watcher.

    HERDR_OPS_TG_TOKEN    @BotFather token — its own bot, because two pollers on one token get
                          409 Conflict, and because restarting the box does not belong in the
                          chat where agents are approved
    HERDR_OPS_TG_CHAT_ID  extra allowlisted chat, merged with ops.json's chat_ids
    HERDR_OPS_CONFIG      registry path (default ~/.config/herdr-remote/ops.json)
"""
import asyncio
import html
import logging
import os
import re
import subprocess
import sys
import time
import urllib.error
from urllib.parse import quote
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import ops_config
import ops_supervisor as sup
import tg_util
from ops_config import ConfigError

from telegram import (BotCommand, BotCommandScopeChat, BotCommandScopeDefault,
                      InlineKeyboardButton, InlineKeyboardMarkup, Update)
from telegram.constants import ParseMode
from telegram.error import RetryAfter, TelegramError
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes

logging.basicConfig(level=logging.INFO)
# httpx logs every request URL at INFO, and that URL contains the bot token.
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("herdr-ops")

TOKEN = os.environ.get("HERDR_OPS_TG_TOKEN", "")
CONFIG_DIR = Path(os.path.expanduser("~/.config/herdr-remote"))
TUNNEL_URL_FILE = CONFIG_DIR / "tunnel.url"

ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\r")
EDIT_INTERVAL = 3.0     # Telegram tolerates an edit every few seconds; below that it 429s
TAIL_LINES = 30
WATCH_INTERVAL = 60.0

CFG: ops_config.OpsConfig
ALLOWED: set[int] = set()
CONFIRM = tg_util.Confirmations()
LIMITER: tg_util.RateLimiter
LOCKS: dict[str, asyncio.Lock] = {}
STREAMS: dict[int, "Stream"] = {}


def secrets_to_hide() -> tuple:
    """Everything scrub() must never let through: the bot token and any relay/API token around."""
    return (TOKEN, *(v for k, v in os.environ.items()
                     if k.startswith("HERDR_") and k.endswith("TOKEN") and v))


def scrub(value) -> str:
    return tg_util.scrub(value, *secrets_to_hide())


# --- Replying ---

class Html(str):
    """Markup this module built and escaped itself.

    Everything else is escaped on the way out, because log lines, pane output and command stdout
    are not ours to trust. This type is the narrow exception, and the only way to say so — so it
    must never wrap anything that came from a subprocess or a file's contents.
    """


def chat_of(update_or_chat) -> int:
    return (update_or_chat.effective_chat.id if isinstance(update_or_chat, Update)
            else update_or_chat)


async def send(update_or_chat, ctx, text: str, mono: bool = False, **kwargs):
    """Every outbound message goes through here: scrubbed, then split to Telegram's limit."""
    if isinstance(text, Html):
        return await send_html(update_or_chat, ctx, text, **kwargs)
    for part in tg_util.chunks(scrub(text)):
        await ctx.bot.send_message(
            chat_id=chat_of(update_or_chat),
            text=tg_util.pre(part) if mono else html.escape(part),
            parse_mode=ParseMode.HTML, **kwargs)


async def send_html(update_or_chat, ctx, markup: Html, **kwargs):
    """Send pre-escaped markup. Not chunked: a split would land inside a tag, and every caller is
    a short card that this module composed. Preview off — the link is for tapping, not unfurling.
    """
    await ctx.bot.send_message(
        chat_id=chat_of(update_or_chat), text=scrub(markup)[:tg_util.MAX_MESSAGE],
        parse_mode=ParseMode.HTML, disable_web_page_preview=True, **kwargs)


def authorized(update: Update) -> bool:
    return bool(ALLOWED) and update.effective_chat.id in ALLOWED


async def guard(update: Update, ctx) -> bool:
    """Allowlist then rate limit. An empty allowlist refuses everything — there is no discovery
    mode here, unlike the agent bot: a process that runs binaries must not boot into an open
    state."""
    chat_id = update.effective_chat.id
    if not authorized(update):
        await send(update, ctx,
                   f"Not authorized. This chat id is {chat_id}.\n"
                   f"Add it to chat_ids in {CFG.path} and restart the bot.")
        log.warning("refused command from chat %s", chat_id)
        return False
    wait = LIMITER.check(chat_id)
    if wait:
        await send(update, ctx, f"Rate limited, try again in {wait}s.")
        return False
    return True


def lock_for(name: str) -> asyncio.Lock:
    return LOCKS.setdefault(name, asyncio.Lock())


# --- Confirmation for state-changing commands ---

def confirm_keyboard(token: str, label: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[
        InlineKeyboardButton(f"Confirm {label}", callback_data=f"y:{token}"),
        InlineKeyboardButton("Cancel", callback_data=f"n:{token}"),
    ]])


async def ask_confirm(update: Update, ctx, label: str, action):
    token = CONFIRM.issue((action, label))
    await ctx.bot.send_message(
        chat_id=update.effective_chat.id,
        text=f"Confirm: <b>{html.escape(label)}</b>\nThis expires in 60s.",
        parse_mode=ParseMode.HTML, reply_markup=confirm_keyboard(token, label))


async def on_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    if not authorized(update):
        return
    if query.data.startswith(MENU_TAP):
        await on_menu_tap(update, ctx, query.data[len(MENU_TAP):])
        return
    verdict, _, token = query.data.partition(":")
    payload = CONFIRM.redeem(token)
    if not payload:
        await query.edit_message_text("That confirmation expired.")
        return
    action, label = payload
    if verdict != "y":
        await query.edit_message_text(f"Cancelled: {label}")
        return
    await query.edit_message_text(f"Running: {label}")
    try:
        result = await action()
    except Exception as exc:                                  # noqa: BLE001 — reported, not raised
        result = f"failed: {type(exc).__name__}: {exc}"
        log.warning("action %s failed: %s", label, scrub(exc))
    await send(update.effective_chat.id, ctx, result, mono=True)


# --- Tunnel link ---

NO_TUNNEL = "No tunnel URL recorded (named mode, or the tunnel is not up)."


def tunnel_wss() -> str:
    """The recorded address as a wss:// URL, or "" if there is none."""
    if not TUNNEL_URL_FILE.exists():
        return ""
    url = TUNNEL_URL_FILE.read_text(encoding="utf-8").strip()
    return url.replace("https://", "wss://", 1) if url else ""


def tunnel_reach(wss: str) -> str:
    url = wss.replace("wss://", "https://", 1)
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            return f"http {response.status}" if response.status >= 500 else "reachable"
    except urllib.error.HTTPError as exc:
        # A 4xx is the relay answering — GET / on the API-only external listener is a 404, and
        # urlopen raises on it. Reporting that as "not answering" called a healthy tunnel dead.
        return "reachable" if exc.code < 500 else f"http {exc.code}"
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return f"not answering ({type(exc).__name__})"


def tunnel_age() -> str:
    stat = TUNNEL_URL_FILE.stat()
    return ("recorded just now" if time.time() - stat.st_mtime <= 5
            else f"recorded {sup.uptime({'started_at': stat.st_mtime})} ago")


def tunnel_status() -> str:
    """One plain line, for the monospace /health table."""
    wss = tunnel_wss()
    return f"Tunnel:  {wss}   ({tunnel_reach(wss)})" if wss else NO_TUNNEL


def tunnel_card() -> "Html":
    """What /relay_url and a finished /relay_restart answer with.

    No token. The link used to carry HERDR_RELAY_TOKEN, and scrub() redacted it on the way out —
    the link arrived broken. Sending the token for real is the wrong trade anyway: only the
    hostname rotates, the token is stable and already in the phone's localStorage, so `?relay=`
    alone is enough to reconnect and nothing in this chat is a credential.

    The address goes out as <code> — tap to copy on a phone — and the app link as a real anchor.
    """
    wss = tunnel_wss()
    if not wss:
        return Html(html.escape(NO_TUNNEL))
    app = os.environ.get("HERDR_APP_URL", "https://eagerkoder.github.io/mini/")
    link = f"{app}?relay={quote(wss, safe='')}"
    return Html(f"<b>Tunnel</b> — {html.escape(tunnel_reach(wss))}, {html.escape(tunnel_age())}\n"
                f"<code>{html.escape(wss)}</code>\n"
                f'<a href="{html.escape(link, quote=True)}">Open in the app</a>')


# --- Streaming ---

class Stream:
    """One live view per chat: a single message edited every few seconds, or appended chunks.

    Editing beats appending for a tail — the chat stays one screen instead of scrolling away. When
    Telegram pushes back with a 429 the missed frame is dropped rather than queued: the point of a
    tail is the newest lines, and a backlog of stale frames would arrive late and out of order.
    """

    def __init__(self, chat_id: int, ctx, title: str, limits: dict):
        self.chat_id = chat_id
        self.ctx = ctx
        self.title = title
        self.limits = limits
        self.buffer: list[str] = []
        self.bytes = 0
        self.message = None
        self.task: asyncio.Task | None = None
        self.proc: subprocess.Popen | None = None
        self.stop_reason: str | None = None
        self.last_render = ""

    def feed(self, text: str) -> bool:
        """Returns False once the byte cap is hit."""
        self.bytes += len(text)
        for line in ANSI.sub("", text).splitlines():
            self.buffer.append(line)
        del self.buffer[:-TAIL_LINES]
        if self.bytes >= self.limits["stream_bytes"]:
            self.stop_reason = "byte limit"
            return False
        return True

    def render(self) -> str:
        return "\n".join(self.buffer) or "(no output yet)"

    async def paint(self, force: bool = False):
        body = self.render()
        if body == self.last_render and not force:
            return
        self.last_render = body
        text = f"<b>{html.escape(self.title)}</b>\n{tg_util.pre(scrub(body)[-3500:])}"
        try:
            if self.message is None:
                self.message = await self.ctx.bot.send_message(
                    chat_id=self.chat_id, text=text, parse_mode=ParseMode.HTML)
            else:
                await self.message.edit_text(text, parse_mode=ParseMode.HTML)
        except RetryAfter as exc:
            await asyncio.sleep(float(exc.retry_after))   # drop this frame; the next one is fresher
        except TelegramError as exc:
            log.debug("paint failed: %s", scrub(exc))

    async def finish(self, reason: str):
        self.stop_reason = self.stop_reason or reason
        await self.paint(force=True)
        await self.ctx.bot.send_message(chat_id=self.chat_id,
                                        text=f"— ended: {self.stop_reason}")
        STREAMS.pop(self.chat_id, None)

    def cancel(self):
        self.stop_reason = "/stop"
        if self.proc and self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, 15)
            except (ProcessLookupError, PermissionError, OSError):
                pass
        if self.task:
            self.task.cancel()


async def run_file_tail(stream: Stream, path: str):
    """Follow a log from its current end. Reopens on rotation — an inode swap otherwise leaves the
    tail silently reading a file nothing writes to any more."""
    deadline = time.time() + stream.limits["stream_seconds"]
    handle = open(path, "r", encoding="utf-8", errors="replace")
    handle.seek(0, os.SEEK_END)
    inode = os.fstat(handle.fileno()).st_ino
    try:
        while time.time() < deadline:
            data = handle.read()
            if data and not stream.feed(data):
                break
            await stream.paint()
            try:
                if os.stat(path).st_ino != inode:
                    handle.close()
                    handle = open(path, "r", encoding="utf-8", errors="replace")
                    inode = os.fstat(handle.fileno()).st_ino
            except FileNotFoundError:
                pass
            await asyncio.sleep(EDIT_INTERVAL)
        else:
            stream.stop_reason = stream.stop_reason or "time limit"
    finally:
        handle.close()
    await stream.finish(stream.stop_reason or "time limit")


async def run_process_stream(stream: Stream, argv: list[str], cwd: str | None, timeout: int):
    """Run a `stream: true` command and tail its output as it goes."""
    stream.proc = subprocess.Popen(argv, cwd=cwd, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, bufsize=1,
                                   start_new_session=True)
    deadline = time.time() + timeout
    loop = asyncio.get_running_loop()
    last_paint = 0.0
    while True:
        line = await loop.run_in_executor(None, stream.proc.stdout.readline)
        if not line:
            break
        if not stream.feed(line):
            break
        if time.time() - last_paint >= EDIT_INTERVAL:
            await stream.paint()
            last_paint = time.time()
        if time.time() > deadline:
            stream.stop_reason = f"timed out after {timeout}s (killed)"
            break
    if stream.proc.poll() is None:
        try:
            os.killpg(stream.proc.pid, 15)
        except (ProcessLookupError, PermissionError, OSError):
            pass
    code = stream.proc.wait()
    await stream.finish(stream.stop_reason or f"process exited {code}")


async def begin_stream(update: Update, ctx, title: str, runner):
    chat_id = update.effective_chat.id
    existing = STREAMS.get(chat_id)
    if existing:
        existing.cancel()
        await send(update, ctx, "Replaced the stream that was already running here.")
    stream = Stream(chat_id, ctx, title, CFG.limits)
    STREAMS[chat_id] = stream
    stream.task = asyncio.create_task(runner(stream))


# --- Commands ---

# --- The native command menu ---

# Telegram's own rules for a command name: lowercase letters, digits and underscores, 1–32 chars.
# A registry name may contain a hyphen (`git-log`), which is legal in ops.json and illegal here.
TG_COMMAND = re.compile(r"^[a-z0-9_]{1,32}$")
TG_MENU_MAX = 100        # Telegram's cap on commands per scope
TG_DESC_MAX = 256

# Order is the order Telegram shows them in, so the two commands worth reaching for in a hurry sit
# at the top: what is wrong, and the thing that fixes it.
BUILTIN_MENU = [
    ("health", "Services, tunnel, disk, load"),
    ("relay_restart", "Restart relay + tunnel, reply with the new link"),
    ("relay_url", "Current wss:// link and app link"),
    ("svc", "[status|start|stop|restart] <name>"),
    ("relay", "restart | url — the long form"),
    ("logs", "<name> [n] — last log lines"),
    ("tail", "<name> — follow a log live"),
    ("run", "<cmd> [args…] — an allowlisted utility"),
    ("stop", "End the active stream"),
    ("ps", "Processes this bot started"),
    ("whoami", "This chat's id"),
    ("help", "Everything this bot allows here"),
]


def menu_name(name: str) -> str:
    """`git-log` in the registry is `/git_log` in Telegram. Hyphens are not allowed in a command."""
    return name.replace("-", "_")


@dataclass(frozen=True)
class MenuPlan:
    """One pass over the registry, and everything derived from it.

    The menu, the handlers and the submenus have to agree or the phone offers commands nothing
    answers, so they are not computed separately. `handlers` is deliberately wider than `entries`:
    a grouped entry leaves the top-level menu but keeps working when typed, and so does one the
    100-command cap pushed out.
    """
    entries: list[tuple[str, str]]          # what setMyCommands publishes, in order
    handlers: dict[str, str]                # telegram command name -> registry name
    groups: dict[str, tuple[str, ...]]      # telegram group name -> member registry names
    skipped: list[str]


def describe(name: str, cmd) -> str:
    params = " ".join(f"<{p}>" for p in cmd.params)
    confirms = " (confirms)" if cmd.tier == "W" else ""
    return (f"{params} {' '.join(cmd.argv[:2])}{confirms}".strip() or name)[:TG_DESC_MAX]


def menu_plan(cfg) -> MenuPlan:
    """Build the native command list, the handler table and the submenus together.

    Registry commands become real commands — `/df`, `/git_log` — so the phone's autocomplete offers
    them and `/run` becomes the long way round rather than the only way. Anything Telegram would
    reject, or that would shadow a built-in, is skipped with a reason rather than silently dropped:
    a menu that disagrees with the handlers is worse than a shorter menu.
    """
    entries = list(BUILTIN_MENU)
    taken = {name for name, _ in entries}
    handlers: dict[str, str] = {}
    skipped: list[str] = []

    # Groups claim their names first. A group and an entry that want the same command name is a
    # collision like any other, and the group has to win: dropping it would strand every member
    # inside a submenu that no longer exists.
    groups: dict[str, list[str]] = {}
    for name, cmd in cfg.commands.items():
        if not cmd.menu:
            continue
        tg_group = menu_name(cmd.menu)
        if tg_group in groups:
            groups[tg_group].append(name)
            continue
        if not TG_COMMAND.match(tg_group):
            skipped.append(f"menu '{cmd.menu}': not a legal Telegram command name, "
                           f"members stay at the top level")
            continue
        if tg_group in taken:
            skipped.append(f"menu '{cmd.menu}': /{tg_group} is already taken, "
                           f"members stay at the top level")
            continue
        groups[tg_group] = [name]
        taken.add(tg_group)

    grouped = {name: tg_group for tg_group, names in groups.items() for name in names}

    for name, cmd in cfg.commands.items():
        tg_name = menu_name(name)
        if not TG_COMMAND.match(tg_name):
            skipped.append(f"{name}: not a legal Telegram command name")
            continue
        if tg_name in taken:
            skipped.append(f"{name}: /{tg_name} is already taken")
            continue
        # Registered whether or not it reaches the menu. The menu is autocomplete; the handler is
        # whether typing it does anything.
        handlers[tg_name] = name
        taken.add(tg_name)
        if name in grouped:
            continue
        if len(entries) >= TG_MENU_MAX:
            skipped.append(f"{name}: menu is full at {TG_MENU_MAX}")
            continue
        entries.append((tg_name, describe(name, cmd)))

    # A group whose members all collided would be a menu item opening an empty keyboard.
    live = {tg_group: tuple(n for n in names if menu_name(n) in handlers)
            for tg_group, names in groups.items()}
    live = {tg_group: names for tg_group, names in live.items() if names}
    for tg_group in groups:
        if tg_group not in live:
            skipped.append(f"menu '{tg_group}': no members survived, not offered")

    position = len(BUILTIN_MENU)
    for tg_group, names in live.items():
        entries.insert(position, (tg_group, f"{len(names)} command(s)"))
        position += 1

    return MenuPlan(entries=entries, handlers=handlers, groups=live, skipped=skipped)


def menu_entries(cfg) -> tuple[list[tuple[str, str]], list[str]]:
    """What setMyCommands needs, and why anything was left out."""
    plan = menu_plan(cfg)
    return plan.entries, plan.skipped


async def publish_menu(app: Application, entries: list[tuple[str, str]]):
    """Register the menu with Telegram, per allowlisted chat.

    Scoped rather than global: the default scope is what a stranger who finds the bot sees, and
    handing them a menu of this machine's controls tells them what to try. They would be refused,
    but the list itself is information the bot has no reason to publish.
    """
    commands = [BotCommand(name, description) for name, description in entries]
    try:
        await app.bot.delete_my_commands(scope=BotCommandScopeDefault())
        for chat_id in ALLOWED:
            await app.bot.set_my_commands(commands, scope=BotCommandScopeChat(chat_id=chat_id))
    except TelegramError as exc:
        # Not fatal: every command still works as typed text. Only autocomplete is lost.
        log.warning("could not publish the command menu: %s", scrub(exc))
        return
    log.info("published %d commands to %d chat(s)", len(commands), len(ALLOWED))


def help_text() -> str:
    services = ", ".join(CFG.services) or "(none)"
    lines = [
        "herdr-ops",
        "",
        "/health — everything at a glance",
        "/relay_restart — restart the stack, reply with the new wss:// link",
        "/relay_url — the current link, no restart",
        "/svc — list services; /svc status|start|stop|restart <name>",
        "/logs <name> [n] — last n lines (default 50, max 500)",
        "/tail <name> — follow a log live; /stop ends it",
        "/ps — processes this bot started",
        "/run <cmd> [args…] — an allowlisted utility",
        "/whoami — this chat's id",
        "",
        f"services: {services}",
        "commands:",
    ]
    plan = menu_plan(CFG)
    in_group = {name: tg_group for tg_group, members in plan.groups.items() for name in members}
    for name, cmd in CFG.commands.items():
        params = " ".join(f"<{p}>" for p in cmd.params)
        tier = " [confirms]" if cmd.tier == "W" else ""
        native = f"/{menu_name(name)}" if menu_name(name) in plan.handlers else f"/run {name}"
        # Grouped entries are off the top-level menu on purpose, so say where they went — typing
        # them still works, and nothing here should look like it disappeared.
        where = f"  (in /{in_group[name]})" if name in in_group else ""
        lines.append(f"  {native} {params}".rstrip() + tier + where)
    if not CFG.commands:
        lines.append("  (none)")
    if plan.skipped:
        lines.append("")
        lines.append("not in the menu: " + "; ".join(plan.skipped))
    return "\n".join(lines)


async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    await send(update, ctx, help_text(), mono=True)


async def cmd_whoami(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    chat_id = update.effective_chat.id
    state = "allowlisted" if chat_id in ALLOWED else "NOT allowlisted"
    await send(update, ctx, f"chat id: {chat_id}\n{state}\nconfig: {CFG.path}")


def service_line(name: str) -> str:
    svc = CFG.services[name]
    state = sup.read_state(name)
    alive = sup.running(state)
    ok, why = sup.probe(svc)
    mark = "up  " if ok else ("?   " if alive else "DOWN")
    pid = f"pid {state['pid']} up {sup.uptime(state)}" if alive else "not started by ops"
    return f"{mark} {name:<10} {why:<22} {pid}"


async def cmd_health(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    lines = [service_line(name) for name in CFG.services] or ["(no services configured)"]
    lines.append("")
    lines.append(tunnel_status())
    lines.append("")
    try:
        disk = subprocess.run(["df", "-h", "/"], capture_output=True, text=True, timeout=3)
        lines.append(disk.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, IndexError):
        pass
    load = ", ".join(f"{v:.2f}" for v in os.getloadavg())
    lines.append(f"load: {load}")
    await send(update, ctx, "\n".join(lines), mono=True)


def known(kind: str, table: dict, name: str):
    if name not in table:
        raise ValueError(f"unknown {kind} '{name}'. Known: {', '.join(table) or 'none'}")
    return table[name]


async def cmd_svc(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    args = ctx.args or []
    if not args:
        lines = [service_line(name) for name in CFG.services] or ["(no services configured)"]
        await send(update, ctx, "\n".join(lines), mono=True)
        return

    action, name = args[0], (args[1] if len(args) > 1 else "")
    if action not in ("status", "start", "stop", "restart"):
        await send(update, ctx, "usage: /svc [status|start|stop|restart] <name>")
        return
    try:
        svc = known("service", CFG.services, name)
    except ValueError as exc:
        await send(update, ctx, str(exc))
        return

    if action == "status":
        state = sup.read_state(name)
        ok, why = sup.probe(svc)
        lines = [f"{name}: {'up' if ok else 'down'} ({why})"]
        if state:
            lines.append(f"pid {state['pid']} pgid {state.get('pgid')} up {sup.uptime(state)}")
            lines.append("argv: " + " ".join(state.get("argv") or []))
        else:
            lines.append("not started by ops (no state file)")
        if svc.log and Path(svc.log).exists():
            lines.append("")
            lines.extend(tail_file(svc.log, 5))
        await send(update, ctx, "\n".join(lines), mono=True)
        return

    await ask_confirm(update, ctx, f"/svc {action} {name}",
                      lambda: service_action(svc, action))


async def service_action(svc, action: str) -> str:
    """Serialised per service: two chats racing a restart is the one way to end up with two
    relays fighting over a port."""
    async with lock_for(svc.name):
        loop = asyncio.get_running_loop()
        if svc.unit and sup.unit_name(svc):
            return await loop.run_in_executor(None, sup.unit_action, svc, action)
        if action == "start":
            state = await loop.run_in_executor(None, sup.start, svc)
            return f"{svc.name} started (pid {state['pid']})."
        if action == "stop":
            return await loop.run_in_executor(None, sup.stop, svc)
        return await loop.run_in_executor(None, sup.restart, svc)


async def relay_url_reply(update: Update, ctx):
    await send_html(update, ctx, tunnel_card())


async def relay_restart_flow(update: Update, ctx):
    """The shortcut this whole bot exists for: one menu item, one Confirm, a working link back.

    The Confirm stays even though the point is speed. It is one tap, and it now guards a command
    that sits in a scrollable menu — a mis-tap here drops the tunnel and any session on it.
    """
    try:
        svc = known("service", CFG.services, "relay")
    except ValueError as exc:
        await send(update, ctx, str(exc))
        return

    async def action_then_link():
        result = await service_action(svc, "restart")
        # The tunnel needs a moment to mint its hostname and start.sh a moment to record it. The
        # whole feature is this reply, so it is worth waiting for rather than answering "unknown".
        for _ in range(30):
            if TUNNEL_URL_FILE.exists() and TUNNEL_URL_FILE.stat().st_mtime > time.time() - 120:
                break
            await asyncio.sleep(1)
        return Html(f"{tg_util.pre(scrub(result))}\n\n{tunnel_card()}")

    await ask_confirm(update, ctx, "restart the relay + tunnel", action_then_link)


async def cmd_relay_restart(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    await relay_restart_flow(update, ctx)


async def cmd_relay_url(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    await relay_url_reply(update, ctx)


async def cmd_relay(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """`/relay restart|url`. Kept because it is what the docs say and what fingers remember; the
    menu offers `/relay_restart` and `/relay_url`, because a subcommand cannot be a menu item.

    Guards once, here — routing through the two handlers above would spend two rate-limit tokens
    for one command.
    """
    if not await guard(update, ctx):
        return
    action = (ctx.args or ["url"])[0]
    if action == "url":
        await relay_url_reply(update, ctx)
        return
    if action == "restart":
        await relay_restart_flow(update, ctx)
        return
    await send(update, ctx, "usage: /relay restart | /relay url")


def tail_file(path: str, count: int) -> list[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return [ANSI.sub("", line.rstrip("\n"))
                    for line in handle.readlines()[-count:]]
    except FileNotFoundError:
        return [f"log not found: {path}"]
    except OSError as exc:
        return [f"cannot read {path}: {exc}"]


async def cmd_logs(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    args = ctx.args or []
    if not args:
        await send(update, ctx, "usage: /logs <name> [n]")
        return
    try:
        svc = known("service", CFG.services, args[0])
    except ValueError as exc:
        await send(update, ctx, str(exc))
        return
    count = 50
    if len(args) > 1:
        if not args[1].isdigit():
            await send(update, ctx, "n must be a whole number in 1..500")
            return
        count = max(1, min(500, int(args[1])))
    if not svc.log:
        await send(update, ctx, f"{svc.name} has no log configured.")
        return
    await send(update, ctx, "\n".join(tail_file(svc.log, count)), mono=True)


async def cmd_tail(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    args = ctx.args or []
    if not args:
        await send(update, ctx, "usage: /tail <name>")
        return
    try:
        svc = known("service", CFG.services, args[0])
    except ValueError as exc:
        await send(update, ctx, str(exc))
        return
    if not svc.stream or not svc.log:
        await send(update, ctx, f"{svc.name} is not streamable (needs a log and stream: true).")
        return
    if not Path(svc.log).exists():
        await send(update, ctx, f"log not found: {svc.log}")
        return
    await begin_stream(update, ctx, f"tail {svc.name}",
                       lambda stream: run_file_tail(stream, svc.log))


async def execute_registry(update: Update, ctx, name: str, args: list[str], label: str):
    """Run one allowlisted command. Reached from `/run <name>` and from its own native command."""
    cmd = CFG.commands[name]
    try:
        argv = ops_config.build_argv(cmd, args)
    except ValueError as exc:
        await send(update, ctx, str(exc))
        return

    async def execute() -> str:
        if cmd.stream:
            await begin_stream(update, ctx, f"run {name}",
                               lambda stream: run_process_stream(stream, argv, cmd.cwd,
                                                                 cmd.timeout))
            return f"streaming {name}…"
        return await asyncio.get_running_loop().run_in_executor(None, run_once, cmd, argv)

    if cmd.tier == "W":
        await ask_confirm(update, ctx, label, execute)
        return
    await send(update, ctx, await execute(), mono=True)


async def cmd_run(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    args = ctx.args or []
    if not args:
        await send(update, ctx, "usage: /run <cmd> [args…]  — /help lists what is allowed")
        return
    name = args[0]
    if name not in CFG.commands:
        await send(update, ctx, f"'{name}' is not in the allowlist. "
                                f"/help lists what is: {', '.join(CFG.commands) or 'none'}")
        return
    await execute_registry(update, ctx, name, args[1:], f"/run {' '.join(args)}")


MENU_TAP = "m:"


def group_keyboard(members: tuple[str, ...]) -> InlineKeyboardMarkup:
    """One button per member, one per row — a phone reads a column, not a grid.

    `callback_data` is the registry name itself. It fits Telegram's 64 bytes (a name is at most 32
    characters), and unlike a confirmation token it has to stay redeemable: scrolling back to an
    older submenu and tapping it again is ordinary use, not a replay. The payload is only ever used
    as a dictionary key, so a stale or forged one finds nothing and runs nothing.
    """
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(CFG.commands[name].label or name, callback_data=f"{MENU_TAP}{name}")]
        for name in members])


def group_handler(tg_group: str, members: tuple[str, ...]):
    """`/git` — the submenu Telegram will not give us as `/git log`."""
    async def handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        if not await guard(update, ctx):
            return
        await send_html(update, ctx, Html(f"<b>/{html.escape(tg_group)}</b>"),
                        reply_markup=group_keyboard(members))
    return handler


async def on_menu_tap(update: Update, ctx, name: str):
    """A button press is a command: same allowlist, same rate limit, same Confirm for a W tier."""
    chat_id = update.effective_chat.id
    cmd = CFG.commands.get(name)
    if cmd is None:
        await send(chat_id, ctx, "That command is no longer in the registry.")
        return
    wait = LIMITER.check(chat_id)
    if wait:
        await send(chat_id, ctx, f"Rate limited, try again in {wait}s.")
        return
    if cmd.params:
        # No text field behind a button, so there is nowhere for arguments to come from. Guessing
        # them would be worse than saying so.
        usage = " ".join(f"<{p}>" for p in cmd.params)
        await send(chat_id, ctx, f"/{menu_name(name)} {usage}\nThis one takes arguments — type it.")
        return
    await execute_registry(update, ctx, name, [], f"/{menu_name(name)}")


def registry_handler(name: str):
    """A native `/df`-style command for a registry entry. `/run df` keeps working either way."""
    async def handler(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        if not await guard(update, ctx):
            return
        args = ctx.args or []
        await execute_registry(update, ctx, name, args,
                               f"/{menu_name(name)} {' '.join(args)}".rstrip())
    return handler


def run_once(cmd, argv: list[str]) -> str:
    """One-shot execution. shell=False, always: argv came from a template, never from a string."""
    try:
        done = subprocess.run(argv, cwd=cmd.cwd, capture_output=True, text=True,
                              timeout=cmd.timeout, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return f"{cmd.name}: timed out after {cmd.timeout}s (killed)"
    except OSError as exc:
        return f"{cmd.name}: {exc}"
    output = ANSI.sub("", (done.stdout or "") + (done.stderr or "")).strip()
    cap = CFG.limits["stream_bytes"]
    if len(output) > cap:
        output = output[:cap] + f"\n… truncated at {cap} bytes"
    return f"$ {' '.join(argv)}\n{output or '(no output)'}\n[exit {done.returncode}]"


async def cmd_stop(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    stream = STREAMS.get(update.effective_chat.id)
    if not stream:
        await send(update, ctx, "No active stream.")
        return
    stream.cancel()
    await stream.finish("/stop")


async def cmd_ps(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not await guard(update, ctx):
        return
    lines = []
    for name in CFG.services:
        state = sup.read_state(name)
        if sup.running(state):
            lines.append(f"{name:<10} pid {state['pid']:<7} pgid {state.get('pgid'):<7} "
                         f"up {sup.uptime(state)}  {' '.join(state.get('argv') or [])}")
    await send(update, ctx, "\n".join(lines) or "Nothing started by ops is running.", mono=True)


# --- Health watcher ---

async def health_watcher(app: Application):
    """Report up→down and down→up, nothing else. No auto-restart: the bot tells you, you decide.

    Transition-only because a heartbeat in a chat is noise you learn to ignore, and the one message
    that matters then arrives among a hundred that did not.
    """
    was: dict[str, bool] = {}
    while True:
        await asyncio.sleep(WATCH_INTERVAL)
        for name, svc in CFG.services.items():
            ok, why = await asyncio.get_running_loop().run_in_executor(None, sup.probe, svc)
            previous = was.get(name)
            was[name] = ok
            if previous is None or previous == ok:
                continue
            text = (f"{name} is back up ({why})" if ok
                    else f"⚠️ {name} is down ({why})\n/svc restart {name}")
            for chat_id in ALLOWED:
                try:
                    await app.bot.send_message(chat_id=chat_id, text=text)
                except TelegramError as exc:
                    log.warning("alert to %s failed: %s", chat_id, scrub(exc))


# --- Entry point ---

# The handlers, next to the menu they have to satisfy. `/start` is here and not in BUILTIN_MENU:
# Telegram calls it on first contact, but it is an alias for /help and does not need a menu row.
# tests/test_ops_menu.py asserts the two agree — a menu row with no handler is a command the phone
# offers and the bot ignores.
BUILTIN_HANDLERS = (
    ("start", cmd_help), ("help", cmd_help), ("whoami", cmd_whoami), ("health", cmd_health),
    ("svc", cmd_svc), ("relay", cmd_relay), ("relay_restart", cmd_relay_restart),
    ("relay_url", cmd_relay_url), ("logs", cmd_logs), ("tail", cmd_tail), ("run", cmd_run),
    ("stop", cmd_stop), ("ps", cmd_ps),
)


def load_config_or_die() -> ops_config.OpsConfig:
    try:
        return ops_config.load()
    except ConfigError as exc:
        print(f"Config error — {exc}", file=sys.stderr)
        sys.exit(1)


def main():
    global CFG, ALLOWED, LIMITER
    CFG = load_config_or_die()
    ALLOWED = set(CFG.chat_ids)
    extra = os.environ.get("HERDR_OPS_TG_CHAT_ID", "").strip()
    if extra:
        ALLOWED |= {int(part) for part in extra.split(",") if part.strip()}
    LIMITER = tg_util.RateLimiter(CFG.limits["rate_per_min"])

    cleared = sup.reconcile(CFG.services)
    summary = (f"{len(CFG.services)} service(s), {len(CFG.commands)} command(s), "
               f"{len(ALLOWED)} allowlisted chat(s)")

    if "--check" in sys.argv:
        print(f"ok: {CFG.path} — {summary}")
        plan = menu_plan(CFG)
        print(f"menu: {' '.join('/' + name for name, _ in plan.entries)}")
        for tg_group, members in plan.groups.items():
            print(f"  /{tg_group} — {', '.join(members)}")
        for reason in plan.skipped:
            print(f"  not offered as a command — {reason} (still reachable as /run)")
        if cleared:
            print(f"cleared stale state: {', '.join(cleared)}")
        if not ALLOWED:
            print("warning: no chat_ids — every command would be refused")
        return

    if not TOKEN:
        print("Set HERDR_OPS_TG_TOKEN (from @BotFather)", file=sys.stderr)
        sys.exit(1)
    if not ALLOWED:
        log.warning("no chat_ids configured — every command will be refused until one is added")

    app = Application.builder().token(TOKEN).build()
    for name, handler in BUILTIN_HANDLERS:
        app.add_handler(CommandHandler(name, handler))

    # Every registry entry also gets its own command, so the phone offers `/df` rather than
    # `/run df`, and every group gets the `/git`-style submenu Telegram will not nest for us. One
    # plan builds the menu and these handlers, so the two cannot disagree.
    plan = menu_plan(CFG)
    for tg_name, origin in plan.handlers.items():
        app.add_handler(CommandHandler(tg_name, registry_handler(origin)))
    for tg_group, members in plan.groups.items():
        app.add_handler(CommandHandler(tg_group, group_handler(tg_group, members)))
    for reason in plan.skipped:
        log.warning("not offered as a command — %s (still reachable as /run)", reason)
    entries = plan.entries

    app.add_handler(CallbackQueryHandler(on_callback))

    log.info("herdr-ops ready — %s", summary)

    async def run():
        async with app:
            await app.start()
            try:
                await publish_menu(app, entries)
                await app.updater.start_polling()
                await health_watcher(app)
            finally:
                # Ctrl-C reaches here as CancelledError, and `async with app` on its way out calls
                # only shutdown() — which refuses while the Application is still running. So the
                # last thing a kill printed was `RuntimeError: This Application is still running!`
                # stacked on top of the cancellation, as if something had gone wrong. Wind the
                # two halves down in order first, and the exit is quiet.
                if app.updater.running:
                    await app.updater.stop()
                if app.running:
                    await app.stop()

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
    log.info("herdr-ops stopped")


if __name__ == "__main__":
    main()
