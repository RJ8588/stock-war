#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PORT=4173
HOST=0.0.0.0
LOG_DIR=".data"
LOG_FILE="$LOG_DIR/stock-war.log"
PID_FILE="$LOG_DIR/stock-war.pid"

mkdir -p "$LOG_DIR"

cleanup_stale_port() {
  local pids=()

  if command -v ss >/dev/null 2>&1; then
    while read -r pid; do
      [ -n "$pid" ] && pids+=("$pid")
    done < <(ss -lntp 2>/dev/null | awk -v port=":${PORT}" '$4 ~ port { print $NF }' | sed -E 's/.*pid=([0-9]+).*/\1/' | sort -u)
  fi

  if [ "${#pids[@]}" -gt 0 ]; then
    echo "Cleaning stale process(es) on port ${PORT}: ${pids[*]}"
    kill "${pids[@]}" 2>/dev/null || true
    sleep 1
  fi
}

start_server() {
  if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    echo "stock-war is already running on http://127.0.0.1:${PORT}/"
    return 0
  fi

  cleanup_stale_port

  echo "Starting stock-war at http://127.0.0.1:${PORT}/"
  PORT="${PORT}" HOST="${HOST}" node server.js >"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  sleep 2
  if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    echo "Background server started successfully."
    return 0
  fi

  echo "Server startup failed; see ${LOG_FILE}"
  return 1
}

start_server || exit 1

while true; do
  if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    echo "stock-war is healthy on http://127.0.0.1:${PORT}/"
    sleep 10
    continue
  fi

  echo "[$(date -Iseconds)] stock-war not responding; restarting..."
  cleanup_stale_port
  start_server || true
  sleep 2

done
