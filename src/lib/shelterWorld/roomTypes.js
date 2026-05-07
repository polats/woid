/**
 * Room type registry for Shelter (Severance-mode game).
 *
 * Distinct from `shelter-layout.json`, which describes which rooms are
 * *placed* on the grid. This file describes the *types* — their
 * category, the tier at which they unlock, what the build menu shows,
 * what each room contributes to gameplay.
 *
 * Cluster 1 (foundation) registers:
 *   - lobby           — top-floor reception, Edi Schmid lives here.
 *   - pattern-sorting — default-built work room (MDR analogue).
 *   - break-room      — type registered but NOT default-built; the
 *                       opening tutorial unlocks it on the first
 *                       tier-up and the player builds it via the
 *                       (still-to-build) build menu.
 *
 * `defaultBuilt` tells the layout loader which rooms appear at game
 * start. `tier` is the facility-tier threshold required to surface
 * this type in the build menu (or in any future "discover" UI).
 */

export const ROOM_CATEGORY = {
  lobby: 'lobby',
  work: 'work',
  service: 'service',
  mystery: 'mystery',
}

export const ROOM_TYPES = {
  lobby: {
    id: 'lobby',
    name: 'Lobby',
    category: ROOM_CATEGORY.lobby,
    description: 'The reception floor. Edi Schmid greets new hires here.',
    defaultBuilt: true,
    tier: 1,
    isWork: false,
  },
  'pattern-sorting': {
    id: 'pattern-sorting',
    name: 'Pattern Sorting',
    category: ROOM_CATEGORY.work,
    description:
      'Sorters refine numerical patterns whose meaning is need-to-know. '
      + "Don't ask what the numbers mean.",
    defaultBuilt: true,
    tier: 1,
    isWork: true,
    workstationCount: 1,
  },
  'break-room': {
    id: 'break-room',
    name: 'Break Room',
    category: ROOM_CATEGORY.service,
    description: 'A small room for restoring energy between shifts.',
    defaultBuilt: false,
    tier: 2,
    isWork: false,
    // Energy units restored per sim minute when an agent is occupying
    // the break room. Pacing numbers are deferred (#§4 / §5 of the
    // design doc) — placeholder until S12 lands.
    energyRestorePerMin: 20,
  },
}

/** All registered type ids in declaration order. */
export const ROOM_TYPE_IDS = Object.keys(ROOM_TYPES)

/** Lookup helper. Returns null on unknown id. */
export function getRoomType(id) {
  return ROOM_TYPES[id] ?? null
}
