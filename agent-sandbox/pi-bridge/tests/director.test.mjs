import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirector } from "../storyteller/director.js";

function fakeCards(cards) {
  const byId = new Map(cards.map((c) => [c.id, c]));
  return {
    get: (id) => byId.get(id) ?? null,
    listAll: () => [...byId.values()],
    listByPhase: (p) => [...byId.values()].filter((c) => c.phase === p),
  };
}

function fakeRuntime() {
  const runs = [];
  return {
    runs,
    run: async (card, opts) => { runs.push({ id: card.id, opts }); return { ok: true }; },
  };
}

function fakeMoodlets(snap) {
  return { snapshot: () => snap || { totalActive: 0, characters: [] } };
}

function makeCard(over = {}) {
  return {
    id: over.id || "c1",
    phase: over.phase || "ambient",
    weight: over.weight ?? 1,
    intensity_min: over.intensity_min ?? 0,
    intensity_max: over.intensity_max ?? 1,
    once_per_session: !!over.once_per_session,
    exhaustible: !!over.exhaustible,
    cooldown_sim_min: over.cooldown_sim_min ?? 0,
    actions: [{ type: "Wait" }],
    ...over,
  };
}

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
  };
}

// ── intensity ──

test("intensity: starts at default and lerps toward target on tick", async () => {
  const wc = fakeClock();
  const cards = fakeCards([]);
  const runtime = fakeRuntime();
  const moodlets = fakeMoodlets({
    totalActive: 1,
    characters: [{ band: "lousy" }, { band: "lousy" }, { band: "steady" }],
  });
  const dir = createDirector({
    cards, runtime, moodlets,
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    config: { initialIntensity: 0.2, riseTauSimMin: 10 },
  });
  // Advance 5 sim-min; target with 2/3 lousy is 0.2 + 0.5*0.667 ≈ 0.533.
  // After 5/10 = half the rise, intensity moves halfway toward target:
  //   0.2 + (0.533 - 0.2) * 0.5 ≈ 0.367.
  wc.advance(5 * 60_000);
  await dir.tick();
  const i = dir.intensity();
  assert.ok(i > 0.3 && i < 0.42, `expected ~0.37, got ${i}`);
});

test("intensity: asymmetric — rises faster than it falls", async () => {
  const wc = fakeClock();
  const dir = createDirector({
    cards: fakeCards([]),
    runtime: fakeRuntime(),
    moodlets: fakeMoodlets({ characters: [{ band: "lousy" }] }), // pressures up
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    config: { initialIntensity: 0.5, riseTauSimMin: 10, fallTauSimMin: 100 },
  });
  // 5 sim-min with rising pressure should move us a meaningful chunk.
  wc.advance(5 * 60_000);
  await dir.tick();
  const afterRise = dir.intensity();

  // Now reset, drop pressure, and see the fall is much slower.
  dir._setIntensity(0.5);
  const dir2 = createDirector({
    cards: fakeCards([]),
    runtime: fakeRuntime(),
    moodlets: fakeMoodlets({ characters: [{ band: "cheerful" }] }), // target ≈ 0.2
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    config: { initialIntensity: 0.5, riseTauSimMin: 10, fallTauSimMin: 100 },
  });
  wc.advance(5 * 60_000);
  await dir2.tick();
  const afterFall = dir2.intensity();

  // Rise from 0.5 with target ≈ 0.7 over 5/10 of tau → ~0.6.
  // Fall from 0.5 with target ≈ 0.2 over 5/100 of tau → ~0.485.
  assert.ok(Math.abs(afterRise - 0.5) > Math.abs(afterFall - 0.5),
    `rise (${afterRise}) should be a larger move than fall (${afterFall}) from baseline`);
});

// ── card eligibility ──

test("tick: fires a single eligible ambient card", async () => {
  const wc = fakeClock();
  const cards = fakeCards([makeCard({ id: "morning", phase: "ambient" })]);
  const runtime = fakeRuntime();
  const dir = createDirector({
    cards, runtime, moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    random: () => 0.5,
  });
  wc.advance(60_000); // 1 sim-min just to make tick non-trivial
  const r = await dir.tick();
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].card_id, "morning");
  assert.equal(runtime.runs[0].id, "morning");
});

test("tick: skips cards outside intensity window", async () => {
  const wc = fakeClock();
  const cards = fakeCards([
    makeCard({ id: "low", phase: "ambient", intensity_max: 0.1 }),
    makeCard({ id: "high", phase: "ambient", intensity_min: 0.9 }),
  ]);
  const runtime = fakeRuntime();
  const dir = createDirector({
    cards, runtime, moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    config: { initialIntensity: 0.5 },
    random: () => 0.5,
  });
  wc.advance(1000);
  const r = await dir.tick();
  // intensity ~0.5, low card max 0.1, high card min 0.9 → both excluded.
  assert.equal(r.fired.length, 0);
  assert.equal(r.eligible_count, 0);
});

test("tick: respects once_per_session", async () => {
  const wc = fakeClock();
  const cards = fakeCards([makeCard({ id: "once", phase: "ambient", once_per_session: true })]);
  const runtime = fakeRuntime();
  const dir = createDirector({
    cards, runtime, moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    random: () => 0.5,
  });
  wc.advance(1000);
  await dir.tick();
  wc.advance(1000);
  await dir.tick();
  // Only one fire across two ticks.
  assert.equal(runtime.runs.length, 1);
});

test("onSessionOpen clears once_per_session memory", async () => {
  const wc = fakeClock();
  const cards = fakeCards([makeCard({ id: "once", phase: "ambient", once_per_session: true })]);
  const runtime = fakeRuntime();
  const dir = createDirector({
    cards, runtime, moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    random: () => 0.5,
  });
  wc.advance(1000); await dir.tick();
  wc.advance(1000); await dir.tick();
  assert.equal(runtime.runs.length, 1);
  dir.onSessionOpen();
  wc.advance(1000); await dir.tick();
  assert.equal(runtime.runs.length, 2);
});

test("tick: respects per-card cooldown", async () => {
  const wc = fakeClock();
  const cards = fakeCards([makeCard({ id: "cd", phase: "ambient", cooldown_sim_min: 30 })]);
  const runtime = fakeRuntime();
  const dir = createDirector({
    cards, runtime, moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },  // 60_000 ms = 1 sim-min
    wallClock: wc.now,
    random: () => 0.5,
  });
  wc.advance(1000); await dir.tick();      // fires
  wc.advance(10 * 60_000); await dir.tick(); // 10 sim-min later — still in cooldown
  assert.equal(runtime.runs.length, 1);
  wc.advance(25 * 60_000); await dir.tick(); // 35 sim-min total — cooldown elapsed
  assert.equal(runtime.runs.length, 2);
});

// ── phase routing ──

test("tick: only fires cards in opts.phases", async () => {
  const wc = fakeClock();
  const cards = fakeCards([
    makeCard({ id: "amb", phase: "ambient" }),
    makeCard({ id: "open", phase: "opening" }),
  ]);
  const runtime = fakeRuntime();
  const dir = createDirector({
    cards, runtime, moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    random: () => 0.5,
  });
  wc.advance(1000);
  await dir.tick({ phases: new Set(["opening"]) });
  assert.equal(runtime.runs[0].id, "open");
});

// ── scheduled cards (TriggerCard pathway) ──

test("scheduleCard: fires when fire_at_real_ms passes", async () => {
  const wc = fakeClock();
  const cards = fakeCards([makeCard({ id: "scheduled", phase: "ambient" })]);
  const runtime = fakeRuntime();
  const dir = createDirector({
    cards, runtime, moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    random: () => 0.5,
  });
  dir.scheduleCard("scheduled", wc.now() + 5000);
  await dir.tick({ fireRate: 0 }); // don't pick ambient; only drain queue
  assert.equal(runtime.runs.length, 0);
  wc.advance(6000);
  await dir.tick({ fireRate: 0 });
  assert.equal(runtime.runs.length, 1);
});

// ── selection weighting (deterministic via injected random) ──

test("weighted selection: roll < weight share picks first card", async () => {
  const wc = fakeClock();
  const cards = fakeCards([
    makeCard({ id: "a", phase: "ambient", weight: 9 }),
    makeCard({ id: "b", phase: "ambient", weight: 1 }),
  ]);
  const runtime = fakeRuntime();
  const dir = createDirector({
    cards, runtime, moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    random: () => 0.05, // lands inside a's 9/10 share
  });
  wc.advance(1000);
  await dir.tick();
  assert.equal(runtime.runs[0].id, "a");
});

test("onFire: invoked with structured record on every fire", async () => {
  const wc = fakeClock();
  const cards = fakeCards([makeCard({ id: "c1", phase: "ambient" })]);
  const runtime = fakeRuntime();
  const fires = [];
  const dir = createDirector({
    cards, runtime, moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    random: () => 0.5,
    onFire: (rec) => fires.push(rec),
  });
  wc.advance(1000);
  await dir.tick();
  assert.equal(fires.length, 1);
  const rec = fires[0];
  assert.equal(rec.card_id, "c1");
  assert.equal(rec.phase, "ambient");
  assert.equal(rec.source, "tick");
  assert.equal(typeof rec.fired_at, "number");
  assert.equal(typeof rec.intensity, "number");
  assert.equal(rec.ok, true);
});

test("onFire: distinguishes manual vs tick source", async () => {
  const wc = fakeClock();
  const cards = fakeCards([makeCard({ id: "manual1", phase: "ambient" })]);
  const runtime = fakeRuntime();
  const fires = [];
  const dir = createDirector({
    cards, runtime, moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
    onFire: (rec) => fires.push(rec),
  });
  await dir.fireCard(cards.get("manual1"), { source: "manual" });
  assert.equal(fires[0].source, "manual");
});

test("snapshot: returns shape", async () => {
  const wc = fakeClock();
  const dir = createDirector({
    cards: fakeCards([]), runtime: fakeRuntime(), moodlets: fakeMoodlets(),
    simClock: { cadence: () => 60_000 },
    wallClock: wc.now,
  });
  const s = dir.snapshot();
  assert.ok(typeof s.intensity === "number");
  assert.ok(Array.isArray(s.fired_this_session));
});
