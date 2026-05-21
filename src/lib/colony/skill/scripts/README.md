# scripts/

Bash invocations the skill calls to act on Colony. Each script POSTs to the Colony HTTP API with a signed Nostr challenge.

**Status: placeholder.** The Colony HTTP API (`/colony/join`, `/colony/verb`, `/colony/perception` SSE) is a deferred hook documented in [docs/design/agent-harness.md §7](../../../../../docs/design/agent-harness.md). Until it ships, these scripts print a description of what they will do once the server is live.

The skill bundle is intentionally shipped at this state — the **file convention** (Anthropic Agent Skills format + a top-level invoke script) is the artifact we want external adopters to copy. The wire transport is the next layer.

## Files

- `take_job.sh` — the canonical action entry point. Dispatches `mine`, `eat`, `sleep`, `move_to`, `idle` via one signed POST.

## When the API ships

Replace the placeholder bodies with real `curl` invocations. The signed-Nostr-challenge auth pattern is already used by `agent-sandbox/pi-bridge/` — copy from there. See [`agent-sandbox/pi-bridge/server.js`](../../../../../agent-sandbox/pi-bridge/server.js) for the existing pattern.
