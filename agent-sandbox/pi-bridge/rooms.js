/**
 * Rooms — named regions on the existing tile grid.
 *
 * Slice-1 representation: each room is a rectangle on the same flat
 * grid the tile renderer already uses. Characters' positions stay
 * `{x, y}` (no schema migration); we *derive* `currentRoomFor(x, y)`
 * by lookup. This keeps Phase A of #285's plan minimal — rooms are
 * additive metadata over the existing world, no canvas redesign yet.
 *
 * Default building (16×12 grid):
 *
 *     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15
 *   ┌─────────────┬───────────────────┬─────────────┐
 *   │   apt-1A    │     hallway       │    apt-1B   │   y=0..3
 *   │  (owner 1)  │                   │  (owner 2)  │
 *   ├─────────────┴───────────────────┴─────────────┤
 *   │                  hallway                      │   y=4..5
 *   ├─────────────────────────────────────────────  │
 *   │                                               │
 *   │              kitchen (communal)               │   y=6..9
 *   │                                               │
 *   ├───────────────────────────┬───────────────────┤
 *   │           apt-1C          │     hallway       │   y=10..11
 *   │         (owner 3)         │                   │
 *   └───────────────────────────┴───────────────────┘
 *
 * Three named apartments + a hallway that wraps the kitchen + a big
 * communal kitchen. This is the "Tomodachi-shape" baseline for
 * scheduled meetings: characters whose schedule says "morning kitchen"
 * collide naturally because there's only one kitchen.
 *
 * `owner_pubkey` is bound at first-spawn (assignDefaultApartment) so
 * the first three characters created automatically claim 1A/1B/1C.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_NAME = "rooms.json";

export const DEFAULT_GRID = { width: 16, height: 12 };

/**
 * Default room rectangles for a fresh workspace. Each rect is
 * inclusive of x..x+w-1, y..y+h-1.
 */
export const DEFAULT_ROOMS = [
  { id: "apt-1A",  name: "1A — apartment",       type: "apartment", x:  0, y:  0, w: 5,  h: 4 },
  { id: "hallway", name: "Hallway",              type: "hallway",   x:  5, y:  0, w: 6,  h: 6 },
  { id: "apt-1B",  name: "1B — apartment",       type: "apartment", x: 11, y:  0, w: 5,  h: 4 },
  { id: "kitchen", name: "Kitchen (communal)",   type: "communal",  x:  0, y:  6, w: 16, h: 4 },
  { id: "apt-1C",  name: "1C — apartment",       type: "apartment", x:  0, y: 10, w: 9,  h: 2 },
  { id: "hallway-south", name: "South hallway",  type: "hallway",   x:  9, y: 10, w: 7,  h: 2 },
];

/**
 * @param {{
 *   workspacePath: string,
 *   fs?: { mkdirSync, existsSync, readFileSync, writeFileSync },
 *   gridWidth?: number,
 *   gridHeight?: number,
 * }} opts
 */
export function createRoomsRegistry(opts = {}) {
  if (!opts.workspacePath) throw new Error("createRoomsRegistry: workspacePath required");
  const fsImpl = opts.fs ?? { mkdirSync, existsSync, readFileSync, writeFileSync };
  const grid = {
    width:  opts.gridWidth  ?? DEFAULT_GRID.width,
    height: opts.gridHeight ?? DEFAULT_GRID.height,
  };
  const path = join(opts.workspacePath, FILE_NAME);

  /** @type {Map<string, object>} id → room */
  const rooms = new Map();
  /** @type {{ pubkey: string, room_id: string }[]} */
  let ownerships = [];

  loadFromDisk();
  if (rooms.size === 0) seed(DEFAULT_ROOMS);

  function seed(defs) {
    rooms.clear();
    for (const r of defs) {
      rooms.set(r.id, { ...r, owner_pubkey: r.owner_pubkey ?? null });
    }
    persist();
  }

  function listAll() {
    // Resolve ownership map onto each room each time we list.
    const map = ownershipMap();
    return [...rooms.values()].map((r) => ({
      ...r,
      owner_pubkey: map.get(r.id) ?? r.owner_pubkey ?? null,
    }));
  }

  function get(id) {
    const r = rooms.get(id);
    if (!r) return null;
    const owner = ownershipMap().get(id) ?? r.owner_pubkey ?? null;
    return { ...r, owner_pubkey: owner };
  }

  /**
   * Which room (id) contains the tile (x, y)? First-match wins —
   * default layout is non-overlapping so this is unambiguous.
   * Returns null if the tile is outside every room.
   */
  function roomAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const r of rooms.values()) {
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.id;
    }
    return null;
  }

  /**
   * Iterate every (x, y) tile inside `roomId`. Cheap for our grid.
   */
  function tilesIn(roomId) {
    const r = rooms.get(roomId);
    if (!r) return [];
    const out = [];
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        out.push({ x, y });
      }
    }
    return out;
  }

  /**
   * A free tile inside `roomId`, prefer-anything-not-occupied. The
   * snapshot is the room-server's presence array; we treat any tile
   * with an agent on it as taken so two characters don't stack.
   * Falls back to a random tile inside the room when fully occupied.
   *
   * @param {string} roomId
   * @param {{ agents?: Array<{ x: number, y: number }> }} [snapshot]
   * @param {() => number} [random]
   * @returns {{ x: number, y: number } | null}
   */
  function randomFreeTile(roomId, snapshot, random = Math.random) {
    const all = tilesIn(roomId);
    if (all.length === 0) return null;
    const occupied = new Set(
      (snapshot?.agents ?? []).map((a) => `${a.x},${a.y}`),
    );
    const free = all.filter((t) => !occupied.has(`${t.x},${t.y}`));
    const pool = free.length > 0 ? free : all;
    return pool[Math.floor(random() * pool.length)];
  }

  /**
   * Center tile of a room — used for "rough" target moves and for UI
   * rendering room labels.
   */
  function centerTile(roomId) {
    const r = rooms.get(roomId);
    if (!r) return null;
    return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
  }

  /**
   * Bind a character to an apartment. Idempotent — if the pubkey
   * already owns a room, nothing changes. If the requested room
   * is occupied, returns null. Default apartments are claimed in
   * order (1A → 1B → 1C) when no roomId is given.
   */
  function assignOwnership(pubkey, roomId) {
    if (!pubkey) return null;
    const existing = ownerships.find((o) => o.pubkey === pubkey);
    if (existing) return existing;
    if (!roomId) {
      const map = ownershipMap();
      const apartments = [...rooms.values()].filter((r) => r.type === "apartment");
      const free = apartments.find((r) => !map.has(r.id));
      if (!free) return null;
      roomId = free.id;
    } else if (!rooms.has(roomId)) {
      return null;
    } else if (ownershipMap().has(roomId)) {
      return null;
    }
    const rec = { pubkey, room_id: roomId };
    ownerships.push(rec);
    persist();
    return rec;
  }

  /**
   * Drop the binding for `pubkey`. Returns the released room id (if any).
   */
  function releaseOwnership(pubkey) {
    const idx = ownerships.findIndex((o) => o.pubkey === pubkey);
    if (idx < 0) return null;
    const released = ownerships[idx].room_id;
    ownerships.splice(idx, 1);
    persist();
    return released;
  }

  function ownerOf(roomId) {
    return ownershipMap().get(roomId) ?? null;
  }

  function roomOwnedBy(pubkey) {
    if (!pubkey) return null;
    const found = ownerships.find((o) => o.pubkey === pubkey);
    return found?.room_id ?? null;
  }

  function ownershipMap() {
    const m = new Map();
    for (const o of ownerships) m.set(o.room_id, o.pubkey);
    return m;
  }

  function snapshot() {
    return {
      grid: { ...grid },
      rooms: listAll(),
      ownerships: [...ownerships],
    };
  }

  // ── persistence ──

  function loadFromDisk() {
    if (!fsImpl.existsSync(path)) return;
    try {
      const data = JSON.parse(fsImpl.readFileSync(path, "utf-8"));
      if (Array.isArray(data?.rooms)) {
        for (const r of data.rooms) {
          if (r?.id) rooms.set(r.id, r);
        }
      }
      if (Array.isArray(data?.ownerships)) {
        ownerships = data.ownerships.filter((o) => o?.pubkey && o?.room_id);
      }
    } catch (err) {
      console.error(`[rooms] load ${path} failed:`, err?.message || err);
    }
  }

  function persist() {
    try {
      fsImpl.mkdirSync(dirname(path), { recursive: true });
      fsImpl.writeFileSync(path, JSON.stringify({
        grid,
        rooms: [...rooms.values()],
        ownerships,
      }, null, 2));
    } catch (err) {
      console.error(`[rooms] persist ${path} failed:`, err?.message || err);
    }
  }

  return {
    seed, listAll, get, roomAt, tilesIn, randomFreeTile, centerTile,
    assignOwnership, releaseOwnership, ownerOf, roomOwnedBy,
    snapshot,
    _path: path,
    _grid: grid,
  };
}
