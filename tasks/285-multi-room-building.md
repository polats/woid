---
name: World — Multi-room building map
description: Replace the single-grid map with a building of rooms connected by hallways. Each character gets their own apartment; new rooms unlock as residents and shared objects are added. Tomodachi-Life shape.
status: in_progress
order: 285
epic: world
---

Architectural change to the map model, specified in [docs/design/building.md](../docs/design/building.md). The current `width × height` single-grid lets characters mill around the same room; for the [vertical slice](../docs/design/vertical-slice.md) audience, "my apartment" is the load-bearing emotional unit.

## Slices

### Phase A — schema only, no UI change

- New `agent-sandbox/pi-bridge/building.js` module mirroring `objects-registry.js` patterns.
- Building/Room/Door schemas per [docs/design/building.md §2.1](../docs/design/building.md#21-building--rooms).
- Persisted at `$WORKSPACE/building.json`. On boot, seeds the default 2-apartment + 1-hallway + outdoor + locked-lobby + locked-stairs layout if missing.
- One-time migration: existing characters and objects get `position.room_id` defaulting to `'default'`. Workspaces upgrade transparently.
- `gm.js`'s `move` verb gains optional `room_id` arg.
- Tests: existing scene/proximity tests still pass with everyone in `room_id: 'default'`.

### Phase B — multi-room rendering

- New `src/BuildingCanvas.jsx` replacing `RoomMap.jsx` for multi-room workspaces (single-room workspaces still render the old grid for compatibility).
- Each room rendered as a sub-grid; canvas pans/zooms; double-click → focus mode.
- Locked rooms render as ghosted outlines with unlock condition labels.
- Drag-and-drop and click-to-move work within the focused room.
- HTTP: `GET /building`, `GET /rooms/:id`.

### Phase C — unlocks + cross-room movement

- `move(room_id, x, y)` cross-room verb routes through doors. Animation = fade-out / fade-in; no per-tile path animation needed for prototype.
- `roomMatesOf(snapshot, pubkey)` helper added to `scenes.js` — returns everyone in the same room regardless of tile distance.
- Card frontmatter gains `room:` (target room for the card) and `room_unlock:` (unlock condition cards) keys.
- Object purchase via shop unlocks shared rooms per the unlock table in [docs/design/building.md §3.2](../docs/design/building.md#32-room-unlocks-open-new-spaces-in-the-building).
- Inter-room window stub: rooms can declare `window_to: <room_id>`; perception queries can include 1-window-hop adjacency.

## Acceptance

- A fresh workspace boots into the default building (1A occupied by founder Mara; 1B for the player; one hallway; locked lobby and 2A visible as ghosted outlines).
- Spawning a character into 1B places them in that apartment, not in a single big grid.
- Welcoming a 3rd resident unlocks 2A; the canvas re-renders to include it.
- Buying a kettle and placing it in the hallway upgrades the hallway to a communal kitchen room.
- Existing single-room workspaces keep working; their characters are migrated to a single `default` room without manual intervention.
- Two characters in different rooms are NOT scene-mates; two characters in the same room within `SCENE_RADIUS` ARE.

## Non-goals

- Per-tile pathfinding through doors (fade-transition is acceptable for prototype).
- Multi-floor staircase animation.
- Procedural building generation — layout is hand-authored seed; expansions are explicit unlocks.
- Custom apartment layouts per resident — geometry standardized, contents vary (Tomodachi pattern).
- Building-level multi-tenancy (multiple buildings per workspace) — defer to #205 storage scale-out.

## Risk notes

- The position migration is the riskiest mechanical step. Write it idempotent and ship behind a `BUILDING_MIGRATION=on` flag for the first deploy.
- Colyseus state schema changes affect both server and client; coordinate the deploy.
- Visual style of the building canvas is up for grabs — top-down vs cross-section vs side-on. Mock both before committing the renderer.
