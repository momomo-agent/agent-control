#!/bin/bash
# start-record.sh — Launch screen recorder via swift interpreter, print PID when ready
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="/tmp/agent-control-screenrecord.pid"
rm -f "$PIDFILE"
swift "$SCRIPT_DIR/screen-record.swift" start "$1" > /dev/null 2>&1 &
disown
# Wait up to 20s for PID file (swift interpreter compiles first)
for i in $(seq 1 40); do
  sleep 0.5
  [ -f "$PIDFILE" ] && cat "$PIDFILE" && exit 0
done
echo "ERROR" >&2
exit 1
