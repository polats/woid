/**
 * Smart-object type registry tests.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/objects.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { OBJECT_TYPES, OBJECT_TYPE_IDS, getType } from "../objects.js";

test("OBJECT_TYPES exposes the documented starter set", () => {
  for (const id of ["chair", "bed", "bookshelf", "jukebox"]) {
    assert.ok(OBJECT_TYPES[id], `missing type "${id}"`);
  }
});

test("each type declares description, capacity, glyph, defaultState, affordances", () => {
  for (const [id, def] of Object.entries(OBJECT_TYPES)) {
    assert.equal(typeof def.description, "string", `${id}.description`);
    assert.ok(typeof def.capacity === "number" || def.capacity === Infinity, `${id}.capacity`);
    assert.equal(typeof def.glyph, "string", `${id}.glyph`);
    assert.equal(typeof def.defaultState, "object", `${id}.defaultState`);
    assert.ok(Array.isArray(def.affordances), `${id}.affordances`);
  }
});

test("affordance entries declare verb, utility, preconditions, effects", () => {
  for (const [id, def] of Object.entries(OBJECT_TYPES)) {
    for (const aff of def.affordances) {
      assert.equal(typeof aff.verb, "string", `${id} affordance.verb`);
      assert.equal(typeof aff.utility, "object", `${id} affordance.utility`);
      assert.ok(Array.isArray(aff.preconditions), `${id} affordance.preconditions`);
      assert.ok(Array.isArray(aff.effects), `${id} affordance.effects`);
    }
  }
});

test("OBJECT_TYPE_IDS lists all keys", () => {
  assert.deepEqual(new Set(OBJECT_TYPE_IDS), new Set(Object.keys(OBJECT_TYPES)));
});

test("getType returns the right def or null", () => {
  assert.equal(getType("chair"), OBJECT_TYPES.chair);
  assert.equal(getType("nonexistent"), null);
  assert.equal(getType(null), null);
});

test("single-occupant types use capacity=1", () => {
  for (const id of ["chair", "bed"]) {
    assert.equal(OBJECT_TYPES[id].capacity, 1);
  }
});

test("jukebox is shared (capacity=Infinity)", () => {
  assert.equal(OBJECT_TYPES.jukebox.capacity, Infinity);
});
