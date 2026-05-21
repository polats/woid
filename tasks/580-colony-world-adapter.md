---
name: Colony WorldAdapter — extend existing GameAdapter to fit WorldRegistry
description: Extend src/lib/colony/adapter.js (already implements harness GameAdapter) to also implement WorldAdapter and register with the WorldRegistry. Smallest of the three adapters; mostly wiring.
status: superseded
order: 580
epic: harness
depends_on: [550]
---

> **Superseded 2026-05-21.** The Phase 5 architecture this card describes was implemented and then reverted in favor of a smaller lifecycle-focused registry (`src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`). See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

Phase 5 / Slice 5.3. See **[docs/design/world-registry.md §5](../docs/design/world-registry.md#5-the-three-world-adapters)**.

Colony already implements the harness `GameAdapter` (per [#490](490-colony-game-scaffold.md)). This card adds a `WorldAdapter` flavour that the `WorldRegistry` consumes — same data sources, different interface shape.

## Deliverables

- `src/lib/colony/world.js`:
  - `createColonyWorldAdapter({ store, loop })` returns a `WorldAdapter`. `store` is `colonyStore` from `src/hooks/useColonyStore.js`; `loop` is the `createColonyLoop()` instance the view mounts (already in `src/lib/colony/loop.js`).
  - `worldId = 'colony'`.
  - `roster()` → `Object.values(store.getSnapshot().dupes).map(d => ({ worldId: 'colony', characterId: d.id, identityId: d.id, name: d.name, avatarUrl: undefined, details: { pos: d.pos, needs: d.needs, stress: d.stress, currentAction: d.currentAction } }))`.
  - `status()` → always `'ok'`.
  - `spawn(identity, target)` → `store.addDupe(makeDupe(identity.id, identity.name, target))`. Returns `{ characterId: identity.id }`.
  - `telemetry(characterId)` → returns a `TelemetryStream` wrapping `loop._brainDecisionsByDupe[characterId]` (the ring buffer added in [#620](620-colony-brain-inspector.md); for this card a stub that returns an empty subscription is acceptable).
  - `findByIdentityId(identityId)` → returns the dupe whose `id === identityId` (Colony uses identityId as characterId today).
- `src/lib/colony/index.js` — re-export + `registerColonyWorld()`.
- Add the registration call to `src/lib/worlds/boot.js`.

## Acceptance

- After visiting `#/colony` once, `getWorldRegistry().byId('colony').roster()` returns 4 dupes.
- `spawn({ id: 'visitor-1', name: 'Visitor', about: '…' }, { x: 10, y: 10 })` adds a fifth dupe visible in the Colony view.
- `getWorldRegistry().allRoster()` (after Sims + Shelter adapters are registered) returns the union of all characters.
- Colony's Playwright spec ([e2e/colony.spec.ts](../e2e/colony.spec.ts)) still passes — no regression to the existing autonomous-mining behaviour.

## Non-goals

- Refactoring `colony/adapter.js` to merge GameAdapter and WorldAdapter into a single object. Two interfaces, two adapters, same data.
- Telemetry implementation. Stub for this card; full ring buffer + subscription in [#620](620-colony-brain-inspector.md).
- Drag-and-drop drop handlers. Those land in [#610](610-cross-world-drag-and-drop.md).

## Risk notes

- **Loop singleton lifetime.** `Colony.jsx` creates `createColonyLoop()` per-mount. The `WorldAdapter` needs the *current* loop instance to read telemetry. Two options:
  - The adapter accepts `loop` at construction; the registration happens after Colony mounts.
  - The adapter looks up the loop lazily from a module-level slot updated by `Colony.jsx` on mount.
  
  Second is more flexible; first is simpler. Pick first for this card; revisit if a loop swap is needed mid-session.
- **Pre-mount roster.** Before `#/colony` is visited, no Colony store has been initialised. `roster()` returns `[]`. That's correct behaviour — empty section in the overlay until the user visits Colony.

## Why third in the slice

The Colony adapter is the cheapest of the three (mostly wiring against code that already exists). Doing it last means Phase 5 progresses from "more work" to "less work" as it goes, leaving energy for the overlay-shell card.
