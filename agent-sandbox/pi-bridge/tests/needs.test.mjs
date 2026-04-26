/**
 * Needs tracker tests — three axes, uniform decay, wellbeing levels.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/needs.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createNeedsTracker,
  computeWellbeing,
  describeNeeds,
  NEED_AXES,
  DEFAULTS,
} from "../needs.js";

function fakeClock() {
  let t = 1000;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
    set: (ms) => { t = ms; return t; },
  };
}

// ── axes ──

test("NEED_AXES is the three-axis set", () => {
  assert.deepEqual(NEED_AXES, ["energy", "social", "curiosity"]);
});

// ── register / get ──

test("register: creates a fresh record at initial value across all axes", () => {
  const clock = fakeClock();
  const tracker = createNeedsTracker({ now: clock.now });
  const rec = tracker.register("alice");
  for (const axis of NEED_AXES) {
    assert.equal(rec.needs[axis], DEFAULTS.initialValue);
  }
});

test("register: seed needs override defaults; legacy axes are ignored", () => {
  const tracker = createNeedsTracker();
  const rec = tracker.register("alice", {
    needs: { energy: 80, hunger: 10, hygiene: 5 }, // hunger/hygiene are legacy
  });
  assert.equal(rec.needs.energy, 80);
  assert.equal(rec.needs.social, DEFAULTS.initialValue);
  assert.equal(rec.needs.curiosity, DEFAULTS.initialValue);
  assert.equal(rec.needs.hunger, undefined);
  assert.equal(rec.needs.hygiene, undefined);
});

test("register: idempotent — re-register preserves needs unless seeded", () => {
  const tracker = createNeedsTracker();
  tracker.register("alice");
  tracker.adjust("alice", "energy", -50);
  const before = tracker.get("alice").needs.energy;
  tracker.register("alice");
  assert.equal(tracker.get("alice").needs.energy, before);
});

test("register: ignores empty pubkey", () => {
  const tracker = createNeedsTracker();
  assert.equal(tracker.register(null), null);
  assert.equal(tracker.register(""), null);
});

test("get: returns null for unknown pubkey", () => {
  const tracker = createNeedsTracker();
  assert.equal(tracker.get("ghost"), null);
});

// ── tickAll ──

test("tickAll: applies decay scaled by elapsed sim-minutes", () => {
  const clock = fakeClock();
  const tracker = createNeedsTracker({ now: clock.now, simMinutePerRealMs: 1000 });
  tracker.register("alice");
  clock.advance(60_000); // 60 sim-minutes
  tracker.tickAll(clock.now());
  const r = tracker.get("alice");
  // social decay 0.5 × 60 = 30
  assert.equal(r.needs.social, DEFAULTS.initialValue - 30);
  // curiosity decay 0.4 × 60 = 24
  assert.equal(r.needs.curiosity, DEFAULTS.initialValue - 24);
});

test("tickAll: needs clamp at 0", () => {
  const clock = fakeClock();
  const tracker = createNeedsTracker({ now: clock.now, simMinutePerRealMs: 1000 });
  tracker.register("alice");
  clock.advance(10 * 60 * 60_000); // 10 sim-hours
  tracker.tickAll(clock.now());
  for (const axis of NEED_AXES) {
    assert.ok(tracker.get("alice").needs[axis] >= 0);
  }
});

// ── threshold crossings (slice 2) ──

test("tickAll: emits crossing when axis dips below lowThreshold", () => {
  const clock = fakeClock();
  // Seed energy at 31 so a single tick of decay (0.3 × 30 sim-min = 9
  // points lost) drops it to 22 — past the default threshold of 30.
  const tracker = createNeedsTracker({ now: clock.now, simMinutePerRealMs: 1000 });
  tracker.register("alice", { needs: { energy: 31, social: 80, curiosity: 80 } });
  clock.advance(30_000);
  const out = tracker.tickAll(clock.now());
  const me = out.find((r) => r.pubkey === "alice");
  assert.equal(me.crossings.length, 1);
  assert.equal(me.crossings[0].axis, "energy");
  assert.equal(me.crossings[0].level, "low");
  assert.ok(me.crossings[0].from >= 30 && me.crossings[0].to < 30);
});

test("tickAll: no crossing when axis was already below threshold", () => {
  const clock = fakeClock();
  const tracker = createNeedsTracker({ now: clock.now, simMinutePerRealMs: 1000 });
  // Already at 25 — under the threshold. Decay continues but no
  // re-fire (it didn't *cross* anything this tick).
  tracker.register("alice", { needs: { energy: 25, social: 80, curiosity: 80 } });
  clock.advance(30_000);
  const out = tracker.tickAll(clock.now());
  const me = out.find((r) => r.pubkey === "alice");
  assert.equal(me.crossings.length, 0);
});

test("tickAll: multiple axes can cross in the same tick", () => {
  const clock = fakeClock();
  const tracker = createNeedsTracker({ now: clock.now, simMinutePerRealMs: 1000 });
  tracker.register("alice", { needs: { energy: 31, social: 31, curiosity: 80 } });
  clock.advance(60_000);
  const out = tracker.tickAll(clock.now());
  const me = out.find((r) => r.pubkey === "alice");
  // energy 31 → ~13, social 31 → ~1. Both cross.
  assert.equal(me.crossings.length, 2);
  assert.deepEqual(me.crossings.map((c) => c.axis).sort(), ["energy", "social"]);
});

test("tickAll: custom lowThreshold respected", () => {
  const clock = fakeClock();
  const tracker = createNeedsTracker({ now: clock.now, simMinutePerRealMs: 1000, lowThreshold: 50 });
  tracker.register("alice", { needs: { energy: 51, social: 80, curiosity: 80 } });
  clock.advance(20_000);
  const out = tracker.tickAll(clock.now());
  assert.equal(out[0].crossings.length, 1);
  assert.equal(out[0].crossings[0].axis, "energy");
});

test("tickAll: returns decay summaries", () => {
  const clock = fakeClock();
  const tracker = createNeedsTracker({ now: clock.now, simMinutePerRealMs: 1000 });
  tracker.register("alice");
  tracker.register("bob");
  clock.advance(30_000);
  const out = tracker.tickAll(clock.now());
  assert.equal(out.length, 2);
  for (const r of out) {
    assert.ok(r.before && r.after && typeof r.simMin === "number");
  }
});

test("tickAll: skips when zero time elapsed", () => {
  const clock = fakeClock();
  const tracker = createNeedsTracker({ now: clock.now });
  tracker.register("alice");
  const out = tracker.tickAll(clock.now()); // same instant
  assert.equal(out.length, 0);
});

// ── adjust / setAxis ──

test("adjust: applies +/- delta clamped to 0..100", () => {
  const tracker = createNeedsTracker();
  tracker.register("alice");
  assert.equal(tracker.adjust("alice", "energy", -100), 0);
  assert.equal(tracker.adjust("alice", "energy", 200), 100);
});

test("adjust: rejects invalid axis (legacy or unknown)", () => {
  const tracker = createNeedsTracker();
  tracker.register("alice");
  assert.equal(tracker.adjust("alice", "wisdom", 10), null);
  assert.equal(tracker.adjust("alice", "hunger", 10), null);  // legacy
  assert.equal(tracker.adjust("alice", "hygiene", 10), null); // legacy
});

test("adjust: rejects unknown pubkey", () => {
  const tracker = createNeedsTracker();
  assert.equal(tracker.adjust("ghost", "energy", 10), null);
});

test("setAxis: replaces value", () => {
  const tracker = createNeedsTracker();
  tracker.register("alice");
  tracker.setAxis("alice", "curiosity", 42);
  assert.equal(tracker.get("alice").needs.curiosity, 42);
});

test("setAxis: clamps and rejects non-numbers", () => {
  const tracker = createNeedsTracker();
  tracker.register("alice");
  tracker.setAxis("alice", "energy", -10);
  assert.equal(tracker.get("alice").needs.energy, 0);
  tracker.setAxis("alice", "energy", 200);
  assert.equal(tracker.get("alice").needs.energy, 100);
  assert.equal(tracker.setAxis("alice", "energy", "high"), null);
});

// ── unregister / snapshot ──

test("unregister drops a record", () => {
  const tracker = createNeedsTracker();
  tracker.register("alice");
  tracker.unregister("alice");
  assert.equal(tracker.get("alice"), null);
});

test("snapshot reports all tracked characters with derived wellbeing", () => {
  const tracker = createNeedsTracker();
  tracker.register("alice");
  tracker.register("bob");
  const snap = tracker.snapshot();
  assert.equal(snap.length, 2);
  for (const s of snap) {
    assert.ok(typeof s.wellbeing === "string");
    assert.ok(NEED_AXES.every((a) => typeof s.needs[a] === "number"));
  }
});

// ── computeWellbeing ──

test("computeWellbeing: high needs → thriving", () => {
  assert.equal(computeWellbeing({ energy: 80, social: 90, curiosity: 75 }), "thriving");
});

test("computeWellbeing: one low axis pulls level down", () => {
  // energy 10 → in_crisis regardless of others
  assert.equal(computeWellbeing({ energy: 10, social: 99, curiosity: 99 }), "in_crisis");
});

test("computeWellbeing: missing values treated as 100 (no concern)", () => {
  assert.equal(computeWellbeing({}), "thriving");
});

test("computeWellbeing: bands are inclusive of their min", () => {
  // Exactly 50 → uneasy
  assert.equal(computeWellbeing({ energy: 50, social: 100, curiosity: 100 }), "uneasy");
  // Exactly 30 → distressed
  assert.equal(computeWellbeing({ energy: 30, social: 100, curiosity: 100 }), "distressed");
});

test("computeWellbeing: below 30 → in_crisis", () => {
  assert.equal(computeWellbeing({ energy: 25, social: 100, curiosity: 100 }), "in_crisis");
});

// ── describeNeeds ──

test("describeNeeds: all-fine reports just the wellbeing level", () => {
  const out = describeNeeds({ energy: 85, social: 90, curiosity: 75 });
  assert.match(out, /Wellbeing: thriving/);
  assert.ok(!/Pressing/.test(out));
});

test("describeNeeds: lists axes below 50 sorted ascending", () => {
  const out = describeNeeds({ energy: 80, social: 35, curiosity: 20 });
  assert.match(out, /Pressing: curiosity 20, social 35/);
});

test("describeNeeds: empty input returns empty string", () => {
  assert.equal(describeNeeds(null), "");
});

// ── undefined opts don't overwrite defaults ──

test("createNeedsTracker: undefined cfg keys preserve defaults", () => {
  const tracker = createNeedsTracker({ simMinutePerRealMs: undefined, decayPerMin: undefined });
  assert.equal(tracker._cfg.simMinutePerRealMs, DEFAULTS.simMinutePerRealMs);
  assert.deepEqual(tracker._cfg.decayPerMin, DEFAULTS.decayPerMin);
});
