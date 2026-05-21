---
name: Colony — game scaffold (tile grid, dupes, resources, verbs, store)
description: Build the minimum-viable ONI-flavored game on top of the harness library. 24x16 tile grid, 4 dupes, 3 resources (oxygen/food/power), 5 verbs (mine, build, deliver, eat, sleep), localStorage save state, basic React view. No utility AI yet — dupes stand still until #500 lands.
status: done
order: 490
epic: harness
depends_on: [470, 480]
---

Phase 2a of the agent harness plan. See **[docs/design/agent-harness.md §6 / Phase 2](../docs/design/agent-harness.md#phase-2--colony-game-490-500)** for full plan context. Companion card [#500](500-colony-utility-ai.md) adds the brain wiring.

Colony is the **second proof of portability** for the harness (Sims is the legacy port; Colony is the greenfield case). The goal is a deterministic colony sim that *could* support LLM brains on named dupes (deferred hook), but ships with zero LLM cost by default. ONI-flavored — tile grid, jobs, resource bars, stress — but radically simpler than ONI itself (no fluids, no temperature, no diseases).

The card focus is **scaffold only**: world, store, verbs, view, debug menu. The utility AI scoring + perception wiring lands in [#500](500-colony-utility-ai.md) so the two cards can run in parallel if needed once world.js is stable.

## Deliverables

- `src/lib/colony/world.js` — pure state module. Tile grid (`24×16`, sparse — only changed tiles stored), 4 dupes with `{ id, name, pos: {x,y}, needs: { oxygen, food, energy }, skills: Record<job, number>, stress: number }`, 3 resource bars at world level (`oxygen`, `food`, `power`). Functions: `createWorld(seed)`, `getDupe(world, id)`, `forEachDupe(world, fn)`, `tile(world, x, y)`.
- `src/lib/colony/verbs.js` — registry of 5 verbs, conforming to [docs/design/agent-harness.md §3 / Verb](../docs/design/agent-harness.md#verb--game-registered-action):
  - `take_job(jobType)` — claim an advertised job.
  - `move_to(x, y)` — pathfind/teleport to tile. Phase-2 acceptable: teleport.
  - `deliver(resource, x, y)` — drop a resource at a tile.
  - `eat()` — restore food need at a tile with food.
  - `sleep()` — restore energy at a bed tile.
  - Each verb has `args`, `prompt` (for future LLM brains), and `handler(actor, args, world) → Effect[]`.
- `src/lib/colony/store.js` — localStorage save/load under key `woid.colony.v1`. Schema-versioned. Debounced 500ms writes.
- `src/lib/colony/adapter.js` — `GameAdapter` implementation, **stub-quality for this card**:
  - `observe()` returns an Observation with empty perception (wired in [#500](500-colony-utility-ai.md)).
  - `schedule()` returns all dupe IDs every tick (refined in [#500](500-colony-utility-ai.md)).
  - `verbs` exports from `verbs.js`.
  - `identity` = `new MemoryIdentityStore()`.
- `src/views/Colony.jsx` — top-level view; reads from `store.js`. Renders the tile grid.
- `src/views/ColonyTile.jsx` — single tile, with resource overlays.
- `src/views/ColonyDupe.jsx` — single dupe sprite/marker with name + need bars.
- `src/views/ColonyDebug.jsx` — floating DEV button (only in `import.meta.env.DEV`) opening a panel: spawn dupe, remove dupe, dump JSON, fast-forward time, clear all.

## Acceptance

- A clean clone loads `#/colony` (route wired in [#510](510-colony-sidebar-and-docs.md), but a temporary route can land here for testing).
- 4 dupes are visible on the tile grid with names + need bars.
- DEV panel: clicking "spawn dupe" adds a 5th dupe. "Remove" removes them. State persists across refresh.
- Calling `verbs.move_to.handler(dupe, { x: 5, y: 5 }, world)` mutates the dupe's `pos` to `{x:5, y:5}`.
- No LLM call is made during play.

## Non-goals

- Utility AI / brain wiring. Dupes don't act on their own in this card. See [#500](500-colony-utility-ai.md).
- Pathfinding. `move_to` teleports; A* is a polish item for a later card.
- Storyteller cards / authored events. Out of scope; reuses the runtime from [#305](305-card-pool-and-day1.md) when it lands.
- Multiplayer / Colyseus. Colony is local-first like Shelter.
- ONI fluids, temperature, decor, diseases.
- LLM-driven journal entry on named dupe. Deferred hook §7 of the plan.

## Risk notes

- Tile state can explode if every tile is stored. Use sparse representation — only changed tiles. 24×16 = 384 cells; assume <10% touched in normal play.
- View ↔ state coupling: `Colony.jsx` reads from `store.js`, the adapter reads from `world.js`. Keep them as two readers of the same state, not coupled via React props.
- Tick budget: aim for ≤2ms with 4 dupes (room for 8x growth). Profile before optimizing.

## Related work

- [#225 world phase 1 grounded actions (done)](225-world-phase1-grounded-actions.md) — verb/GM pattern Colony reuses.
- [#285 multi-room building (todo)](285-multi-room-building.md) — Shelter's similar grid system; check there for tile-render patterns before re-inventing.
- [#395 schedule editor UI (todo)](395-schedule-editor-ui.md) — adjacent UI pattern.
