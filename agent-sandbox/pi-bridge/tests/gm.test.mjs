/**
 * GM tests. Cover the full ten-verb registry from #225 slice 2 plus
 * legacy-shape compatibility, arg validation, and handler errors.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/gm.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createGM, VERBS } from "../gm.js";

/**
 * Default snapshot used by stubbed deps. Two agents: the actor
 * "abc123" (Marisol) at (5,5), and "carlos_pk" (Carlos) at (6,5) so
 * they're scene-mates by Chebyshev distance 1.
 */
const DEFAULT_SNAPSHOT = {
  agents: [
    { npub: "abc123", name: "Marisol", x: 5, y: 5 },
    { npub: "carlos_pk", name: "Carlos", x: 6, y: 5 },
  ],
};

function makeStubDeps(overrides = {}) {
  const calls = {
    roomSay: [],
    relayPost: [],
    moveAgent: [],
    saveCharacterManifest: [],
    loadCharacter: [],
    perception: [],   // every broadcast/append goes here
  };
  const snapshot = overrides.snapshot ?? DEFAULT_SNAPSHOT;
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
    getSnapshot: () => snapshot,
    perception: {
      appendOne: (target, ev) => calls.perception.push({ kind: "appendOne", target, ev }),
      broadcastTo: (targets, ev, except) =>
        calls.perception.push({ kind: "broadcastTo", targets: [...targets], ev, except }),
    },
    ...overrides,
  };
  // Allow caller to pass a partial perception override that doesn't
  // know about our `calls` map (e.g. omit perception entirely).
  if (overrides.perception === null) deps.perception = undefined;
  return { deps, calls };
}

const ctx = { agentId: "agent_1", pubkey: "abc123", name: "Marisol", model: "test-model" };

// ── factory ──

test("createGM throws when missing deps", () => {
  assert.throws(() => createGM({}));
  assert.throws(() => createGM({ roomSay: () => {} }));
});

test("createGM exposes the full verb registry", () => {
  const { deps } = makeStubDeps();
  const gm = createGM(deps);
  for (const v of ["say", "say_to", "move", "face", "wait", "emote", "set_state", "set_mood", "feel", "post", "idle"]) {
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

// ── feel ──

function makeFeelDeps() {
  const { deps, calls } = makeStubDeps();
  const moodletCalls = [];
  deps.moodletsTracker = {
    emit: (pk, m) => { const rec = { id: `m_${moodletCalls.length}`, ...m }; moodletCalls.push({ pk, m: rec }); return rec; },
  };
  deps.simClock = { cadence: () => 60_000 };
  return { deps, calls, moodletCalls };
}

test("feel: emits a self-moodlet via tracker + perception", async () => {
  const { deps, calls, moodletCalls } = makeFeelDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { verb: "feel", args: { tag: "felt_seen", weight: 2, reason: "she actually asked" } });
  assert.equal(res.ok, true);
  assert.equal(moodletCalls.length, 1);
  assert.equal(moodletCalls[0].pk, "abc123");
  assert.equal(moodletCalls[0].m.tag, "felt_seen");
  assert.equal(moodletCalls[0].m.weight, 2);
  assert.equal(moodletCalls[0].m.source, "self");
  // perception should record a moodlet_added on self.
  const perc = calls.perception.find((p) => p.kind === "appendOne" && p.ev?.kind === "moodlet_added");
  assert.ok(perc, "expected moodlet_added perception on self");
  assert.equal(perc.target, "abc123");
});

test("feel: duration_sim_min × cadence → duration_ms", async () => {
  const { deps, moodletCalls } = makeFeelDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { verb: "feel", args: { tag: "x", weight: 1, duration_sim_min: 90 } });
  assert.equal(moodletCalls[0].m.duration_ms, 90 * 60_000);
});

test("feel: clamps out-of-range weight to ±5", async () => {
  const { deps, moodletCalls } = makeFeelDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { verb: "feel", args: { tag: "x", weight: 99 } });
  assert.equal(res.ok, true);
  assert.equal(moodletCalls[0].m.weight, 5);
});

test("feel: rejects missing tag", async () => {
  const { deps, moodletCalls } = makeFeelDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { verb: "feel", args: { weight: 1 } });
  assert.equal(res.ok, false);
  assert.equal(moodletCalls.length, 0);
});

test("feel: no-op when moodletsTracker not wired", async () => {
  const { deps } = makeStubDeps();
  // No moodletsTracker provided.
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { verb: "feel", args: { tag: "x", weight: 1 } });
  // Verb returned ok=true (handler short-circuits gracefully) — no throw.
  assert.equal(res.ok, true);
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

// ── slice 3 + 4: perception emission + scene-aware say_to ──

test("say: broadcasts speech perception to scene-mates", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "say", text: "good morning" });
  const broadcasts = calls.perception.filter((c) => c.kind === "broadcastTo");
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0].targets, ["carlos_pk"]);
  assert.equal(broadcasts[0].ev.kind, "speech");
  assert.equal(broadcasts[0].ev.from_pubkey, "abc123");
  assert.equal(broadcasts[0].ev.from_name, "Marisol");
  assert.equal(broadcasts[0].ev.text, "good morning");
});

test("say: no perception broadcast when alone", async () => {
  const aloneSnap = { agents: [{ npub: "abc123", name: "Marisol", x: 5, y: 5 }] };
  const { deps, calls } = makeStubDeps({ snapshot: aloneSnap });
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "say", text: "anybody here?" });
  assert.equal(calls.perception.length, 0);
  assert.equal(calls.roomSay.length, 1);
});

test("say_to: rejects self-addressed speech", async () => {
  const { deps, calls } = makeStubDeps({
    inScene: () => true,
    sceneMatesOf: () => ["carlos_pk"],
  });
  const gm = createGM(deps);
  // Refer to self by name and by pubkey — both should be rejected.
  const r1 = await gm.dispatch(ctx, { type: "say_to", recipient: "Marisol", text: "hey" });
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /can't say_to yourself/);
  const r2 = await gm.dispatch(ctx, { type: "say_to", recipient: "abc123", text: "hey" });
  assert.equal(r2.ok, false);
  assert.equal(calls.roomSay.length, 0);
});

test("say_to: rejects when recipient not in room", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say_to", recipient: "Stranger", text: "hi" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not found in room/);
  assert.equal(calls.roomSay.length, 0);
  assert.equal(calls.perception.length, 0);
});

test("say_to: rejects when recipient out of scene", async () => {
  const farSnap = {
    agents: [
      { npub: "abc123", name: "Marisol", x: 5, y: 5 },
      { npub: "carlos_pk", name: "Carlos", x: 15, y: 15 },
    ],
  };
  const { deps, calls } = makeStubDeps({ snapshot: farSnap });
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say_to", recipient: "Carlos", text: "you ok?" });
  assert.equal(res.ok, false);
  assert.match(res.reason, /not in scene/);
  assert.equal(calls.roomSay.length, 0);
  assert.equal(calls.perception.length, 0);
});

test("say_to: resolves by name and emits addressed speech event", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say_to", recipient: "Carlos", text: "you ok?" });
  assert.equal(res.ok, true);
  // roomSay still happens, with the canonical recipient name prefixed.
  assert.equal(calls.roomSay[0].content, "@Carlos you ok?");
  // Speech event broadcast to scene-mate with the addressed_to fields.
  const broadcasts = calls.perception.filter((c) => c.kind === "broadcastTo");
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].ev.addressed_to_npub, "carlos_pk");
  assert.equal(broadcasts[0].ev.addressed_to_name, "Carlos");
});

test("say_to: resolves by npub directly", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  const res = await gm.dispatch(ctx, { type: "say_to", recipient: "carlos_pk", text: "hey" });
  assert.equal(res.ok, true);
  // Recipient name comes from the snapshot, not the raw arg.
  assert.equal(calls.roomSay[0].content, "@Carlos hey");
});

test("move: emits movement event to pre-move scene-mates", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "move", x: 9, y: 9 });
  const broadcasts = calls.perception.filter((c) => c.kind === "broadcastTo");
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0].targets, ["carlos_pk"]);
  assert.equal(broadcasts[0].ev.kind, "movement");
  assert.equal(broadcasts[0].ev.who_pubkey, "abc123");
  assert.equal(broadcasts[0].ev.x, 9);
  assert.equal(broadcasts[0].ev.y, 9);
});

test("move: no perception when moving alone", async () => {
  const aloneSnap = { agents: [{ npub: "abc123", name: "Marisol", x: 5, y: 5 }] };
  const { deps, calls } = makeStubDeps({ snapshot: aloneSnap });
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "move", x: 8, y: 4 });
  assert.equal(calls.perception.length, 0);
  assert.equal(calls.moveAgent.length, 1);
});

test("post: does NOT emit perception (offstage social action)", async () => {
  const { deps, calls } = makeStubDeps();
  const gm = createGM(deps);
  await gm.dispatch(ctx, { type: "post", text: "morning, internet" });
  assert.equal(calls.relayPost.length, 1);
  assert.equal(calls.perception.length, 0);
});

test("perception is optional — handlers tolerate missing dep", async () => {
  // Simulate a test or external embedding that doesn't wire perception.
  const { deps, calls } = makeStubDeps();
  delete deps.perception;
  const gm = createGM(deps);
  const r1 = await gm.dispatch(ctx, { type: "say", text: "hi" });
  const r2 = await gm.dispatch(ctx, { type: "move", x: 1, y: 1 });
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);
  assert.equal(calls.roomSay.length, 1);
  assert.equal(calls.moveAgent.length, 1);
});
