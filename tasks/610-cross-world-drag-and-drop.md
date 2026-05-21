---
name: Cross-world drag-and-drop spawn — Sims, Shelter, Colony
description: Drag any character from the overlay roster onto any world's view to spawn them. Sims already works via RoomMap. Colony needs ~5 LOC of wiring. Shelter needs a new raycasting drop handler against its 3D stage. This is the "the harness works across three worlds" demo.
status: superseded
order: 610
epic: harness
depends_on: [550, 560, 570, 580, 590, 600]
---

> **Superseded 2026-05-21.** The Phase 5 architecture this card describes was implemented and then reverted in favor of a smaller lifecycle-focused registry (`src/lib/harness/registry.js` + `useWorldDrop` + `useWorldRegistration`). See [docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md](../docs/devlog/2026-05-20-phase5-worldregistry-and-overlay.md).

Phase 5 / Slice 5.6. See **[docs/design/world-registry.md §7](../docs/design/world-registry.md#7-cross-world-drag-and-drop-610)**.

Standardize on the existing `application/x-character-pubkey` MIME pattern that `RoomMap.jsx` already uses. Each world view registers a drop handler that translates client coordinates to that world's coordinate shape and calls `WorldRegistry.byId(world).spawn(identity, target)`.

## Deliverables

### Shared

- `src/lib/harness/world-dnd.js`:
  - `extractDragIdentity(event) → identityId | null` — uniform reader.
  - `setDragIdentity(event, identity)` — uniform writer (used by the Roster tab in [#600](600-roster-tab-cross-world.md) and any future drag source).

### Sims (`#/game`)

- Verify the existing `RoomMap.jsx` drop handler in `Sandbox.jsx` (and its eventual home post-[#640](640-sidebar-cleanup-and-route-redirects.md)) still works. **No changes expected** — this was already shipped.
- Wire `onDropCharacter` to call `getWorldRegistry().byId('sims').spawn({...identity}, { x, y, kind: 'player' })`. If today it calls `bridge/characters` directly, swap to the registry call so all three worlds go through the same path.

### Colony (`#/colony`)

- `src/views/Colony.jsx` already renders `<RoomMap />` without `onDropCharacter`. Add:
  ```js
  const onDropCharacter = useCallback(async (identityId, x, y) => {
    const identity = await registryHelper.findIdentity(identityId);
    if (!identity) return;
    await getWorldRegistry().byId('colony').spawn(identity, { x, y });
  }, []);
  ```
  Pass to `<RoomMap onDropCharacter={onDropCharacter} />`.
- ~10 LOC including the import.

### Shelter (`#/shelter`)

- `src/views/ShelterStage3D.jsx` gets new drag handlers.
- Use the existing `presenceProjector.js` — already does cell→world mapping. We add **world→cell** via Three.js raycasting against the floor planes:
  ```js
  // On dragover:
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(floorMeshes, false);
  if (hits.length > 0) { /* compute (roomId, localU, localV) from hit.point */ }
  // On drop:
  const target = lastValidCell;
  if (target) await getWorldRegistry().byId('shelter').spawn(identity, target);
  ```
- Show a translucent highlight cell while hovering. Reuse the existing tap-to-focus material if available.
- The drop handler needs the scene's `floorMeshes` and `camera` refs — exposed via `ShelterStage3D`'s internal state. Plumbing: add an `onDrop` callback prop accepting `{ identityId, roomId, localU, localV }`.

### Wiring

- `src/views/Shelter.jsx` passes `onDrop` to `ShelterStage3D` which calls the registry's spawn.

## Acceptance

- Open the overlay → Roster tab. Drag a Colony dupe onto Sims's tile grid — it spawns as a Sims character at the drop tile.
- Drag a Sims character onto Colony — spawns as a Colony dupe at the drop tile.
- Drag any character onto Shelter — spawns as a Shelter agent in the room the mouse was over, at the localU/localV the mouse hit.
- Playwright spec: simulate drag from a Colony roster row to a target tile, assert the character count increments by 1.
- No regressions to Sims's existing drag-from-card-tray behaviour (which already used the same MIME pattern).

## Non-goals

- Pathfinding. Spawned characters appear at the drop point.
- Cross-world identity *teleportation*. Spawn creates a new game-local instance with the dropped identity's `id` and `name`; existing game-local state of any prior instance in that world is overwritten or preserved per the spawn handler (the spawn handler decides — Colony adds a new dupe, ignoring stale records).
- Drop validation in the world view (e.g., "can't drop on a wall"). Spawn handler is the last word; bad targets emit a toast.
- Drag *between* world views (Colony tile → Sims). Roster is the only drag source.

## Risk notes

- **Shelter raycasting precision.** Camera angles + floor plane geometry can produce hit points slightly off the expected cell. Mitigation: compute cell from hit point using the *same* presenceProjector math the renderer uses for placement; if rounding differs, agents will spawn slightly offset. ~3 hours to get right.
- **Drag image trail.** Dragged element should show a ghost. The browser default (clone of the dragged element) is fine; no extra work unless it looks ugly.
- **Touch devices.** HTML5 DnD is mouse-only on most touch browsers. Out of scope.
- **Race condition.** User drags a Sims character and drops it on Sims (re-spawning themselves). The bridge may reject this as a duplicate. Mitigation: spawn handler in `sims/world.js` returns a soft error; UI shows a toast.

## Related work

- [`src/RoomMap.jsx`](../src/RoomMap.jsx) — already has the MIME pattern; this card extends.
- [`src/lib/shelterWorld/presenceProjector.js`](../src/lib/shelterWorld/presenceProjector.js) — coord mapping math.
