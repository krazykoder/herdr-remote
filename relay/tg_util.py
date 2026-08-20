"""The few things both Telegram bots need. Small on purpose.

`scrub` lives here rather than being copied because it is the one function whose divergence between
the two bots would be a leak: a WebSocket exception embeds the relay URL including `?token=`, and
httpx exceptions embed the bot token. One copy, two callers.
"""
import html
import secrets
import time

MAX_MESSAGE = 4096
CHUNK = 3500      # under the limit with room for the <pre> wrapper and a truncation marker


def scrub(value, *secrets_to_hide) -> str:
    """Strip secrets from anything before it is logged or sent."""
    text = str(value)
    for secret in secrets_to_hide:
        if secret:
            text = text.replace(secret, "<redacted>")
    return text


def chunks(text: str, size: int = CHUNK):
    """Split for Telegram's 4096-character limit, preferring line boundaries."""
    while len(text) > size:
        cut = text.rfind("\n", 0, size)
        if cut <= 0:
            cut = size
        yield text[:cut]
        text = text[cut:].lstrip("\n")
    if text:
        yield text


def pre(text: str) -> str:
    """Monospace block for HTML parse mode, escaped so pane output cannot inject markup."""
    return f"<pre>{html.escape(text)}</pre>"


class Confirmations:
    """Single-use, expiring tokens for the state-changing commands.

    The token travels in `callback_data`, which Telegram caps at 64 bytes — hence a short random id
    and a table here, rather than the action itself on the wire where it could be replayed or
    edited.
    """

    def __init__(self, ttl: float = 60.0):
        self.ttl = ttl
        self._pending: dict[str, tuple[float, tuple]] = {}

    def issue(self, payload: tuple) -> str:
        self._sweep()
        token = secrets.token_hex(8)
        self._pending[token] = (time.time() + self.ttl, payload)
        return token

    def redeem(self, token: str) -> tuple | None:
        self._sweep()
        entry = self._pending.pop(token, None)   # popped: single use, replay is not possible
        return entry[1] if entry else None

    def _sweep(self):
        now = time.time()
        for token in [t for t, (expiry, _) in self._pending.items() if expiry < now]:
            self._pending.pop(token, None)


class RateLimiter:
    """Token bucket per chat, so a stuck client cannot loop a restart."""

    def __init__(self, per_minute: int):
        self.per_minute = per_minute
        self._hits: dict[int, list[float]] = {}

    def check(self, chat_id: int) -> float:
        """Returns 0.0 when allowed, else the seconds to wait."""
        now = time.time()
        hits = [t for t in self._hits.get(chat_id, []) if now - t < 60]
        if len(hits) >= self.per_minute:
            self._hits[chat_id] = hits
            return round(60 - (now - hits[0]), 1)
        hits.append(now)
        self._hits[chat_id] = hits
        return 0.0
