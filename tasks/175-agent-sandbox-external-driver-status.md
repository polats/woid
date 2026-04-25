---
name: Driver status panel for external-harness agents
description: Surface the external client's connection state, last turn, last act, and heartbeat staleness in the System tab so a remote-driver session is debuggable from the woid UI.
status: todo
order: 175
epic: agent-sandbox
---

Once an agent is spawned with `harness: "external"`, the woid UI shows nothing about whether the remote driver is connected, processing turns, or about to be evicted. All the information exists — `ExternalHarness.snapshot()` already returns `streamConnected`, `lastHeartbeatAgeMs`, `history` length — but it's only visible via `GET /health`.

Useful when the user is debugging an external agent that went silent (did the SSE drop? is the heartbeat stale? is there a pending turn that timed out?).

## Deliverables

- New `GET /agents/:agentId/external-status` endpoint (or extend the existing `/agents/:id/events` to include the latest snapshot envelope) returning:
  - `streamConnected: bool`
  - `lastHeartbeatAt: ts | null`
  - `lastHeartbeatAgeMs`
  - `pendingTurn: { turnId, deadline } | null`
  - `lastTurnAt: ts | null`
  - `lastActAt: ts | null`
  - `tokenExpiresAt`
  - `evictionAt` (if heartbeat stale enough that the next reaper pass will evict)
- Frontend: `src/AgentSystemPrompt.jsx` (or a new sibling `AgentDriverStatus.jsx`) renders the panel only when `agent.harness === "external"`. Polls `external-status` every 2–3s. Displays:
  - A connection dot (green/grey/red) + a one-line "Connected — last turn 4s ago" status
  - Token expiry countdown ("expires in 23h 12m")
  - Heartbeat freshness ("last heartbeat 1m 18s ago — eviction in 3m 42s")
  - A small log of the last 5 act payloads (the bridge already records these in the event ring) so the user can see what the driver has been doing
- Optional: a "force eviction" button that calls `DELETE /agents/:agentId` for when the user wants to disconnect a misbehaving driver from the woid side.

## Acceptance

- Spawn an external agent via `agent-sandbox/examples/external-agent.mjs`. Open System tab. Status shows "Connected", token countdown ticking down, last turn timestamp updating with each turn.
- Kill the example mid-session. Within ~3s, status reads "Disconnected"; heartbeat freshness ages.
- After 5 minutes of silence, the heartbeat-eviction reaper fires; UI shows the agent has been evicted (drawer empties or transitions to a stopped runtime view).
- pi/direct agents see no driver-status panel (the System tab keeps its current shape for those).

## Non-goals

- Server-side dashboards / metrics scraping — this is a per-agent debugging surface, not Prometheus.
- Live SSE event mirror in the panel — Live tab already covers that. The driver-status panel is for connection-level health, not turn content.
