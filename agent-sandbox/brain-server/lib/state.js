// In-memory state. Per-character harness primitives from woid-core/harness/:
// perception bus, needs tracker, moodlets tracker.

import { createPerception }      from "../../woid-core/harness/perception.js";
import { createNeedsTracker }    from "../../woid-core/harness/needs.js";
import { createMoodletsTracker } from "../../woid-core/harness/moodlets.js";

export const state = {
  bootedAt: Date.now(),

  // Map<id, Character>
  characters: new Map(),

  // Shared trackers — all multi-character via per-key buckets internally.
  perception: createPerception(),
  needs:      createNeedsTracker(),
  moodlets:   createMoodletsTracker(),   // in-memory persist (default)

  // First-slice hard-coded smart-object instance.
  objects: new Map([
    ['chair_1', {
      id: 'chair_1', type: 'chair', pos: { x: 2, y: 0, z: 3 },
      occupant: null,
    }],
  ]),
};

export function makeCharacter({ id, identity, brain_provider }) {
  const char = {
    id,
    identity: {
      name: identity?.name ?? id,
      about: identity?.about ?? '',
      vibe: identity?.vibe ?? '',
      avatar_hint: identity?.avatar_hint ?? '',
    },
    brain_provider: brain_provider ?? 'utility',
    traits: [],
    location: { x: 0, y: 0, z: 0, room: 'living' },
  };
  state.characters.set(id, char);

  // Initialize per-character harness state.
  state.needs.register(id);
  state.moodlets.clear(id);                 // fresh start
  // Perception buffer auto-created on first appendOne.

  return char;
}

/**
 * Get the merged snapshot of a character for HTTP responses.
 * Combines static identity with live needs + moodlets aggregate.
 */
export function snapshotCharacter(id) {
  const c = state.characters.get(id);
  if (!c) return null;
  const needRec = state.needs.get(id);
  const moodAgg = state.moodlets.aggregate(id);
  return {
    ...c,
    needs: needRec?.needs ?? { energy: 100, social: 60, hunger: 80 },
    moodlets: moodAgg.breakdown,
    mood: { mood: moodAgg.mood, band: moodAgg.band },
  };
}
