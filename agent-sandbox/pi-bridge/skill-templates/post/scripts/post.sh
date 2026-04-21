#!/bin/bash
# Post a message to Nostr as this character
# Usage: bash .pi/skills/post/scripts/post.sh "Your message here" [model-name]
#
# Arguments:
#   $1 — The post content (required)
#   $2 — Model name tag (optional, e.g. "gemini-2.5-flash")

set -e

CONTENT="$1"
MODEL="$2"

if [ -z "$CONTENT" ]; then
  echo "Error: No content provided"
  echo "Usage: bash .pi/skills/post/scripts/post.sh \"Your message\" [model]"
  exit 1
fi

# Find workspace root from script location (4 levels up)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

# Read pubkey from identity file
IDENTITY_FILE="$WORKSPACE_ROOT/.pi/identity"
if [ ! -f "$IDENTITY_FILE" ]; then
  echo "Error: No identity file found at $IDENTITY_FILE"
  exit 1
fi
PUBKEY=$(cat "$IDENTITY_FILE")

# Build JSON payload safely with jq, write to temp file to avoid shell expansion issues
TMPFILE=$(mktemp)
if [ -n "$MODEL" ]; then
  jq -n --arg c "$CONTENT" --arg p "$PUBKEY" --arg m "$MODEL" '{pubkey: $p, content: $c, model: $m}' > "$TMPFILE"
else
  jq -n --arg c "$CONTENT" --arg p "$PUBKEY" '{pubkey: $p, content: $c}' > "$TMPFILE"
fi

# Post to the internal endpoint (no auth needed, same container)
RESULT=$(curl -s -X POST http://localhost:3457/internal/post \
  -H "Content-Type: application/json" \
  -d @"$TMPFILE")
rm -f "$TMPFILE"

# Check result
if echo "$RESULT" | jq -e '.ok' > /dev/null 2>&1; then
  EVENT_ID=$(echo "$RESULT" | jq -r '.eventId')
  echo "Posted successfully! Event ID: $EVENT_ID"
else
  ERROR=$(echo "$RESULT" | jq -r '.error // "unknown error"')
  echo "Error posting: $ERROR"
  exit 1
fi