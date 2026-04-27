import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import * as fs from "fs";
import { createCardLoader } from "../storyteller/cards.js";
import { createCardRuntime } from "../storyteller/actions.js";
import { createDirector } from "../storyteller/director.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CARDS_DIR = join(__dirname, "..", "cards");

const ALICE = "a".repeat(64);
const BOB = "b".repeat(64);

function fakeMoodletsTracker() {
  const calls = [];
  return {
    calls,
    emit: (pubkey, m) => { const rec = { id: `m_${calls.length}`, ...m }; calls.push({ kind: "emit", pubkey, m: rec }); return rec; },
    clearByTag: (pubkey, pattern) => { calls.push({ kind: "clear", pubkey, pattern }); return 0; },
  };
}

function fakeMoodletsAggregator(snap) {
  return { snapshot: () => snap || { totalActive: 0, characters: [] } };
}

function fakePerception() {
  const events = [];
  return { events, appendOne: (pk, e) => events.push({ pk, ...e }), broadcastTo: () => {} };
}

function fakeSessions() {
  const events = [];
  return { events, appendEvent: (e) => events.push(e) };
}

test("starter cards: all on-disk cards load and validate", () => {
  const loader = createCardLoader({ cardsPath: CARDS_DIR, fs });
  const r = loader.loadAll();
  assert.equal(r.errors.length, 0, `validation errors: ${JSON.stringify(r.errors)}`);
  assert.ok(r.loaded >= 10, `expected at least 10 starter cards, got ${r.loaded}`);
  const snap = loader.snapshot();
  assert.ok(snap.byPhase.opening >= 1, "need at least one opening card");
  assert.ok(snap.byPhase.ambient >= 1, "need at least one ambient card");
  assert.ok(snap.byPhase.closing >= 1, "need at least one closing card");
});

test("starter cards: director picks and fires an ambient card end-to-end", async () => {
  const loader = createCardLoader({ cardsPath: CARDS_DIR, fs });
  loader.loadAll();
  const moodletsTracker = fakeMoodletsTracker();
  const perception = fakePerception();
  const sessions = fakeSessions();
  const pool = [ALICE, BOB];
  let pickIdx = 0;
  const runtime = createCardRuntime({
    moodletsTracker,
    perception,
    sessions,
    simClock: { now: () => ({ sim_iso: "Day 0 · 14:00" }), cadence: () => 60_000 },
    loadCharacter: (pk) => ({ name: pk === ALICE ? "Alice" : "Bob" }),
    pickRandomCharacter: () => pool[pickIdx++ % pool.length],
  });
  const director = createDirector({
    cards: loader,
    runtime,
    moodlets: fakeMoodletsAggregator({ totalActive: 0, characters: [{ band: "steady" }, { band: "steady" }] }),
    sessions,
    simClock: { cadence: () => 60_000 },
    config: { initialIntensity: 0.4 },
    random: () => 0.1,
  });
  const r = await director.tick({ phases: new Set(["ambient"]) });
  assert.equal(r.fired.length, 1, `expected one ambient fire, got ${JSON.stringify(r.fired)}`);
  assert.equal(r.fired[0].ok, true, `card failed: ${r.fired[0].reason}`);
  // Expect at least one moodlet emission or perception event from the fire.
  const totalEffects = moodletsTracker.calls.length + perception.events.length;
  assert.ok(totalEffects >= 1, "card fired but produced no observable effect");
  // Session should have a card_fired event.
  const fireEvent = sessions.events.find((e) => e.kind === "card_fired");
  assert.ok(fireEvent, "expected card_fired session event");
});

test("starter cards: 30 ticks across phases produces a healthy mix of fires", async () => {
  const loader = createCardLoader({ cardsPath: CARDS_DIR, fs });
  loader.loadAll();
  const moodletsTracker = fakeMoodletsTracker();
  const perception = fakePerception();
  const sessions = fakeSessions();
  const pool = [ALICE, BOB];
  let pickIdx = 0;
  let t = 1_700_000_000_000;
  const wallClock = () => t;
  const runtime = createCardRuntime({
    moodletsTracker,
    perception,
    sessions,
    simClock: { now: () => ({ sim_iso: "Day 0" }), cadence: () => 60_000 },
    loadCharacter: (pk) => ({ name: pk.slice(0, 6) }),
    pickRandomCharacter: () => pool[pickIdx++ % pool.length],
    wallClock,
  });
  // Mood pressure rising — characters are lousy, intensity should climb.
  const director = createDirector({
    cards: loader,
    runtime,
    moodlets: fakeMoodletsAggregator({ totalActive: 2, characters: [{ band: "lousy" }, { band: "lousy" }] }),
    sessions,
    simClock: { cadence: () => 60_000 },
    wallClock,
    config: { initialIntensity: 0.3, riseTauSimMin: 10 },
    random: () => 0.5,
  });
  const fired = [];
  for (let i = 0; i < 30; i++) {
    t += 5 * 60_000; // 5 sim-min per tick
    const phase = i < 5 ? "opening" : i > 25 ? "closing" : "ambient";
    const r = await director.tick({ phases: new Set([phase]) });
    for (const f of r.fired) fired.push({ tick: i, phase, ...f });
  }
  // We should see multiple fires — cooldowns and intensity windows should
  // not starve the pool entirely across 30 ticks.
  assert.ok(fired.length >= 5, `expected ≥5 fires across 30 ticks, got ${fired.length}`);
  const phasesSeen = new Set(fired.map((f) => f.phase));
  assert.ok(phasesSeen.size >= 2, `expected fires across multiple phases, saw ${[...phasesSeen]}`);
});
