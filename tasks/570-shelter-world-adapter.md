---
name: Shelter WorldAdapter — shelterStore translator
description: Implement src/lib/shelter/world.js — wraps shelterStore reads + addAgent mutation. Tells the WorldRegistry "yes, Shelter exists and these are its characters" without any shelterStore refactor.
status: superseded
order: 570
epic: harness
depends_on: [550]
---

> **Superseded 2026-05-21.** The Phase 5 architecture this card describes was implemented and then reverted in favor of a smaller lifecycle-focused registry (`src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`). See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

Phase 5 / Slice 5.2. See **[docs/design/world-registry.md §5](../docs/design/world-registry.md#5-the-three-world-adapters)**.

Wraps the existing shelterStore (`src/lib/shelterStore/`) into a `WorldAdapter`. No shelterStore refactor — this is read-translation + a thin spawn wrapper around the existing `addAgent` mutation.

## Deliverables

- `src/lib/shelter/world.js`:
  - `createShelterWorldAdapter({ store })` returns a `WorldAdapter`. `store` is the shelterStore singleton from `src/hooks/useShelterStore.js`.
  - `worldId = 'shelter'`.
  - `roster()` → `Object.values(store.getSnapshot().agents)` → projects each to `{ worldId: 'shelter', characterId: agent.id, identityId: agent.pubkey ?? agent.id, name: agent.name, avatarUrl: undefined, details: { kind: agent.kind, scheduleId: agent.scheduleId, state: agent.state, assignment: agent.assignment } }`. Synchronous internally; returned as a resolved Promise to match the interface.
  - `status()` → always `'ok'` (in-process).
  - `spawn(identity, target)` → `store.addAgent({ id: identity.id, name: identity.name, pubkey: identity.id, traits: {}, scheduleId: target.scheduleId ?? 'worker', assignment: target.assignment ?? null, pos: target.pos ?? null })`. Returns `{ characterId: identity.id }`.
  - `telemetry(_characterId)` → returns `null`. Shelter's resolver doesn't surface decision logs yet; the inspector tab will show "no telemetry available" for Shelter rows.
  - `findByIdentityId(identityId)` → linear scan of `Object.values(store.getSnapshot().agents)`; returns first matching `pubkey === identityId`.
- `src/lib/shelter/index.js` — re-exports + `registerShelterWorld()` that pulls the store from the existing hook factory.
- Add the registration call to `src/lib/worlds/boot.js` (created in [#560](560-sims-world-adapter.md)).

## Acceptance

- After Shelter is loaded (visit `#/shelter` once to ensure the store is initialised), `getWorldRegistry().byId('shelter').roster()` returns the current Shelter agents projected to `RosterEntry` shape.
- `spawn({ id: 'test-1', name: 'Tester', about: '...' }, { scheduleId: 'worker' })` adds an agent to the Shelter store; the existing Shelter view shows them.
- `telemetry()` returns `null` without throwing.
- Shelter remains fully functional via its existing UI; this card adds no new visible behaviour to Shelter itself.

## Non-goals

- Shelter `GameAdapter` (the harness Brain interface). That's the deferred §7 hook in [agent-harness.md](../docs/design/agent-harness.md#7-deferred-hooks-with-triggers-for-activation).
- Resolver telemetry. The resolver's per-tick patches could become a TelemetryStream in a follow-up but not this card.
- LLM-driven Shelter NPCs. Different phase.
- Persistence layer changes. shelterStore's localStorage save format is unchanged.

## Risk notes

- **`store.addAgent` shape.** The actual shelterStore API may differ from what's sketched here; verify against the current `src/lib/shelterStore/store.js` before implementing. The intent is unchanged; the call shape may need adjustment.
- **Identity collision.** If a Sims character and a Shelter agent share an `identityId`, the registry must surface both rows. The roster aggregation in [#600](600-roster-tab-cross-world.md) decides how to render duplicates (likely: dedupe by `identityId` with per-world chips).
- **Subscription pattern.** Shelter's `useShelterStore` is `useSyncExternalStore`-based. The adapter's `roster()` is one-shot; the UI may want a subscription. Defer to [#600](600-roster-tab-cross-world.md) — it can subscribe to the store directly for live updates and call the adapter on each tick.

## Related work

- [#275 — Storyteller foundation (done)](275-storyteller-foundation.md) — shelterStore is the persistence shelter relies on.
- [#345 — Sleep silence scheduler (todo)](345-sleep-silence-scheduler.md) — adjacent shelterStore work.
