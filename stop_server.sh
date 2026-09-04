#!/usr/bin/env bash
# Stop the MTE DAQ service.
#
# If a run is in progress this stops it the same way Ctrl+C always has: the
# runner is sent SIGINT, drains what is still buffered in the module, and closes
# all four files. That is why this is the right way to stop the service rather
# than kill -9.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pidfile="$here/.mte.pid"

if [[ ! -f "$pidfile" ]]; then
  echo "No PID file; it does not look like it is running." >&2
  exit 1
fi

pid="$(cat "$pidfile")"
if ! kill -0 "$pid" 2>/dev/null; then
  echo "PID $pid is gone; clearing the stale PID file."
  rm -f "$pidfile"
  exit 0
fi

kill "$pid"
# Long enough for a run to be stopped and drained on the way out.
for _ in $(seq 40); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done

if kill -0 "$pid" 2>/dev/null; then
  echo "PID $pid did not stop; sending SIGKILL." >&2
  kill -9 "$pid"
fi

rm -f "$pidfile"
echo "Stopped $pid."
