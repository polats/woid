/**
 * Maps colyseus presence (bridge tile coords + roomId) into Shelter
 * world coordinates.
 *
 * Each Shelter cell declares the bridge tile rectangle it represents
 * via `bridgeRoomId` + `tileBounds = { x, y, w, h }` in
 * `shelter-layout.json`. Agents whose tile (presence.x, presence.y)
 * falls inside that rectangle are placed inside that cell.
 *
 * Inside a cell, tile-X spans the cell's world width (left → right)
 * and tile-Y spans the cell's world depth (back → front), with the
 * cell's world Y giving floor height.
 */

export function createPresenceProjector({ layout }) {
  const cellW = layout.cellWidth ?? 2
  const cellH = layout.cellHeight ?? 1.1
  // Index rooms by both Shelter id and bridge id for fast lookup.
  const roomsByBridgeId = new Map()
  const roomsById = new Map()
  for (const room of layout.rooms ?? []) {
    const w = room.gridW * cellW
    const h = room.gridH * cellH
    const cx = (room.gridX + room.gridW / 2) * cellW
    const cy = (room.gridY + room.gridH / 2) * cellH
    const meta = { ...room, w, h, cx, cy }
    roomsById.set(room.id, meta)
    if (room.bridgeRoomId) roomsByBridgeId.set(room.bridgeRoomId, meta)
  }

  const project = (roomId, tileX, tileY) => {
    const room = roomsByBridgeId.get(roomId) ?? roomsById.get(roomId)
    if (!room || !room.tileBounds) return null
    const tb = room.tileBounds
    if (tileX < tb.x || tileX >= tb.x + tb.w) return null
    if (tileY < tb.y || tileY >= tb.y + tb.h) return null
    // Normalised position inside the room: 0..1.
    const u = (tileX - tb.x + 0.5) / tb.w
    const v = (tileY - tb.y + 0.5) / tb.h
    // Local x spans the room's width left → right; local z spans the
    // room's depth back → front. Inset 0.1 from each edge so agents
    // don't clip into walls.
    const margin = 0.1
    const lx = -room.w / 2 + margin + u * (room.w - 2 * margin)
    const lz = -room.w * 0   // unused — depth uses tileY → z below
    const ROOM_DEPTH = 3.0
    const innerD = ROOM_DEPTH - 2 * margin
    const lzFinal = -ROOM_DEPTH / 2 + margin + v * innerD
    const fy = -room.h / 2  // floor level local
    return {
      roomId: room.id,
      world: { x: room.cx + lx, y: room.cy + fy, z: lzFinal },
    }
  }

  /**
   * Find the room that contains a given (tileX, tileY) without
   * requiring the bridge roomId. Useful when presence carries only
   * coords. Returns the project() result or null.
   */
  const projectByTile = (tileX, tileY) => {
    for (const room of roomsById.values()) {
      const tb = room.tileBounds
      if (!tb) continue
      if (tileX < tb.x || tileX >= tb.x + tb.w) continue
      if (tileY < tb.y || tileY >= tb.y + tb.h) continue
      return project(room.id, tileX, tileY)
    }
    return null
  }

  /**
   * Local-store projection: ShelterStore agents carry
   * `pos = { roomId, localU, localV }` already in [0,1] room-local
   * coords (no bridge tiles involved). Map directly to world.
   * `roomId` is the *Shelter* id (matches `room.id` in the layout).
   */
  const projectLocal = (roomId, localU, localV) => {
    const room = roomsById.get(roomId)
    if (!room) return null
    const margin = 0.1
    const ROOM_DEPTH = 3.0
    // Floor slab thickness — must match `floorT` in ShelterStage3D's
    // buildShell. `room.h / 2` is the bottom of the slab in room-local
    // y; adding floorT gets the top surface where agents stand.
    const FLOOR_T = 0.08
    const innerW = room.w - 2 * margin
    const innerD = ROOM_DEPTH - 2 * margin
    const lx = -room.w / 2 + margin + localU * innerW
    const lz = -ROOM_DEPTH / 2 + margin + localV * innerD
    const fy = -room.h / 2 + FLOOR_T
    return {
      roomId: room.id,
      world: { x: room.cx + lx, y: room.cy + fy, z: lz },
    }
  }

  return { project, projectByTile, projectLocal, roomsById, roomsByBridgeId }
}
