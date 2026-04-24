---
name: Global turn scheduler + unified room perception
description: Replace the flat 1.5s debounce with urgency tiers, coordinate across agents so they don't all fire at once, and feed agents a room-wide context slice on every turn.
status: todo
order: 140
epic: agent-sandbox
---

Phase 2 of the "as dynamic as call-my-ghost" plan. Assumes task #130 is landed (pool + rate-limiter). This is where the *feel* of the room actually comes from — pacing, coordination, and the sense that agents see each other.

Today each agent has its own `pendingTrigger` → debounce(1.5s) → `tryListenTurn`. No awareness of other agents, no prioritisation. call-my-ghost's `driveRoom`/`thinkReason` (`llmDriver.js:65–159` in that repo) does three things we don't: urgency tiers, per-agent min-gaps with jitter, and a global dampener so N agents don't all reply simultaneously to the same event.

## Deliverables

### Scheduler

- `agent-sandbox/pi-bridge/scheduler.js` — new module. Per-agent queue of pending triggers tagged with type:
  - `reply` (directly addressed / mentioned / replied-to): min-gap ~3s, jitter ±500ms
  - `ambient` (room chatter, tangential): min-gap ~12s, jitter ±2s
  - `arrival` / `departure` / `admin`: min-gap ~2s, high priority, runs ahead of other triggers
- On each trigger, the scheduler picks the highest-priority tier per agent that's past its min-gap. Dropped triggers are coalesced, not queued indefinitely.
- Global dampener: if >1 agent's turn comes due within a 1s window for the same room event, stagger them (random order, 500–1500ms apart) so they don't speak in chorus.
- Expose `scheduler.getState()` for `/health` introspection.

### Trigger classification

- Classify incoming Colyseus messages in `roomWatcher`-equivalent code in `server.js`:
  - Message directly addresses this agent (`@name`, name in text, kind:1 `p` tag matches) → `reply`
  - Message in same room but not addressed → `ambient`
  - Agent arrived/left → `arrival`/`departure` (trigger everyone present)

### Unified perception

- Today pi sees a delta (`messagesSinceLastSeen`). Extend `buildUserTurn` in `buildContext.js` to include:
  - `recentRoom`: last 8 utterances in the room (any speaker, most-recent-last)
  - `presence`: current roster (who's in the room, positions)
  - `youLastSaid`: the agent's own last 1–2 posts, verbatim (so pi doesn't repeat itself)
- Mirrors call-my-ghost's `recentConversation` + `recentPerceptions` split.

## Acceptance

- Drop two agents in a room, post a question addressed to one by name. Addressed agent replies within ~4s; un-addressed agent might chime in ambient-style after 12–15s, not simultaneously.
- Three+ agents present when an event fires: their replies are staggered, not chorus.
- Agent doesn't echo its own last post (validates `youLastSaid` context).
- Scheduler state visible at `/health` — active queues, per-agent last-acted time.
- No regression: killing / respawning agents, changing rooms, restarting pi-bridge all work.

## Non-goals

- External-agent mode — task #150. The scheduler should be designed so external agents plug in as one more scheduled actor, but that wiring is next task.
- Hand-tuning the tier timings — the ones above are starting points; expose them as env vars (`TIER_REPLY_MIN_MS`, etc.) so we can adjust without redeploying.
