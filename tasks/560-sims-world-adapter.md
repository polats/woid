---
name: Sims WorldAdapter — pi-bridge translator
description: Implement src/lib/sims/world.js — a read-only translator that wraps pi-bridge HTTP endpoints into the WorldRegistry interface. No pi-bridge changes; pi-bridge stays as the authoritative Sims runtime.
status: superseded
order: 560
epic: harness
depends_on: [550]
---

> **Superseded 2026-05-21.** The Phase 5 architecture this card describes was implemented and then reverted in favor of a smaller lifecycle-focused registry (`src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`). See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

Phase 5 / Slice 5.1. See **[docs/design/world-registry.md §5](../docs/design/world-registry.md#5-the-three-world-adapters)** for the adapter shape and **[#550](550-world-registry-primitive.md)** for the registry contract.

This card lifts Sims into the WorldRegistry without changing pi-bridge or its endpoints. The adapter is **read-only translation** on top of the existing `${bridgeUrl}/...` HTTP API; spawning + telemetry pass through to pi-bridge's existing routes.

## Deliverables

- `src/lib/sims/world.js`:
  - `createSimsWorldAdapter({ bridgeUrl })` returns a `WorldAdapter`.
  - `worldId = 'sims'`.
  - `roster()` → `GET ${bridgeUrl}/characters` → projects each character to `{ worldId: 'sims', characterId: pubkey, identityId: character.identityId ?? pubkey, name, avatarUrl, details: { kind, room, position } }`. Caches for 5s to avoid hammering on overlay open.
  - `status()` → tracks a lightweight `${bridgeUrl}/health` ping; returns `'ok'` if last ping within 30s, `'offline'` otherwise.
  - `spawn(identity, target)` → `POST ${bridgeUrl}/characters` with `{ name: identity.name, about: identity.about, kind: target.kind ?? 'player', x: target.x, y: target.y }`. Returns `{ characterId: response.pubkey }`.
  - `telemetry(characterId)` → opens an EventSource to `${bridgeUrl}/agents/${characterId}/events/stream`. Returns a `TelemetryStream` with `subscribe(handler) → unsubscribe` semantics (lazy connection; closed when last subscriber unsubscribes).
  - `findByIdentityId(identityId)` → for now, scans `roster()` results filtering by `identityId`. Pi-bridge gains a dedicated endpoint as a follow-up if needed.
- `src/lib/sims/index.js` — re-exports + a `registerSimsWorld(bridgeUrl)` convenience.
- Auto-registration somewhere in the app boot path — likely a `src/lib/worlds/boot.js` that calls `registerSimsWorld(config.agentSandbox?.bridgeUrl)` (and later the other two). Imported once from `src/main.jsx`.

## Acceptance

- With pi-bridge running and ≥1 character on the bridge, `getWorldRegistry().byId('sims').roster()` returns that character projected to `RosterEntry` shape.
- With pi-bridge **not** running, `status()` returns `'offline'` and `roster()` returns `[]` rather than throwing.
- Spawning a character via `spawn({ name: 'Test', about: '…' }, { kind: 'npc', x: 4, y: 6 })` produces a character visible in the bridge's `/characters` endpoint.
- `telemetry()` SSE subscription receives at least one event when a pi agent is active on that character.

## Non-goals

- Pi-bridge endpoint changes. Pure read translation.
- Caching beyond the 5s roster TTL.
- Identity-by-id efficiency. Linear scan is fine until proven slow.
- WebSocket / Colyseus presence integration. The Sims world view already has `useSandboxRoom` for live presence; the adapter only handles roster + spawn + telemetry.

## Risk notes

- **EventSource isn't fetch.** Browser EventSource can't set custom headers. If pi-bridge later requires auth on the SSE endpoint, this becomes a problem; today it's localhost-bound so auth is moot.
- **Stale character entries.** Pi-bridge may return characters that have been deleted; mitigate by filtering on `character.runtime?.deleted` if pi-bridge surfaces such a flag, otherwise trust the bridge.
- **CORS in production.** If/when this ships beyond localhost, the Sims adapter needs pi-bridge to set appropriate CORS headers. Out of scope for this card.

## Related work

- [#135 — Harness abstraction (done)](135-agent-sandbox-harness-abstraction.md) — pi-bridge's internal Harness interface that this adapter wraps.
- [#175 — External driver status panel (todo)](175-agent-sandbox-external-driver-status.md) — adjacent surface for external runtime debugging.
