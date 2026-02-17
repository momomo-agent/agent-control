#!/bin/bash
# start-record.sh — Launch ScreenRecord.app, print PID when ready
# Usage: start-record.sh <output.mp4> [--window <name>] [--pid <pid>]
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="/tmp/agent-control-screenrecord.pid"
[ -f "$PIDFILE" ] && kill -INT "$(cat "$PIDFILE")" 2>/dev/null && sleep 1
rm -f "$PIDFILE"
"$SCRIPT_DIR/ScreenRecord.app/Contents/MacOS/ScreenRecord" "$@" > /dev/null 2>&1 &
disown
for i in $(seq 1 10); do
  sleep 0.5
  [ -f "$PIDFILE" ] && cat "$PIDFILE" && exit 0
done
echo "ERROR" >&2
exit 1
