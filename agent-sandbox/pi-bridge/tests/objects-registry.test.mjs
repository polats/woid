/**
 * Object-instance registry tests — placement, listing, persistence,
 * proximity query.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/objects-registry.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createObjectsRegistry, seedDefaults } from "../objects-registry.js";

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

let counter = 0;
function fakeId() { return `id_${++counter}`; }

test("placeOne creates an instance with default state", () => {
  counter = 0;
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  const inst = r.placeOne({ type: "chair", x: 5, y: 5 });
  assert.equal(inst.type, "chair");
  assert.equal(inst.x, 5);
  assert.equal(inst.y, 5);
  assert.equal(inst.state.occupant, null);
  assert.equal(typeof inst.id, "string");
});

test("placeOne rejects unknown type", () => {
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  assert.throws(() => r.placeOne({ type: "nonexistent", x: 1, y: 1 }));
});

test("placeOne rejects non-finite coords", () => {
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  assert.throws(() => r.placeOne({ type: "chair", x: "five", y: 1 }));
  assert.throws(() => r.placeOne({ type: "chair", x: 1, y: NaN }));
});

test("placeOne rounds coords to integers", () => {
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  const inst = r.placeOne({ type: "chair", x: 5.7, y: 2.3 });
  assert.equal(inst.x, 6);
  assert.equal(inst.y, 2);
});

test("listAll + remove", () => {
  counter = 0;
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  const a = r.placeOne({ type: "chair", x: 1, y: 1 });
  r.placeOne({ type: "bed", x: 2, y: 2 });
  assert.equal(r.listAll().length, 2);
  assert.equal(r.remove(a.id), true);
  assert.equal(r.listAll().length, 1);
  assert.equal(r.remove("does-not-exist"), false);
});

test("get returns the instance or null", () => {
  counter = 0;
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  const a = r.placeOne({ type: "chair", x: 1, y: 1 });
  assert.equal(r.get(a.id), a);
  assert.equal(r.get("missing"), null);
});

test("nearby returns objects within radius, sorted by distance", () => {
  counter = 0;
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  r.placeOne({ type: "chair", x: 5, y: 5 });
  r.placeOne({ type: "bed",   x: 7, y: 5 }); // chebyshev 2
  r.placeOne({ type: "bookshelf", x: 12, y: 12 }); // far
  const out = r.nearby(5, 5, 3);
  assert.equal(out.length, 2);
  assert.equal(out[0].distance, 0);
  assert.equal(out[1].distance, 2);
  // Far object excluded
  assert.ok(!out.find((o) => o.type === "bookshelf"));
});

test("nearby with no coords returns []", () => {
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  r.placeOne({ type: "chair", x: 0, y: 0 });
  assert.deepEqual(r.nearby(NaN, 0), []);
});

test("patchState merges into instance.state", () => {
  counter = 0;
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  const a = r.placeOne({ type: "jukebox", x: 0, y: 0 });
  assert.equal(a.state.playing, false);
  r.patchState(a.id, { playing: true });
  assert.equal(r.get(a.id).state.playing, true);
});

test("patchState on unknown id returns null", () => {
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  assert.equal(r.patchState("ghost", { playing: true }), null);
});

// ── persistence ──

test("persist writes one JSON line per instance", () => {
  counter = 0;
  const fs = inMemoryFs();
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs, id: fakeId });
  r.placeOne({ type: "chair", x: 1, y: 1 });
  r.placeOne({ type: "bed", x: 2, y: 2 });
  const text = fs._store.get("/tmp/ws/objects.jsonl");
  const lines = text.split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  for (const line of lines) JSON.parse(line); // no throw
});

test("hydrates from existing JSONL on construction", () => {
  const fs = inMemoryFs();
  fs.writeFileSync(
    "/tmp/ws/objects.jsonl",
    JSON.stringify({ id: "a", type: "chair", x: 1, y: 1, state: { occupant: null } }) + "\n" +
    JSON.stringify({ id: "b", type: "bed", x: 2, y: 2, state: { occupant: null } }) + "\n",
  );
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs });
  assert.equal(r.listAll().length, 2);
  assert.equal(r.get("a").type, "chair");
});

test("hydration tolerates malformed lines", () => {
  const fs = inMemoryFs();
  fs.writeFileSync(
    "/tmp/ws/objects.jsonl",
    JSON.stringify({ id: "a", type: "chair", x: 1, y: 1 }) + "\n" +
    "this is not json\n" +
    JSON.stringify({ id: "b", type: "bed", x: 2, y: 2 }) + "\n",
  );
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs });
  assert.equal(r.listAll().length, 2);
});

test("hydration drops instances of unknown types", () => {
  const fs = inMemoryFs();
  fs.writeFileSync(
    "/tmp/ws/objects.jsonl",
    JSON.stringify({ id: "a", type: "chair", x: 1, y: 1 }) + "\n" +
    JSON.stringify({ id: "b", type: "deprecated_thing", x: 2, y: 2 }) + "\n",
  );
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs });
  assert.equal(r.listAll().length, 1);
});

test("clear empties everything", () => {
  counter = 0;
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  r.placeOne({ type: "chair", x: 1, y: 1 });
  r.clear();
  assert.equal(r.listAll().length, 0);
});

// ── snapshot ──

test("snapshot reports count and per-type breakdown", () => {
  counter = 0;
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  r.placeOne({ type: "chair", x: 1, y: 1 });
  r.placeOne({ type: "chair", x: 2, y: 2 });
  r.placeOne({ type: "bed", x: 3, y: 3 });
  const snap = r.snapshot();
  assert.equal(snap.count, 3);
  assert.deepEqual(snap.types, { chair: 2, bed: 1 });
});

// ── seedDefaults ──

test("seedDefaults populates an empty registry once; idempotent on re-call", () => {
  counter = 0;
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  const first = seedDefaults(r);
  assert.ok(first.length > 0);
  const second = seedDefaults(r);
  assert.equal(second.length, 0);
});

test("seedDefaults respects custom placements", () => {
  counter = 0;
  const r = createObjectsRegistry({ workspacePath: "/tmp/ws", fs: inMemoryFs(), id: fakeId });
  const placed = seedDefaults(r, {
    placements: [{ type: "chair", x: 3, y: 3 }],
  });
  assert.equal(placed.length, 1);
  assert.equal(placed[0].type, "chair");
});
