/**
 * Scene awareness tests.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/scenes.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { chebyshev, inScene, sceneMatesOf, isInScene, resolveRecipient, SCENE_RADIUS } from "../scenes.js";

const SNAP = {
  agents: [
    { npub: "alice", name: "Alice", x: 5, y: 5 },
    { npub: "bob",   name: "Bob",   x: 7, y: 6 },     // 2 tiles from Alice
    { npub: "carol", name: "Carol", x: 12, y: 12 },   // 7 tiles from Alice
    { npub: "dave",  name: "Dave",  x: 8, y: 8 },     // 3 tiles from Alice (boundary)
  ],
};

// ── chebyshev ──

test("chebyshev: diagonal counts as one step per axis (max)", () => {
  assert.equal(chebyshev({ x: 0, y: 0 }, { x: 3, y: 2 }), 3);
  assert.equal(chebyshev({ x: 5, y: 5 }, { x: 5, y: 5 }), 0);
});

test("chebyshev: missing inputs return Infinity", () => {
  assert.equal(chebyshev(null, { x: 0, y: 0 }), Infinity);
  assert.equal(chebyshev({ x: 0, y: 0 }, null), Infinity);
});

// ── inScene ──

test("inScene: characters within radius are in scene", () => {
  assert.equal(inScene(SNAP, "alice", "bob"), true);
});

test("inScene: characters at exact radius are in scene", () => {
  assert.equal(inScene(SNAP, "alice", "dave"), true);
  assert.equal(SCENE_RADIUS, 3);
});

test("inScene: characters beyond radius are not", () => {
  assert.equal(inScene(SNAP, "alice", "carol"), false);
});

test("inScene: same character is not in scene with self", () => {
  assert.equal(inScene(SNAP, "alice", "alice"), false);
});

test("inScene: missing character returns false", () => {
  assert.equal(inScene(SNAP, "alice", "ghost"), false);
});

test("inScene: respects custom radius", () => {
  assert.equal(inScene(SNAP, "alice", "carol", 8), true);
  assert.equal(inScene(SNAP, "alice", "bob", 1), false);
});

// ── sceneMatesOf ──

test("sceneMatesOf: returns pubkeys within radius, excludes self", () => {
  const mates = sceneMatesOf(SNAP, "alice");
  assert.deepEqual(mates.sort(), ["bob", "dave"]);
});

test("sceneMatesOf: missing character returns []", () => {
  assert.deepEqual(sceneMatesOf(SNAP, "ghost"), []);
});

test("sceneMatesOf: empty snapshot returns []", () => {
  assert.deepEqual(sceneMatesOf({ agents: [] }, "alice"), []);
});

test("sceneMatesOf: respects custom radius", () => {
  assert.deepEqual(sceneMatesOf(SNAP, "alice", 1), []);
  assert.deepEqual(sceneMatesOf(SNAP, "alice", 100).sort(), ["bob", "carol", "dave"]);
});

// ── isInScene ──

test("isInScene: true when at least one mate is within radius", () => {
  assert.equal(isInScene(SNAP, "alice"), true);
  // Carol is alone at 12,12.
  assert.equal(isInScene(SNAP, "carol"), false);
});

// ── resolveRecipient ──

test("resolveRecipient: exact npub", () => {
  assert.equal(resolveRecipient(SNAP, "alice"), "alice");
});

test("resolveRecipient: case-insensitive name", () => {
  assert.equal(resolveRecipient(SNAP, "Bob"), "bob");
  assert.equal(resolveRecipient(SNAP, "bob"), "bob");
  assert.equal(resolveRecipient(SNAP, "BOB"), "bob");
});

test("resolveRecipient: tolerates leading @", () => {
  assert.equal(resolveRecipient(SNAP, "@Carol"), "carol");
});

test("resolveRecipient: hex prefix match", () => {
  const snap = {
    agents: [
      { npub: "abcdef1234567890aabb", name: "Real" },
      { npub: "ffeeaabbccddee1122", name: "Other" },
    ],
  };
  assert.equal(resolveRecipient(snap, "abcdef12"), "abcdef1234567890aabb");
});

test("resolveRecipient: short hex doesn't fuzzy-match", () => {
  const snap = { agents: [{ npub: "abcdef1234", name: "Foo" }] };
  // 7 chars — under the 8-char floor.
  assert.equal(resolveRecipient(snap, "abcdef1"), null);
});

test("resolveRecipient: empty / missing returns null", () => {
  assert.equal(resolveRecipient(SNAP, ""), null);
  assert.equal(resolveRecipient(SNAP, "  "), null);
  assert.equal(resolveRecipient(SNAP, null), null);
  assert.equal(resolveRecipient(null, "alice"), null);
});

test("resolveRecipient: unknown name returns null", () => {
  assert.equal(resolveRecipient(SNAP, "Stranger"), null);
});
