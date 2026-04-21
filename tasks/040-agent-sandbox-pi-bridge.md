---
name: Port pi-bridge with post-to-relay tool
description: pi-bridge spawns pi per agent; each agent gets a post.sh skill that POSTs to /internal/post which signs and publishes to the relay
status: done
order: 40
epic: sandbox
---

Port `npc-no-more/pi-bridge/` into `agent-sandbox/pi-bridge/`, keeping the key pattern: **agents don't sign Nostr events themselves — they call a bash tool that hits an internal HTTP endpoint on the bridge, and the bridge signs on their behalf.**

See `npc-no-more/pi-bridge/skill-templates/post/` for the exact pattern.

## How it works (MVP flow)

1. User calls `POST /agents` on pi-bridge → `{ name, seedMessage?, roomId }`
2. Bridge mints an ephemeral keypair, writes `$WORKSPACE/<agentId>/.pi/identity` with the pubkey, installs the `post` skill into `$WORKSPACE/<agentId>/.pi/skills/post/`
3. Bridge spawns `pi` as a child process in that workspace, pointed at NIM via `nim-models.json`
4. Bridge joins the Colyseus room as a client on the agent's behalf (using `colyseus.js`)
5. Agent runs; when it decides to post, it calls `bash .pi/skills/post/scripts/post.sh "message"`
6. That script POSTs to `http://localhost:3457/internal/post` (reachable only inside the container)
7. Bridge looks up the keypair by workspace, signs a `kind:1` event, publishes to the relay, returns the event id to the script

## Deliverables

- `agent-sandbox/pi-bridge/Dockerfile` — `node:20-slim`, installs `@mariozechner/pi-coding-agent` globally, installs `jq` (post.sh uses it), bundles bridge code
- `agent-sandbox/pi-bridge/server.js` — HTTP API:
  - `POST /agents` → `{ name, seedMessage?, roomId }` → spawns + returns `{ agentId, npub }`
  - `GET  /agents` → list active
  - `DELETE /agents/:id` → stop pi, leave room, drop keypair
  - `POST /internal/post` → `{ pubkey, content, model? }` → signs + publishes `kind:1`, returns `{ ok, eventId }` (no outer auth — only reachable from inside the container)
- `agent-sandbox/pi-bridge/room-client.js` — per-agent Colyseus client wrapper
- `agent-sandbox/pi-bridge/nim-models.json` — carry from reference
- `agent-sandbox/pi-bridge/prompt-builder.js` — assembles system prompt from `{ name, seedMessage, roomId }`; simple for MVP
- `agent-sandbox/pi-bridge/skill-templates/post/` — copy verbatim from npc-no-more

## "Seed message" — the one human-in-the-loop affordance

At agent spawn, the caller can pass `seedMessage` — one initial user turn the agent sees. Not ongoing chat; just a way to kick off what the agent should do. Costs almost nothing to implement (append to the system prompt or send as first user message).

## Required env

- `NVIDIA_NIM_API_KEY`
- `ROOM_SERVER_URL`, `RELAY_URL`, `WORKSPACE`

## Out of scope for MVP

- `/agents/:id/stream` live stdout WS
- `/agents/:id/context` inspection
- Tool-call logging as separate events
- Skills beyond `post`
