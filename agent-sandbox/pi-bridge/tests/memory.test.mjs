/**
 * Memory injection tests — buildMemoryBlock formats past scenes for
 * inclusion in the next user turn.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/memory.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { buildMemoryBlock, DEFAULTS } from "../memory.js";

function makeCtx({ selfPubkey = "alice", sceneMates = [], recentScenesBetween = () => [] } = {}) {
  return { selfPubkey, sceneMates, recentScenesBetween };
}

function makeScene({
  sceneId = "s1",
  participants = ["alice", "bob"],
  endReason = "budget",
  turns = [],
} = {}) {
  return {
    scene_id: sceneId,
    participants,
    end_reason: endReason,
    ts_start: 1000,
    ts_end: 2000,
    turns,
  };
}

// ── empty / null ──

test("returns empty string when selfPubkey missing", () => {
  assert.equal(buildMemoryBlock({}), "");
});

test("returns empty string when no scene-mates", () => {
  assert.equal(buildMemoryBlock(makeCtx({ selfPubkey: "alice" })), "");
});

test("returns empty string when no past scenes between mates", () => {
  const ctx = makeCtx({
    selfPubkey: "alice",
    sceneMates: [{ pubkey: "bob", name: "Bob" }],
    recentScenesBetween: () => [],
  });
  assert.equal(buildMemoryBlock(ctx), "");
});

// ── single past scene ──

test("formats a single past scene with `you` for self and name for mate", () => {
  const past = makeScene({
    turns: [
      { ts: 1000, actor_pubkey: "alice", actor_name: "Alice", verb: "say", args: { text: "hi bob" } },
      { ts: 1100, actor_pubkey: "bob",   actor_name: "Bob",   verb: "say", args: { text: "hey alice" } },
    ],
  });
  const ctx = makeCtx({
    selfPubkey: "alice",
    sceneMates: [{ pubkey: "bob", name: "Bob" }],
    recentScenesBetween: () => [past],
  });
  const block = buildMemoryBlock(ctx);
  assert.match(block, /You and Bob have spoken before:/);
  assert.match(block, /you: "hi bob"/);
  assert.match(block, /Bob: "hey alice"/);
  assert.match(block, /scene s1/);
  assert.match(block, /budget/);
});

// ── multiple past scenes per mate ──

test("renders past scenes oldest-first within a mate's section", () => {
  const olderScene = makeScene({
    sceneId: "s_old",
    turns: [{ ts: 100, actor_pubkey: "alice", actor_name: "Alice", verb: "say", args: { text: "first time" } }],
  });
  const newerScene = makeScene({
    sceneId: "s_new",
    turns: [{ ts: 500, actor_pubkey: "bob", actor_name: "Bob", verb: "say", args: { text: "second time" } }],
  });
  // recentScenesBetween returns newest-first.
  const ctx = makeCtx({
    selfPubkey: "alice",
    sceneMates: [{ pubkey: "bob", name: "Bob" }],
    recentScenesBetween: () => [newerScene, olderScene],
  });
  const block = buildMemoryBlock(ctx);
  const oldIdx = block.indexOf("first time");
  const newIdx = block.indexOf("second time");
  assert.ok(oldIdx >= 0 && newIdx >= 0);
  assert.ok(oldIdx < newIdx, "older scene should appear before newer");
});

// ── per-scene turn cap ──

test("caps turns per scene to maxTurnsPerScene; keeps the tail", () => {
  const turns = [];
  for (let i = 0; i < 10; i++) {
    turns.push({ ts: i, actor_pubkey: "alice", actor_name: "Alice", verb: "say", args: { text: `line ${i}` } });
  }
  const past = makeScene({ turns });
  const ctx = makeCtx({
    selfPubkey: "alice",
    sceneMates: [{ pubkey: "bob", name: "Bob" }],
    recentScenesBetween: () => [past],
  });
  const block = buildMemoryBlock(ctx, { maxTurnsPerScene: 3 });
  // Tail = lines 7, 8, 9
  assert.ok(block.includes("line 7"));
  assert.ok(block.includes("line 8"));
  assert.ok(block.includes("line 9"));
  assert.ok(!block.includes("line 0"));
  assert.ok(!block.includes("line 5"));
});

// ── multi-mate ──

test("includes a section per scene-mate that has past scenes", () => {
  const aliceBob = makeScene({
    sceneId: "s_ab",
    participants: ["alice", "bob"],
    turns: [{ ts: 100, actor_pubkey: "alice", actor_name: "Alice", verb: "say", args: { text: "to bob" } }],
  });
  const aliceCarol = makeScene({
    sceneId: "s_ac",
    participants: ["alice", "carol"],
    turns: [{ ts: 200, actor_pubkey: "alice", actor_name: "Alice", verb: "say", args: { text: "to carol" } }],
  });
  const fetcher = (a, b) => {
    if (a === "alice" && b === "bob") return [aliceBob];
    if (a === "alice" && b === "carol") return [aliceCarol];
    return [];
  };
  const ctx = makeCtx({
    selfPubkey: "alice",
    sceneMates: [
      { pubkey: "bob", name: "Bob" },
      { pubkey: "carol", name: "Carol" },
    ],
    recentScenesBetween: fetcher,
  });
  const block = buildMemoryBlock(ctx);
  assert.match(block, /You and Bob have spoken before:/);
  assert.match(block, /You and Carol have spoken before:/);
  assert.ok(block.includes("to bob"));
  assert.ok(block.includes("to carol"));
});

// ── verb rendering ──

test("renders different verbs distinctly", () => {
  const past = makeScene({
    turns: [
      { actor_pubkey: "bob", actor_name: "Bob", verb: "say_to", args: { recipient: "Alice", text: "you up?" } },
      { actor_pubkey: "alice", actor_name: "Alice", verb: "post", args: { text: "weird night" } },
      { actor_pubkey: "bob", actor_name: "Bob", verb: "move", args: { x: 4, y: 7 } },
      { actor_pubkey: "alice", actor_name: "Alice", verb: "emote", args: { kind: "shrug" } },
    ],
  });
  const ctx = makeCtx({
    selfPubkey: "alice",
    sceneMates: [{ pubkey: "bob", name: "Bob" }],
    recentScenesBetween: () => [past],
  });
  const block = buildMemoryBlock(ctx);
  assert.match(block, /Bob → Alice: "you up\?"/);
  assert.match(block, /you posted: "weird night"/);
  assert.match(block, /Bob moved to \(4, 7\)/);
  assert.match(block, /you shrug\./);
});

test("idle verbs are skipped (noisy)", () => {
  const past = makeScene({
    turns: [
      { actor_pubkey: "alice", actor_name: "Alice", verb: "idle", args: {} },
      { actor_pubkey: "alice", actor_name: "Alice", verb: "say", args: { text: "actually here" } },
    ],
  });
  const ctx = makeCtx({
    selfPubkey: "alice",
    sceneMates: [{ pubkey: "bob", name: "Bob" }],
    recentScenesBetween: () => [past],
  });
  const block = buildMemoryBlock(ctx);
  assert.ok(!block.includes("idle"));
  assert.ok(block.includes("actually here"));
});

// ── budget enforcement ──

test("drops oldest sections when total block exceeds maxBlockChars", () => {
  const longText = "x".repeat(2000);
  const long = (id) => makeScene({
    sceneId: id,
    turns: [{ actor_pubkey: "bob", actor_name: "Bob", verb: "say", args: { text: longText } }],
  });
  const fetcher = (a, b) => {
    if (b === "bob") return [long("with-bob")];
    if (b === "carol") return [long("with-carol")];
    if (b === "dave") return [long("with-dave")];
    return [];
  };
  const ctx = makeCtx({
    selfPubkey: "alice",
    sceneMates: [
      { pubkey: "bob", name: "Bob" },
      { pubkey: "carol", name: "Carol" },
      { pubkey: "dave", name: "Dave" },
    ],
    recentScenesBetween: fetcher,
  });
  const block = buildMemoryBlock(ctx, { maxBlockChars: 2500 });
  assert.ok(block.length <= 2500, `expected ≤ 2500, got ${block.length}`);
  // Drops happen from the front (Bob) — Dave's section is most likely
  // to survive (it was added last to `sections`).
  assert.ok(block.includes("Dave"));
});

test("falls back to single-section truncation when nothing else can be dropped", () => {
  // Per-turn text is truncated at 240 chars in the renderer, so to
  // overflow the block from a single section we need many turns.
  const turns = [];
  for (let i = 0; i < 100; i++) {
    turns.push({
      actor_pubkey: "bob",
      actor_name: "Bob",
      verb: "say",
      args: { text: "y".repeat(200) },
    });
  }
  const past = makeScene({ turns });
  const ctx = makeCtx({
    selfPubkey: "alice",
    sceneMates: [{ pubkey: "bob", name: "Bob" }],
    // Generous per-scene cap so most turns make it through and bust
    // the block budget.
    recentScenesBetween: () => [past],
  });
  const block = buildMemoryBlock(ctx, { maxBlockChars: 500, maxTurnsPerScene: 100 });
  assert.ok(block.length <= 500, `expected ≤ 500, got ${block.length}`);
  assert.match(block, /memory truncated/);
});

// ── unknown actor names fall back to short pubkey ──

test("falls back to short pubkey when actor_name is missing", () => {
  const past = makeScene({
    turns: [
      { actor_pubkey: "abcdef1234567890", verb: "say", args: { text: "no name set" } },
    ],
  });
  const ctx = makeCtx({
    selfPubkey: "alice",
    sceneMates: [{ pubkey: "abcdef1234567890" }],
    recentScenesBetween: () => [past],
  });
  const block = buildMemoryBlock(ctx);
  assert.match(block, /You and abcdef12 have spoken before:/);
  assert.match(block, /abcdef12: "no name set"/);
});
