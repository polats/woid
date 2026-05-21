/**
 * Colony GameAdapter — the bridge between Colony's world.js + verbs.js
 * and the woid harness contract.
 *
 * Implements the four-method GameAdapter interface from
 * src/lib/harness/types.js. The brain wiring (UtilityBrain candidates +
 * scorers) lives in src/lib/colony/brain.js — this file just plumbs
 * Observations together from world state.
 */

import { createMemoryIdentityStore } from '../harness/impls/identity/MemoryIdentityStore.js';
import { VERB_LIST } from './verbs.js';
import { tilesOfType, NEED_LOW_THRESHOLD } from './world.js';

/**
 * @typedef {import('../harness/types.js').GameAdapter} GameAdapter
 * @typedef {import('../harness/types.js').Observation} Observation
 */

/**
 * @param {{
 *   moodletsTracker?: { listActive: (key: string) => unknown[] },
 *   perceptionBus?: { eventsSince: (key: string, ts?: number) => any[] },
 *   identity?: import('../harness/types.js').IdentityStore,
 * }} [opts]
 * @returns {GameAdapter}
 */
export function createColonyAdapter(opts = {}) {
  const moodletsTracker = opts.moodletsTracker ?? null;
  const perceptionBus = opts.perceptionBus ?? null;
  const identity = opts.identity ?? createMemoryIdentityStore();

  /** Map of last-seen perception ts per dupe so we only inject deltas. */
  const lastSeenTs = new Map();

  /**
   * @param {string} dupeId
   * @param {any} world
   * @param {number} tick
   * @returns {Observation}
   */
  function observe(dupeId, world, tick) {
    const dupe = world?.dupes?.[dupeId];
    if (!dupe) {
      return {
        selfId: dupeId,
        tick,
        trigger: { kind: 'heartbeat' },
        perception: [],
        game: {},
      };
    }

    const since = lastSeenTs.get(dupeId);
    const events = perceptionBus
      ? perceptionBus.eventsSince(dupeId, since)
      : [];
    if (events.length > 0) {
      lastSeenTs.set(dupeId, events[events.length - 1].ts);
    }

    // Need-low synthesized events so brains can react even when the
    // perception bus is empty.
    const needsLow = [];
    for (const [axis, value] of Object.entries(dupe.needs ?? {})) {
      if (value < NEED_LOW_THRESHOLD) needsLow.push({ axis, value });
    }

    const moodlets = moodletsTracker?.listActive(dupeId) ?? [];

    /** @type {Observation} */
    const obs = {
      selfId: dupeId,
      tick,
      trigger: { kind: 'heartbeat' },
      perception: events,
      needs: { ...(dupe.needs ?? {}) },
      moodlets,
      traits: [],
      game: {
        pos: { ...(dupe.pos ?? { x: 0, y: 0 }) },
        stress: dupe.stress ?? 0,
        skills: { ...(dupe.skills ?? {}) },
        currentAction: dupe.currentAction ?? 'idle',
        lastVerb: dupe.lastVerb ?? null,
        // Pre-computed candidate sources — brains can read these without
        // re-scanning the grid.
        oreDeposits: tilesOfType(world, 'ore_deposit'),
        beds: tilesOfType(world, 'bed'),
        kitchens: tilesOfType(world, 'kitchen'),
        resources: { ...(world.resources ?? {}) },
        needsLow,
      },
    };
    return obs;
  }

  /**
   * Schedule policy: tick every dupe each frame. Refined in Phase 2b
   * to throttle per-dupe ticking (200ms cadence) and prioritize
   * `breaking`-band dupes.
   */
  function schedule(world, _tick) {
    return Object.keys(world?.dupes ?? {});
  }

  return {
    observe,
    schedule,
    verbs: VERB_LIST,
    identity,
  };
}
