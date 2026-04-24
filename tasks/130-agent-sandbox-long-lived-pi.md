---
name: Long-lived pi process per agent + rate-limit backoff
description: Replace the spawn-per-turn pi model with a resident process per agent. Add a global circuit breaker so a single 429 doesn't silently kill every agent.
status: done
order: 130
epic: agent-sandbox
---

Today every turn is `spawn pi --print → readline stdout → exit`, costing ~600ms–2s of cold-start per response. call-my-ghost's brain is in-process and feels snappy by comparison. Phase 1 of the "make woid feel as dynamic as call-my-ghost" plan — highest-ROI change, touches only pi-bridge internals, no protocol changes.

Pair it with a rate-limit circuit breaker because the new persistent-pi model will expose quota issues faster (agents run turns more often), and today a 429 from NIM/Gemini just surfaces as a generic error that doesn't stop subsequent turns.

## Deliverables

- `agent-sandbox/pi-bridge/pi-pool.js` — new module. One long-lived `pi` child process per active agent. API:
  - `startPi(agentId, { pubkey, sessionPath, model, provider, env })` → `{ stdin, turn(input) }`
  - `turn(input)` writes a framed request to stdin, returns a Promise that resolves when the next `message_end` arrives on stdout. Interleaves turns per-agent.
  - `stopPi(agentId)` sends SIGTERM, waits, SIGKILL fallback.
  - Restart-on-crash (max 3 in 60s, then give up and surface an `agent-crashed` event).
- Refactor `tryListenTurn` in `server.js` to use the pool instead of `spawn(PI_BIN, ...)` per turn. Remove the `spawn` block and readline plumbing from that call path.
- New module `agent-sandbox/pi-bridge/rate-limiter.js`:
  - `recordError(provider, err)` — if it's a 429/quota/rate error, enter global cooldown (exponential: 10s → 60s → 300s capped).
  - `isInCooldown(provider)` — check before starting a turn; if true, queue the trigger for when the window ends.
  - Per-provider, not per-agent — a NIM cooldown shouldn't pause Gemini agents.
- Wire the rate-limiter into the pool and the existing turn loop. Emit `[rate-limit]` log lines on entry/exit so it's obvious in Railway logs.
- Update `/health` to surface `{ pool: { <agentId>: { running, turns, lastError } }, cooldowns: { nim?: <secs>, gemini?: <secs> } }`.

## Acceptance

- After spawning two agents locally and chatting in the room, turn latency from "user posts" → "agent reply visible" drops measurably (compare before/after — should be ~1s faster on the first turn and sub-second on subsequent turns within the same agent).
- Memory per agent is stable (no leak from repeated spawns since there aren't any).
- Force a NIM 429 (e.g. set NVIDIA_NIM_API_KEY to something invalid mid-session, or saturate quota) — all NIM-backed agents pause cleanly and resume once the cooldown expires; Gemini agents keep running.
- Killing `pi` externally (`kill <pid>`) causes the pool to restart it within 2s; the agent keeps turning after.
- `npm run agent-sandbox:up` + existing e2e still green.

## Non-goals

- Scheduler / urgency tiers — that's task #140.
- External-brain support — that's task #150.
- Streaming partial tokens to the UI — defer; one response per turn is fine.
