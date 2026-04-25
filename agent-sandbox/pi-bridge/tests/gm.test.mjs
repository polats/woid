/**
 * GM tests. Exercise dispatch + arg validation across the four
 * currently-implemented verbs, with stubbed bridge deps.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/gm.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createGM, VERBS } from "../gm.js";

function makeStubDeps(overrides = {}) {
  const calls = {
    publishKind1: [],
    moveAgent: [],
    saveCharacterManifest: [],
    loadCharacter: [],
  };
  const deps = {
    publishKind1: async (agentId, content, modelTag) => {
      calls.publishKind1.push({ agentId, content, modelTag });
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
  assert.throws(() => createGM({ publishKind1: async () => {} }));
});

test("createGM exposes the verb registry", () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  assert.ok(gm.verbs.say);
  assert.ok(gm.verbs.move);
  assert.ok(gm.verbs.state);
  assert.ok(gm.verbs.mood);
  assert.equal(gm.verbs, VERBS);
});

// ── say ──

test("say: routes to publishKind1 with trimmed text", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say", text: "  hello world  " });
  assert.equal(res.ok, true);
  assert.equal(res.verb, "say");
  assert.equal(calls.publishKind1.length, 1);
  assert.equal(calls.publishKind1[0].content, "hello world");
  assert.equal(calls.publishKind1[0].agentId, "agent_1");
  assert.equal(calls.publishKind1[0].modelTag, "test-model");
});

test("say: rejects empty text", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say", text: "   " });
  assert.equal(res.ok, false);
  assert.match(res.reason, /non-empty/);
  assert.equal(calls.publishKind1.length, 0);
});

test("say: rejects non-string text", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say", text: 42 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /must be a string/);
  assert.equal(calls.publishKind1.length, 0);
});

test("say: clips text to 1000 chars", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const long = "x".repeat(2000);
  const res = await gm.dispatch(ctx, { type: "say", text: long });
  assert.equal(res.ok, true);
  assert.equal(calls.publishKind1[0].content.length, 1000);
});

// ── move ──

test("move: routes to moveAgent with rounded ints", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "move", x: 3.7, y: 2.2 });
  assert.equal(res.ok, true);
  assert.deepEqual(calls.moveAgent[0], { agentId: "agent_1", x: 4, y: 2 });
});

test("move: rejects non-finite coords", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "move", x: "nope", y: 2 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /finite number/);
  assert.equal(calls.moveAgent.length, 0);
});

test("move: rejects missing y", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "move", x: 3 });
  assert.equal(res.ok, false);
  assert.match(res.reason, /missing arg "y"/);
  assert.equal(calls.moveAgent.length, 0);
});

// ── state ──

test("state: patches manifest with trimmed value", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "state", value: "  curious  " });
  assert.equal(res.ok, true);
  assert.equal(calls.saveCharacterManifest[0].pubkey, "abc123");
  assert.deepEqual(calls.saveCharacterManifest[0].patch, { state: "curious" });
});

test("state: clips to 2000 chars", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const long = "y".repeat(5000);
  const res = await gm.dispatch(ctx, { type: "state", value: long });
  assert.equal(res.ok, true);
  assert.equal(calls.saveCharacterManifest[0].patch.state.length, 2000);
});

// ── mood ──

test("mood: merges with existing", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "mood", value: { energy: 80 } });
  assert.equal(res.ok, true);
  assert.equal(calls.loadCharacter.length, 1);
  assert.deepEqual(calls.saveCharacterManifest[0].patch, {
    mood: { energy: 80, social: 50 },
  });
});

test("mood: clamps to 0–100", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "mood", value: { energy: 150, social: -30 } });
  assert.deepEqual(calls.saveCharacterManifest[0].patch, {
    mood: { energy: 100, social: 0 },
  });
});

test("mood: ignores non-number fields silently", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "mood", value: { energy: null, social: 75 } });
  assert.deepEqual(calls.saveCharacterManifest[0].patch, {
    mood: { energy: 50, social: 75 },
  });
});

test("mood: no-op when value has no number fields", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "mood", value: { energy: "cat", social: "dog" } });
  assert.equal(calls.saveCharacterManifest.length, 0);
  assert.equal(calls.loadCharacter.length, 0);
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

// ── new shape forward-compat ──

test("dispatch: accepts the { verb, args } shape directly", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { verb: "say", args: { text: "hi from new shape" } });
  assert.equal(res.ok, true);
  assert.equal(res.verb, "say");
  assert.equal(calls.publishKind1[0].content, "hi from new shape");
});

// ── handler errors are caught ──

test("dispatch: handler throw becomes structured rejection", async () => {
  const { deps } = makeStubDeps({
    publishKind1: async () => {
      throw new Error("upstream relay down");
    },
  });
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say", text: "hello" });
  assert.equal(res.ok, false);
  assert.equal(res.verb, "say");
  assert.match(res.reason, /upstream relay down/);
});
