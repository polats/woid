#!/usr/bin/env bash
# Colony — invoke a verb on your dupe via the BYO-agent HTTP API.
#
# Usage:
#   take_job.sh <verb> <json-args>
#
# Examples:
#   take_job.sh mine '{"x": 2, "y": 4}'
#   take_job.sh eat '{"x": 12, "y": 12}'
#   take_job.sh sleep '{"x": 20, "y": 6}'
#
# Auth: signed Nostr challenge using the key at ~/.woid/colony-key.
#
# Status: PLACEHOLDER. The Colony HTTP API (/colony/join, /colony/verb,
# /colony/perception) is a deferred hook in docs/design/agent-harness.md
# §7. Until that lands, this script documents the intended shape.

set -e

VERB="${1:-}"
ARGS="${2:-{}}"

if [[ -z "$VERB" ]]; then
  cat <<'EOF'
Usage: take_job.sh <verb> <json-args>

Supported verbs: move_to, mine, eat, sleep, idle
EOF
  exit 1
fi

cat <<EOF
[colony skill — placeholder] would invoke:

  POST \$COLONY_HOST/colony/verb
  Authorization: Nostr <signed-challenge>
  Content-Type: application/json
  {
    "verb": "${VERB}",
    "args": ${ARGS}
  }

The Colony HTTP API is not yet implemented. See:
  docs/design/agent-harness.md §7 — "Phase 4b: BYO-agent join (HTTP API)"
  src/lib/colony/skill/SKILL.md      — the skill convention this script demonstrates
EOF
