/**
 * Rooms — named regions on the existing tile grid.
 *
 * Levels are pure data: each `levels/<name>.json` file declares a
 * grid, a list of rooms (with optional `color`), a list of doors,
 * and an optional list of object placements. Add a new level by
 * dropping a new JSON file in `levels/`; nothing here needs to change.
 *
 * Doors become first-class single-tile rooms with `type: "door"`.
 * `roomAt(x, y)` checks doors first so a door tile resolves to the
 * door id, not the room it's carved into.
 *
 * `owner_pubkey` is bound at first-spawn (assignOwnership) so the
 * first N characters created automatically claim apartments in order.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE_NAME = "rooms.json";
const LEVELS_DIR = join(dirname(fileURLToPath(import.meta.url)), "levels");

/**
 * Read every `levels/*.json` file into the LAYOUTS map. Door entries
 * get the standard `name`/`type`/`w`/`h` fields applied so callers
 * can treat them as just-another-room.
 */
function loadLayoutsFromDisk() {
  const out = {};
  let files = [];
  try { files = readdirSync(LEVELS_DIR).filter((f) => f.endsWith(".json")); }
  catch { return out; }
  for (const f of files) {
    const name = f.replace(/\.json$/, "");
    const filePath = join(LEVELS_DIR, f);
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const mtime = statSync(filePath).mtimeMs;
      const doors = (raw.doors ?? []).map((d) => ({
        ...d,
        name: d.name ?? `Door (${(d.between ?? []).join(" ↔ ")})`,
        type: "door",
        w: 1, h: 1,
      }));
      out[name] = {
        grid: raw.grid,
        rooms: raw.rooms ?? [],
        doors,
        objects: raw.objects ?? [],
        mtime,
      };
    } catch (err) {
      console.error(`[rooms] failed to load level ${f}:`, err?.message || err);
    }
  }
  return out;
}

export const LAYOUTS = loadLayoutsFromDisk();

export const DEFAULT_LAYOUT = "simple";

// Back-compat exports — point at the active default layout.
export const DEFAULT_GRID = LAYOUTS[DEFAULT_LAYOUT].grid;
export const DEFAULT_ROOMS = LAYOUTS[DEFAULT_LAYOUT].rooms;

/** Object placements declared in the level file (used to seed objects-registry). */
export function defaultObjectPlacements(layoutName = DEFAULT_LAYOUT) {
  return LAYOUTS[layoutName]?.objects ?? [];
}

/**
 * @param {{
 *   workspacePath: string,
 *   fs?: { mkdirSync, existsSync, readFileSync, writeFileSync },
 *   layout?: keyof typeof LAYOUTS,
 *   gridWidth?: number,
 *   gridHeight?: number,
 * }} opts
 */
export function createRoomsRegistry(opts = {}) {
  if (!opts.workspacePath) throw new Error("createRoomsRegistry: workspacePath required");
  const fsImpl = opts.fs ?? { mkdirSync, existsSync, readFileSync, writeFileSync };
  const layoutName = opts.layout ?? DEFAULT_LAYOUT;
  const layout = LAYOUTS[layoutName];
  if (!layout) throw new Error(`createRoomsRegistry: unknown layout "${layoutName}"`);

  const grid = {
    width:  opts.gridWidth  ?? layout.grid.width,
    height: opts.gridHeight ?? layout.grid.height,
  };
  const path = join(opts.workspacePath, FILE_NAME);

  /** @type {Map<string, object>} id → room (includes door rooms) */
  const rooms = new Map();
  /** @type {{ pubkey: string, room_id: string }[]} */
  let ownerships = [];
  /** mtime of the level file the persisted rooms.json was seeded from */
  let persistedSourceMtime = 0;

  loadFromDisk();
  // Reseed when the level file on disk is newer than the snapshot
  // we persisted last — lets a JSON edit propagate without needing
  // a manual `rm /workspace/rooms.json`. Ownerships live in their
  // own array and survive the reseed unchanged.
  const layoutMtime = layout.mtime ?? 0;
  if (rooms.size === 0) {
    seed([...layout.rooms, ...layout.doors]);
  } else if (layoutMtime > persistedSourceMtime) {
    console.log(`[rooms] level "${layoutName}" is newer than persisted snapshot — reseeding`);
    seed([...layout.rooms, ...layout.doors]);
  }

  function seed(defs) {
    rooms.clear();
    for (const r of defs) {
      rooms.set(r.id, { ...r, owner_pubkey: r.owner_pubkey ?? null });
    }
    persist();
  }

  function listAll() {
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
   * Which room (id) contains the tile (x, y)? Doors are checked first
   * so a tile carved into a wall resolves to the door, not the room
   * the door rect overlaps. Returns null if outside every room.
   */
  function roomAt(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    for (const r of rooms.values()) {
      if (r.type !== "door") continue;
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.id;
    }
    for (const r of rooms.values()) {
      if (r.type === "door") continue;
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r.id;
    }
    return null;
  }

  /**
   * Iterate every (x, y) tile inside `roomId` whose `roomAt` resolves
   * back to `roomId`. This naturally excludes door tiles that overlap
   * the room rect.
   */
  function tilesIn(roomId) {
    const r = rooms.get(roomId);
    if (!r) return [];
    const out = [];
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (roomAt(x, y) === roomId) out.push({ x, y });
      }
    }
    return out;
  }

  /**
   * A free tile inside `roomId`, prefer-anything-not-occupied.
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

  function centerTile(roomId) {
    const r = rooms.get(roomId);
    if (!r) return null;
    return { x: Math.floor(r.x + r.w / 2), y: Math.floor(r.y + r.h / 2) };
  }

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
      layout: layoutName,
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
      if (typeof data?.sourceMtime === "number") {
        persistedSourceMtime = data.sourceMtime;
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
        layout: layoutName,
        sourceMtime: layout.mtime ?? null,
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
    _layout: layoutName,
  };
}
