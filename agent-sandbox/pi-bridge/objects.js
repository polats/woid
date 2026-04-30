/**
 * Smart object type registry — declarative data only. The runtime
 * registry that tracks live *instances* lives in objects-registry.js.
 *
 * Slice 1 of #245 ships the schema and a small starter set of types.
 * Slice 2 adds the `use(object_id)` verb that consumes affordances;
 * slice 3 adds space templates that instantiate objects in bulk.
 *
 * Each type declares:
 *
 *   description  — short noun phrase used in perception ("a chair")
 *   capacity     — how many actors can use it concurrently. 1 for
 *                  single-occupant items (chair, bed, fridge);
 *                  larger N for shared things (bookshelf=2, etc).
 *                  Use Infinity for passive ambient objects (jukebox).
 *   defaultState — shape of per-instance mutable fields. Tagged in
 *                  comments with Astron-style intent (broadcast / db
 *                  / local) until the registry actually enforces it
 *                  in slice 2.
 *   affordances  — verbs the object accepts and what they yield.
 *                  Slice 1 only documents this; slice 2 wires the
 *                  utility scoring + effects into the GM.
 *
 * Design constraint: types are pure data, no functions on the type.
 * Effects/utility are declarative arrays so the registry + tests +
 * future renderers can all read them without invoking JS.
 */

export const OBJECT_TYPES = {
  chair: {
    description: "a chair",
    capacity: 1,
    glyph: "🪑",
    defaultState: { occupant: null /* db */ },
    affordances: [
      {
        verb: "sit",
        // Most attractive when tired. Rough Sims-style advertisement:
        // utility = (max-need - current-need-value), 0..100.
        utility: { axis: "energy", attractor: "low", max: 50 },
        preconditions: ["adjacent", "free"],
        effects: [
          { kind: "occupy" },
          { kind: "need", axis: "energy", op: "+", amount: 5 },
        ],
      },
    ],
  },

  bed: {
    description: "a bed",
    capacity: 1,
    glyph: "🛏️",
    defaultState: { occupant: null /* db */ },
    affordances: [
      {
        verb: "sleep",
        utility: { axis: "energy", attractor: "low", max: 100 },
        preconditions: ["adjacent", "free"],
        effects: [
          { kind: "occupy" },
          { kind: "need", axis: "energy", op: "=", amount: 100 },
          { kind: "moodlet", tag: "slept_well", weight: 4, reason: "slept properly", duration_sim_min: 8 * 60 },
          // Skip the boring sim-hours of sleeping. Maya wakes up
          // the next sim-morning. Acceptable for solo demos; for
          // multi-character sandboxes this would be deferred to
          // after the world has its sleep semantics.
          { kind: "advance_sim", sim_minutes: 8 * 60 },
        ],
      },
    ],
  },

  fridge: {
    description: "a fridge with leftovers",
    capacity: 1,
    glyph: "🧊",
    defaultState: { occupant: null /* db */ },
    affordances: [
      {
        verb: "eat",
        utility: { axis: "energy", attractor: "low", max: 70 },
        preconditions: ["adjacent"],
        effects: [
          { kind: "need", axis: "energy", op: "+", amount: 30 },
          { kind: "moodlet", tag: "had_a_meal", weight: 2, reason: "ate something from the fridge", duration_sim_min: 4 * 60 },
        ],
      },
    ],
  },

  bookshelf: {
    description: "a bookshelf",
    capacity: 2,
    glyph: "📚",
    defaultState: {},
    affordances: [
      {
        verb: "read",
        utility: { axis: "social", attractor: "low", max: 60 },
        preconditions: ["adjacent"],
        effects: [
          { kind: "need", axis: "social", op: "+", amount: 15 },
        ],
      },
    ],
  },

  table: {
    description: "a table",
    // Communal centerpiece — multiple people can be at the table
    // together. No active affordance yet; ambient social flavor.
    capacity: 4,
    glyph: "🍽️",
    defaultState: {},
    affordances: [
      {
        verb: "eat_at_table",
        utility: { axis: "social", attractor: "low", max: 40 },
        preconditions: ["adjacent"],
        effects: [
          { kind: "need", axis: "social", op: "+", amount: 10 },
        ],
      },
    ],
  },

  jukebox: {
    description: "a jukebox",
    // Many-occupant passive — anyone in range gets the effect of it
    // playing. The cap is informational only; jukebox doesn't track
    // a "user" the way chairs do.
    capacity: Infinity,
    glyph: "🎵",
    defaultState: { playing: false /* broadcast */ },
    affordances: [
      {
        verb: "play_music",
        utility: { axis: "social", attractor: "low", max: 30 },
        preconditions: ["adjacent"],
        effects: [
          { kind: "instance", field: "playing", op: "=", value: true },
        ],
      },
    ],
  },
};

/**
 * Convenience — list of known type ids.
 */
export const OBJECT_TYPE_IDS = Object.keys(OBJECT_TYPES);

/**
 * Get a type by id; returns null for unknown types so callers can
 * decide whether to reject or fall back.
 */
export function getType(typeId) {
  return OBJECT_TYPES[typeId] ?? null;
}
