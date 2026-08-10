#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$HOME/.config/herdr-remote/config.env"
SECRETS_FILE="$HOME/.config/herdr-remote/secrets.env"
WS_PORT="${HERDR_RELAY_PORT:-8375}"

RELAY_PID=""
TUNNEL_PID=""

cleanup() {
    STATUS=$?
    echo ""
    echo "Shutting down..."
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null && wait "$TUNNEL_PID" 2>/dev/null
    [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null && wait "$RELAY_PID" 2>/dev/null
    echo "Done."
    exit "$STATUS"
}

trap cleanup INT TERM EXIT

echo "herdr-remote relay"
echo ""

# Load config if available. secrets.env too: install-service.sh writes HERDR_RELAY_TOKEN there and
# never into config.env, and the installed service sources both. Sourcing only one here meant the
# token was invisible to a foreground run — and with HERDR_EXTERNAL_PORT set the relay then
# refuses to boot, which is the exact combination a tunnel needs.
# `set -a` because those files are plain KEY=value; only config.env uses `export`.
set -a
# shellcheck disable=SC1090
[ -f "$CONFIG_FILE" ] && source "$CONFIG_FILE"
# shellcheck disable=SC1090
[ -f "$SECRETS_FILE" ] && source "$SECRETS_FILE"
set +a

# 1. Start relay
for port in "$WS_PORT" ${HERDR_EXTERNAL_PORT:+$HERDR_EXTERNAL_PORT}; do
    if lsof -iTCP:"$port" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
        echo "Error: port $port is already in use:"
        lsof -iTCP:"$port" -sTCP:LISTEN -n -P
        exit 1
    fi
done

echo "Starting relay on :$WS_PORT..."
uv run "$SCRIPT_DIR/herdr_relay.py" &
RELAY_PID=$!
sleep 2

if ! kill -0 "$RELAY_PID" 2>/dev/null; then
    # The relay exits non-zero on bad config (fail-closed) and on a missing token when
    # write extensions are enabled. Its own message is on stderr, directly above this.
    RELAY_STATUS=0
    wait "$RELAY_PID" 2>/dev/null || RELAY_STATUS=$?
    echo "Error: relay exited with status $RELAY_STATUS — see its output above."
    RELAY_PID=""
    exit 1
fi
echo "Relay running (pid $RELAY_PID)"

# 2. Start tunnel (if cloudflared available)
if command -v cloudflared >/dev/null 2>&1; then
    TUNNEL_MODE="${HERDR_TUNNEL_MODE:-temp}"

    if [ "$TUNNEL_MODE" = "named" ] && [ -n "$HERDR_TUNNEL_NAME" ]; then
        echo "Starting named tunnel ($HERDR_TUNNEL_NAME)..."
        CF_CONFIG="$HOME/.cloudflared/config-herdr.yml"
        if [ -f "$CF_CONFIG" ]; then
            cloudflared tunnel --config "$CF_CONFIG" run "$HERDR_TUNNEL_NAME" &
            TUNNEL_PID=$!
        else
            echo "Warning: Tunnel config not found at $CF_CONFIG"
            echo "Run install-service.sh to configure the named tunnel."
            echo "Falling back to temp tunnel..."
            TUNNEL_MODE="temp"
        fi
    fi

    # A tunnel must terminate on the token-required listener. Pointing it at the LAN port
    # publishes whatever that port's policy is — and with HERDR_LAN_OPEN=1 that is no policy
    # at all, i.e. an unauthenticated relay on the public internet.
    TUNNEL_TARGET_PORT="${HERDR_EXTERNAL_PORT:-$WS_PORT}"
    if [ -z "$HERDR_EXTERNAL_PORT" ] && [ "$HERDR_LAN_OPEN" = "1" ]; then
        echo "Error: HERDR_LAN_OPEN=1 with no HERDR_EXTERNAL_PORT — refusing to tunnel to a"
        echo "       token-free listener. Set HERDR_EXTERNAL_PORT (and HERDR_RELAY_TOKEN),"
        echo "       or use start-local.sh for LAN-only."
        exit 1
    fi

    if [ "$TUNNEL_MODE" = "temp" ]; then
        echo "Starting temp tunnel to 127.0.0.1:$TUNNEL_TARGET_PORT..."
        # To a file, not the terminal. The URL has to be read back out of it, and a temp tunnel
        # mints a new one on every start — so printing it plainly is the difference between a
        # 20-second restart and hunting through cloudflared's banner each time.
        TUNNEL_LOG="$(mktemp -t herdr-tunnel)"
        cloudflared tunnel --url "http://127.0.0.1:$TUNNEL_TARGET_PORT" > "$TUNNEL_LOG" 2>&1 &
        TUNNEL_PID=$!

        # Poll the log. The old code read /proc/$PID/fd/1, which does not exist on macOS, so the
        # URL was never found there and the fallback message was all anyone ever saw.
        TUNNEL_URL=""
        for _ in $(seq 1 40); do
            TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)"
            [ -n "$TUNNEL_URL" ] && break
            kill -0 "$TUNNEL_PID" 2>/dev/null || break
            sleep 0.5
        done

        if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
            echo "Error: tunnel exited. Last lines of $TUNNEL_LOG:"
            tail -5 "$TUNNEL_LOG"
            TUNNEL_PID=""
        elif [ -z "$TUNNEL_URL" ]; then
            echo "Warning: tunnel is up but printed no URL within 20s. Watch: tail -f $TUNNEL_LOG"
        else
            WSS_URL="${TUNNEL_URL/https:\/\//wss://}"
            ENC_URL="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$WSS_URL")"
            APP_URL="${HERDR_APP_URL:-https://eagerkoder.github.io/mini/}"
            echo ""
            echo "  Tunnel:  $WSS_URL"
            if [ -n "${HERDR_RELAY_TOKEN:-}" ]; then
                # A 64-character hex token and a hostname that changes every restart, both needing
                # to reach a phone. Typing them is the worst step in this setup, so hand over one
                # link: the app stores both and strips them from the URL.
                echo "  Open:    $APP_URL?relay=$ENC_URL&token=$HERDR_RELAY_TOKEN"
            fi

            # Optional: post the new address to a webhook, so a restart does not mean walking to
            # the laptop to read this. Discord's format; Slack wants "text" instead of "content".
            # Falls back to a plain WEBHOOK_URL already in the environment, so an existing one
            # works with no config change; the HERDR_ name wins when both are set.
            NOTIFY_HOOK="${HERDR_NOTIFY_WEBHOOK:-${WEBHOOK_URL:-}}"
            if [ -n "$NOTIFY_HOOK" ]; then
                # No token by default, and that is the point: only the hostname rotates. The token
                # is already in the phone's localStorage from the first setup, so the routine
                # message carries no credential and nothing is at risk if the channel leaks.
                # HERDR_NOTIFY_TOKEN=1 includes it, for a new device or cleared storage.
                NOTIFY_LINK="$APP_URL?relay=$ENC_URL"
                [ "${HERDR_NOTIFY_TOKEN:-}" = "1" ] && NOTIFY_LINK="$NOTIFY_LINK&token=$HERDR_RELAY_TOKEN"
                NOTIFY_BODY="$(python3 -c 'import json,sys;print(json.dumps({"content": sys.argv[1]}))' \
                    "herdr relay is up — $NOTIFY_LINK")"
                if curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
                        -d "$NOTIFY_BODY" "$NOTIFY_HOOK" >/dev/null 2>&1; then
                    echo "  Notified: webhook$([ "${HERDR_NOTIFY_TOKEN:-}" = "1" ] && echo " (with token)")"
                else
                    # Never fatal. The relay and tunnel are up; only the convenience failed.
                    echo "  Warning: webhook post failed — the URL above is still good."
                fi
            fi
            echo ""
        fi
    fi

    if [ "$TUNNEL_MODE" = "none" ]; then
        echo "Tunnel disabled (config: HERDR_TUNNEL_MODE=none)"
    fi
else
    echo "cloudflared not found — running local only."
    echo "Install: brew install cloudflared"
fi

echo ""
echo "Ready. Press Ctrl+C to stop."
echo ""

# Wait for relay (primary process)
wait "$RELAY_PID"
