/**
 * Colony local-first store.
 *
 * Single JSON blob in localStorage under `woid.colony.v1`. Mirrors the
 * shelterStore pattern (useSyncExternalStore + LocalOnlySync + pluggable
 * sync). Everything Colony-specific lives here: dupes, tiles, resources.
 *
 * The harness library (src/lib/harness/) supplies the cross-cutting
 * primitives (perception, needs, moodlets); the store wires them in.
 */

import { createInitialWorld, NEED_AXES, NEED_DECAY, clampNeed } from './world.js';
import { VERBS } from './verbs.js';

const STORAGE_KEY = 'woid.colony.v1';
const SCHEMA_VERSION = 1;
const TICK_HZ = 4;                  // matches useColonyTick
const OFFLINE_CAP_TICKS = TICK_HZ * 60 * 5; // 5 real-minutes of offline catch-up
// Debounce groups bursts of mutations into one write, but the brain
// ticks every 250ms — without a max-wait, the timer never fires.
const WRITE_DEBOUNCE_MS = 500;
const WRITE_MAX_WAIT_MS = 2000;

/** No-op sync; the seam for future cloud persistence. */
export const LocalOnlySync = {
  async push() {},
  async pull() { return null; },
};

function readFromStorage() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeToStorage(snapshot) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // quota / serialization — swallow silently like shelterStore does
  }
}

export function createColonyStore({ sync = LocalOnlySync, initial = null } = {}) {
  let snapshot = initial ?? readFromStorage() ?? createInitialWorld();
  let listeners = new Set();
  let writeTimer = null;
  let writeDeadline = 0;

  function persist() {
    const now = Date.now();
    if (writeDeadline === 0) writeDeadline = now + WRITE_MAX_WAIT_MS;
    if (writeTimer) clearTimeout(writeTimer);
    const wait = Math.max(0, Math.min(WRITE_DEBOUNCE_MS, writeDeadline - now));
    writeTimer = setTimeout(() => {
      writeToStorage(snapshot);
      writeTimer = null;
      writeDeadline = 0;
    }, wait);
  }

  function notify() {
    for (const fn of listeners) fn();
  }

  function getSnapshot() { return snapshot; }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function mutate(updater) {
    const next = updater(snapshot);
    if (next && next !== snapshot) {
      snapshot = next;
      persist();
      notify();
    }
  }

  /**
   * Advance the sim clock and apply per-tick decay. Returns the number
   * of ticks advanced (0 if nothing happened).
   */
  function advanceClock(nowMs = Date.now()) {
    const elapsedMs = Math.max(0, nowMs - snapshot.lastTickWallClock);
    const ticks = Math.min(OFFLINE_CAP_TICKS, Math.floor(elapsedMs * TICK_HZ / 1000));
    if (ticks <= 0) return 0;
    const next = JSON.parse(JSON.stringify(snapshot));
    next.simTicks += ticks;
    next.lastTickWallClock = snapshot.lastTickWallClock + Math.floor(ticks * 1000 / TICK_HZ);
    // Apply need decay for every dupe.
    for (const dupe of Object.values(next.dupes)) {
      for (const axis of NEED_AXES) {
        const rate = NEED_DECAY[axis] ?? 0;
        dupe.needs[axis] = clampNeed((dupe.needs[axis] ?? 100) - rate * ticks);
      }
    }
    snapshot = next;
    persist();
    notify();
    return ticks;
  }

  /**
   * Apply an Action[] from a brain. Looks up each verb, runs its
   * handler, applies mutate Effects, returns perceive Effects so the
   * caller can dispatch them to the perception bus.
   */
  function applyActions(actorId, actions) {
    if (!Array.isArray(actions) || actions.length === 0) return [];
    const next = JSON.parse(JSON.stringify(snapshot));
    const actor = next.dupes[actorId];
    if (!actor) return [];
    const perceptionEvents = [];
    for (const action of actions) {
      const verb = VERBS[action?.verb];
      if (!verb) continue;
      const effects = verb.handler(actor, action.args ?? {}, next) ?? [];
      for (const eff of effects) {
        if (eff.kind === 'mutate' && typeof eff.apply === 'function') eff.apply(next);
        else if (eff.kind === 'perceive') perceptionEvents.push(eff);
      }
    }
    snapshot = next;
    persist();
    notify();
    return perceptionEvents;
  }

  function addDupe(dupe) {
    mutate((s) => ({ ...s, dupes: { ...s.dupes, [dupe.id]: dupe } }));
  }

  function removeDupe(id) {
    mutate((s) => {
      if (!s.dupes[id]) return s;
      const next = { ...s, dupes: { ...s.dupes } };
      delete next.dupes[id];
      return next;
    });
  }

  function updateDupe(id, patch) {
    mutate((s) => {
      const cur = s.dupes[id];
      if (!cur) return s;
      return { ...s, dupes: { ...s.dupes, [id]: { ...cur, ...patch } } };
    });
  }

  function reset() {
    snapshot = createInitialWorld();
    persist();
    notify();
  }

  function fastForwardTicks(n) {
    if (!Number.isFinite(n) || n <= 0) return;
    const next = JSON.parse(JSON.stringify(snapshot));
    next.simTicks += n;
    for (const dupe of Object.values(next.dupes)) {
      for (const axis of NEED_AXES) {
        const rate = NEED_DECAY[axis] ?? 0;
        dupe.needs[axis] = clampNeed((dupe.needs[axis] ?? 100) - rate * n);
      }
    }
    snapshot = next;
    persist();
    notify();
  }

  return {
    getSnapshot,
    subscribe,
    advanceClock,
    applyActions,
    addDupe,
    removeDupe,
    updateDupe,
    reset,
    fastForwardTicks,
    _sync: sync,
  };
}
