---
name: Port Colyseus room-server (no auth)
description: Adapt npc-no-more/room-server into agent-sandbox/room-server/ with one generic SandboxRoom, auth stripped for MVP
status: done
order: 30
epic: sandbox
---

Port `npc-no-more/room-server/` into `agent-sandbox/room-server/`. Drop Nostr auth — any client can join. Keep one generic room type.

## Deliverables

- `agent-sandbox/room-server/{Dockerfile,package.json,src/index.js}`
- `agent-sandbox/room-server/src/rooms/SandboxRoom.js` — generic; join accepts `{ name, npub? }` with no verification
- `agent-sandbox/room-server/src/schema/SandboxState.js` — minimal:
  - `agents: MapSchema<AgentPresence>` — `{ sessionId, name, npub, joinedAt }`
  - `messages: ArraySchema<Message>` — `{ ts, from, text }`, ring-buffered to last ~50

## Out of scope for MVP

- Nostr auth (`nostr-auth.js`)
- Recording to disk (`recordings.js`)
- Multiple room types

Both get post-MVP cards if we want them.
