#!/bin/bash
# Interactive setup for the ops bot (relay/herdr_ops.py).
#
# Does the parts of relay/OPS_SETUP.md that are error-prone by hand: validating the token against
# Telegram rather than a regex, discovering the chat id instead of asking you to read it off a
# screen, and writing an ops.json whose ports match what this machine actually runs — the tunnel
# pattern in ops.example.json is a guess, and a wrong one makes /health report a live tunnel as
# down.
#
# Refuses the one mistake that is silent: reusing the agent bot's token. Two long-pollers on one
# token get 409 Conflict, and the symptom is two bots that each work intermittently.
#
# Safe to re-run. An existing ops.json is never overwritten without asking, and its command
# allowlist is preserved when only the chat id changes.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.config/herdr-remote"
CONFIG_FILE="$CONFIG_DIR/config.env"
SECRETS_FILE="$CONFIG_DIR/secrets.env"
OPS_FILE="${HERDR_OPS_CONFIG:-$CONFIG_DIR/ops.json}"

mkdir -p "$CONFIG_DIR"

echo "herdr-ops setup"
echo "==============="
echo ""

# --- What this machine already runs ---

set -a
# shellcheck disable=SC1090
[ -f "$CONFIG_FILE" ] && source "$CONFIG_FILE"
# shellcheck disable=SC1090
[ -f "$SECRETS_FILE" ] && source "$SECRETS_FILE"
set +a

WS_PORT="${HERDR_RELAY_PORT:-8375}"
# The tunnel terminates on the external listener when there is one — that is start.sh's own rule,
# and the pgrep pattern has to match the argv start.sh actually used or /health lies.
TUNNEL_PORT="${HERDR_EXTERNAL_PORT:-$WS_PORT}"

# The relay should be started from the main checkout, not from whatever worktree this script lives
# in. `git worktree list` puts the main one first.
DEFAULT_ROOT="$(git -C "$SCRIPT_DIR" worktree list 2>/dev/null | head -1 | awk '{print $1}')"
[ -n "$DEFAULT_ROOT" ] || DEFAULT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ "$(uname -s)" = "Darwin" ]; then
    LOG_DIR="$HOME/Library/Logs/herdr-remote"
else
    LOG_DIR="$HOME/.local/state/herdr-remote"
fi
mkdir -p "$LOG_DIR"

echo "Detected"
echo "--------"
echo "  relay port:    $WS_PORT"
echo "  tunnel target: $TUNNEL_PORT"
echo "  repo:          $DEFAULT_ROOT"
echo "  logs:          $LOG_DIR"
echo ""
read -p "  Relay repo to restart from [$DEFAULT_ROOT]: " REPO_ROOT
REPO_ROOT="${REPO_ROOT:-$DEFAULT_ROOT}"
if [ ! -x "$REPO_ROOT/relay/start.sh" ]; then
    echo "  Error: $REPO_ROOT/relay/start.sh is not there or not executable."
    exit 1
fi
if ! grep -q 'tunnel.url' "$REPO_ROOT/relay/start.sh"; then
    echo ""
    echo "  Note: that start.sh does not record the tunnel URL yet — it predates the ops branch."
    echo "        Setup continues, but /relay url will answer 'No tunnel URL recorded' until you"
    echo "        merge feat/telegram-ops into what $REPO_ROOT has checked out."
fi

# --- Telegram ---

echo ""
echo "Telegram bot"
echo "------------"
echo "  This must be a SECOND bot, not the one herdr_telegram.py uses."
echo "  In Telegram: message @BotFather, send /newbot, and copy the token it gives you."
echo ""

telegram_api() {
    local method="$1"
    shift
    curl -fsS --max-time 20 -X POST \
        "https://api.telegram.org/bot${OPS_TOKEN}/${method}" "$@"
}

OPS_TOKEN="${HERDR_OPS_TG_TOKEN:-}"
if [ -n "$OPS_TOKEN" ]; then
    read -p "  A token is already configured. Keep it? [Y/n] " -n 1 -r
    echo
    [[ $REPLY =~ ^[Nn]$ ]] && OPS_TOKEN=""
fi

while [ -z "$OPS_TOKEN" ]; do
    read -r -p "  BotFather token: " -s OPS_TOKEN
    echo
    if [[ ! "$OPS_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]]; then
        echo "  Error: that is not a BotFather token (expected 123456:AA...)."
        OPS_TOKEN=""
    fi
done

# The 409 guard. Cheap to check here, genuinely confusing to debug later: both bots keep polling,
# each steals updates from the other, and each looks like it works about half the time.
if [ -n "${HERDR_TG_TOKEN:-}" ] && [ "$OPS_TOKEN" = "$HERDR_TG_TOKEN" ]; then
    echo ""
    echo "  Error: that is the agent bot's token (HERDR_TG_TOKEN)."
    echo "         Two processes cannot long-poll one token — Telegram answers 409 Conflict."
    echo "         Create a second bot with @BotFather and run this again."
    exit 1
fi

OPS_USERNAME="$(telegram_api getMe 2>/dev/null | python3 -c '
import json, sys
data = json.load(sys.stdin)
print((data.get("result") or {}).get("username", "") if data.get("ok") else "")
' 2>/dev/null || true)"

if [ -z "$OPS_USERNAME" ]; then
    echo "  Error: Telegram rejected that token (getMe failed)."
    exit 1
fi
echo "  [ok] Connected as @$OPS_USERNAME"

# --- Chat id ---

echo ""
echo "  Open a PRIVATE chat with @$OPS_USERNAME and send it any message."
echo "  (Private, not a group: /relay url prints a link containing HERDR_RELAY_TOKEN.)"
echo ""

discover_chat() {
    telegram_api getUpdates --data-urlencode "timeout=10" 2>/dev/null | python3 -c '
import json, sys
data = json.load(sys.stdin)
for update in reversed(data.get("result", [])):
    message = update.get("message") or update.get("channel_post") or {}
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    if chat_id is None:
        continue
    kind = str(chat.get("type", "unknown"))
    label = chat.get("username") or chat.get("first_name") or chat.get("title") or ""
    label = str(label).replace("\t", " ").replace("\n", " ")
    print("\t".join([str(chat_id), kind, label]))
    break
' 2>/dev/null || true
}

OPS_CHAT_ID=""
for attempt in $(seq 1 12); do
    FOUND="$(discover_chat)"
    if [ -n "$FOUND" ]; then
        OPS_CHAT_ID="$(printf '%s' "$FOUND" | cut -f1)"
        CHAT_TYPE="$(printf '%s' "$FOUND" | cut -f2)"
        CHAT_LABEL="$(printf '%s' "$FOUND" | cut -f3)"
        echo "  [ok] Found chat $OPS_CHAT_ID ($CHAT_TYPE${CHAT_LABEL:+, $CHAT_LABEL})"
        if [ "$CHAT_TYPE" != "private" ]; then
            echo ""
            echo "  Warning: that is a $CHAT_TYPE chat. Everyone in it can restart this machine,"
            echo "           and will see a link containing the relay token."
            read -p "  Use it anyway? [y/N] " -n 1 -r
            echo
            [[ $REPLY =~ ^[Yy]$ ]] || OPS_CHAT_ID=""
        fi
        [ -n "$OPS_CHAT_ID" ] && break
    fi
    printf '  waiting for your message… (%s/12)\r' "$attempt"
    sleep 2
done
echo ""

if [ -z "$OPS_CHAT_ID" ]; then
    echo "  No message arrived. Enter the chat id by hand instead (the bot's /whoami prints it)."
    read -p "  Chat ID: " OPS_CHAT_ID
    [[ "$OPS_CHAT_ID" =~ ^-?[0-9]+$ ]] || { echo "  Error: chat id must be a signed integer."; exit 1; }
fi

if ! telegram_api sendMessage \
        --data-urlencode "chat_id=$OPS_CHAT_ID" \
        --data-urlencode "text=herdr-ops configured. Send /help when the bot is running." \
        >/dev/null 2>&1; then
    echo "  Error: Telegram could not deliver to chat $OPS_CHAT_ID."
    exit 1
fi
echo "  [ok] Test message delivered"

# --- Registry ---

echo ""
echo "Registry"
echo "--------"

WRITE_MODE="new"
if [ -f "$OPS_FILE" ]; then
    echo "  $OPS_FILE already exists."
    echo "    [k] keep it, only set chat_ids   (your command allowlist is preserved)"
    echo "    [r] replace it with a fresh one  (a backup is kept)"
    echo "    [a] abort"
    read -p "  Choice [k/r/a]: " -n 1 -r
    echo
    case "$REPLY" in
        [Rr]) WRITE_MODE="replace" ;;
        [Aa]) echo "  Aborted."; exit 1 ;;
        *)    WRITE_MODE="patch" ;;
    esac
fi

# Written by python, not a heredoc: it produces valid JSON by construction, and patching one key of
# an existing file without disturbing the rest is not something shell should be doing.
OPS_FILE="$OPS_FILE" REPO_ROOT="$REPO_ROOT" LOG_DIR="$LOG_DIR" WS_PORT="$WS_PORT" \
TUNNEL_PORT="$TUNNEL_PORT" OPS_CHAT_ID="$OPS_CHAT_ID" WRITE_MODE="$WRITE_MODE" python3 <<'PY'
import json, os, pathlib, shutil, time

path = pathlib.Path(os.environ["OPS_FILE"])
repo = os.environ["REPO_ROOT"]
chat_id = int(os.environ["OPS_CHAT_ID"])
mode = os.environ["WRITE_MODE"]

fresh = {
    "_comment": [
        "Registry for relay/herdr_ops.py — written by relay/ops-setup.sh.",
        "Everything the ops bot can do to this machine is a row below. Nothing else is reachable.",
        "A {placeholder} must be a whole argv element; each param declares one of enum/int/re.",
    ],
    "chat_ids": [chat_id],
    "services": {
        "relay": {
            "start": ["relay/start.sh"],
            "root": repo,
            "health": {"tcp": int(os.environ["WS_PORT"])},
            "log": str(pathlib.Path(os.environ["LOG_DIR"]) / "relay.log"),
            "stream": True,
        },
        "tunnel": {
            "health": {"pgrep":
                       f"cloudflared .*--url http://127.0.0.1:{os.environ['TUNNEL_PORT']}"},
        },
    },
    "commands": {
        "df": {"argv": ["df", "-h"], "tier": "R"},
        "uptime": {"argv": ["uptime"], "tier": "R"},
        "ports": {"argv": ["lsof", "-nP",
                           f"-iTCP:{os.environ['WS_PORT']},{os.environ['TUNNEL_PORT']}",
                           "-sTCP:LISTEN"], "tier": "R"},
        "git-log": {
            "argv": ["git", "-C", "{repo}", "log", "--oneline", "-n", "{n}"],
            "params": {"repo": {"enum": [repo]}, "n": {"int": [1, 50]}},
            "tier": "R",
        },
        "git-status": {
            "argv": ["git", "-C", "{repo}", "status", "--short", "--branch"],
            "params": {"repo": {"enum": [repo]}},
            "tier": "R",
        },
    },
    "limits": {"stream_seconds": 600, "stream_bytes": 262144, "rate_per_min": 20},
}

if path.exists():
    backup = path.with_suffix(f".json.bak.{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(path, backup)
    print(f"  backup: {backup}")

if mode == "patch":
    config = json.loads(path.read_text())
    ids = [c for c in config.get("chat_ids", []) if isinstance(c, int)]
    if chat_id not in ids:
        ids.append(chat_id)
    config["chat_ids"] = ids
    path.write_text(json.dumps(config, indent=2) + "\n")
    print(f"  patched chat_ids -> {ids}")
else:
    path.write_text(json.dumps(fresh, indent=2) + "\n")
    print(f"  wrote {path}")
PY

# --- Secrets ---

# Appended to the shared secrets file rather than a file of its own, so one `source` line gives a
# shell everything. install-service.sh rewrites this file wholesale, so it carries the ops token
# through — see the HERDR_OPS_TG_TOKEN line in its heredoc.
touch "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
if grep -q '^HERDR_OPS_TG_TOKEN=' "$SECRETS_FILE"; then
    TMP="$SECRETS_FILE.tmp.$$"
    (umask 077; grep -v '^HERDR_OPS_TG_TOKEN=' "$SECRETS_FILE" > "$TMP")
    mv "$TMP" "$SECRETS_FILE"
fi
printf 'HERDR_OPS_TG_TOKEN=%s\n' "$OPS_TOKEN" >> "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"
echo "  token saved to $SECRETS_FILE (mode 0600)"

# --- Validate ---

echo ""
echo "Validating"
echo "----------"
RUNNER=""
if command -v uv >/dev/null 2>&1; then
    RUNNER="uv run"
elif [ -x "$SCRIPT_DIR/../.venv313/bin/python" ]; then
    RUNNER="$SCRIPT_DIR/../.venv313/bin/python"
else
    echo "  Neither uv nor .venv313 found — skipping the check."
fi

if [ -n "$RUNNER" ]; then
    if HERDR_OPS_CONFIG="$OPS_FILE" $RUNNER "$SCRIPT_DIR/herdr_ops.py" --check; then
        :
    else
        echo "  The registry did not validate — the message above names the key to fix."
        exit 1
    fi
fi

cat <<EOF

Done
----
Start the bot — it runs in the foreground, Ctrl-C stops it:

  set -a; source $CONFIG_FILE; source $SECRETS_FILE; set +a
  ${RUNNER:-uv run} $SCRIPT_DIR/herdr_ops.py

Sourcing secrets.env is what lets /relay url print the one-tap Open: link — that link carries
HERDR_RELAY_TOKEN, so it can only be built where the token is in the environment.

Then send @$OPS_USERNAME:  /help  ·  /health  ·  /relay url
EOF
