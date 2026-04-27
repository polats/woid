/**
 * Scene summary tests — deterministic fallback shape, LLM happy path,
 * LLM validation/clamping, prompt builder.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/scene-summary.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeSceneToMoodlets, buildSceneSummaryPrompt } from "../scene-summary.js";

const ALICE = "alice000000000000000000000000000000000000000000000000000000000a";
const BOB   = "bob00000000000000000000000000000000000000000000000000000000000b";

const sceneFor = (reason) => ({
  scene_id: "s1",
  participants: [ALICE, BOB],
  end_reason: reason,
  turns: [
    { actor_pubkey: ALICE, actor_name: "Alice", verb: "say", args: { text: "morning" } },
    { actor_pubkey: BOB,   actor_name: "Bob",   verb: "say", args: { text: "morning" } },
  ],
});

const resolve = (pk) =>
  pk === ALICE ? { name: "Alice", about: "early riser, quiet" } :
  pk === BOB   ? { name: "Bob",   about: "night owl, sharp" } : null;

// ── deterministic fallback ──

test("fallback: emits one moodlet per pair (each participant gets one)", async () => {
  const { moodlets, source } = await summarizeSceneToMoodlets(sceneFor("budget"), { resolveCharacter: resolve });
  assert.equal(source, "fallback");
  assert.equal(moodlets.length, 2);
  const owners = moodlets.map((m) => m.pubkey).sort();
  assert.deepEqual(owners, [ALICE, BOB].sort());
});

test("fallback: budget end → +2 weight 'real conversation'", async () => {
  const { moodlets } = await summarizeSceneToMoodlets(sceneFor("budget"), { resolveCharacter: resolve });
  for (const m of moodlets) {
    assert.equal(m.weight, +2);
    assert.match(m.reason, /real conversation with/);
  }
});

test("fallback: hard_cap → -1 weight 'too much time'", async () => {
  const { moodlets } = await summarizeSceneToMoodlets(sceneFor("hard_cap"), { resolveCharacter: resolve });
  for (const m of moodlets) {
    assert.equal(m.weight, -1);
    assert.match(m.reason, /too much time with/);
  }
});

test("fallback: proximity_lost → +1 'brief encounter'", async () => {
  const { moodlets } = await summarizeSceneToMoodlets(sceneFor("proximity_lost"), { resolveCharacter: resolve });
  for (const m of moodlets) {
    assert.equal(m.weight, +1);
    assert.match(m.reason, /brief encounter/);
  }
});

test("fallback: tag includes the other pubkey for relationship aggregation", async () => {
  const { moodlets } = await summarizeSceneToMoodlets(sceneFor("budget"), { resolveCharacter: resolve });
  const aliceMl = moodlets.find((m) => m.pubkey === ALICE);
  const bobMl = moodlets.find((m) => m.pubkey === BOB);
  assert.ok(aliceMl.tag.endsWith(`:${BOB}`));
  assert.equal(aliceMl.by, BOB);
  assert.ok(bobMl.tag.endsWith(`:${ALICE}`));
  assert.equal(bobMl.by, ALICE);
});

test("fallback: scene_id and end_reason carried for journal cross-reference", async () => {
  const { moodlets } = await summarizeSceneToMoodlets(sceneFor("budget"), { resolveCharacter: resolve });
  for (const m of moodlets) {
    assert.equal(m.scene_id, "s1");
    assert.equal(m.end_reason, "budget");
  }
});

// ── LLM path ──

test("llm: happy path returns validated moodlets and source: 'llm'", async () => {
  const llm = async () => ({
    moodlets: [
      { pubkey: ALICE, tag: "felt_seen:" + BOB, weight: 4, reason: "Bob really listened this morning" },
      { pubkey: BOB,   tag: "warmed_to:" + ALICE, weight: 3, reason: "Alice has a way of making mornings less sharp" },
    ],
  });
  const { moodlets, source } = await summarizeSceneToMoodlets(sceneFor("budget"), { resolveCharacter: resolve, llm });
  assert.equal(source, "llm");
  assert.equal(moodlets.length, 2);
  assert.equal(moodlets[0].weight, 4);
  assert.equal(moodlets[1].weight, 3);
});

test("llm: clamps weight to [-5, +5]", async () => {
  const llm = async () => ({
    moodlets: [
      { pubkey: ALICE, tag: "x", weight: 999,   reason: "r" },
      { pubkey: BOB,   tag: "y", weight: -999,  reason: "r" },
    ],
  });
  const { moodlets } = await summarizeSceneToMoodlets(sceneFor("budget"), { resolveCharacter: resolve, llm });
  assert.equal(moodlets.find((m) => m.pubkey === ALICE).weight, +5);
  assert.equal(moodlets.find((m) => m.pubkey === BOB).weight, -5);
});

test("llm: filters moodlets pointed at unknown pubkeys", async () => {
  const llm = async () => ({
    moodlets: [
      { pubkey: ALICE, tag: "ok",  weight: 1, reason: "r" },
      { pubkey: "ghost", tag: "x", weight: 1, reason: "r" },
    ],
  });
  const { moodlets } = await summarizeSceneToMoodlets(sceneFor("budget"), { resolveCharacter: resolve, llm });
  assert.equal(moodlets.length, 1);
  assert.equal(moodlets[0].pubkey, ALICE);
});

test("llm: empty/invalid response → falls back to deterministic", async () => {
  const llm = async () => ({ moodlets: [] });
  const { source } = await summarizeSceneToMoodlets(sceneFor("budget"), { resolveCharacter: resolve, llm });
  assert.equal(source, "fallback");
});

test("llm: thrown error → falls back to deterministic", async () => {
  const llm = async () => { throw new Error("nim 503"); };
  const { source } = await summarizeSceneToMoodlets(sceneFor("budget"), { resolveCharacter: resolve, llm });
  assert.equal(source, "fallback");
});

test("llm: trims overlong reason to 120 chars", async () => {
  const longReason = "x".repeat(500);
  const llm = async () => ({
    moodlets: [
      { pubkey: ALICE, tag: "t", weight: 1, reason: longReason },
      { pubkey: BOB,   tag: "t", weight: 1, reason: "ok" },
    ],
  });
  const { moodlets } = await summarizeSceneToMoodlets(sceneFor("budget"), { resolveCharacter: resolve, llm });
  const a = moodlets.find((m) => m.pubkey === ALICE);
  assert.ok(a.reason.length <= 120);
});

// ── prompt builder ──

test("buildSceneSummaryPrompt: includes both names and the transcript", () => {
  const { systemPrompt, userPrompt } = buildSceneSummaryPrompt({
    scene: sceneFor("budget"),
    resolveCharacter: resolve,
  });
  assert.match(systemPrompt, /one short moodlet per participant/);
  assert.match(userPrompt, /Alice/);
  assert.match(userPrompt, /Bob/);
  assert.match(userPrompt, /"morning"/);
  assert.match(userPrompt, /Scene ended: budget/);
});
