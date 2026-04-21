---
name: Sandbox docs + smoke check
description: docs/agent-sandbox.md walkthrough, README bullet, one smoke script
status: done
order: 80
epic: sandbox
---

Closing card — make the feature discoverable.

## Docs

- `docs/agent-sandbox.md` (auto-appears in sidebar):
  - One-paragraph "what it is"
  - Quickstart: `cp agent-sandbox/.env.example sandbox/.env` → add `NVIDIA_NIM_API_KEY` → `npm run agent-sandbox:up` → open `#/agent-sandbox`
  - Service diagram (browser → {room-server, relay, pi-bridge}; pi-bridge → {room-server, relay})
  - How agent posting works (link to `skill-templates/post/SKILL.md`)
  - How to tail the relay from outside: `nak req -s ws://localhost:7777`
  - Disabling the feature (`features.agentSandbox: false`)
- Root `README.md` — one-line Sandbox bullet under "What's inside"

## Smoke

- `scripts/agent-sandbox-smoke.js` — hits `GET /health` on each of the three services; exits non-zero if any fail
- Documented, not wired into `npm run test:e2e` (Docker requirement would break the default)

## Acceptance

Fresh clone → set NIM key → `npm run agent-sandbox:up` → `npm run dev` → `#/agent-sandbox` → create agent with seed message "introduce yourself" → see agent in room pane → see its `kind:1` post in relay feed within ~30s.
