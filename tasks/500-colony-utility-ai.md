---
name: Colony — utility AI brain wiring + perception bus
description: Make Colony's dupes act autonomously. Wire UtilityBrain into the tick loop with per-character scorers, integrate perception.js for tile-change events with interest management, and integrate moodlets.js for stress events. Dupes mine 100 ore without supervision and without LLM cost.
status: done
order: 500
epic: harness
depends_on: [470, 480, 490]
---

Phase 2b of the agent harness plan. See **[docs/design/agent-harness.md §6 / Phase 2b](../docs/design/agent-harness.md#2b--utility-ai--perception-wiring-500-15-days)** for full plan context.

[#490](490-colony-game-scaffold.md) lands the world + verbs + view. This card brings the dupes to life with **deterministic utility AI** — no LLM. The scoring approach is the Utility AI pattern from [docs/research/foundational-ai-patterns.md](../docs/research/foundational-ai-patterns.md) and the Sims smart-object precedent in [docs/research/the-sims.md](../docs/research/the-sims.md).

Stress is modeled with moodlets (from `src/lib/harness/moodlets.js`, relocated in [#470](470-harness-extraction.md)): environment events emit weighted moodlets; mood band gates behavior (a `breaking`-band dupe forces a break).

## Deliverables

- `src/lib/colony/utility.js` — pure scoring functions:
  - `scoreTakeJob(verb, args, obs) → number` — based on `need_pressure` (oxygen low → mining oxygen-bearing tile scores high), `proximity`, `skill_match`.
  - `scoreEat(verb, args, obs) → number` — based on food need.
  - `scoreSleep(verb, args, obs) → number` — based on energy need.
  - `scoreMoveTo(verb, args, obs) → number` — instrumental; only when needed to reach another high-scoring verb.
- `src/lib/colony/perception.js` — Colony-specific perception event kinds:
  - `colony:tile_changed` (broadcast to dupes within 3 tiles)
  - `colony:job_advertised` (broadcast to dupes with matching skill)
  - `colony:resource_low` (per-dupe self-event when own needs drop)
  - `colony:breaker_tripped` (broadcast to all)
- Update `src/lib/colony/adapter.js`:
  - `observe(id, world, tick)` populates `perception` (delta since last tick), `needs` (oxygen/food/energy), `moodlets`, and `game.advertisedJobs` (lazy — only when a Brain consumes it).
  - `schedule(world, tick)` — returns dupe IDs at most every 200ms per dupe (smooth out the load); a dupe with `breaking` mood-band always ticks.
- `src/lib/colony/brain.js` — Colony's brain factory:
  - `createColonyBrain(dupeId)` returns a `UtilityBrain` configured with the scorers from `utility.js` and a topK of 1.
  - One brain instance per dupe; attached at world creation, detached on removal.
- Wire moodlets into the tick loop:
  - Environmental events (`breaker_tripped`) emit `{ source: 'environment', tag: 'breaker_tripped', weight: -5, duration_ms: 30*60*1000 }`.
  - Mood-band check: `breaking` → emit a `colony:resource_low` self-event so the brain chooses a break verb.
- Interest management: `perception.broadcastTo()` filters tile-change recipients to dupes within 3 tiles. Avoid the 30-dupes-receive-every-tile-step leak.

## Acceptance

- Start a fresh world. Within 10 sim-minutes, all 4 dupes have autonomously taken a job (verified by the debug-panel JSON dump).
- Trigger `breaker_tripped` via the debug panel: dupes near the breaker get the moodlet; their mood-band drops; behavior shifts (they prioritize food/rest if the moodlet pushes them low).
- 4 dupes complete 100 mining actions in <5 minutes of real time, with **zero LLM calls** (verified by absence of network traffic to model providers).
- Tick budget: stable ≤2ms per tick at 30 ticks/sec with 4 dupes (use the browser perf profiler).
- Refresh the page; world state restores; dupes resume what they were doing.

## Non-goals

- Pathfinding upgrade. Movement is still teleport (or a 30-sim-second timer like Shelter's deferred A*).
- LLM brain on a named dupe (Meep journal). Deferred hook §7 of the plan.
- Storyteller cards. Reuse later from [#305](305-card-pool-and-day1.md).
- Cooldown decorators on the scoring function. Add only if dupes oscillate in playtest.
- Perception event types beyond the four listed. Add as Colony grows.

## Risk notes

- **Oscillation.** Two near-equal scores can ping-pong a dupe between two jobs. Mitigation: tie-break by dupe ID; add a small hysteresis bonus for the current job. Only add a real cooldown decorator if playtest reveals oscillation; do not pre-optimize.
- **Interest-management correctness.** The 3-tile radius for tile-change events is approximate. A dupe just outside the radius might miss a relevant event. Acceptable for Phase 2; revisit if game design demands wider perception.
- **Stress runaway.** A `breaking`-band dupe that can't get to food/rest will compound. Cap moodlet sum at ±50 to avoid the spiral.
- **Tick coherence.** If `observe()` and the verb handlers operate on slightly different snapshots, dupes can act on stale info. Mitigation: `tick` runs as: collect observations → resolve brains → apply effects in order → emit perception events. No interleaving.

## Why this card before docs

The Colony view is unimpressive without autonomous dupes — they just stand there. [#510](510-colony-sidebar-and-docs.md)'s acceptance criterion ("dupes are visibly working when the sidebar route opens") depends on this card landing first.
