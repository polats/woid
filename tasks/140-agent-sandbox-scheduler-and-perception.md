---
name: Global turn scheduler + unified room perception
description: Replace the flat 1.5s per-agent debounce with urgency tiers, coordinate across agents so they don't all fire at once, and feed each turn a room-wide context slice. Built on top of the harness abstraction (#135).
status: todo
order: 140
epic: agent-sandbox
---

The last unfinished piece from the original "make it feel as alive as call-my-ghost" plan. With the harness abstraction (#135), the scheduler is now harness-agnostic: it schedules **actors** (any object that exposes `Harness.turn(userTurn)`), not pi processes specifically. Pi, direct, external, and any future harness slot in identically.

Today each agent has its own `pendingTrigger` → debounce(1.5s) → `tryListenTurn`. No awareness of other agents, no prioritisation. call-my-ghost's `driveRoom`/`thinkReason` does three things we don't: urgency tiers, per-agent min-gaps with jitter, and a global dampener so N agents don't all reply simultaneously to the same event.

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

Classify incoming Colyseus messages in the existing `onNewMessage` callback in `server.js`:
- Message directly addresses this agent (`@name`, name in text, kind:1 `p` tag matches) → `reply`
- Message in same room but not addressed → `ambient`
- Agent arrived/left → `arrival`/`departure` (trigger everyone present)

The dynamic prompt (#promptStyle from the call-my-ghost A/B) already includes anti-silence guidance. The scheduler complements it by *picking when* an agent gets its turn — anti-silence tells the LLM what to do *during* the turn.

### Unified perception

Today `buildUserTurn` only includes a delta of messages newer than `lastSeenMessageTs`. Extend it for direct/external harnesses (pi sees its own session history via the `--session` file, so it doesn't need this):

- `recentRoom`: last 8 utterances in the room (any speaker, most-recent-last)
- `presence`: current roster snapshot (who's in the room, positions)
- `youLastSaid`: the agent's own last 1–2 posts, verbatim (so the LLM doesn't repeat itself)

Mirrors call-my-ghost's `recentConversation` + `recentPerceptions` split.

## Acceptance

- Drop two agents (one `dynamic`, one `minimal` for A/B continuity) in a room. Post a question addressed to one by name. Addressed agent replies within ~4s; un-addressed agent might chime in ambient-style after 12–15s, not simultaneously.
- Three+ agents present when an event fires: their replies are staggered, not chorus.
- Agent doesn't echo its own last post (validates `youLastSaid`).
- Scheduler state visible at `/health` — active queues, per-agent last-acted time, current cooldowns.
- No regression: killing / respawning agents, changing rooms, restarting pi-bridge all work.

## Non-goals

- Per-tier hand-tuning beyond env vars (`SCHEDULER_REPLY_GAP_MS` etc.) — pick reasonable defaults from call-my-ghost and tune later.
- Multi-room scheduling — single shared sandbox is fine for v1.
