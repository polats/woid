import { test } from "node:test";
import assert from "node:assert/strict";
import { createRelationships } from "../relationships.js";

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

test("recordEncounter: first call creates a record (created=true)", () => {
  const r = createRelationships({ workspacePath: "/ws", fs: inMemoryFs(), now: () => 100 });
  const out = r.recordEncounter("alice", "bob");
  assert.equal(out.created, true);
  assert.equal(out.record.scenes_count, 1);
  assert.equal(out.record.from_pubkey, "alice");
  assert.equal(out.record.to_pubkey, "bob");
});

test("recordEncounter: subsequent calls bump scenes_count (created=false)", () => {
  const r = createRelationships({ workspacePath: "/ws", fs: inMemoryFs(), now: () => 100 });
  r.recordEncounter("alice", "bob");
  const second = r.recordEncounter("alice", "bob");
  assert.equal(second.created, false);
  assert.equal(second.record.scenes_count, 2);
});

test("recordEncounter: order-independent (a,b) === (b,a)", () => {
  const r = createRelationships({ workspacePath: "/ws", fs: inMemoryFs() });
  const ab = r.recordEncounter("alice", "bob");
  const ba = r.recordEncounter("bob", "alice");
  assert.equal(ab.created, true);
  assert.equal(ba.created, false);
  assert.equal(ba.record.scenes_count, 2);
});

test("recordEncounter: ignores self-pair", () => {
  const r = createRelationships({ workspacePath: "/ws", fs: inMemoryFs() });
  const out = r.recordEncounter("alice", "alice");
  assert.equal(out.created, false);
  assert.equal(out.record, null);
});

test("recordEncounter: stamps sim_iso when provided", () => {
  const r = createRelationships({ workspacePath: "/ws", fs: inMemoryFs() });
  const out = r.recordEncounter("alice", "bob", { sim_iso: "Day 3 · 09:14", sim_day: 3 });
  assert.equal(out.record.met_at_sim_iso, "Day 3 · 09:14");
  assert.equal(out.record.met_at_sim_day, 3);
});

test("get: returns the record both ways", () => {
  const r = createRelationships({ workspacePath: "/ws", fs: inMemoryFs() });
  r.recordEncounter("alice", "bob");
  assert.ok(r.get("alice", "bob"));
  assert.ok(r.get("bob", "alice"));
  assert.equal(r.get("alice", "ghost"), null);
});

test("listFor: filters to records mentioning the pubkey", () => {
  const r = createRelationships({ workspacePath: "/ws", fs: inMemoryFs() });
  r.recordEncounter("alice", "bob");
  r.recordEncounter("alice", "carl");
  r.recordEncounter("bob", "carl");
  assert.equal(r.listFor("alice").length, 2);
  assert.equal(r.listFor("bob").length, 2);
  assert.equal(r.listFor("ghost").length, 0);
});

test("persistence: round-trips through disk", () => {
  const fs = inMemoryFs();
  const r1 = createRelationships({ workspacePath: "/ws", fs });
  r1.recordEncounter("alice", "bob");
  r1.recordEncounter("alice", "bob"); // bump

  const r2 = createRelationships({ workspacePath: "/ws", fs });
  const rec = r2.get("alice", "bob");
  assert.ok(rec);
  assert.equal(rec.scenes_count, 2);
});
