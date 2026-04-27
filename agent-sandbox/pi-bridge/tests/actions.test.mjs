import { test } from "node:test";
import assert from "node:assert/strict";
import { createCardRuntime } from "../storyteller/actions.js";

const ALICE = "a".repeat(64);
const BOB   = "b".repeat(64);

function fakeMoodlets() {
  const calls = [];
  return {
    calls,
    emit: (pubkey, m) => { const rec = { id: `m_${calls.length}`, ...m }; calls.push({ kind: "emit", pubkey, m }); return rec; },
    clearByTag: (pubkey, pattern) => { calls.push({ kind: "clear", pubkey, pattern }); return 0; },
  };
}

function fakeSessions() {
  const events = [];
  return {
    events,
    appendEvent: (e) => events.push(e),
  };
}

function fakePerception() {
  const events = [];
  return {
    events,
    appendOne: (pk, e) => events.push({ pk, ...e }),
    broadcastTo: () => {},
  };
}

function newDeps(extra = {}) {
  return {
    moodletsTracker: fakeMoodlets(),
    sessions: fakeSessions(),
    perception: fakePerception(),
    simClock: { now: () => ({ sim_iso: "Day 0 · 09:00" }), cadence: () => 60_000 },
    loadCharacter: (pk) => ({ name: pk === ALICE ? "Alice" : pk === BOB ? "Bob" : pk.slice(0, 8) }),
    pickRandomCharacter: () => ALICE,
    scheduleCard: () => {},
    ...extra,
  };
}

// ── EmitMoodlet ──

test("EmitMoodlet: resolves role and emits via tracker + perception", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  const card = {
    id: "c1", phase: "ambient", weight: 1, actions: [
      { type: "EmitMoodlet", target: "host", tag: "test", weight: 3, reason: "test reason" },
    ], roles: { host: { select: "random_character" } },
  };
  const r = await rt.run(card);
  assert.equal(r.ok, true);
  assert.equal(deps.moodletsTracker.calls.length, 1);
  const emitted = deps.moodletsTracker.calls[0];
  assert.equal(emitted.pubkey, ALICE);
  assert.equal(emitted.m.tag, "test");
  assert.equal(emitted.m.weight, 3);
  assert.equal(deps.perception.events.length, 1);
});

test("EmitMoodlet: fails on unbound role", async () => {
  const deps = newDeps({ pickRandomCharacter: () => null });
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", actions: [{ type: "EmitMoodlet", target: "ghost", tag: "x", weight: 1 }],
    roles: {}, weight: 1,
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unbound role/);
});

test("EmitMoodlet: duration_sim_min × cadence → duration_ms", async () => {
  const deps = newDeps({ simClock: { now: () => ({}), cadence: () => 1000 } });
  const rt = createCardRuntime(deps);
  await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "EmitMoodlet", target: "host", tag: "x", weight: 1, duration_sim_min: 60 }],
    roles: { host: { select: "random_character" } },
  });
  const m = deps.moodletsTracker.calls[0].m;
  assert.equal(m.duration_ms, 60_000); // 60 sim-min * 1000 ms/sim-min
});

// ── ClearMoodletByTag ──

test("ClearMoodletByTag: passes pattern through", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "ClearMoodletByTag", target: "host", pattern: "rel_change:*" }],
    roles: { host: { select: "random_character" } },
  });
  const c = deps.moodletsTracker.calls.find((x) => x.kind === "clear");
  assert.equal(c.pattern, "rel_change:*");
});

// ── role resolution ──

test("role: random_with_scene_mate forwards opts to pickRandomCharacter", async () => {
  const calls = [];
  const deps = newDeps({
    pickRandomCharacter: (opts) => { calls.push(opts); return ALICE; },
  });
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "Notice", target: "speaker", text: "hi" }],
    roles: { speaker: { select: "random_with_scene_mate" } },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], { withSceneMate: true });
  assert.equal(r.bindings.speaker, ALICE);
});

test("role: scene_mate resolves anchor first, then picks a mate of it", async () => {
  const calls = { random: [], mate: [] };
  const deps = newDeps({
    pickRandomCharacter: () => { calls.random.push(1); return ALICE; },
    pickSceneMate: (anchor) => { calls.mate.push(anchor); return BOB; },
  });
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [
      { type: "Notice", target: "a", text: "hi a" },
      { type: "Notice", target: "b", text: "hi b" },
    ],
    roles: {
      a: { select: "random_with_scene_mate" },
      b: { select: "scene_mate", of: "a" },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.bindings.a, ALICE);
  assert.equal(r.bindings.b, BOB);
  // pickSceneMate was called with the anchor's pubkey, not its role name.
  assert.equal(calls.mate[0], ALICE);
});

test("role: scene_mate fails cleanly when no mate available", async () => {
  const deps = newDeps({
    pickRandomCharacter: () => ALICE,
    pickSceneMate: () => null,
  });
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [
      { type: "Notice", target: "a", text: "hi" },
      { type: "Notice", target: "b", text: "hi" },
    ],
    roles: {
      a: { select: "random_character" },
      b: { select: "scene_mate", of: "a" },
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unbound role/);
});

// ── Notice ──

test("Notice: emits ambient_moment perception on the bound role", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "Notice", target: "host", text: "the room is quiet." }],
    roles: { host: { select: ALICE } },
  });
  assert.equal(r.ok, true);
  const ev = deps.perception.events.find((e) => e.kind === "ambient_moment");
  assert.ok(ev);
  assert.equal(ev.pk, ALICE);
  assert.equal(ev.text, "the room is quiet.");
});

test("Notice: rejects unbound role", async () => {
  const deps = newDeps({ pickRandomCharacter: () => null });
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "Notice", target: "ghost", text: "hi" }],
    roles: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unbound role/);
});

test("Notice: rejects empty text", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "Notice", target: "host", text: "   " }],
    roles: { host: { select: ALICE } },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /text required/);
});

// ── Suggest ──

test("Suggest: emits card_prompt perception on the speaker only", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "Suggest", target: "speaker", text: "say hi if you feel like it" }],
    roles: { speaker: { select: ALICE } },
  });
  assert.equal(r.ok, true);
  const prompt = deps.perception.events.find((e) => e.kind === "card_prompt");
  assert.ok(prompt);
  assert.equal(prompt.pk, ALICE);
  assert.equal(prompt.text, "say hi if you feel like it");
  // Critically: no speech is fabricated, no session card_conversation event.
  assert.equal(deps.perception.events.filter((e) => e.kind === "speech").length, 0);
  assert.equal(deps.sessions.events.filter((e) => e.kind === "card_conversation").length, 0);
});

test("Suggest: rejects unbound role", async () => {
  const deps = newDeps({ pickRandomCharacter: () => null });
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "Suggest", target: "ghost", text: "hi" }],
    roles: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unbound role/);
});

test("Suggest: rejects empty text", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "Suggest", target: "speaker", text: "  " }],
    roles: { speaker: { select: ALICE } },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /text required/);
});

// ── ModifyRel ──

test("ModifyRel: emits a moodlet with delta as weight", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "ModifyRel", from: "a", to: "b", delta: 5, reason: "shared something" }],
    roles: { a: { select: ALICE }, b: { select: BOB } },
  });
  const emit = deps.moodletsTracker.calls.find((c) => c.kind === "emit");
  assert.equal(emit.pubkey, ALICE);
  assert.equal(emit.m.weight, 5);
  assert.match(emit.m.tag, /^rel_change:by_/);
});

test("ModifyRel: zero delta is a no-op", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "ModifyRel", from: "a", to: "b", delta: 0 }],
    roles: { a: { select: ALICE }, b: { select: BOB } },
  });
  assert.equal(deps.moodletsTracker.calls.length, 0);
});

// ── SetData / CheckData branching ──

test("CheckData: branches via Label + jump", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [
      { type: "SetData", key: "mode", value: "warm" },
      { type: "CheckData", key: "mode", equals: "warm", then: "warm_path", else: "cold_path" },
      { type: "Label", name: "cold_path" },
      { type: "EmitMoodlet", target: "host", tag: "cold", weight: -1, reason: "cold" },
      { type: "GoTo", target: "end" },
      { type: "Label", name: "warm_path" },
      { type: "EmitMoodlet", target: "host", tag: "warm", weight: 2, reason: "warm" },
      { type: "Label", name: "end" },
    ],
    roles: { host: { select: "random_character" } },
  });
  assert.equal(r.ok, true);
  const tags = deps.moodletsTracker.calls.map((c) => c.m?.tag);
  assert.deepEqual(tags, ["warm"]);
});

// ── TriggerCard ──

test("TriggerCard: schedules via injected callback", async () => {
  const calls = [];
  const deps = newDeps({ scheduleCard: (id, at) => calls.push({ id, at }) });
  const rt = createCardRuntime(deps);
  await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "TriggerCard", card_id: "next-step", delay_sim_min: 10 }],
    roles: {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, "next-step");
  // delay 10 sim-min × 60_000 default cadence = 600_000 ms in the future
  assert.ok(calls[0].at > Date.now() + 500_000);
});

// ── Wait ──

test("Wait: pauses for sim_min × cadence ms via test seam", async () => {
  const deps = newDeps({ simClock: { now: () => ({}), cadence: () => 100 } });
  const waits = [];
  const rt = createCardRuntime(deps);
  await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "Wait", sim_min: 5 }, { type: "EmitMoodlet", target: "host", tag: "after", weight: 1 }],
    roles: { host: { select: "random_character" } },
  }, { waitFn: (ms) => { waits.push(ms); return Promise.resolve(); } });
  assert.deepEqual(waits, [500]); // 5 sim-min × 100 ms
});

// ── RNG ──

test("RNG: deterministic via injected random()", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  const card = {
    id: "c", phase: "ambient", weight: 1,
    actions: [
      { type: "RNG", prob: 0.5, then: "lucky", else: "unlucky" },
      { type: "Label", name: "unlucky" },
      { type: "EmitMoodlet", target: "host", tag: "unlucky_path", weight: 1 },
      { type: "GoTo", target: "end" },
      { type: "Label", name: "lucky" },
      { type: "EmitMoodlet", target: "host", tag: "lucky_path", weight: 1 },
      { type: "Label", name: "end" },
    ],
    roles: { host: { select: "random_character" } },
  };
  // random() = 0.4 < prob 0.5 → lucky
  const r1 = await rt.run(card, { random: () => 0.4 });
  // random() = 0.7 > prob 0.5 → unlucky
  const r2 = await rt.run(card, { random: () => 0.7 });
  // First and second runs share the same moodletsTracker; check tags.
  const tags = deps.moodletsTracker.calls.map((c) => c.m?.tag);
  assert.deepEqual(tags, ["lucky_path", "unlucky_path"]);
});

// ── Goto with no target ──

test("GoTo with unknown target: card fails cleanly", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [{ type: "GoTo", target: "ghost" }, { type: "Label", name: "elsewhere" }],
    roles: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /jump target "ghost"/);
});

// ── runaway loop guard ──

test("infinite loop is bounded by safety counter", async () => {
  const deps = newDeps();
  const rt = createCardRuntime(deps);
  const r = await rt.run({
    id: "c", phase: "ambient", weight: 1,
    actions: [
      { type: "Label", name: "loop" },
      { type: "GoTo", target: "loop" },
    ],
    roles: {},
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /runaway loop/);
});
