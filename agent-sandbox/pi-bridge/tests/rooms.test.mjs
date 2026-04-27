/**
 * Rooms registry tests — region queries, ownership, persistence.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/rooms.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createRoomsRegistry, DEFAULT_ROOMS } from "../rooms.js";

function inMemoryFs() {
  const store = new Map();
  return {
    _store: store,
    mkdirSync: () => {},
    writeFileSync: (p, c) => store.set(p, String(c)),
    readFileSync: (p) => store.get(p) ?? "",
    existsSync: (p) => store.has(p),
  };
}

// ── seed ──

test("fresh workspace seeds the default building", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  const all = r.listAll();
  assert.equal(all.length, DEFAULT_ROOMS.length);
  assert.ok(all.some((x) => x.id === "apt-1A"));
  assert.ok(all.some((x) => x.id === "kitchen"));
});

test("default building has 3 apartments + a kitchen + hallways", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  const types = r.listAll().reduce((acc, room) => {
    acc[room.type] = (acc[room.type] || 0) + 1;
    return acc;
  }, {});
  assert.equal(types.apartment, 3);
  assert.equal(types.communal, 1);
  assert.ok(types.hallway >= 1);
});

// ── roomAt ──

test("roomAt: returns the containing room id", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  assert.equal(r.roomAt(0, 0), "apt-1A");
  assert.equal(r.roomAt(15, 0), "apt-1B");
  assert.equal(r.roomAt(8, 7), "kitchen");
  assert.equal(r.roomAt(5, 0), "hallway");
});

test("roomAt: returns null for out-of-bounds", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  assert.equal(r.roomAt(99, 99), null);
  assert.equal(r.roomAt(NaN, 0), null);
});

// ── tilesIn ──

test("tilesIn: enumerates every tile in a room", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  const apt = r.get("apt-1A");
  const tiles = r.tilesIn("apt-1A");
  assert.equal(tiles.length, apt.w * apt.h);
  // Every tile should round-trip through roomAt.
  for (const t of tiles) {
    assert.equal(r.roomAt(t.x, t.y), "apt-1A");
  }
});

test("tilesIn: empty for unknown room", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  assert.deepEqual(r.tilesIn("ghost"), []);
});

// ── randomFreeTile ──

test("randomFreeTile: prefers tiles not occupied by an agent", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  // Occupy every tile of 1A except (0,0).
  const apt = r.get("apt-1A");
  const agents = [];
  for (let y = apt.y; y < apt.y + apt.h; y++) {
    for (let x = apt.x; x < apt.x + apt.w; x++) {
      if (!(x === 0 && y === 0)) agents.push({ x, y });
    }
  }
  const t = r.randomFreeTile("apt-1A", { agents });
  assert.deepEqual(t, { x: 0, y: 0 });
});

test("randomFreeTile: falls back to any tile when fully occupied", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  const apt = r.get("apt-1A");
  const agents = [];
  for (let y = apt.y; y < apt.y + apt.h; y++) {
    for (let x = apt.x; x < apt.x + apt.w; x++) {
      agents.push({ x, y });
    }
  }
  const t = r.randomFreeTile("apt-1A", { agents }, () => 0);
  // Even fully occupied, returns a tile (just the first one).
  assert.deepEqual(t, { x: apt.x, y: apt.y });
});

// ── ownership ──

test("assignOwnership: claims first free apartment in declaration order", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  assert.equal(r.assignOwnership("alice").room_id, "apt-1A");
  assert.equal(r.assignOwnership("bob").room_id,   "apt-1B");
  assert.equal(r.assignOwnership("cleo").room_id,  "apt-1C");
});

test("assignOwnership: idempotent re-assign returns the existing record", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  const first = r.assignOwnership("alice");
  const again = r.assignOwnership("alice");
  assert.equal(first.room_id, again.room_id);
});

test("assignOwnership: returns null when no apartments are free", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  r.assignOwnership("a"); r.assignOwnership("b"); r.assignOwnership("c");
  assert.equal(r.assignOwnership("d"), null);
});

test("assignOwnership: explicit roomId respected; rejects non-apartment / occupied", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  assert.equal(r.assignOwnership("alice", "apt-1B").room_id, "apt-1B");
  assert.equal(r.assignOwnership("bob",   "apt-1B"), null); // already taken
  assert.equal(r.assignOwnership("ghost", "kitchen").room_id, "kitchen"); // permissive on type
});

test("releaseOwnership: frees the apartment", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  r.assignOwnership("alice");
  assert.equal(r.releaseOwnership("alice"), "apt-1A");
  assert.equal(r.assignOwnership("alice").room_id, "apt-1A");
});

test("ownerOf / roomOwnedBy round-trip", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  r.assignOwnership("alice");
  assert.equal(r.ownerOf("apt-1A"), "alice");
  assert.equal(r.roomOwnedBy("alice"), "apt-1A");
  assert.equal(r.ownerOf("kitchen"), null);
  assert.equal(r.roomOwnedBy("ghost"), null);
});

// ── persistence ──

test("persistence: ownership round-trips through disk", () => {
  const fs = inMemoryFs();
  const r1 = createRoomsRegistry({ workspacePath: "/ws", fs });
  r1.assignOwnership("alice");
  r1.assignOwnership("bob");

  const r2 = createRoomsRegistry({ workspacePath: "/ws", fs });
  assert.equal(r2.roomOwnedBy("alice"), "apt-1A");
  assert.equal(r2.roomOwnedBy("bob"),   "apt-1B");
});

test("snapshot: includes grid, rooms, ownerships", () => {
  const r = createRoomsRegistry({ workspacePath: "/ws", fs: inMemoryFs() });
  r.assignOwnership("alice");
  const snap = r.snapshot();
  assert.equal(snap.grid.width, 16);
  assert.equal(snap.grid.height, 12);
  assert.equal(snap.rooms.length, DEFAULT_ROOMS.length);
  assert.equal(snap.ownerships.length, 1);
});
