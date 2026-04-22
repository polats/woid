#!/bin/bash
# Interact with the 2D room. Currently supports: move <x> <y>.
# Reads the agent's pubkey from .pi/identity and POSTs to /internal/move.

set -e

CMD="$1"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
IDENTITY_FILE="$WORKSPACE_ROOT/.pi/identity"

if [ ! -f "$IDENTITY_FILE" ]; then
  echo "Error: identity file missing at $IDENTITY_FILE"
  exit 1
fi
PUBKEY=$(cat "$IDENTITY_FILE")

case "$CMD" in
  move)
    X="$2"
    Y="$3"
    if [ -z "$X" ] || [ -z "$Y" ]; then
      echo "Usage: room.sh move <x> <y>"
      exit 1
    fi
    TMP=$(mktemp)
    jq -n --arg p "$PUBKEY" --argjson x "$X" --argjson y "$Y" \
      '{pubkey: $p, x: $x, y: $y}' > "$TMP"
    RESULT=$(curl -s -X POST http://localhost:3457/internal/move \
      -H "Content-Type: application/json" \
      -d @"$TMP")
    rm -f "$TMP"
    if echo "$RESULT" | jq -e '.ok' > /dev/null 2>&1; then
      echo "Moved to ($X, $Y)."
    else
      ERR=$(echo "$RESULT" | jq -r '.error // "unknown error"')
      echo "Error moving: $ERR"
      exit 1
    fi
    ;;
  *)
    echo "Usage: room.sh move <x> <y>"
    echo "Subcommands: move"
    exit 1
    ;;
esac
