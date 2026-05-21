/**
 * MemoryIdentityStore — in-memory PortableIdentity store.
 *
 * The simplest IdentityStore. Useful for tests and for games whose
 * characters are scoped to a single session (e.g. Colony's dupes).
 */

/**
 * @param {{ initial?: Record<string, import('../../types.js').PortableIdentity> }} [opts]
 * @returns {import('../../types.js').IdentityStore}
 */
export function createMemoryIdentityStore(opts = {}) {
  /** @type {Map<string, import('../../types.js').PortableIdentity>} */
  const store = new Map();
  if (opts.initial) {
    for (const [id, identity] of Object.entries(opts.initial)) {
      store.set(id, { ...identity });
    }
  }

  async function load(id) {
    const got = store.get(id);
    return got ? { ...got } : null;
  }

  async function save(identity) {
    if (!identity?.id) throw new Error('MemoryIdentityStore.save: identity.id required');
    const now = Date.now();
    const record = {
      ...identity,
      updatedAt: now,
      createdAt: identity.createdAt ?? now,
      traits: Array.isArray(identity.traits) ? identity.traits.slice() : [],
    };
    store.set(record.id, record);
  }

  async function list() {
    return Array.from(store.values()).map((v) => ({ ...v }));
  }

  return { load, save, list };
}
