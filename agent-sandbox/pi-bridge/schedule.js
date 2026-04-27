/**
 * Schedules — per-character "where should I be right now?" timetable.
 *
 * Coarse 4-slot day:
 *
 *   morning    (06–11)  → kitchen by default       — co-presence #1
 *   midday     (11–16)  → own apartment by default
 *   afternoon  (16–21)  → hallway by default       — co-presence #2
 *   evening    (21–06)  → own apartment by default
 *
 * The point is *overlap*: all characters' default schedule sends
 * them to the kitchen in the morning and the hallway in the
 * afternoon. They collide there, the scene tracker opens a scene,
 * the LLM-driven turn loop runs, and the scene-close handler emits
 * moodlets onto each participant. That's the natural-meeting loop.
 *
 * Per-character overrides: callers can `setSlot(pubkey, slot, room_id)`
 * to bend a character's day. A "night-owl" character's morning slot
 * could be their own apartment instead of the kitchen, etc.
 *
 * Slot determination: we use the bridge's wall-clock hour for now.
 * #275 slice 2 will introduce a sim-clock; this module's slotForHour
 * stays the same — the caller just passes whichever clock they want.
 *
 * Persistence: one JSON file per character at
 * `$WORKSPACE/schedules/<pubkey>.json`. Tiny files, easy to edit
 * by hand for testing.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DIR_NAME = "schedules";

export const SLOTS = ["morning", "midday", "afternoon", "evening"];

/**
 * Default 24-hour → slot mapping. Wraps midnight: 21..05 = evening.
 */
export function slotForHour(hour) {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 6  && h < 11) return "morning";
  if (h >= 11 && h < 16) return "midday";
  if (h >= 16 && h < 21) return "afternoon";
  return "evening";
}

/**
 * Default slot → room_id mapping for a character with no overrides.
 * Owner's apartment for "private" slots, communal rooms for the
 * meet-up slots. The roomId for "own" is filled in by the bridge
 * (it knows who owns what); callers receive a literal "own".
 */
export const DEFAULT_TIMETABLE = {
  morning:   "kitchen",
  midday:    "own",
  afternoon: "hallway",
  evening:   "own",
};

/**
 * @param {{
 *   workspacePath: string,
 *   fs?: { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync },
 *   resolveOwnRoom?: (pubkey: string) => string | null,
 *   defaultTimetable?: object,
 * }} opts
 */
export function createScheduler(opts = {}) {
  if (!opts.workspacePath) throw new Error("createScheduler: workspacePath required");
  const fsImpl = opts.fs ?? { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync };
  const resolveOwnRoom = opts.resolveOwnRoom ?? (() => null);
  const defaultTimetable = { ...DEFAULT_TIMETABLE, ...(opts.defaultTimetable || {}) };
  const dirPath = join(opts.workspacePath, DIR_NAME);

  /** @type {Map<string, object>} pubkey → timetable override */
  const overrides = new Map();

  loadFromDisk();

  function fileFor(pubkey) {
    return join(dirPath, `${pubkey}.json`);
  }

  /**
   * Read the full effective timetable for a character: merges
   * overrides over defaults. Always returns all SLOTS keyed.
   */
  function timetableFor(pubkey) {
    const ov = overrides.get(pubkey) || {};
    const out = {};
    for (const slot of SLOTS) {
      out[slot] = ov[slot] ?? defaultTimetable[slot];
    }
    return out;
  }

  /**
   * Resolve a slot to a concrete room id. Returns null if the slot's
   * timetable says "own" and the character doesn't own a room yet.
   */
  function targetRoomFor(pubkey, slot) {
    const tt = timetableFor(pubkey);
    const target = tt[slot];
    if (!target) return null;
    if (target === "own") return resolveOwnRoom(pubkey);
    return target;
  }

  /**
   * Convenience — given current sim hour, what's the target room?
   */
  function targetRoomAtHour(pubkey, hour) {
    return targetRoomFor(pubkey, slotForHour(hour));
  }

  /**
   * Set a single slot override for a character. Pass `null` to clear
   * the override and fall back to the default for that slot.
   */
  function setSlot(pubkey, slot, roomId) {
    if (!pubkey) return null;
    if (!SLOTS.includes(slot)) return null;
    const ov = overrides.get(pubkey) || {};
    if (roomId == null) {
      delete ov[slot];
    } else {
      ov[slot] = String(roomId);
    }
    if (Object.keys(ov).length === 0) overrides.delete(pubkey);
    else overrides.set(pubkey, ov);
    persist(pubkey);
    return timetableFor(pubkey);
  }

  /**
   * Replace the entire override map for a character. Pass `{}` to
   * clear all overrides.
   */
  function setTimetable(pubkey, partial) {
    if (!pubkey || !partial || typeof partial !== "object") return null;
    const ov = {};
    for (const slot of SLOTS) {
      if (slot in partial && partial[slot] != null) ov[slot] = String(partial[slot]);
    }
    if (Object.keys(ov).length === 0) overrides.delete(pubkey);
    else overrides.set(pubkey, ov);
    persist(pubkey);
    return timetableFor(pubkey);
  }

  function clear(pubkey) {
    if (!pubkey) return false;
    const had = overrides.delete(pubkey);
    if (had) persist(pubkey); // writes empty file → loadFromDisk skips empty entries
    return had;
  }

  /**
   * Snapshot — useful for /health/schedules. Includes the resolved
   * timetable per pubkey (default + overrides applied).
   */
  function snapshot(pubkeys) {
    const list = pubkeys ?? [...overrides.keys()];
    return list.map((pubkey) => ({
      pubkey,
      override: overrides.get(pubkey) || {},
      effective: timetableFor(pubkey),
    }));
  }

  // ── persistence ──

  function loadFromDisk() {
    if (!fsImpl.existsSync(dirPath)) return;
    let entries;
    try { entries = fsImpl.readdirSync(dirPath); }
    catch { return; }
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const pubkey = name.slice(0, -".json".length);
      const filePath = join(dirPath, name);
      try {
        const data = JSON.parse(fsImpl.readFileSync(filePath, "utf-8"));
        if (data && typeof data === "object" && Object.keys(data).length > 0) {
          overrides.set(pubkey, data);
        }
      } catch { /* skip malformed */ }
    }
  }

  function persist(pubkey) {
    const ov = overrides.get(pubkey) || {};
    const filePath = fileFor(pubkey);
    try {
      fsImpl.mkdirSync(dirname(filePath), { recursive: true });
      fsImpl.writeFileSync(filePath, JSON.stringify(ov, null, 2));
    } catch (err) {
      console.error(`[schedule] persist ${filePath} failed:`, err?.message || err);
    }
  }

  return {
    timetableFor, targetRoomFor, targetRoomAtHour,
    setSlot, setTimetable, clear,
    snapshot,
    _slots: SLOTS,
    _defaultTimetable: defaultTimetable,
    _dir: dirPath,
  };
}
