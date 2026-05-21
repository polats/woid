---
name: WorldRegistry primitive — cross-world adapter index
description: Introduce src/lib/harness/world-registry.js — the typed interface, the singleton, the per-adapter self-registration pattern. No game adapters yet; this is just the contract the next three cards plug into.
status: superseded
order: 550
epic: harness
---

> **Superseded 2026-05-21.** The Phase 5 architecture this card describes was implemented and then reverted in favor of a smaller lifecycle-focused registry (`src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`). See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

Phase 5 / Slice 5.0 of the agent harness work. See **[docs/design/world-registry.md §4](../docs/design/world-registry.md#4-the-worldregistry-interface)** for the source-of-truth interface definitions.

The `WorldRegistry` is the cross-world data layer the sandbox overlay reads through. After Phase 5 ships, every UI surface that needs to enumerate characters / spawn them / inspect their telemetry across Sims, Shelter, and Colony goes through this layer instead of asking pi-bridge or shelterStore directly. This card lands the empty contract; [#560](560-sims-world-adapter.md), [#570](570-shelter-world-adapter.md), [#580](580-colony-world-adapter.md) plug their adapters in.

`WorldRegistry` and the existing `GameAdapter` ([#480](480-harness-interfaces.md)) are different interfaces serving different layers. `GameAdapter` is the per-game tick-loop contract (what a Brain sees). `WorldAdapter` is the per-game registry contract (what the cross-world UI sees). A game may implement both.

## Deliverables

- `src/lib/harness/world-registry.js`:
  - `WorldAdapter` JSDoc typedef per [world-registry.md §4](../docs/design/world-registry.md#4-the-worldregistry-interface).
  - `WorldRegistry` JSDoc typedef.
  - `RosterEntry`, `WorldStatus`, `DropTarget`, `TelemetryStream` typedefs.
  - `getWorldRegistry()` browser-singleton factory; lazy on first call.
  - `register(adapter)` — adds to internal Map keyed by `adapter.worldId`. Idempotent — re-register overwrites (useful for HMR).
  - `worlds()` — returns array of registered adapters.
  - `byId(worldId)` — returns adapter or null.
  - `allRoster()` — `Promise.allSettled` over every `adapter.roster()`. Offline worlds return `[]` for their slice; the function never rejects.
- `src/lib/harness/world-registry.test.js` (or inline smoke; pattern matching #480):
  - Registering an adapter and reading it back via `byId`.
  - `allRoster` succeeds even when one adapter rejects.
  - Re-registering the same `worldId` overwrites without throwing.

## Acceptance

- Importing `src/lib/harness/world-registry.js` in both Node and the browser compiles cleanly via Vite (test by visiting the existing dev server with this module imported in a placeholder).
- Smoke: register two stub adapters with the same `worldId`; the second one wins.
- Smoke: register one adapter whose `roster()` throws; `allRoster()` resolves with empty entries for that world rather than rejecting.

## Non-goals

- Any game adapter. That's [#560](560-sims-world-adapter.md), [#570](570-shelter-world-adapter.md), [#580](580-colony-world-adapter.md).
- Any UI consumer. That's [#590](590-agent-sandbox-overlay-shell.md) onward.
- Persistence — registrations live in-memory only.

## Non-goals (deferred follow-ups)

- `WorldAdapter.findByIdentityId` is optional in the contract. Cards [#560](560-sims-world-adapter.md) / [#570](570-shelter-world-adapter.md) / [#580](580-colony-world-adapter.md) decide whether to implement it; [#630](630-personas-in-overlay.md) only relies on it when implemented.
- Real-time telemetry streaming. `telemetry()` returns a `TelemetryStream` interface; the actual SSE consumer + UI lands in [#620](620-colony-brain-inspector.md).

## Risk notes

- **HMR re-registration** can cause duplicate stale adapters if not handled — overwrite-on-register is the chosen behavior.
- **Async fanout in `allRoster`** must use `Promise.allSettled`, not `Promise.all`. A naive `Promise.all` causes one offline world to blank the whole roster.

## Why this card first

Every other Phase 5 card depends on the contract. ~0.5 day.
