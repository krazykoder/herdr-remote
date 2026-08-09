#!/bin/bash
# LAN-only launcher: token-free relay, no tunnel.
#
# Deliberately not a flag on start.sh. That script may launch cloudflared, and it sources the
# config file — which is where a tunnel token lives. Unsetting the token there and then starting
# a tunnel anyway is the one mistake this whole split exists to prevent.
#
#   .workflow/02_architecture/2026-08-09_dual_listener_access.md
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$HOME/.config/herdr-remote/config.env"
WS_PORT="${HERDR_RELAY_PORT:-8375}"

RELAY_PID=""

cleanup() {
    STATUS=$?
    echo ""
    echo "Shutting down..."
    [ -n "$RELAY_PID" ] && kill "$RELAY_PID" 2>/dev/null && wait "$RELAY_PID" 2>/dev/null
    echo "Done."
    exit "$STATUS"
}

trap cleanup INT TERM EXIT

echo "herdr-remote relay — local mode"
echo ""

# Config first, then override. Anything the config sets for tunnel use is dropped below.
[ -f "$CONFIG_FILE" ] && source "$CONFIG_FILE"

export HERDR_LAN_OPEN=1
export HERDR_ENABLE_WRITE_EXT=1
unset HERDR_RELAY_TOKEN
unset HERDR_EXTERNAL_PORT

LAN_BIND="${HERDR_LAN_BIND:-0.0.0.0}"

if lsof -iTCP:"$WS_PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1; then
    echo "Error: port $WS_PORT is already in use:"
    lsof -iTCP:"$WS_PORT" -sTCP:LISTEN -n -P
    exit 1
fi

echo "WARNING: $LAN_BIND:$WS_PORT has no token."
echo "         Any peer that can reach this machine can read panes, type into agents,"
echo "         and start sessions. That includes café and hotel Wi-Fi, guest VLANs,"
echo "         container bridges, and VPN peers when bound to 0.0.0.0."
echo "         Set HERDR_LAN_BIND to one interface address to narrow it."
echo ""

echo "Starting relay on $LAN_BIND:$WS_PORT..."
uv run "$SCRIPT_DIR/herdr_relay.py" &
RELAY_PID=$!
sleep 2

if ! kill -0 "$RELAY_PID" 2>/dev/null; then
    # The relay exits non-zero on bad config (fail-closed). Its message is on stderr above.
    RELAY_STATUS=0
    wait "$RELAY_PID" 2>/dev/null || RELAY_STATUS=$?
    echo "Error: relay exited with status $RELAY_STATUS — see its output above."
    RELAY_PID=""
    exit 1
fi
echo "Relay running (pid $RELAY_PID)"
echo ""
echo "  http://127.0.0.1:$WS_PORT"
for ip in $(ipconfig getiflist 2>/dev/null | tr ' ' '\n' | while read -r i; do
                ipconfig getifaddr "$i" 2>/dev/null; done); do
    echo "  http://$ip:$WS_PORT"
done
echo ""
echo "No tunnel. Press Ctrl+C to stop."
echo ""

wait "$RELAY_PID"
