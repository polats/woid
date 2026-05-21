---
name: Roster tab — cross-world character list inside the overlay
description: The Roster tab inside <AgentSandboxOverlay /> renders characters from all registered worlds (Sims, Shelter, Colony) with a per-world filter. This is the first user-visible proof the harness works across all three.
status: superseded
order: 600
epic: harness
depends_on: [550, 560, 570, 580, 590]
---

> **Superseded 2026-05-21.** The Phase 5 architecture this card describes was implemented and then reverted in favor of a smaller lifecycle-focused registry (`src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`). See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

Phase 5 / Slice 5.5. See **[docs/design/world-registry.md §6](../docs/design/world-registry.md#6-sandbox-overlay-shape-590)**.

Replaces the `#/npcs` route. The Roster tab is the first place a user sees Sims + Shelter + Colony characters in one list.

## Deliverables

- `src/components/RosterTab.jsx` (rendered inside `<AgentSandboxOverlay />`'s tab area):
  - Subscribes to `WorldRegistry.allRoster()` on mount + every 5 seconds + on visibility change. Lightweight polling; per-adapter caching from [#560](560-sims-world-adapter.md) and friends absorbs the load.
  - Filter chips at the top: "All" / "Sims" / "Shelter" / "Colony". Off worlds (status === 'offline') show a dimmed chip with the count.
  - Each row: avatar (fallback initial), name, world chip, status indicator.
  - Click a row → opens the Inspector tab with that character selected (Inspector landing in [#620](620-colony-brain-inspector.md); for this card, clicking just sets the active inspected character in `useOverlayState`).
  - Drag a row → sets `dataTransfer.setData('application/x-character-pubkey', identityId)` (consumed in [#610](610-cross-world-drag-and-drop.md)).
  - Empty state per world: "No characters in <world>" or "(world offline)".
- Sidebar `#/npcs` link disposition decided in [#640](640-sidebar-cleanup-and-route-redirects.md). For this card, the existing `NPCs.jsx` view stays accessible at `#/npcs` until [#640](640-sidebar-cleanup-and-route-redirects.md) redirects.
- Optional: deduplication by `identityId` — if the same identity appears in Sims and Colony, show one row with two world chips. Behind a flag for now; default to per-world-row.

## Acceptance

- Open the overlay → click Roster tab.
- With pi-bridge running + Shelter visited + Colony visited at least once: roster shows entries from all three.
- Filter to "Colony" → only Colony dupes show.
- Filter to "Sims" with pi-bridge offline → "Sims unavailable" empty state (not a thrown error).
- Drag a row over a world view → `dragstart` payload is `application/x-character-pubkey` with the identity id.
- Click a row → the Inspector tab activates and the row's character is "selected" (visible via overlay state).
- Playwright spec verifies: roster contains Colony dupes after visiting `#/colony`.

## Non-goals

- The Inspector tab content. That's [#620](620-colony-brain-inspector.md).
- The drop handlers on world views. Those are [#610](610-cross-world-drag-and-drop.md).
- The Personas creation flow. [#630](630-personas-in-overlay.md).
- Removing the `#/npcs` route. [#640](640-sidebar-cleanup-and-route-redirects.md).
- Real-time updates beyond 5s polling. Subscriptions per adapter are a follow-up.

## Risk notes

- **Polling cost.** 5s × 3 worlds × HTTP/local reads. Adapter caches absorb most of it; Sims SSE could replace polling for the live world if it becomes hot.
- **Avatar fallback.** Sims has bridge-served avatars; Shelter agents may not; Colony dupes have none. Use the initial-letter fallback from `RoomMap.jsx` consistently.
- **Identity dedupe edge case.** Two characters with the same name in different worlds is fine. Two characters with the same `identityId` is the real dedupe case; if it happens before [#630](630-personas-in-overlay.md) introduces PortableIdentity flow, just show two rows.

## Related work

- Existing [`src/views/NPCs.jsx`](../src/views/NPCs.jsx) — bridge-only NPC manager; this tab supersedes it for cross-world reach.
- [`src/AgentDrawer.jsx`](../src/AgentDrawer.jsx) — drawer pattern this tab visually echoes.
