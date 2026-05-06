# Shelter — data backend

Plan for the Shelter view's data layer, focusing on **characters first**.
Companion to [shelter-view.md](./shelter-view.md), which covers the
rendering side. This doc is the architectural backbone.

## Goal

Shelter's diorama rooms should be populated by the **same agents** that
exist in the Agent Sandbox — same npub identity, same Trellis/UniRig
3D model, same kimodo idle animation. The 2D-image → animated-character
asset pipeline must work end-to-end through both Sims *and* Shelter
without divergence.

## Defaults

Pre-decided open questions:
- **1:1 room mapping.** One Sims/bridge room ↔ one Shelter cell.
- **Bridge edits in scope.** ~20 lines of additive Node changes to
  `pi-bridge/server.js` are part of the plan (Phase 3).
- **Kimodo is optional.** If `/api/kimodo/*` is unreachable, agents
  fall back to the generic `avatar.glb` template; Shelter still works.
- **Observers filtered.** Only `presence.isAgent === true` is rendered.

## Architecture

Lift the character-loading + animation logic out of `Stage3D.jsx` into
a reusable engine. Both views consume it.

```
src/lib/shelterWorld/
├── characterRegistry.js   poll + merge /characters + /api/kimodo/characters
├── animationLibrary.js    fetch + cache /api/kimodo/animations/<id>
├── avatarFactory.js       spawn(npub) → { object3d, animator?, dispose }
├── presenceProjector.js   (roomId, tileX, tileY) → world (x, y, z)
└── index.js               public re-exports
```

Engines own state. Views are thin: ShelterStage3D's character loop becomes
"for each presence agent, ask the factory for an avatar instance, place
it at the projected world position, tick animators each frame."

### Module contracts

**characterRegistry.js**
- 5s poll of `GET /characters` and `GET /api/kimodo/characters`.
- Merges into `Map<npub, CharacterEntry>`:
  ```js
  { npub, name, avatarUrl,
    modelUrl?, modelMtime?,        // Trellis/Hunyuan3d static GLB
    kimodoCharId?, kimodoUrl?,     // UniRig-rigged GLB
    mapping?, backend? }
  ```
- Emits a `change` event when an entry's `modelMtime` or
  `kimodoCharId` changes — drives cache invalidation.

**animationLibrary.js**
- Single `Map<id, motionJSON>` cache.
- `getMotion(id)` returns cached or fetches.
- Bootstraps with the standard idle clip on construction.

**avatarFactory.js**
- `spawn(npub) → Promise<{ object3d, animator?, dispose }>`.
- Resolution tiers:
  1. Kimodo-rigged GLB + `KimodoAnimator(mapping)` + idle motion.
  2. Static Trellis mesh, no animation.
  3. Cloned generic `/avatar.glb`.
- Internal load cache keyed by URL — repeat `spawn()` calls for
  agents using the same character don't re-download.

**presenceProjector.js**
- Reads the (extended) `shelter-layout.json` for per-room tile bounds.
- `(roomId, tileX, tileY) → { x, y, z }` in shelter world coords.
- `tileX` → in-room x; `tileY` → in-room z; room's `gridY` gives world y.

## Schema changes

### `public/shelter-layout.json` — extend each room

```diff
 {
   "id": "office-1",
   "name": "Office",
+  "bridgeRoomId": "office",
+  "tileBounds": { "x": 0, "y": 4, "w": 4, "h": 2 },
   ...
 }
```

The `tileBounds` is the rectangle of the bridge's tile coordinate system
that this Shelter cell represents. `presenceProjector` uses it to map
live `(presence.x, presence.y)` into a Shelter world position.

### Bridge `/characters` response — additive fields

Two fields, ~20 lines in `pi-bridge/server.js`:

- `model.modelMtime` — fs mtime of `model.glb`. Drives the registry's
  `change` event when a model is regenerated.
- `model.kimodoCharId` — `unirig_<pubkey[:12]>_<backend>` once UniRig
  completes. Lets the registry match without prefix-string parsing.

Both purely additive — Sims keeps working unchanged.

## Rough-edge fixes folded in

| Survey item | Resolved by |
|---|---|
| UniRig completion timing | Bridge tracks `riggedAt` on character manifest. |
| No backend tracking | `kimodoCharId` already encodes it; surfaced. |
| Trellis cache brittle on regen | Registry emits `change` on `modelMtime` shift; factory respawns. |
| Kimodo registry never re-polled | Registry polls every 5s. |
| Animation IDs hardcoded | `public/shelter-animations.json` declares `{ idle, walk, sit, work }` ids. |
| Foot-drop hack | Per-rig drop in `mapping.metadata.footOffset`; fall back to 0.15 if absent. |

## Phasing

**Phase 1 — extract the engine.** Build `shelterWorld/` modules using
patterns lifted from `Stage3D.jsx` verbatim where possible. No view
changes. Engine usable in isolation.

**Phase 2 — wire Shelter.** Replace static `character()` calls with
engine-spawned avatars driven by `useSandboxRoom`. Keep primitive boxes
as a fallback when no presence agent is in a cell. Schema-extend
`shelter-layout.json` with `bridgeRoomId` + `tileBounds`. End of phase:
agents that spawn in the sandbox visibly appear in their Shelter cell
with the right model and idle animation.

**Phase 3 — bridge additions + e2e verification.** Add `modelMtime` +
`kimodoCharId` fields. Manual e2e: pick an agent → regenerate avatar
→ regenerate T-pose → regenerate model → trigger UniRig → reload
Shelter, confirm the new mesh appears in the same cell. Document the
test in `docs/testing.md`.

**Phase 4 — Sims migration (optional, deferred).** `Stage3D.jsx`
swaps its inline character logic for the engine. Drops ~400 lines.
Spell casting stays Sims-specific and continues to live there.

## Out of scope (for now)

- **Walking between rooms.** Presence updates teleport agents; no
  inter-room corridor animation.
- **Per-character animation selection.** Everyone runs idle.
- **Spell casting in Shelter.** Stays a Sims feature until/unless
  the Shelter design needs it.
- **Sims migration.** Phase 4; ship Shelter first, validate the
  engine, then port.
