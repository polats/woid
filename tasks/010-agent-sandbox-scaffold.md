---
name: Scaffold agent-sandbox/ and docker-compose
description: Create sandbox/ subtree and compose file for relay + room-server + pi-bridge
status: done
order: 10
epic: sandbox
---

Create the `agent-sandbox/` subtree. Isolated from the rest of woid — no imports into `server/`, `src/`, `tasks/`, `diagrams/`, `docs/`.

## Deliverables

- `agent-sandbox/README.md` — quickstart, ports, service graph
- `agent-sandbox/docker-compose.yml` — three services, localhost-bound:
  - `relay` → `127.0.0.1:7777:7777`
  - `room-server` → `127.0.0.1:2567:2567`
  - `pi-bridge` → `127.0.0.1:3457:3457`
- `agent-sandbox/.env.example` — `NVIDIA_NIM_API_KEY=`, `RELAY_URL=ws://relay:7777`, `ROOM_SERVER_URL=ws://room-server:2567`
- Root `package.json` scripts: `agent-sandbox:up`, `agent-sandbox:down`
- `woid.config.json`: add `features.agentSandbox: true` + `sandbox.{relayUrl, roomServerUrl, bridgeUrl}`

## MVP scope

Auth deferred — no signature verification anywhere. Stack binds to localhost only and README says "don't expose this." That's the safety net.
