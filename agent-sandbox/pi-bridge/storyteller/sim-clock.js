/**
 * Sim-clock — maps real-time to sim-time for the storyteller's
 * session-rollover machinery (#275 slice 2) and the schedule
 * mover's slot lookup.
 *
 * The mapping is linear:
 *
 *   sim_minutes(t) = originSimMinutes + (t - originRealMs) / simMinutePerRealMs
 *
 * `originSimMinutes` is total sim-minutes since the world began;
 * `originRealMs` is the wall-clock at which that origin was set.
 * `simMinutePerRealMs` is the cadence — the default 60_000 means
 * 1 real-minute per sim-minute (real-time pacing). Override via
 * env `SIM_MS_PER_MIN` for fast dev cycles.
 *
 * The origin is persisted to `$WORKSPACE/sim-clock.json` so a bridge
 * restart doesn't reset the world's day count. `advance(simMs)`
 * shifts the origin backward — a dev escape hatch the
 * `POST /sessions/advance` endpoint uses to fast-forward to the
 * next sim-day rollover for testing.
 *
 * The schedule slots (morning / midday / afternoon / evening) here
 * mirror the canonical mapping in schedule.js so the bridge's slot
 * is consistent across the schedule mover, AgentSchedule UI, and
 * recap header. We keep them DRY by importing schedule.js's slotForHour.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { slotForHour } from "../schedule.js";

const FILE_NAME = "sim-clock.json";
const SIM_MIN_PER_DAY = 24 * 60;

export const DEFAULTS = {
  // 1:1 cadence — one real-minute is one sim-minute. Override for
  // dev: 2_500 makes 1 sim-day pass in 1 real-hour; 1_000 in 24
  // real-min; 60 in ~24 real-sec.
  simMinutePerRealMs: 60_000,
  // Fresh worlds start on sim-day 0 at 06:00. Hooking origin to the
  // morning makes the first session_open feel like "morning rolling
  // in" rather than midnight.
  initialSimMinutes: 6 * 60,
};

/**
 * @param {{
 *   workspacePath: string,
 *   wallClock?: () => number,
 *   simMinutePerRealMs?: number,
 *   initialSimMinutes?: number,
 *   fs?: { existsSync, readFileSync, writeFileSync, mkdirSync },
 * }} opts
 */
export function createSimClock(opts = {}) {
  if (!opts.workspacePath) throw new Error("createSimClock: workspacePath required");
  const fsImpl = opts.fs ?? { existsSync, readFileSync, writeFileSync, mkdirSync };
  const wallClock = opts.wallClock ?? (() => Date.now());
  const simMinutePerRealMs = opts.simMinutePerRealMs ?? DEFAULTS.simMinutePerRealMs;
  const path = join(opts.workspacePath, FILE_NAME);

  let originRealMs;
  let originSimMinutes;
  let cadence = simMinutePerRealMs;

  loadOrSeed();

  function loadOrSeed() {
    if (fsImpl.existsSync(path)) {
      try {
        const data = JSON.parse(fsImpl.readFileSync(path, "utf-8"));
        if (Number.isFinite(data?.originRealMs) && Number.isFinite(data?.originSimMinutes)) {
          originRealMs = data.originRealMs;
          originSimMinutes = data.originSimMinutes;
          // Persisted cadence wins over the constructor arg so frontend
          // changes survive restarts. The constructor `opts` only seeds
          // a fresh workspace.
          if (Number.isFinite(data?.simMinutePerRealMs) && data.simMinutePerRealMs > 0) {
            cadence = data.simMinutePerRealMs;
          }
          return;
        }
      } catch { /* fall through to seed */ }
    }
    originRealMs = wallClock();
    originSimMinutes = opts.initialSimMinutes ?? DEFAULTS.initialSimMinutes;
    persist();
  }

  function persist() {
    try {
      fsImpl.mkdirSync(dirname(path), { recursive: true });
      fsImpl.writeFileSync(
        path,
        JSON.stringify({ originRealMs, originSimMinutes, simMinutePerRealMs: cadence }, null, 2),
      );
    } catch (err) {
      console.error(`[sim-clock] persist ${path} failed:`, err?.message || err);
    }
  }

  function simMinutesAt(realMs) {
    return originSimMinutes + (realMs - originRealMs) / cadence;
  }

  /**
   * Snapshot of the current sim-time.
   *
   *   sim_day                — integer day count from origin
   *   sim_minutes_into_day   — 0..1439 (within the current sim-day)
   *   sim_hour               — 0..23
   *   sim_minute             — 0..59
   *   slot                   — morning/midday/afternoon/evening
   *   sim_iso                — pretty string for UI ("Day 3 · 09:14")
   */
  function now(realMs) {
    const t = realMs ?? wallClock();
    const total = simMinutesAt(t);
    const dayBase = Math.floor(total / SIM_MIN_PER_DAY);
    const intoDay = ((total % SIM_MIN_PER_DAY) + SIM_MIN_PER_DAY) % SIM_MIN_PER_DAY;
    const sim_hour = Math.floor(intoDay / 60);
    const sim_minute = Math.floor(intoDay % 60);
    const slot = slotForHour(sim_hour);
    return {
      sim_day: dayBase,
      sim_minutes_into_day: intoDay,
      sim_hour,
      sim_minute,
      slot,
      sim_iso: `Day ${dayBase} · ${pad2(sim_hour)}:${pad2(sim_minute)}`,
      real_ms: t,
      cadence_ms_per_sim_min: cadence,
    };
  }

  function simDay(realMs) { return now(realMs).sim_day; }
  function simHour(realMs) { return now(realMs).sim_hour; }
  function currentSlot(realMs) { return now(realMs).slot; }

  /**
   * Compute the real-ms wall-clock instant at which sim-time will
   * cross the next integer sim-day. Used by the session module to
   * schedule the next rollover.
   */
  function nextDayRolloverRealMs() {
    const t = wallClock();
    const total = simMinutesAt(t);
    const nextDayStart = (Math.floor(total / SIM_MIN_PER_DAY) + 1) * SIM_MIN_PER_DAY;
    const simMinUntil = nextDayStart - total;
    return t + simMinUntil * cadence;
  }

  /**
   * Change the sim:real cadence at runtime, preserving the current
   * sim-time. Re-anchors origin to (now, sim-now) and swaps in the
   * new rate — sim-time at the moment of change is unchanged; only
   * the future drift rate is faster/slower.
   *
   * `simMinutePerRealMs` ranges:
   *   60_000  → real-time (1 real-min = 1 sim-min)
   *   1_000   → 60× (1 real-min = 1 sim-hour)
   *   60      → 1000× (1 real-sec ≈ 17 sim-min)
   *
   * Rejected if value is not finite or ≤ 0.
   */
  function setCadence(newCadenceMsPerSimMin) {
    if (!Number.isFinite(newCadenceMsPerSimMin) || newCadenceMsPerSimMin <= 0) return null;
    const t = wallClock();
    originSimMinutes = simMinutesAt(t);
    originRealMs = t;
    cadence = newCadenceMsPerSimMin;
    persist();
    return now();
  }

  /**
   * Fast-forward sim-time by `simMs` (in sim-milliseconds). Equivalent
   * to subtracting that much from the origin so the same wall-clock
   * now reads as later. Persists the new origin.
   */
  function advance(simMs) {
    const simMin = simMs / 60_000;
    originSimMinutes += simMin;
    persist();
    return now();
  }

  /**
   * Set the origin so that "now" reads as exactly `simMinutesAtNow`.
   * Useful for tests and for jumping to a specific sim-time.
   */
  function setSimTime(simMinutesAtNow) {
    originRealMs = wallClock();
    originSimMinutes = simMinutesAtNow;
    persist();
    return now();
  }

  return {
    now, simDay, simHour, currentSlot,
    nextDayRolloverRealMs,
    advance, setSimTime, setCadence,
    cadence: () => cadence,
    _path: path,
  };
}

function pad2(n) { return n < 10 ? `0${n}` : `${n}`; }
