# Shared port/process reclaim for start.sh and start-local.sh.
#
# Sourced, not executed. Lives in one file because both launchers need it and two copies of
# process-killing logic is exactly the thing that drifts apart and then kills the wrong process.
#
# The rule throughout: only ever stop something this project started. A port held by anything else
# is an error, not something to clear out of the way — "restarting my relay" must never mean
# "terminate whatever is on 8375".

# Stop a previous relay holding $1, or fail if the holder is someone else's process.
reclaim_relay_port() {
    local port="$1" pid cmd killed=""
    for pid in $(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null); do
        cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
        case "$cmd" in
            *herdr_relay.py*)
                echo "  Stopping previous relay (pid $pid)"
                kill "$pid" 2>/dev/null || true
                killed="$killed $pid"
                ;;
            *)
                echo "Error: port $port is held by a process this script did not start:"
                echo "  pid $pid: $cmd"
                echo "Stop it yourself, or point HERDR_RELAY_PORT/HERDR_EXTERNAL_PORT elsewhere."
                exit 1
                ;;
        esac
    done
    [ -n "$killed" ] || return 0

    # SIGTERM first: the relay closes its listeners and flushes its log on the way out. Escalate
    # only if it will not go, because SIGKILL leaves the port in TIME_WAIT and the next bind fails
    # for reasons that look nothing like the actual cause.
    local i
    for i in $(seq 1 20); do
        lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
        sleep 0.25
    done
    echo "  Previous relay did not exit in 5s — sending SIGKILL"
    for pid in $killed; do kill -9 "$pid" 2>/dev/null || true; done
    for i in $(seq 1 12); do
        lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || return 0
        sleep 0.25
    done
    echo "Error: port $port is still held after SIGKILL."
    exit 1
}

# Stop a quick tunnel pointed at 127.0.0.1:$1, and a named tunnel running $2 if given.
#
# Matched on the argv this script would itself have used — never on the name "cloudflared". A
# dashboard-managed connector runs with --token-file and another project's tunnel has its own
# target; neither matches, so neither is touched.
stop_stale_tunnel() {
    local target="$1" name="${2:-}" pid cmd
    for pid in $(pgrep -f cloudflared 2>/dev/null); do
        cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
        case "$cmd" in
            *"--url http://127.0.0.1:$target"*)
                echo "  Stopping previous tunnel (pid $pid)"
                kill "$pid" 2>/dev/null || true
                ;;
            *)
                [ -n "$name" ] || continue
                case "$cmd" in
                    *"run $name"*)
                        echo "  Stopping previous named tunnel $name (pid $pid)"
                        kill "$pid" 2>/dev/null || true
                        ;;
                esac
                ;;
        esac
    done
}
