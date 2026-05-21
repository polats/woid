/**
 * Colony behaviour loop — the per-tick orchestration that turns the
 * store's tick advance into autonomous dupe behaviour.
 *
 * Composes:
 *   - the GameAdapter (observe + schedule)
 *   - one UtilityBrain per dupe (lazy-attached on first observation)
 *   - the harness perception ring buffer
 *   - the harness moodlets tracker (stress + need-low events)
 *
 * Owns nothing the store doesn't already own — everything is rebuilt
 * cleanly from a snapshot if needed. Designed to be called from
 * useColonyTick's `runBehaviour` callback.
 */

import { createPerception } from '../harness/perception.js';
import {
  createMoodletsTracker,
  createLocalStoragePersist,
} from '../harness/moodlets.js';
import { createColonyAdapter } from './adapter.js';
import { createColonyBrain } from './brain.js';
import { NEED_LOW_THRESHOLD } from './world.js';

const STRESS_FROM_NEED_LOW = 4;
const STRESS_FROM_ACTION_REJECTED = 2;
const STRESS_BREAKING_THRESHOLD = 80;

/**
 * @param {{
 *   persistNamespace?: string,
 *   moodletsNamespace?: string,
 * }} [opts]
 */
export function createColonyLoop(opts = {}) {
  const perceptionBus = createPerception();
  const moodlets = createMoodletsTracker({
    persist: createLocalStoragePersist({
      namespace: opts.moodletsNamespace ?? 'woid.colony.moodlets.v1',
    }),
  });
  const adapter = createColonyAdapter({
    moodletsTracker: moodlets,
    perceptionBus,
  });

  /** @type {Map<string, import('../harness/types.js').Brain>} */
  const brainsByDupe = new Map();
  /** @type {Map<string, Record<string, number>>} last-tick need values for crossing detection */
  const lastNeeds = new Map();

  function brainFor(dupeId) {
    let brain = brainsByDupe.get(dupeId);
    if (!brain) {
      brain = createColonyBrain(dupeId);
      brainsByDupe.set(dupeId, brain);
    }
    return brain;
  }

  function dropBrain(dupeId) {
    brainsByDupe.delete(dupeId);
    perceptionBus.clear(dupeId);
    lastNeeds.delete(dupeId);
  }

  /**
   * Run a single behaviour pass. Called by useColonyTick after the
   * store has advanced. Performs:
   *   1. Need-crossing → moodlets + perception
   *   2. Stress recompute from active moodlets
   *   3. For each scheduled dupe: observe → brain → applyActions
   *   4. Broadcast perception effects to nearby dupes
   *
   * @param {ReturnType<typeof import('./store.js').createColonyStore>} store
   * @param {number} _ticksAdvanced
   */
  async function tick(store, _ticksAdvanced) {
    const snapshot = store.getSnapshot();

    // ── 1. Detect need-low crossings, emit moodlets + perception ──
    for (const dupe of Object.values(snapshot.dupes)) {
      const prev = lastNeeds.get(dupe.id) ?? { food: 100, energy: 100 };
      const cur = dupe.needs ?? {};
      for (const axis of Object.keys(cur)) {
        if (prev[axis] >= NEED_LOW_THRESHOLD && cur[axis] < NEED_LOW_THRESHOLD) {
          // Moodlet + perception event
          moodlets.emit(dupe.id, {
            tag: `need_low:${axis}`,
            weight: -STRESS_FROM_NEED_LOW,
            reason: `${axis} dropped below ${NEED_LOW_THRESHOLD}`,
            source: 'biology',
            duration_ms: 30 * 60 * 1000,
          });
          perceptionBus.appendOne(dupe.id, {
            kind: 'need_low',
            axis,
            value: cur[axis],
          });
        }
      }
      lastNeeds.set(dupe.id, { ...cur });
    }

    // ── 2. Recompute stress from active moodlets ──
    for (const dupe of Object.values(snapshot.dupes)) {
      const agg = moodlets.aggregate(dupe.id);
      // Stress is the negative-side sum, clamped to [0, 100].
      const stressDelta = Math.max(0, 50 - agg.mood);
      // Smooth a little so stress doesn't jump from one moodlet emit.
      const next = Math.round((dupe.stress ?? 0) * 0.8 + stressDelta * 1.2);
      if (next !== dupe.stress) {
        store.updateDupe(dupe.id, { stress: Math.max(0, Math.min(100, next)) });
      }
    }

    // ── 3. Reap stale brains for removed dupes ──
    const activeIds = new Set(Object.keys(snapshot.dupes));
    for (const id of brainsByDupe.keys()) {
      if (!activeIds.has(id)) dropBrain(id);
    }

    // ── 4. Run brain for each scheduled dupe ──
    const dupeIds = adapter.schedule(store.getSnapshot(), snapshot.simTicks);
    for (const dupeId of dupeIds) {
      const dupe = store.getSnapshot().dupes[dupeId];
      if (!dupe) continue;
      const obs = adapter.observe(dupeId, store.getSnapshot(), snapshot.simTicks);
      const brain = brainFor(dupeId);
      let actions = [];
      try {
        actions = await brain.step(obs);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[colony] brain error', dupeId, err);
        continue;
      }
      if (!actions || actions.length === 0) continue;
      const perceptionEffects = store.applyActions(dupeId, actions);

      // Dispatch perceive Effects to the bus. `*nearby*` becomes a
      // broadcast to dupes within INTEREST_RADIUS of the actor.
      const INTEREST_RADIUS = 3;
      const actorPos = store.getSnapshot().dupes[dupeId]?.pos;
      for (const eff of perceptionEffects) {
        const target = eff.target;
        const event = eff.event;
        if (target === '*nearby*') {
          for (const other of Object.values(store.getSnapshot().dupes)) {
            if (other.id === dupeId) continue;
            if (!actorPos) continue;
            const dx = Math.abs(other.pos.x - actorPos.x);
            const dy = Math.abs(other.pos.y - actorPos.y);
            if (Math.max(dx, dy) <= INTEREST_RADIUS) {
              perceptionBus.appendOne(other.id, event);
            }
          }
        } else if (target) {
          perceptionBus.appendOne(target, event);
          if (event?.kind === 'action_rejected') {
            // Frustration: rejected actions add a small stress moodlet.
            moodlets.emit(target, {
              tag: `rejected:${event.verb}`,
              weight: -STRESS_FROM_ACTION_REJECTED,
              reason: `couldn't ${event.verb}`,
              source: 'environment',
              duration_ms: 5 * 60 * 1000,
            });
          }
        }
      }
    }
  }

  return {
    tick,
    moodlets,
    perceptionBus,
    adapter,
    _brainsByDupe: brainsByDupe,
    dropBrain,
  };
}
