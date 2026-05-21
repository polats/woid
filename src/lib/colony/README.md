# colony

ONI-flavored colony sim and the **reference greenfield implementation** of the [woid agent harness](../harness/README.md).

Colony exists for two reasons:

1. To prove the harness ports cleanly from Sims (`agent-sandbox/pi-bridge/`) to a completely different game shape — tile grid, utility AI by default, no LLM cost.
2. To be the canonical example external OSS adopters copy from when integrating their own games. See [`../harness/docs/integrating.md`](../harness/docs/integrating.md) — Colony is the recommended starting template.

## How to play

`#/colony` in the woid sidebar (feature-flag controlled via `woid.config.json` → `features.colony`, defaults on).

4 starting dupes spawn on a 24×16 tile grid. They autonomously mine ore from deposits on the left edge, eat at the kitchen tile, and sleep at beds on the right edge. Press backtick (`` ` ``) for the dev panel — spawn / remove dupes, fast-forward sim time, reset the world.

There is **zero LLM cost** during play. All behaviour is utility AI ([`utility.js`](utility.js)).

## File map

| File | Role |
|---|---|
| [world.js](world.js) | Pure data: tile grid, dupe records, resources, seed-based init. |
| [verbs.js](verbs.js) | Five verbs: `move_to`, `mine`, `eat`, `sleep`, `idle`. Each with args schema + handler. |
| [utility.js](utility.js) | Scoring functions consumed by the brain. Pure; trivially testable. |
| [brain.js](brain.js) | `createColonyBrain(dupeId)` — wires the harness `UtilityBrain` with Colony scorers. |
| [adapter.js](adapter.js) | `GameAdapter` impl: `observe`, `schedule`, verbs, identity. |
| [store.js](store.js) | `useSyncExternalStore`-shaped store with localStorage persistence. Mirrors `shelterStore` pattern. |
| [loop.js](loop.js) | Per-tick orchestration. Combines adapter + per-dupe brain + perception bus + moodlets. |
| [index.js](index.js) | Re-exports. |

## Where the harness is

Colony imports the cross-cutting primitives from [`../harness/`](../harness):

- `harness/perception.js` for the event ring buffer
- `harness/moodlets.js` for stress-driven mood (localStorage-backed persistence)
- `harness/needs.js` is referenced through `world.js` for decay constants
- `harness/impls/brains/UtilityBrain.js` for the brain
- `harness/impls/identity/MemoryIdentityStore.js` for in-session identity

Colony's own `verbs.js` + `utility.js` are the game-specific surface.

## Why these particular verbs

The five verbs were chosen so the brain has clear pressure points:

- `mine(x, y)` — produces ore (the visible objective).
- `eat(x, y)` — restores food need.
- `sleep(x, y)` — restores energy need + reduces stress.
- `move_to(x, y)` — instrumental movement (currently unused by the brain since `mine` / `eat` / `sleep` teleport to their target; reserved for future pathing).
- `idle()` — fallback when nothing scores.

Each verb's handler is self-contained, returns `Effect[]`, and is the only place world mutation happens for that action. This keeps the verb registry trivially testable in isolation.

## See also

- [docs/design/agent-harness.md](../../../docs/design/agent-harness.md) — overall design plan + phasing.
- [docs/research/agent-harness-2026.md](../../../docs/research/agent-harness-2026.md) — research backing each architectural choice.
- [tasks/490-colony-game-scaffold.md](../../../tasks/490-colony-game-scaffold.md) — Phase 2a task card.
- [tasks/500-colony-utility-ai.md](../../../tasks/500-colony-utility-ai.md) — Phase 2b task card.
