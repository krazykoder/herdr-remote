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
CONFIG_DIR="$HOME/.config/herdr-remote"
CONFIG_FILE="$CONFIG_DIR/config.env"
WS_PORT="${HERDR_RELAY_PORT:-8375}"

RELAY_PID=""

cleanup() {
    STATUS=$?
    # Once. Ctrl-C fires INT, whose handler exits, which fires EXIT — so this ran twice, printing
    # the shutdown twice and sending the relay a second SIGTERM it had already acted on.
    trap - INT TERM EXIT
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
#
# `set -a`, as start.sh does: config.env is written with `export` today, and a line without one
# would otherwise set a shell variable the relay never sees — a setting that looks applied and is
# not. secrets.env is deliberately *not* sourced here; that is where the token lives, and this
# script's whole job is to run without one.
set -a
# shellcheck disable=SC1090
[ -f "$CONFIG_FILE" ] && source "$CONFIG_FILE"
set +a

# Remembered before the unset below, and used for nothing except finding a tunnel start.sh may
# have left running against it. This script must not open that port; it only cleans up after it.
CONFIGURED_EXTERNAL_PORT="${HERDR_EXTERNAL_PORT:-}"

export HERDR_LAN_OPEN=1
export HERDR_ENABLE_WRITE_EXT=1
# Terminal mode is off everywhere else and on here, because "here" is the machine you are sitting
# at. Overridable rather than hardcoded like the line above it: this one hands a shell to whoever
# reaches the port, so turning it off must not mean editing a launcher.
#   HERDR_ENABLE_TERMINAL=0 relay/start-local.sh
export HERDR_ENABLE_TERMINAL="${HERDR_ENABLE_TERMINAL:-1}"
unset HERDR_RELAY_TOKEN
unset HERDR_EXTERNAL_PORT

LAN_BIND="${HERDR_LAN_BIND:-0.0.0.0}"

# Reclaim the port from a previous run of a launcher in this repo. A holder that is not our relay
# is still a hard error — see relay/lib-ports.sh.
# shellcheck source=lib-ports.sh
. "$SCRIPT_DIR/lib-ports.sh"
reclaim_relay_port "$WS_PORT"

# No tunnel here by design, but start.sh may have left one running. Leaving it up would keep a
# public hostname alive while this script deliberately drops the token — the tunnel would answer
# 502 at best, and at worst outlive the assumption that local mode is local.
[ -n "$CONFIGURED_EXTERNAL_PORT" ] && stop_stale_tunnel "$CONFIGURED_EXTERNAL_PORT" "${HERDR_TUNNEL_NAME:-}"

echo "WARNING: $LAN_BIND:$WS_PORT has no token."
echo "         Any peer that can reach this machine can read panes, type into agents,"
echo "         and start sessions. That includes café and hotel Wi-Fi, guest VLANs,"
echo "         container bridges, and VPN peers when bound to 0.0.0.0."
if [ "$HERDR_ENABLE_TERMINAL" = "1" ]; then
echo "         Terminal mode is on, so that also means running shell commands as you."
echo "         HERDR_ENABLE_TERMINAL=0 turns it off."
fi
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
