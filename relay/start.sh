#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$HOME/.config/herdr-remote/config.env"
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

# Load config if available
[ -f "$CONFIG_FILE" ] && source "$CONFIG_FILE"

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
        cloudflared tunnel --url "http://127.0.0.1:$TUNNEL_TARGET_PORT" 2>&1 &
        TUNNEL_PID=$!
        sleep 4

        if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
            echo "Warning: Tunnel failed to start. Relay still running locally."
            TUNNEL_PID=""
        else
            # Extract URL from cloudflared output
            TUNNEL_URL=$(grep -o 'https://[^ ]*\.trycloudflare\.com' /proc/$TUNNEL_PID/fd/1 2>/dev/null || true)
            # Fallback: check recent log output
            if [ -z "$TUNNEL_URL" ]; then
                sleep 2
                echo ""
                echo "Tunnel starting... URL will appear below:"
                echo "(If not visible, check: ps aux | grep cloudflared)"
            fi
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
