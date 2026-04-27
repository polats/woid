/**
 * Sim-clock tests — linear mapping, persistence, advance, slot
 * derivation, rollover-time calculation.
 *
 * Run: node --test agent-sandbox/pi-bridge/tests/sim-clock.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSimClock, DEFAULTS } from "../storyteller/sim-clock.js";

function inMemoryFs() {
  const store = new Map();
  return {
    _store: store,
    mkdirSync: () => {},
    writeFileSync: (p, c) => store.set(p, String(c)),
    readFileSync: (p) => store.get(p) ?? "",
    existsSync: (p) => store.has(p),
  };
}

function fakeClock(initial = 1_700_000_000_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t; },
    set: (ms) => { t = ms; return t; },
  };
}

const SIM_MIN_PER_DAY = 24 * 60;

// ── seed ──

test("fresh workspace: seeds origin to current real-ms + initial sim-min", () => {
  const wc = fakeClock();
  const c = createSimClock({
    workspacePath: "/ws",
    fs: inMemoryFs(),
    wallClock: wc.now,
  });
  const snap = c.now();
  assert.equal(snap.sim_day, 0);
  // Default initial = 6 * 60 = 360 sim-min
  assert.equal(snap.sim_hour, 6);
  assert.equal(snap.sim_minute, 0);
  assert.equal(snap.slot, "morning");
});

test("custom initialSimMinutes overrides default", () => {
  const c = createSimClock({
    workspacePath: "/ws",
    fs: inMemoryFs(),
    wallClock: () => 0,
    initialSimMinutes: 17 * 60, // 17:00 → afternoon
  });
  const snap = c.now();
  assert.equal(snap.sim_hour, 17);
  assert.equal(snap.slot, "afternoon");
});

// ── advance with cadence ──

test("real-time advance progresses sim-time by cadence ratio", () => {
  const wc = fakeClock();
  const c = createSimClock({
    workspacePath: "/ws",
    fs: inMemoryFs(),
    wallClock: wc.now,
    simMinutePerRealMs: 1_000, // 1 real-second = 1 sim-minute
  });
  const before = c.now();
  wc.advance(60_000); // 60 real-sec = 60 sim-min = 1 sim-hour
  const after = c.now();
  assert.equal(after.sim_hour, before.sim_hour + 1);
});

test("default cadence is 1 real-min per sim-min (real-time pacing)", () => {
  const c = createSimClock({ workspacePath: "/ws", fs: inMemoryFs(), wallClock: () => 0 });
  assert.equal(c.cadence(), DEFAULTS.simMinutePerRealMs);
  assert.equal(c.cadence(), 60_000);
});

test("sim_day rolls over after 1440 sim-min", () => {
  const wc = fakeClock();
  const c = createSimClock({
    workspacePath: "/ws",
    fs: inMemoryFs(),
    wallClock: wc.now,
    simMinutePerRealMs: 1, // 1ms = 1 sim-min, easy math
    initialSimMinutes: 0,
  });
  assert.equal(c.simDay(), 0);
  wc.advance(SIM_MIN_PER_DAY); // 1440 ms = 1440 sim-min
  assert.equal(c.simDay(), 1);
  wc.advance(SIM_MIN_PER_DAY * 2);
  assert.equal(c.simDay(), 3);
});

// ── slot derivation ──

test("slot maps from sim_hour", () => {
  const wc = fakeClock();
  const c = createSimClock({
    workspacePath: "/ws",
    fs: inMemoryFs(),
    wallClock: wc.now,
    simMinutePerRealMs: 1,
    initialSimMinutes: 0,
  });
  // We start at 00:00 = evening (default slotForHour: 21..06 = evening)
  assert.equal(c.currentSlot(), "evening");
  wc.advance(8 * 60); // jump to 08:00 → morning
  assert.equal(c.currentSlot(), "morning");
  wc.advance(5 * 60); // jump to 13:00 → midday
  assert.equal(c.currentSlot(), "midday");
  wc.advance(5 * 60); // jump to 18:00 → afternoon
  assert.equal(c.currentSlot(), "afternoon");
});

// ── rollover time ──

test("nextDayRolloverRealMs returns when sim-day will roll over", () => {
  const wc = fakeClock();
  const c = createSimClock({
    workspacePath: "/ws",
    fs: inMemoryFs(),
    wallClock: wc.now,
    simMinutePerRealMs: 1, // 1ms = 1 sim-min
    initialSimMinutes: 23 * 60, // start at 23:00 sim-time
  });
  const rollover = c.nextDayRolloverRealMs();
  // 60 sim-min until midnight → 60 ms real-time
  assert.equal(rollover, wc.now() + 60);
});

// ── advance() ──

test("advance(simMs) jumps sim-time forward without changing real-time", () => {
  const wc = fakeClock();
  const c = createSimClock({
    workspacePath: "/ws",
    fs: inMemoryFs(),
    wallClock: wc.now,
    simMinutePerRealMs: 60_000,
    initialSimMinutes: 0,
  });
  const tBefore = wc.now();
  // Advance 6 sim-hours = 360 sim-min = 21_600_000 sim-ms.
  c.advance(6 * 60 * 60_000);
  assert.equal(wc.now(), tBefore); // real-clock untouched
  assert.equal(c.simHour(), 6);
});

// ── setSimTime ──

test("setSimTime: pins now to a specific sim-minute count", () => {
  const wc = fakeClock();
  const c = createSimClock({
    workspacePath: "/ws",
    fs: inMemoryFs(),
    wallClock: wc.now,
    simMinutePerRealMs: 1_000,
    initialSimMinutes: 0,
  });
  c.setSimTime(2 * SIM_MIN_PER_DAY + 14 * 60); // sim-day 2, hour 14
  const snap = c.now();
  assert.equal(snap.sim_day, 2);
  assert.equal(snap.sim_hour, 14);
});

// ── persistence ──

test("persistence: origin survives re-instantiation; clock keeps advancing", () => {
  const fs = inMemoryFs();
  const wc = fakeClock();
  const c1 = createSimClock({
    workspacePath: "/ws",
    fs,
    wallClock: wc.now,
    simMinutePerRealMs: 1, // 1ms = 1 sim-min
    initialSimMinutes: 6 * 60, // 06:00
  });
  // Advance 4 sim-hours of wall-clock.
  wc.advance(4 * 60); // 4 hours × 60 min = 240 ms
  assert.equal(c1.simHour(), 10);

  // Restart: re-instantiate against the same fs + same advanced wall.
  const c2 = createSimClock({
    workspacePath: "/ws",
    fs,
    wallClock: wc.now,
    simMinutePerRealMs: 1,
  });
  const snap = c2.now();
  // Origin restored → still reads 10:00.
  assert.equal(snap.sim_hour, 10);
  // And further wall-clock advance progresses sim-time.
  wc.advance(60); // +1 sim-hour
  assert.equal(c2.simHour(), 11);
});

// ── setCadence ──

test("setCadence: preserves current sim-time across the change", () => {
  const wc = fakeClock();
  const c = createSimClock({
    workspacePath: "/ws", fs: inMemoryFs(), wallClock: wc.now,
    simMinutePerRealMs: 60_000, // real-time
    initialSimMinutes: 8 * 60,  // 08:00
  });
  // 30 real-min in: sim-time should be 08:30.
  wc.advance(30 * 60_000);
  assert.equal(c.now().sim_hour, 8);
  assert.equal(c.now().sim_minute, 30);

  // Switch to 1000× (60ms = 1 sim-min). Sim-time at change should
  // still read 08:30, but future advance is 1000× faster.
  c.setCadence(60);
  assert.equal(c.now().sim_hour, 8);
  assert.equal(c.now().sim_minute, 30);
  assert.equal(c.cadence(), 60);

  // Now 60ms passes → 1 sim-min.
  wc.advance(60);
  assert.equal(c.now().sim_minute, 31);
});

test("setCadence: rejects non-finite or non-positive", () => {
  const c = createSimClock({
    workspacePath: "/ws", fs: inMemoryFs(),
    wallClock: () => 0,
  });
  assert.equal(c.setCadence(0), null);
  assert.equal(c.setCadence(-1), null);
  assert.equal(c.setCadence(NaN), null);
  assert.equal(c.setCadence("fast"), null);
  assert.equal(c.cadence(), 60_000); // unchanged
});

test("setCadence: persisted across re-instantiation", () => {
  const fs = inMemoryFs();
  const wc = fakeClock();
  const c1 = createSimClock({
    workspacePath: "/ws", fs, wallClock: wc.now,
    simMinutePerRealMs: 60_000,
    initialSimMinutes: 6 * 60,
  });
  c1.setCadence(1_000);
  assert.equal(c1.cadence(), 1_000);

  // Restart — new instance against same fs.
  const c2 = createSimClock({
    workspacePath: "/ws", fs, wallClock: wc.now,
    simMinutePerRealMs: 60_000, // constructor arg ignored, persisted wins
  });
  assert.equal(c2.cadence(), 1_000);
});

// ── pretty string ──

test("sim_iso reads as 'Day N · HH:MM'", () => {
  const wc = fakeClock();
  const c = createSimClock({
    workspacePath: "/ws",
    fs: inMemoryFs(),
    wallClock: wc.now,
    simMinutePerRealMs: 1,
    initialSimMinutes: 3 * SIM_MIN_PER_DAY + 7 * 60 + 23, // day 3, 07:23
  });
  assert.equal(c.now().sim_iso, "Day 3 · 07:23");
});
