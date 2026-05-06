# Shelter view — Fallout-Shelter-style side-section, 3D rooms

Plan for the second game variant at `#/shelter` (sibling of the
existing `#/game` "Sims" view). Single-purpose: render the woid world
as a vertical cross-section of stacked rooms, each cell a tiny live
3D scene, with agents arriving from the top-left and the player
expanding the shelter downward.

Companion research: [Fallout Shelter-likes & the Severance pitch](/docs/fallout-shelter-likes).

---

## What's already in place (from this pass)

- Sidebar entry: **Game → Sims** (renamed from "Phone") and **Shelter**.
- Route: `#/shelter` parses in `App.jsx` and mounts `views/Shelter.jsx`.
- `Shelter.jsx` currently re-uses the exported `PhoneScreen` from
  `views/Game.jsx` so the two variants share a base while we iterate.
- Sims stays persistently mounted (existing WebGL-context preservation
  trick); Shelter is conditionally mounted while it's a prototype.

The Shelter view is intentionally identical to Sims today. Everything
below is the divergence plan.

---

## Target experience

- Phone-frame portrait viewport (same chrome as Sims).
- Inside the screen: a **single 3D diorama** — every room is a connected
  object in one shared scene, side-on cross-section, all visible
  simultaneously at the right zoom level.
- **Pan**: click/touch-drag the diorama to translate the camera across
  the map. **Zoom**: pinch / scroll-wheel to dolly between "whole
  shelter visible" and "single room filling the screen".
- Surface sits at the top of world-space with the entrance off the top-
  left edge; new agents walk in from there into the surface room.
- Rooms below the surface are tiled in a fixed grid (each room a unit
  rectangle in world XY). Adjacent rooms share walls — no gaps, no
  separate cells. The "shelter" is one continuous cutaway.
- Agents move between rooms by walking inside the same scene: corridors
  and elevator shafts are real geometry, not a separate column.
- **"Dig"** places a new room rectangle into the world below or beside
  an existing one. The whole diorama gets one row taller / wider.

The end-state visual reference is Fallout Shelter (2015) — but as a
true 3D cutaway you can fly the camera around, not a stack of sprite
cells.

---

## Architectural questions to resolve

### 1. Rendering — single scene, one camera

A diorama collapses the earlier "viewport per cell" question. There's
**one canvas, one renderer, one scene, one camera**. Every room is a
`THREE.Group` parented to a world root; layout is just `group.position`
in shared world coordinates. No viewport scheduling, no GL-context
juggling, no DOM ↔ canvas rect mirroring.

This means:

- Room count is bounded by triangle/material budget, not by GL
  contexts. A 30-room shelter is trivially in budget.
- Postprocessing (bloom, vignette, CRT-scanline for Severance flavor)
  is one composer pass over the whole diorama, not per cell.
- We can reuse `Stage3D.jsx` patterns (loaders, kimodo animator hookup,
  spell runtime) but the camera + controls are different enough to
  warrant a sibling `ShelterStage3D.jsx`.

### 2. Camera and controls

Use an **orthographic camera** looking down +Z (or whatever fixes the
side-on cross-section axis). Orthographic is the right call:

- Side-section reads as a flat cutaway — perspective foreshortening
  fights the Fallout-Shelter silhouette.
- Pan = move camera in XY only. Zoom = adjust ortho frustum size
  (`camera.zoom` + `updateProjectionMatrix`). Both are one-line ops.
- Picking is straightforward — raycast from screen-space, no FOV math.

Controls:

- **Drag** → camera XY translation. Constrain to a bounding rect that
  always keeps at least one room on screen.
- **Wheel / pinch** → `camera.zoom` between two clamps. Min zoom shows
  the whole shelter + a margin; max zoom frames roughly one room. Zoom
  toward cursor / pinch midpoint, not toward origin.
- **Tap / click on a room** → soft-focus: tween the camera to center
  that room and zoom to the "single room" level. This replaces the
  Sims `selectedRoomId` "stage tab" UX — there's no tab here, just a
  focus mode.

Don't reuse `OrbitControls` — it's built for orbiting a target. Write
a small `PanZoomControls` (~80 lines) that owns the drag/wheel/pinch
math directly. It's less code than configuring OrbitControls to behave
like a 2D pan-zoomer.

### 3. Room data — reuse or extend

The bridge already serves `/rooms` with `{ id, x, y, w, h, color,
sceneObjects }` (Sims uses this in `Game.jsx`). Shelter needs:

- A **vertical stack ordering** (depth `0..N`). Either reinterpret the
  existing `y` field as depth, or add `shelter: { depth, slot }`
  metadata to each room. Adding metadata is safer — Sims and Shelter
  are different topologies.
- A **room category** (`surface`, `living`, `production`, `mdr`,
  `break-room`, `wellness`, …). Drives cell theme + which 3D props
  load.
- Per-room **agent capacity** and **a "shaft side"** (which side the
  elevator door is on) so the entrance animation is consistent.

Layout is now a 2D placement, not a 1D stack. Each room needs:

- `gridX`, `gridY` — integer cell coords. Rooms larger than 1×1 occupy
  multiple cells; record `gridW`, `gridH`.
- `category` — `surface`, `living`, `mdr`, `break-room`, `wellness`,
  …. Drives the 3D set dressed into the room interior.
- `entranceSide` — which neighbor cell the room connects to (for
  corridor pathing). Usually inferred from adjacency, but explicit
  for surface / elevator anchors.

For the prototype, ship this as a sibling JSON file
(`shelter-layout.json`) loaded by the bridge alongside `/rooms`. Promote
into the bridge once the shape is settled. Sims's `/rooms` topology is
unaffected.

### 4. Agents — entrance and routing

The diorama removes the separate "shaft column" — corridors and the
elevator are real geometry inside the same scene.

- **Spawn point**: a world-space anchor just outside the top-left of
  the surface room. New agents fade in there and walk in across the
  surface floor.
- **Elevator**: a vertical shaft is just a thin tall room category
  spanning multiple gridY cells. Agents in transit walk to the shaft,
  ride it, and exit into the destination room — all animated in shared
  world space.
- **In-room behavior**: same model as Sims — colyseus presence drives
  `(x, y)`; the shelter's world-space transform maps presence coords
  into room-local coords for avatar placement.

Reuse the existing `useSandboxRoom` colyseus hook and `/characters`
enrichment. The new piece is the **walker**: a thin layer that watches
presence "agent moved between rooms" transitions and tweens the avatar
along an A*-like path across cell adjacencies (or just a corridor →
shaft → corridor sequence) instead of teleporting.

### 5. Building outward / downward

Player verb: **"dig"**. Empty cells adjacent to existing rooms (below
or beside) light up at the right zoom level as ghosted "+ excavate"
prompts. Clicking adds a room rectangle at that cell.

- Excavation costs nothing and is instant for the prototype.
- New cell starts as bare dirt; player picks a category from a small
  palette (Living, MDR, Break Room, Wellness, …).
- Picking a category writes a new entry to `shelter-layout.json` via
  the bridge (`POST /shelter/dig` with `{ gridX, gridY, category }`).
- The diorama's bounding rect grows; pan/zoom clamps update so the
  camera can reach the new room.

Hand-wave economy and time-to-build until the layout pipe works.

---

## Build order

Six steps. Each is small enough to ship and look at; nothing later
depends on the next being committed.

1. **Diorama canvas + ortho camera.** Replace Shelter's reused
   PhoneScreen with `ShelterScreen` that mounts `ShelterStage3D.jsx`
   as a fullscreen child. One shared Three.js renderer + scene + ortho
   camera. Render a single coloured plane at world origin so the
   scaffold is visible.
2. **Pan / zoom controls.** Implement `PanZoomControls` (drag to pan,
   wheel + pinch to zoom toward cursor). Clamp pan/zoom to a debug
   rect. Verify on touch + mouse.
3. **Static room grid.** Read `shelter-layout.json` (3–5 hand-authored
   rooms, including a surface). For each room, instantiate a
   `THREE.Group` at `(gridX, gridY)` with a flat coloured backplate +
   a label; parent all rooms to a world root. Camera bounds derive
   from the rooms' bounding rect.
4. **Room dressing.** Per-category 3D sets (MDR terminal cluster, Break
   Room props, Living bunks). Reuse loader patterns from `Stage3D.jsx`.
   Test by picking a category and seeing the right props in the right
   cell.
5. **Agents in rooms.** Plumb colyseus presence + `/characters` from
   the existing `useSandboxRoom` hook. Place each avatar at world
   coords derived from `(roomOrigin + presenceLocalXY)`. Skip walking
   for now — agents pop into their current room.
6. **Walker + entrance + dig.** Add (a) the top-left surface entrance
   walk-in for new agents, (b) the inter-room walker that animates
   along corridors / elevator shafts, and (c) the "+ excavate" ghost
   cells with `POST /shelter/dig`. This step is the genre-defining
   motion + the build loop; worth doing last so the rendering
   foundation is settled.

---

## Open questions / deferred

- **Sims ↔ Shelter coexistence**: Sims is persistently mounted for
  WebGL-context preservation. While Shelter is open, both views own a
  context. On the prototype this is fine; before merging the second
  Stage3D into a shared production view, decide whether to suspend
  Sims's renderer when Shelter is active.
- **Severance theming**: pure cosmetic and out of scope for this plan.
  Once cells render, we can theme cell categories (MDR room with the
  green-numbers terminal, Break Room with the corkboard, etc.).
- **Persistence**: `shelter-layout.json` is fine for prototype; long
  term the bridge should treat shelter rooms as first-class so the
  same world appears in Sims (room map) and Shelter (cross-section).
