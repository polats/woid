/**
 * GM tests. Cover the full ten-verb registry from #225 slice 2 plus
 * legacy-shape compatibility, arg validation, and handler errors.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/gm.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createGM, VERBS } from "../gm.js";

function makeStubDeps(overrides = {}) {
  const calls = {
    roomSay: [],
    relayPost: [],
    moveAgent: [],
    saveCharacterManifest: [],
    loadCharacter: [],
  };
  const deps = {
    roomSay: (agentId, content) => {
      calls.roomSay.push({ agentId, content });
    },
    relayPost: async (agentId, content, modelTag) => {
      calls.relayPost.push({ agentId, content, modelTag });
    },
    moveAgent: (agentId, x, y) => {
      calls.moveAgent.push({ agentId, x, y });
    },
    saveCharacterManifest: (pubkey, patch) => {
      calls.saveCharacterManifest.push({ pubkey, patch });
    },
    loadCharacter: (pubkey) => {
      calls.loadCharacter.push({ pubkey });
      return { mood: { energy: 50, social: 50 } };
    },
    ...overrides,
  };
  return { deps, calls };
}

const ctx = { agentId: "agent_1", pubkey: "abc123", model: "test-model" };

// ── factory ──

test("createGM throws when missing deps", () => {
  assert.throws(() => createGM({}));
  assert.throws(() => createGM({ roomSay: () => {} }));
});

test("createGM exposes the full verb registry", () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  for (const v of ["say", "say_to", "move", "face", "wait", "emote", "set_state", "set_mood", "post", "idle"]) {
    assert.ok(gm.verbs[v], `expected verb "${v}" in registry`);
  }
  assert.equal(gm.verbs, VERBS);
});

// ── say ──

test("say: routes to roomSay with trimmed text — no relay", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say", text: "  hello world  " });
  assert.equal(res.ok, true);
  assert.equal(calls.roomSay.length, 1);
  assert.equal(calls.roomSay[0].content, "hello world");
  assert.equal(calls.relayPost.length, 0);
});

test("say: rejects empty text", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say", text: "   " });
  assert.equal(res.ok, false);
  assert.match(res.reason, /non-empty/);
  assert.equal(calls.roomSay.length, 0);
});

test("say: clips text to 1000 chars", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "say", text: "x".repeat(2000) });
  assert.equal(calls.roomSay[0].content.length, 1000);
});

// ── say_to ──

test("say_to: prefixes recipient, single roomSay", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say_to", recipient: "Carlos", text: "you ok?" });
  assert.equal(res.ok, true);
  assert.equal(calls.roomSay.length, 1);
  assert.equal(calls.roomSay[0].content, "@Carlos you ok?");
  assert.equal(calls.relayPost.length, 0);
});

test("say_to: rejects missing recipient", async () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say_to", text: "hello" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /missing arg "recipient"/);
});

// ── move ──

test("move: rounds coords to ints", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "move", x: 3.7, y: 2.2 });
  assert.deepEqual(calls.moveAgent[0], { agentId: "agent_1", x: 4, y: 2 });
});

test("move: rejects non-finite coords", async () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "move", x: "nope", y: 2 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /finite number/);
});

// ── face / wait / emote / idle (intent-only) ──

test("face: validates target, no side effects", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "face", target: "Bob" });
  assert.equal(res.ok, true);
  assert.equal(calls.roomSay.length, 0);
  assert.equal(calls.moveAgent.length, 0);
});

test("face: rejects empty target", async () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "face", target: "" });
  assert.equal(res.ok, false);
});

test("wait: optional seconds, no side effects", async () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  assert.equal((await gm.dispatch(ctx, { type: "wait" })).ok, true);
  assert.equal((await gm.dispatch(ctx, { type: "wait", seconds: 5 })).ok, true);
});

test("wait: clamps absurd durations into [0, 600]", async () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  assert.equal((await gm.dispatch(ctx, { type: "wait", seconds: 99999 })).ok, true);
  assert.equal((await gm.dispatch(ctx, { type: "wait", seconds: -10 })).ok, true);
});

test("emote: validates kind, no side effects", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "emote", kind: "shrug" });
  assert.equal(res.ok, true);
  assert.equal(calls.roomSay.length, 0);
});

test("idle: always ok, no side effects", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "idle" });
  assert.equal(res.ok, true);
  assert.equal(Object.values(calls).every((arr) => arr.length === 0), true);
});

// ── set_state ──

test("set_state: patches manifest with trimmed value", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { verb: "set_state", args: { value: "  curious  " } });
  assert.deepEqual(calls.saveCharacterManifest[0].patch, { state: "curious" });
});

test("legacy alias: state → set_state", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "state", value: "thinking" });
  assert.deepEqual(calls.saveCharacterManifest[0].patch, { state: "thinking" });
});

// ── set_mood ──

test("set_mood: merges only provided fields", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { verb: "set_mood", args: { energy: 80 } });
  assert.deepEqual(calls.saveCharacterManifest[0].patch, {
    mood: { energy: 80, social: 50 },
  });
});

test("set_mood: clamps to 0-100", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { verb: "set_mood", args: { energy: 150, social: -30 } });
  assert.deepEqual(calls.saveCharacterManifest[0].patch, {
    mood: { energy: 100, social: 0 },
  });
});

test("set_mood: no-op when nothing valid", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { verb: "set_mood", args: {} });
  assert.equal(calls.saveCharacterManifest.length, 0);
});

test("legacy alias: mood → set_mood", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "mood", value: { energy: 75 } });
  assert.deepEqual(calls.saveCharacterManifest[0].patch, {
    mood: { energy: 75, social: 50 },
  });
});

// ── post ──

test("post: routes to relayPost — no roomSay", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "post", text: "morning, internet" });
  assert.equal(res.ok, true);
  assert.equal(calls.relayPost.length, 1);
  assert.equal(calls.relayPost[0].content, "morning, internet");
  assert.equal(calls.relayPost[0].modelTag, "test-model");
  assert.equal(calls.roomSay.length, 0);
});

test("post: rejects empty text", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { verb: "post", args: { text: "  " } });
  assert.equal(res.ok, false);
  assert.equal(calls.relayPost.length, 0);
});

test("post: clips text to 1000 chars", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { verb: "post", args: { text: "p".repeat(5000) } });
  assert.equal(calls.relayPost[0].content.length, 1000);
});

// ── unknown verb / shape ──

test("dispatch: unknown verb returns structured rejection", async () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "fly", height: 100 });
  assert.equal(res.ok, false);
  assert.equal(res.verb, "fly");
  assert.match(res.reason, /unknown verb/);
});

test("dispatch: missing type/verb returns structured rejection", async () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { foo: "bar" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /missing verb/);
});

test("dispatch: non-object action returns structured rejection", async () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, "say hi");
  assert.equal(res.ok, false);
  assert.match(res.reason, /must be an object/);
});

// ── new shape ──

test("dispatch: { verb, args } shape passes through", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { verb: "say", args: { text: "via new shape" } });
  assert.equal(calls.roomSay[0].content, "via new shape");
});

test("dispatch: handler throw becomes structured rejection", async () => {
  const { deps } = makeStubDeps({
    roomSay: () => {
      throw new Error("room offline");
    },
  });
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say", text: "hello" });
  assert.equal(res.ok, false);
  assert.equal(res.verb, "say");
  assert.match(res.reason, /room offline/);
});
