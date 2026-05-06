/**
 * Cached fetcher for kimodo motion JSON.
 *
 * Motions are content-addressed by id (e.g. `342711ffd11f` for the
 * standard idle). Once fetched, the parsed JSON is held in memory for
 * the lifetime of the page — motions are small and we want zero
 * latency when spawning new avatars that share an idle clip.
 */

const STANDARD_IDS = {
  idle: '342711ffd11f',
  cast: '4290481a993e',
}

const cache = new Map()    // id → motion JSON
const inflight = new Map() // id → Promise<motion>

function fetchMotion(id) {
  if (cache.has(id)) return Promise.resolve(cache.get(id))
  const existing = inflight.get(id)
  if (existing) return existing
  const p = fetch(`/api/kimodo/animations/${id}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((m) => {
      if (m) cache.set(id, m)
      inflight.delete(id)
      return m
    })
    .catch(() => {
      inflight.delete(id)
      return null
    })
  inflight.set(id, p)
  return p
}

export const animationLibrary = {
  STANDARD_IDS,
  /** Resolves to motion JSON, or null on failure. Idempotent. */
  get: fetchMotion,
  /** Synchronously returns a previously-fetched motion, or null. */
  peek(id) { return cache.get(id) ?? null },
  /** Pre-warm the cache with the standard clips. Returns a Promise. */
  bootstrap() {
    return Promise.all(Object.values(STANDARD_IDS).map(fetchMotion))
  },
}
