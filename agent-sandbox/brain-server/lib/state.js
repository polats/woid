// In-memory state. Persistence is out of scope for v0.1 (see CONTRACT.md).
// Resets on every brain-server restart; sbox re-POSTs /character on connect.

export const state = {
  bootedAt: Date.now(),

  // Map<id, Character>
  characters: new Map(),

  // Map<id, PerceptionEvent[]>   most recent 50 per char
  perception: new Map(),

  // Single hard-coded object instance for the first-slice MVP.
  // Smart-object registry will replace this in phase 2.
  objects: new Map([
    ['chair_1', {
      id: 'chair_1', type: 'chair', pos: { x: 2, y: 0, z: 3 },
      occupant: null,
    }],
  ]),
};

const PERCEPTION_RING_SIZE = 50;

export function appendPerception(charId, event) {
  let buf = state.perception.get(charId);
  if (!buf) { buf = []; state.perception.set(charId, buf); }
  buf.push(event);
  if (buf.length > PERCEPTION_RING_SIZE) buf.shift();
}

export function makeCharacter({ id, identity, brain_provider }) {
  const char = {
    id,
    identity: {
      name: identity?.name ?? id,
      about: identity?.about ?? '',
      vibe: identity?.vibe ?? '',
      avatar_hint: identity?.avatar_hint ?? '',
    },
    brain_provider: brain_provider ?? 'utility',   // "utility" | "llm"
    needs:    { energy: 100, social: 60, hunger: 80 },
    traits:   [],
    moodlets: [],
    location: { x: 0, y: 0, z: 0, room: 'living' },
  };
  state.characters.set(id, char);
  state.perception.set(id, []);
  return char;
}
