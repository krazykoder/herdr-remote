#!/bin/bash
# Back up everything this relay holds that cannot be regenerated.
#
# Why this exists: on 27 August a test relay wrote its fixtures over the live conversation index —
# 132 conversations, 27 named by hand — and the only reason it was recoverable is that the shared
# store keeps 200 revisions of each document. That window is about two hours at the rate the index
# actually moves. Revision history is an undo, not a backup.
#
# Takes no arguments and needs no schedule of its own: the relay runs it, every
# HERDR_BACKUP_HOURS (24), and `/ops backup` in Telegram runs one now. Deliberately not a launchd
# job or a cron line — a system-level schedule is a second thing to install, a second thing to
# remember to remove, and on macOS a permission prompt about a program the person did not start.
# The data belongs to the relay, so the schedule does too.
#
#   relay/backup-state.sh    one backup, then prune to the last HERDR_BACKUP_KEEP
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUPS="${HERDR_BACKUP_DIR:-$PROJECT_DIR/.herdr-remote/backups}"
CONFIG_DIR="${HERDR_CONFIG_DIR:-$HOME/.config/herdr-remote}"
LOG_DIR="${HERDR_LOG_DIR:-$HOME/Library/Logs/herdr-remote}"
KEEP="${HERDR_BACKUP_KEEP:-14}"
DEST="$BACKUPS/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST/config" "$DEST/logs"

# SQLite's own backup, not cp: these run in WAL mode with the relay live, and a plain copy of the
# .sqlite3 file alone is a copy missing every write still sitting in the -wal. Opened read-only so
# a backup can never be the thing that corrupts what it is backing up.
for db in state arbitration; do
    src="$PROJECT_DIR/.herdr-remote/$db.sqlite3"
    [ -f "$src" ] || continue
    sqlite3 "file:$src?mode=ro" ".backup '$DEST/$db.sqlite3'"
    sqlite3 "$DEST/$db.sqlite3" "pragma wal_checkpoint(TRUNCATE);" >/dev/null
    # The sidecars the line above just created. A backup that ships a stray -wal is one whose
    # contents depend on which files happen to travel with it.
    rm -f "$DEST/$db.sqlite3-wal" "$DEST/$db.sqlite3-shm"
done

# The arbitrator's drop boxes: the decision files themselves, which the database indexes but does
# not contain.
if [ -d "$PROJECT_DIR/.herdr-remote/arbitration" ]; then
    cp -R "$PROJECT_DIR/.herdr-remote/arbitration" "$DEST/arbitration"
fi

# Config, deliberately without secrets.env. A keystore copied nightly into a directory nobody
# thinks about is a second place to leak it from, and the one file here that is trivially
# recreated by hand is the one holding the keys. `run/` is pids, true only while they are running.
if [ -d "$CONFIG_DIR" ]; then
    ( cd "$CONFIG_DIR" && tar cf - --exclude secrets.env --exclude run . ) |
        ( cd "$DEST/config" && tar xf - )
fi

# Push subscriptions are user data — a device that has to re-subscribe is a device that stops
# getting told its agent needs it. The logs are the forensic record; today is the argument.
for f in push_subs.json audit.log relay.log; do
    if [ -f "$LOG_DIR/$f" ]; then cp -p "$LOG_DIR/$f" "$DEST/logs/"; fi
done

# Pruned by count rather than by age: a machine that was off for a month should still have its
# last fourteen backups, not none. Newest first, then everything past KEEP — BSD head has no
# negative -n, so the list is reversed instead.
ls -1d "$BACKUPS"/*/ 2>/dev/null | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -rf "$old"
done

kept=$(ls -1d "$BACKUPS"/*/ | wc -l | tr -d ' ')
echo "$(date '+%Y-%m-%d %H:%M:%S') backup -> $DEST ($(/usr/bin/du -sh "$DEST" | cut -f1 | tr -d ' '), $kept kept)"
