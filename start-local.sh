#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "Starting stock-war UI at http://127.0.0.1:4173/"
echo "Press Ctrl+C to stop the server."

export PORT=4173
export HOST=127.0.0.1

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://127.0.0.1:4173/" >/dev/null 2>&1 &
fi

node server.js
