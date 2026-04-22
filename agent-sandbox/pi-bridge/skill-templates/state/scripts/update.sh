#!/bin/bash
# Overwrite the agent's current state blob.
# Reads pubkey from .pi/identity, POSTs {pubkey, state} to /internal/state.

set -e

CONTENT="$1"

if [ -z "$CONTENT" ]; then
  echo "Usage: bash .pi/skills/state/scripts/update.sh \"your new state\""
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"
IDENTITY_FILE="$WORKSPACE_ROOT/.pi/identity"

if [ ! -f "$IDENTITY_FILE" ]; then
  echo "Error: identity file missing at $IDENTITY_FILE"
  exit 1
fi
PUBKEY=$(cat "$IDENTITY_FILE")

TMP=$(mktemp)
jq -n --arg p "$PUBKEY" --arg s "$CONTENT" '{pubkey: $p, state: $s}' > "$TMP"
RESULT=$(curl -s -X POST http://localhost:3457/internal/state \
  -H "Content-Type: application/json" \
  -d @"$TMP")
rm -f "$TMP"

if echo "$RESULT" | jq -e '.ok' > /dev/null 2>&1; then
  echo "State updated."
else
  ERR=$(echo "$RESULT" | jq -r '.error // "unknown error"')
  echo "Error updating state: $ERR"
  exit 1
fi
