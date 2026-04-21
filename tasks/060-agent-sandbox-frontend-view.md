---
name: Add Sandbox view to the frontend
description: #/agent-sandbox route — create agent form, room state, relay feed. Observation-only.
status: done
order: 60
epic: sandbox
---

Add a first-class sandbox view alongside tasks/diagrams/references/docs. Feature-flagged via `config.features.agentSandbox`.

## Deliverables

- `src/Sandbox.jsx` — three panes:
  - **Left**: "Create agent" form (name + optional seed message) → `POST /agents` on pi-bridge
  - **Middle**: room state from Colyseus (agents present)
  - **Right**: relay feed — subscribe to `{ kinds: [1] }` via `nostr-tools` SimplePool, render newest first with agent name lookup by pubkey
- `src/hooks/useSandboxRoom.js` — Colyseus client wrapper
- `src/hooks/useRelayFeed.js` — SimplePool subscription hook
- Route in `App.jsx`: `#/agent-sandbox` → `<Sandbox />`, gated on `config.features?.sandbox`
- Sidebar entry in `src/layout/Sidebar.jsx`

## Frontend deps to add

- `colyseus.js`
- `nostr-tools`

## MVP: observation-only

No chat textbox. No per-agent stop buttons beyond a basic delete. No context inspection. You create agents, you watch them. Anything richer is a post-MVP card.
